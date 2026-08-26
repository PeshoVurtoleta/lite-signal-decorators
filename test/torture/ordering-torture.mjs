// test/torture/ordering-torture.mjs -- node --expose-gc test/torture/ordering-torture.mjs
//
// PRNG-driven construction over the inheritance matrix, plus the full PD-8
// rejection matrix re-asserted. Each round builds a randomized host shape
// (P<=8 signals, D<=4 deriveds, E<=3 effects, a decorated base chain 1-3 deep,
// sometimes an undecorated leaf on top), constructs it, and asserts:
//   - declaration-order reads (a `late` field reads an earlier accessor's box;
//     every signal reads its initial value; every derived reads its source);
//   - single deepest-host wiring: the node delta is exactly P+D+E+1 (one
//     anchor), never doubled for the chain;
//   - effects (S2a): every effect on the chain starts EXACTLY once, at leaf
//     wiring, AFTER every field of every class in the chain is initialized. The
//     observable: each effect body reads the chain's FIRST and LAST signal (the
//     last one may live in a more-derived class) on its first run and records a
//     miss if either is not its initialized value. Total runs === E, misses 0.
//   - conservation: activeNodes returns to the round baseline after dispose.
// Then every PD-8 rejection row is re-asserted through mock contexts (both the
// factory and bare paths where they differ).
//
// A failing check prints seed + op so the exact round replays with
// TORTURE_SEED=<seed>. TORTURE_BREAK=ordering-torture sabotages the effect
// start-count gate (expects E+1 runs) so the control sweep proves it can fail.
//
// ASCII-only.

import { stats } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import {
    buildClass,
    makeAccessorContext,
    makeGetterContext,
    makeMethodContext,
    makeClassContext,
} from "../shared/mock-emitter.mjs";
import { RUN, check, breakActive, randInt, randRange, pass } from "./helpers/harness.mjs";

const NAME = "ordering-torture";
const ROUNDS = 250;

// PENDING is module state: an un-hosted @reactive/@derived leaves a record. A
// throwaway host splices the whole buffer, throwing iff records lingered
// (swallowed). Called around every residue-leaving rejection probe.
function drainPending() {
    try {
        pkg.reactiveHost(class Drain {}, makeClassContext("Drain"));
    } catch (_) { /* the splice already emptied the buffer */ }
}

// --- PRNG-driven construction rounds ------------------------------------------

function runRound(rk) {
    RUN.op = rk;
    const depth = randRange(1, 3);
    const P = randRange(1, 8);
    const D = randRange(0, 4);
    const E = randRange(0, 3);

    // Distribute P signals, D deriveds and E effects across the chain levels.
    const pl = new Array(depth).fill(0);
    const dl = new Array(depth).fill(0);
    const el = new Array(depth).fill(0);
    for (let k = 0; k < P; k++) pl[randInt(depth)]++;
    for (let k = 0; k < D; k++) dl[randInt(depth)]++;
    for (let k = 0; k < E; k++) el[randInt(depth)]++;
    // Level 0 must own at least one signal: it anchors the `late` field read and
    // every derived source.
    if (pl[0] === 0) {
        for (let l = 1; l < depth; l++) { if (pl[l] > 0) { pl[l]--; pl[0]++; break; } }
        if (pl[0] === 0) pl[0] = 1;
    }

    // --- pass 1: plan every key up front so an effect body (which may sit in a
    // base class) can name a signal declared in a MORE-DERIVED class -----------
    let gi = 0;
    const levels = [];
    const sigKeys = [];
    const sigVals = [];
    const derKeys = [];
    const effKeys = [];
    for (let level = 0; level < depth; level++) {
        const L = { sigs: [], ders: [], effs: [] };
        for (let j = 0; j < pl[level]; j++) {
            const key = "r" + rk + "_g" + gi;
            L.sigs.push({ key, val: gi });
            sigKeys.push(key);
            sigVals.push(gi);
            gi++;
        }
        for (let j = 0; j < dl[level]; j++) {
            const key = "r" + rk + "_d" + level + "_" + j;
            L.ders.push(key);
            derKeys.push(key);
        }
        for (let j = 0; j < el[level]; j++) {
            const key = "r" + rk + "_e" + level + "_" + j;
            L.effs.push(key);
            effKeys.push(key);
        }
        levels.push(L);
    }
    const firstKey = sigKeys[0];
    const firstVal = sigVals[0];               // 0 -- level 0 owns the first signal
    const lastKey = sigKeys[sigKeys.length - 1];
    const lastVal = sigVals[sigVals.length - 1];

    // One effect body shared by every effect this round (round-constant reads).
    // It fires under the leaf anchor after all fields init; a premature or
    // duplicated wiring is observable as a wrong run count or a recorded miss.
    const effBody = function () {
        this.__eruns = (this.__eruns | 0) + 1;
        if (this[firstKey] !== firstVal || this[lastKey] !== lastVal) {
            this.__emiss = (this.__emiss | 0) + 1;
        }
    };
    const derBody = function () { return this[firstKey] + 1000; };
    const lateThunk = function () { return this[firstKey] + 1; };

    // --- pass 2: build the chain ---------------------------------------------
    let superClass = undefined;
    let Deepest = undefined;
    for (let level = 0; level < depth; level++) {
        const members = [];
        const L = levels[level];
        for (let j = 0; j < L.sigs.length; j++) {
            const v = L.sigs[j].val;
            members.push({
                kind: "accessor",
                key: L.sigs[j].key,
                decorator: pkg.reactive,
                value: (function (vv) { return function () { return vv; }; })(v),
            });
        }
        for (let j = 0; j < L.ders.length; j++) {
            members.push({ kind: "getter", key: L.ders[j], decorator: pkg.derived, body: derBody });
        }
        for (let j = 0; j < L.effs.length; j++) {
            members.push({ kind: "method", key: L.effs[j], decorator: pkg.reactiveEffect, body: effBody });
        }
        if (level === 0) {
            members.push({ kind: "field", key: "late", value: lateThunk });
        }
        Deepest = buildClass({
            name: "R" + rk + "L" + level,
            superClass,
            classDecorator: pkg.reactiveHost,
            members,
        });
        superClass = Deepest;
    }

    const base = stats().activeNodes;
    const inst = new Deepest();
    const delta = stats().activeNodes - base;
    check(
        delta === P + D + E + 1,
        () => "round " + rk + ": node delta " + delta + " != P+D+E+1 " + (P + D + E + 1) +
            " (P=" + P + " D=" + D + " E=" + E + " depth=" + depth + ")",
    );
    check(inst.late === 1, () => "round " + rk + ": late=" + inst.late + " expected 1");
    for (let i = 0; i < sigKeys.length; i++) {
        check(
            inst[sigKeys[i]] === sigVals[i],
            () => "round " + rk + ": signal " + sigKeys[i] + "=" + inst[sigKeys[i]] + " expected " + sigVals[i],
        );
    }
    for (let i = 0; i < derKeys.length; i++) {
        check(
            inst[derKeys[i]] === 1000,
            () => "round " + rk + ": derived " + derKeys[i] + "=" + inst[derKeys[i]] + " expected 1000",
        );
    }
    // S2a effect start-timing: exactly E first-runs, each after every field
    // initialized (misses 0). BREAK expects E+1 -> the control fails as required.
    const expectedEruns = breakActive(NAME) ? E + 1 : E;
    check(
        (inst.__eruns | 0) === expectedEruns,
        () => "round " + rk + ": effects ran " + (inst.__eruns | 0) + " expected " + expectedEruns,
    );
    check(
        (inst.__emiss | 0) === 0,
        () => "round " + rk + ": an effect saw an uninitialized field on first run (miss=" + (inst.__emiss | 0) + ")",
    );
    pkg.disposeReactive(inst);
    check(
        stats().activeNodes === base,
        () => "round " + rk + ": activeNodes " + stats().activeNodes + " != baseline " + base + " after dispose",
    );

    // Sometimes an undecorated leaf: it must wire at the inherited host (single
    // anchor), preserve instanceof, read declaration-order fields, and fire the
    // inherited effects exactly once each.
    if (randInt(2) === 0) {
        const Leaf = buildClass({ name: "R" + rk + "Leaf", superClass: Deepest, members: [] });
        const b2 = stats().activeNodes;
        const leaf = new Leaf();
        const d2 = stats().activeNodes - b2;
        check(
            d2 === P + D + E + 1,
            () => "round " + rk + ": leaf node delta " + d2 + " != P+D+E+1 " + (P + D + E + 1),
        );
        check(leaf instanceof Deepest, () => "round " + rk + ": leaf not instanceof deepest");
        check(leaf.late === 1, () => "round " + rk + ": leaf late=" + leaf.late + " expected 1");
        check((leaf.__eruns | 0) === E, () => "round " + rk + ": leaf effects ran " + (leaf.__eruns | 0) + " expected " + E);
        check((leaf.__emiss | 0) === 0, () => "round " + rk + ": leaf effect saw an uninitialized field");
        pkg.disposeReactive(leaf);
        check(
            stats().activeNodes === b2,
            () => "round " + rk + ": leaf activeNodes not restored",
        );
    }
}

for (let r = 0; r < ROUNDS; r++) runRound(r);

// --- PD-8 rejection matrix (all named, all at decoration/construction) --------

RUN.op = -1;

// One rejection assertion.
function assertRejects(label, fn, re) {
    let threw = false;
    let msg = "";
    try { fn(); } catch (e) { threw = true; msg = (e && e.message) || String(e); }
    check(
        threw && re.test(msg),
        () => "rejection " + label + ": expected /" + re.source + "/, got " +
            (threw ? '"' + msg + '"' : "no throw"),
    );
}

// legacy emit -- both member decorators + the class decorator.
assertRejects("legacy-reactive", () => pkg.reactive({}, "count"), /legacy decorator call/);
assertRejects("legacy-derived", () => pkg.derived(function () {}, "d"), /legacy decorator call/);
assertRejects("legacy-host", () => pkg.reactiveHost(class {}), /legacy decorator call/);
assertRejects("legacy-effect", () => pkg.reactiveEffect(function () {}, "m"), /legacy decorator call/);
assertRejects("legacy-batched", () => pkg.batched(function () {}, "m"), /legacy decorator call/);

// wrong kind.
assertRejects("wrongkind-reactive", () => pkg.reactive({ get() {}, set() {} }, makeGetterContext("x")), /kind "accessor"/);
assertRejects("wrongkind-derived", () => pkg.derived(function () {}, makeAccessorContext("y")), /kind "getter"/);
assertRejects("wrongkind-host", () => pkg.reactiveHost(class {}, makeAccessorContext("z")), /kind "class"/);
assertRejects("wrongkind-effect", () => pkg.reactiveEffect(function () {}, makeGetterContext("e")), /kind "method"/);
assertRejects("wrongkind-batched", () => pkg.batched(function () {}, makeGetterContext("b")), /kind "method"/);

// static member.
assertRejects("static-reactive", () => pkg.reactive({ get() {}, set() {} }, makeAccessorContext("s", { static: true })), /cannot decorate the static member/);
assertRejects("static-derived", () => pkg.derived(function () {}, makeGetterContext("s", { static: true })), /cannot decorate the static member/);
assertRejects("static-effect", () => pkg.reactiveEffect(function () {}, makeMethodContext("s", { static: true })), /cannot decorate the static member/);
assertRejects("static-batched", () => pkg.batched(function () {}, makeMethodContext("s", { static: true })), /cannot decorate the static member/);

// private member.
assertRejects("private-reactive", () => pkg.reactive({ get() {}, set() {} }, makeAccessorContext("p", { private: true })), /private \(#\) members are not supported/);
assertRejects("private-derived", () => pkg.derived(function () {}, makeGetterContext("p", { private: true })), /private \(#\) members are not supported/);
assertRejects("private-effect", () => pkg.reactiveEffect(function () {}, makeMethodContext("p", { private: true })), /private \(#\) members are not supported/);
assertRejects("private-batched", () => pkg.batched(function () {}, makeMethodContext("p", { private: true })), /private \(#\) members are not supported/);

// unknown option key -> did-you-mean.
assertRejects("unknown-reactive", () => pkg.reactive({ equal: () => true }), /did you mean `equals`/);
assertRejects("unknown-derived", () => pkg.derived({ eqals: () => true }), /did you mean `equals`/);
assertRejects("unknown-effect", () => pkg.reactiveEffect({ schedular: () => {} }), /did you mean `scheduler`/);

// bad option type.
assertRejects("badequals-reactive", () => pkg.reactive({ equals: 3 }), /`equals` must be a function/);
assertRejects("badequals-derived", () => pkg.derived({ equals: 3 }), /`equals` must be a function/);
assertRejects("badscheduler-effect", () => pkg.reactiveEffect({ scheduler: 3 }), /`scheduler` must be a function/);

// batched takes no options.
assertRejects("batched-options", () => pkg.batched({ any: 1 }), /batched takes no options/);

// double host.
drainPending();
{
    const Once = pkg.reactiveHost(class Solo {}, makeClassContext("Solo"));
    assertRejects("double-host", () => pkg.reactiveHost(Once, makeClassContext("Solo")), /already has a @reactiveHost wrapper/);
}

// duplicate key across the chain.
drainPending();
{
    const B = buildClass({
        name: "DupBase",
        classDecorator: pkg.reactiveHost,
        members: [{ kind: "accessor", key: "k", decorator: pkg.reactive, value: () => 1 }],
    });
    assertRejects(
        "duplicate-key",
        () => buildClass({
            name: "DupChild",
            superClass: B,
            classDecorator: pkg.reactiveHost,
            members: [{ kind: "accessor", key: "k", decorator: pkg.reactive, value: () => 2 }],
        }),
        /declared twice across the prototype chain/,
    );
}

// stacking law: two package decorators on one member declare the same key twice
// in one class -> the claim-time duplicate-key throw fires (PD-13).
drainPending();
{
    assertRejects(
        "stacked-decorators",
        () => buildClass({
            name: "Stacked",
            classDecorator: pkg.reactiveHost,
            members: [
                { kind: "method", key: "act", decorator: pkg.reactiveEffect, body: function () {} },
                { kind: "method", key: "act", decorator: pkg.batched, body: function () {} },
            ],
        }),
        /declared twice/,
    );
}

// orphans: an un-hosted member poisons the next claim.
drainPending();
pkg.reactive({ get() {}, set() {} }, makeAccessorContext("orphaned"));
assertRejects(
    "orphans",
    () => pkg.reactiveHost(class Clean {}, makeClassContext("Clean")),
    /never installed on its prototype/,
);

// missing host -- reactive first-touch path.
drainPending();
{
    const NoHostSig = buildClass({
        name: "NoHostSig",
        members: [{ kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 0 }],
    });
    assertRejects("missing-host-reactive", () => new NoHostSig(), /without a @reactiveHost/);
}
drainPending();

// missing host -- derived initializer path.
{
    const NoHostDer = buildClass({
        name: "NoHostDer",
        members: [{ kind: "getter", key: "d", decorator: pkg.derived, body: function () { return 1; } }],
    });
    assertRejects("missing-host-derived", () => new NoHostDer(), /without a @reactiveHost/);
}
drainPending();

// missing host -- effect manual-call path (public guarded method fails closed).
{
    const NoHostEff = buildClass({
        name: "NoHostEff",
        members: [{ kind: "method", key: "run", decorator: pkg.reactiveEffect, body: function () {} }],
    });
    assertRejects("missing-host-effect", () => new NoHostEff().run(), /without a @reactiveHost/);
}
drainPending();

pass(NAME);
