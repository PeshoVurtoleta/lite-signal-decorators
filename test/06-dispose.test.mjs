// test/06-dispose.test.mjs -- the disposal contract (S1-A4, decisions/0002 D-2d):
// idempotency, post-dispose poison on every member touch + boxOf + rootOf naming
// Cls.key, F-0 conservation back to baseline, the dispose-during-construction
// (not-yet-wired) named throw, and the not-a-reactive-instance named throw.
// Driven through the mock emitter (its own process; clean module state).
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import {
    makeClasses,
    buildClass,
    makeClassContext,
} from "./shared/mock-emitter.mjs";

const { reactive, reactiveHost, boxOf, rootOf, disposeReactive, ReactiveDisposedError } = pkg;

function conserved() {
    const s = stats();
    return s.totalAllocations - s.totalDisposals === s.activeNodes;
}

test("disposeReactive is idempotent: true then false, no further change", () => {
    const { Counter } = makeClasses(pkg);
    const c = new Counter();
    assert.equal(disposeReactive(c), true, "first dispose");
    const after = stats().activeNodes;
    assert.equal(disposeReactive(c), false, "second dispose is a no-op");
    assert.equal(stats().activeNodes, after, "no-op changed nothing");
});

test("post-dispose get/set/boxOf/rootOf throw ReactiveDisposedError naming Cls.key", () => {
    const { Counter, SYM } = makeClasses(pkg);
    const c = new Counter();
    disposeReactive(c);

    // Signal member read.
    assert.throws(
        () => c.count,
        (e) => e instanceof ReactiveDisposedError && e.name === "ReactiveDisposedError" &&
            e.className === "Counter" && e.key === "count",
    );
    // Signal member write.
    assert.throws(
        () => { c.count = 9; },
        (e) => e instanceof ReactiveDisposedError && e.className === "Counter" && e.key === "count",
    );
    // Derived member read.
    assert.throws(
        () => c.double,
        (e) => e instanceof ReactiveDisposedError && e.className === "Counter" && e.key === "double",
    );
    // Symbol-keyed member.
    assert.throws(
        () => c[SYM],
        (e) => e instanceof ReactiveDisposedError && e.className === "Counter",
    );
    // boxOf on a disposed instance.
    assert.throws(
        () => boxOf(c, "count"),
        (e) => e instanceof ReactiveDisposedError && e.key === "count",
    );
    // rootOf on a disposed instance names "<root>".
    assert.throws(
        () => rootOf(c),
        (e) => e instanceof ReactiveDisposedError && e.className === "Counter" && e.key === "<root>",
    );
});

test("conservation after dispose (F-0): activeNodes to baseline; alloc-disposal invariant", () => {
    const { Counter } = makeClasses(pkg);
    const before = stats().activeNodes;
    assert.ok(conserved(), "invariant holds at baseline");
    const c = new Counter();
    assert.ok(stats().activeNodes > before, "construction allocated nodes");
    disposeReactive(c);
    assert.equal(stats().activeNodes, before, "activeNodes returned to baseline");
    assert.ok(conserved(), "totalAllocations - totalDisposals === activeNodes at quiesce");
});

test("dispose during construction (not yet wired) throws named", () => {
    // A plain-field initializer calls disposeReactive(this) BEFORE the host's
    // wiring runs -- the anchor does not exist yet, so it must throw named.
    const C = buildClass({
        name: "EarlyDispose",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 0 },
            { kind: "field", key: "boom", value: function () { disposeReactive(this); return 0; } },
        ],
    });
    assert.throws(
        () => new C(),
        (e) => /not wired/.test(e.message) && /during\s+construction/.test(e.message),
    );
});

test("disposeReactive / boxOf / rootOf on a plain object throw named (no plan)", () => {
    assert.throws(
        () => disposeReactive({}),
        (e) => /not a reactive instance/.test(e.message),
    );
    assert.throws(
        () => boxOf({}, "x"),
        (e) => /not a reactive instance/.test(e.message),
    );
    assert.throws(
        () => rootOf({}),
        (e) => /not a reactive instance/.test(e.message),
    );
});

test("throwaway host absorbs the EarlyDispose leftover", () => {
    // The EarlyDispose class above was fully hosted (its record was claimed), so
    // PENDING is already empty; this host simply confirms a clean slate.
    const Ok = reactiveHost(class CleanTail {}, makeClassContext("CleanTail"));
    assert.equal(typeof Ok, "function");
});
