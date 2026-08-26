// test/11-qa-s2b-boundary.test.mjs -- independent QA adversarial boundary
// coverage for S2b (PLAN-S2b.md section 5 QA charge), authored AFTER reviewer
// APPROVED the full stage (seven new torture scenarios + D-2h init-phase
// capacity atomicity + the wiring-phase atomicity extension). This file's job
// is the D-2h adversarial cases the torture lanes (capacity-torture.mjs etc.)
// may not have exercised: a plain (non-capacity) Error thrown mid-construction
// from a field initializer that runs AFTER some accessor init boxes already
// exist (the SCRATCH frame must still drain on ANY throw, not just
// CapacityError); a two-level host chain where the BASE class's own field
// initializers throw AFTER Base's own boxes exist (the leaf's single frame
// must drain Base's boxes too -- this is the exact shape of the reviewer's
// recorded intermediate-host counterexample in decisions/0002 D-2h); a
// `using`-block construction that overflows (CapacityError propagates before
// anything is ever bound, so `using`'s implicit dispose never runs); a
// double-construction storm alternating fail/succeed on a fixed-ceiling
// registry (SCRATCH frame indices must stay coherent across many interleaved
// successful and failed attempts); the defineReactive buildless twin under
// the same kind of init-throw (its boxes are wire-time, inside wireInstance's
// own try/catch -- a DIFFERENT mechanism than the decorator path's SCRATCH,
// worth contrasting explicitly); and two invented composition-nesting cases
// (a field initializer constructing ANOTHER independent reactive VM that
// itself overflows, same registry and a different registry) that exercise the
// LIFO frame claim and the documented boundary of what the atomicity
// guarantee covers.
//
// Driven through the mock emitter (own process; clean module state), matching
// the pattern of 07/08/09/10. Every claim below was measured against the real
// module before being pinned.
//
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import {
    buildClass,
    makeClassContext,
} from "./shared/mock-emitter.mjs";

const {
    reactive,
    reactiveHost,
    disposeReactive,
    defineReactive,
} = pkg;

function drainPending() {
    try {
        reactiveHost(class Drain {}, makeClassContext("Drain"));
    } catch (_) {
        // orphan records were present; the buffer is now empty.
    }
}

// === QA-J1: a plain field-initializer throw mid-construction drains the frame =

test("QA-J1: a plain (non-capacity) Error from a field initializer AFTER accessor boxes exist still drains the SCRATCH frame", () => {
    drainPending();
    const reg = createRegistry({ maxNodes: 64 });
    const C = buildClass({
        name: "PlainThrowMid",
        classDecorator: reactiveHost({ registry: reg }),
        members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "b", decorator: reactive, value: () => 2 },
            { kind: "field", key: "boom", value: function () { throw new Error("plain field boom"); } },
        ],
    });
    const before = reg.stats().activeNodes;
    assert.throws(() => new C(), (e) => e.message === "plain field boom", "the original error propagates unmodified");
    assert.equal(reg.stats().activeNodes, before, "the two already-created signal boxes (a, b) were drained -- no leak from a non-capacity throw");
});

// === QA-J2: a BASE class's own field throw, solo and inside a host chain =====

test("QA-J2a: a solo host whose own field throws AFTER its accessors are initialized drains cleanly", () => {
    drainPending();
    const reg = createRegistry({ maxNodes: 64 });
    const Base = buildClass({
        name: "ThrowBaseSolo",
        classDecorator: reactiveHost({ registry: reg }),
        members: [
            { kind: "accessor", key: "x", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "y", decorator: reactive, value: () => 2 },
            { kind: "field", key: "baseBoom", value: function () { throw new Error("base ctor throws after fields"); } },
        ],
    });
    const before = reg.stats().activeNodes;
    assert.throws(() => new Base(), (e) => e.message === "base ctor throws after fields");
    assert.equal(reg.stats().activeNodes, before, "solo host: both boxes drained");
});

test("QA-J2b: a two-level host chain where the BASE throws -- the LEAF's single frame drains BASE's boxes too (D-2h intermediate-host regression pin)", () => {
    // This is the exact shape of the reviewer's recorded counterexample: an
    // intermediate host must NOT run its own capture/truncate; only the
    // most-derived wiring W's frame may cover the whole super() chain. If that
    // gating regressed, Base's boxes would leak here (activeNodes 0 -> +2).
    drainPending();
    const reg = createRegistry({ maxNodes: 64 });
    const Base = buildClass({
        name: "ThrowBaseChain",
        classDecorator: reactiveHost({ registry: reg }),
        members: [
            { kind: "accessor", key: "x", decorator: reactive, value: () => 1 },
            { kind: "field", key: "baseBoom", value: function () { throw new Error("base fields done, throw"); } },
        ],
    });
    const Derived = buildClass({
        name: "DerivedOverThrowingBase",
        superClass: Base,
        classDecorator: reactiveHost,             // no explicit registry -> inherits reg
        members: [
            { kind: "accessor", key: "z", decorator: reactive, value: () => 3 },
        ],
    });
    const before = reg.stats().activeNodes;
    assert.throws(() => new Derived(), (e) => e.message === "base fields done, throw");
    assert.equal(reg.stats().activeNodes, before, "Base's box drained by the leaf's frame -- no leak from the intermediate host");
});

// === QA-J3: `using` construction that overflows -- nothing is ever bound =====

test("QA-J3: a `using` declaration whose initializer overflows propagates CapacityError; nothing was ever bound, nothing retained", () => {
    drainPending();
    const reg = createRegistry({ maxNodes: 2 });   // headroom for < 3 signals
    const C = buildClass({
        name: "UsingOverflow",
        classDecorator: reactiveHost({ registry: reg }),
        members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "b", decorator: reactive, value: () => 2 },
            { kind: "accessor", key: "c", decorator: reactive, value: () => 3 },
        ],
    });
    const before = reg.stats().activeNodes;
    let threw = null;
    assert.throws(
        () => {
            (function () {
                using inst = new C();          // the RHS throws before binding
                void inst;
            })();
        },
        (e) => { threw = e; return e.name === "CapacityError"; },
        "CapacityError by name propagates out through the `using` declaration's initializer",
    );
    assert.ok(threw !== null);
    assert.equal(reg.stats().activeNodes, before, "nothing retained -- `using`'s implicit Symbol.dispose never ran because nothing was ever bound");
});

// === QA-J4: double-construction storm, alternating fail/succeed =============

test("QA-J4: a fail/succeed storm on a fixed-ceiling registry leaves conservation exact (SCRATCH frame indices stayed coherent)", () => {
    drainPending();
    // Ceiling sized for exactly ONE live instance (anchor + 2 signals = 3 nodes).
    const reg = createRegistry({ maxNodes: 3 });
    const C = buildClass({
        name: "StormClass",
        classDecorator: reactiveHost({ registry: reg }),
        members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "b", decorator: reactive, value: () => 2 },
        ],
    });
    const before = reg.stats().activeNodes;
    let held = null;
    let successes = 0;
    let failures = 0;
    for (let i = 0; i < 40; i++) {
        if (held === null) {
            held = new C();                     // succeeds: room is free
            successes++;
        } else {
            // `held` occupies all 3 nodes -- this attempt MUST overflow, pushing
            // and draining its own SCRATCH frame while `held`'s already-committed
            // boxes (long truncated out of SCRATCH) must stay completely untouched.
            assert.throws(() => new C(), (e) => e.name === "CapacityError");
            failures++;
            disposeReactive(held);
            held = null;
        }
    }
    if (held !== null) disposeReactive(held);
    assert.equal(successes, 20, "every other attempt succeeded (room freed each cycle)");
    assert.equal(failures, 20, "every other attempt overflowed (room held by the live instance)");
    assert.equal(reg.stats().activeNodes, before, "40 interleaved fail/succeed cycles: conservation exact, no cumulative drift");
});

// === QA-J5: defineReactive twin under the same init-throw (wire-time, not SCRATCH)

test("QA-J5: the defineReactive twin's init-throw is caught by wireInstance's own try/catch, not the (decorator-only) SCRATCH frame", () => {
    drainPending();
    const reg = createRegistry({ maxNodes: 64 });
    const before = reg.stats().activeNodes;
    const C = defineReactive(class BuildlessThrow {}, {
        signals: {
            a: { init: () => 1 },
            b: { init: () => { throw new Error("buildless init boom"); } },
        },
        host: { registry: reg },
    });
    assert.throws(() => new C(), (e) => e.message === "buildless init boom");
    assert.equal(
        reg.stats().activeNodes, before,
        "buildless signal `a`'s box (already created inside wireInstance's try, wire-time not field-init-time) was drained by disposeCore",
    );
});

// === QA-J6 (invented): nested composition, SAME registry, inner overflows ===

test("QA-J6: ADVERSARIAL -- a field initializer builds an INDEPENDENT nested reactive VM (same registry) that itself overflows; the outer's own frame still drains correctly (LIFO)", () => {
    drainPending();
    const reg = createRegistry({ maxNodes: 3 });   // room for exactly one small VM
    const Inner = buildClass({
        name: "InnerNestedSameReg",
        classDecorator: reactiveHost({ registry: reg }),
        members: [
            { kind: "accessor", key: "x", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "y", decorator: reactive, value: () => 2 },
        ],
    });
    drainPending();
    const Outer = buildClass({
        name: "OuterNestedSameReg",
        classDecorator: reactiveHost({ registry: reg }),
        members: [
            { kind: "accessor", key: "p", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "q", decorator: reactive, value: () => 2 },
            // Outer's own p+q already consume all 3 nodes (2 signals + eventual
            // anchor headroom P); building an Inner VM (needs anchor+2 signals =
            // 3 MORE nodes) inside this field must overflow on the shared ceiling.
            { kind: "field", key: "inner", value: function () { return new Inner(); } },
        ],
    });
    const before = reg.stats().activeNodes;
    assert.throws(
        () => new Outer(),
        (e) => e.name === "CapacityError",
        "the nested Inner construction overflows the shared registry",
    );
    assert.equal(
        reg.stats().activeNodes, before,
        "LIFO drain: Inner's own (self-cleaned, empty-net) failed attempt AND Outer's own p+q boxes are all gone -- zero net leak",
    );
});

// === QA-J7 (invented): nested composition, DIFFERENT registry, inner commits =

test("QA-J7: ADVERSARIAL -- a field initializer builds a nested VM on a DIFFERENT registry that fully commits before the outer's OWN wiring-phase overflow; the atomicity boundary is documented, not a package bug", () => {
    // The atomicity guarantee covers the OUTER instance's own plan (its own
    // registry's boxes). It cannot and does not reach into an opaque plain field
    // holding a reference to an unrelated, independently-owned live resource on
    // a DIFFERENT registry -- that resource's lifecycle is the composing code's
    // responsibility, exactly like any other object a failed constructor might
    // have handed off to a field before throwing.
    drainPending();
    const regInner = createRegistry({ maxNodes: 16 });
    const regOuter = createRegistry({ maxNodes: 2 }); // outer: room for its 2 signals; anchor overflows at headroom P exactly
    const Inner = buildClass({
        name: "InnerCrossReg",
        classDecorator: reactiveHost({ registry: regInner }),
        members: [{ kind: "accessor", key: "x", decorator: reactive, value: () => 1 }],
    });
    drainPending();
    const Outer = buildClass({
        name: "OuterCrossReg",
        classDecorator: reactiveHost({ registry: regOuter }),
        members: [
            { kind: "accessor", key: "p", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "q", decorator: reactive, value: () => 2 },
            { kind: "field", key: "inner", value: function () { return new Inner(); } },
        ],
    });
    const innerBefore = regInner.stats().activeNodes;
    const outerBefore = regOuter.stats().activeNodes;
    assert.throws(
        () => new Outer(),
        (e) => e.name === "CapacityError",
        "Outer's own wiring-phase anchor creation overflows regOuter AFTER Inner already fully committed on regInner",
    );
    assert.equal(
        regOuter.stats().activeNodes, outerBefore,
        "Outer's own p+q boxes are drained -- the atomicity guarantee holds fully for Outer's OWN registry",
    );
    assert.equal(
        regInner.stats().activeNodes - innerBefore, 2,
        "MEASURED (documented boundary, not a bug): the already-committed Inner VM (anchor+1 signal=2 nodes) on the OTHER registry is untouched and remains live -- the package has no handle to a plain field's opaque value and cannot dispose it on Outer's behalf",
    );
});
