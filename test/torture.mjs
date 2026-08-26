// test/torture.mjs -- node --expose-gc test/torture.mjs
//
// Package-level gate for @zakkster/lite-signal-decorators. Phase 1 proves an
// explicitly-disposed reactive instance is fully reclaimed (no retention past
// its owner); phase 2 proves the accessor/derived hot path allocates nothing
// and provokes no major GC. Both phases drive the REAL package entries through
// a faithful Stage-3 mini-emitter -- the same code path a transpiler generates.
import { GcProfiler, checkNoGc } from '@zakkster/lite-gc-profiler';
import {
  createLeakTracker,
  createOwnerCascadeOrphanKernel,
  createObserverOrphanKernel,
  createAsyncRetentionKernel,
} from '@zakkster/lite-leak';
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
const leaks = [];
const warns = [];

const tracker = createLeakTracker({
  name: 'torture',
  onLeak: (r) => leaks.push(r.kind + ':' + String(r.tag)),
  onWarning: (w) => warns.push(w.kind + ':' + w.reason),
});
// Only the surfaces this package touches: the reactive owner tree (cascade
// orphans), graph observers, and async retention. This package patches no
// timer/listener/DOM surface, so those kernels are not registered.
tracker.registerKernel(createOwnerCascadeOrphanKernel());
tracker.registerKernel(createObserverOrphanKernel());
tracker.registerKernel(createAsyncRetentionKernel());

// ---- phase 1: retention torture ------------------------------------------
// The VM anchor is DETACHED (createRoot in wireInstance), so the parent effect's
// disposal does NOT cascade the VM (DV-1). disposeReactive is the only lifecycle
// owner -- call it, drop the reference, and the instance must be reclaimed.
for (let i = 0; i < CYCLES; i++) {
  createRoot(() => {
    const stop = effect(() => {
      const vm = new VM();
      vm.count = i & 1023;
      const seen = vm.sum;                 // exercise derived recompute
      const tag = 'vm#' + (seen & 255);    // detached primitive; no capture of vm
      tracker.track(vm, noopRelease, tag, { audit: true });
      disposeReactive(vm);                 // explicit teardown, allocation-free
    });
    stop();                                // effect is detached; dispose it too
  });
}

function noopRelease() {}

globalThis.gc?.();
await new Promise((r) => setTimeout(r, 50));

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

const ok = report.ok && live === 0 && leaks.length === 0 && findings.length === 0;
console.log(
  'GATE leak=size ' + live + '/0 findings=' + findings.length +
  ' warnings=' + warns.length +
  ' | gc major=' + s.gc.major + ' minor=' + s.gc.minor +
  ' maxMs=' + s.gc.maxMs.toFixed(2) +
  ' | ' + (ok ? 'ok' : 'FAIL')
);
if (!ok) {
  for (const v of report.violations) {
    console.error('  violation ' + v.metric + ' limit=' + v.limit + ' actual=' + v.actual);
  }
  for (const f of findings) console.error('  finding ' + f.kind + ':' + f.reason);
  for (const l of leaks) console.error('  leak ' + l);
  process.exitCode = 1;
}
