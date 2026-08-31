// test/torture/localto-torture.mjs -- node --expose-gc test/torture/localto-torture.mjs
//
// @localTo torture (PLAN-S8 T9, group: semantic, floor 1.5.0). Proves the 0014
// contract's ship-bar assertions for the localTo accessor pair (makeLocalGet /
// makeLocalSet, the seen-slot compare-on-read law) with MEASURED numbers, never
// invented ones:
//
//   S8-A2 (the read/write hot bar) -- 1e6 alternating upstream-move/read cycles
//     + 1e6 local-write/read cycles on the PLAIN path (not inside any effect):
//     gc.major === 0 STRICT, maxPauseMs <= 4.0 STRICT, minors CONTROL-RELATIVE
//     at an in-process zero-alloc control + 128 (via gcGate), and the headline
//     delta-heap per combined cycle at/below the same control + 2 B (forced-GC
//     noise floor) measured at N and 8N (a real per-op leak holds its per-op
//     byte figure as the window grows; fixed forced-GC endpoint noise amortizes
//     toward zero).
//   S8-A6 (the interleave lattice) -- upstream moves and local writes
//     interleaved with derived reads, the 0014 lattice pinned at checkpoints:
//     an override survives a NON-moving upstream, a move RESETS the read, and
//     THE SHIPPED ABA CONTRACT (upstream A -> local write X -> upstream B ->
//     upstream returns to an equals-A value -> the read shows the STALE LOCAL X)
//     asserted verbatim, plus the coarse-equals override-survival case.
//   S8-A3 (pooled park/reinit retention) -- 4096 release/reinit cycles at N=512
//     live instances tracked by lite-leak, the AUTHORITY being FINALIZATION: each
//     instance is tracked OUTSIDE any owner with a shared NOOP cleanup + numeric
//     tag (held-value-safe), NEVER untracked, and its pool-array scaffolding ref
//     is cleared at teardown, so after a HARD settle the finalization residual
//     tracker.size() <= RES = max(16, N/1000); the F-0 pool floor (activeNodes at
//     baseline, poolGrowths delta 0, ledger balanced) holds throughout as the
//     INDEPENDENT node oracle; and a direct probe shows release frees EXACTLY
//     P+L+D+E+1 nodes per instance. (An earlier version tracked from inside an
//     effect and untracked on stop() -- VARIANT-2 VACUOUS: stop() drove size()
//     to 0 by construction. Fixed here to finalization authority.)
//   S8-A4/A5 (the tracking shape) -- forEachSource on a derived reading ONE
//     local yields EXACTLY 2 source descriptors (upstream edge + local box edge);
//     1e5 localTo reads inside a recomputing derived emit 0 node-create and 0
//     node-dispose opcodes (onGraphMutation opcodes 1 and 2), proving the read
//     path is pure -- legal inside any @derived compute.
//
// TORTURE_BREAK=localto-torture retains one object per reset-storm cycle inside
// the MEASURED delta-heap window: the per-op heap delta then climbs above the
// zero-alloc control + 2 B floor and the S8-A2 headline check fails. The control
// MUST exit non-zero.
//
// TORTURE_LEAK=1 pins every disposed pool instance (S8-A3) in a module sink so it
// can NEVER finalize -> residual ~= N -> the S8-A3 finalization gate trips RED
// (the engine-node oracles stay green: the instances are still disposed).
//
// ASCII-only.

import {
    stats, createRegistry, forEachSource, onGraphMutation,
} from "@zakkster/lite-signal";
import { createLeakTracker } from "@zakkster/lite-leak";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, randInt, pass,
    conservationBaseline, assertConserved, gcGate, dieInfra,
    retainLeak, residualCeiling, settleHard,
} from "./helpers/harness.mjs";

const NAME = "localto-torture";

if (typeof globalThis.gc !== "function") {
    dieInfra("localto-torture requires node --expose-gc (forced-GC brackets are the measurement)");
}

// --- the shape under test -----------------------------------------------------
//
// P=4 signals (s0..s3), L=2 locals -- `draft` carries an initializer (starts 0,
// the @trackedReset flavor keyed on s0) and `mirror` omits one (follows s1 from
// wiring, the @localCopy flavor). D=2 deriveds, EACH reading a local (dLocal
// reads draft -- purity-in-compute; dMix reads mirror + s3). E=1 effect over
// dMix (kept OFF the s0/draft storm path so the S8-A2 lanes measure a pure
// read/write, no effect re-fire). Node cost per instance: P+L+D+E+1 = 10.
const P = 4, L = 2, D = 2, E = 1;
const NODES_PER_INSTANCE = P + L + D + E + 1;   // 4 + 2 + 2 + 1 + 1 = 10

function localMembers(pk) {
    return [
        { kind: "accessor", key: "s0", decorator: pk.reactive, value: () => 0 },
        { kind: "accessor", key: "s1", decorator: pk.reactive, value: () => 0 },
        { kind: "accessor", key: "s2", decorator: pk.reactive, value: () => 0 },
        { kind: "accessor", key: "s3", decorator: pk.reactive, value: () => 0 },
        // draft: @trackedReset (initializer present -> starts at 0, resets to s0
        // on the first upstream move).
        { kind: "accessor", key: "draft", decorator: pk.localTo((self) => self.s0), value: () => 0 },
        // mirror: @localCopy (no initializer -> follows s1 from wiring).
        { kind: "accessor", key: "mirror", decorator: pk.localTo((self) => self.s1) },
        // dLocal READS a local (draft) -- proves a localTo read is legal in a compute.
        { kind: "getter", key: "dLocal", decorator: pk.derived, body: function () { return this.draft + 1; } },
        { kind: "getter", key: "dMix", decorator: pk.derived, body: function () { return this.mirror + this.s3; } },
        // effect tracks dMix ONLY: the s0/draft storm never re-fires it.
        { kind: "method", key: "e0", decorator: pk.reactiveEffect, body: function () { void this.dMix; } },
    ];
}

function buildLocalClass(name, pk) {
    return buildClass({ name, classDecorator: pk.reactiveHost, members: localMembers(pk) });
}

function buildLocalClassOn(name, reg) {
    return buildClass({
        name,
        classDecorator: pkg.reactiveHost({ registry: reg }),
        members: localMembers(pkg),
    });
}

const SCENARIO_BASE = conservationBaseline();

// ===============================================================================
// S8-A2 -- the RESET STORM: 1e6 move/read + 1e6 write/read, plain path.
// ===============================================================================

{
    const Local = buildLocalClass("LocalStorm", pkg);
    const vm = new Local();
    const controlVm = new Local();     // never mutated except s0; zero-alloc control

    const HOT = 1000000;               // 1e6, the A2 lane size

    // The two hot bodies. move/read: mutate the upstream then read the local
    // (the reset path); write/read: override the local then read it back (the
    // override path). Both run OUTSIDE any effect -> makeLocalSet takes its
    // plain-code branch (reg.isTracking() === false), a zero-alloc source.call.
    let sink = 0;
    const moveReadCycle = (i) => { vm.s0 = i & 1023; return vm.draft | 0; };
    const writeReadCycle = (i) => { vm.draft = i & 1023; return vm.draft | 0; };
    const controlRead = (i) => controlVm.s0 + (i & 1);

    // Control minors, measured in THIS process (decision 0003 / zerogc idiom) --
    // never a hardcoded budget. maxMajor/maxPauseMs asserted on the control too.
    const controlSummary = await gcGate("localto-a2-control", controlRead, {
        ops: HOT,
        warmup: HOT,
        maxMajor: 0,
        maxPauseMs: 4,
    });
    const MINOR_FLOOR = controlSummary.gc.minor;
    const MINOR_LIMIT = MINOR_FLOOR + 128;

    const readSummary = await gcGate("localto-a2-move-read", moveReadCycle, {
        ops: HOT,
        warmup: HOT,
        maxMajor: 0,
        maxMinor: MINOR_LIMIT,
        maxPauseMs: 4,
    });
    const writeSummary = await gcGate("localto-a2-write-read", writeReadCycle, {
        ops: HOT,
        warmup: HOT,
        maxMajor: 0,
        maxMinor: MINOR_LIMIT,
        maxPauseMs: 4,
    });

    // The headline: delta-heap per combined (move/read + write/read) cycle,
    // measured by SCALING at N and 8N with forced-GC brackets. Under BREAK a
    // fresh object is retained every cycle inside the MEASURED window, so the
    // per-op delta climbs off the control floor and the check below fails.
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

    const combinedCycle = (i) => {
        sink += moveReadCycle(i);
        sink += writeReadCycle(i);
        if (doBreak) leakSink.push({ i });   // BREAK: retained forever
    };
    const controlCycle = (i) => { sink += controlRead(i); };

    const N_SMALL = HOT;             // 1e6
    const N_BIG = HOT * 8;           // 8e6
    const retSmall = retainedWindow(combinedCycle, N_SMALL);
    const retBig = retainedWindow(combinedCycle, N_BIG);
    const perSmall = retSmall / N_SMALL;
    const perBig = retBig / N_BIG;
    const ctlBig = retainedWindow(controlCycle, N_BIG) / N_BIG;

    // PD-45: "zero" is operational -- at or below the matched in-process
    // zero-alloc control, both ends forced-GC bracketed. +2 B is the forced-GC
    // noise-floor tolerance (0014's measured resolution), never a widened budget.
    check(
        perBig <= ctlBig + 2,
        () => "S8-A2 headline: delta-heap/cycle " + perBig.toFixed(3) + " B > control " +
            ctlBig.toFixed(3) + " B (+2 noise tolerance) at N=" + N_BIG +
            " (small-window N=" + N_SMALL + " was " + perSmall.toFixed(3) + " B/cyc)",
    );

    if (sink === -1 || leakSink.length === -1) console.log("unreachable");

    process.stdout.write(
        "torture: localto-torture S8-A2 reads=" + HOT + " writes=" + HOT +
        " | move/read gc major=" + readSummary.gc.major + " minor=" + readSummary.gc.minor +
        " write/read gc major=" + writeSummary.gc.major + " minor=" + writeSummary.gc.minor +
        " (floor=" + MINOR_FLOOR + " limit=" + MINOR_LIMIT + ")" +
        " maxMs=" + Math.max(readSummary.gc.maxMs, writeSummary.gc.maxMs).toFixed(2) +
        " | delta-heap/cyc small=" + perSmall.toFixed(3) + "B big=" + perBig.toFixed(3) +
        "B ctl=" + ctlBig.toFixed(3) + "B\n",
    );

    pkg.disposeReactive(vm);
    pkg.disposeReactive(controlVm);
}

// ===============================================================================
// S8-A6 -- the INTERLEAVE lattice: override survival, reset-on-move, THE ABA
// SHIPPED CONTRACT, and coarse-equals override survival.
// ===============================================================================

{
    // A minimal L=1 shape whose local keys on s0, so every transition below is a
    // single clean upstream/local move -- Object.is compare (the default).
    const LatticeVM = buildClass({
        name: "LocalLattice",
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "s0", decorator: pkg.reactive, value: () => 0 },
            // @localCopy flavor: seeds seen=s0-at-wiring, box=s0-at-wiring.
            { kind: "accessor", key: "loc", decorator: pkg.localTo((self) => self.s0) },
            { kind: "getter", key: "dLoc", decorator: pkg.derived, body: function () { return this.loc; } },
        ],
    });

    // --- override survives a NON-moving upstream --------------------------------
    {
        const lv = new LatticeVM();
        lv.s0 = 7;               // move upstream once so the read is well-defined
        lv.loc = 99;             // override: box=99, seen=7 (upstream-at-write)
        check(lv.loc === 99, () => "S8-A6 override: a fresh write must read back as 99, got " + lv.loc);
        check(lv.loc === 99, () => "S8-A6 override: a re-read with a static upstream must still be 99, got " + lv.loc);
        check(lv.dLoc === 99, () => "S8-A6 override: a derived over the local must see the override 99, got " + lv.dLoc);
        pkg.disposeReactive(lv);
    }

    // --- a move RESETS the read -------------------------------------------------
    {
        const lv = new LatticeVM();
        lv.s0 = 7;
        lv.loc = 99;             // seen=7, box=99
        lv.s0 = 8;               // move: upstream now 8 != seen 7
        check(lv.loc === 8, () => "S8-A6 reset: after an upstream move the read must show 8 (reset), got " + lv.loc);
        check(lv.dLoc === 8, () => "S8-A6 reset: the derived must recompute to the reset value 8, got " + lv.dLoc);
        pkg.disposeReactive(lv);
    }

    // --- THE SHIPPED ABA CONTRACT (S8-A6) ---------------------------------------
    // upstream A -> local write X -> upstream B -> upstream returns to an
    // equals-A value -> the read shows the STALE LOCAL X. The reset requires the
    // upstream to CHANGE relative to the LAST ADOPTION (the write's seen slot),
    // not to have moved transitively. This is 0014's honest, documented limit --
    // tracked-toolbox's @localCopy has the same property. Asserted verbatim,
    // NEVER softened.
    {
        const lv = new LatticeVM();
        const A = 100, B = 200, X = 999;
        lv.s0 = A;               // upstream A
        lv.loc = X;              // local write X: box=X, seen=A
        check(lv.loc === X, () => "S8-A6 ABA[1]: at upstream A the override X must read back, got " + lv.loc);
        lv.s0 = B;               // upstream B: B != seen A -> a transient reset read
        check(lv.loc === B, () => "S8-A6 ABA[2]: at upstream B the read must reset to B, got " + lv.loc);
        lv.s0 = A;               // upstream returns to an equals-A value
        // THE CONTRACT: seen is still A (a read never adopts), so upstream === seen
        // and the read shows the STALE LOCAL X -- the B excursion is invisible.
        check(
            lv.loc === X,
            () => "S8-A6 ABA[3] THE SHIPPED CONTRACT: after A->write X->B->A the read must show the STALE LOCAL " +
                X + ", got " + lv.loc,
        );
        check(lv.dLoc === X, () => "S8-A6 ABA[3]: the derived must also show the stale local " + X + ", got " + lv.dLoc);
        pkg.disposeReactive(lv);
    }

    // --- coarse equals holds an override across a move Object.is would reset -----
    {
        const CoarseVM = buildClass({
            name: "LocalCoarse",
            classDecorator: pkg.reactiveHost,
            members: [
                { kind: "accessor", key: "s0", decorator: pkg.reactive, value: () => 0 },
                {
                    kind: "accessor",
                    key: "loc",
                    // equals within 0.5 -> a 1.0 -> 1.4 move is "unchanged".
                    decorator: pkg.localTo((self) => self.s0, { equals: (a, b) => Math.abs(a - b) < 0.5 }),
                },
            ],
        });
        const cv = new CoarseVM();
        cv.s0 = 1.0;
        cv.loc = 42;             // box=42, seen=1.0
        cv.s0 = 1.4;             // Object.is would reset; approxEquals(1.4,1.0) -> unchanged
        check(
            cv.loc === 42,
            () => "S8-A6 coarse-equals: a within-tolerance move must PRESERVE the override 42, got " + cv.loc,
        );
        cv.s0 = 3.0;             // now beyond tolerance -> reset
        check(cv.loc === 3.0, () => "S8-A6 coarse-equals: an out-of-tolerance move must reset to 3.0, got " + cv.loc);
        pkg.disposeReactive(cv);
    }

    process.stdout.write("torture: localto-torture S8-A6 interleave lattice pinned (override / reset / ABA-stale / coarse-equals)\n");
}

// ===============================================================================
// S8-A3 -- pooled park/reinit retention: N=512 instances, 4096 cycles.
// ===============================================================================

{
    const POOL_N = 512;
    const RETENTION_CYCLES = 4096;
    const LEAK_EVERY = 1024;          // BREAK cadence
    const CHECK_MASK = 255;           // F-0 checkpoint every 256 cycles
    const EXPECTED_NODES = POOL_N * NODES_PER_INSTANCE;   // 512 x 10 == 5120
    const RES = residualCeiling(POOL_N);                  // finalization residual ceiling
    const RETAIN = retainLeak();      // RED control: pin every disposed instance
    const __leakSink = [];

    // A DEDICATED registry: 512 x 10 == 5120 exceeds the default registry's
    // 1024-node ceiling, so F-0 is asserted against THIS registry's own stats().
    const reg = createRegistry({ maxNodes: EXPECTED_NODES + 1024, onCapacityExceeded: "throw" });
    const Local = buildLocalClassOn("LocalPool", reg);

    const warns = [];
    // PLAIN tracker: no kernels, no onLeak (finalization is the release path).
    // onWarning stays -- a warning is a real finding.
    const tracker = createLeakTracker({
        name: NAME,
        onWarning: (w) => warns.push(w.kind + ":" + w.reason),
    });

    // Held-value-safe cleanup: `release` captures nothing, the tag is a detached
    // primitive.
    function release() {}

    const pool = new Array(POOL_N);
    for (let i = 0; i < POOL_N; i++) {
        const inst = new Local();
        // AUTHORITY: track OUTSIDE any owner (module-scope loop -> getOwner()
        // undefined) so lite-leak arms NO auto-untrack; finalization is the sole
        // release path. Never untracked.
        tracker.track(inst, release, i & 255);
        pool[i] = inst;
    }

    {
        const s = reg.stats();
        check(
            s.activeNodes === EXPECTED_NODES,
            () => "S8-A3 pool build: activeNodes " + s.activeNodes + " != expected " + EXPECTED_NODES,
        );
    }

    const poolBase = { activeNodes: reg.stats().activeNodes, poolGrowths: reg.stats().poolGrowths };

    // BREAK leaks: retained forever -> their live nodes stay off the pool floor,
    // caught by the F-0 checkpoint (the independent node oracle).
    const leakedVms = [];

    let rsink = 0;
    for (let i = 0; i < RETENTION_CYCLES; i++) {
        RUN.op = i;
        const leak = breakActive(NAME) && (i % LEAK_EVERY === 0);

        if (leak) {
            const extra = new Local();
            extra.s0 = 1;                   // wire + touch
            leakedVms.push(extra);          // retained -> live nodes off the pool floor
        } else {
            const idx = randInt(POOL_N);
            const inst = pool[idx];
            pkg.releaseReactive(inst);
            pkg.reinitReactive(inst);
            inst.s0 = i & 1023;
            inst.draft = i & 511;
            rsink = (rsink + (inst.draft | 0) + (inst.dMix | 0)) | 0;
        }

        if ((i & CHECK_MASK) === 0) {
            const s = reg.stats();
            check(
                s.activeNodes === poolBase.activeNodes,
                () => "S8-A3 pre-cycle floor: activeNodes " + s.activeNodes + " != baseline " +
                    poolBase.activeNodes + " at cycle " + i,
            );
            check(
                s.poolGrowths - poolBase.poolGrowths === 0,
                () => "S8-A3: poolGrowths grew by " + (s.poolGrowths - poolBase.poolGrowths) + " at cycle " + i,
            );
            check(
                s.totalAllocations - s.totalDisposals === s.activeNodes,
                () => "S8-A3: ledger " + (s.totalAllocations - s.totalDisposals) +
                    " != activeNodes " + s.activeNodes + " at cycle " + i,
            );
        }
    }
    if (rsink === -1) console.log("unreachable");
    RUN.op = -1;

    {
        const s = reg.stats();
        check(
            s.activeNodes === poolBase.activeNodes,
            () => "S8-A3 post-cycle: activeNodes " + s.activeNodes + " != baseline " + poolBase.activeNodes,
        );
        check(
            s.poolGrowths - poolBase.poolGrowths === 0,
            () => "S8-A3 post-cycle: poolGrowths grew by " + (s.poolGrowths - poolBase.poolGrowths),
        );
        check(
            s.totalAllocations - s.totalDisposals === s.activeNodes,
            () => "S8-A3 post-cycle: ledger " + (s.totalAllocations - s.totalDisposals) +
                " != activeNodes " + s.activeNodes,
        );
    }

    // Direct probe: releaseReactive frees EXACTLY P+L+D+E+1 nodes per instance.
    const probe = pool[0];
    const beforePark = reg.stats().activeNodes;
    const released = pkg.releaseReactive(probe);
    check(released === true, () => "S8-A3 direct: releaseReactive(probe) must return true");
    const afterPark = reg.stats().activeNodes;
    check(
        beforePark - afterPark === NODES_PER_INSTANCE,
        () => "S8-A3 direct: release must free exactly " + NODES_PER_INSTANCE + " nodes (P+L+D+E+1), freed " +
            (beforePark - afterPark) + " (before=" + beforePark + " after=" + afterPark + ")",
    );
    pkg.reinitReactive(probe);
    const afterRevive = reg.stats().activeNodes;
    check(
        afterRevive === beforePark,
        () => "S8-A3 direct: reinit must restore the exact node count, before=" +
            beforePark + " after-revive=" + afterRevive,
    );

    for (let i = 0; i < POOL_N; i++) {
        pkg.disposeReactive(pool[i]);
        if (RETAIN) __leakSink.push(pool[i]);   // RED: pin the disposed object -> never finalizes
        pool[i] = null;                          // clear scaffolding -> only the tracker weak-refs it
    }
    // Under BREAK, leakedVms is left un-disposed (caught by the F-0 checkpoint).

    {
        const s = reg.stats();
        check(
            breakActive(NAME) || s.activeNodes === 0,
            () => "S8-A3 teardown: dedicated registry activeNodes " + s.activeNodes + " != 0",
        );
    }

    await settleHard(() => tracker.size(), RES);
    // Keep the RED sink + leaked set live ACROSS the settle (V8 liveness-elides a
    // module array written-but-never-read after the loop, masking the pin).
    if (__leakSink.length === -1 || leakedVms.length === -1) console.log("unreachable");

    const live = tracker.size();
    const findings = tracker.audit();

    process.stdout.write(
        "torture: localto-torture S8-A3 pool=" + POOL_N + " cycles=" + RETENTION_CYCLES +
        " | AUTHORITY residual size=" + live + "/" + RES + " findings=" + findings.length +
        " warnings=" + warns.length +
        " | release-node-delta=" + (beforePark - afterPark) + " (expect " + NODES_PER_INSTANCE + ")\n",
    );

    check(warns.length === 0, () => "S8-A3: kernel warnings emitted: " + warns.join(","));
    check(
        findings.length === 0,
        () => "S8-A3: audit findings: " + findings.map((f) => f.kind + ":" + f.reason).join(","),
    );
    check(
        live <= RES,
        () => "S8-A3: AUTHORITY finalization residual size()=" + live + " > " + RES +
            " -- an instance outlived its disposal",
    );
}

// ===============================================================================
// S8-A4/A5 -- the TRACKING shape: a derived over ONE local holds exactly 2
// source edges; 1e5 localTo reads inside a recomputing derived emit 0 node
// create/dispose opcodes.
// ===============================================================================

{
    // A dedicated P=1, L=1, D=1 shape whose derived reads ONLY the local, so the
    // source count is exactly the local's two edges (upstream + local box).
    const TrackVM = buildClass({
        name: "LocalTrack",
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "src", decorator: pkg.reactive, value: () => 1 },
            { kind: "accessor", key: "loc", decorator: pkg.localTo((self) => self.src) },
            // reads ONLY the local -> its deps ARE the local's two edges.
            { kind: "getter", key: "dLoc", decorator: pkg.derived, body: function () { return this.loc; } },
        ],
    });

    // --- S8-A4: forEachSource on the derived yields exactly 2 descriptors --------
    {
        const tv = new TrackVM();
        void tv.dLoc;                    // force the lazy compute so the deps link
        const dbox = pkg.boxOf(tv, "dLoc");
        let count = 0;
        forEachSource(dbox, function () { count++; });
        check(
            count === 2,
            () => "S8-A4: a derived over one local must hold EXACTLY 2 source edges " +
                "(upstream + local box), got " + count,
        );
        pkg.disposeReactive(tv);
    }

    // --- S8-A5 (second half): 1e5 localTo reads in a compute -> 0 create/dispose -
    {
        const tv = new TrackVM();
        void tv.dLoc;                    // warm the compute + establish deps

        const HOT_READS = 100000;        // 1e5
        const tally = [0, 0, 0, 0, 0, 0];
        const off = onGraphMutation(function (op) { tally[op]++; });
        // Each iteration moves src (invalidates dLoc) then reads dLoc, forcing a
        // recompute whose body runs a localTo read INSIDE the compute. A pure read
        // path creates and disposes NO nodes over the whole window.
        let tsink = 0;
        for (let i = 0; i < HOT_READS; i++) {
            tv.src = i & 1023;
            tsink = (tsink + (tv.dLoc | 0)) | 0;
        }
        off();
        if (tsink === -1) console.log("unreachable");

        check(
            tally[1] === 0,
            () => "S8-A5: localTo reads in a compute created " + tally[1] + " node(s) (opcode 1) -- must be 0",
        );
        check(
            tally[2] === 0,
            () => "S8-A5: localTo reads in a compute disposed " + tally[2] + " node(s) (opcode 2) -- must be 0",
        );

        process.stdout.write(
            "torture: localto-torture S8-A4/A5 forEachSource-edges=2 reads=" + HOT_READS +
            " | node-create(op1)=" + tally[1] + " node-dispose(op2)=" + tally[2] + "\n",
        );

        pkg.disposeReactive(tv);
    }
}

// --- overall conservation: everything on the default registry is torn down -----

assertConserved(SCENARIO_BASE, "localto-torture final");

pass(NAME);
