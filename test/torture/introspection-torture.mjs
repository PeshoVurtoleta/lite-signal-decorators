// test/torture/introspection-torture.mjs -- node --expose-gc test/torture/introspection-torture.mjs
//
// The S9 introspection lane (PLAN-S9 T10/T11, group: semantic, floor 1.5.0).
// forEachReactive and snapshotOf are COLD, opt-in exports; this lane proves the
// two claims the plan makes about them with MEASURED numbers, never invented:
//
//   T10 (A3) the WALK is zero-alloc -- 1e6 forEachReactive walks over a
//     P=4, L=1, D=2, E=1 instance driven by a MODULE-HOISTED callback (no
//     per-walk closure): gc.major === 0 STRICT, maxPauseMs <= 4.0 STRICT,
//     minors CONTROL-RELATIVE at an in-process zero-alloc control + 128 (via
//     gcGate), and the delta-heap PER WALK at/below the same control + 2 B
//     (forced-GC noise floor) measured at N and 8N. The arg pass-through kills
//     the caller's closure too, so the whole walk carries zero per-visit bytes.
//
//   T11 the SNAPSHOT allocates BY DESIGN -- 1e5 snapshotOf calls. The snapshot
//     is a plain {} of every member; it is a cold migration/serialize call, not
//     a frame path, so its bytes/op are MEASURED and REPORTED (never gated vs
//     the zero floor). Major GC is still 0 (the young snapshots minor and are
//     reclaimed); minors are reported honestly against the walk control.
//
//   A4 retention -- 1e5 construct -> snapshotOf -> disposeReactive cycles under
//     a lite-leak tracker: tracker.size() === 0 after settle (held-value-safe),
//     0 findings, 0 warnings; the default registry's F-0 floor returns to its
//     pre-loop baseline; and a KEPT snapshot object holds NO box reference (its
//     values are plain accessor reads -- none is a live signal box).
//
// TORTURE_BREAK=introspection-torture makes the WALK lane allocate a 1024-slot
// array per walk: the control-relative maxMinor gate is what catches it, and
// the lane exits non-zero (the --controls self-test).
//
// ASCII-only.

import { effect, stats } from "@zakkster/lite-signal";
import {
    createLeakTracker,
    createOwnerCascadeOrphanKernel,
    createObserverOrphanKernel,
} from "@zakkster/lite-leak";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, settle, pass,
    conservationBaseline, assertConserved, gcGate, dieInfra,
} from "./helpers/harness.mjs";

const NAME = "introspection-torture";

if (typeof globalThis.gc !== "function") {
    dieInfra("introspection-torture requires node --expose-gc (forced-GC brackets are the measurement)");
}

// --- the shape under test -----------------------------------------------------
//
// P=4 signals (s0..s3), L=1 local (loc, keyed on s0), D=2 deriveds (d0=s0+s1,
// d1=s2+s3), E=1 effect (e0 over d0). The walk visits P+L+D = 7 value-bearing
// members; the effect is EXCLUDED. Node cost per instance: P+L+D+E+1 = 9.
const P = 4, L = 1, D = 2, E = 1;
const NODES_PER_INSTANCE = P + L + D + E + 1;   // 4 + 1 + 2 + 1 + 1 = 9
const WALK_COUNT = P + L + D;                    // 7 value-bearing members

function introMembers() {
    return [
        { kind: "accessor", key: "s0", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "s1", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "s2", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "s3", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "loc", decorator: pkg.localTo((self) => self.s0), value: () => 0 },
        { kind: "getter", key: "d0", decorator: pkg.derived, body: function () { return this.s0 + this.s1; } },
        { kind: "getter", key: "d1", decorator: pkg.derived, body: function () { return this.s2 + this.s3; } },
        { kind: "method", key: "e0", decorator: pkg.reactiveEffect, body: function () { void this.d0; } },
    ];
}

const Intro = buildClass({ name: "IntroVM", classDecorator: pkg.reactiveHost, members: introMembers() });

const SCENARIO_BASE = conservationBaseline();

// --- the MODULE-HOISTED walk callback (defined ONCE, never per walk) -----------
//
// It threads its accumulator through `arg` (the closure-free pass-through), so
// the whole walk carries zero per-visit bytes beyond its four scalar args. The
// kind literal is one of three hoisted interned strings -- reading kind.length
// defeats DCE without allocating.
const WALK_ARG = { n: 0 };
function walkCb(key, box, kind, arg) {
    arg.n = (arg.n + kind.length) | 0;
}

// ===============================================================================
// T10 -- the WALK is zero-alloc: 1e6 forEachReactive walks, hoisted callback.
// ===============================================================================

let walkSummary, snapSummary;
let walkFloor, walkLimit, walkMinor, snapMinor;
let perSmall, perBig, ctlBig;
let snapBytesPerOp;

{
    const vm = new Intro();
    void vm.d0; void vm.d1;              // force the lazy deriveds' boxes/links

    const HOT = 1000000;                 // 1e6 walks, the A3 lane size

    const doBreak = breakActive(NAME);
    const walkClean = (i) => { pkg.forEachReactive(vm, walkCb, WALK_ARG); return WALK_ARG.n; };
    const walkBreak = (i) => {
        const a = new Array(1024); a[0] = i;         // allocation storm under BREAK
        pkg.forEachReactive(vm, walkCb, WALK_ARG);
        return WALK_ARG.n + a[0];
    };
    const walkFn = doBreak ? walkBreak : walkClean;

    // Control minors, measured in THIS process (decision 0003 / zerogc idiom) --
    // never a hardcoded budget. maxMajor/maxPauseMs asserted on the control too.
    const controlSummary = await gcGate("intro-walk-control", (i) => (i & 7), {
        ops: HOT,
        warmup: HOT,
        maxMajor: 0,
        maxPauseMs: 4,
    });
    walkFloor = controlSummary.gc.minor;
    walkLimit = walkFloor + 128;

    walkSummary = await gcGate("intro-walk", walkFn, {
        ops: HOT,
        warmup: HOT,
        maxMajor: 0,
        maxMinor: walkLimit,
        maxPauseMs: 4,
    });
    walkMinor = walkSummary.gc.minor;

    // The headline: delta-heap PER WALK, measured by SCALING at N and 8N with
    // forced-GC brackets. A clean walk retains nothing, so the per-walk delta
    // amortizes toward the control's forced-GC endpoint noise.
    function forceGc() { globalThis.gc(); globalThis.gc(); }
    function heapNow() { forceGc(); return process.memoryUsage().heapUsed; }
    function retainedWindow(work, n) {
        const a = heapNow();
        for (let i = 0; i < n; i++) work(i);
        const b = heapNow();
        return b - a;
    }

    let dsink = 0;
    const walkCycle = (i) => { dsink += walkClean(i); };
    const controlCycle = (i) => { dsink += (i & 7); };

    const N_SMALL = HOT;                 // 1e6
    const N_BIG = HOT * 8;               // 8e6
    const retSmall = retainedWindow(walkCycle, N_SMALL);
    const retBig = retainedWindow(walkCycle, N_BIG);
    perSmall = retSmall / N_SMALL;
    perBig = retBig / N_BIG;
    ctlBig = retainedWindow(controlCycle, N_BIG) / N_BIG;
    if (dsink === -1) console.log("unreachable");

    // PD-45: "zero" is operational -- at or below the matched in-process
    // zero-alloc control, both ends forced-GC bracketed. +2 B is the forced-GC
    // noise-floor tolerance, never a widened budget.
    check(
        perBig <= ctlBig + 2,
        () => "T10 walk headline: delta-heap/walk " + perBig.toFixed(3) + " B > control " +
            ctlBig.toFixed(3) + " B (+2 noise tolerance) at N=" + N_BIG +
            " (small-window N=" + N_SMALL + " was " + perSmall.toFixed(3) + " B/walk)",
    );

    // Correctness: the walk visited exactly WALK_COUNT members every call.
    {
        const out = [];
        const c2 = pkg.forEachReactive(vm, (k, b, kind) => out.push(kind), null);
        check(c2 === WALK_COUNT, () => "T10: forEachReactive visited " + c2 + " != expected " + WALK_COUNT);
        check(
            out.length === WALK_COUNT &&
            out[0] === "signal" && out[4] === "local" && out[5] === "derived",
            () => "T10: walk kinds wrong: " + out.join(","),
        );
    }

    pkg.disposeReactive(vm);
}

// ===============================================================================
// T11 -- the SNAPSHOT allocates BY DESIGN: 1e5 snapshotOf calls, bytes/op
// MEASURED and REPORTED (never gated vs zero); major GC still 0.
// ===============================================================================

{
    const vm = new Intro();
    void vm.d0; void vm.d1;

    const SNAP_OPS = 100000;             // 1e5, the T11 lane size

    // Major-GC / pause gate over the discard path (the young snapshots minor and
    // are reclaimed). No maxMinor: the snapshot allocates, so minors are REPORTED
    // against the walk control, never gated against zero.
    let ksink = 0;
    const snapOp = (i) => { const s = snapshotOfKeys(vm); ksink += s; return s; };
    function snapshotOfKeys(v) {
        const snap = pkg.snapshotOf(v);
        // touch every member so the read is not elided
        let n = 0;
        for (const _ in snap) n++;
        return n + Object.getOwnPropertySymbols(snap).length;
    }
    snapSummary = await gcGate("intro-snapshot", snapOp, {
        ops: SNAP_OPS,
        warmup: 5000,
        maxMajor: 0,
        maxPauseMs: 4,
    });
    snapMinor = snapSummary.gc.minor;
    if (ksink === -1) console.log("unreachable");

    // The MEASURED bytes/op: retain every snapshot inside a forced-GC bracket so
    // the delta IS the snapshot footprint (this figure is REPORTED, not gated).
    function forceGc() { globalThis.gc(); globalThis.gc(); }
    function heapNow() { forceGc(); return process.memoryUsage().heapUsed; }
    const kept = new Array(SNAP_OPS);
    const a = heapNow();
    for (let i = 0; i < SNAP_OPS; i++) kept[i] = pkg.snapshotOf(vm);
    const b = heapNow();
    snapBytesPerOp = (b - a) / SNAP_OPS;
    // Sanity: the retained snapshots are real objects with the member count.
    check(
        Object.keys(kept[0]).length + Object.getOwnPropertySymbols(kept[0]).length === WALK_COUNT,
        () => "T11: a snapshot must carry all " + WALK_COUNT + " value-bearing members",
    );
    check(snapBytesPerOp > 0, () => "T11: the snapshot must allocate (measured " + snapBytesPerOp.toFixed(1) + " B/op)");
    kept.length = 0;

    pkg.disposeReactive(vm);
}

// ===============================================================================
// A4 -- retention: 1e5 construct -> snapshotOf -> disposeReactive cycles under a
// lite-leak tracker; F-0 back to baseline; a kept snapshot holds NO box.
// ===============================================================================

let live = 0, findingsN = 0, warnsN = 0;

{
    const RET_CYCLES = 100000;           // 1e5, the A4 lane size
    const LEAK_EVERY = 20000;            // BREAK cadence (dead under the walk-break flag)

    const leaks = [];
    const warns = [];
    const tracker = createLeakTracker({
        name: NAME,
        onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
        onWarning: (w) => warns.push(w.kind + ":" + w.reason),
    });
    tracker.registerKernel(createOwnerCascadeOrphanKernel());
    tracker.registerKernel(createObserverOrphanKernel());

    // Held-value-safe: `release` captures nothing, the tag is a detached primitive.
    function release() {}
    const AUDIT = { audit: true };
    const doBreak = breakActive(NAME);

    const preLoop = { activeNodes: stats().activeNodes };

    let keptSnap = null;
    const leakedVms = [];
    const leakedStops = [];

    let rsink = 0;
    for (let i = 0; i < RET_CYCLES; i++) {
        RUN.op = i;
        const inst = new Intro();
        const tag = i & 255;
        const stop = effect(function () { tracker.track(inst, release, tag, AUDIT); });
        const snap = pkg.snapshotOf(inst);
        rsink = (rsink + Object.keys(snap).length) | 0;
        if (i === 0) keptSnap = snap;    // keep ONE snapshot from a to-be-disposed instance

        if (doBreak && (i % LEAK_EVERY === 0)) {
            leakedVms.push(inst);        // retained -> off the tracker floor
            leakedStops.push(stop);
        } else {
            pkg.disposeReactive(inst);
            stop();
        }
    }
    if (rsink === -1) console.log("unreachable");
    RUN.op = -1;

    // The kept snapshot outlived its instance's disposal: prove it holds NO live
    // box -- every value is a plain accessor read, not a signal box.
    check(keptSnap !== null, () => "A4: no snapshot was kept");
    for (const k of Reflect.ownKeys(keptSnap)) {
        const v = keptSnap[k];
        const looksLikeBox = v !== null && typeof v === "object" &&
            typeof v.get === "function" && typeof v.set === "function";
        check(!looksLikeBox, () => "A4: kept snapshot value for " + String(k) + " is a live box -- snapshot retained reactivity");
    }

    await settle();
    globalThis.gc();
    await settle();

    live = tracker.size();
    findingsN = tracker.audit().length;
    warnsN = warns.length;

    check(warnsN === 0, () => "A4: kernel warnings emitted: " + warns.join(","));
    check(findingsN === 0, () => "A4: audit findings emitted");
    check(leaks.length === 0, () => "A4: leak callbacks fired: " + leaks.join(","));
    check(
        live === 0,
        () => "A4: tracker retained " + live + " handle(s) after settle -- an instance outlived its owner",
    );

    // F-0: the default registry returns to its pre-loop baseline.
    check(
        stats().activeNodes === preLoop.activeNodes,
        () => "A4: activeNodes " + stats().activeNodes + " != pre-loop baseline " + preLoop.activeNodes,
    );
}

// --- overall conservation ------------------------------------------------------

assertConserved(SCENARIO_BASE, "introspection-torture final");

process.stdout.write(
    "torture: introspection-torture" +
    " | T10 walk=1e6 gc major=" + walkSummary.gc.major + " minor=" + walkMinor +
    " (floor=" + walkFloor + " limit=" + walkLimit + ") maxMs=" + walkSummary.gc.maxMs.toFixed(2) +
    " delta-heap/walk small=" + perSmall.toFixed(3) + "B big=" + perBig.toFixed(3) + "B ctl=" + ctlBig.toFixed(3) + "B" +
    " | T11 snapshot=1e5 gc major=" + snapSummary.gc.major + " minor=" + snapMinor +
    " maxMs=" + snapSummary.gc.maxMs.toFixed(2) +
    " bytes/op=" + snapBytesPerOp.toFixed(1) + " (allocates by design, not gated)" +
    " | A4 leak size=" + live + "/0 findings=" + findingsN + " warnings=" + warnsN + "\n",
);

pass(NAME);
