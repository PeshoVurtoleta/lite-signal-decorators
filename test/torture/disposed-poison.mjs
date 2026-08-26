// test/torture/disposed-poison.mjs -- node --expose-gc test/torture/disposed-poison.mjs
//
// The full post-dispose poison surface (PLAN-S2b T2, decision 0002 D-2d/D-2f/
// D-2g + 0004 D-4e), on decorated AND defineReactive instances. After
// disposeReactive, every touch of the dead instance fails closed:
//   - accessor get/set               -> ReactiveDisposedError
//   - derived get                    -> ReactiveDisposedError
//   - boxOf(vm, signal|derived)      -> ReactiveDisposedError
//   - rootOf(vm)                     -> ReactiveDisposedError
//   - manual @reactiveEffect call    -> ReactiveDisposedError (poison touch in
//                                       the body; D-4e lets a disposed receiver
//                                       past the identity guard so it fails
//                                       closed on the poison slot)
//   - manual @batched call           -> ReactiveDisposedError (decorated only;
//                                       defineReactive has no batched section)
//
// Resurrection storm: a scripted sequence of every post-dispose call --
// captured-box writes + subscribe, captured-handle reads, manual method calls,
// `using` re-entry, double dispose, and a cross-instance write on a live
// unrelated instance -- run repeatedly. The dead instance's OWNED effect fires
// ZERO more times and its derived recomputes ZERO more times (counted through
// counters the bodies bump AFTER the reactive read, so a manual call that throws
// on the poison read never charges a count), and no slot is ever un-poisoned.
//
// TORTURE_BREAK=disposed-poison pretends the poison swap was skipped for one
// slot: the post-storm re-verification asserts that slot reads LIVE (no throw),
// which reality refutes -- the gate fails.
//
// ASCII-only.

import { dispose as sigDispose, stats } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import { RUN, check, breakActive, settle, pass } from "./helpers/harness.mjs";

const NAME = "disposed-poison";
const RDE = pkg.ReactiveDisposedError;

function throwsRDE(fn) {
    try { fn(); } catch (e) { return e instanceof RDE; }
    return false;
}

// --- twin builders: fresh counters per class so runs never cross-charge -------
//
// Both bodies READ the reactive member first, then bump. A live wiring run reads
// a live box and counts; a post-dispose manual call throws on the poison read
// BEFORE the bump, so the counter is a faithful "completed reactive run" signal.

function buildDecClass() {
    const counters = { dx: 0, fx: 0 };
    const C = buildClass({
        name: "PoisonDec",
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 0 },
            {
                kind: "getter",
                key: "dx",
                decorator: pkg.derived,
                body: function () { const v = this.x + 1; counters.dx++; return v; },
            },
            {
                kind: "method",
                key: "fx",
                decorator: pkg.reactiveEffect,
                body: function () { void this.x; counters.fx++; },
            },
            {
                kind: "method",
                key: "bump",
                decorator: pkg.batched,
                body: function () { this.x = this.x + 1; },
            },
        ],
    });
    return { C, counters, hasBatched: true };
}

function buildBuildlessClass() {
    const counters = { dx: 0, fx: 0 };
    class B {}
    const C = pkg.defineReactive(B, {
        signals: { x: 0 },
        deriveds: { dx: function () { const v = this.x + 1; counters.dx++; return v; } },
        effects: { fx: function () { void this.x; counters.fx++; } },
    });
    return { C, counters, hasBatched: false };
}

// A distinct live class for the cross-instance write (its own counters, so
// driving it can never be mistaken for the dead instance re-running).
function buildOtherClass() {
    const counters = { fx: 0 };
    const C = buildClass({
        name: "PoisonOther",
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 0 },
            {
                kind: "method",
                key: "fx",
                decorator: pkg.reactiveEffect,
                body: function () { void this.x; counters.fx++; },
            },
        ],
    });
    return { C, counters };
}

const STORMS = 3;

function runSurface(label, twin) {
    const baseActive = stats().activeNodes;
    const vm = new twin.C();
    const counters = twin.counters;

    // Live sanity: the effect fired once at wire; force the derived to compute.
    check(counters.fx === 1, () => label + ": wire-fire=" + counters.fx + " expected 1");
    check(vm.dx === 1, () => label + ": live dx=" + vm.dx + " expected 1");
    check(counters.dx === 1, () => label + ": live derived recompute=" + counters.dx + " expected 1");

    // Capture live handles + a live subscription BEFORE dispose.
    const box = pkg.boxOf(vm, "x");
    const dbox = pkg.boxOf(vm, "dx");
    const root = pkg.rootOf(vm);
    check(root !== undefined && root.kind === "effect", () => label + ": rootOf kind=" + (root && root.kind));
    const seen = [];
    const unsub = box.subscribe((v) => { seen.push(v); });
    const seenAtDispose = seen.length;

    const fxAtDispose = counters.fx;
    const dxAtDispose = counters.dx;

    check(pkg.disposeReactive(vm) === true, () => label + ": first dispose did not return true");

    // --- immediate post-dispose surface ---------------------------------------
    check(throwsRDE(() => vm.x), () => label + ": post-dispose get did not throw RDE");
    check(throwsRDE(() => { vm.x = 9; }), () => label + ": post-dispose set did not throw RDE");
    check(throwsRDE(() => vm.dx), () => label + ": post-dispose derived get did not throw RDE");
    check(throwsRDE(() => pkg.boxOf(vm, "x")), () => label + ": post-dispose boxOf(signal) did not throw RDE");
    check(throwsRDE(() => pkg.boxOf(vm, "dx")), () => label + ": post-dispose boxOf(derived) did not throw RDE");
    check(throwsRDE(() => pkg.rootOf(vm)), () => label + ": post-dispose rootOf did not throw RDE");
    check(throwsRDE(() => vm.fx()), () => label + ": post-dispose manual effect call did not throw RDE");
    if (twin.hasBatched) {
        check(throwsRDE(() => vm.bump()), () => label + ": post-dispose manual batched call did not throw RDE");
    }

    // --- resurrection storm ---------------------------------------------------
    for (let s = 0; s < STORMS; s++) {
        // captured-box write + read on a torn-down handle: fires nothing.
        try { box.set(100 + s); } catch (_) { /* torn down */ }
        try { void box.get(); } catch (_) { /* torn down */ }
        // captured-derived-handle read.
        try { void dbox.get(); } catch (_) { /* torn down */ }
        // manual method calls (each fails closed on the poison read).
        try { vm.fx(); } catch (_) { /* RDE */ }
        if (twin.hasBatched) { try { vm.bump(); } catch (_) { /* RDE */ } }
        // accessor writes through the dead instance.
        try { vm.x = 200 + s; } catch (_) { /* RDE */ }
        // `using` re-entry: block exit runs Symbol.dispose -> idempotent no-op.
        try {
            using u = vm;
            void u;
        } catch (_) { /* Symbol.dispose no-op never throws; guard anyway */ }
        // double dispose -- idempotent false.
        check(pkg.disposeReactive(vm) === false, () => label + ": storm " + s + " double dispose returned true");
        // cross-instance write: a live unrelated instance re-runs ITS effect, not ours.
        const other = buildOtherClass();
        const o = new other.C();
        o.x = 7;
        check(other.counters.fx === 2, () => label + ": storm " + s + " cross-instance effect fired " + other.counters.fx + " expected 2");
        pkg.disposeReactive(o);
    }

    // The live subscription captured before dispose received nothing after the
    // box was torn down.
    check(seen.length === seenAtDispose, () => label + ": captured subscription fired post-dispose (seen " + seen.length + " != " + seenAtDispose + ")");
    unsub();                                   // safe no-op on a disposed box

    // ZERO owned-effect executions and ZERO derived recomputes on the corpse.
    check(counters.fx === fxAtDispose, () => label + ": dead effect executed post-dispose (fx " + counters.fx + " != " + fxAtDispose + ")");
    check(counters.dx === dxAtDispose, () => label + ": dead derived recomputed post-dispose (dx " + counters.dx + " != " + dxAtDispose + ")");

    // No slot un-poisoned. BREAK pretends the swap was skipped for slot 0.
    const keys = ["x", "dx"];
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const threw = throwsRDE(() => vm[k]);
        const mustThrow = !(breakActive(NAME) && i === 0);
        check(
            threw === mustThrow,
            () => label + ": post-storm read of " + k + " threw=" + threw + " expected throw=" + mustThrow,
        );
    }

    // Conservation: the corpse and every transient `other` returned to baseline.
    check(stats().activeNodes === baseActive, () => label + ": activeNodes " + stats().activeNodes + " != baseline " + baseActive);
}

RUN.op = 0;
runSurface("decorated", buildDecClass());
RUN.op = 1;
runSurface("buildless", buildBuildlessClass());

await settle();
RUN.op = -1;
pass(NAME);
