// test/10-qa-s2a-boundary.test.mjs -- independent QA adversarial boundary
// coverage for S2a (PLAN-S2a.md section 10), authored AFTER reviewer APPROVED.
// This file's job is the cases 08-effects/09-buildless did NOT think of: registry
// duck near-misses (a RegistryConfig, a partial facade missing exactly one
// method), same-object-vs-heterogeneous registry chains (including a THREE-level
// grandchild), a throwing scheduler, a plain-Error first effect run at wire time,
// a manual effect-method call via `Class.prototype.m.call(foreignObject)`,
// defineReactive spec edges from angles the coder did not exercise (symbol-keyed
// conflicts, a named-function bare signal, a getter/symbol collision, the
// "inherited is not a collision" boundary), the new boxOf(vm, effectKey /
// batchedKey) "has no backing box" surface, a D-4d re-pin from a second
// scheduled run and a cross-instance dispose, and a boundary matrix sweep
// (N=0 empty specs, NaN/-0 as signal VALUES, duplicate dispose with effect+
// batched members present, dispose-during-iteration, a self-referential
// re-entrant write, and one adversarial case: freezing the instance before
// dispose).
//
// Driven through the mock emitter (own process; clean module state), matching
// the pattern of 07/08/09. Every claim below was measured against the real
// module before being pinned -- see the QA report for anything that surfaced
// as a FINDING rather than a clean PASS.
//
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats, createRegistry } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import {
    buildClass,
    makeClassContext,
} from "./shared/mock-emitter.mjs";

const {
    reactive,
    derived,
    reactiveHost,
    reactiveEffect,
    batched,
    defineReactive,
    disposeReactive,
    boxOf,
    ReactiveDisposedError,
} = pkg;

function active() {
    return stats().activeNodes;
}

function drainPending() {
    try {
        reactiveHost(class Drain {}, makeClassContext("Drain"));
    } catch (_) {
        // orphan records were present; the buffer is now empty.
    }
}

// === Cluster A: registry duck-typing near-misses ==============================

test("QA-A1: a RegistryConfig object (config, no methods) -> named throw naming the FIRST missing method", () => {
    drainPending();
    assert.throws(
        () => reactiveHost({ registry: { maxNodes: 64 } }),
        (e) => e instanceof TypeError && /missing the `signalBox` method/.test(e.message) &&
            /not a RegistryConfig/.test(e.message),
    );
});

test("QA-A2: a facade missing exactly ONE method (untrack) -> the error names untrack specifically", () => {
    drainPending();
    const real = createRegistry({ maxNodes: 32 });
    const REG_METHODS = [
        "signalBox", "computedBox", "effect", "createRoot", "getOwner",
        "runWithOwner", "dispose", "nodeId", "isTracking", "batch", "untrack",
    ];
    const facade = {};
    for (const m of REG_METHODS) facade[m] = real[m].bind(real);
    delete facade.untrack;
    assert.throws(
        () => reactiveHost({ registry: facade }),
        (e) => e instanceof TypeError && /missing the `untrack` method/.test(e.message),
        "the error must name the actually-missing method, not a generic first-in-list message",
    );
});

test("QA-A3: registry: null and registry: a bare function both fail closed named (not silently treated as absent)", () => {
    drainPending();
    assert.throws(
        () => reactiveHost({ registry: null }),
        (e) => e instanceof TypeError && /missing the `signalBox` method/.test(e.message),
    );
    assert.throws(
        () => reactiveHost({ registry: function () {} }),
        (e) => e instanceof TypeError && /missing the `signalBox` method/.test(e.message),
    );
});

// === Cluster B: registry chain identity vs heterogeneity =======================

test("QA-B1: the SAME registry object repeated on a subclass is allowed (both directions readable)", () => {
    drainPending();
    const reg = createRegistry({ maxNodes: 64 });
    const A = buildClass({
        name: "SameRegA",
        classDecorator: reactiveHost({ registry: reg }),
        members: [{ kind: "accessor", key: "a", decorator: reactive, value: () => 1 }],
    });
    const B = buildClass({
        name: "SameRegB",
        superClass: A,
        classDecorator: reactiveHost({ registry: reg }),
        members: [{ kind: "accessor", key: "b", decorator: reactive, value: () => 2 }],
    });
    const regBefore = reg.stats().activeNodes;
    const b = new B();
    assert.equal(b.a, 1);
    assert.equal(b.b, 2);
    assert.ok(reg.stats().activeNodes > regBefore, "the custom registry actually allocated the merged chain");
    disposeReactive(b);
    assert.equal(reg.stats().activeNodes, regBefore, "back to baseline");
});

test("QA-B2: a two-level heterogeneous chain throws named, naming the DESCENDANT class", () => {
    drainPending();
    const reg1 = createRegistry({ maxNodes: 32 });
    const reg2 = createRegistry({ maxNodes: 32 });
    const G1 = buildClass({
        name: "HetG1",
        classDecorator: reactiveHost({ registry: reg1 }),
        members: [{ kind: "accessor", key: "a", decorator: reactive, value: () => 1 }],
    });
    assert.throws(
        () => buildClass({
            name: "HetG2",
            superClass: G1,
            classDecorator: reactiveHost({ registry: reg2 }),
            members: [{ kind: "accessor", key: "b", decorator: reactive, value: () => 2 }],
        }),
        (e) => e instanceof TypeError && /class HetG2 passes a different registry/.test(e.message) &&
            /one registry per host chain/.test(e.message),
    );
});

test("QA-B3: a THREE-level grandchild mismatch is caught at the grandchild, naming IT (not the base)", () => {
    drainPending();
    const reg1 = createRegistry({ maxNodes: 32 });
    const reg2 = createRegistry({ maxNodes: 32 });
    const H1 = buildClass({
        name: "HetH1",
        classDecorator: reactiveHost({ registry: reg1 }),
        members: [{ kind: "accessor", key: "a", decorator: reactive, value: () => 1 }],
    });
    // H2 inherits reg1 implicitly (no explicit registry) -- must NOT throw.
    const H2 = buildClass({
        name: "HetH2",
        superClass: H1,
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "b", decorator: reactive, value: () => 2 }],
    });
    assert.doesNotThrow(() => { const h2 = new H2(); disposeReactive(h2); });
    // H3 explicitly passes a DIFFERENT registry -- the mismatch surfaces here,
    // naming H3, even though the actual divergence originates at H1.
    assert.throws(
        () => buildClass({
            name: "HetH3",
            superClass: H2,
            classDecorator: reactiveHost({ registry: reg2 }),
            members: [{ kind: "accessor", key: "c", decorator: reactive, value: () => 3 }],
        }),
        (e) => e instanceof TypeError && /class HetH3 passes a different registry/.test(e.message),
    );
});

// === Cluster C: a throwing scheduler ============================================

test("QA-C1: a scheduler that throws surfaces synchronously at construction; conservation exact; registry stays usable", () => {
    drainPending();
    const C = buildClass({
        name: "ThrowingScheduler",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 0 },
            {
                kind: "method",
                key: "eff",
                decorator: reactiveEffect({ scheduler: () => { throw new Error("scheduler boom"); } }),
                body: function () { void this.v; },
            },
        ],
    });
    const before = active();
    assert.throws(() => new C(), (e) => e.message === "scheduler boom");
    assert.equal(active(), before, "the failed first construction leaked zero nodes");
    // A SECOND attempt on the same (deterministically throwing) class behaves
    // identically -- the module state was not corrupted by the first failure.
    assert.throws(() => new C(), (e) => e.message === "scheduler boom");
    assert.equal(active(), before, "conservation still exact after a second failed attempt");
    // The default registry is still usable for an UNRELATED class afterward.
    drainPending();
    const Other = buildClass({
        name: "AfterSchedulerThrow",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "x", decorator: reactive, value: () => 7 }],
    });
    const o = new Other();
    assert.equal(o.x, 7, "the registry is not wedged by the earlier throwing scheduler");
    disposeReactive(o);
});

// === Cluster D: a plain first-run throw (not CapacityError -- that is C's lane) =

test("QA-D1: a first effect run that throws a plain Error propagates synchronously; conservation exact; registry stays usable", () => {
    drainPending();
    let attempts = 0;
    const C = buildClass({
        name: "PlainFirstRunThrow",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 0 },
            {
                kind: "method",
                key: "eff",
                decorator: reactiveEffect,
                body: function () { attempts++; throw new Error("first run boom"); },
            },
        ],
    });
    const before = active();
    assert.throws(() => new C(), (e) => e.message === "first run boom");
    assert.equal(attempts, 1, "the body ran exactly once before propagating");
    assert.equal(active(), before, "wireInstance's catch -> disposeCore -> rethrow left conservation exact");
    // Retrying the SAME class fails the same way (deterministic, not corrupted).
    assert.throws(() => new C(), (e) => e.message === "first run boom");
    assert.equal(active(), before);
    // The default registry stays usable for a DIFFERENT class.
    drainPending();
    const Other = buildClass({
        name: "AfterFirstRunThrow",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "y", decorator: reactive, value: () => 3 }],
    });
    const o = new Other();
    assert.equal(o.y, 3);
    disposeReactive(o);
});

// === Cluster E: manual call via Class.prototype.m.call(foreignObject) ==========
//
// RE-PINNED (D-4e, delta-approved fix): the QA-E1/E2 findings from the first
// pass -- a foreign `this` silently ran the body instead of failing closed --
// are now closed. `makeEffectPublic`/`makeBatchedPublic` add an identity guard:
// `planOf(this)` must resolve AND `plan.byKey.get(rec.key) === rec` (the exact
// SAME rec object the closure captured, not just a same-shaped one on some other
// plan). A null, primitive, foreign-plain-object, or cross-class receiver now
// throws the named not-wired error via `throwNotWired`, matching /not wired/.

test("QA-E1: D-4e -- a manual call on a genuinely foreign plain object now throws the named not-wired error", () => {
    drainPending();
    const Hosted = buildClass({
        name: "ForeignCallTarget",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: reactive, value: () => 0 },
            { kind: "method", key: "onCount", decorator: reactiveEffect, body: function () { return this.count; } },
        ],
    });
    assert.throws(
        () => Hosted.prototype.onCount.call({}),
        (e) => e instanceof Error && /not wired/.test(e.message) && /ForeignCallTarget\.onCount/.test(e.message),
        "the identity guard fails closed on a bare foreign object, named Class.key",
    );
    // null and a primitive `this` are equally foreign -- same named throw, no crash.
    assert.throws(() => Hosted.prototype.onCount.call(null), (e) => /not wired/.test(e.message));
    assert.throws(() => Hosted.prototype.onCount.call(42), (e) => /not wired/.test(e.message));
});

test("QA-E2: D-4e -- a foreign object carrying its OWN same-named data property STILL fails closed (identity, not shape)", () => {
    drainPending();
    const Hosted = buildClass({
        name: "ForeignCallTarget2",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: reactive, value: () => 0 },
            { kind: "method", key: "onCount", decorator: reactiveEffect, body: function () { return this.count; } },
        ],
    });
    // A shape-alike object (has its own `count`) is still not a wired instance of
    // THIS plan -- the guard is byKey identity, not duck-shape, so it throws too.
    assert.throws(
        () => Hosted.prototype.onCount.call({ count: 999 }),
        (e) => /not wired/.test(e.message),
        "measured: identity guard rejects a shape-alike foreign object; duck-shape reads no longer happen",
    );
});

test("QA-E3b: D-4e -- the identity guard fires for the @batched public method too, not just @reactiveEffect", () => {
    drainPending();
    const Hosted = buildClass({
        name: "ForeignBatchedTarget",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: reactive, value: () => 0 },
            { kind: "method", key: "bump", decorator: batched, body: function () { this.count++; return this.count; } },
        ],
    });
    assert.throws(
        () => Hosted.prototype.bump.call({}),
        (e) => e instanceof Error && /not wired/.test(e.message) && /ForeignBatchedTarget\.bump/.test(e.message),
        "the SAME identity guard protects the batched public method",
    );
    // A live instance of a DIFFERENT (unrelated) hosted class is also foreign --
    // its plan resolves, but byKey.get("bump") on ITS plan is not this rec.
    const Other = buildClass({
        name: "UnrelatedHost",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "x", decorator: reactive, value: () => 0 }],
    });
    const other = new Other();
    assert.throws(
        () => Hosted.prototype.bump.call(other),
        (e) => /not wired/.test(e.message),
        "cross-class receiver (a real, live, but unrelated reactive instance) is still foreign",
    );
    disposeReactive(other);
});

test("QA-E3a: D-4e positive control -- a Derived instance manually calling a Base-declared effect method still succeeds (identity, not exact-class equality)", () => {
    drainPending();
    const Base = buildClass({
        name: "IdentityBase",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            { kind: "method", key: "onA", decorator: reactiveEffect, body: function () { return this.a; } },
        ],
    });
    const Sub = buildClass({ name: "IdentitySub", superClass: Base, members: [] });
    const sub = new Sub();
    assert.equal(
        Base.prototype.onA.call(sub), 1,
        "the merged plan's byKey still maps onA to the SAME rec for the inherited-host subclass instance",
    );
    disposeReactive(sub);
});

test("QA-E3: contrast -- a manual call with `this` bound to a DISPOSED instance of the SAME class DOES fail closed named", () => {
    drainPending();
    const Hosted = buildClass({
        name: "ForeignCallTarget3",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: reactive, value: () => 0 },
            { kind: "method", key: "onCount", decorator: reactiveEffect, body: function () { return this.count; } },
        ],
    });
    const c = new Hosted();
    disposeReactive(c);
    assert.throws(
        () => Hosted.prototype.onCount.call(c),
        (e) => e instanceof ReactiveDisposedError,
        "the poisoned slot on a genuinely-disposed same-class instance still fails closed",
    );
});

// === Cluster F: boxOf(vm, effectKey / batchedKey) -- delta-approved fix ========

test('QA-F1: boxOf(vm, effectKey) throws the dedicated "has no backing box" error', () => {
    drainPending();
    const C = buildClass({
        name: "BoxOfEffect",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: reactive, value: () => 0 },
            { kind: "method", key: "onCount", decorator: reactiveEffect, body: function () { void this.count; } },
        ],
    });
    const c = new C();
    assert.throws(
        () => boxOf(c, "onCount"),
        (e) => e instanceof Error && /has no backing box/.test(e.message) && /@reactiveEffect/.test(e.message),
    );
    disposeReactive(c);
});

test('QA-F2: boxOf(vm, batchedKey) throws the dedicated "has no backing box" error', () => {
    drainPending();
    const C = buildClass({
        name: "BoxOfBatched",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: reactive, value: () => 0 },
            { kind: "method", key: "bump", decorator: batched, body: function () { this.count++; } },
        ],
    });
    const c = new C();
    assert.throws(
        () => boxOf(c, "bump"),
        (e) => e instanceof Error && /has no backing box/.test(e.message) && /@batched/.test(e.message),
    );
    disposeReactive(c);
});

test("QA-F3: an UNKNOWN key on a class that also has effect/batched members still gets the did-you-mean, not the box error", () => {
    drainPending();
    const C = buildClass({
        name: "BoxOfUnknownNearEffect",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: reactive, value: () => 0 },
            { kind: "method", key: "onCount", decorator: reactiveEffect, body: function () { void this.count; } },
            { kind: "method", key: "bump", decorator: batched, body: function () { this.count++; } },
        ],
    });
    const c = new C();
    assert.throws(
        () => boxOf(c, "onCoun"),
        (e) => /did you mean `onCount`/.test(e.message) && !/has no backing box/.test(e.message),
    );
    disposeReactive(c);
});

// === Cluster G: defineReactive spec edges, QA's own angle =====================

test("QA-G1: { equals } alone (no initial/init) -> initial is undefined, legal", () => {
    const C = defineReactive(class EqAlone {}, {
        signals: { v: { equals: (a, b) => a === b } },
    });
    const c = new C();
    assert.equal(c.v, undefined, "no initial/init given -> undefined, not a throw");
    disposeReactive(c);
});

test("QA-G2: an object `initial` in descriptor form is used verbatim (not treated as a nested descriptor)", () => {
    const shape = { foo: 1 };
    const C = defineReactive(class ObjInit {}, {
        signals: { v: { initial: shape } },
    });
    const c = new C();
    assert.deepEqual(c.v, { foo: 1 });
    disposeReactive(c);
});

test("QA-G3: initial+init conflict via a SYMBOL key -> named throw naming both initial and init", () => {
    const SYM = Symbol("conflict");
    assert.throws(
        () => defineReactive(class SymConflict {}, { signals: { [SYM]: { initial: 1, init: () => 2 } } }),
        (e) => e instanceof TypeError && /initial/.test(e.message) && /init/.test(e.message),
    );
});

test("QA-G4: a bare NAMED function reference (not an arrow) as a signal entry is still ambiguous -> named throw", () => {
    function computeIt() { return 1; }
    assert.throws(
        () => defineReactive(class BareNamed {}, { signals: { x: computeIt } }),
        (e) => e instanceof TypeError && /ambiguous/.test(e.message) && /initial: fn/.test(e.message),
    );
});

test("QA-G5: a spec key colliding with an existing GETTER (accessor, not a method) -> named throw", () => {
    class HasGetter {
        get val() { return 1; }
    }
    assert.throws(
        () => defineReactive(HasGetter, { signals: { val: 0 } }),
        (e) => e instanceof TypeError && /HasGetter\.prototype already owns/.test(e.message),
    );
});

test("QA-G6: a spec key colliding with an existing SYMBOL-keyed prototype method -> named throw", () => {
    const SYM = Symbol("collide");
    class HasSymMethod {
        [SYM]() { return 1; }
    }
    assert.throws(
        () => defineReactive(HasSymMethod, { signals: { [SYM]: 0 } }),
        (e) => e instanceof TypeError && /already owns/.test(e.message),
    );
});

test("QA-G7: an INHERITED (non-own) same-named member is NOT a collision -- the check is own-property only", () => {
    class Base2 {
        helper() { return "base"; }
    }
    class Sub2 extends Base2 {}
    const C = defineReactive(Sub2, { effects: { helper: () => {} } });
    const c = new C();
    // The spec-declared effect method now SHADOWS the inherited one on Sub2's
    // own prototype (installRec defines an own property under the same key).
    assert.equal(typeof c.helper, "function", "installed without a collision throw");
    disposeReactive(c);
});

// === Cluster H: D-4d re-pin from QA's own angle ================================

test("QA-H1: self-dispose from the SECOND scheduled run (via a scheduler) is allowed; conservation exact", () => {
    drainPending();
    const captured = [];
    let fires = 0;
    let disposedRet = null;
    const C = buildClass({
        name: "SecondRunSelfDispose",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 0 },
            {
                kind: "method",
                key: "eff",
                decorator: reactiveEffect({ scheduler: (run) => { captured.push(run); } }),
                body: function () {
                    fires++;
                    void this.v;
                    if (fires === 2) disposedRet = disposeReactive(this);
                },
            },
        ],
    });
    const before = active();
    const c = new C();
    assert.equal(captured.length, 1, "first run deferred through the trampoline");
    captured[0]();                              // run 1: does not self-dispose
    assert.equal(fires, 1);
    assert.equal(disposedRet, null, "run 1 did not self-dispose");
    c.v = 1;                                     // schedules run 2
    assert.equal(captured.length, 2, "the tracked write scheduled a second flush");
    captured[1]();                              // run 2: self-disposes
    assert.equal(fires, 2, "the second run executed exactly once");
    assert.equal(disposedRet, true, "self-dispose from the SECOND run is allowed and reports success");
    assert.equal(active(), before, "conservation exact after a second-run self-dispose");
});

test("QA-H2: one instance's owned effect disposes a DIFFERENT (foreign) instance -- legal, counted, conservation exact", () => {
    drainPending();
    let bodyRuns = 0;
    let otherDisposeResult = null;
    const D = buildClass({
        name: "CrossInstanceDispose",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 0 },
            { kind: "field", key: "target", value: () => null },
            {
                kind: "method",
                key: "killTarget",
                decorator: reactiveEffect,
                body: function () {
                    bodyRuns++;
                    void this.v;
                    if (this.target !== null) otherDisposeResult = disposeReactive(this.target);
                },
            },
        ],
    });
    const before = active();
    const inst1 = new D();
    const inst2 = new D();
    assert.equal(bodyRuns, 2, "each instance's own effect fired once at its own wire");
    inst1.target = inst2;                       // plain field write, untracked -- no re-run yet
    inst1.v = 5;                                 // triggers inst1's effect to re-run and dispose inst2
    assert.equal(bodyRuns, 3, "inst1's effect re-ran exactly once on its own tracked write");
    assert.equal(otherDisposeResult, true, "cross-instance dispose from an owned effect succeeds and is counted");
    assert.throws(() => inst2.v, ReactiveDisposedError, "inst2 is genuinely disposed");
    disposeReactive(inst1);
    assert.equal(active(), before, "conservation exact once both instances are torn down");
});

// === Cluster I: boundary matrix =================================================

test("QA-I1: N=0 -- an empty defineReactive spec ({}) allocates exactly the anchor (delta 1)", () => {
    const before = active();
    const C = defineReactive(class Empty {}, {});
    const c = new C();
    assert.equal(active() - before, 1, "zero signals, zero deriveds, zero effects -> just the anchor");
    disposeReactive(c);
    assert.equal(active(), before);
});

test("QA-I2: N=0 -- a decorator host with zero members allocates exactly the anchor (delta 1)", () => {
    drainPending();
    const before = active();
    const C = buildClass({ name: "EmptyHost", classDecorator: reactiveHost, members: [] });
    const c = new C();
    assert.equal(active() - before, 1);
    disposeReactive(c);
    assert.equal(active(), before);
});

test("QA-I3: NaN as a SIGNAL VALUE (not a key): default Object.is equals suppresses a repeat NaN write", () => {
    drainPending();
    let recomputes = 0;
    const C = buildClass({
        name: "NanValue",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 0 },
            { kind: "getter", key: "d", decorator: derived, body: function () { recomputes++; return this.v; } },
        ],
    });
    const c = new C();
    assert.equal(c.d, 0);
    const base = recomputes;
    c.v = NaN;
    assert.ok(Number.isNaN(c.d));
    assert.equal(recomputes - base, 1, "first NaN write propagates (0 -> NaN is a real change)");
    c.v = NaN;                                    // same NaN again: Object.is(NaN, NaN) === true
    assert.equal(recomputes - base, 1, "a repeat NaN write is suppressed by default Object.is equality");
    disposeReactive(c);
});

test("QA-I4: -0 and 0 are DISTINCT under default equals as SIGNAL VALUES (Object.is, not ==)", () => {
    drainPending();
    let recomputes = 0;
    const C = buildClass({
        name: "NegZeroValue",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => NaN },
            { kind: "getter", key: "d", decorator: derived, body: function () { recomputes++; return this.v; } },
        ],
    });
    const c = new C();
    void c.d;
    const base = recomputes;
    c.v = -0;
    assert.ok(Object.is(c.d, -0));
    assert.equal(recomputes - base, 1, "NaN -> -0 is a real change");
    c.v = 0;
    assert.ok(Object.is(c.d, 0), "0 propagated: Object.is(0, -0) is false, so it is a real change too");
    assert.equal(recomputes - base, 2, "-0 -> 0 is NOT suppressed: they are distinct under Object.is");
    disposeReactive(c);
});

test("QA-I5: duplicate dispose on a class carrying BOTH effect and batched members -- true then false, batched call after dispose fails closed", () => {
    drainPending();
    const before = active();
    const C = buildClass({
        name: "DupDisposeWithEffectsAndBatched",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: reactive, value: () => 0 },
            { kind: "method", key: "onCount", decorator: reactiveEffect, body: function () { void this.count; } },
            { kind: "method", key: "bump", decorator: batched, body: function () { this.count = this.count + 1; } },
        ],
    });
    const c = new C();
    assert.equal(disposeReactive(c), true, "first dispose succeeds");
    assert.equal(disposeReactive(c), false, "second dispose is an idempotent no-op");
    assert.equal(active(), before, "conservation back to baseline");
    assert.throws(
        () => c.bump(),
        (e) => e instanceof ReactiveDisposedError,
        "a manual @batched call after dispose fails closed (the batch body reads the poisoned slot), not a crash",
    );
});

test("QA-I6: dispose-during-iteration -- an instance disposed EARLY from a sibling's effect, then reached normally by a later loop pass, is idempotent", () => {
    drainPending();
    const N = 5;
    const D = buildClass({
        name: "DisposeDuringIteration",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 0 },
            { kind: "field", key: "target", value: () => null },
            {
                kind: "method",
                key: "killTarget",
                decorator: reactiveEffect,
                body: function () { void this.v; if (this.target !== null) disposeReactive(this.target); },
            },
        ],
    });
    const before = active();
    const insts = [];
    for (let i = 0; i < N; i++) insts.push(new D());
    // Instance 0's effect disposes instance 2 EARLY (out of loop order) by
    // targeting it then nudging its own tracked signal.
    insts[0].target = insts[2];
    insts[0].v = 1;                              // re-runs killTarget -> disposes insts[2] early
    assert.throws(() => insts[2].v, ReactiveDisposedError, "instance 2 was disposed out of turn");
    // Now dispose every instance in order; the loop reaches the already-disposed
    // instance 2 and must get `false` back (idempotent), not a crash or a
    // double-free, and every OTHER instance disposes normally (`true`).
    const results = [];
    for (let i = 0; i < N; i++) results.push(disposeReactive(insts[i]));
    assert.deepEqual(results, [true, true, false, true, true], "instance 2 alone reports the idempotent false");
    assert.equal(active(), before, "no leaked or double-freed nodes across the whole loop");
});

test("QA-I7: a self-referential re-entrant write (effect writes its own tracked signal) settles without an infinite loop or a delayed re-run", async () => {
    drainPending();
    let effRuns = 0;
    const D = buildClass({
        name: "ReentrantSelfWrite",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "n", decorator: reactive, value: () => 0 },
            {
                kind: "method",
                key: "grow",
                decorator: reactiveEffect,
                body: function () {
                    effRuns++;
                    const cur = this.n;
                    if (cur < 3) this.n = cur + 1;   // re-entrant write to its OWN tracked dep
                },
            },
        ],
    });
    const d = new D();
    assert.equal(effRuns, 1, "measured: the re-entrant write does not cause a synchronous cascading re-run");
    assert.equal(d.n, 1, "measured: exactly one hop landed (0 -> 1), not a runaway climb to 3");
    // Confirm no delayed/async flush resurrects further runs.
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(effRuns, 1, "no deferred re-run surfaced asynchronously either");
    assert.equal(d.n, 1);
    disposeReactive(d);
});

// --- Adversarial re-pin (D-2g, delta-approved fix): freezing before dispose --
//
// RE-PINNED: the original QA-ADVERSARIAL finding -- freeze corrupted the
// idempotency contract with a raw TypeError and a half-torn-down instance -- is
// closed. `disposeReactive` now checks `Object.isFrozen(vm)` UP FRONT, before
// the anchor is touched, and refuses ATOMICALLY with a named error matching
// /frozen/. Nothing is disposed: the anchor cascade never runs, the signal box
// is never torn down, and the ANCHOR slot is untouched -- so a captured box
// from before the freeze is still fully live, and a SECOND attempt throws the
// SAME named refusal again (not a corrupted raw TypeError, and not a false
// idempotent success -- a frozen instance can never be disposed at all).
// `seal`/`preventExtensions` (which do NOT make own properties non-writable)
// are unaffected: the poison swap can still be installed, so dispose proceeds
// normally on a sealed-but-not-frozen instance.
test("QA-ADVERSARIAL (D-2g): freezing the instance before dispose refuses atomically, named, and changes nothing", () => {
    drainPending();
    const C = buildClass({
        name: "FreezeBeforeDispose",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "v", decorator: reactive, value: () => 1 }],
    });
    const before = active();
    const c = new C();
    const wired = active() - before;             // construction delta (anchor + v box)
    const box = boxOf(c, "v");                  // captured while still live
    Object.freeze(c);

    assert.throws(
        () => disposeReactive(c),
        (e) => e instanceof TypeError && /frozen/.test(e.message) && /FreezeBeforeDispose/.test(e.message),
        "the refusal is named and matches /frozen/, not a raw engine TypeError",
    );
    // Atomicity: nothing was disposed. The instance's OWN graph is still fully
    // allocated (delta unchanged from construction) -- not merely numerically
    // rebalanced via free-then-leak-elsewhere.
    assert.equal(active() - before, wired, "the wired graph is still fully live -- the refused attempt disposed nothing");
    assert.equal(box.peek(), 1, "the captured box is still fully live and readable after the refusal");
    assert.equal(c.v, 1, "the instance itself is still live and readable through its own accessor");

    // A second attempt refuses IDENTICALLY -- not a corrupted raw error, and not
    // a false idempotent `false` (a frozen instance can never be disposed).
    assert.throws(
        () => disposeReactive(c),
        (e) => e instanceof TypeError && /frozen/.test(e.message),
        "the second attempt throws the SAME named refusal, not a raw TypeError and not a silent false",
    );
    assert.equal(active() - before, wired, "still fully live after the second refused attempt");
    assert.equal(box.peek(), 1, "still live after the second refused attempt");
});

test("QA-ADVERSARIAL companion: seal/preventExtensions do NOT trigger the frozen refusal -- dispose proceeds normally", () => {
    drainPending();
    const C = buildClass({
        name: "SealedNotFrozen",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "v", decorator: reactive, value: () => 1 }],
    });
    const before = active();
    const sealed = new C();
    Object.seal(sealed);
    assert.equal(disposeReactive(sealed), true, "a sealed (but not frozen) instance disposes normally");
    assert.equal(active(), before, "conservation back to baseline");

    const nonExtensible = new C();
    Object.preventExtensions(nonExtensible);
    assert.equal(disposeReactive(nonExtensible), true, "a non-extensible (but not frozen) instance disposes normally too");
    assert.equal(active(), before, "conservation back to baseline");
});
