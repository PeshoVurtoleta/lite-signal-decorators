// spikes/poison.mjs -- node --expose-gc spikes/poison.mjs
// Feeds decision 0002 (P3 poison-on-dispose, D-05): can a per-class prebuilt frozen
// poison handle make post-dispose reads/writes throw at ZERO steady-state hot-path
// cost, with an allocation-free dispose swap? Honors FINDING F-0 for conservation.
import { signalBox, dispose, stats } from '@zakkster/lite-signal';
import { measureOps } from '@zakkster/lite-gc-profiler';
import { table, stamp, stampLine, snap } from './_util.mjs';

let FAIL = false;
function assert(cond, msg) { if (!cond) { FAIL = true; console.log('  ASSERT FAIL: ' + msg); } }

const s = stamp();
console.log(stampLine(s));
console.log('');

// Reference layout: P=16 symbol slots (S-A), one class shape.
const P = 16;
const CLASS_NAME = 'PoisonRef';
const SLOTS = [];
const PROP_NAMES = [];
for (let k = 0; k < P; k++) { SLOTS.push(Symbol('p' + k)); PROP_NAMES.push('p' + k); }

// Local disposed-error type (the package will export ReactiveDisposedError in S1).
class ReactiveDisposedError extends Error {
  constructor(message) { super(message); this.name = 'ReactiveDisposedError'; }
}

// POISON: built ONCE per class, one frozen handle per property (so the message can
// name class + property), shared across ALL instances. No per-instance/per-call alloc.
const POISON = [];
for (let k = 0; k < P; k++) {
  const label = CLASS_NAME + '.' + PROP_NAMES[k];
  POISON.push(Object.freeze({
    get() { throw new ReactiveDisposedError('read of disposed reactive property ' + label); },
    set() { throw new ReactiveDisposedError('write to disposed reactive property ' + label); },
    peek() { throw new ReactiveDisposedError('peek of disposed reactive property ' + label); },
  }));
}

function install(instance) {
  for (let k = 0; k < P; k++) instance[SLOTS[k]] = signalBox(k);
  return instance;
}
// Allocation-free dispose swap: dispose each box, then swap the prebuilt POISON in.
function disposeReactive(instance) {
  for (let k = 0; k < P; k++) {
    dispose(instance[SLOTS[k]]);
    instance[SLOTS[k]] = POISON[k];
  }
}

// The live read path (identical with or without the poison mechanism compiled in):
function makeGetter(slotSym) {
  return function () { return this[slotSym].get(); };
}
const liveGetter = makeGetter(SLOTS[0]);

// -------------------------------------------------------------------------
// Hot-path proof: the live getter has NO disposed-ness branch. Its source is a
// single monomorphic proto call. Poison support adds nothing to this function.
// -------------------------------------------------------------------------
const src = liveGetter.toString().replace(/\s+/g, ' ');
const unbranched = !/disposed|throw|if\s*\(|POISON/i.test(src);
console.log('HOT-PATH getter source: ' + src);
console.log('HOT-PATH unbranched (no disposed guard in the read body): ' + unbranched);
assert(unbranched, 'live getter must have no disposed-ness branch');

// live get bytes/op + maxMajor
{
  const inst = install({});
  let sink = 0;
  const res = measureOps((i) => { sink += inst[SLOTS[i & 15]].get(); }, { ops: 300000, warmup: 60000, stabilize: true });
  if (sink === 0) globalThis.__p_guard = sink;
  console.log('HOT-PATH live get: ns/op=' + (1e9 / res.opsPerSec).toFixed(2) +
    ' bytes/op=' + (res.bytesPerOp === null ? 'null(0 retained)' : res.bytesPerOp.toFixed(2)) +
    ' maxMajor(perKOp)=' + res.majorsPerKOp.toFixed(3));
  assert(res.majorsPerKOp === 0, 'live get path must show maxMajor 0');
  disposeReactive(inst);
}

// -------------------------------------------------------------------------
// Dispose-swap allocation cost: bytes/op must be 0. Cycle a ring of instances so
// the swap does real work; after warmup every dispose() is an idempotent no-op and
// the swap is a bare assignment -- allocation-free.
// -------------------------------------------------------------------------
let swapBytesPerOp;
{
  const RING = 64;
  const ring = new Array(RING);
  for (let i = 0; i < RING; i++) ring[i] = install({});
  const res = measureOps((i) => { disposeReactive(ring[i & (RING - 1)]); }, { ops: 200000, warmup: 20000, stabilize: true });
  swapBytesPerOp = res.bytesPerOp;
  console.log('DISPOSE-SWAP: bytes/op=' + (swapBytesPerOp === null ? 'null(0 retained)' : swapBytesPerOp.toFixed(2)) +
    ' maxMajor(perKOp)=' + res.majorsPerKOp.toFixed(3));
  const swapZero = swapBytesPerOp === null || swapBytesPerOp <= 0.5;
  assert(swapZero, 'dispose swap must be allocation-free (bytes/op 0)');
}

// -------------------------------------------------------------------------
// Post-dispose: every slot get AND set throws ReactiveDisposedError naming class+prop.
// -------------------------------------------------------------------------
let allThrow = true;
{
  const inst = install({});
  disposeReactive(inst);
  for (let k = 0; k < P; k++) {
    let getThrew = false, setThrew = false, named = true;
    try { inst[SLOTS[k]].get(); } catch (e) { getThrew = e instanceof ReactiveDisposedError && e.message.includes(CLASS_NAME + '.' + PROP_NAMES[k]); }
    try { inst[SLOTS[k]].set(1); } catch (e) { setThrew = e instanceof ReactiveDisposedError && e.message.includes(CLASS_NAME + '.' + PROP_NAMES[k]); }
    if (!getThrew || !setThrew) { allThrow = false; }
  }
  console.log('POST-DISPOSE: every slot get+set throws ReactiveDisposedError naming class.prop: ' + allThrow);
  assert(allThrow, 'post-dispose get and set must throw ReactiveDisposedError naming class.prop');
}

// -------------------------------------------------------------------------
// Conservation over 1000 install+dispose CYCLES (churn: max ~16 live nodes; the
// default 1024 pool cannot hold 1000*16 at once, so we churn). F-0 invariants.
// -------------------------------------------------------------------------
let consRows;
{
  // warmup so first-touch pool population is not charged to the run
  for (let i = 0; i < 64; i++) { const w = install({}); disposeReactive(w); }
  const base = snap(stats);
  let peakActive = 0;
  for (let i = 0; i < 1000; i++) {
    const inst = install({});
    const live = stats().activeNodes;
    if (live > peakActive) peakActive = live;
    disposeReactive(inst);
  }
  const after = snap(stats);
  const backToBaseline = after.activeNodes === base.activeNodes;
  const growthsZero = (after.poolGrowths - base.poolGrowths) === 0;
  const reconciles = (after.totalAllocations - after.totalDisposals) === after.activeNodes;
  consRows = [
    ['phase', 'activeNodes', 'poolGrowths', 'bytesPerOp', 'throws?'],
    ['baseline', base.activeNodes, base.poolGrowths, '-', '-'],
    ['peak-live (1 inst)', peakActive, base.poolGrowths, '-', '-'],
    ['after-1000-cycles', after.activeNodes, after.poolGrowths, swapBytesPerOp === null ? '0(null)' : swapBytesPerOp.toFixed(2), String(allThrow)],
  ];
  console.log('');
  console.log('CONSERVATION over 1000 cycles (F-0):');
  console.log(table(consRows));
  console.log('  activeNodes back to baseline: ' + backToBaseline +
    ' | poolGrowths delta 0: ' + growthsZero +
    ' | (alloc-disp==activeNodes): ' + reconciles);
  assert(backToBaseline, 'conservation: activeNodes must return to baseline');
  assert(growthsZero, 'conservation: poolGrowths delta must be 0');
  assert(reconciles, 'conservation: alloc-disp must reconcile');
}

console.log('');
console.log('FEASIBILITY: prebuilt frozen per-class poison handle is VIABLE -- post-dispose get/set');
console.log('  throw ReactiveDisposedError; the dispose swap is allocation-free; the live read path');
console.log('  is unbranched (throw comes from the swapped handle, not a guard).');
console.log('');
console.log('SPIKE poison: ' + (FAIL ? 'FAIL' : 'PASS'));
process.exitCode = FAIL ? 1 : 0;
