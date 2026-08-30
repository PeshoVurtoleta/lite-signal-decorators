// test/17-localto.test.mjs -- the @localTo contract (PLAN-S8 T10, decisions/0014):
// the upstream-keyed resettable-local lattice on BOTH compiled emit lanes (TS
// standard + Babel 2023-11) via the committed `Locals` fixture, the buildless
// spec.locals twin (defineReactive), the set-path dep-leak regression (the
// isTracking/untrack gate's reason to exist), and the validateLocalOptions
// rejection matrix.
//
// The lattice matrix (per 0014): initial unification (BOTH flavors), write
// override, upstream reset, coarse-equals override survival, THE SHIPPED ABA
// STALE-LOCAL contract, a source throw propagating with nothing mutated (fail
// closed), dispose -> named ReactiveDisposedError on every touch, park ->
// parked-message throw, park->reinit (PD-58: box -> initial AND seen -> CURRENT
// upstream), initials[] accepting local keys, boxOf(vm, localKey) -> the live
// box, and costOf nodes === P+L+D+E+1 with the `locals` field.
//
// Run `npm run fixtures` first if the compiled-fixture imports fail to resolve.
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import { buildClass } from "./shared/mock-emitter.mjs";
import * as tsClasses from "./fixtures/ts-out/fixture.src.js";
import * as babelClasses from "./fixtures/babel-out/fixture.src.js";

const {
    reactive, derived, reactiveEffect, reactiveHost, localTo, defineReactive,
    boxOf, releaseReactive, reinitReactive, disposeReactive, costOf,
    ReactiveDisposedError,
} = pkg;

function conserved() {
    const s = stats();
    return s.totalAllocations - s.totalDisposals === s.activeNodes;
}

// =================================================================================
// The lattice matrix over the committed `Locals` fixture -- run identically over
// the TS standard emit and the Babel 2023-11 emit (decorator lane parity). The
// fixture: `src` (@reactive, init 10); `draft` (@localTo(src), initializer 0 ->
// the @trackedReset flavor); `mirror` (@localTo(src), no initializer -> the
// @localCopy flavor). P=1, L=2, D=0, E=0 -> 4 nodes.
// =================================================================================

function localToLatticeSuite(t, classes, label) {
    const { Locals, pkg: fpkg } = classes;
    const {
        boxOf: fboxOf, releaseReactive: frelease, reinitReactive: freinit,
        disposeReactive: fdispose, costOf: fcostOf, ReactiveDisposedError: FErr,
    } = fpkg;

    t.test(label + ": initial unification -- draft STARTS at its initializer, mirror FOLLOWS the source", () => {
        const vm = new Locals();
        assert.equal(vm.draft, 0, "draft (initializer flavor) starts at its declared initial 0");
        assert.equal(vm.mirror, 10, "mirror (localCopy flavor) starts at the source value 10 seen at wiring");
        fdispose(vm);
    });

    t.test(label + ": a local write overrides while the upstream is static", () => {
        const vm = new Locals();
        vm.draft = 42;
        assert.equal(vm.draft, 42, "the override reads back with the upstream unchanged");
        assert.equal(vm.draft, 42, "a second static-upstream read is still the override");
        fdispose(vm);
    });

    t.test(label + ": an upstream move RESETS every local keyed on it", () => {
        const vm = new Locals();
        vm.draft = 42;                 // override draft; mirror still follows
        vm.src = 20;                   // move the shared upstream
        assert.equal(vm.draft, 20, "draft resets to the moved upstream");
        assert.equal(vm.mirror, 20, "mirror resets to the moved upstream");
        fdispose(vm);
    });

    t.test(label + ": THE SHIPPED ABA CONTRACT -- A -> write X -> B -> A reads the STALE LOCAL", () => {
        // 0014: the reset requires the upstream to CHANGE relative to the LAST
        // ADOPTION (the write's seen slot), not to have moved transitively. The
        // B excursion is invisible once the upstream returns to an equals-A value.
        const vm = new Locals();
        vm.src = 100;                  // upstream A
        vm.draft = 999;                // local write X: box=999, seen=A(100)
        assert.equal(vm.draft, 999, "at A the override reads back");
        vm.src = 200;                  // upstream B
        assert.equal(vm.draft, 200, "at B the read transiently resets (never adopts)");
        vm.src = 100;                  // upstream returns to an equals-A value
        assert.equal(vm.draft, 999, "THE SHIPPED CONTRACT: back at A the read shows the STALE LOCAL 999");
        fdispose(vm);
    });

    t.test(label + ": dispose -> every touch throws a named ReactiveDisposedError (not parked)", () => {
        const vm = new Locals();
        assert.equal(fdispose(vm), true);
        assert.throws(
            () => vm.draft,
            (e) => e instanceof FErr && e.name === "ReactiveDisposedError" && !/parked/.test(e.message),
        );
        assert.throws(
            () => { vm.draft = 1; },
            (e) => e instanceof FErr && !/parked/.test(e.message),
        );
        assert.throws(
            () => fboxOf(vm, "mirror"),
            (e) => e instanceof FErr && !/parked/.test(e.message),
        );
    });

    t.test(label + ": park -> every touch throws the parked-message error", () => {
        const vm = new Locals();
        assert.equal(frelease(vm), true);
        assert.throws(() => vm.draft, (e) => e instanceof FErr && /parked/.test(e.message));
        assert.throws(() => { vm.mirror = 3; }, (e) => e instanceof FErr && /parked/.test(e.message));
        assert.throws(() => fboxOf(vm, "draft"), (e) => e instanceof FErr && /parked/.test(e.message));
        fdispose(vm);
    });

    t.test(label + ": park->reinit (PD-58) resets the box to its initial AND the seen slot to the CURRENT upstream", () => {
        const vm = new Locals();
        vm.src = 99;                   // move upstream away from the wiring value
        vm.draft = 7;                  // override: box=7, seen=99
        assert.equal(vm.draft, 7);
        frelease(vm);
        freinit(vm);
        // After reinit: src reset to its field-initial 10 (signal loop), draft box
        // reset to its initial 0, seen reseeded to the CURRENT upstream 10. A read
        // therefore returns the INITIAL (0), which is ONLY possible if seen === 10:
        // a stale seen (99) would make the read reset to the upstream (10) instead.
        assert.equal(vm.src, 10, "src reset to its field-initial");
        assert.equal(vm.draft, 0, "draft box reset to its initial 0 AND seen reseeded to the current upstream");
        assert.equal(vm.mirror, 10, "mirror (localCopy) reseeds its box from the current upstream 10");
        fdispose(vm);
    });

    t.test(label + ": initials[] accepts @localTo keys on reinit", () => {
        const vm = new Locals();
        frelease(vm);
        freinit(vm, { draft: 77, mirror: 88 });
        // seen is reseeded to the current upstream (10) for both, so with a static
        // upstream the caller override reads straight back.
        assert.equal(vm.draft, 77, "the reinit initials value overrides the draft box");
        assert.equal(vm.mirror, 88, "the reinit initials value overrides the mirror box");
        fdispose(vm);
    });

    t.test(label + ": boxOf(vm, localKey) returns the live local box (identity via a write through it)", () => {
        const vm = new Locals();
        const box = fboxOf(vm, "draft");
        assert.equal(typeof box.get, "function", "boxOf returns a live signal box");
        box.set(555);                  // write straight through the returned box
        // The upstream is static (== seen), so makeLocalGet returns the box value:
        // seeing 555 proves boxOf handed back the very box the accessor reads.
        assert.equal(vm.draft, 555, "a write through the boxOf handle is visible through the accessor");
        fdispose(vm);
    });

    t.test(label + ": costOf reports nodes === P+L+D+E+1 and a `locals` field", () => {
        const c = fcostOf(Locals);
        assert.equal(c.signals, 1, "P = 1 (src)");
        assert.equal(c.locals, 2, "L = 2 (draft, mirror)");
        assert.equal(c.deriveds, 0);
        assert.equal(c.effects, 0);
        assert.equal(c.nodes, 4, "nodes === P + L + D + E + 1 == 1 + 2 + 0 + 0 + 1");
    });
}

test("localTo lattice over the TS standard emit", (t) => {
    localToLatticeSuite(t, tsClasses, "ts");
});

test("localTo lattice over the Babel 2023-11 emit", (t) => {
    localToLatticeSuite(t, babelClasses, "babel");
});

// =================================================================================
// The buildless twin (defineReactive spec.locals): the same lattice through the
// no-build path, whose local box is seeded via the plan initFn (not a decorator
// SIG_INITIAL capture) -- a distinct code path worth its own proof.
// =================================================================================

function makeBuildless() {
    return defineReactive(class Bl {}, {
        signals: { src: 10 },
        locals: {
            draft: { source: (self) => self.src, initial: 0 },
            mirror: { source: (self) => self.src },
        },
    });
}

test("buildless: spec.locals unifies both flavors (draft starts at initial, mirror follows source)", () => {
    const C = makeBuildless();
    const vm = new C();
    assert.equal(vm.draft, 0, "draft starts at its buildless initial 0");
    assert.equal(vm.mirror, 10, "mirror follows the source from wiring");
    disposeReactive(vm);
});

test("buildless: write override, upstream reset, and the ABA stale-local contract hold", () => {
    const C = makeBuildless();
    const vm = new C();
    vm.draft = 42;
    assert.equal(vm.draft, 42, "override with a static upstream");
    vm.src = 20;
    assert.equal(vm.draft, 20, "reset on an upstream move");
    // ABA on the buildless path.
    vm.src = 100;
    vm.draft = 999;
    vm.src = 200;
    assert.equal(vm.draft, 200, "transient reset at B");
    vm.src = 100;
    assert.equal(vm.draft, 999, "ABA stale-local at the equals-A return");
    disposeReactive(vm);
});

test("buildless: park->reinit resets the box to its initial and seen to the current upstream", () => {
    const C = makeBuildless();
    const vm = new C();
    vm.src = 99;
    vm.draft = 7;
    releaseReactive(vm);
    reinitReactive(vm);
    assert.equal(vm.src, 10);
    assert.equal(vm.draft, 0, "box -> initial, seen -> current upstream (10)");
    assert.equal(vm.mirror, 10);
    disposeReactive(vm);
});

test("buildless: reinit initials accepts a local key", () => {
    const C = makeBuildless();
    const vm = new C();
    releaseReactive(vm);
    reinitReactive(vm, { draft: 33 });
    assert.equal(vm.draft, 33);
    disposeReactive(vm);
});

// =================================================================================
// Coarse-equals: a custom equals governs the UPSTREAM compare only (PD-56), so
// it can hold an override across a move that Object.is would reset.
// =================================================================================

test("equals suppression: a coarse equals holds an override across a move Object.is would reset", () => {
    const C = buildClass({
        name: "Coarse",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "s", decorator: reactive, value: () => 0 },
            {
                kind: "accessor",
                key: "loc",
                decorator: localTo((self) => self.s, { equals: (a, b) => Math.abs(a - b) < 0.5 }),
            },
        ],
    });
    const vm = new C();
    vm.s = 1.0;
    vm.loc = 42;                    // box=42, seen=1.0
    vm.s = 1.4;                     // Object.is would reset; within-tolerance -> unchanged
    assert.equal(vm.loc, 42, "a within-tolerance move preserves the override");
    vm.s = 3.0;                     // beyond tolerance -> reset
    assert.equal(vm.loc, 3.0, "an out-of-tolerance move resets");
    disposeReactive(vm);
});

// =================================================================================
// Source throw: a throwing source propagates from the READ, mutating nothing
// (fail closed) -- costOf/stats unperturbed after the throw.
// =================================================================================

test("source throw: propagates from the read, nothing mutated (fail closed)", () => {
    const C = buildClass({
        name: "Throwy",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "s", decorator: reactive, value: () => 1 },
            // `boom` is a PLAIN (non-reactive) instance flag; false at wiring so
            // seedLocal's untracked source read succeeds, true flips the read to throw.
            { kind: "field", key: "boom", value: () => false },
            {
                kind: "accessor",
                key: "loc",
                decorator: localTo(function (self) {
                    if (self.boom) throw new Error("localTo source boom");
                    return self.s;
                }),
            },
        ],
    });
    const vm = new C();
    assert.equal(vm.loc, 1, "a healthy source reads through");
    const before = stats();
    const beforeActive = before.activeNodes;
    vm.boom = true;
    assert.throws(() => vm.loc, (e) => /localTo source boom/.test(e.message), "the source throw propagates from the read");
    const after = stats();
    assert.equal(after.activeNodes, beforeActive, "the throwing read mutated no graph node (fail closed)");
    assert.ok(conserved(), "the ledger stays balanced across the throw");
    // Nothing corrupted: clearing the flag restores a healthy read.
    vm.boom = false;
    assert.equal(vm.loc, 1);
    disposeReactive(vm);
});

// =================================================================================
// costOf shape variety: P=1, L=2, D=1, E=0 -> nodes 5, locals 2 (a derived that
// READS a local, proving the local counts as exactly one box node).
// =================================================================================

test("costOf: a derived reading a local counts P+L+D+E+1 with locals=2", () => {
    const C = buildClass({
        name: "CostShape",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "src", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "a", decorator: localTo((self) => self.src), value: () => 0 },
            { kind: "accessor", key: "b", decorator: localTo((self) => self.src) },
            { kind: "getter", key: "d", decorator: derived, body: function () { return this.a + this.b; } },
        ],
    });
    const c = costOf(C);
    assert.equal(c.signals, 1);
    assert.equal(c.locals, 2);
    assert.equal(c.deriveds, 1);
    assert.equal(c.effects, 0);
    assert.equal(c.nodes, 5, "P+L+D+E+1 == 1+2+1+0+1");
});

// =================================================================================
// validateLocalOptions rejections -- named TypeErrors, fail closed.
// =================================================================================

test("validateLocalOptions: missing source is a named TypeError", () => {
    assert.throws(
        () => localTo(),
        (e) => e instanceof TypeError && /localTo requires a source function/.test(e.message),
    );
});

test("validateLocalOptions: a non-function source is a named TypeError", () => {
    assert.throws(
        () => localTo(123),
        (e) => e instanceof TypeError && /localTo requires a source function/.test(e.message),
    );
    assert.throws(
        () => localTo({}),
        (e) => e instanceof TypeError && /localTo requires a source function/.test(e.message),
    );
});

test("validateLocalOptions: an unknown option key is a named TypeError (fail closed, not silently ignored)", () => {
    assert.throws(
        () => localTo((self) => self.s, { bogus: 1 }),
        (e) => e instanceof TypeError && /unknown option `bogus`/.test(e.message),
    );
    // `source` is NOT an option key -- passing it as one is fail-closed rejected
    // (the whole point of localTo's OWN validator, PLAN-S8 spelling call).
    assert.throws(
        () => localTo((self) => self.s, { source: (s) => s.x }),
        (e) => e instanceof TypeError && /unknown option `source`/.test(e.message),
    );
});

// =================================================================================
// THE DEP-LEAK REGRESSION (the set-path law): a local WRITE performed INSIDE a
// reactiveEffect body must NOT subscribe that effect to the upstream. After such
// a write, a later upstream move must NOT re-fire the effect. This is the
// isTracking()/untrack() gate in makeLocalSet's reason to exist -- pin it.
// =================================================================================

test("dep-leak regression: a local write inside an effect does NOT subscribe the effect to the upstream", () => {
    let fires = 0;
    const C = buildClass({
        name: "SetPathLeak",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "trigger", decorator: reactive, value: () => 0 },
            { kind: "accessor", key: "up", decorator: reactive, value: () => 0 },
            { kind: "accessor", key: "loc", decorator: localTo((self) => self.up) },
            {
                // The effect reads `trigger` (its ONE legit dep) and WRITES `loc`.
                // makeLocalSet's seen-capture reads `up` -- WITHOUT the untrack gate
                // that tracked read would silently subscribe this effect to `up`.
                kind: "method",
                key: "e",
                decorator: reactiveEffect,
                body: function () { fires++; this.loc = this.trigger; },
            },
        ],
    });
    const vm = new C();
    assert.equal(fires, 1, "the effect fires once at wiring");

    vm.up = 5;                     // move the UPSTREAM: the effect must NOT re-fire
    assert.equal(fires, 1, "moving the local's upstream did NOT re-fire the effect (no leaked dep)");

    vm.trigger = 9;                // move the effect's LEGIT dep: it MUST re-fire
    assert.equal(fires, 2, "moving the tracked trigger re-fires the effect (the real dep still links)");

    vm.up = 7;                     // once more: still no leak after a genuine re-fire
    assert.equal(fires, 2, "the upstream still does not re-fire the effect after a real fire");

    disposeReactive(vm);
});

// --- conservation sanity: everything this file built is disposed ---------------

test("conservation: every instance built above was disposed (ledger balances)", () => {
    assert.ok(conserved(), "totalAllocations - totalDisposals === activeNodes");
});
