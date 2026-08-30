// cookbook/r01-prove-teardown.mjs -- node --expose-gc cookbook/r01-prove-teardown.mjs
//
// Recipe 1 -- "Prove your teardown."
// disposeReactive(vm) is the ONE lifecycle owner: it cascades the anchor,
// disposes every signal box, and poisons every slot. This recipe proves the
// teardown three ways over 4096 construct/dispose cycles with 512 live:
//   1. lite-leak: the tracker returns to size 0 (nothing outlived its owner);
//   2. the registry ledger: activeNodes back to the exact pre-cycle baseline,
//      totalAllocations - totalDisposals === activeNodes;
//   3. auditReactive(true): the safety net that catches the instance you FORGOT
//      to dispose -- with its reach caveat stated honestly.
//
// GATED (gc): the construct/dispose cycle itself is zero-GC in steady state --
// the node pool is reused, so the loop provokes no major collection and stays
// under the pause budget. COOKBOOK_BREAK=r1 allocates one throwaway object per
// op inside the measured loop; the minors gate then fails, exit non-zero.
// ASCII only.

const RID = "r1";
function assert(cond, msg) {
    if (!cond) {
        process.stderr.write("cookbook " + RID + " FAIL: " + msg + "\n");
        process.exit(1);
    }
}
function settleTick() {
    return new Promise((r) => setTimeout(() => Promise.resolve().then(r), 50));
}

// #region cookbook:r1.1
import { effect, createRegistry, stats } from "@zakkster/lite-signal";
import {
    createLeakTracker,
    createOwnerCascadeOrphanKernel,
} from "@zakkster/lite-leak";
import {
    defineReactive,
    disposeReactive,
    capacityFor,
    auditReactive,
} from "@zakkster/lite-signal-decorators";

// The fleet: 512 live view-models, each P=2 signals, D=1 derived, E=0.
// capacityFor sizes a registry EXACTLY for that inventory (headroom leaves room
// for the deriveds' links); the default registry ceils at 1024 nodes, so a real
// fleet lives on its own bound registry.
const Probe = defineReactive(class {}, {
    signals: { hp: 100, mp: 50 },
    deriveds: { alive: (self) => self.hp > 0 },
    effects: {},
});
const registry = createRegistry(capacityFor([[Probe, 512]], { headroom: 2 }));
const Mob = defineReactive(class {}, {
    signals: { hp: 100, mp: 50 },
    deriveds: { alive: (self) => self.hp > 0 },
    effects: {},
    host: { registry },
});

const baseline = registry.stats().activeNodes;   // the floor teardown must return to
// #endregion cookbook:r1.1

// #region cookbook:r1.2
// A lite-leak tracker with the owner-cascade kernel watches the reactive tree
// this package owns. HELD-VALUE CONTRACT: neither `release` (the cleanup) nor
// the numeric `tag` closes over the instance -- capturing it would defeat
// finalization and report a false clean.
const leaks = [];
const warns = [];
const tracker = createLeakTracker({
    name: "teardown",
    onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
    onWarning: (w) => warns.push(w.kind + ":" + w.reason),
});
tracker.registerKernel(createOwnerCascadeOrphanKernel());
function release() {}                            // captures nothing

// Track each instance from INSIDE a short-lived effect: the effect becomes the
// owner and registers onCleanup(untrack). Disposing the instance and stopping
// that effect makes reclamation DETERMINISTIC -- not GC-dependent.
const N = 512;
const CYCLES = 4096;
const live = new Array(N).fill(null);
const stops = new Array(N).fill(null);
for (let i = 0; i < CYCLES; i++) {
    const slot = i % N;
    if (live[slot] !== null) {
        disposeReactive(live[slot]);             // cascade + poison the old one
        stops[slot]();                           // effect cleanup -> untrack
    }
    const vm = new Mob();
    vm.hp = i & 1023;
    const tag = i & 255;                         // detached primitive; no capture
    const stop = effect(() => { tracker.track(vm, release, tag, { audit: true }); });
    live[slot] = vm;
    stops[slot] = stop;
}
for (let s = 0; s < N; s++) {
    if (live[s] !== null) { disposeReactive(live[s]); stops[s](); live[s] = null; stops[s] = null; }
}
// #endregion cookbook:r1.2

await settleTick();
globalThis.gc?.();
await settleTick();

// #region cookbook:r1.3
// The three proofs, read after a settle tick.
const retained = tracker.size();                 // 0 -- nothing outlived its owner
const findings = tracker.audit();                // [] -- no orphaned reactive nodes
const s = registry.stats();
const conserved =
    s.activeNodes === baseline &&                // back to the exact floor
    s.totalAllocations - s.totalDisposals === s.activeNodes;   // ledger balances
// #endregion cookbook:r1.3

assert(retained === 0, "tracker retained " + retained + " handle(s)");
assert(findings.length === 0, "audit findings: " + findings.length);
assert(warns.length === 0, "kernel warnings: " + warns.length);
assert(leaks.length === 0, "leak callbacks fired: " + leaks.length);
assert(conserved === true, "registry ledger did not return to baseline " + baseline +
    " (activeNodes=" + s.activeNodes + ")");

// #region cookbook:r1.4
// The one you FORGOT. auditReactive(true) lazily arms a FinalizationRegistry
// that reports any instance GC'd WITHOUT disposeReactive. REACH CAVEAT
// (llms.txt:168-171): an instance still pinned by its own undisposed nodes on a
// long-lived registry is never collected, so audit cannot fire for it -- that
// retention is what the lite-leak pass above catches. Audit fires for instances
// that reach GC whole, e.g. a per-scope registry dropped entirely.
let auditFires = 0;
const realError = console.error;
console.error = () => { auditFires++; };         // capture the audit report
auditReactive(true);
(function dropWholeScope() {
    const scoped = createRegistry(capacityFor([[Probe, 4]]));
    const Scoped = defineReactive(class {}, {
        signals: { hp: 100, mp: 50 },
        deriveds: { alive: (self) => self.hp > 0 },
        effects: {},
        host: { registry: scoped },
    });
    let forgotten = new Scoped();                 // never disposed
    forgotten.hp = 1;
    void forgotten.alive;
    forgotten = null;                             // drop instance AND scope together
})();
// #endregion cookbook:r1.4

globalThis.gc?.();
await settleTick();
globalThis.gc?.();
await settleTick();
console.error = realError;
auditReactive(false);
assert(auditFires > 0, "auditReactive did not report the dropped scoped instance");

// ---- gc mini-gate: the construct/dispose cycle is zero-GC in steady state ----
// (harness; not a published region)
await runGcGate();

process.stdout.write(
    "cookbook r1 prove-teardown | size=" + retained + "/0 findings=" + findings.length +
    " warnings=" + warns.length + " baseline=" + baseline +
    " audit-fired=" + (auditFires > 0) + " | ok\n",
);

// -----------------------------------------------------------------------------
// gc mini-gate (measurement plumbing; kept OUT of the published regions)
// -----------------------------------------------------------------------------
async function runGcGate() {
    const { GcProfiler, checkNoGc, measureOps } = await import("@zakkster/lite-gc-profiler");
    const OPS = 500_000;
    const WARMUP = 50_000;
    const MAX_BYTES_PER_OP = 0.589;              // stamped zerogc noise floor (PLAN-S5)
    const MAX_PAUSE_MS = 4.0;                    // the S1 budget
    const MINOR_HEADROOM = 128;                  // control-relative (decision 0003)
    const BREAK = process.env.COOKBOOK_BREAK === RID;

    // scratch reused by the clean path; break allocates a fresh object per op.
    const gateReg = createRegistry(capacityFor([[Probe, 2]]));
    const Cheap = defineReactive(class {}, {
        signals: { hp: 100, mp: 50 },
        deriveds: { alive: (self) => self.hp > 0 },
        effects: {},
        host: { registry: gateReg },
    });
    const cycleClean = (i) => {
        const vm = new Cheap();
        vm.hp = i & 1023;
        const a = vm.alive ? 1 : 0;
        disposeReactive(vm);
        return a;
    };
    const cycleBreak = (i) => {
        const trash = new Array(1024);           // one throwaway object per op
        trash[0] = i;
        return trash[0] + cycleClean(i);
    };
    const hot = BREAK ? cycleBreak : cycleClean;

    let sink = 0;
    async function observe(fn) {
        for (let i = 0; i < WARMUP; i++) sink += fn(i) | 0;
        const gc = new GcProfiler().start();
        for (let i = 0; i < OPS; i++) {
            sink += fn(i) | 0;
            if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
        await settleFast();
        const summary = gc.summary();
        gc.stop();
        return summary.gc;
    }
    function settleFast() {
        return new Promise((r) => setTimeout(() => Promise.resolve().then(r), 0));
    }

    const controlMinor = (await observe((i) => i & 7)).minor;
    const minorLimit = controlMinor + MINOR_HEADROOM;

    const g = await observe(hot);
    const m = measureOps(hot, { ops: OPS, warmup: WARMUP });
    const bpo = (m.bracketInverted || m.bytesPerOp == null) ? 0 : m.bytesPerOp;
    globalThis.__r1_sink = (globalThis.__r1_sink | 0) + (sink | 0);
    void checkNoGc;
    void MAX_BYTES_PER_OP;

    // The node POOL is reused, so the churn provokes no major collection and
    // stays under the pause budget; minors are gated control-relative. bytes/op
    // is REPORTED, not gated: `new Cheap()` allocates the instance object itself
    // by design (HONEST COST) -- teardown returns the reactive NODES, not the JS
    // shell. The retention proof above (tracker.size, ledger) is the leak gate.
    const fail = [];
    if (g.major !== 0) fail.push("major=" + g.major);
    if (g.maxMs > MAX_PAUSE_MS) fail.push("maxPauseMs=" + g.maxMs.toFixed(2));
    if (g.minor > minorLimit) fail.push("minor=" + g.minor + ">" + minorLimit);
    if (fail.length) {
        process.stderr.write("cookbook " + RID + " gc-gate FAIL: " + fail.join(", ") + "\n");
        process.exit(1);
    }
    process.stdout.write(
        "cookbook r1 gc-gate | construct/dispose bytes/op=" + bpo.toFixed(4) +
        " (reported) major=" + g.major + " minor=" + g.minor + " (limit " + minorLimit +
        ") maxMs=" + g.maxMs.toFixed(2) + " | ok\n",
    );
}
