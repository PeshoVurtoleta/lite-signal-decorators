// test/torture.mjs -- node --expose-gc test/torture.mjs
//
// Package-level gate for @zakkster/lite-signal-decorators. Phase 1 proves an
// explicitly-disposed reactive instance is fully reclaimed (no retention past
// its owner) -- the AUTHORITY is FINALIZATION: each vm is tracked OUTSIDE its
// owner (no auto-untrack) and reclamation is proven by tracker.size() <= RES
// after a HARD settle, never by an untrack counter. Phase 2 proves the
// accessor/derived hot path allocates nothing and provokes no major GC. Both
// phases drive the REAL package entries through a faithful Stage-3 mini-emitter --
// the same code path a transpiler generates.
//
// TORTURE_LEAK=1 pins every disposed vm in a module sink so it can NEVER
// finalize -> residual ~= CYCLES -> the phase-1 gate trips RED (the RED control).
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import { createLeakTracker } from '@zakkster/lite-leak';
import { createRoot, effect } from '@zakkster/lite-signal';

import {
  reactive,
  derived,
  reactiveHost,
  disposeReactive,
  boxOf,
  rootOf,
} from '../SignalDecorators.js';

// --- Faithful Stage-3 mini-emitter (mimics TS/Babel standard emit) -----------
// Member decorators applied in source order; accessor get/set installed on the
// prototype; init captured; class wrapped by reactiveHost's result. Per-instance
// construction: addInitializer callbacks (L3) then init calls in declaration
// order with `this` bound (L2), then the wrapper's most-derived wiring.

function defineAccessor(C, inits, fieldInits, name, value, opts) {
  const ctx = {
    kind: 'accessor',
    name,
    static: false,
    private: false,
    addInitializer(fn) { inits.push(fn); },
  };
  const target = { get() {}, set() {} };
  const dec = opts === undefined ? reactive : reactive(opts);
  const res = dec(target, ctx);
  Object.defineProperty(C.prototype, name, {
    get: res.get, set: res.set, enumerable: true, configurable: true,
  });
  fieldInits.push({ init: res.init, value });
}

function defineDerived(C, inits, name, getter, opts) {
  const ctx = {
    kind: 'getter',
    name,
    static: false,
    private: false,
    addInitializer(fn) { inits.push(fn); },
  };
  const dec = opts === undefined ? derived : derived(opts);
  const res = dec(getter, ctx);
  Object.defineProperty(C.prototype, name, {
    get: res, enumerable: true, configurable: true,
  });
}

function buildVMClass() {
  const inits = [];
  const fieldInits = [];
  class C {
    constructor() {
      for (let i = 0; i < inits.length; i++) inits[i].call(this);
      for (let i = 0; i < fieldInits.length; i++) {
        const f = fieldInits[i];
        f.init.call(this, f.value);
      }
    }
  }
  defineAccessor(C, inits, fieldInits, 'count', 0, undefined);
  defineAccessor(C, inits, fieldInits, 'step', 0, undefined);
  defineDerived(C, inits, 'sum', function () { return this.count + this.step; }, undefined);
  return reactiveHost(C, { kind: 'class', name: 'TortureVM' });
}

const VM = buildVMClass();

const CYCLES = 4096;
const HOT = 400000;
// AUTHORITY residual ceiling: single digits are expected on a clean run; a real
// leak leaves ~CYCLES. Finalization is nondeterministic, so the gate is `<= RES`,
// never `=== 0`.
const RES = Math.max(16, (CYCLES / 1000) | 0);
const warns = [];

// PLAIN tracker: no kernels, no onLeak. Finalization is the release path, so a
// held-but-uncollected object must NOT be flagged, and onLeak (which fires on
// COLLECTION, kind 'unknown') is not a leak signal for this pattern. onWarning
// stays -- a warning is a real finding.
const tracker = createLeakTracker({
  name: 'torture',
  onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});

// RED control (TORTURE_LEAK=1): pin every disposed vm in this module sink so it
// can NEVER finalize -> residual ~= CYCLES -> the phase-1 gate trips RED.
const RETAIN = process.env.TORTURE_LEAK === '1';
const __leakSink = [];

// ---- phase 1: retention torture ------------------------------------------
// The VM anchor is DETACHED (createRoot in wireInstance), so the parent effect's
// disposal does NOT cascade the VM (DV-1). disposeReactive is the only lifecycle
// owner. AUTHORITY = FINALIZATION: capture the vm inside the owner, then track it
// AFTER the owner scope closes so getOwner() is undefined at the track site and
// lite-leak arms NO auto-untrack. The disposed vm's only strong ref is then the
// tracker's WeakRef, so it must be reclaimed -- unless a real leak (or the RED
// pin) retains it.
//
// (An earlier version tracked from INSIDE the effect and relied on stop() to
// drive size() to 0 -- a VARIANT-2 VACUOUS gate: the auto-registered
// onCleanup(untrack) zeroed size() by construction even if the vm were retained.)
for (let i = 0; i < CYCLES; i++) {
  let captured = null;
  createRoot(() => {
    const stop = effect(() => {
      const vm = new VM();
      vm.count = i & 1023;
      const seen = vm.sum;                 // exercise derived recompute
      if (seen === -1) console.log('unreachable');
      captured = vm;                       // hoist the ref OUT of the owner
      disposeReactive(vm);                 // explicit teardown, allocation-free
    });
    stop();                                // effect is detached; dispose it too
  });
  tracker.track(captured, noopRelease, i & 255);   // track OUTSIDE any owner
  if (RETAIN) __leakSink.push(captured);   // RED: pin -> never finalizes
  captured = null;
}

function noopRelease() {}

// Settle HARD: FinalizationRegistry callbacks fire only after a collection AND a
// macrotask; loop until the residual reaches the ceiling or the budget is spent.
for (let k = 0; k < 40; k++) {
  globalThis.gc?.();
  await new Promise((r) => setTimeout(r, 15));
  if (tracker.size() <= RES) break;
}
// Keep the RED sink live ACROSS the settle (V8 liveness-elides a module array
// written-but-never-read after the loop, masking the pin).
if (__leakSink.length === -1) console.log('unreachable');

const live = tracker.size();
const findings = tracker.audit();

// ---- phase 2: allocation + GC torture ------------------------------------
const gc = new GcProfiler().start();

const inst = new VM();
let sink = 0;
for (let i = 0; i < HOT; i++) {
  inst.count = i & 1023;                   // makeSet -> box.set
  sink += inst.sum;                        // makeDerivedGet -> recompute (makeGet x2)
  if ((i & 8191) === 0) {
    gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
  }
}
if (sink === -1) console.log('unreachable');
// Keep the introspection surface reachable and exercised post-loop.
boxOf(inst, 'count');
rootOf(inst);
disposeReactive(inst);

await new Promise((r) => setTimeout(r, 50));
const s = gc.summary();
const report = checkNoGc(s, { maxMajor: 0, maxPauseMs: 4 });
gc.stop();

const ok = report.ok && live <= RES && findings.length === 0 && warns.length === 0;
console.log(
  'GATE AUTHORITY residual=size ' + live + '/' + RES + ' findings=' + findings.length +
  ' warnings=' + warns.length +
  ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
  ' maxMs=' + s.gc.maxMs.toFixed(2) +
  ' | ' + (ok ? 'ok' : 'FAIL')
);
if (!ok) {
  if (live > RES) console.error('  residual ' + live + ' > ' + RES + ' -- instance(s) outlived disposal');
  for (const v of report.violations) {
    console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
  }
  for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
  process.exitCode = 1;
}
