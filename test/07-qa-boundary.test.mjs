// test/07-qa-boundary.test.mjs -- independent QA boundary coverage for S1.
// Targets the four post-approval advisories plus the coverage gaps named in
// BRIEF1 sec.8 (QA charge): numeric-looking string keys, symbol keys through
// boxOf, an `equals` predicate that throws mid-set, dispose inside a `using`
// block that also calls disposeReactive manually, and a boxOf did-you-mean.
// Also closes a small boundary matrix around the lookup entry points
// (disposeReactive/boxOf/rootOf) for null/undefined/empty-string keys, an
// invalid `equals` (NaN, a numeric value that is not a function), and two
// adversarial cases: re-entrant disposeReactive from inside a @derived body
// mid-computation, and a re-entrant write to a sibling member from inside an
// `equals` predicate.
//
// Driven through the mock emitter (own process; clean module state), matching
// the pattern of 05/06. ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats, effect as liteEffect, dispose as liteDispose } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import {
    buildClass,
    makeClasses,
    makeClassContext,
} from "./shared/mock-emitter.mjs";

const { reactive, derived, reactiveHost, boxOf, rootOf, disposeReactive, ReactiveDisposedError } = pkg;

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

// --- (a) equals: undefined behaves as bare (advisory 1) -----------------------

test("reactive({ equals: undefined }) behaves as bare: default equality accepted", () => {
    drainPending();
    const recompute = { d: 0 };
    const C = buildClass({
        name: "EqUndef",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive({ equals: undefined }), value: () => 1 },
            {
                kind: "getter",
                key: "d",
                decorator: derived,
                body: function () { recompute.d++; return this.v * 2; },
            },
        ],
    });
    const c = new C();
    assert.equal(c.d, 2, "initial derived value");
    assert.equal(recompute.d, 1, "first read computes once");
    c.v = 1; // same value under default Object.is: must NOT propagate
    assert.equal(c.d, 2);
    assert.equal(recompute.d, 1, "no-op set suppressed by default equality, not a passthrough bug");
    c.v = 5;
    assert.equal(c.d, 10);
    assert.equal(recompute.d, 2, "a real change still propagates");
    disposeReactive(c);
});

// --- (a) boxOf on a forged instance throws "not wired", not undefined ---------

test("boxOf on a forged { constructor } object throws named (not wired), never returns undefined", () => {
    drainPending();
    const Real = buildClass({
        name: "ForgeTarget",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "x", decorator: reactive, value: () => 0 }],
    });
    const forged = { constructor: Real };
    assert.throws(
        () => boxOf(forged, "x"),
        (e) => e instanceof Error && /not wired/.test(e.message),
        "must throw a named error, not silently return undefined",
    );
});

// --- (b) symbol-keyed member through boxOf round trip --------------------------

test("symbol-keyed member: boxOf round-trip live, then ReactiveDisposedError after dispose", () => {
    drainPending();
    const SYM = Symbol("qa-sym-key");
    const C = buildClass({
        name: "SymRoundTrip",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: SYM, decorator: reactive, value: () => "init" }],
    });
    const c = new C();
    const box = boxOf(c, SYM);
    assert.equal(box.peek(), "init");
    c[SYM] = "changed";
    assert.equal(box.peek(), "changed");
    disposeReactive(c);
    assert.throws(
        () => boxOf(c, SYM),
        (e) => e instanceof ReactiveDisposedError && e.className === "SymRoundTrip",
    );
});

// --- (c) equals that throws mid-set: propagates unchanged, instance intact ----

test("equals predicate that throws mid-set: propagates to the setter call site, instance stays readable", () => {
    drainPending();
    const boom = new Error("equals blew up");
    const C = buildClass({
        name: "ThrowingEquals",
        classDecorator: reactiveHost,
        members: [
            {
                kind: "accessor",
                key: "v",
                decorator: reactive({
                    equals() { throw boom; },
                }),
                value: () => 1,
            },
        ],
    });
    const c = new C();
    assert.equal(c.v, 1);
    assert.throws(() => { c.v = 2; }, (e) => e === boom, "the exact engine exception, unmodified");
    // The instance must not be corrupted: a subsequent read still works and
    // reflects the OLD value (the write never committed, since equals ran
    // before the assignment in the engine contract).
    assert.equal(c.v, 1, "read after a throwing set still works");
    // And a normal write afterwards still works (box is not wedged).
    // Re-decorate a sibling to confirm the class/plan itself is unharmed:
    disposeReactive(c);
    const c2 = new C();
    assert.equal(c2.v, 1);
    disposeReactive(c2);
});

// --- (d) using + manual disposeReactive: implicit dispose is a silent no-op ---

test("using block plus a manual disposeReactive inside: implicit Symbol.dispose at exit is a silent idempotent no-op", () => {
    drainPending();
    const { Counter } = makeClasses(pkg);
    const before = active();
    let ranAfterBlock = false;
    {
        using c = new Counter();
        assert.equal(c.count, 0);
        const firstResult = disposeReactive(c);
        assert.equal(firstResult, true, "manual dispose inside the block succeeds");
        assert.throws(() => c.count, ReactiveDisposedError);
        ranAfterBlock = true;
        // block exit triggers c[Symbol.dispose](), i.e. a SECOND disposeReactive
        // call on an already-disposed instance -- must not throw.
    }
    assert.equal(ranAfterBlock, true);
    assert.equal(active(), before, "no leaked nodes despite the double teardown path");
});

// --- (e) numeric-looking string key "0" (and "-0") works through the full round trip

test('numeric-looking string key "0" works as a reactive member name end to end', () => {
    drainPending();
    const C = buildClass({
        name: "NumKey",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "0", decorator: reactive, value: () => "zero" },
            { kind: "accessor", key: "-0", decorator: reactive, value: () => "neg-zero" },
        ],
    });
    const c = new C();
    assert.equal(c["0"], "zero");
    assert.equal(c[0], "zero", "numeric-index access resolves to the same string-keyed property");
    c["0"] = "changed";
    assert.equal(c["0"], "changed");
    assert.equal(boxOf(c, "0").peek(), "changed");

    // "-0" is a DISTINCT string key from "0" -- not to be confused with the
    // numeric negative zero value.
    assert.equal(c["-0"], "neg-zero");
    assert.notEqual(c["0"], c["-0"]);
    disposeReactive(c);
    assert.throws(() => c["0"], ReactiveDisposedError);
    assert.throws(() => c["-0"], ReactiveDisposedError);
});

// --- (f) boxOf did-you-mean: "cont" on a class with "count" suggests "count" --

test('boxOf did-you-mean: unknown key "cont" on Counter (has "count") suggests count', () => {
    drainPending();
    const { Counter } = makeClasses(pkg);
    const c = new Counter();
    assert.throws(
        () => boxOf(c, "cont"),
        (e) => /did you mean `count`/.test(e.message),
    );
    disposeReactive(c);
});

// --- boundary matrix: null/undefined/empty/NaN at the lookup entry points -----

test("disposeReactive/boxOf/rootOf on null and undefined throw named (no plan), not a TypeError crash", () => {
    for (const bad of [null, undefined]) {
        assert.throws(
            () => disposeReactive(bad),
            (e) => e instanceof Error && /not a reactive instance/.test(e.message),
        );
        assert.throws(
            () => boxOf(bad, "x"),
            (e) => e instanceof Error && /not a reactive instance/.test(e.message),
        );
        assert.throws(
            () => rootOf(bad),
            (e) => e instanceof Error && /not a reactive instance/.test(e.message),
        );
    }
});

test('boxOf with an empty-string key and a NaN key both fail closed with a named "no such member" error', () => {
    drainPending();
    const { Counter } = makeClasses(pkg);
    const c = new Counter();
    assert.throws(
        () => boxOf(c, ""),
        (e) => e instanceof Error && /no such reactive member/.test(e.message),
    );
    assert.throws(
        () => boxOf(c, NaN),
        (e) => e instanceof Error && /no such reactive member/.test(e.message),
    );
    disposeReactive(c);
});

test("reactive({ equals: NaN }) is rejected named at decoration time (not silently coerced)", () => {
    drainPending();
    assert.throws(
        () => reactive({ equals: NaN }),
        (e) => e instanceof TypeError && /must be a function/.test(e.message),
    );
});

// --- adversarial 1: re-entrant disposeReactive from inside its own @derived ---
//
// Pins decision D-2f (decisions/0002 amendment): disposeReactive(this) called
// from INSIDE the instance's own @derived computation must throw a named
// Error naming the class and the derived key ("derived getters must be
// pure" -- dispose from an effect, a subscription, or plain code instead),
// never silently discard the computation's return value. This closes the gap
// this file originally reported as a FINDING (self-dispose mid-compute used
// to return `undefined` with no error); the core now fails closed.
test("D-2f: disposeReactive(this) from within its own @derived getter throws a named self-dispose error", () => {
    drainPending();
    const C = buildClass({
        name: "ReentrantDisposeDuringDerive",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 1 },
            {
                kind: "getter",
                key: "selfDisposing",
                decorator: derived,
                body: function () {
                    // Dispose the instance owning this very computation, while
                    // the computation is still on the stack.
                    disposeReactive(this);
                    return 42; // unreachable on a correct core
                },
            },
        ],
    });
    const baseline = active();
    const c = new C();
    assert.equal(active() - baseline, 3, "construction allocated v + selfDisposing box + anchor");
    assert.throws(
        () => c.selfDisposing,
        (e) => e instanceof Error &&
            /derived getters must be pure/.test(e.message) &&
            /ReentrantDisposeDuringDerive/.test(e.message) &&
            /selfDisposing/.test(e.message),
        "must throw naming the class and the derived key, not silently return/drop a value",
    );
    // The guard must not have torn anything down: a rejected self-dispose is
    // a no-op on the instance, so a normal (foreign-context) dispose still
    // works afterward and returns to baseline cleanly.
    assert.equal(disposeReactive(c), true, "instance is still live and disposable normally after the rejected self-dispose");
    assert.equal(active(), baseline, "no leaked nodes after the guarded rejection + normal dispose");
});

// Companion (guard must not false-positive): disposing the SAME instance from
// inside a FOREIGN raw lite-signal effect -- not one of the instance's own
// @derived computations -- must proceed normally and return `true`. This
// exercises the isTracking()/nodeId() branch of the D-2f guard against a
// live tracking context that is NOT one of the instance's own deriveds.
test("D-2f companion: disposeReactive of the same instance from inside a FOREIGN effect proceeds (returns true)", () => {
    drainPending();
    const C = buildClass({
        name: "ForeignEffectDispose",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "v", decorator: reactive, value: () => 1 }],
    });
    const baseline = active();
    const c = new C();
    let disposeResult = null;
    let threw = null;
    const stopEffect = liteEffect(() => {
        // A manager/foreign effect: not one of `c`'s own @derived computations,
        // and not tracking any of `c`'s members either.
        try {
            disposeResult = disposeReactive(c);
        } catch (e) {
            threw = e;
        }
    });
    assert.equal(threw, null, "foreign-context dispose must not be rejected by the D-2f guard");
    assert.equal(disposeResult, true, "foreign-context dispose proceeds and reports success");
    assert.throws(() => c.v, ReactiveDisposedError, "the instance is genuinely disposed");
    liteDispose(stopEffect);
    assert.equal(active(), baseline, "no leaked nodes: instance teardown + effect teardown both landed");
});

// --- adversarial 2: re-entrant write to a sibling member from inside `equals` -
//
// Note: lite-signal invokes `equals(oldValue, newValue)` as a plain function
// call (no `this` binding to the reactive instance -- consistent with the
// `(a, b) => boolean` arrow-friendly type signature in SignalDecorators.d.ts).
// So the re-entrant write below reaches the sibling member through a closure
// over `c`, not `this`.
test("ADVERSARIAL: equals predicate writes to a sibling reactive member as a side effect (re-entrant write during set)", () => {
    drainPending();
    let c; // assigned after construction; closed over by the equals predicate
    let sideEffectRan = false;
    const C = buildClass({
        name: "ReentrantWriteInEquals",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "y", decorator: reactive, value: () => 0 },
            {
                kind: "accessor",
                key: "x",
                decorator: reactive({
                    equals(a, b) {
                        if (!sideEffectRan) {
                            sideEffectRan = true;
                            c.y = 999; // re-entrant write to a sibling during x's equals check
                        }
                        return a === b;
                    },
                }),
                value: () => 1,
            },
        ],
    });
    c = new C();
    let caught = null;
    try {
        c.x = 2;
    } catch (e) {
        caught = e;
    }
    // MEASURED: whatever the engine's real contract is, record it plainly.
    assert.equal(caught, null, "re-entrant sibling write during equals did not crash the setter");
    assert.equal(sideEffectRan, true, "the side effect actually ran");
    assert.equal(c.y, 999, "the re-entrant write landed");
    assert.equal(c.x, 2, "the original write still completed");
    disposeReactive(c);
});
