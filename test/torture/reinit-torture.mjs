// test/torture/reinit-torture.mjs -- node --expose-gc test/torture/reinit-torture.mjs
//
// POOLED-REINIT torture (PLAN-S6 T6, group: semantic). Proves the S6-A1/A2/A3
// ship-bar assertions for `releaseReactive`/`reinitReactive` (PD-42(b)/PD-44,
// decisions/0010 + 0011) with MEASURED numbers, never invented ones:
//
//   S6-A1 (the ship bar) -- 4096 acquire/release cycles at the CHURN shape
//     (P=4, D=2, E=1, bench/scenarios/churn.mjs:28): gc.major === 0 STRICT,
//     maxPauseMs <= 4.0 STRICT, minors CONTROL-RELATIVE at an in-process
//     zero-alloc control + 128 (zerogc-torture.mjs:79-82 idiom via gcGate) --
//     AND the headline, delta-heap per acquire/release cycle at/below the same
//     in-process zero-alloc control's per-op delta, both windows bracketed by
//     forced GC (spikes/reinit-contract.mjs Q2(b) scaling idiom: measure at N
//     and 8N -- a real leak holds its per-cycle byte figure, fixed forced-GC
//     endpoint noise amortizes toward zero).
//   S6-A2 (retention) -- over the SAME 4096-cycle budget at N=512 live
//     instances tracked by lite-leak, the AUTHORITY is FINALIZATION: each
//     instance is tracked OUTSIDE any owner with a shared NOOP cleanup + numeric
//     tag (held-value-safe), NEVER untracked, and its pool-array scaffolding ref
//     is cleared at teardown, so the tracker holds it only WEAKLY. After a HARD
//     settle the finalization residual tracker.size() <= RES = max(16, N/1000);
//     an instance really reclaimed on dispose is collected, one that leaked is
//     not. The F-0 pool floor (activeNodes at its pre-cycle baseline, poolGrowths
//     delta 0, ledger balanced) holds throughout -- the INDEPENDENT node oracle
//     -- and a direct measurement shows a PARKED instance holds ZERO engine nodes
//     (activeNodes delta across releaseReactive == -(P+D+E+1)).
//     (An earlier version tracked from inside an effect and untracked on stop() --
//     VARIANT-2 VACUOUS: stop() drove size() to 0 by construction. Fixed here.)
//   S6-A3 (the nine-transition lattice) -- all nine states pinned with
//     message-thunk assertions: live->park->reinit->live (values reset,
//     initials override honored), live->dispose (unchanged from 1.0.0),
//     park->dispose (lands DISPOSED, idempotent false on the second call),
//     park->park (idempotent false), and the five NAMED reinitReactive throws
//     (on live / disposed / frozen / unwired / non-reactive) -- zero silent
//     no-ops. Every parked touch throws with "parked" in the message (never
//     "disposed"); boxOf/rootOf agree.
//
// TORTURE_BREAK=reinit-torture leaks one UN-PARKED instance every 1024 cycles
// during the S6-A2 retention churn (churn-soak.mjs:156 pattern): a fresh
// instance is constructed and retained forever -- never released, never disposed.
// Its 8 live nodes stay off the pool floor permanently, so the very next F-0
// checkpoint (every 256 cycles) fails. The control MUST exit non-zero.
//
// TORTURE_LEAK=1 pins every disposed pool instance in a module sink so it can
// NEVER finalize -> residual ~= N -> the S6-A2 finalization gate trips RED
// (the engine-node oracles stay green: the instances are still disposed).
//
// ASCII-only.

import { stats, createRegistry } from "@zakkster/lite-signal";
import { createLeakTracker } from "@zakkster/lite-leak";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, randInt, pass,
    conservationBaseline, assertConserved, gcGate, dieInfra,
    retainLeak, residualCeiling, settleHard,
} from "./helpers/harness.mjs";

const NAME = "reinit-torture";

if (typeof globalThis.gc !== "function") {
    dieInfra("reinit-torture requires node --expose-gc (forced-GC brackets are the measurement)");
}

// --- the shapes under test ----------------------------------------------------

// CHURN shape (bench/scenarios/churn.mjs:28): P=4, D=2, E=1, +1 R-A anchor =
// P+D+E+1 = 8 engine nodes per live instance.
const P = 4, D = 2, E = 1;
const NODES_PER_INSTANCE = P + D + E + 1;

function churnMembers() {
    const members = [];
    for (let i = 0; i < P; i++) {
        members.push({ kind: "accessor", key: "s" + i, decorator: pkg.reactive, value: () => 0 });
    }
    members.push({ kind: "getter", key: "d0", decorator: pkg.derived, body: function () { return this.s0 + this.s1; } });
    members.push({ kind: "getter", key: "d1", decorator: pkg.derived, body: function () { return this.s2 + this.s3; } });
    members.push({ kind: "method", key: "e0", decorator: pkg.reactiveEffect, body: function () { void this.d0; } });
    return members;
}

function buildChurnClass(name) {
    return buildClass({ name, classDecorator: pkg.reactiveHost, members: churnMembers() });
}

// Small lattice shape for S6-A3 (P=2, D=1, E=1): enough surface to exercise
// signal reset, derived recompute, and effect re-fire on every transition.
function buildLatticeClass() {
    return buildClass({
        name: "LatticeVM",
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "a", decorator: pkg.reactive, value: () => 10 },
            { kind: "accessor", key: "b", decorator: pkg.reactive, value: () => 20 },
            { kind: "getter", key: "sum", decorator: pkg.derived, body: function () { return this.a + this.b; } },
            { kind: "method", key: "onSum", decorator: pkg.reactiveEffect, body: function () { void this.sum; } },
        ],
    });
}

const SCENARIO_BASE = conservationBaseline();

// ===============================================================================
// S6-A1 -- the ship bar: GC budget + the delta-heap headline.
// ===============================================================================

{
    const Churn = buildChurnClass("ChurnA1");
    const vm = new Churn();
    const controlVm = new Churn();     // never released; pure zero-alloc read control

    const CYCLES = 4096;

    let sink = 0;
    const acquireReleaseCycle = (i) => {
        pkg.releaseReactive(vm);
        pkg.reinitReactive(vm);
        vm.s0 = i & 1023;
        return vm.d0;
    };
    const controlRead = (i) => controlVm.s0 + (i & 1);

    // Control: minors provoked by a known zero-alloc body, measured in THIS
    // process (decision 0003 / zerogc-torture.mjs:69-82) -- never a hardcoded
    // budget. maxMajor/maxPauseMs are asserted on the control too (belt and
    // suspenders: a control that itself majors would poison the derived limit).
    const controlSummary = await gcGate("reinit-a1-control", controlRead, {
        ops: CYCLES,
        warmup: CYCLES,
        maxMajor: 0,
        maxPauseMs: 4,
    });
    const MINOR_FLOOR = controlSummary.gc.minor;
    const MINOR_LIMIT = MINOR_FLOOR + 128;

    // The real lane: exactly 4096 acquire/release cycles. The first call inside
    // WARMUP pays the one-time prebuildClosures() allocation (0011: built
    // lazily at first releaseReactive); every call inside the MEASURED window
    // re-registers that same closure set with zero new allocation (0010 Q3).
    const realSummary = await gcGate("reinit-a1-cycle", acquireReleaseCycle, {
        ops: CYCLES,
        warmup: CYCLES,
        maxMajor: 0,
        maxMinor: MINOR_LIMIT,
        maxPauseMs: 4,
    });

    // The headline: delta-heap per acquire/release cycle, measured by SCALING
    // (spikes/reinit-contract.mjs Q2(b)) -- forced-GC endpoint noise is a FIXED
    // per-window cost; a real per-cycle retention leak holds its per-cycle byte
    // figure as the window grows. vm[CLOSURES] is already warm from the gcGate
    // calls above, so this window measures steady-state reuse only.
    function forceGc() { globalThis.gc(); globalThis.gc(); }
    function heapNow() { forceGc(); return process.memoryUsage().heapUsed; }
    function retainedWindow(work, n) {
        const a = heapNow();
        for (let i = 0; i < n; i++) work(i);
        const b = heapNow();
        return b - a;
    }

    const N_SMALL = CYCLES;          // 4096
    const N_BIG = CYCLES * 8;        // 32768
    const retSmall = retainedWindow((i) => { sink += acquireReleaseCycle(i); }, N_SMALL);
    const retBig = retainedWindow((i) => { sink += acquireReleaseCycle(i); }, N_BIG);
    const perSmall = retSmall / N_SMALL;
    const perBig = retBig / N_BIG;
    const ctlBig = retainedWindow((i) => { sink += controlRead(i); }, N_BIG) / N_BIG;

    // PD-45: "zero" is operational -- at or below the matched in-process
    // zero-alloc control, both ends forced-GC bracketed. +2 B is the same
    // forced-GC noise-floor tolerance decisions/0010's accepted Q2 measurement
    // used (never a widened budget -- it is the measurement's own resolution).
    check(
        perBig <= ctlBig + 2,
        () => "S6-A1 headline: delta-heap/cycle " + perBig.toFixed(3) + " B > control " +
            ctlBig.toFixed(3) + " B (+2 noise tolerance) at N=" + N_BIG +
            " (small-window N=" + N_SMALL + " was " + perSmall.toFixed(3) + " B/cyc)",
    );

    if (sink === -1) console.log("unreachable");

    process.stdout.write(
        "torture: reinit-torture S6-A1 cycles=" + CYCLES +
        " | gc major=" + realSummary.gc.major + " minor=" + realSummary.gc.minor +
        " (floor=" + MINOR_FLOOR + " limit=" + MINOR_LIMIT + ")" +
        " maxMs=" + realSummary.gc.maxMs.toFixed(2) +
        " | delta-heap/cyc small(N=" + N_SMALL + ")=" + perSmall.toFixed(3) + "B" +
        " big(N=" + N_BIG + ")=" + perBig.toFixed(3) + "B ctl=" + ctlBig.toFixed(3) + "B\n",
    );

    pkg.disposeReactive(vm);
    pkg.disposeReactive(controlVm);
}

// ===============================================================================
// S6-A2 -- retention: N=512 live instances, 4096 acquire/release cycles.
// ===============================================================================

{
    const POOL_N = 512;
    const RETENTION_CYCLES = 4096;
    const LEAK_EVERY = 1024;          // BREAK cadence
    const CHECK_MASK = 255;           // F-0 checkpoint every 256 cycles
    const EXPECTED_NODES = POOL_N * NODES_PER_INSTANCE;   // 512 x 8 == 4096
    const RES = residualCeiling(POOL_N);                  // finalization residual ceiling
    const RETAIN = retainLeak();      // RED control: pin every disposed instance
    const __leakSink = [];

    // A DEDICATED registry (fleet-soak.mjs pattern): 512 live instances x 8
    // nodes == 4096 exceeds the default registry's 1024-node ceiling, so F-0
    // is asserted against THIS registry's own stats(), never the global
    // `stats()` import (which would silently read the wrong population).
    const reg = createRegistry({ maxNodes: EXPECTED_NODES + 1024, onCapacityExceeded: "throw" });
    const Churn = buildClass({
        name: "ChurnA2",
        classDecorator: pkg.reactiveHost({ registry: reg }),
        members: churnMembers(),
    });

    const warns = [];
    // PLAIN tracker: no kernels, no onLeak (finalization is the release path, so a
    // held-but-uncollected object must not be flagged and onLeak fires on
    // collection). onWarning stays -- a warning is a real finding.
    const tracker = createLeakTracker({
        name: NAME,
        onWarning: (w) => warns.push(w.kind + ":" + w.reason),
    });

    // Held-value-safe cleanup: `release` captures nothing, the tag is a detached
    // primitive.
    function release() {}

    const pool = new Array(POOL_N);
    for (let i = 0; i < POOL_N; i++) {
        const inst = new Churn();
        // AUTHORITY: track OUTSIDE any owner (module-scope loop -> getOwner()
        // undefined) so lite-leak arms NO auto-untrack; finalization is the sole
        // release path. Never untracked.
        tracker.track(inst, release, i & 255);
        pool[i] = inst;
    }

    // Sanity: the standing pool is exactly the expected node count.
    {
        const s = reg.stats();
        check(
            s.activeNodes === EXPECTED_NODES,
            () => "S6-A2 pool build: activeNodes " + s.activeNodes + " != expected " + EXPECTED_NODES,
        );
    }

    // Pre-cycle baseline: taken with all 512 pool instances LIVE, before the
    // acquire/release churn begins.
    const poolBase = { activeNodes: reg.stats().activeNodes, poolGrowths: reg.stats().poolGrowths };

    // Control retention: BREAK leaks (retained forever, never parked/disposed).
    // Its 8 live nodes stay off the pool floor -> the F-0 checkpoint (the
    // independent node oracle) catches it.
    const leakedVms = [];

    let rsink = 0;
    for (let i = 0; i < RETENTION_CYCLES; i++) {
        RUN.op = i;
        const leak = breakActive(NAME) && (i % LEAK_EVERY === 0);

        if (leak) {
            const extra = new Churn();
            extra.s0 = 1;                   // wire + touch
            leakedVms.push(extra);          // retained -> 8 live nodes off the pool floor
        } else {
            const idx = randInt(POOL_N);
            const inst = pool[idx];
            pkg.releaseReactive(inst);
            pkg.reinitReactive(inst);
            inst.s0 = i & 1023;
            rsink = (rsink + inst.d0) | 0;
        }

        if ((i & CHECK_MASK) === 0) {
            const s = reg.stats();
            check(
                s.activeNodes === poolBase.activeNodes,
                () => "S6-A2 pre-cycle floor: activeNodes " + s.activeNodes + " != baseline " +
                    poolBase.activeNodes + " at cycle " + i,
            );
            check(
                s.poolGrowths - poolBase.poolGrowths === 0,
                () => "S6-A2: poolGrowths grew by " + (s.poolGrowths - poolBase.poolGrowths) + " at cycle " + i,
            );
            check(
                s.totalAllocations - s.totalDisposals === s.activeNodes,
                () => "S6-A2: ledger " + (s.totalAllocations - s.totalDisposals) +
                    " != activeNodes " + s.activeNodes + " at cycle " + i,
            );
        }
    }
    if (rsink === -1) console.log("unreachable");
    RUN.op = -1;

    // Post-cycle: the pool floor one more time, explicitly, at the exact
    // pre-cycle baseline (S6-A2's own wording).
    {
        const s = reg.stats();
        check(
            s.activeNodes === poolBase.activeNodes,
            () => "S6-A2 post-cycle: activeNodes " + s.activeNodes + " != baseline " + poolBase.activeNodes,
        );
        check(
            s.poolGrowths - poolBase.poolGrowths === 0,
            () => "S6-A2 post-cycle: poolGrowths grew by " + (s.poolGrowths - poolBase.poolGrowths),
        );
        check(
            s.totalAllocations - s.totalDisposals === s.activeNodes,
            () => "S6-A2 post-cycle: ledger " + (s.totalAllocations - s.totalDisposals) +
                " != activeNodes " + s.activeNodes,
        );
    }

    // Direct measurement: a PARKED instance holds ZERO engine nodes.
    const probe = pool[0];
    const beforePark = reg.stats().activeNodes;
    const released = pkg.releaseReactive(probe);
    check(released === true, () => "S6-A2 direct: releaseReactive(probe) must return true");
    const afterPark = reg.stats().activeNodes;
    check(
        beforePark - afterPark === NODES_PER_INSTANCE,
        () => "S6-A2 direct: PARKED must free exactly " + NODES_PER_INSTANCE + " nodes, freed " +
            (beforePark - afterPark) + " (before=" + beforePark + " after=" + afterPark + ")",
    );
    pkg.reinitReactive(probe);
    const afterRevive = reg.stats().activeNodes;
    check(
        afterRevive === beforePark,
        () => "S6-A2 direct: reinitReactive must restore the exact node count, before=" +
            beforePark + " after-revive=" + afterRevive,
    );

    // Final teardown: dispose the whole pool (every instance is live at this
    // point) and CLEAR its scaffolding ref, so a properly-disposed instance's
    // only strong ref is the tracker's WeakRef -> it becomes collectable and the
    // finalization residual falls. The tracker is NEVER untracked.
    for (let i = 0; i < POOL_N; i++) {
        pkg.disposeReactive(pool[i]);
        if (RETAIN) __leakSink.push(pool[i]);   // RED: pin the disposed object -> never finalizes
        pool[i] = null;                          // clear scaffolding
    }
    // Under BREAK, leakedVms is deliberately left un-disposed -- that is the
    // sabotage under test (caught by the F-0 checkpoint above).

    // The dedicated registry is back to its pre-fleet baseline (activeNodes 0)
    // on a clean (non-BREAK) run; a BREAK run leaves the leaked instances'
    // nodes live, which the tracker-size gate below also catches.
    {
        const s = reg.stats();
        check(
            breakActive(NAME) || s.activeNodes === 0,
            () => "S6-A2 teardown: dedicated registry activeNodes " + s.activeNodes + " != 0",
        );
    }

    await settleHard(() => tracker.size(), RES);
    // Keep the RED sink + leaked set live ACROSS the settle (a module array
    // written-but-never-read after the loop is liveness-elided by V8, masking the
    // pin). This read forces both to survive every gc() round above.
    if (__leakSink.length === -1 || leakedVms.length === -1) console.log("unreachable");

    const live = tracker.size();
    const findings = tracker.audit();

    process.stdout.write(
        "torture: reinit-torture S6-A2 pool=" + POOL_N + " cycles=" + RETENTION_CYCLES +
        " | AUTHORITY residual size=" + live + "/" + RES + " findings=" + findings.length +
        " warnings=" + warns.length +
        " | parked-node-delta=" + (beforePark - afterPark) + " (expect " + NODES_PER_INSTANCE + ")\n",
    );

    check(warns.length === 0, () => "S6-A2: kernel warnings emitted: " + warns.join(","));
    check(
        findings.length === 0,
        () => "S6-A2: audit findings: " + findings.map((f) => f.kind + ":" + f.reason).join(","),
    );
    check(
        live <= RES,
        () => "S6-A2: AUTHORITY finalization residual size()=" + live + " > " + RES +
            " -- an instance outlived its disposal",
    );
}

// ===============================================================================
// S6-A3 -- the nine-transition lattice, each pinned with a message-thunk check.
// ===============================================================================

{
    const LatticeVM = buildLatticeClass();

    function throwsOf(fn) {
        try { fn(); return null; } catch (e) { return e; }
    }

    // T1 -- live -> park -> reinit -> live (values reset; initials honored).
    {
        const lv = new LatticeVM();
        lv.a = 999;
        check(lv.a === 999, () => "T1 setup: mutation did not apply before park");

        const released = pkg.releaseReactive(lv);
        check(released === true, () => "T1 live->park: releaseReactive must return true on first release");

        let e = throwsOf(() => lv.a);
        check(
            e !== null && e instanceof pkg.ReactiveDisposedError && /parked/.test(e.message),
            () => "T1: parked READ of `a` must throw ReactiveDisposedError naming parked, got " +
                (e && e.constructor.name + ": " + e.message),
        );
        e = throwsOf(() => { lv.a = 1; });
        check(
            e !== null && /parked/.test(e.message),
            () => "T1: parked WRITE of `a` must throw a parked message, got " + (e && e.message),
        );
        e = throwsOf(() => lv.sum);
        check(
            e !== null && /parked/.test(e.message),
            () => "T1: parked derived `sum` touch must throw a parked message, got " + (e && e.message),
        );
        e = throwsOf(() => pkg.boxOf(lv, "a"));
        check(
            e !== null && e instanceof pkg.ReactiveDisposedError && /parked/.test(e.message),
            () => "T1: boxOf on a parked instance must throw a parked message, got " + (e && e.message),
        );
        e = throwsOf(() => pkg.rootOf(lv));
        check(
            e !== null && e instanceof pkg.ReactiveDisposedError && /parked/.test(e.message) && e.key === "<root>",
            () => "T1: rootOf on a parked instance must throw a parked message naming <root>, got " +
                (e && e.message),
        );

        const revived = pkg.reinitReactive(lv);
        check(revived === lv, () => "T1: reinitReactive must return the SAME vm");
        check(lv.a === 10, () => "T1: reinitReactive must reset `a` to its field-initial (10), got " + lv.a);
        check(lv.b === 20, () => "T1: reinitReactive must reset `b` to its field-initial (20), got " + lv.b);
        check(lv.sum === 30, () => "T1: derived `sum` must recompute over the reset values, got " + lv.sum);

        // initials override: non-overridden keys still reset to their own initial.
        pkg.releaseReactive(lv);
        pkg.reinitReactive(lv, { a: 555 });
        check(lv.a === 555, () => "T1 initials: overridden key `a` must take the caller value, got " + lv.a);
        check(lv.b === 20, () => "T1 initials: non-overridden key `b` must still reset to its own initial, got " + lv.b);

        pkg.disposeReactive(lv);
    }

    // T2 -- live -> dispose, unchanged from 1.0.0.
    {
        const lv = new LatticeVM();
        const first = pkg.disposeReactive(lv);
        check(first === true, () => "T2 live->dispose: first dispose must return true");
        const second = pkg.disposeReactive(lv);
        check(second === false, () => "T2 live->dispose: second dispose must be idempotent false");
        const e = throwsOf(() => lv.a);
        check(
            e !== null && e instanceof pkg.ReactiveDisposedError && !/parked/.test(e.message),
            () => "T2: a disposed touch must throw the DISPOSED message (not parked), got " + (e && e.message),
        );
    }

    // T3 -- park -> dispose lands DISPOSED, idempotent false on the second call.
    {
        const lv = new LatticeVM();
        pkg.releaseReactive(lv);
        const d1 = pkg.disposeReactive(lv);
        check(d1 === true, () => "T3 park->dispose: dispose-of-parked must return true and land DISPOSED");
        const e = throwsOf(() => lv.a);
        check(
            e !== null && !/parked/.test(e.message),
            () => "T3: after dispose-of-parked, touch must throw the DISPOSED message (not parked), got " +
                (e && e.message),
        );
        const d2 = pkg.disposeReactive(lv);
        check(d2 === false, () => "T3 park->dispose: second dispose must be idempotent false");
    }

    // T4 -- park -> park, idempotent false.
    {
        const lv = new LatticeVM();
        const r1 = pkg.releaseReactive(lv);
        check(r1 === true, () => "T4 park->park: first release must return true");
        const r2 = pkg.releaseReactive(lv);
        check(r2 === false, () => "T4 park->park: second release (already parked) must be idempotent false");
        const e = throwsOf(() => lv.a);
        check(
            e !== null && /parked/.test(e.message),
            () => "T4: instance must remain parked (still throws parked) after the idempotent no-op",
        );
        pkg.reinitReactive(lv);
        pkg.disposeReactive(lv);
    }

    // T5 -- reinit-on-live: NAMED throw.
    {
        const lv = new LatticeVM();
        const e = throwsOf(() => pkg.reinitReactive(lv));
        check(
            e !== null && /is live/.test(e.message),
            () => "T5 reinit-on-live: must throw a NAMED error naming the live state, got " + (e && e.message),
        );
        pkg.disposeReactive(lv);
    }

    // T6 -- reinit-on-disposed: NAMED throw.
    {
        const lv = new LatticeVM();
        pkg.disposeReactive(lv);
        const e = throwsOf(() => pkg.reinitReactive(lv));
        check(
            e !== null && /was disposed \(terminal\)/.test(e.message),
            () => "T6 reinit-on-disposed: must throw a NAMED error, got " + (e && e.message),
        );
    }

    // T7 -- reinit-on-frozen: NAMED throw.
    {
        const lv = new LatticeVM();
        pkg.releaseReactive(lv);
        Object.freeze(lv);
        const e = throwsOf(() => pkg.reinitReactive(lv));
        check(
            e !== null && e instanceof TypeError && /frozen/.test(e.message),
            () => "T7 reinit-on-frozen: must throw a NAMED TypeError, got " + (e && e.message),
        );
        // A frozen PARKED instance holds zero engine nodes (already cascaded at
        // release); nothing further to tear down, no F-0 impact left behind.
    }

    // T8 -- reinit-on-unwired: NAMED throw (mid-construction, mirrors 06-dispose's
    // "dispose during construction" probe).
    {
        let capturedError = null;
        const C8 = buildClass({
            name: "UnwiredReinit",
            classDecorator: pkg.reactiveHost,
            members: [
                { kind: "accessor", key: "v", decorator: pkg.reactive, value: () => 0 },
                {
                    kind: "field",
                    key: "boom",
                    value: function () {
                        try { pkg.reinitReactive(this); } catch (e) { capturedError = e; }
                        return 0;
                    },
                },
            ],
        });
        const inst = new C8();
        check(
            capturedError !== null && /not wired/.test(capturedError.message),
            () => "T8 reinit-on-unwired: must throw a NAMED error mid-construction, got " +
                (capturedError && capturedError.message),
        );
        pkg.disposeReactive(inst);
    }

    // T9 -- reinit-on-non-reactive: NAMED throw.
    {
        const e = throwsOf(() => pkg.reinitReactive({}));
        check(
            e !== null && /not a reactive instance/.test(e.message),
            () => "T9 reinit-on-non-reactive: must throw a NAMED error, got " + (e && e.message),
        );
    }

    process.stdout.write("torture: reinit-torture S6-A3 lattice 9/9 transitions pinned\n");
}

// --- overall conservation: everything this scenario built is torn down -------

assertConserved(SCENARIO_BASE, "reinit-torture final");

pass(NAME);
