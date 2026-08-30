// test/16-reinit.test.mjs -- the pooled-reinit contract (PLAN-S6 T6,
// decisions/0010 + 0011, PD-42/PD-44): `releaseReactive`/`reinitReactive`'s
// named-throw lattice on BOTH compiled emit lanes (TS standard + Babel
// 2023-11), plus defineReactive (buildless) shapes, plus a full boundary
// matrix on the two new entry points: 0, 1, N-1, N, N+1, empty, null,
// undefined, NaN, -0, duplicate dispose, dispose-during-iteration, a
// re-entrant write, and one adversarial case (self-release from inside an
// instance's OWN effect, at its very first synchronous fire).
//
// Run `npm run fixtures` first if the compiled-fixture imports fail to
// resolve. ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import { buildClass, makeClassContext } from "./shared/mock-emitter.mjs";
import * as tsClasses from "./fixtures/ts-out/fixture.src.js";
import * as babelClasses from "./fixtures/babel-out/fixture.src.js";

const {
    reactive, derived, reactiveEffect, reactiveHost, defineReactive,
    boxOf, rootOf, releaseReactive, reinitReactive, disposeReactive,
    ReactiveDisposedError,
} = pkg;

function conserved() {
    const s = stats();
    return s.totalAllocations - s.totalDisposals === s.activeNodes;
}

// =================================================================================
// Both emit lanes: the named-throw lattice + boxOf/rootOf agreement, driven
// through the compiled TS and Babel `Counter` fixture (same family both 02/03
// run the behavior suite over).
// =================================================================================

function reinitLatticeSuite(t, classes, label) {
    const { Counter, pkg: fpkg } = classes;
    const {
        releaseReactive: frelease, reinitReactive: freinit, disposeReactive: fdispose,
        boxOf: fboxOf, rootOf: frootOf, ReactiveDisposedError: FErr,
    } = fpkg;

    t.test(label + ": releaseReactive parks a live instance; parked touch throws named 'parked'", () => {
        const c = new Counter();
        assert.equal(frelease(c), true);
        assert.throws(
            () => c.count,
            (e) => e instanceof FErr && e.name === "ReactiveDisposedError" &&
                e.className === "Counter" && /parked/.test(e.message),
        );
        assert.throws(
            () => fboxOf(c, "count"),
            (e) => e instanceof FErr && /parked/.test(e.message),
        );
        assert.throws(
            () => frootOf(c),
            (e) => e instanceof FErr && /parked/.test(e.message) && e.key === "<root>",
        );
        fdispose(c);
    });

    t.test(label + ": park->reinit->live resets every signal to its field-initial", () => {
        const c = new Counter();
        c.count = 42;
        c.level = 7;
        frelease(c);
        const revived = freinit(c);
        assert.equal(revived, c, "reinitReactive returns the same instance");
        assert.equal(c.count, 0, "count resets to its field-initial 0");
        assert.equal(c.level, 0, "level resets to its field-initial 0");
        assert.equal(c.double, 0, "derived recomputes over the reset values");
        fdispose(c);
    });

    t.test(label + ": the five reinitReactive fail-closed states are named throws", () => {
        // on live
        {
            const c = new Counter();
            assert.throws(() => freinit(c), (e) => /is live/.test(e.message));
            fdispose(c);
        }
        // on disposed
        {
            const c = new Counter();
            fdispose(c);
            assert.throws(() => freinit(c), (e) => /was disposed \(terminal\)/.test(e.message));
        }
        // on frozen (parked then frozen)
        {
            const c = new Counter();
            frelease(c);
            Object.freeze(c);
            assert.throws(() => freinit(c), (e) => e instanceof TypeError && /frozen/.test(e.message));
        }
        // on non-reactive
        assert.throws(() => freinit({}), (e) => /not a reactive instance/.test(e.message));
    });

    t.test(label + ": park->dispose lands DISPOSED (not parked), idempotent false thereafter", () => {
        const c = new Counter();
        frelease(c);
        assert.equal(fdispose(c), true);
        assert.throws(
            () => c.count,
            (e) => e instanceof FErr && !/parked/.test(e.message),
        );
        assert.equal(fdispose(c), false, "second dispose is idempotent");
    });

    t.test(label + ": park->park is idempotent false, releaseReactive-on-disposed is a named throw", () => {
        const c = new Counter();
        assert.equal(frelease(c), true);
        assert.equal(frelease(c), false, "second release (already parked) is idempotent false");
        const c2 = new Counter();
        fdispose(c2);
        assert.throws(() => frelease(c2), (e) => /cannot be released to the pool/.test(e.message));
        freinit(c);
        fdispose(c);
    });
}

test("reinit lattice over the TS standard emit", (t) => {
    reinitLatticeSuite(t, tsClasses, "ts");
});

test("reinit lattice over the Babel 2023-11 emit", (t) => {
    reinitLatticeSuite(t, babelClasses, "babel");
});

// =================================================================================
// defineReactive (buildless) shapes: reinit resets via the plan's initFn, not
// the decorator SIG_INITIAL capture -- a distinct code path worth its own proof.
// =================================================================================

test("defineReactive: release->reinit resets signals via the buildless initFn", () => {
    const C = defineReactive(class Bl {}, {
        signals: { a: 5, b: { initial: 9 } },
        deriveds: { sum: (self) => self.a + self.b },
    });
    const vm = new C();
    vm.a = 100;
    releaseReactive(vm);
    reinitReactive(vm);
    assert.equal(vm.a, 5);
    assert.equal(vm.b, 9);
    assert.equal(vm.sum, 14);
    disposeReactive(vm);
});

// =================================================================================
// Symbol.dispose interop on a PARKED instance: dispose-on-parked lands DISPOSED
// (not left parked), and is idempotent thereafter.
// =================================================================================

test("Symbol.dispose on a parked instance disposes (lands DISPOSED), idempotent", () => {
    const C = buildClass({
        name: "DisposableParked",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "v", decorator: reactive, value: () => 1 }],
    });
    const vm = new C();
    assert.equal(typeof vm[Symbol.dispose], "function", "the wrapper installs Symbol.dispose");
    assert.equal(releaseReactive(vm), true);
    // still parked before the Symbol.dispose call
    assert.throws(() => vm.v, (e) => /parked/.test(e.message));
    vm[Symbol.dispose]();
    assert.throws(
        () => vm.v,
        (e) => e instanceof ReactiveDisposedError && !/parked/.test(e.message),
        "Symbol.dispose on a parked instance must land DISPOSED, not leave it parked",
    );
    // idempotent: a second Symbol.dispose call must not throw.
    assert.doesNotThrow(() => vm[Symbol.dispose]());
});

// =================================================================================
// Accessor identity (S6-A4 companion): a reinitReactive'd instance's accessors
// are the SAME function objects a fresh instance's are -- the hot canon is
// never touched by park/reinit (it lives on the prototype, not the instance).
// =================================================================================

test("reinitReactive touches no accessor: get/set descriptors are byte-identical before and after", () => {
    const C = buildClass({
        name: "AccessorIdentity",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 1 },
            { kind: "getter", key: "dv", decorator: derived, body: function () { return this.v + 1; } },
        ],
    });
    // `@reactiveHost` wraps the decorated class in a subclass `W extends Inner`
    // (PD-5); the accessor/getter descriptors are installed on Inner's own
    // prototype, one level up from the wrapper's own prototype.
    const innerProto = Object.getPrototypeOf(C.prototype);
    const before = Object.getOwnPropertyDescriptor(innerProto, "v");
    const beforeD = Object.getOwnPropertyDescriptor(innerProto, "dv");

    const vm = new C();
    releaseReactive(vm);
    reinitReactive(vm);

    const after = Object.getOwnPropertyDescriptor(innerProto, "v");
    const afterD = Object.getOwnPropertyDescriptor(innerProto, "dv");

    assert.equal(after.get, before.get, "the `v` getter is the SAME function object");
    assert.equal(after.set, before.set, "the `v` setter is the SAME function object");
    assert.equal(afterD.get, beforeD.get, "the `dv` derived getter is the SAME function object");

    // A second, freshly constructed instance shares the SAME prototype accessors.
    const vm2 = new C();
    const fresh = Object.getOwnPropertyDescriptor(innerProto, "v");
    assert.equal(fresh.get, before.get);
    assert.equal(fresh.set, before.set);

    disposeReactive(vm);
    disposeReactive(vm2);
});

// =================================================================================
// Boundary matrix on the two new entry points (releaseReactive, reinitReactive):
// 0, 1, N-1, N, N+1, empty, null, undefined, NaN, -0, duplicate dispose,
// dispose-during-iteration, a re-entrant write, and one adversarial case.
// =================================================================================

// A P=3 signal shape so the initials-key-count boundary (N-1 / N / N+1) has
// somewhere to land: x, y, z, each with a distinct field-initial.
function makeTrio() {
    return buildClass({
        name: "Trio",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "x", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "y", decorator: reactive, value: () => 2 },
            { kind: "accessor", key: "z", decorator: reactive, value: () => 3 },
        ],
    });
}

test("boundary: initials with 0 keys (empty object) resets every signal, same as omitted", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    vm.x = 99;
    releaseReactive(vm);
    reinitReactive(vm, {});
    assert.deepEqual([vm.x, vm.y, vm.z], [1, 2, 3]);
    disposeReactive(vm);
});

test("boundary: initials with 1 key overrides exactly that signal", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    reinitReactive(vm, { x: 100 });
    assert.deepEqual([vm.x, vm.y, vm.z], [100, 2, 3]);
    disposeReactive(vm);
});

test("boundary: initials with N-1 keys overrides all but one signal", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    reinitReactive(vm, { x: 100, y: 200 });
    assert.deepEqual([vm.x, vm.y, vm.z], [100, 200, 3]);
    disposeReactive(vm);
});

test("boundary: initials with N keys (all signals) overrides every one", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    reinitReactive(vm, { x: 100, y: 200, z: 300 });
    assert.deepEqual([vm.x, vm.y, vm.z], [100, 200, 300]);
    disposeReactive(vm);
});

test("boundary: initials with N+1 keys (one unknown) throws named and applies NOTHING (fail closed)", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    assert.throws(
        () => reinitReactive(vm, { x: 100, y: 200, z: 300, bogus: 1 }),
        (e) => /initials carries key `bogus`/.test(e.message) && /is not a @reactive signal/.test(e.message),
    );
    // Fail closed: the unknown-key validation runs BEFORE any box rebuild, so
    // the instance is still PARKED, not half-revived.
    assert.throws(() => vm.x, (e) => /parked/.test(e.message));
    reinitReactive(vm); // clean revival still works after the rejected attempt
    assert.deepEqual([vm.x, vm.y, vm.z], [1, 2, 3]);
    disposeReactive(vm);
});

test("boundary: initials === null throws a named TypeError (null is not an empty object)", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    assert.throws(
        () => reinitReactive(vm, null),
        (e) => e instanceof TypeError && /must be an object/.test(e.message),
    );
    assert.throws(() => vm.x, (e) => /parked/.test(e.message), "still parked, not half-revived");
    reinitReactive(vm);
    disposeReactive(vm);
});

test("boundary: initials === undefined (explicit) behaves exactly like omitted", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    reinitReactive(vm, undefined);
    assert.deepEqual([vm.x, vm.y, vm.z], [1, 2, 3]);
    disposeReactive(vm);
});

test("boundary: an initials value of NaN is accepted verbatim (no coercion)", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    reinitReactive(vm, { x: NaN });
    assert.ok(Number.isNaN(vm.x));
    disposeReactive(vm);
});

test("boundary: an initials value of -0 is preserved verbatim (Object.is)", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    reinitReactive(vm, { x: -0 });
    assert.ok(Object.is(vm.x, -0), "negative zero must survive the reset, not coerce to +0");
    disposeReactive(vm);
});

test("boundary: duplicate dispose after a revival is idempotent (true then false)", () => {
    const Trio = makeTrio();
    const vm = new Trio();
    releaseReactive(vm);
    reinitReactive(vm);
    assert.equal(disposeReactive(vm), true, "first dispose of a REVIVED instance");
    assert.equal(disposeReactive(vm), false, "second dispose is idempotent, not stale from before park");
});

test("boundary: releaseReactive from inside the instance's own @derived throws named (dispose-during-iteration)", () => {
    const C = buildClass({
        name: "SelfReleaseDerived",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            { kind: "getter", key: "boom", decorator: derived, body: function () { void this.a; return releaseReactive(this); } },
        ],
    });
    const vm = new C();
    assert.throws(
        () => vm.boom,
        (e) => /was called from inside its own @derived/.test(e.message) && /Release from an effect/.test(e.message),
    );
    disposeReactive(vm);
});

test("boundary: a re-entrant reinitReactive call from within its own revival effect fails closed (reinit-on-live), the OUTER call still succeeds", () => {
    let fireCount = 0;
    let innerError = null;
    const C = buildClass({
        name: "ReentrantReinit",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            {
                kind: "method",
                key: "onA",
                decorator: reactiveEffect,
                body: function () {
                    fireCount++;
                    void this.a;
                    if (fireCount === 2) {
                        // this fire happens DURING the outer reinitReactive's own
                        // buildGraph, after inst[ANCHOR] is already live -- a
                        // re-entrant reinitReactive on the SAME instance must see
                        // it as live and fail closed, not corrupt the revival.
                        try { reinitReactive(this); } catch (e) { innerError = e; }
                    }
                },
            },
        ],
    });
    const vm = new C();
    assert.equal(fireCount, 1, "wire-time fire");
    releaseReactive(vm);
    const outer = reinitReactive(vm);   // fires the effect a 2nd time, re-entrantly
    assert.equal(outer, vm, "the OUTER reinitReactive call still returns the revived instance");
    assert.equal(fireCount, 2);
    assert.ok(innerError !== null && /is live/.test(innerError.message), "the re-entrant call fails closed, named");
    assert.equal(vm.a, 1, "no corruption: the revived value is correct");
    disposeReactive(vm);
});

test("adversarial: releaseReactive from inside the instance's OWN effect, at its first synchronous fire, succeeds and parks the instance mid-construction -- no crash, no corruption, and it is still revivable", () => {
    // Unlike a @derived self-dispose (guarded, D-2f/D-4d), an EFFECT is not in
    // plan.deriveds, so this re-entrant self-release is NOT guarded -- it is
    // allowed by design (effects have no return value a fail-open cascade could
    // silently drop). Pinned here as a regression proof, not a hazard: the
    // instance ends up PARKED immediately after `new`, and reinitReactive on it
    // still works correctly afterward.
    let fireCount = 0;
    let releaseResult = "not-called";
    const C = buildClass({
        name: "SelfReleaseEffect",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            {
                kind: "method",
                key: "onA",
                decorator: reactiveEffect,
                body: function () {
                    fireCount++;
                    void this.a;
                    if (fireCount === 1) releaseResult = releaseReactive(this);
                },
            },
        ],
    });
    const vm = new C();               // construction itself does not throw
    assert.equal(fireCount, 1);
    assert.equal(releaseResult, true, "the re-entrant self-release succeeded");
    assert.throws(() => vm.a, (e) => /parked/.test(e.message), "the instance is parked, not live, right after `new`");
    const revived = reinitReactive(vm);
    assert.equal(revived, vm);
    assert.equal(vm.a, 1, "recoverable: reinit revives it correctly");
    disposeReactive(vm);
});

// --- conservation sanity: everything this file built is disposed ---------------

test("conservation: every instance built above was disposed (ledger balances)", () => {
    assert.ok(conserved(), "totalAllocations - totalDisposals === activeNodes");
});
