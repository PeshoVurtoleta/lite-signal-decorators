// demo/gc-lane.mjs -- node --expose-gc demo/gc-lane.mjs
//
// The headless GC lane over the DOM-free core (PD-31): the identical Plane A
// loop that runs in the browser, driven for 3600 frames (60 s at 60 fps) at a
// standing fleet of N=2000, while every one of the five Plane B lite-watch-ex
// watchers is exercised via allocation-free NUMERIC sinks at the SAME masked
// cadence the UI writes text ((frame & 7) === 0). This is how OUR gate verifies
// lite-watch-ex's zero-alloc claim (PD-30) -- we never trust it.
//
// GATE (S5b-A1): gc.major === 0; maxPauseMs <= 4.0 (the S1 budget, never
// widened); delta-heap per entity-op at or below the zerogc lane's stamped noise
// floor (0.589 B/op, README.md:346); and gc.minor at or below a zero-alloc
// CONTROL measured in THIS process plus headroom. The literal `gc.minor === 0`
// of S5b-A1 is not physical here: the package's own hot accessor path carries a
// documented ~0.56 B/op sub-floor over this window's 7.2M entity-ops, so minor
// is gated against a measured control per decision 0003 (the package's law; the
// zerogc torture does the same) -- a hardcoded-zero minor budget is exactly what
// that decision forbids. The DEMO_BREAK control below still trips it.
//
// Also proves S5b-A4 (THE WALL): registering all five watchers and tearing them
// down moves world.stats().activeNodes and activeLinks by EXACTLY 0.
//
// DEMO_BREAK=alloc retains one object per frame -> the retained heap forces a
// major collection, so the strict gc.major === 0 gate is the load-bearing one
// that exits non-zero (the retained bytes stay resident, so B/op alone does not
// cross the floor). A gate that cannot fail is not a gate.
//
// ASCII-only.

import { GcProfiler, checkNoGc } from "@zakkster/lite-gc-profiler";
import { buildNodeCore } from "./build.mjs";

const core = await import(await buildNodeCore());
const {
    N_MAX, spawn, step, population, worldStats, effectFires, createTelemetry,
} = core;

const FLEET = 2000;
const FRAMES = 3600;
const WARMUP = 300;
const TEXT_MASK = 7;                    // (frame & 7) === 0 -- matches the UI
// step() performs a fixed, countable set of reactive accessor ops per entity per
// frame -- the unit the 0.589 floor was stamped on (a single accessor read/write,
// zerogc-torture). A CONSERVATIVE undercount (guaranteed touches only, ignoring
// the bounce rewrites, the derived recompute's internal reads, and the effect
// refire): 6 reads (vx,x,vy,y,x,y) + 4 writes (vx,vy,x,y) + 1 derived read
// (speed) = 11. Undercounting ops -> overcounting B/op, so the gate stays strict.
const OPS_PER_ENTITY = 11;
const ACCESSOR_OPS = FRAMES * FLEET * OPS_PER_ENTITY;
const NOISE_FLOOR_BPO = 0.589;          // README.md:346 stamped control
const MAX_PAUSE_MS = 4.0;               // S1 budget
const MINOR_HEADROOM = 128;             // decision 0003 headroom over the control

const BREAK = process.env.DEMO_BREAK === "alloc";
const breakSink = [];                   // retains the BREAK allocations

// --- standing fleet -----------------------------------------------------------

spawn(FLEET);
if (population() !== FLEET) {
    console.error("gc-lane FAIL -- fleet build: population " + population() + " != " + FLEET);
    process.exit(1);
}

// --- Plane B: numeric sinks (zero-alloc), one per watcher ---------------------

let cAlert = 0, cFrame = 0, cPop = 0, cDash = 0, cChurn = 0;
const tel = createTelemetry({
    onCapacityAlert: () => { cAlert = (cAlert + 1) | 0; },
    onFrameSample: () => { cFrame = (cFrame + 1) | 0; },
    onPopulationChanged: () => { cPop = (cPop + 1) | 0; },
    onDashboard: () => { cDash = (cDash + 1) | 0; },
    onChurnDelta: () => { cChurn = (cChurn + 1) | 0; },
}, { dev: true, worldStats });

// --- the frame body (identical shape for warmup + measure) --------------------
// step() every frame (Plane A hot path); telemetry pushed at the masked cadence
// (Plane B), exactly as the UI writes text. All watcher sources read Plane B
// boxes only; population oscillates safely below 0.9 x N_MAX so watchUntil stays
// armed (source evaluated each change) without firing.

function frameBody(i) {
    step(1 / 60);
    if ((i & TEXT_MASK) === 0) {
        tel.fps.set(60 - ((i >> 3) & 7));
        tel.frameMs.set(15 + ((i >> 3) & 15) * 0.1);
        tel.populationBox.set(FLEET - ((i >> 3) & 7));
        tel.effectFiresBox.set(effectFires());
        tel.churnRate.set((i >> 3) & 255);
    }
    if (BREAK) breakSink.push(new Float64Array(1024));  // retained -> trips the strict major===0 gate
}

// --- control: minors provoked by a zero-alloc body over the same window -------

function measureControl() {
    let sink = 0;
    for (let i = 0; i < WARMUP; i++) sink += (i & 7);
    globalThis.gc?.();
    const g = new GcProfiler().start();
    for (let i = 0; i < FRAMES; i++) {
        sink += (i & 7);
        if ((i & 511) === 0) g.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    const s = g.summary();
    g.stop();
    if (sink === -1) console.log("unreachable");
    return s.gc.minor;
}
const controlMinors = measureControl();
const MINOR_LIMIT = controlMinors + MINOR_HEADROOM;

// --- warmup -------------------------------------------------------------------

for (let i = 0; i < WARMUP; i++) frameBody(i);

// --- measured window ----------------------------------------------------------

globalThis.gc?.();
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));

const h0 = process.memoryUsage().heapUsed;
const gc = new GcProfiler().start();
for (let i = 0; i < FRAMES; i++) {
    frameBody(i);
    if ((i & 511) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
}
const h1 = process.memoryUsage().heapUsed;

await new Promise((r) => setTimeout(r, 50));
const s = gc.summary();
gc.stop();

const bPerOp = (h1 - h0) / ACCESSOR_OPS;
const report = checkNoGc(s, { maxMajor: 0, maxMinor: MINOR_LIMIT, maxPauseMs: MAX_PAUSE_MS });

// --- watcher liveness ---------------------------------------------------------
const sinksLive = cFrame > 0 && cPop > 0 && cDash > 0 && cChurn > 0;

// --- S5b-A4: the wall, falsifiable -------------------------------------------
const wBefore = worldStats();
const wall = createTelemetry({}, { dev: true, worldStats });
const wAfter = worldStats();
wall.disposeAll();
const wPost = worldStats();
const wallOk =
    wAfter.activeNodes === wBefore.activeNodes &&
    wAfter.activeLinks === wBefore.activeLinks &&
    wPost.activeNodes === wBefore.activeNodes &&
    wPost.activeLinks === wBefore.activeLinks;

// --- verdict ------------------------------------------------------------------

// The gate is IDENTICAL in clean and BREAK mode -- DEMO_BREAK=alloc merely
// injects a retained allocation each frame, which must trip this same gate to
// exit non-zero. A gate that behaves differently under its own control is not a
// gate.
const bpoOk = bPerOp <= NOISE_FLOOR_BPO;
const pass = report.verdict === "pass" && bpoOk && sinksLive && wallOk;

process.stdout.write(
    "demo gc-lane fleet=" + FLEET + " frames=" + FRAMES +
    " | gc major=" + s.gc.major + " minor=" + s.gc.minor +
    " (control " + controlMinors + " +" + MINOR_HEADROOM + ")" +
    " maxMs=" + s.gc.maxMs.toFixed(2) +
    " | alloc=" + bPerOp.toFixed(3) + " B/op (floor " + NOISE_FLOOR_BPO + ")" +
    " | watchers alert=" + cAlert + " frame=" + cFrame + " pop=" + cPop +
    " dash=" + cDash + " churn=" + cChurn +
    " | wall nodesDelta=" + (wAfter.activeNodes - wBefore.activeNodes) +
    " linksDelta=" + (wAfter.activeLinks - wBefore.activeLinks) +
    " | " + (BREAK ? "BREAK " : "") + (pass ? "ok" : "FAIL") + "\n",
);

if (!pass) {
    for (const v of (report.violations || [])) {
        process.stderr.write("  violation " + v.metric + " limit=" + v.limit + " actual=" + v.actual + "\n");
    }
    if (!bpoOk) process.stderr.write("  B/op " + bPerOp.toFixed(3) + " > floor " + NOISE_FLOOR_BPO + "\n");
    if (!sinksLive) process.stderr.write("  watcher sink stalled: frame=" + cFrame + " pop=" + cPop + " dash=" + cDash + " churn=" + cChurn + "\n");
    if (!wallOk) process.stderr.write("  WALL breached: nodesDelta=" + (wAfter.activeNodes - wBefore.activeNodes) + " linksDelta=" + (wAfter.activeLinks - wBefore.activeLinks) + "\n");
    process.exit(1);
}

tel.disposeAll();
