// cookbook/r09-two-plane-fleet.mjs -- node --expose-gc cookbook/r09-two-plane-fleet.mjs
//
// Recipe 9 (Pro, GATED): the two-plane fleet. Generalizes demo/src/core/loop.ts.
// Stamp 2026-08-30. Sim plane = a lite-arena SoA column set written RAW per
// frame against a uniform-grid stand-in; reactive plane = ONE fleet view-model
// committed at the tick boundary by a single coarse rev bump. Snippets live in
// `#region cookbook:r9.k` spans; harness (gate + asserts + summary) is OUTSIDE.
//
// GATES (the S1 budget, never widened): gc.major === 0, maxPauseMs <= 4.0,
// bytes/op <= 0.589, minors <= an in-process zero-alloc control + 128.
// CB-A5: costOf(FleetVM).nodes invariant at 0 / 1 / 1000 / 100000 entities.
// CB-A4: 1000 spawn/kill cycles at N=256 -- tracker.size() === 0, activeNodes
//        back to the exact baseline, poolGrowths === 0.
// COOKBOOK_BREAK=r9 allocates one object per op in the measured loop -> FAIL.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

import { GcProfiler, checkNoGc, measureOps } from "@zakkster/lite-gc-profiler";
import {
    createLeakTracker,
    createOwnerCascadeOrphanKernel,
    createObserverOrphanKernel,
} from "@zakkster/lite-leak";

function fail(msg) {
    process.stderr.write("cookbook r9 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }
function settle() {
    return new Promise((r) => { setTimeout(() => { Promise.resolve().then(r); }, 0); });
}

// #region cookbook:r9.1
import { Arena } from "@zakkster/lite-arena";

// Sim plane: a Structure-of-Arrays column set. One component, four parallel
// TypedArray columns, all written RAW per frame -- no per-entity object, no
// per-entity reactive node.
const MAX_ENTITIES = 4096;
const arena = new Arena(MAX_ENTITIES);
const motion = arena.registerComponent({
    x: Float32Array, y: Float32Array, vx: Float32Array, vy: Float32Array,
});

// A plain uniform-grid stand-in: one preallocated cell index per slot, rewritten
// each frame. A production build swaps this for a real broadphase -- see the
// lite-bvh POINTER block in the recipe, where the reassign-the-returned-id
// contract (updateLeaf/query on the class DynamicBVH2D) is stated in prose.
const GRID_BITS = 5;                            // a 32 x 32 cell grid
const cellOf = new Int32Array(MAX_ENTITIES);
function gridCell(x, y) {
    const cx = (x | 0) & 31;
    const cy = (y | 0) & 31;
    return (cy << GRID_BITS) | cx;
}

function spawnFleet(n) {
    for (let k = 0; k < n; k++) {
        const e = arena.spawn();
        const i = motion.add(e);
        motion.data.x[i] = (k * 7) & 31;
        motion.data.y[i] = (k * 13) & 31;
        motion.data.vx[i] = (k & 3) - 1;         // small integers -> no boxed doubles
        motion.data.vy[i] = (k & 1) ? 1 : -1;
    }
}
// #endregion cookbook:r9.1

// #region cookbook:r9.2
import { createRegistry } from "@zakkster/lite-signal";
import {
    defineReactive, disposeReactive, capacityFor, costOf,
} from "@zakkster/lite-signal-decorators";

// Reactive plane: ONE fleet view-model with a handful of meaningful members --
// never a node per entity. Its shape is fixed, so its cost is fixed.
const FLEET_SPEC = {
    signals: { count: 0, avgSpeed: 0, rev: 0 },
    deriveds: { status: (vm) => (vm.count > 0 ? "active" : "idle") },
    effects: { onCommit: (vm) => { void vm.rev; } },
};

// Size a PRIVATE world for exactly this shape from its measured cost, then bind
// the fleet to it. capacityFor defaults to prealloc:"eager" +
// onCapacityExceeded:"throw", so the (k+1)-th fleet throws CapacityError instead
// of quietly growing the pool.
const fleetProbe = defineReactive(class FleetShape {}, FLEET_SPEC);
const fleetWorld = createRegistry(capacityFor([[fleetProbe, 1]]));
const FleetVM = defineReactive(class Fleet {}, { host: { registry: fleetWorld }, ...FLEET_SPEC });
const fleet = new FleetVM();
// #endregion cookbook:r9.2

// #region cookbook:r9.3
// The tick: advance the sim plane with RAW column writes, rebin into the grid,
// then commit the reactive plane with ONE coarse rev bump. We do NOT wrap the
// commit in @batched -- @batched allocates a thunk + rest-array per call and is
// for the user-intent path (one call per user action), never a per-frame path.
// A frame commits by bumping a single rev signal; watchers see one edge.
function tick(frame) {
    const n = motion.count;
    const x = motion.data.x, y = motion.data.y;
    const vx = motion.data.vx, vy = motion.data.vy;
    let speedSum = 0;
    for (let i = 0; i < n; i++) {
        x[i] += vx[i];
        y[i] += vy[i];
        cellOf[i] = gridCell(x[i], y[i]);
        speedSum += (vx[i] < 0 ? -vx[i] : vx[i]) + (vy[i] < 0 ? -vy[i] : vy[i]);
    }
    fleet.count = n;
    fleet.avgSpeed = n > 0 ? ((speedSum / n) | 0) : 0;
    fleet.rev = frame;                            // one coarse commit per frame
    return fleet.rev | 0;
}
// #endregion cookbook:r9.3

// --- CB-A5: static-cost invariance across entity count -----------------------

// Measure the shape ONCE on the default-registry probe (never on a class bound
// to a tightly-sized world -- costOf constructs its own probe instance and would
// overflow a world already holding a live fleet).
const EXPECTED_NODES = costOf(fleetProbe).nodes;  // P(3) + D(1) + E(1) + 1 = 6
assert(EXPECTED_NODES === 6, "unexpected fleet node count: " + EXPECTED_NODES);

function activeNodesForFleetOf(n) {
    const a = new Arena(Math.max(1, n));
    const comp = a.registerComponent({ x: Float32Array, y: Float32Array, vx: Float32Array, vy: Float32Array });
    for (let k = 0; k < n; k++) {
        const e = a.spawn();
        const i = comp.add(e);
        comp.data.x[i] = k & 31; comp.data.vx[i] = (k & 3) - 1;
    }
    const world = createRegistry(capacityFor([[fleetProbe, 1]]));
    const F = defineReactive(class FleetN {}, { host: { registry: world }, ...FLEET_SPEC });
    const fl = new F();
    fl.count = comp.count; fl.avgSpeed = 0; fl.rev = 1;
    void fl.status;                               // force the lazy derived's node
    const active = world.stats().activeNodes;
    disposeReactive(fl);
    return active;
}

const a5 = [0, 1, 1000, 100000].map(activeNodesForFleetOf);
for (let k = 0; k < a5.length; k++) {
    assert(a5[k] === EXPECTED_NODES, "activeNodes " + a5[k] + " != " + EXPECTED_NODES + " (CB-A5)");
}

// --- CB-A4: retention over 1000 spawn/kill cycles at N=256 -------------------

const CHURN_N = 256;
const CHURN_CYCLES = 1000;

const leaks = [];
const warns = [];
const tracker = createLeakTracker({
    name: "r9",
    onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
    onWarning: (w) => warns.push(w.kind + ":" + w.reason),
});
tracker.registerKernel(createOwnerCascadeOrphanKernel());
tracker.registerKernel(createObserverOrphanKernel());
function release() {}
const AUDIT = { audit: true };

import { effect } from "@zakkster/lite-signal";

const churnArena = new Arena(CHURN_N);
const churnMotion = churnArena.registerComponent({ x: Float32Array, y: Float32Array, vx: Float32Array, vy: Float32Array });
const churnWorld = createRegistry(capacityFor([[fleetProbe, 1]]));
const FleetChurn = defineReactive(class FleetChurn {}, { host: { registry: churnWorld }, ...FLEET_SPEC });

// Warm the pools out of the baseline, then snapshot the floor.
{
    const warm = new FleetChurn();
    warm.count = 0; warm.rev = 1; void warm.status;
    disposeReactive(warm);
}
const churnBaseline = churnWorld.stats().activeNodes;
const poolGrowthsBaseline = churnWorld.stats().poolGrowths;

for (let c = 0; c < CHURN_CYCLES; c++) {
    for (let k = 0; k < CHURN_N; k++) {
        const e = churnArena.spawn();
        const i = churnMotion.add(e);
        churnMotion.data.x[i] = k & 31;
        churnMotion.data.vx[i] = (k & 3) - 1;
    }
    const fl = new FleetChurn();
    fl.count = churnMotion.count;
    fl.rev = c;
    void fl.status;
    // Track from a default-registry effect so reclamation is deterministic;
    // the cleanup and tag close over nothing (suite held-value contract).
    const stop = effect(() => { tracker.track(fl, release, c & 255, AUDIT); });
    for (let k = churnMotion.count - 1; k >= 0; k--) churnArena.despawn(churnMotion.dense[k]);
    disposeReactive(fl);
    stop();
}

await settle();
globalThis.gc?.();
await settle();

const churnLive = tracker.size();
const churnFindings = tracker.audit();
const churnAfter = churnWorld.stats();
assert(warns.length === 0, "CB-A4 kernel warnings: " + warns.join(","));
assert(churnFindings.length === 0, "CB-A4 audit findings: " + churnFindings.length);
assert(churnLive === 0, "CB-A4 tracker retained " + churnLive + " handle(s)");
assert(churnAfter.activeNodes === churnBaseline, "CB-A4 activeNodes " + churnAfter.activeNodes + " != baseline " + churnBaseline);
assert(churnAfter.poolGrowths - poolGrowthsBaseline === 0, "CB-A4 poolGrowths grew by " + (churnAfter.poolGrowths - poolGrowthsBaseline));

// --- the S1 gate on the tick loop --------------------------------------------

const OPS = 200000;
const WARMUP = 20000;
const BREAK = process.env.COOKBOOK_BREAK === "r9";
let breakSink = 0;

// The sabotage hook lives in the HARNESS, never in a published region: under
// COOKBOOK_BREAK it allocates one object per op, and the minor gate must catch it.
function measured(frame) {
    const r = tick(frame);
    if (BREAK) { const junk = new Array(1024); junk[0] = frame; breakSink += junk[0]; }
    return r;
}

async function gcWindow(fn, rules) {
    let sink = 0;
    for (let i = 0; i < WARMUP; i++) sink += fn(i) | 0;
    const gc = new GcProfiler().start();
    for (let i = 0; i < OPS; i++) {
        sink += fn(i) | 0;
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    if (sink === -0x7fffffff) process.stdout.write("");   // anti-DCE
    await settle();
    const s = gc.summary();
    gc.stop();
    return { s, report: checkNoGc(s, rules) };
}

// Spawn the measured fleet, then measure. Control floor first (a known
// zero-alloc body in THIS process), so the minor limit is never hardcoded.
spawnFleet(CHURN_N);
const control = await gcWindow((i) => (i & 7), { maxMajor: 0, maxPauseMs: 4 });
const MINOR_LIMIT = control.s.gc.minor + 128;

const bytesPerOp = measureOps(measured, { ops: OPS, warmup: WARMUP, stabilize: true }).bytesPerOp;
const gated = await gcWindow(measured, { maxMajor: 0, maxMinor: MINOR_LIMIT, maxPauseMs: 4 });

assert(gated.report.verdict === "pass",
    "S1 gate violated: " + JSON.stringify(gated.report.violations) +
    " (minor=" + gated.s.gc.minor + " limit=" + MINOR_LIMIT + ")");
assert(gated.s.gc.major === 0, "gate: gc.major " + gated.s.gc.major + " != 0");
assert(gated.s.gc.maxMs <= 4.0, "gate: maxPauseMs " + gated.s.gc.maxMs.toFixed(2) + " > 4.0");
assert(bytesPerOp <= 0.589, "gate: bytes/op " + bytesPerOp + " > 0.589");

// Teardown.
disposeReactive(fleet);

process.stdout.write(
    "cookbook r9 two-plane-fleet | nodes=" + EXPECTED_NODES +
    " a5=[" + a5.join(",") + "] churn=" + CHURN_CYCLES + "x" + CHURN_N +
    " size=0 | gc major=" + gated.s.gc.major + " minor=" + gated.s.gc.minor +
    "/" + MINOR_LIMIT + " maxMs=" + gated.s.gc.maxMs.toFixed(2) +
    " bytes/op=" + bytesPerOp.toFixed(3) + " | ok\n",
);
