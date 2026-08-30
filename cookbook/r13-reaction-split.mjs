// cookbook/r13-reaction-split.mjs -- node --expose-gc cookbook/r13-reaction-split.mjs
//
// Recipe 13 (Working, GATED): react to a computed value, not every write. Stamp
// 2026-08-30. MobX's reaction(dataFn, effectFn) shape: an effect whose body
// reads ONLY a @derived selector, so it fires when the SELECTOR changes, not on
// every raw write; fireImmediately and delay expressed through {scheduler}.
// Snippets live in `#region cookbook:r13.k` spans; the harness (gate + asserts +
// summary) is OUTSIDE them.
//
// THE GATE: the measured steady-state loop -- raw writes propagating through the
// selector to the effect -- meets the S1 budget (gc.major === 0, maxPauseMs <=
// 4.0, bytes/op <= 0.589, minors <= an in-process zero-alloc control + 128).
// COOKBOOK_BREAK=r13 allocates one object per op in the measured loop -> FAIL.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

import { GcProfiler, checkNoGc, measureOps } from "@zakkster/lite-gc-profiler";

function fail(msg) {
    process.stderr.write("cookbook r13 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }
function settle() {
    return new Promise((r) => { setTimeout(() => { Promise.resolve().then(r); }, 0); });
}

let reactions = 0;

// #region cookbook:r13.1
import { defineReactive, disposeReactive } from "@zakkster/lite-signal-decorators";

// MobX reaction(dataFn, effectFn): the effect body reads ONLY a derived SELECTOR,
// so it fires when the SELECTOR value changes -- not on every raw write. Here the
// selector buckets a raw counter into 16-wide bands; fifteen of every sixteen
// writes leave the band unchanged and the reaction stays SILENT. That is the
// whole point: you react to a computed value, not to every mutation underneath it.
const Meter = defineReactive(class Meter {}, {
    signals: { raw: 0 },
    deriveds: { band: (vm) => vm.raw >> 4 },              // the selector: derived, memoised
    effects: {
        onBand: (vm) => { void vm.band; reactions++; },   // reads the selector, nothing raw
    },
});
const meter = new Meter();      // fireImmediately: the auto-effect runs once at wiring
// #endregion cookbook:r13.1

assert(reactions === 1, "the reaction did not fire immediately at wiring: " + reactions);
const beforeBurst = reactions;
for (let i = 1; i <= 16; i++) meter.raw = i;    // 16 raw writes, band 0 -> 1 exactly once
assert(reactions - beforeBurst === 1, "reaction fired on a raw write that did not move the selector: " + (reactions - beforeBurst));

// #region cookbook:r13.2
// fireImmediately and delay are expressed through the effect's {scheduler}. The
// scheduler receives the engine's flush thunk: call it now for a synchronous
// run, or defer it (queueMicrotask / setTimeout / a frame clock) to coalesce a
// burst into one trailing reaction. Here a microtask scheduler batches a write
// storm into a single delayed run instead of one run per write.
let scheduled = 0;
const Debounced = defineReactive(class Debounced {}, {
    signals: { raw: 0 },
    deriveds: { band: (vm) => vm.raw >> 4 },
    effects: {
        onBand: {
            run: (vm) => { void vm.band; },
            scheduler: (flush) => { scheduled++; queueMicrotask(flush); },
        },
    },
});
const debounced = new Debounced();
debounced.raw = 100;            // one selector change -> one scheduled (deferred) run
// #endregion cookbook:r13.2

assert(scheduled >= 1, "the scheduler was never invoked: " + scheduled);
await settle();

// --- the S1 gate on the selector -> effect propagation loop -------------------

const OPS = 200000;
const WARMUP = 20000;
const BREAK = process.env.COOKBOOK_BREAK === "r13";
let breakSink = 0;

// The measured op writes the raw member; the derived selector recomputes lazily
// and the effect fires only on a band change -- the reaction split, per op. The
// sabotage hook lives in the HARNESS, never in a published region.
function measured(i) {
    meter.raw = i;                                 // raw write propagates through the selector
    if (BREAK) { const junk = new Array(1024); junk[0] = i; breakSink += junk[0]; }
    return meter.band | 0;
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

const bytesPerOp = measureOps(measured, { ops: OPS, warmup: WARMUP, stabilize: true }).bytesPerOp;
const gated = await gcWindow(measured, { maxMajor: 0, maxMinor: MINOR_LIMIT, maxPauseMs: 4 });

assert(gated.report.verdict === "pass",
    "S1 gate violated: " + JSON.stringify(gated.report.violations) +
    " (minor=" + gated.s.gc.minor + " limit=" + MINOR_LIMIT + ")");
assert(gated.s.gc.major === 0, "gate: gc.major " + gated.s.gc.major + " != 0");
assert(gated.s.gc.maxMs <= 4.0, "gate: maxPauseMs " + gated.s.gc.maxMs.toFixed(2) + " > 4.0");
assert(bytesPerOp !== null && bytesPerOp <= 0.589, "gate: bytes/op " + bytesPerOp + " > 0.589");

disposeReactive(meter);
disposeReactive(debounced);

process.stdout.write(
    "cookbook r13 reaction-split | fire-immediately=1 burst-writes=16 reactions=" + reactions +
    " scheduled=" + scheduled +
    " | gc major=" + gated.s.gc.major + " minor=" + gated.s.gc.minor +
    "/" + MINOR_LIMIT + " maxMs=" + gated.s.gc.maxMs.toFixed(2) +
    " bytes/op=" + bytesPerOp.toFixed(3) + " | ok\n",
);
