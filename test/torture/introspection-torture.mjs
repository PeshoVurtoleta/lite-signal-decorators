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
//     a lite-leak tracker, the AUTHORITY being FINALIZATION: each disposed
//     instance is tracked OUTSIDE any owner with a shared NOOP cleanup + numeric
//     tag (held-value-safe), NEVER untracked, so after a HARD settle the residual
//     tracker.size() <= RES = max(16, RET_CYCLES/1000); the default registry's
//     F-0 floor returns to its pre-loop baseline (the INDEPENDENT node oracle);
//     and a KEPT snapshot object holds NO box reference (its values are plain
//     accessor reads -- none is a live signal box). (An earlier version tracked
//     from inside an effect and untracked on stop() -- VARIANT-2 VACUOUS: stop()
//     drove size() to 0 by construction. Fixed here. S10-A5 has the same fix.)
//
// TORTURE_BREAK=introspection-torture makes the WALK lane allocate a 1024-slot
// array per walk: the control-relative maxMinor gate is what catches it, and
// the lane exits non-zero (the --controls self-test). TORTURE_LEAK=1 pins every
// disposed A4/S10-A5 instance in a module sink so it can NEVER finalize ->
// residual ~= the tracked count -> the finalization gates trip RED (the node
// oracles stay green: the instances are still disposed).
//
// ASCII-only.

import { stats } from "@zakkster/lite-signal";
import { createLeakTracker } from "@zakkster/lite-leak";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, pass,
    conservationBaseline, assertConserved, gcGate, dieInfra,
    retainLeak, residualCeiling, settleHard,
} from "./helpers/harness.mjs";

const NAME = "introspection-torture";

// RED control (TORTURE_LEAK=1): pin every disposed retention instance in this
// module sink so it can NEVER finalize -> residual ~= the tracked count. Shared
// by A4 and S10-A5. Read post-settle in each lane to defeat V8 liveness elision.
const RETAIN = retainLeak();
const __leakSink = [];

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
    const RES = residualCeiling(RET_CYCLES);   // finalization residual ceiling (100)

    const warns = [];
    // PLAIN tracker: no kernels, no onLeak (finalization is the release path).
    const tracker = createLeakTracker({
        name: NAME,
        onWarning: (w) => warns.push(w.kind + ":" + w.reason),
    });

    // Held-value-safe: `release` captures nothing, the tag is a detached primitive.
    function release() {}

    const preLoop = { activeNodes: stats().activeNodes };

    let keptSnap = null;

    let rsink = 0;
    for (let i = 0; i < RET_CYCLES; i++) {
        RUN.op = i;
        const inst = new Intro();
        const tag = i & 255;
        const snap = pkg.snapshotOf(inst);
        rsink = (rsink + Object.keys(snap).length) | 0;
        if (i === 0) keptSnap = snap;    // keep ONE snapshot from a to-be-disposed instance

        pkg.disposeReactive(inst);
        // AUTHORITY: track OUTSIDE any owner, after disposal -> lite-leak arms no
        // auto-untrack; finalization is the sole release path. Never untracked.
        tracker.track(inst, release, tag);
        if (RETAIN) __leakSink.push(inst);   // RED: pin -> never finalizes
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

    await settleHard(() => tracker.size(), RES);
    // Keep the RED sink live ACROSS the settle (V8 liveness-elides a module array
    // written-but-never-read after the loop, masking the pin).
    if (__leakSink.length === -1) console.log("unreachable");

    live = tracker.size();
    findingsN = tracker.audit().length;
    warnsN = warns.length;

    check(warnsN === 0, () => "A4: kernel warnings emitted: " + warns.join(","));
    check(findingsN === 0, () => "A4: audit findings emitted");
    check(
        live <= RES,
        () => "A4: AUTHORITY finalization residual size()=" + live + " > " + RES +
            " -- an instance outlived its disposal",
    );

    // F-0: the default registry returns to its pre-loop baseline (INDEPENDENT oracle).
    check(
        stats().activeNodes === preLoop.activeNodes,
        () => "A4: activeNodes " + stats().activeNodes + " != pre-loop baseline " + preLoop.activeNodes,
    );
}

// ===============================================================================
// S10-A4 -- costOfInstance is UNCACHED and allocates ONE frozen result per call
// (PD-69): 1e4 costOfInstance walks over a forced P=4,L=1,D=2,E=1 instance. The
// per-call frozen { nodes, links, signals, locals, deriveds, effects } is the ONLY
// allocation, so major GC stays 0 and the pause floor holds; its bytes/op are
// MEASURED and REPORTED (never gated vs zero -- the same discipline as the
// snapshot line above). Minors are reported honestly against a zero-alloc control.
// ===============================================================================

let costSummary, costMinor, costCtlMinor, costBytesPerOp;

{
    const vm = new Intro();
    void vm.d0; void vm.d1;              // force the lazy deriveds so links are settled

    const COST_OPS = 10000;              // 1e4, the S10-A4 lane size

    // Zero-alloc control minors in THIS process (decision 0003) -- reported, not a
    // gate on the cost lane (which allocates the frozen result by design).
    const costControl = await gcGate("intro-cost-control", (i) => (i & 7), {
        ops: COST_OPS,
        warmup: COST_OPS,
        maxMajor: 0,
        maxPauseMs: 4,
    });
    costCtlMinor = costControl.gc.minor;

    let csink = 0;
    const costOp = (i) => { const c = pkg.costOfInstance(vm); csink = (csink + c.nodes + c.links) | 0; return c.nodes; };
    costSummary = await gcGate("intro-cost", costOp, {
        ops: COST_OPS,
        warmup: 5000,
        maxMajor: 0,                     // STRICT: the walk itself allocates nothing
        maxPauseMs: 4,                   // STRICT
    });
    costMinor = costSummary.gc.minor;
    if (csink === -1) console.log("unreachable");

    // The MEASURED bytes/op: retain every frozen result inside a forced-GC bracket
    // so the delta IS the result footprint (REPORTED, never gated vs zero).
    function forceGc() { globalThis.gc(); globalThis.gc(); }
    function heapNow() { forceGc(); return process.memoryUsage().heapUsed; }
    const kept = new Array(COST_OPS);
    const a = heapNow();
    for (let i = 0; i < COST_OPS; i++) kept[i] = pkg.costOfInstance(vm);
    const b = heapNow();
    costBytesPerOp = (b - a) / COST_OPS;

    // Sanity: every retained result is a distinct frozen report of the right shape.
    check(
        Object.isFrozen(kept[0]) && kept[0].nodes === NODES_PER_INSTANCE,
        () => "S10-A4: a cost result must be a frozen report with nodes=" + NODES_PER_INSTANCE + " (saw " + kept[0].nodes + ")",
    );
    check(kept[0] !== kept[1], () => "S10-A4: costOfInstance must be UNCACHED -- two calls returned the same object");
    check(costBytesPerOp > 0, () => "S10-A4: the per-call frozen result must allocate (measured " + costBytesPerOp.toFixed(1) + " B/op)");
    kept.length = 0;

    pkg.disposeReactive(vm);
}

// ===============================================================================
// S10-A5 -- conservation across the full lifecycle: 1000 wire/measure/park/reinit/
// dispose cycles under a lite-leak tracker. costOfInstance is measured on the LIVE
// instance and again after reinit; the tracker must return to 0, activeNodes to
// the exact pre-loop baseline, and poolGrowths must not move.
// ===============================================================================

let cycLive = 0, cycFindings = 0, cycWarns = 0;

{
    const CYCLES = 1000;                 // 1e3, the S10-A5 lane size
    const RES = residualCeiling(CYCLES); // finalization residual ceiling (16)

    const warns = [];
    // PLAIN tracker: no kernels, no onLeak (finalization is the release path).
    const tracker = createLeakTracker({
        name: NAME + "-cost",
        onWarning: (w) => warns.push(w.kind + ":" + w.reason),
    });

    // Held-value-safe: release captures nothing, the tag is a detached primitive.
    function release() {}

    const preLoop = { activeNodes: stats().activeNodes, poolGrowths: stats().poolGrowths };

    let msink = 0;
    for (let i = 0; i < CYCLES; i++) {
        RUN.op = i;
        const inst = new Intro();                // wire
        const tag = i & 255;
        void inst.d0; void inst.d1;
        msink = (msink + pkg.costOfInstance(inst).nodes) | 0;   // measure (live)
        check(
            pkg.releaseReactive(inst) === true,
            () => "S10-A5: releaseReactive failed at cycle " + i,
        );                                        // park
        pkg.reinitReactive(inst);                 // reinit (revive)
        void inst.d0; void inst.d1;
        msink = (msink + pkg.costOfInstance(inst).nodes) | 0;   // measure again (revived)
        pkg.disposeReactive(inst);                // dispose
        // AUTHORITY: track OUTSIDE any owner, after disposal; finalization is the
        // sole release path. Never untracked.
        tracker.track(inst, release, tag);
        if (RETAIN) __leakSink.push(inst);        // RED: pin -> never finalizes
    }
    if (msink === -1) console.log("unreachable");
    RUN.op = -1;

    await settleHard(() => tracker.size(), RES);
    if (__leakSink.length === -1) console.log("unreachable");   // keep RED sink live across settle

    cycLive = tracker.size();
    cycFindings = tracker.audit().length;
    cycWarns = warns.length;

    check(cycWarns === 0, () => "S10-A5: kernel warnings emitted: " + warns.join(","));
    check(cycFindings === 0, () => "S10-A5: audit findings emitted");
    check(
        cycLive <= RES,
        () => "S10-A5: AUTHORITY finalization residual size()=" + cycLive + " > " + RES +
            " -- an instance outlived its disposal",
    );
    check(
        stats().activeNodes === preLoop.activeNodes,
        () => "S10-A5: activeNodes " + stats().activeNodes + " != pre-loop baseline " + preLoop.activeNodes,
    );
    check(
        stats().poolGrowths === preLoop.poolGrowths,
        () => "S10-A5: poolGrowths moved by " + (stats().poolGrowths - preLoop.poolGrowths) + " -- the pool had to grow",
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
    " | A4 residual size=" + live + "/" + residualCeiling(100000) + " findings=" + findingsN + " warnings=" + warnsN +
    " | S10-A4 cost=1e4 gc major=" + costSummary.gc.major + " minor=" + costMinor +
    " (ctl=" + costCtlMinor + ") maxMs=" + costSummary.gc.maxMs.toFixed(2) +
    " bytes/op=" + costBytesPerOp.toFixed(1) + " (allocates by design, not gated)" +
    " | S10-A5 cycles=1e3 residual size=" + cycLive + "/" + residualCeiling(1000) + " findings=" + cycFindings + " warnings=" + cycWarns + "\n",
);

pass(NAME);
