// cookbook/r17-on-observed.mjs -- node --expose-gc cookbook/r17-on-observed.mjs
//
// Recipe 17 (Pro, GATED): start the resource when someone is watching. Stamp
// 2026-08-30. MobX's onBecomeObserved / onBecomeUnobserved over the installed
// peer's observeObservers: a resource that starts on the FIRST observer of
// boxOf(vm, key) and stops on the LAST. Snippets live in `#region cookbook:r17.k`
// spans; the harness (pinned gotcha + retention + gate + summary) is OUTSIDE them.
//
// THE GATE: 4096 observe/unobserve transitions retain nothing -- tracker.size()
// === 0, bound-world activeNodes back to the exact baseline, poolGrowths delta 0,
// start/stop counts EXACTLY paired -- and the measured steady-state toggle loop
// meets the S1 budget (gc.major === 0, maxPauseMs <= 4.0, bytes/op <= 0.589,
// minors <= an in-process zero-alloc control + 128).
// COOKBOOK_BREAK=r17 allocates one object per op in the measured loop -> FAIL.
//
// PINNED GOTCHA (proven by assertion, not comment): a transition is driven by a
// REAL tracked read, never by construction alone. Building the VM and calling
// observeObservers fire nothing; the FIRST effect that reads the member fires
// onConnect, and disposing it fires onDisconnect.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

import { GcProfiler, checkNoGc, measureOps } from "@zakkster/lite-gc-profiler";
import {
    createLeakTracker,
    createOwnerCascadeOrphanKernel,
    createObserverOrphanKernel,
} from "@zakkster/lite-leak";

function fail(msg) {
    process.stderr.write("cookbook r17 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }
function settle() {
    return new Promise((r) => { setTimeout(() => { Promise.resolve().then(r); }, 0); });
}

let running = false;
let starts = 0;
let stops = 0;

// #region cookbook:r17.1
import { observeObservers, effect } from "@zakkster/lite-signal";
import { defineReactive, boxOf, disposeReactive } from "@zakkster/lite-signal-decorators";

// Start a resource when the FIRST observer appears and stop it when the LAST one
// leaves -- MobX's onBecomeObserved / onBecomeUnobserved, over the installed
// peer's observeObservers. boxOf(vm, key) is the handle the hooks attach to; they
// fire on the 0->1 and 1->0 transitions ONLY, so a second concurrent observer
// never restarts a resource that is already running.
const Feed = defineReactive(class Feed {}, {
    signals: { tick: 0 },
    deriveds: {},
    effects: {},
});
const feed = new Feed();
const tickBox = boxOf(feed, "tick");             // the handle observers attach to
const unobserve = observeObservers(tickBox, {
    onConnect: () => { running = true; starts++; },      // first watcher -> start the resource
    onDisconnect: () => { running = false; stops++; },   // last watcher gone -> stop it
});
// #endregion cookbook:r17.1

// #region cookbook:r17.2
// The pinned gotcha: a transition is driven by a REAL tracked read, never by
// construction alone. Building the VM and calling observeObservers fire nothing;
// the resource starts only when an effect actually READS the member, and stops
// when that effect disposes. A hoisted body keeps the toggle allocation-free --
// a fresh closure per cycle would allocate against the pool that reuses nodes.
const readTick = () => { void tickBox.get(); };  // a real tracked read of the member
function watchOnce() {
    const stop = effect(readTick);   // 0->1: onConnect fires, the resource starts
    stop();                          // 1->0: onDisconnect fires, the resource stops
}
// #endregion cookbook:r17.2

// --- the pinned gotcha, proven ------------------------------------------------

assert(starts === 0 && running === false, "construction alone fired onConnect (it must not)");
const liveStop = effect(readTick);
assert(running === true && starts === 1, "the first tracked read did not start the resource");
const midStop = effect(readTick);                // a second, concurrent observer
assert(starts === 1, "a concurrent second observer restarted a running resource (1->2 must not fire)");
midStop();
assert(running === true && stops === 0, "dropping one of two observers stopped the resource early");
liveStop();
assert(running === false && stops === 1, "the last observer leaving did not stop the resource");
unobserve();

// --- S7-A5 retention: 4096 observe/unobserve transitions retain nothing -------
//
// The churn runs on the DEFAULT registry: the top-level observeObservers binds
// the default world (the PD-29 wall from r10), so a box on a custom registry is
// invisible to it. Isolation is not what r17 proves -- transition pairing and
// zero retention are -- and the default ledger conserves exactly.

import { stats } from "@zakkster/lite-signal";

const TRANSITIONS = 4096;
const leaks = [];
const warns = [];
const tracker = createLeakTracker({
    name: "r17",
    onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
    onWarning: (w) => warns.push(w.kind + ":" + w.reason),
});
tracker.registerKernel(createOwnerCascadeOrphanKernel());
tracker.registerKernel(createObserverOrphanKernel());
function release() {}                            // closes over nothing (held-value contract)
const AUDIT = { audit: true };

// Warm the pools out of the baseline, then snapshot the floor.
{
    const warm = new Feed();
    const wb = boxOf(warm, "tick");
    const wu = observeObservers(wb, { onConnect: () => {}, onDisconnect: () => {} });
    const ws = effect(() => { void wb.get(); });
    ws();
    wu();
    disposeReactive(warm);
}
const baseline = stats().activeNodes;
const poolGrowthsBaseline = stats().poolGrowths;

let churnStarts = 0;
let churnStops = 0;
for (let c = 0; c < TRANSITIONS; c++) {
    const f = new Feed();
    const box = boxOf(f, "tick");
    const unob = observeObservers(box, {
        onConnect: () => { churnStarts++; },
        onDisconnect: () => { churnStops++; },
    });
    const stop = effect(() => { void box.get(); });   // 0->1 start
    stop();                                           // 1->0 stop
    unob();
    // Track from a default-registry effect so reclamation is deterministic; the
    // cleanup and tag close over nothing (suite held-value contract).
    const trackStop = effect(() => { tracker.track(f, release, c & 255, AUDIT); });
    disposeReactive(f);
    trackStop();
}

await settle();
globalThis.gc?.();
await settle();

const retained = tracker.size();
const findings = tracker.audit();
const after = stats();
assert(warns.length === 0, "A5 kernel warnings: " + warns.join(","));
assert(retained === 0, "A5 tracker retained " + retained + " handle(s)");
assert(findings.length === 0, "A5 audit findings: " + findings.length);
assert(after.activeNodes === baseline, "A5 activeNodes " + after.activeNodes + " != baseline " + baseline);
assert(after.poolGrowths - poolGrowthsBaseline === 0, "A5 poolGrowths grew by " + (after.poolGrowths - poolGrowthsBaseline));
assert(churnStarts === TRANSITIONS && churnStops === TRANSITIONS,
    "A5 start/stop counts not paired: starts=" + churnStarts + " stops=" + churnStops + " != " + TRANSITIONS);

// --- the S1 gate on the observe/unobserve toggle loop -------------------------

const OPS = 200000;
const WARMUP = 20000;
const BREAK = process.env.COOKBOOK_BREAK === "r17";
let breakSink = 0;

const gateFeed = new Feed();
const gateBox = boxOf(gateFeed, "tick");
let gateStarts = 0;
let gateStops = 0;
const gateUnobserve = observeObservers(gateBox, {
    onConnect: () => { gateStarts++; },
    onDisconnect: () => { gateStops++; },
});
const gateBody = () => { void gateBox.get(); };   // hoisted: a per-cycle closure would allocate

// The measured op creates+disposes one observing effect -- a 0->1 then 1->0
// transition -- reusing pooled nodes. The sabotage hook lives in the HARNESS,
// never in a published region.
function measured(i) {
    const stop = effect(gateBody);
    stop();
    if (BREAK) { const junk = new Array(1024); junk[0] = i; breakSink += junk[0]; }
    return gateStarts | 0;
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

const control = await gcWindow((i) => (i & 7), { maxMajor: 0, maxPauseMs: 4 });
const MINOR_LIMIT = control.s.gc.minor + 128;

const opsResult = measureOps(measured, { ops: OPS, warmup: WARMUP, stabilize: true });
const bytesPerOp = opsResult.bytesPerOp;
const gated = await gcWindow(measured, { maxMajor: 0, maxMinor: MINOR_LIMIT, maxPauseMs: 4 });

assert(gated.report.verdict === "pass",
    "S1 gate violated: " + JSON.stringify(gated.report.violations) +
    " (minor=" + gated.s.gc.minor + " limit=" + MINOR_LIMIT + ")");
assert(gated.s.gc.major === 0, "gate: gc.major " + gated.s.gc.major + " != 0");
assert(gated.s.gc.maxMs <= 4.0, "gate: maxPauseMs " + gated.s.gc.maxMs.toFixed(2) + " > 4.0");
// An inverted bracket means the steady-end anchor read BELOW the start: no
// positive per-op cost could be attributed -- a stronger result than <= the floor.
// Accept it or a measured number at or under the floor; reject anything above.
assert(opsResult.bracketInverted || (bytesPerOp !== null && bytesPerOp <= 0.589),
    "gate: bytes/op " + bytesPerOp + " > 0.589");
assert(gateStarts === gateStops, "gate: toggle transitions not paired: " + gateStarts + " != " + gateStops);

gateUnobserve();
disposeReactive(gateFeed);
disposeReactive(feed);

const bpoLabel = opsResult.bracketInverted ? "inverted(<=floor)" : bytesPerOp.toFixed(3);
process.stdout.write(
    "cookbook r17 on-observed | transitions=" + TRANSITIONS + " paired=" + churnStarts + "/" + churnStops +
    " retained=" + retained + " activeNodes=" + after.activeNodes + "/" + baseline +
    " poolGrowths-delta=" + (after.poolGrowths - poolGrowthsBaseline) +
    " | gc major=" + gated.s.gc.major + " minor=" + gated.s.gc.minor +
    "/" + MINOR_LIMIT + " maxMs=" + gated.s.gc.maxMs.toFixed(2) +
    " bytes/op=" + bpoLabel + " | ok\n",
);
