// demo/storm-lane.mjs -- node --expose-gc demo/storm-lane.mjs
//
// Dispose-storm retention lane (S5b-A2) over the DOM-free core. A standing fleet
// of N=512 on the enforced Plane A registry, then 4096 spawn/kill cycles that
// dispose one VM and reconstruct a replacement in place, each disposed instance
// tracked by lite-leak. Torture-harness law: neither `release` (cleanup) nor
// `tag` closes over the tracked instance, so finalization is never defeated;
// a settle tick precedes summary().
//
// GATE (S5b-A2): after settle, tracker.size() === 0, 0 findings, 0 warnings;
// world.stats().activeNodes returns to its exact pre-storm baseline;
// poolGrowths === 0; totalAllocations - totalDisposals === activeNodes.
//
// Also proves S5b-A4 (THE WALL) independently: registering all five Plane B
// watchers and tearing them down moves world.stats().activeNodes and
// activeLinks by EXACTLY 0.
//
// DEMO_BREAK=leak skips one dispose every 512 cycles (retaining the instance):
// tracker.size() stays above zero -- the gate that must catch it.
//
// ASCII-only.

import { effect } from "@zakkster/lite-signal";
import {
    createLeakTracker,
    createOwnerCascadeOrphanKernel,
    createObserverOrphanKernel,
} from "@zakkster/lite-leak";
import { buildNodeCore } from "./build.mjs";

const core = await import(await buildNodeCore());
const { Entity, disposeReactive, worldStats, createTelemetry } = core;

const STANDING = 512;
const CYCLES = 4096;
const LEAK_EVERY = 512;
const BREAK = process.env.DEMO_BREAK === "leak";

// --- tracker + kernels --------------------------------------------------------

const leaks = [];
const warns = [];
const tracker = createLeakTracker({
    name: "demo-storm",
    onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
    onWarning: (w) => warns.push(w.kind + ":" + w.reason),
});
// The reactive owner tree (cascade orphans) is the surface the package owns; the
// observer kernel guards a surface it does not patch, so it must stay silent.
tracker.registerKernel(createOwnerCascadeOrphanKernel());
tracker.registerKernel(createObserverOrphanKernel());

// Held-value-safe cleanup + audit options, allocated ONCE. `release` captures
// nothing; the tag passed per cycle is a primitive.
function release() {}
const AUDIT = { audit: true };

// Control retention: leaked instances + their never-stopped tracking effects.
const leakedVms = [];
const leakedStops = [];

// --- standing fleet -----------------------------------------------------------

const fleet = new Array(STANDING);
for (let i = 0; i < STANDING; i++) fleet[i] = new Entity();

const preStorm = worldStats();          // pre-storm baseline (activeNodes 512x8)
const basePoolGrowths = preStorm.poolGrowths;

// --- the storm ----------------------------------------------------------------

let sink = 0;
for (let i = 0; i < CYCLES; i++) {
    const j = i % STANDING;
    const old = fleet[j];
    const tag = i & 255;                // detached primitive; no capture
    const leak = BREAK && (i % LEAK_EVERY === 0);

    // Track from inside a default-registry effect -> owner captured,
    // onCleanup(untrack) registered (mirror of the package's leak torture).
    const stop = effect(function () {
        tracker.track(old, release, tag, AUDIT);
    });

    old.vx = i & 3;                     // exercise the hot accessor before teardown
    sink = (sink + old.speed) | 0;

    if (leak) {
        leakedVms.push(old);            // retained -> handle stays live -> size > 0
        leakedStops.push(stop);         // effect never stopped -> untrack never fires
        fleet[j] = new Entity();        // replacement; population climbs off floor
    } else {
        disposeReactive(old);           // dispose first -> peak stays at the floor
        stop();                         // effect cleanup -> untrack -> size decrements
        fleet[j] = new Entity();        // reconstruct in place
    }
}
if (sink === -1) console.log("unreachable");

// --- post-storm conservation (non-break: population back at the floor) --------

const postStorm = worldStats();

// --- teardown the standing fleet ----------------------------------------------

for (let i = 0; i < STANDING; i++) {
    disposeReactive(fleet[i]);
    fleet[i] = null;
}
const teardown = worldStats();

// --- S5b-A4: the wall, independently ------------------------------------------

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

// --- settle + retention gate --------------------------------------------------

await new Promise((r) => setTimeout(r, 50));
globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));

const live = tracker.size();
const findings = tracker.audit();

// --- verdict ------------------------------------------------------------------

const popBackToFloor = postStorm.activeNodes === preStorm.activeNodes;
const poolFlat = postStorm.poolGrowths - basePoolGrowths === 0;
const ledgerStorm = postStorm.totalAllocations - postStorm.totalDisposals === postStorm.activeNodes;
const teardownZero = teardown.activeNodes === 0;
const ledgerEnd = teardown.totalAllocations - teardown.totalDisposals === teardown.activeNodes;

const pass =
    live === 0 && findings.length === 0 && warns.length === 0 && leaks.length === 0 &&
    popBackToFloor && poolFlat && ledgerStorm && teardownZero && ledgerEnd && wallOk;

process.stdout.write(
    "demo storm-lane standing=" + STANDING + " cycles=" + CYCLES +
    " | leak=size " + live + "/0 findings=" + findings.length + " warnings=" + warns.length +
    " | preStorm nodes=" + preStorm.activeNodes + " postStorm nodes=" + postStorm.activeNodes +
    " poolGrowths=" + (postStorm.poolGrowths - basePoolGrowths) +
    " ledger=" + (postStorm.totalAllocations - postStorm.totalDisposals) +
    " | teardown nodes=" + teardown.activeNodes +
    " | wall nodesDelta=" + (wAfter.activeNodes - wBefore.activeNodes) +
    " linksDelta=" + (wAfter.activeLinks - wBefore.activeLinks) +
    " | " + (BREAK ? "BREAK " : "") + (pass ? "ok" : "FAIL") + "\n",
);

if (!pass) {
    if (live !== 0) process.stderr.write("  retained " + live + " handle(s) after settle\n");
    if (findings.length) process.stderr.write("  findings: " + findings.map((f) => f.kind + ":" + f.reason).join(",") + "\n");
    if (warns.length) process.stderr.write("  warnings: " + warns.join(",") + "\n");
    if (leaks.length) process.stderr.write("  leak callbacks: " + leaks.join(",") + "\n");
    if (!popBackToFloor) process.stderr.write("  post-storm nodes " + postStorm.activeNodes + " != baseline " + preStorm.activeNodes + "\n");
    if (!poolFlat) process.stderr.write("  poolGrowths grew by " + (postStorm.poolGrowths - basePoolGrowths) + "\n");
    if (!ledgerStorm) process.stderr.write("  post-storm ledger " + (postStorm.totalAllocations - postStorm.totalDisposals) + " != nodes " + postStorm.activeNodes + "\n");
    if (!teardownZero) process.stderr.write("  teardown nodes " + teardown.activeNodes + " != 0\n");
    if (!ledgerEnd) process.stderr.write("  teardown ledger imbalance\n");
    if (!wallOk) process.stderr.write("  WALL breached: nodesDelta=" + (wAfter.activeNodes - wBefore.activeNodes) + " linksDelta=" + (wAfter.activeLinks - wBefore.activeLinks) + "\n");
    process.exit(1);
}
