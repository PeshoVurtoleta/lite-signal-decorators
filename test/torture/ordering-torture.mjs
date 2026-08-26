// test/torture/ordering-torture.mjs -- node --expose-gc test/torture/ordering-torture.mjs
//
// PRNG-driven construction over the inheritance matrix, plus the full PD-8
// rejection matrix re-asserted. Each round builds a randomized host shape
// (P<=8 signals, D<=4 deriveds, a decorated base chain 1-3 deep, sometimes an
// undecorated leaf on top), constructs it, and asserts:
//   - declaration-order reads (an `late` field reads an earlier accessor's box;
//     every signal reads its initial value; every derived reads its source);
//   - single deepest-host wiring: the node delta is exactly P+D+1 (one anchor),
//     never doubled for the chain;
//   - conservation: activeNodes returns to the round baseline after dispose.
// Then every PD-8 rejection row is re-asserted through mock contexts (both the
// factory and bare paths where they differ).
//
// A failing check prints seed + op so the exact round replays with
// TORTURE_SEED=<seed>. TORTURE_BREAK=ordering-torture inverts ONE rejection
// assertion (static-member) so the control sweep proves the gate can fail.
//
// ASCII-only.

import { stats } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import {
    buildClass,
    makeAccessorContext,
    makeGetterContext,
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

    // Distribute P signals and D deriveds across the chain levels.
    const pl = new Array(depth).fill(0);
    const dl = new Array(depth).fill(0);
    for (let k = 0; k < P; k++) pl[randInt(depth)]++;
    for (let k = 0; k < D; k++) dl[randInt(depth)]++;
    // Level 0 must own at least one signal: it anchors the `late` field read and
    // every derived source.
    if (pl[0] === 0) {
        for (let l = 1; l < depth; l++) { if (pl[l] > 0) { pl[l]--; pl[0]++; break; } }
        if (pl[0] === 0) pl[0] = 1;
    }

    let gi = 0;
    const sigKeys = [];
    const sigVals = [];
    const derKeys = [];
    let firstKey = null;
    let superClass = undefined;
    let Deepest = undefined;

    for (let level = 0; level < depth; level++) {
        const members = [];
        for (let j = 0; j < pl[level]; j++) {
            const key = "r" + rk + "_g" + gi;
            const val = gi;
            sigKeys.push(key);
            sigVals.push(val);
            if (firstKey === null) firstKey = key;
            members.push({
                kind: "accessor",
                key,
                decorator: pkg.reactive,
                value: (function (v) { return function () { return v; }; })(val),
            });
            gi++;
        }
        for (let j = 0; j < dl[level]; j++) {
            const key = "r" + rk + "_d" + level + "_" + j;
            derKeys.push(key);
            const fk = firstKey;
            members.push({
                kind: "getter",
                key,
                decorator: pkg.derived,
                body: (function (fk) { return function () { return this[fk] + 1000; }; })(fk),
            });
        }
        if (level === 0) {
            const fk = firstKey;
            members.push({
                kind: "field",
                key: "late",
                value: (function (fk) { return function () { return this[fk] + 1; }; })(fk),
            });
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
        delta === P + D + 1,
        () => "round " + rk + ": node delta " + delta + " != P+D+1 " + (P + D + 1) +
            " (P=" + P + " D=" + D + " depth=" + depth + ")",
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
    pkg.disposeReactive(inst);
    check(
        stats().activeNodes === base,
        () => "round " + rk + ": activeNodes " + stats().activeNodes + " != baseline " + base + " after dispose",
    );

    // Sometimes an undecorated leaf: it must wire at the inherited host (single
    // anchor), preserve instanceof, and read declaration-order fields.
    if (randInt(2) === 0) {
        const Leaf = buildClass({ name: "R" + rk + "Leaf", superClass: Deepest, members: [] });
        const b2 = stats().activeNodes;
        const leaf = new Leaf();
        const d2 = stats().activeNodes - b2;
        check(
            d2 === P + D + 1,
            () => "round " + rk + ": leaf node delta " + d2 + " != P+D+1 " + (P + D + 1),
        );
        check(leaf instanceof Deepest, () => "round " + rk + ": leaf not instanceof deepest");
        check(leaf.late === 1, () => "round " + rk + ": leaf late=" + leaf.late + " expected 1");
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

// One rejection assertion. TORTURE_BREAK sabotages the `static-reactive` row by
// asserting it does NOT throw (it does) -> the control fails as required.
function assertRejects(label, fn, re) {
    if (breakActive(NAME) && label === "static-reactive") {
        let threw = false;
        try { fn(); } catch (_) { threw = true; }
        check(!threw, () => "BREAK sabotage: " + label + " unexpectedly threw (gate still works)");
        return;
    }
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

// wrong kind.
assertRejects("wrongkind-reactive", () => pkg.reactive({ get() {}, set() {} }, makeGetterContext("x")), /kind "accessor"/);
assertRejects("wrongkind-derived", () => pkg.derived(function () {}, makeAccessorContext("y")), /kind "getter"/);
assertRejects("wrongkind-host", () => pkg.reactiveHost(class {}, makeAccessorContext("z")), /kind "class"/);

// static member.
assertRejects("static-reactive", () => pkg.reactive({ get() {}, set() {} }, makeAccessorContext("s", { static: true })), /cannot decorate the static member/);
assertRejects("static-derived", () => pkg.derived(function () {}, makeGetterContext("s", { static: true })), /cannot decorate the static member/);

// private member.
assertRejects("private-reactive", () => pkg.reactive({ get() {}, set() {} }, makeAccessorContext("p", { private: true })), /private \(#\) members are not supported/);
assertRejects("private-derived", () => pkg.derived(function () {}, makeGetterContext("p", { private: true })), /private \(#\) members are not supported/);

// unknown option key -> did-you-mean.
assertRejects("unknown-reactive", () => pkg.reactive({ equal: () => true }), /did you mean `equals`/);
assertRejects("unknown-derived", () => pkg.derived({ eqals: () => true }), /did you mean `equals`/);

// bad option type.
assertRejects("badequals-reactive", () => pkg.reactive({ equals: 3 }), /`equals` must be a function/);
assertRejects("badequals-derived", () => pkg.derived({ equals: 3 }), /`equals` must be a function/);

// host options.
assertRejects("host-options", () => pkg.reactiveHost({ registry: {} }), /reactiveHost takes no options/);

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

pass(NAME);
