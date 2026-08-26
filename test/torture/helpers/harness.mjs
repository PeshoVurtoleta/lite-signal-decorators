// test/torture/helpers/harness.mjs -- shared torture primitives for
// @zakkster/lite-signal-decorators (Workstream C, PLAN-S1 C-2).
//
// One place enforces the discipline every scenario relies on:
//   - a seeded xorshift32 PRNG (TORTURE_SEED overrides; a failure prints the
//     seed and the current op index so any case replays deterministically);
//   - check(cond, msgThunk) -- the message thunk is evaluated ONLY on failure,
//     so a passing assertion allocates nothing in a hot loop;
//   - settle() -- awaits a macrotask + microtask so lite-gc-profiler's async GC
//     entries land before summary() is read (a false PASS otherwise);
//   - gcGate() -- wraps measureOps/checkNoGc with exactly ONE measurement in
//     flight (all lanes share one heap);
//   - conservationBaseline()/assertConserved() -- FINDING F-0 exactly
//     (decisions/0002): activeNodes back to baseline, poolGrowths delta 0,
//     totalAllocations - totalDisposals === activeNodes;
//   - breakActive(name) -- reads TORTURE_BREAK so every scenario can sabotage
//     its own central assertion (the --controls gate self-test).
//
// ASCII-only. Zero dependencies beyond lite-gc-profiler and the peer.

import { GcProfiler, checkNoGc } from "@zakkster/lite-gc-profiler";
import { stats } from "@zakkster/lite-signal";

// --- seed + replay state ------------------------------------------------------

/** Default seed. A fixed literal so an unseeded run is reproducible. */
const DEFAULT_SEED = 0x9e3779b9;

/** Effective seed for this process. xorshift32 must never be seeded with 0. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return DEFAULT_SEED;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n;
})();

/** Mutable replay cursor. Scenarios set RUN.op = <index> before each op; a
 *  failing check quotes SEED + RUN.op so the exact case replays. Assigning a
 *  number is allocation-free, so this stays hot-loop safe. */
export const RUN = { op: -1 };

// --- PRNG ---------------------------------------------------------------------

/** Seeded xorshift32 -> a function yielding a uint32 per call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** The process PRNG, seeded from SEED. */
export const prng = makePrng(SEED);

/** Uniform integer in [0, n). n must be a positive integer. */
export function randInt(n) {
    return prng() % n;
}

/** Uniform integer in [lo, hi] inclusive. */
export function randRange(lo, hi) {
    return lo + (prng() % (hi - lo + 1));
}

// --- assertions + exit contract -----------------------------------------------

/** Fail the whole scenario (exit 1). stdout stays clean; reason to stderr,
 *  always tagged with the replay coordinates. */
export function die(msg) {
    process.stderr.write(
        "torture: FAIL -- " + msg + " (seed=" + SEED + " op=" + RUN.op + ")\n",
    );
    process.exit(1);
}

/** Fail as an infrastructure error (exit 78): a prerequisite the engine's
 *  floor says nothing about (a missing fixture, an unreadable manifest). */
export function dieInfra(msg) {
    process.stderr.write("torture: INFRA -- " + msg + "\n");
    process.exit(78);
}

/** Assertion whose message is built ONLY on failure. Pass a thunk. */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/** True when TORTURE_BREAK names THIS scenario -- flips its central assertion
 *  so the --controls sweep proves the gate can fail. */
export function breakActive(name) {
    return process.env.TORTURE_BREAK === name;
}

// --- settling -----------------------------------------------------------------

/** Await a macrotask then a microtask, so any asynchronously-delivered GC
 *  PerformanceObserver entries and FinalizationRegistry callbacks land before
 *  the next measurement window reads summary(). */
export function settle() {
    return new Promise((resolve) => {
        setTimeout(() => { Promise.resolve().then(resolve); }, 0);
    });
}

// --- GC gate ------------------------------------------------------------------
//
// The measurement uses the GcProfiler MANUAL path (a live PerformanceObserver),
// NOT measureOps: measureOps forces its own collections to settle each batch,
// which counts as `ownForced` and NEVER surfaces as a real major/minor -- so an
// allocation storm inside the body would slip past `maxMajor`/`maxMinor`
// silently. The manual observer records the collections the WORKLOAD actually
// provoked, which is the thing we mean to gate. --expose-gc is required.
//
// Rules are gc-lane keys only (`maxMajor`, `maxMinor`, `maxPauseMs`); whichever
// are present are forwarded to checkNoGc. Exactly one profiler window is ever
// open at a time (callers await each gcGate before the next); gc.stop() closes
// it. Per decision 0003 (the S0 minor-noise floor lesson), a lane that gates
// `maxMinor` derives its limit from a known-zero-alloc control measured in THIS
// same process (see zerogc-torture) -- never a hardcoded budget.

const SINK_KEY = "__ldtorture_sink";

/**
 * Run `fn(i)` (returns a number, accumulated to defeat DCE) over a warmup then a
 * measured loop, sample the heap on a sparse mask, settle so async GC entries
 * land, and gate the recorded window against `rules`. FAILS the scenario
 * (exit 1) on any violation, naming the metric. Returns the gc summary.
 *
 * @param {string} name
 * @param {(i:number)=>number} fn
 * @param {{ops:number, warmup?:number, sampleMask?:number,
 *          maxMajor?:number, maxMinor?:number, maxPauseMs?:number}} opts
 */
export async function gcGate(name, fn, opts) {
    const warmup = opts.warmup === undefined ? 0 : opts.warmup;
    const sampleMask = opts.sampleMask === undefined ? 8191 : opts.sampleMask;
    let sink = globalThis[SINK_KEY] | 0;
    for (let i = 0; i < warmup; i++) sink += fn(i);

    const gc = new GcProfiler().start();
    for (let i = 0; i < opts.ops; i++) {
        sink += fn(i);
        if ((i & sampleMask) === 0) {
            gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
    }
    globalThis[SINK_KEY] = sink;               // reachable -> reads are not DCE'd
    await settle();
    const s = gc.summary();
    gc.stop();

    const rules = {};
    if (opts.maxMajor !== undefined) rules.maxMajor = opts.maxMajor;
    if (opts.maxMinor !== undefined) rules.maxMinor = opts.maxMinor;
    if (opts.maxPauseMs !== undefined) rules.maxPauseMs = opts.maxPauseMs;
    const report = checkNoGc(s, rules);
    if (report.verdict !== "pass") {
        process.stderr.write(
            "torture: FAIL -- gcGate(" + name + ") verdict=" + report.verdict +
                " gc major=" + s.gc.major + " minor=" + s.gc.minor +
                " maxMs=" + s.gc.maxMs.toFixed(2) + " (seed=" + SEED + ")\n",
        );
        const v = report.violations || [];
        for (let i = 0; i < v.length; i++) {
            process.stderr.write(
                "  violation " + v[i].metric + " limit=" + v[i].limit +
                    " actual=" + v[i].actual + "\n",
            );
        }
        process.exit(1);
    }
    return s;
}

// --- conservation (FINDING F-0) -----------------------------------------------

/** Snapshot the four F-0 counters at a quiescent moment. */
export function conservationBaseline() {
    const s = stats();
    return {
        activeNodes: s.activeNodes,
        poolGrowths: s.poolGrowths,
        totalAllocations: s.totalAllocations,
        totalDisposals: s.totalDisposals,
    };
}

/**
 * Assert F-0 EXACTLY against a baseline taken after warmup:
 *   1. activeNodes returned to the baseline;
 *   2. poolGrowths delta is 0 (the pool never had to grow);
 *   3. totalAllocations - totalDisposals === activeNodes (the ledger balances).
 * Any breach FAILS the scenario with the concrete numbers.
 */
export function assertConserved(base, label) {
    const s = stats();
    check(
        s.activeNodes === base.activeNodes,
        () => label + ": activeNodes " + s.activeNodes + " != baseline " + base.activeNodes,
    );
    check(
        s.poolGrowths - base.poolGrowths === 0,
        () => label + ": poolGrowths grew by " + (s.poolGrowths - base.poolGrowths),
    );
    check(
        s.totalAllocations - s.totalDisposals === s.activeNodes,
        () => label + ": ledger " + (s.totalAllocations - s.totalDisposals) +
            " != activeNodes " + s.activeNodes,
    );
}

// --- pass banner --------------------------------------------------------------

/** Print the scenario's PASS line (the runner keys on exit code, not text). */
export function pass(name) {
    process.stdout.write("torture: PASS -- " + name + "\n");
}
