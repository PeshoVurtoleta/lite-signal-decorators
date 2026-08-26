// bench/benchmark.mjs -- the class-reactivity runner.
//
// ORIGIN: modeled on ../../LiteSignal/bench/benchmark.mjs (bench protocol v3):
// the anti-DCE sink, median-of-5 with min shown, forced GC between runs, and the
// delta-heap + retained-heap columns are that rig's proven form. Here the runner
// is data-driven: it derives the engine list from frameworks.mjs and, per
// ENGINE_KEY x scenario, dynamically imports an adapter and a scenario module.
//
// ADAPTER  (./adapters/<key>.mjs):  export const ADAPTER = {
//     key, version(), build: { [scenarioKey]: (shape, ctx) => LANE } }
//   where LANE = { drive(i), expectedSum, dispose, liveness?() }
//              | { unsupported: "<reason>" }
//   and ctx = { sink, slot, mask, size, iters }. The churn and retention lanes
//   MUST expose liveness() -> a monotonically-advanced effect counter (PD-18):
//   the runner gates liveness() > 0 and FAILS a lane whose effect never ran.
//
// SCENARIO (./scenarios/<key>.mjs): export const SCENARIO = {
//     key, shape, iters, expectedSumFor(iters) }  -- the shape is LAW and the
//   expectedSum is engine-independent (the analytic oracle for the sink).
//
// DRIFT LAW (PD-17). A declared engine missing an adapter or a per-scenario
// builder is a runner ERROR -- drift is impossible. The one exception: a
// candidate engine (frameworks.mjs `candidate: true`) named in
// ./adapters/_exclusions.mjs prints its reason and is skipped. A builder may
// also return { unsupported } for one scenario, which is printed, not fatal.
//
// Run:   node --expose-gc benchmark.mjs
// Quick: BENCH_QUICK=1 node --expose-gc benchmark.mjs   (1 rep, CI smoke)
// Filter: FW=lsd,mobx SCEN=vm-write,churn node --expose-gc benchmark.mjs

import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance, PerformanceObserver, constants } from "node:perf_hooks";
import { ENGINES, ENGINE_KEYS, SCENARIO_KEYS, engineByKey } from "./frameworks.mjs";
import { SINK, SINK_MASK, SINK_SIZE, resetSink, verifySink } from "./lib/sink.mjs";
import { makeStamp, formatStamp, formatStampLine, PROTOCOLS } from "./lib/stamp.mjs";
import { median, summarizeSamples } from "./lib/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADAPTER_DIR = process.env.LSD_BENCH_ADAPTER_DIR || "./adapters";
const SCENARIO_DIR = process.env.LSD_BENCH_SCENARIO_DIR || "./scenarios";
const RESULTS_PATH = process.env.LSD_BENCH_RESULTS || resolve(HERE, "results.txt");
const ENGINE_PATH = resolve(HERE, "..", "SignalDecorators.js");

const QUICK = process.env.BENCH_QUICK === "1";
const WARMUP = QUICK ? 1 : 2;
const RUNS = QUICK ? 1 : 5;
const RETENTION_CYCLES = 4096;   // PD-19: retention is a fixed 4096-cycle gate lane.

const hasGC = typeof globalThis.gc === "function";
function forceGC() { if (hasGC) { globalThis.gc(); globalThis.gc(); } }
function heapKB() { return process.memoryUsage().heapUsed / 1024; }
function settle(ms) { return new Promise((r) => setTimeout(r, ms)); }

function moduleUrl(dir, key) {
    return pathToFileURL(resolve(HERE, dir, key + ".mjs")).href;
}

// --- formatting --------------------------------------------------------------
function pad(s, n) { s = String(s); return s + " ".repeat(Math.max(0, n - s.length)); }
function fmtMs(n) { return n.toFixed(2).padStart(8) + "ms"; }
function fmtOps(n) {
    return (n < 1_000_000_000 ? (n / 1_000) | 0 : (n / 1_000_000) | 0) + (n < 1_000_000_000 ? "K" : "M");
}
function fmtKB(n) { const v = n.toFixed(1); return (n >= 0 ? " " : "") + v + "KB"; }

// --- GC entry counter (retention lane) ---------------------------------------
function makeGcCounter() {
    let major = 0, minor = 0, incremental = 0;
    const obs = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
            const k = (e.detail && e.detail.kind) || e.kind;
            if (k === constants.NODE_PERFORMANCE_GC_MAJOR) major++;
            else if (k === constants.NODE_PERFORMANCE_GC_MINOR) minor++;
            else if (k === constants.NODE_PERFORMANCE_GC_INCREMENTAL) incremental++;
        }
    });
    obs.observe({ entryTypes: ["gc"] });
    return { stop: () => obs.disconnect(), get: () => ({ major, minor, incremental }) };
}

// --- output sink (stdout + results.txt) --------------------------------------
const out = [];
function emit(line) { console.log(line); out.push(line); }

// --- load phase: adapters, scenarios, exclusions -----------------------------
async function loadExclusions() {
    try {
        const m = await import(moduleUrl(ADAPTER_DIR, "_exclusions"));
        return (m && m.default) || {};
    } catch {
        return {}; // Coder I owns _exclusions.mjs; a missing file is an empty map.
    }
}

async function loadScenario(key) {
    const m = await import(moduleUrl(SCENARIO_DIR, key));
    const S = m.SCENARIO;
    if (!S || S.key !== key) throw new Error("scenario " + key + " export SCENARIO missing or mis-keyed");
    if (typeof S.expectedSumFor !== "function") throw new Error("scenario " + key + " has no expectedSumFor(iters) oracle");
    return S;
}

async function loadAdapter(key) {
    const m = await import(moduleUrl(ADAPTER_DIR, key));
    const A = m.ADAPTER;
    if (!A || A.key !== key) throw new Error("adapter " + key + " export ADAPTER missing or mis-keyed");
    if (!A.build || typeof A.build !== "object") throw new Error("adapter " + key + " has no build map");
    if (typeof A.version !== "function") throw new Error("adapter " + key + " has no version()");
    return A;
}

function die(lines) {
    for (const l of lines) console.error(l);
    process.exit(1);
}

// --- one lane ----------------------------------------------------------------
// Runs the timed protocol for (engine x scenario). Returns { row, checksumOk }.
async function runLane(engineKey, laneIndex, adapter, SCENARIO) {
    const builder = adapter.build[SCENARIO.key];
    if (typeof builder !== "function") {
        // DRIFT: a declared engine with a loaded adapter but no builder for a
        // declared scenario. Fatal per PD-17 -- absence is never silent.
        die(["DRIFT ERROR: adapter " + engineKey + " has no builder for scenario '" + SCENARIO.key +
            "'. Add the builder or return { unsupported } from it."]);
    }
    const isRetention = SCENARIO.key === "retention";
    const iters = isRetention ? RETENTION_CYCLES : SCENARIO.iters;
    const slot = (laneIndex * 64) & SINK_MASK;
    const oracle = SCENARIO.expectedSumFor(iters);

    function build() {
        return builder(SCENARIO.shape, { sink: SINK, slot, mask: SINK_MASK, size: SINK_SIZE, iters });
    }

    // Probe once for unsupported / expected-sum drift.
    const probe = build();
    if (probe && probe.unsupported) {
        if (probe.dispose) probe.dispose();
        return { row: pad(engineKey, 22) + "(unsupported: " + probe.unsupported + ")", checksumOk: true };
    }
    if (probe.expectedSum != null && probe.expectedSum !== oracle) {
        if (probe.dispose) probe.dispose();
        return {
            row: pad(engineKey, 22) + "REJECTED expectedSum=" + probe.expectedSum + " disagrees with oracle=" + oracle,
            checksumOk: false,
        };
    }
    if (probe.dispose) probe.dispose();

    if (isRetention) return runRetentionLane(engineKey, build, oracle);

    const needLiveness = SCENARIO.key === "churn";   // effect-duty lane (PD-18).

    // Warmup on a throwaway build.
    for (let w = 0; w < WARMUP; w++) {
        const b = build();
        for (let i = 0; i < iters; i++) b.drive(i);
        if (b.dispose) b.dispose();
    }

    // RETAINED baseline: the post-forced-GC heap floor captured BEFORE the timed
    // reps. Every build in the reps loop is disposed inside it, so a clean lane
    // returns to this floor (retained ~ 0) and a lane that retains memory past
    // dispose moves the column above it. This is a real measurement -- not a
    // reading subtracted from itself.
    forceGC();
    const retainBaseline = heapKB();

    const samples = [];
    const heapDeltas = [];
    let sinkOk = true, lastGot = 0, lastLive = null;
    for (let r = 0; r < RUNS; r++) {
        const b = build();
        resetSink();
        forceGC();
        const heapBefore = heapKB();
        const t0 = performance.now();
        for (let i = 0; i < iters; i++) b.drive(i);
        samples.push(performance.now() - t0);
        heapDeltas.push(heapKB() - heapBefore);
        const v = verifySink(oracle);
        if (!v.ok) { sinkOk = false; lastGot = v.got; }
        if (needLiveness) lastLive = (typeof b.liveness === "function") ? b.liveness() : NaN;
        if (b.dispose) b.dispose();
    }
    forceGC();
    const retained = Math.max(0, heapKB() - retainBaseline);

    let laneOk = sinkOk;
    let verdict = sinkOk ? "sink=ok" : "sink=REJECTED(got=" + lastGot + " want=" + oracle + ")";
    if (needLiveness && !(lastLive > 0)) {   // dead effect counter -> lane FAILURE.
        laneOk = false;
        verdict += " liveness=DEAD(" + lastLive + ")";
    }

    const med = median(samples);
    const min = Math.min(...samples);
    const ops = (iters / (med / 1000)) | 0;
    const heapMed = median(heapDeltas);
    const heapP95 = summarizeSamples(heapDeltas).p95;
    const row =
        pad(engineKey, 22) +
        "median=" + fmtMs(med) +
        " min=" + fmtMs(min) +
        " ops/s=" + pad(fmtOps(ops), 7) +
        " heapMed=" + pad(fmtKB(heapMed), 9) +
        " heapP95=" + pad(fmtKB(heapP95), 9) +
        " retained=" + pad(fmtKB(retained), 9) +
        " " + verdict;
    return { row, checksumOk: laneOk };
}

// RETENTION lane: fixed cycles, reports retained heap + GC collection counts,
// NOT ops/s (PD-19). The sink checksum still gates the exit code.
async function runRetentionLane(engineKey, build, oracle) {
    const b = build();
    forceGC();
    const heap0 = heapKB();
    const gc = makeGcCounter();
    resetSink();
    for (let c = 0; c < RETENTION_CYCLES; c++) b.drive(c);
    await settle(50);                 // GC entries arrive asynchronously.
    const counts = gc.get();
    gc.stop();
    const v = verifySink(oracle);
    const live = (typeof b.liveness === "function") ? b.liveness() : NaN;   // PD-18 effect duty.
    forceGC();
    const retainedDelta = heapKB() - heap0;   // post-GC growth over the pre-lane post-GC floor.
    if (b.dispose) b.dispose();
    let laneOk = v.ok;
    let verdict = v.ok ? "sink=ok" : "sink=REJECTED(got=" + v.got + " want=" + oracle + ")";
    if (!(live > 0)) { laneOk = false; verdict += " liveness=DEAD(" + live + ")"; }
    const row =
        pad(engineKey, 22) +
        "cycles=" + pad(RETENTION_CYCLES, 6) +
        " retainedDelta=" + pad(fmtKB(retainedDelta), 9) +
        " gc.major=" + pad(counts.major, 4) +
        " gc.minor=" + pad(counts.minor, 5) +
        " " + verdict;
    return { row, checksumOk: laneOk };
}

// --- main --------------------------------------------------------------------
async function main() {
    if (!hasGC) emit("!  Run with --expose-gc for accurate heap columns.");

    // Filters (FW=, SCEN=) as in the LiteSignal harness.
    const fw = process.env.FW ? process.env.FW.split(",").map((s) => s.trim()).filter(Boolean) : null;
    const scen = process.env.SCEN ? process.env.SCEN.split(",").map((s) => s.trim()).filter(Boolean) : null;

    const activeEngineKeys = (fw ? fw.filter((k) => ENGINE_KEYS.includes(k)) : ENGINE_KEYS.slice());
    const activeScenarioKeys = (scen ? scen.filter((k) => SCENARIO_KEYS.includes(k)) : SCENARIO_KEYS.slice());
    if (activeEngineKeys.length === 0) die(["no matching engines for FW='" + process.env.FW + "'"]);
    if (activeScenarioKeys.length === 0) die(["no matching scenarios for SCEN='" + process.env.SCEN + "'"]);

    const exclusions = await loadExclusions();

    // Load scenarios first (a missing scenario is fatal drift).
    const scenarios = new Map();
    for (const key of activeScenarioKeys) {
        try {
            scenarios.set(key, await loadScenario(key));
        } catch (e) {
            die(["DRIFT ERROR: cannot load scenario '" + key + "': " + (e && e.message || e)]);
        }
    }

    // Load adapters. Missing adapter => fatal drift, unless a candidate is excluded.
    const adapters = new Map();
    const skipped = [];
    const versions = {};
    for (const key of activeEngineKeys) {
        const eng = engineByKey(key);
        try {
            const A = await loadAdapter(key);
            adapters.set(key, A);
            try { versions[key] = String(A.version()); } catch { versions[key] = "version()-threw"; }
        } catch (e) {
            if (eng && eng.candidate && exclusions[key]) {
                skipped.push({ key, reason: exclusions[key] });
                continue;
            }
            die(["DRIFT ERROR: cannot load adapter './adapters/" + key + ".mjs' for declared engine '" + key +
                "': " + (e && e.message || e),
                "  (a non-candidate engine MUST have an adapter; a candidate must be listed in ./adapters/_exclusions.mjs to be skipped)"]);
        }
    }

    // Stamp header (provenance + resolved adapter versions).
    const stamp = makeStamp({
        enginePath: pathToFileURL(ENGINE_PATH).href,
        harnessPath: import.meta.url,
        config: { mode: "class-reactivity microscope", warmup: WARMUP, runs: RUNS, quick: QUICK },
        protocol: PROTOCOLS.PER_ENGINE,
        reps: RUNS,
        extra: { adapters: versions, scenarios: activeScenarioKeys },
    });
    emit(formatStamp(stamp));
    emit(formatStampLine(stamp));
    for (const s of skipped) emit("# EXCLUDED  " + pad(s.key, 20) + s.reason);
    emit("Config: WARMUP=" + WARMUP + "  RUNS=" + RUNS + "  QUICK=" + QUICK + "  gc=" + (hasGC ? "on" : "OFF"));
    emit("");

    let anyChecksumFail = false;
    let laneIndex = 0;
    const activeAdapterKeys = activeEngineKeys.filter((k) => adapters.has(k));
    for (const scKey of activeScenarioKeys) {
        const SCENARIO = scenarios.get(scKey);
        emit("-".repeat(110));
        emit(scKey + "   shape=" + JSON.stringify(SCENARIO.shape) + "   iters=" +
            (scKey === "retention" ? RETENTION_CYCLES : SCENARIO.iters));
        emit("-".repeat(110));
        for (const engineKey of activeAdapterKeys) {
            const { row, checksumOk } = await runLane(engineKey, laneIndex++, adapters.get(engineKey), SCENARIO);
            emit(row);
            if (!checksumOk) anyChecksumFail = true;
        }
        emit("");
    }

    emit("Notes:");
    emit("  median/min = median-of-" + RUNS + " timed runs (min shown for spread); each run is GC-fenced.");
    emit("  heapMed/heapP95 = transient heap per timed run; retained = heap surviving a forced GC.");
    emit("  sink=ok means the summed anti-DCE sink matched the scenario's analytic oracle; REJECTED voids the lane.");
    emit("  retention reports retainedDelta + GC collection counts, not ops/s (PD-19).");

    // Append the whole table to results.txt under the stamp.
    try {
        appendFileSync(RESULTS_PATH, out.join("\n") + "\n\n");
    } catch (e) {
        console.error("could not append to results.txt: " + (e && e.message || e));
    }

    if (anyChecksumFail) {
        console.error("");
        console.error("!".repeat(110));
        console.error("INVALID RUN -- one or more lanes REJECTED by the sink checksum. These numbers are not publishable.");
        console.error("!".repeat(110));
        process.exit(1);
    }
}

main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
