// test/19-cost-instance.test.mjs -- costOfInstance(vm): the live measured
// instance (PLAN-S10 T4, decisions 0013 criterion (b) / 0009 candidate 4).
//
// costOfInstance is the measured-instance twin of costOf. Where costOf constructs
// a throwaway probe and FORCES every derived to report the constructed CEILING
// ("what will an instance of this class cost"), costOfInstance walks a LIVE wired
// vm right now: no probe, no ctor args, no registry pollution. It returns a
// per-call, UNCACHED, frozen { nodes, links, signals, locals, deriveds, effects }
// in costOf's exact shape.
//
// THE CONTRACT (the feature's value, PD-70/PD-74): the number is the truth NOW.
//   - nodes = 1 (anchor) + plan.signals + plan.locals + forEachOwned(rootOf(vm))
//     (the deriveds + user effects the anchor adopted -- signal/local boxes are
//     built pre-anchor, unadopted, never owned). nodes matches costOf regardless
//     of whether links have formed.
//   - links = sum of forEachSource over anchor + owned nodes + signal/local boxes,
//     NO dedupe (one edge per observer, matching costOf's activeLinks delta). An
//     UNFORCED lazy derived and an untaken dynamic branch have formed no links yet,
//     so links reads BELOW costOf's until the graph is exercised. Read every
//     derived once and the two agree exactly (A1 parity). The delta is the feature.
//   - kind counts read from the plan arrays, never walked.
//
// PD-72: the walk needs no stats() ledger, so costOfInstance works on a bound
// custom registry AND on a hand-rolled facade that lacks stats -- exactly the
// case costOf fails closed on. The walk routes through plan.reg (the REGISTRY-
// METHOD form: handles are registry-scoped, each registry owns its NODE_PTR).
//
// Fail-closed (A6/PD-71): parked/disposed -> ReactiveDisposedError with the right
// message flavor; a plain object -> throwNoPlan; an unwired instance ->
// throwNotWired; a prewired member slot -> throwPrewiredMember. NEVER a silent
// { nodes: 0 } report (indistinguishable from a bug).
//
// Run `npm run fixtures` first if the compiled-fixture imports fail to resolve.
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, stats } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import { buildClass } from "./shared/mock-emitter.mjs";
import * as tsClasses from "./fixtures/ts-out/fixture.src.js";
import * as babelClasses from "./fixtures/babel-out/fixture.src.js";

const {
    reactive, derived, reactiveEffect, localTo, reactiveHost, defineReactive,
    costOf, costOfInstance, disposeReactive, releaseReactive, reinitReactive,
    ReactiveDisposedError,
} = pkg;

const ERR = "@zakkster/lite-signal-decorators: ";
const SHAPE_KEYS = ["nodes", "links", "signals", "locals", "deriveds", "effects"];

function costFields(c) {
    return { nodes: c.nodes, links: c.links, signals: c.signals, locals: c.locals, deriveds: c.deriveds, effects: c.effects };
}

// =================================================================================
// EMIT LANES -- the committed Counter/Locals fixtures, run identically over the TS
// standard emit and the Babel 2023-11 emit. Counter's reactive shape: signals
// count/level/SYM (P=3, one SYMBOL member), deriveds double/band (D=2), an
// @reactiveEffect onCount (E=1) and a @batched bump (excluded from every kind
// count). costOf(Counter) = nodes 7, links 3 (double->count, band->level,
// onCount->count). Locals: signal src (P=1), locals draft/mirror (L=2) keyed on
// src -> nodes 4, links 0 (the @localTo upstream is a seen-slot, not a graph edge).
// =================================================================================

function emitLaneSuite(t, classes, label) {
    const { Counter, Locals, SYM } = classes;

    t.test(label + ": A1 parity-when-forced -- costOfInstance === costOf after reading every derived once (nodes 7, links 3, every kind count)", () => {
        const c = new Counter();
        void c.double; void c.band;                  // force the lazy deriveds' links
        const inst = costOfInstance(c);
        const cls = costOf(Counter);
        assert.deepEqual(costFields(inst), costFields(cls), "forced instance cost === class probe cost, field for field");
        assert.equal(inst.nodes, 7, "P+D+E+1 = 3+2+1+1 = 7");
        assert.equal(inst.links, 3, "double->count, band->level, onCount->count = 3 forced links");
        assert.equal(inst.signals, 3);
        assert.equal(inst.deriveds, 2);
        assert.equal(inst.effects, 1);
        assert.equal(inst.locals, 0);
        disposeReactive(c);
    });

    t.test(label + ": A2 delta-when-lazy -- fresh instance nodes equal, links strictly LOWER, then monotonic toward the forced number", () => {
        const c = new Counter();
        const fresh = costOfInstance(c);
        assert.equal(fresh.nodes, 7, "nodes match the forced count even before any derived is read (owned children exist)");
        assert.equal(fresh.links, 1, "only the onCount effect has fired at wire (onCount->count); both deriveds are lazy");
        assert.ok(fresh.links < 3, "links strictly below costOf's forced 3");

        void c.double;                               // force one derived -> +1 link
        const mid = costOfInstance(c);
        assert.equal(mid.links, 2, "reading double forms double->count; links climbs monotonically");
        assert.ok(mid.links > fresh.links, "monotonic increase toward the forced number");

        void c.band;                                 // force the second -> forced total
        const forced = costOfInstance(c);
        assert.equal(forced.links, 3, "reading band reaches costOf's forced 3");
        assert.equal(forced.links, costOf(Counter).links, "the forced instance matches the class probe exactly");
        disposeReactive(c);
    });

    t.test(label + ": a SYMBOL-keyed signal is counted and a @batched method never inflates any kind count", () => {
        assert.ok(typeof SYM === "symbol", "precondition: SYM is a symbol member");
        const c = new Counter();
        void c.double; void c.band;
        const inst = costOfInstance(c);
        // Counter carries count, level, and the symbol SYM: signals must be 3.
        assert.equal(inst.signals, 3, "the symbol-keyed @reactive member is counted in signals (count, level, SYM)");
        // onCount is the only effect; the @batched bump wires no node and is excluded.
        assert.equal(inst.effects, 1, "the @batched bump is excluded -- effects stays at onCount only");
        assert.equal(inst.deriveds, 2, "double + band; no phantom kinds");
        assert.equal(inst.nodes, inst.signals + inst.locals + inst.deriveds + inst.effects + 1, "nodes never exceed plan truth");
        disposeReactive(c);
    });

    t.test(label + ": @localTo members are counted in locals; the upstream tracking contributes ZERO graph links (Locals fixture)", () => {
        const loc = new Locals();
        void loc.draft; void loc.mirror;             // read both locals (upstream still static)
        const inst = costOfInstance(loc);
        assert.deepEqual(costFields(inst), costFields(costOf(Locals)), "Locals instance cost === class probe cost");
        assert.equal(inst.nodes, 4, "P+L+D+E+1 = 1+2+0+0+1 = 4");
        assert.equal(inst.locals, 2, "both @localTo members (draft, mirror) counted in locals");
        assert.equal(inst.signals, 1);
        assert.equal(inst.links, 0, "the @localTo upstream subscription is a seen-slot mechanism, not a counted graph edge");
        disposeReactive(loc);
    });
}

test("costOfInstance over the TS standard emit", (t) => {
    emitLaneSuite(t, tsClasses, "ts");
});

test("costOfInstance over the Babel 2023-11 emit", (t) => {
    emitLaneSuite(t, babelClasses, "babel");
});

// =================================================================================
// BUILDLESS LANE -- the A1 canonical shape with locals, built as a defineReactive
// twin: signals hp/mp (P=2), a @localTo shield keyed on hp (L=1), deriveds
// alive/power (D=2), an effect watch over hp (E=1). nodes = P+L+D+E+1 = 7.
// costOf(Avatar) = nodes 7, links 3 (alive->hp, power->mp, watch->hp; the local's
// upstream contributes no counted link).
// =================================================================================

function makeAvatar() {
    return defineReactive(class Avatar {}, {
        signals: { hp: 100, mp: 30 },
        locals: { shield: { source: (self) => self.hp, initial: 0 } },
        deriveds: { alive: (vm) => vm.hp > 0, power: (vm) => vm.mp * 2 },
        effects: { watch: (vm) => { void vm.hp; } },
    });
}

test("buildless A1: parity-when-forced on a locals-bearing shape (P=2,L=1,D=2,E=1) -- costOfInstance === costOf, nodes 7 links 3", () => {
    const Avatar = makeAvatar();
    const v = new Avatar();
    void v.alive; void v.power;                      // force both lazy deriveds
    const inst = costOfInstance(v);
    assert.deepEqual(costFields(inst), costFields(costOf(Avatar)), "forced instance cost === class probe cost, field for field");
    assert.equal(inst.nodes, 7, "1 anchor + 2 signals + 1 local + 2 deriveds + 1 effect = 7");
    assert.equal(inst.links, 3, "alive->hp, power->mp, watch->hp forced; the @localTo upstream is uncounted");
    assert.equal(inst.locals, 1, "the @localTo shield is counted in locals");
    disposeReactive(v);
});

test("buildless A2: delta-when-lazy with the intermediate asserted -- fresh links 1, read alive -> 2, read power -> 3", () => {
    const Avatar = makeAvatar();
    const v = new Avatar();
    const fresh = costOfInstance(v);
    assert.equal(fresh.nodes, 7, "nodes equal to the forced count even fresh");
    assert.equal(fresh.links, 1, "only the watch effect (watch->hp) has fired at wire; both deriveds are lazy");

    void v.alive;
    assert.equal(costOfInstance(v).links, 2, "reading alive forms alive->hp: the intermediate is exactly 2 (stable)");
    void v.power;
    assert.equal(costOfInstance(v).links, 3, "reading power forms power->mp: reaches the forced 3");
    assert.equal(costOfInstance(v).links, costOf(Avatar).links, "and the forced instance matches the class probe");
    disposeReactive(v);
});

test("buildless: the result is frozen and its shape keys are EXACTLY {nodes, links, signals, locals, deriveds, effects}", () => {
    const Avatar = makeAvatar();
    const v = new Avatar();
    void v.alive; void v.power;
    const inst = costOfInstance(v);
    assert.ok(Object.isFrozen(inst), "the per-call result is frozen (cold path, allocated by design)");
    assert.deepEqual(Object.keys(inst).sort(), SHAPE_KEYS.slice().sort(), "exactly the six kind/count keys, no more, no less");
    assert.equal(Object.getOwnPropertySymbols(inst).length, 0, "no symbol keys smuggled in");
    for (const k of SHAPE_KEYS) assert.ok(Number.isInteger(inst[k]), "field " + k + " is an integer");
    // UNCACHED (PD-70): two calls return DISTINCT frozen objects (never a cached identity).
    assert.notEqual(inst, costOfInstance(v), "each call allocates a fresh frozen result -- never cached");
    disposeReactive(v);
});

test("localTo links measurement: on an isolated signal+local shape a @localTo read (and an upstream move) contributes ZERO links -- measured, not assumed", () => {
    // P=1 signal `up`, L=1 local `loc` keyed on up. Nothing else. This isolates
    // exactly what a @localTo member contributes to the link tally.
    const LocalOnly = buildClass({ name: "LocalOnly", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "up", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "loc", decorator: localTo((self) => self.up), value: () => 0 },
    ] });
    const lo = new LocalOnly();
    const fresh = costOfInstance(lo);
    assert.equal(fresh.nodes, 3, "1 anchor + 1 signal + 1 local box");
    assert.equal(fresh.locals, 1, "the local is counted in locals");
    assert.equal(fresh.links, 0, "MEASURED: a fresh @localTo forms no counted link");

    void lo.loc;                                     // read the local accessor
    assert.equal(costOfInstance(lo).links, 0, "MEASURED: reading the @localTo accessor contributes 0 links");

    lo.up = 5;                                        // move the upstream (resets the local)
    assert.equal(costOfInstance(lo).links, 0, "MEASURED: an upstream move keeps links at 0 -- the seen-slot is not a graph edge");
    disposeReactive(lo);
});

// =================================================================================
// A3 -- the walk NEVER mutates the registry.
// =================================================================================

test("A3 registry-untouched: 10000 costOfInstance calls leave the default registry stats() snapshot byte-identical", () => {
    const Avatar = makeAvatar();
    const v = new Avatar();
    void v.alive; void v.power;

    const before = stats();
    for (let i = 0; i < 10000; i++) {
        const c = costOfInstance(v);
        if (c.nodes !== 7) throw new Error("A3: unexpected nodes " + c.nodes + " at call " + i);
    }
    const after = stats();
    assert.deepEqual(after, before, "activeNodes/activeLinks/totalDisposals and every other ledger field unchanged across 10000 walks");
    disposeReactive(v);
});

// =================================================================================
// PD-72 -- the registry-method form: a BOUND custom registry and a stats-less
// hand-rolled facade. The bound case is the regression case for the registry-
// method walk (handles are registry-scoped).
// =================================================================================

function avatarMembers() {
    return [
        { kind: "accessor", key: "hp", decorator: reactive, value: () => 100 },
        { kind: "accessor", key: "mp", decorator: reactive, value: () => 30 },
        { kind: "accessor", key: "shield", decorator: localTo((self) => self.hp), value: () => 0 },
        { kind: "getter", key: "alive", decorator: derived, body: function () { return this.hp > 0; } },
        { kind: "getter", key: "power", decorator: derived, body: function () { return this.mp * 2; } },
        { kind: "method", key: "watch", decorator: reactiveEffect, body: function () { void this.hp; } },
    ];
}

test("PD-72 bound-registry REGRESSION: a reactiveHost({ registry }) instance measures via its OWN registry (nodes 7, links 3), default stats frozen", () => {
    const reg = createRegistry({ maxNodes: 256, maxLinks: 256 });
    const BoundAvatar = buildClass({ name: "BoundAvatar", classDecorator: reactiveHost({ registry: reg }), members: avatarMembers() });
    const bv = new BoundAvatar();
    void bv.alive; void bv.power;

    // The regression: if the walk used the DEFAULT registry's forEachOwned on a
    // foreign handle it would yield 0 owned nodes (nodes 4, links 0). The registry-
    // method form (reg.forEachOwned via plan.reg) is why this reads the truth.
    const defaultBefore = stats();
    const inst = costOfInstance(bv);
    const defaultAfter = stats();
    assert.equal(inst.nodes, 7, "measured via the bound registry's own walkers -- the foreign-handle regression would report 4");
    assert.equal(inst.links, 3, "and its links are the bound registry's edges, not an empty walk");
    assert.deepEqual(costFields(inst), costFields(costOf(BoundAvatar)), "parity with the bound-registry probe");
    assert.deepEqual(defaultAfter, defaultBefore, "the DEFAULT registry stats stay frozen while a bound instance is measured");
    disposeReactive(bv);
});

test("PD-72 stats-less registry: costOfInstance measures on a hand-rolled facade that carries the walkers but NOT stats -- where costOf fails closed", () => {
    // The 11 duck-check methods + the two introspection walkers, bound to a real
    // registry, but no stats() ledger. reactiveHost wires fine; costOf throws;
    // costOfInstance (walk-based) works.
    const REG_METHODS = ["signalBox", "computedBox", "effect", "createRoot", "getOwner",
        "runWithOwner", "dispose", "nodeId", "isTracking", "batch", "untrack"];
    const real = createRegistry({ maxNodes: 128, maxLinks: 128 });
    const facade = {};
    for (const m of REG_METHODS) facade[m] = real[m].bind(real);
    facade.forEachOwned = real.forEachOwned.bind(real);
    facade.forEachSource = real.forEachSource.bind(real);

    const W = defineReactive(class NoStatsInst {}, {
        signals: { x: 1 },
        deriveds: { d: (self) => self.x },
        host: { registry: facade },
    });
    const w = new W();
    void w.d;

    // costOf needs stats() and fails closed on this facade.
    assert.throws(
        () => costOf(W),
        (e) => e instanceof TypeError && e.message.startsWith(ERR) && /stats\(\) ledger/.test(e.message),
        "costOf fails closed on a stats-less facade",
    );
    // costOfInstance is walk-based and measures it anyway (PD-72).
    const inst = costOfInstance(w);
    assert.equal(inst.nodes, 3, "1 anchor + 1 signal + 1 derived, measured with no stats ledger");
    assert.equal(inst.links, 1, "d->x forced");
    assert.equal(inst.signals, 1);
    assert.equal(inst.deriveds, 1);
    disposeReactive(w);
});

// =================================================================================
// PD-70 -- UNCACHED and LIVE: two calls across a graph change return DIFFERENT
// link counts. Proof the number is never cached.
// =================================================================================

test("PD-70 uncached/live: two costOfInstance calls across a branch flip return DIFFERENT link counts", () => {
    // A branchy derived reads a DIFFERENT source set depending on flag: false ->
    // {flag, a} (2 links); true -> {flag, a, b} (3 links). costOf would fail closed
    // on this (inconclusive probe); costOfInstance reports the LIVE truth per call.
    const Branchy = buildClass({ name: "BranchyInst", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "flag", decorator: reactive, value: () => false },
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "b", decorator: reactive, value: () => 2 },
        { kind: "getter", key: "sel", decorator: derived, body: function () { return this.flag ? this.a + this.b : this.a; } },
    ] });
    const br = new Branchy();
    void br.sel;
    const first = costOfInstance(br).links;
    assert.equal(first, 2, "flag=false: sel reads flag + a = 2 links");

    br.flag = true;                                  // flip the branch...
    void br.sel;                                     // ...and re-read to re-track
    const second = costOfInstance(br).links;
    assert.equal(second, 3, "flag=true: sel now reads flag + a + b = 3 links");
    assert.notEqual(first, second, "two calls across a graph change disagree -- the number is uncached and live");
    disposeReactive(br);
});

// =================================================================================
// A6 -- the fail-closed matrix. Every degenerate state throws NAMED; not one ever
// returns a silent { nodes: 0 } report (PD-71).
// =================================================================================

test("A6 fail-closed: a plain object throws throwNoPlan; never a {nodes:0} report", () => {
    for (const bad of [{}, { constructor: Object }, Object.create(null)]) {
        let threw = false, result = null;
        try { result = costOfInstance(bad); } catch (e) {
            threw = true;
            assert.ok(e instanceof Error && e.message.startsWith(ERR) && /costOfInstance/.test(e.message) &&
                /not a reactive instance/.test(e.message), "named no-plan throw for " + Object.prototype.toString.call(bad));
        }
        assert.ok(threw, "a plain object must throw, never return");
        assert.equal(result, null, "no {nodes:0} report was produced");
    }
});

test("A6 fail-closed: an unwired instance (forged { constructor }) throws throwNotWired; never a {nodes:0} report", () => {
    const Avatar = makeAvatar();
    const forged = { constructor: Avatar };
    let result = null;
    assert.throws(
        () => { result = costOfInstance(forged); },
        (e) => e instanceof Error && e.message.startsWith(ERR) && /costOfInstance/.test(e.message) && /not wired/.test(e.message),
        "named not-wired throw",
    );
    assert.equal(result, null, "no {nodes:0} report for an unwired instance");
});

test("A6 fail-closed: a PARKED instance throws ReactiveDisposedError with the parked flavor; never a {nodes:0} report", () => {
    const Avatar = makeAvatar();
    const v = new Avatar();
    assert.equal(releaseReactive(v), true, "park it");
    let result = null;
    assert.throws(
        () => { result = costOfInstance(v); },
        (e) => e instanceof ReactiveDisposedError && e.message.startsWith(ERR) && /parked/.test(e.message),
        "a parked vm holds ZERO nodes -- a {nodes:0} report would be indistinguishable from a bug, so it fails closed",
    );
    assert.equal(result, null, "no {nodes:0} report for a parked instance");
    // and it revives + measures correctly after reinit (the park was not terminal).
    reinitReactive(v);
    void v.alive; void v.power;
    assert.equal(costOfInstance(v).nodes, 7, "reinit revives the graph -- measurement resumes");
    disposeReactive(v);
});

test("A6 fail-closed: a DISPOSED instance throws ReactiveDisposedError with the disposed flavor; never a {nodes:0} report", () => {
    const Avatar = makeAvatar();
    const v = new Avatar();
    assert.equal(disposeReactive(v), true, "dispose it");
    let result = null;
    assert.throws(
        () => { result = costOfInstance(v); },
        (e) => e instanceof ReactiveDisposedError && e.message.startsWith(ERR) &&
            /disposeReactive/.test(e.message) && !/parked/.test(e.message),
        "the disposed flavor, not the parked one",
    );
    assert.equal(result, null, "no {nodes:0} report for a disposed instance");
});
