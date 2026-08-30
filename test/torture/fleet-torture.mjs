// test/torture/fleet-torture.mjs -- node --expose-gc test/torture/fleet-torture.mjs
//
// createFleet torture (PLAN-S11 T4, group: semantic, floor 1.5.0). reinit-torture
// keeps the PRIMITIVE pooled-cycle proof (releaseReactive/reinitReactive); THIS
// lane proves the fleet HELPER's own bookkeeping -- the prebuilt acquire/release
// closures over a slot array + an Int32Array free-list + per-vm symbol stamps --
// adds ZERO allocation and ZERO growth on top of it. MEASURED numbers only:
//
//   A1 (the ship bar) -- 4096 acquire/release cycles at the demo-like Entity
//     shape (P=4, D=2, E=1, L=0): gc.major === 0 STRICT, maxPauseMs <= 4.0
//     STRICT, minors CONTROL-RELATIVE at an in-process zero-alloc control + 128
//     (gcGate idiom), the fleet-registry poolGrowths delta 0 across the window,
//     AND the headline delta-heap per acquire/release cycle at/below the same
//     in-process control + 2 B (forced-GC noise floor), measured at N and 8N
//     (a real per-op leak holds its per-op byte figure; fixed endpoint noise
//     amortizes toward zero).
//   A3 (the release node-delta) -- a direct probe INSIDE this lane: releasing an
//     acquired member frees EXACTLY P+L+D+E+1 nodes on the fleet registry.
//   A4 (the cold fail-closed paths under measurement) -- a storm of exhausted +
//     foreign throws at capacity: each throws its NAMED error, and neither the
//     fleet registry ledger (activeNodes) nor the live count (size) moves -- the
//     cold throw disturbs nothing.
//   A2 (conservation over lifecycles) -- 1000 full fleet lifecycles (createFleet
//     N=512 -> partial churn -> dispose): every fleet's poolGrowths delta is 0
//     across its churn (the Int32Array/slots/stamps never grow), every fleet
//     returns to its prefill baseline (activeNodes 0) before dispose, a tracked
//     sample member NEVER outlives its fleet (lite-leak size() === 0 after
//     settle, 0 findings, 0 warnings), and the DEFAULT registry never moves (the
//     fleets own their registries and destroy them).
//
// TORTURE_BREAK=fleet-torture retains one object per cycle inside the A1 MEASURED
// delta-heap window: the per-op heap delta then climbs above the zero-alloc
// control + 2 B floor and the A1 headline check fails. The control MUST exit
// non-zero.
//
// ASCII-only.

import { effect, stats, createRegistry } from "@zakkster/lite-signal";
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

const NAME = "fleet-torture";

if (typeof globalThis.gc !== "function") {
    dieInfra("fleet-torture requires node --expose-gc (forced-GC brackets are the measurement)");
}

// --- the shape under test -----------------------------------------------------
//
// The demo-like Entity: P=4 signals (x, y, vx, vy), D=2 deriveds (speed reads
// vx+vy, mag reads x+y), E=1 effect over mag, L=0 locals. Node cost per member:
// P+L+D+E+1 = 8. Release frees exactly 8; the fleet registry is eager-sized for
// capacity x 8, so a churn never grows the pool.
const P = 4, L = 0, D = 2, E = 1;
const NODES_PER_MEMBER = P + L + D + E + 1;   // 8

function entMembers() {
    return [
        { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "y", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "vx", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "vy", decorator: pkg.reactive, value: () => 0 },
        { kind: "getter", key: "speed", decorator: pkg.derived, body: function () { return this.vx + this.vy; } },
        { kind: "getter", key: "mag", decorator: pkg.derived, body: function () { return this.x + this.y; } },
        { kind: "method", key: "onMove", decorator: pkg.reactiveEffect, body: function () { void this.mag; } },
    ];
}

// A fleet over a class BOUND to its own registry (PD-76): the bind callback
// returns a mock-emitter @reactiveHost({ registry }) class -- the exact path a
// transpiled decorated class drives. The inventory Factory sizes the registry
// (costOf on a scratch-bound probe of the SAME shape).
function makeFleet(cap) {
    const scratch = createRegistry({ maxNodes: 256 });
    const Probe = buildClass({
        name: "Ent",
        classDecorator: pkg.reactiveHost({ registry: scratch }),
        members: entMembers(),
    });
    return pkg.createFleet([[Probe, cap]], (reg) => buildClass({
        name: "Ent",
        classDecorator: pkg.reactiveHost({ registry: reg }),
        members: entMembers(),
    }));
}

const SCENARIO_BASE = conservationBaseline();

// ===============================================================================
// A1 -- the ship bar: GC budget + poolGrowths-0 + the delta-heap headline.
// A3 + A4 (direct probes) ride the same fleet before the measured window.
// ===============================================================================

{
    const CAP = 8;
    const fleet = makeFleet(CAP);

    // --- A3: releasing an acquired member frees EXACTLY P+L+D+E+1 nodes ---------
    {
        const before = fleet.registry.stats().activeNodes;    // 0 (all parked)
        const vm = fleet.acquire();
        const live = fleet.registry.stats().activeNodes;
        check(
            live - before === NODES_PER_MEMBER,
            () => "A3: acquire must add exactly " + NODES_PER_MEMBER + " nodes, added " + (live - before),
        );
        fleet.release(vm);
        const after = fleet.registry.stats().activeNodes;
        check(
            live - after === NODES_PER_MEMBER,
            () => "A3: release must free exactly " + NODES_PER_MEMBER + " nodes (P+L+D+E+1), freed " +
                (live - after) + " (live=" + live + " after=" + after + ")",
        );
        check(after === before, () => "A3: the parked slot holds zero nodes, activeNodes=" + after);
    }

    // --- A4: exhausted + foreign throws disturb NOTHING -------------------------
    {
        const held = [];
        for (let i = 0; i < CAP; i++) held.push(fleet.acquire());   // fill to capacity
        const beforeNodes = fleet.registry.stats().activeNodes;
        const beforeSize = fleet.size();
        const alien = {};
        for (let i = 0; i < 256; i++) {
            RUN.op = i;
            let exhausted = null;
            try { fleet.acquire(); } catch (e) { exhausted = e; }
            check(
                exhausted !== null && exhausted.name === "FleetExhaustedError",
                () => "A4: acquire at capacity must throw FleetExhaustedError, got " + (exhausted && exhausted.name),
            );
            let foreign = null;
            try { fleet.release(alien); } catch (e) { foreign = e; }
            check(
                foreign !== null && foreign.name === "FleetForeignMemberError",
                () => "A4: a foreign vm must throw FleetForeignMemberError, got " + (foreign && foreign.name),
            );
        }
        RUN.op = -1;
        check(
            fleet.registry.stats().activeNodes === beforeNodes,
            () => "A4: the cold throw storm moved activeNodes " + beforeNodes + " -> " +
                fleet.registry.stats().activeNodes,
        );
        check(
            fleet.size() === beforeSize,
            () => "A4: the cold throw storm moved size " + beforeSize + " -> " + fleet.size(),
        );
        for (const vm of held) fleet.release(vm);
        check(fleet.size() === 0, () => "A4: all members released, size=" + fleet.size());
    }

    // --- A1: 4096 acquire/release cycles, zero-alloc + poolGrowths 0 ------------
    const controlVm = fleet.acquire();        // stays LIVE: a pure zero-alloc read control
    const CYCLES = 4096;

    let sink = 0;
    const acquireReleaseCycle = (i) => {
        const vm = fleet.acquire();
        vm.x = i & 1023;
        const r = vm.mag | 0;
        fleet.release(vm);
        return r;
    };
    const controlRead = (i) => (controlVm.x | 0) + (i & 1);

    // Control minors, measured in THIS process (decision 0003 idiom), never a
    // hardcoded budget. maxMajor/maxPauseMs asserted on the control too.
    const controlSummary = await gcGate("fleet-a1-control", controlRead, {
        ops: CYCLES,
        warmup: CYCLES,
        maxMajor: 0,
        maxPauseMs: 4,
    });
    const MINOR_FLOOR = controlSummary.gc.minor;
    const MINOR_LIMIT = MINOR_FLOOR + 128;

    // The fleet registry's pool must not grow across the acquire/release window:
    // the free-list + slots + stamps are fixed at construction, and reinit pulls
    // engine nodes from the eager prealloc, so poolGrowths stays put.
    const growBase = fleet.stats().poolGrowths;

    const realSummary = await gcGate("fleet-a1-cycle", acquireReleaseCycle, {
        ops: CYCLES,
        warmup: CYCLES,
        maxMajor: 0,
        maxMinor: MINOR_LIMIT,
        maxPauseMs: 4,
    });

    check(
        fleet.stats().poolGrowths - growBase === 0,
        () => "A1: fleet-registry poolGrowths grew by " + (fleet.stats().poolGrowths - growBase) +
            " across the acquire/release window",
    );

    // The headline: delta-heap per acquire/release cycle, measured by SCALING at
    // N and 8N with forced-GC brackets. Under BREAK a fresh object is retained
    // every cycle inside the MEASURED window, so the per-op delta climbs off the
    // control floor and the check below fails.
    const leakSink = [];
    const doBreak = breakActive(NAME);
    function forceGc() { globalThis.gc(); globalThis.gc(); }
    function heapNow() { forceGc(); return process.memoryUsage().heapUsed; }
    function retainedWindow(work, n) {
        const a = heapNow();
        for (let i = 0; i < n; i++) work(i);
        const b = heapNow();
        return b - a;
    }

    const cycleWork = (i) => {
        sink += acquireReleaseCycle(i);
        if (doBreak) leakSink.push({ i });   // BREAK: retained forever
    };
    const controlWork = (i) => { sink += controlRead(i); };

    const N_SMALL = CYCLES;          // 4096
    const N_BIG = CYCLES * 8;        // 32768
    const retSmall = retainedWindow(cycleWork, N_SMALL);
    const retBig = retainedWindow(cycleWork, N_BIG);
    const perSmall = retSmall / N_SMALL;
    const perBig = retBig / N_BIG;
    const ctlBig = retainedWindow(controlWork, N_BIG) / N_BIG;

    // PD-45: "zero" is operational -- at or below the matched in-process
    // zero-alloc control, both ends forced-GC bracketed. +2 B is the forced-GC
    // noise-floor tolerance, never a widened budget.
    check(
        perBig <= ctlBig + 2,
        () => "A1 headline: delta-heap/cycle " + perBig.toFixed(3) + " B > control " +
            ctlBig.toFixed(3) + " B (+2 noise tolerance) at N=" + N_BIG +
            " (small-window N=" + N_SMALL + " was " + perSmall.toFixed(3) + " B/cyc)",
    );

    if (sink === -1 || leakSink.length === -1) console.log("unreachable");

    process.stdout.write(
        "torture: fleet-torture A1 cycles=" + CYCLES +
        " | gc major=" + realSummary.gc.major + " minor=" + realSummary.gc.minor +
        " (floor=" + MINOR_FLOOR + " limit=" + MINOR_LIMIT + ")" +
        " maxMs=" + realSummary.gc.maxMs.toFixed(2) +
        " | poolGrowths delta=" + (fleet.stats().poolGrowths - growBase) +
        " | delta-heap/cyc small(N=" + N_SMALL + ")=" + perSmall.toFixed(3) + "B" +
        " big(N=" + N_BIG + ")=" + perBig.toFixed(3) + "B ctl=" + ctlBig.toFixed(3) + "B\n",
    );

    fleet.release(controlVm);
    fleet.dispose();
}

// ===============================================================================
// A2 -- conservation over 1000 full fleet lifecycles (createFleet N=512 ->
// partial churn -> dispose): poolGrowths delta 0 per fleet, prefill-baseline
// return, a tracked sample member never outlives its fleet (lite-leak 0), and
// the DEFAULT registry never moves.
// ===============================================================================

{
    const LIFECYCLES = 1000;
    const POOL_N = 512;
    const CHURN = 64;                // partial churn per lifecycle

    const leaks = [];
    const warns = [];
    const tracker = createLeakTracker({
        name: NAME,
        onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
        onWarning: (w) => warns.push(w.kind + ":" + w.reason),
    });
    // The reactive owner tree (cascade orphans) is the surface the fleet owns;
    // the observer kernel guards a surface it does not patch, so it must stay
    // silent -- a warning would itself be a finding.
    tracker.registerKernel(createOwnerCascadeOrphanKernel());
    tracker.registerKernel(createObserverOrphanKernel());

    // Held-value-safe cleanup + audit options, allocated ONCE. `release` captures
    // nothing; the tag passed per-cycle is a detached primitive.
    function release() {}
    const AUDIT = { audit: true };

    const held = new Array(CHURN);
    let sink = 0;
    for (let L2 = 0; L2 < LIFECYCLES; L2++) {
        RUN.op = L2;
        const fleet = makeFleet(POOL_N);

        // Fresh fleet: eager prefill parked all N members -> zero live nodes.
        check(
            fleet.registry.stats().activeNodes === 0,
            () => "A2: fresh fleet activeNodes " + fleet.registry.stats().activeNodes + " != 0 at lifecycle " + L2,
        );
        const growBase = fleet.stats().poolGrowths;

        // Partial churn: acquire CHURN members, use each, then release.
        for (let k = 0; k < CHURN; k++) held[k] = fleet.acquire();

        // Track a sample member from inside a DEFAULT-registry effect -> owner
        // captured, onCleanup(untrack) registered. Deterministic reclaim: the
        // sample is disposed with the fleet, then the effect is stopped.
        const sample = held[0];
        const sampleStop = effect(function () { tracker.track(sample, release, L2 & 255, AUDIT); });

        for (let k = 0; k < CHURN; k++) {
            const vm = held[k];
            vm.x = (L2 + k) & 1023;
            sink = (sink + (vm.mag | 0)) | 0;
        }

        // The fleet's own bookkeeping (Int32Array free-list, slots, stamps) never
        // grows; nor does the eager-sized registry pool.
        check(
            fleet.stats().poolGrowths - growBase === 0,
            () => "A2: poolGrowths grew by " + (fleet.stats().poolGrowths - growBase) + " at lifecycle " + L2,
        );

        for (let k = 0; k < CHURN; k++) fleet.release(held[k]);

        // Back to the exact prefill baseline before dispose.
        check(
            fleet.registry.stats().activeNodes === 0,
            () => "A2: post-churn activeNodes " + fleet.registry.stats().activeNodes + " != 0 at lifecycle " + L2,
        );

        fleet.dispose();               // disposes every parked member + destroys the registry
        sampleStop();                  // effect cleanup -> untrack -> size decrements

        for (let k = 0; k < CHURN; k++) held[k] = null;   // drop refs
    }
    RUN.op = -1;
    if (sink === -1) console.log("unreachable");

    await settle();
    globalThis.gc();
    await settle();

    const live = tracker.size();
    const findings = tracker.audit();

    process.stdout.write(
        "torture: fleet-torture A2 lifecycles=" + LIFECYCLES + " N=" + POOL_N + " churn=" + CHURN +
        " | leak size=" + live + "/0 findings=" + findings.length + " warnings=" + warns.length + "\n",
    );

    check(warns.length === 0, () => "A2: kernel warnings emitted: " + warns.join(","));
    check(
        findings.length === 0,
        () => "A2: audit findings: " + findings.map((f) => f.kind + ":" + f.reason).join(","),
    );
    check(leaks.length === 0, () => "A2: leak callbacks fired: " + leaks.join(","));
    check(
        live === 0,
        () => "A2: tracker retained " + live + " handle(s) after settle -- a member outlived its fleet",
    );
}

// --- overall conservation: the DEFAULT registry never moved -------------------

assertConserved(SCENARIO_BASE, "fleet-torture final");

pass(NAME);
