// test/09-buildless.test.mjs -- the defineReactive(Class, spec) buildless front
// door (S2a-A3, decision 0005 made real). This file contains ZERO decorator
// syntax: no `@` decorator appears anywhere in it (grep it to prove it). It runs
// a defineReactive twin of the class family through the shared behavioral core
// (values, node deltas, boxOf/rootOf, dispose idempotency + poison, a `using`
// block), then the full PD-14 spec-validation rejection matrix, and a
// symbol-keyed spec member round-trip.
//
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats, createRegistry } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";

const { defineReactive, boxOf, rootOf, disposeReactive, ReactiveDisposedError } = pkg;

function active() {
    return stats().activeNodes;
}

function approxEquals(a, b) {
    return Math.abs(a - b) < 0.5;
}

// --- The buildless twin family (built with defineReactive, no decorators) ------

function makeBuildlessFamily() {
    const SYM = Symbol("bl-sym");
    const recompute = { double: 0 };
    const effectFires = { counter: 0 };

    const Counter = defineReactive(class Counter {}, {
        signals: {
            count: 0,
            level: { initial: 0, equals: approxEquals },  // descriptor: initial + equals
            [SYM]: "tag",                                 // symbol-keyed signal
        },
        deriveds: {
            double: (self) => { recompute.double++; return self.count * 2; },
        },
        effects: {
            onCount: (self) => { effectFires.counter++; void self.count; },
        },
    });

    // Inheritance twin: a defineReactive subclass of a defineReactive base.
    const Base = defineReactive(class Base {}, {
        signals: { a: { init: (self) => 1 } },  // per-instance init function form
        deriveds: { da: (self) => self.a + 100 },
    });
    const Derived = defineReactive(class Derived extends Base {}, {
        signals: { b: 2 },
        deriveds: { db: (self) => self.a + self.b },
    });

    return { Counter, Base, Derived, SYM, recompute, effectFires };
}

// --- Shared behavioral core over the buildless twin ---------------------------

test("buildless twin: initial values, set/get, derived laziness", () => {
    const { Counter, SYM, recompute } = makeBuildlessFamily();
    const c = new Counter();
    assert.equal(c.count, 0);
    assert.equal(c.level, 0);
    assert.equal(c[SYM], "tag");

    const base = recompute.double;
    assert.equal(c.double, 0);
    assert.equal(recompute.double - base, 1, "first read computes once");
    assert.equal(c.double, 0);
    assert.equal(recompute.double - base, 1, "memoized: no recompute without a write");

    c.count = 41;
    assert.equal(c.count, 41);
    assert.equal(c.double, 82);
    assert.equal(recompute.double - base, 2, "write invalidates, recomputes once");
    disposeReactive(c);
});

test("buildless twin: node delta P+D+E+1 and inheritance merge", () => {
    const { Counter, Base, Derived } = makeBuildlessFamily();

    let before = active();
    const c = new Counter();
    // P=3 (count, level, SYM) + D=1 (double) + E=1 (onCount) + 1 anchor = 6.
    assert.equal(active() - before, 6, "Counter twin node delta");
    disposeReactive(c);

    before = active();
    const b = new Base();
    assert.equal(active() - before, 3, "Base twin node delta (P=1 + D=1 + anchor)");
    assert.equal(b.a, 1);
    assert.equal(b.da, 101);
    disposeReactive(b);

    before = active();
    const d = new Derived();
    // Merged P=2 + D=2 + one anchor = 5.
    assert.equal(active() - before, 5, "Derived twin node delta (single anchor)");
    assert.equal(d.a, 1);
    assert.equal(d.b, 2);
    assert.equal(d.da, 101);
    assert.equal(d.db, 3);
    assert.ok(d instanceof Base, "Derived twin instanceof Base twin");
    disposeReactive(d);
});

test("buildless twin: effect fires once at wire, re-fires on a tracked write", () => {
    const { Counter, effectFires } = makeBuildlessFamily();
    const base = effectFires.counter;
    const c = new Counter();
    assert.equal(effectFires.counter - base, 1, "wire fire");
    c.count = 9;
    assert.equal(effectFires.counter - base, 2, "one re-fire on the tracked write");
    disposeReactive(c);
});

test("buildless twin: boxOf / rootOf, and boxOf did-you-mean", () => {
    const { Counter, SYM } = makeBuildlessFamily();
    const c = new Counter();
    assert.equal(boxOf(c, "count").peek(), 0);
    assert.equal(boxOf(c, SYM).peek(), "tag", "symbol-keyed spec member round-trips through boxOf");
    c[SYM] = "next";
    assert.equal(boxOf(c, SYM).peek(), "next");
    assert.equal(rootOf(c).kind, "effect");
    assert.throws(
        () => boxOf(c, "cont"),
        (e) => /did you mean `count`/.test(e.message),
    );
    disposeReactive(c);
});

test("buildless twin: dispose idempotency + poison on every member touch", () => {
    const { Counter, SYM } = makeBuildlessFamily();
    const before = active();
    const c = new Counter();
    assert.equal(disposeReactive(c), true, "first dispose");
    assert.equal(disposeReactive(c), false, "second dispose is a no-op");
    assert.equal(active(), before, "conservation back to baseline");
    assert.throws(() => c.count, ReactiveDisposedError);
    assert.throws(() => { c.count = 1; }, ReactiveDisposedError);
    assert.throws(() => c.double, ReactiveDisposedError);
    assert.throws(() => c[SYM], ReactiveDisposedError);
    assert.throws(() => boxOf(c, "count"), (e) => e instanceof ReactiveDisposedError);
    assert.throws(() => rootOf(c), (e) => e instanceof ReactiveDisposedError && e.key === "<root>");
});

test("buildless twin: a `using` block disposes at scope exit", () => {
    const { Counter } = makeBuildlessFamily();
    const before = active();
    {
        using c = new Counter();
        assert.equal(c.count, 0);
        assert.equal(typeof c[Symbol.dispose], "function");
    }
    assert.equal(active(), before, "scope exit reclaimed the whole graph");
});

// --- host.registry (shared PD-11 validation path) -----------------------------

test("buildless: host.registry routes the graph to a custom registry (isolation)", () => {
    const reg = createRegistry({ maxNodes: 64 });
    const C = defineReactive(class Iso {}, {
        signals: { v: 1 },
        deriveds: { d: (self) => self.v + 1 },
        host: { registry: reg },
    });
    const defBefore = active();
    const regBefore = reg.stats().activeNodes;
    const c = new C();
    assert.equal(active() - defBefore, 0, "default registry untouched");
    assert.ok(reg.stats().activeNodes - regBefore > 0, "custom registry allocated");
    disposeReactive(c);
    assert.equal(reg.stats().activeNodes - regBefore, 0, "custom registry back to baseline");
});

// --- PD-14 spec-validation rejection matrix -----------------------------------

test("PD-14: a non-object spec is rejected", () => {
    assert.throws(() => defineReactive(class A {}, null), (e) => e instanceof Error);
    assert.throws(() => defineReactive(class B {}, 42), (e) => e instanceof Error);
});

test("PD-14: an unknown top-level section -> did-you-mean over the known sections", () => {
    assert.throws(
        () => defineReactive(class C {}, { signalz: { x: 0 } }),
        (e) => /did you mean `signals`/.test(e.message),
    );
});

test("PD-14: a bare-function signal entry is ambiguous -> named throw", () => {
    assert.throws(
        () => defineReactive(class D {}, { signals: { x: () => 1 } }),
        (e) => /initial/.test(e.message) && /init/.test(e.message),
    );
});

test("PD-14: initial + init present together -> named throw", () => {
    assert.throws(
        () => defineReactive(class E {}, { signals: { x: { initial: 1, init: () => 2 } } }),
        (e) => /initial/.test(e.message) && /init/.test(e.message),
    );
});

test("PD-14: a signal descriptor with an unknown key -> did-you-mean over its keys", () => {
    assert.throws(
        () => defineReactive(class F {}, { signals: { x: { initail: 1 } } }),
        (e) => /did you mean `initial`/.test(e.message),
    );
});

test("PD-14: a deriveds entry that is neither a function nor a { get } descriptor -> throw", () => {
    assert.throws(
        () => defineReactive(class G {}, { deriveds: { d: 42 } }),
        (e) => e instanceof Error,
    );
    assert.throws(
        () => defineReactive(class H {}, { deriveds: { d: { equals: approxEquals } } }),
        (e) => /get/.test(e.message),
    );
});

test("PD-14: an effects entry that is not a function or { run } descriptor -> throw", () => {
    assert.throws(
        () => defineReactive(class I {}, { effects: { e: 42 } }),
        (e) => e instanceof Error,
    );
});

test("PD-14: a spec key colliding with an existing prototype member -> named throw", () => {
    class HasCount {
        count() { return 1; }   // a hand-written prototype member
    }
    assert.throws(
        () => defineReactive(HasCount, { signals: { count: 0 } }),
        (e) => /count/.test(e.message),
    );
});

test("PD-14: host.registry that is not a Registry (duck-type failure) -> named throw", () => {
    assert.throws(
        () => defineReactive(class J {}, { signals: { v: 0 }, host: { registry: {} } }),
        (e) => /registry/i.test(e.message),
    );
});
