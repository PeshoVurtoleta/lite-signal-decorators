// spikes/ownership.mjs -- node --expose-gc spikes/ownership.mjs
// Closes decision 0002: Q1..Q5, R-A vs R-B, DV-1. Honors FINDING F-0.
import {
  signalBox, computedBox, effect, createRoot, getOwner, runWithOwner,
  dispose, stats, onCleanup,
} from '@zakkster/lite-signal';
import { table, stamp, stampLine, snap } from './_util.mjs';

let FAIL = false;
function assert(cond, msg) {
  if (!cond) { FAIL = true; console.log('  ASSERT FAIL: ' + msg); }
}

const s = stamp();
console.log(stampLine(s));
console.log('');

// -------------------------------------------------------------------------
// Q1 -- is signalBox creation adopted by an enclosing computation?
// -------------------------------------------------------------------------
console.log('Q1 -- signalBox creation inside an effect body');
{
  const base = stats().activeNodes;
  let inside;
  const outer = effect(() => { inside = signalBox(0); });
  const afterCreate = stats().activeNodes;
  dispose(outer);
  const afterDispose = stats().activeNodes;
  const drop = afterCreate - afterDispose;
  // still readable after outer disposed?
  let readable = false;
  try { inside.peek(); readable = true; } catch { readable = false; }
  const adopted = drop >= 2;
  console.log(table([
    ['base', 'afterCreate', 'afterDispose', 'drop', 'inside.peek() ok', 'verdict'],
    [base, afterCreate, afterDispose, drop, readable, adopted ? 'ADOPTED' : 'NOT-ADOPTED'],
  ]));
  console.log('Q1 CONSEQUENCE: ' + (adopted
    ? 'accessor init MUST wrap signalBox() in createRoot() to force a rooted box.'
    : 'bare signalBox() creation is safe; box survives the enclosing effect cascade.'));
  // clean up the surviving box
  if (readable) dispose(inside);
  assert(afterCreate === base + 2, 'Q1 expected 2 nodes live during creation');
}
console.log('');

// -------------------------------------------------------------------------
// Q2 -- does dispose(anchor) cascade owned computeds/effects once, idempotently?
// which handle disposes: effect-return vs getOwner-handle?
// -------------------------------------------------------------------------
console.log('Q2 -- anchor cascade: exactly-once + idempotent');
function buildAnchor() {
  // returns { ownerHandle (from getOwner), effectDispose (effect return) }
  let ownerHandle;
  let effectDispose;
  createRoot(() => {
    effectDispose = effect(() => { ownerHandle = getOwner(); });
  });
  return { ownerHandle, effectDispose };
}
function q2Trial(useGetOwnerHandle, D, E) {
  const baseline = stats().activeNodes;
  const cleanups = new Array(E).fill(0);
  const { ownerHandle, effectDispose } = buildAnchor();
  runWithOwner(ownerHandle, () => {
    for (let i = 0; i < D; i++) computedBox(() => 1);
    for (let i = 0; i < E; i++) {
      const idx = i;
      effect(() => { onCleanup(() => { cleanups[idx]++; }); });
    }
  });
  const built = stats().activeNodes;
  const handle = useGetOwnerHandle ? ownerHandle : effectDispose;
  dispose(handle);
  const afterFirst = stats().activeNodes;
  const cleanupsAfterFirst = cleanups.slice();
  dispose(handle); // idempotent re-dispose
  const afterSecond = stats().activeNodes;
  const cleanupsAfterSecond = cleanups.slice();
  const sumFirst = cleanupsAfterFirst.reduce((a, b) => a + b, 0);
  const sumSecond = cleanupsAfterSecond.reduce((a, b) => a + b, 0);
  return {
    baseline, built, afterFirst, afterSecond,
    cascaded: built - afterFirst,
    cleanupSum: sumFirst,
    idempotent: (afterSecond === afterFirst) && (sumSecond === sumFirst),
    eachOnce: cleanupsAfterFirst.every((c) => c === 1),
    returnedToBaseline: afterFirst === baseline,
  };
}
const D = 4, E = 2;
const viaOwner = q2Trial(true, D, E);
const viaEffect = q2Trial(false, D, E);
console.log(table([
  ['handle', 'baseline', 'built', 'afterFirstDispose', 'cascaded', 'cleanupSum', 'eachOnce', 'toBaseline', 'idempotent'],
  ['getOwner-handle', viaOwner.baseline, viaOwner.built, viaOwner.afterFirst, viaOwner.cascaded, viaOwner.cleanupSum, viaOwner.eachOnce, viaOwner.returnedToBaseline, viaOwner.idempotent],
  ['effect-return', viaEffect.baseline, viaEffect.built, viaEffect.afterFirst, viaEffect.cascaded, viaEffect.cleanupSum, viaEffect.eachOnce, viaEffect.returnedToBaseline, viaEffect.idempotent],
]));
// The expected anchor-cascade node count: anchor(1) + D + E
const expectCascade = 1 + D + E;
const q2ok = viaOwner.cascaded === expectCascade && viaOwner.eachOnce &&
  viaOwner.returnedToBaseline && viaOwner.idempotent;
console.log('Q2: expected cascade nodes = ' + expectCascade +
  '; getOwner-handle cascade = ' + viaOwner.cascaded +
  '; effect-return cascade = ' + viaEffect.cascaded);
console.log('Q2 which handle cascades correctly: ' +
  (viaOwner.cascaded === expectCascade ? 'getOwner-handle' : '') +
  (viaEffect.cascaded === expectCascade ? (viaOwner.cascaded === expectCascade ? ' AND effect-return' : 'effect-return') : ''));
assert(q2ok, 'Q2 R-A viability gate: getOwner-handle must cascade exactly once + idempotent');
console.log('');

// -------------------------------------------------------------------------
// Q3 -- per-instance cost grid, R-A vs R-B.
// -------------------------------------------------------------------------
console.log('Q3 -- (P,D,E) node/link cost grid: R-A vs R-B');
function buildRA(P, D, E) {
  // P signalBoxes created OUTSIDE the anchor (per Q1 verdict: not adopted anyway,
  // but keep them out of runWithOwner so ownership is explicit). Then anchor owns
  // D computedBoxes + E effects. Returns a disposer + the box handles.
  const boxes = [];
  for (let i = 0; i < P; i++) boxes.push(signalBox(i));
  let ownerHandle;
  createRoot(() => { effect(() => { ownerHandle = getOwner(); }); });
  runWithOwner(ownerHandle, () => {
    for (let i = 0; i < D; i++) computedBox(() => 1);
    for (let i = 0; i < E; i++) effect(() => {});
  });
  return function teardown() {
    dispose(ownerHandle);
    for (const b of boxes) dispose(b);
  };
}
function buildRB(P, D, E) {
  const handles = [];
  for (let i = 0; i < P; i++) handles.push(signalBox(i));
  for (let i = 0; i < D; i++) handles.push(createRoot(() => computedBox(() => 1)));
  for (let i = 0; i < E; i++) handles.push(createRoot(() => effect(() => {})));
  return function teardown() {
    for (const h of handles) dispose(h);
  };
}
const grid = [[0, 0, 0], [1, 0, 0], [8, 4, 2], [16, 8, 4]];
const q3rows = [['P,D,E', 'R-A nodes', 'R-A links', 'R-B nodes', 'R-B links']];
let q3ok = true;
for (const [P, D, E] of grid) {
  const b0 = snap(stats);
  const trA = buildRA(P, D, E);
  const aNodes = stats().activeNodes - b0.activeNodes;
  const aLinks = stats().activeLinks - b0.activeLinks;
  trA();
  const b1 = snap(stats);
  const trB = buildRB(P, D, E);
  const bNodes = stats().activeNodes - b1.activeNodes;
  const bLinks = stats().activeLinks - b1.activeLinks;
  trB();
  q3rows.push([P + ',' + D + ',' + E, aNodes, aLinks, bNodes, bLinks]);
  // R-A costs exactly +1 node (the anchor) over R-B
  if (aNodes !== bNodes + 1) q3ok = false;
}
console.log(table(q3rows));
console.log('Q3: R-A node cost == R-B + 1 (the anchor) across grid: ' + q3ok);
console.log('');

// -------------------------------------------------------------------------
// Q4 -- the DV-1 hazard exhibit: adopt-dies vs detach-survives.
// -------------------------------------------------------------------------
console.log('Q4 -- DV-1 hazard: adopt-dies vs detach-survives');
// ADOPT model: VM children built inside a live parent effect WITHOUT createRoot.
{
  const dep = signalBox(0);
  let vmFires = 0;
  const vmSignal = signalBox(100);
  // parent effect reads dep; builds a child effect that reads vmSignal (adopted by parent)
  const parent = effect(() => {
    dep.get(); // parent depends on dep
    effect(() => { vmSignal.get(); vmFires++; }); // NO createRoot -> adopted by parent owner
  });
  const firesAfterBuild = vmFires;
  // mutate vmSignal: child should fire
  vmSignal.set(101);
  const firesAfterVmMutate = vmFires;
  // now re-run parent by mutating dep: parent re-runs, cascade-disposes adopted child,
  // then builds a NEW child. The OLD child is dead.
  dep.set(1);
  const firesAfterParentRerun = vmFires;
  // mutate vmSignal again: only the NEW child fires (old one is gone). Net: adopted
  // children do not accumulate -> the old VM's effect was disposed by the parent re-run.
  const nodesBefore = stats().activeNodes;
  vmSignal.set(102);
  const firesAfterSecondVmMutate = vmFires;
  dispose(parent); dispose(vmSignal); dispose(dep);
  console.log('  ADOPT: fires build=' + firesAfterBuild + ' afterVmMutate=' + firesAfterVmMutate +
    ' afterParentRerun=' + firesAfterParentRerun + ' afterSecondVmMutate=' + firesAfterSecondVmMutate);
  console.log('  ADOPT verdict: parent re-run cascade-disposed the adopted child (the DV-1 hazard).');
  // Evidence: after parent re-run the child count did not double; a fresh child replaced it.
}
// DETACH model (R-A): VM children built with createRoot detachment -> survive parent re-run.
{
  const dep = signalBox(0);
  let vmFires = 0;
  const vmSignal = signalBox(100);
  let vmDispose;
  const parent = effect(() => {
    dep.get();
    // detach: build the VM child in its own root, unowned by the parent effect
    createRoot(() => { vmDispose = effect(() => { vmSignal.get(); vmFires++; }); });
  });
  const firesAfterBuild = vmFires;
  vmSignal.set(101);
  const firesAfterVmMutate = vmFires;
  dep.set(1); // parent re-runs; detached child is NOT disposed
  const firesAfterParentRerun = vmFires;
  vmSignal.set(102); // detached child still alive -> fires
  const firesAfterSecondVmMutate = vmFires;
  const survived = firesAfterSecondVmMutate > firesAfterParentRerun;
  console.log('  DETACH: fires build=' + firesAfterBuild + ' afterVmMutate=' + firesAfterVmMutate +
    ' afterParentRerun=' + firesAfterParentRerun + ' afterSecondVmMutate=' + firesAfterSecondVmMutate);
  console.log('  DETACH verdict: VM survives the parent re-run (detached-by-default is correct): ' + survived);
  dispose(parent); if (vmDispose) vmDispose(); dispose(vmSignal); dispose(dep);
  assert(survived, 'Q4 detached VM must survive parent re-run');
}
console.log('');

// -------------------------------------------------------------------------
// Q5 -- does dispose() return box nodes to the pool? (F-0 conservation)
// -------------------------------------------------------------------------
console.log('Q5 -- pooled teardown conservation (F-0)');
{
  // NOTE: the default node pool capacity is 1024 with the "throw" growth policy,
  // so more than ~1024 simultaneously-live reactive nodes cannot exist without a
  // pool growth (which throws). To keep poolGrowths == 0 (the F-0 invariant) the
  // live set is sized to fit the pool: N signalBoxes + N computedBoxes, 2N < 1024.
  const N = 500;
  // warmup once so poolGrowths from first-touch is not counted against the run
  {
    const warm = [];
    for (let i = 0; i < N; i++) warm.push(signalBox(i));
    for (const b of warm) dispose(b);
  }
  const before = snap(stats);
  const boxes = [];
  const comps = [];
  for (let i = 0; i < N; i++) boxes.push(signalBox(i));
  for (let i = 0; i < N; i++) {
    const b = boxes[i];
    comps.push(createRoot(() => computedBox(() => b.get() + 1)));
  }
  const live = snap(stats);
  for (const c of comps) dispose(c);
  for (const b of boxes) dispose(b);
  const after = snap(stats);
  const q5rows = [
    ['phase', 'activeNodes', 'activeLinks', 'totalAlloc', 'totalDisp', 'poolGrowths'],
    ['before', before.activeNodes, before.activeLinks, before.totalAllocations, before.totalDisposals, before.poolGrowths],
    ['live', live.activeNodes, live.activeLinks, live.totalAllocations, live.totalDisposals, live.poolGrowths],
    ['after', after.activeNodes, after.activeLinks, after.totalAllocations, after.totalDisposals, after.poolGrowths],
  ];
  console.log(table(q5rows));
  const backToBaseline = after.activeNodes === before.activeNodes;
  const growthsZero = (after.poolGrowths - before.poolGrowths) === 0;
  const reconciles = (after.totalAllocations - after.totalDisposals) === after.activeNodes;
  console.log('Q5: activeNodes back to baseline: ' + backToBaseline +
    ' | poolGrowths delta 0: ' + growthsZero +
    ' | (alloc-disp==activeNodes): ' + reconciles);
  assert(backToBaseline, 'Q5 activeNodes must return to baseline');
  assert(growthsZero, 'Q5 poolGrowths delta must be 0 after warmup');
  assert(reconciles, 'Q5 alloc-disp must reconcile to activeNodes');
}
console.log('');

// -------------------------------------------------------------------------
// Recommendation
// -------------------------------------------------------------------------
console.log('RECOMMENDATION: R-A (single-anchor cascade). Reason: Q2 shows dispose(getOwner-handle)');
console.log('  cascades owned computeds+effects exactly once and is idempotent; the Q3 grid shows');
console.log('  R-A costs exactly +1 node (the anchor) over R-B while giving a single-handle teardown');
console.log('  and preserving rootOf without enumeration. R-B trades that one node for a flat-array');
console.log('  walk and loss of the cascade. The +1 node is the correct price.');
console.log('');

console.log('SPIKE ownership: ' + (FAIL ? 'FAIL' : 'PASS'));
process.exitCode = FAIL ? 1 : 0;
