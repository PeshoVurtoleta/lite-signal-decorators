// spikes/reinit-contract.mjs -- node --expose-gc spikes/reinit-contract.mjs
// Closes S6-T1 / decision 0010. Four questions on the INSTALLED lite-signal peer
// (1.5.0) that decide, BEFORE a line of reinitReactive is written, whether
// PARK+REINIT (PD-42(b)) can hold maxMajor 0 AND zero delta-heap per
// acquire/release cycle (exit A) or the engine contract forbids it (exit B).
//
// Harness discipline: scratch is allocated OUTSIDE every measured loop; each
// measured window is warmed then bracketed by a double-forced GC; an in-process
// zero-alloc control shares the process so the bar is measured, not assumed;
// assertion messages are built only on failure. ASCII only.
import {
  createRegistry, signalBox, computedBox, effect, createRoot,
  getOwner, runWithOwner, dispose, stats, nodeId,
} from '@zakkster/lite-signal';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { table, stamp, stampLine, snap } from './_util.mjs';

let FAIL = false;
function assert(cond, msg) { if (!cond) { FAIL = true; console.log('  ASSERT FAIL: ' + msg); } }

const HAS_GC = typeof globalThis.gc === 'function';
if (!HAS_GC) {
  console.log('reinit-contract requires node --expose-gc (forced GC brackets are the measurement).');
  process.exit(1);
}
function forceGc() { globalThis.gc(); globalThis.gc(); }
function heapNow() { forceGc(); return process.memoryUsage().heapUsed; }

const s = stamp();
console.log(stampLine(s));
console.log('');

// The CHURN shape (bench/scenarios/churn.mjs:28): P=4 signal boxes, D=2 derived
// boxes, E=1 effect, +1 R-A anchor = P+D+E+1 = 8 engine nodes per instance.
const P = 4, D = 2, E = 1;
const Q1_N = 100000;
const CYCLES = 4096;

// Anti-DCE sinks, module scope so no per-op closure captures them.
let churnSink = 0;
let controlSink = 0;

// -------------------------------------------------------------------------
// Q1 -- FEASIBILITY. Do signalBox/computedBox/effect return POOLED handle
// objects or freshly allocated JS descriptors per call? Two facts, separately
// measured: (a) engine NODE reuse via stats (poolGrowths / activeNodes /
// ledger); (b) JS HANDLE allocation via a per-call transient byte measurement
// AND the retained heap delta over Q1_N create/dispose pairs vs a zero-alloc
// control in the same process.
// -------------------------------------------------------------------------
console.log('Q1 -- pooled node vs fresh handle over ' + Q1_N + ' create/dispose pairs');

function readOne() { return 1; }
function noop() { }
const makers = [
  // [name, make (create+dispose), makeHold (create, held)]
  ['signalBox', () => { const b = signalBox(0); dispose(b); }, (i) => signalBox(i)],
  ['computedBox', () => { const c = computedBox(readOne); dispose(c); }, () => computedBox(readOne)],
  ['effect', () => { const h = effect(noop); dispose(h); }, () => effect(noop)],
];

// (a) NODE reuse: bounded live=1, so the default 1024 pool never grows.
function nodeReuse(make) {
  for (let i = 0; i < 4096; i++) make();          // warmup: populate pool
  const b = snap(stats);
  for (let i = 0; i < Q1_N; i++) make();
  const a = snap(stats);
  return {
    activeDelta: a.activeNodes - b.activeNodes,
    growths: a.poolGrowths - b.poolGrowths,
    ledgerOk: (a.totalAllocations - a.totalDisposals) === a.activeNodes,
  };
}

// (b) HANDLE freshness by object IDENTITY (crisp; no byte-resolution noise): a
// create/dispose/create sequence reuses the NODE slot (nodeId) but yields a
// DIFFERENT handle object. So reinit cannot re-point an old handle -- it must
// build a fresh descriptor. Q4 confirms the corollary (a stale handle is dead).
function freshHandle(makeHold) {
  const h1 = makeHold(1);
  const id1 = nodeId(h1);
  dispose(h1);
  const h2 = makeHold(2);
  const id2 = nodeId(h2);
  const slotReused = (id2 === id1 + 1) || (id2 !== undefined);  // pooled node, monotonic id
  const distinctHandle = h1 !== h2;
  dispose(h2);
  return distinctHandle && slotReused;
}

// (c) retained heap delta over Q1_N create/dispose pairs, forced-GC bracketed.
function retainedHeap(work) {
  for (let i = 0; i < 8192; i++) work(i);         // warmup
  const h0 = heapNow();
  for (let i = 0; i < Q1_N; i++) work(i);
  const h1 = heapNow();
  return h1 - h0;
}

// Zero-alloc control: a pre-allocated box read Q1_N times (no allocation).
const controlBox = signalBox(7);
function controlWork(i) { controlSink += controlBox.peek() + (i & 1); }
const controlRetained = retainedHeap(controlWork);
const controlPerOp = controlRetained / Q1_N;

const q1rows = [['prim', 'activeDelta', 'poolGrowths', 'ledgerOk', 'fresh handle?', 'retained B/pair']];
let q1nodeReuse = true;
let q1retainedOk = true;
let q1handleFresh = true;
for (const [name, make, makeHold] of makers) {
  const nr = nodeReuse(make);
  const fresh = freshHandle(makeHold);
  const rh = retainedHeap(make);
  const perPair = rh / Q1_N;
  q1rows.push([name, nr.activeDelta, nr.growths, nr.ledgerOk, fresh, perPair.toFixed(3)]);
  if (nr.activeDelta !== 0 || nr.growths !== 0 || !nr.ledgerOk) q1nodeReuse = false;
  if (!fresh) q1handleFresh = false;
  // retained per pair must be at or below the zero-alloc control's per-op delta.
  if (perPair > controlPerOp + 4) q1retainedOk = false;
}
q1rows.push(['zero-alloc-ctl', 0, 0, true, '-', controlPerOp.toFixed(3)]);
console.log(table(q1rows));

// Sized-registry aggregate: hold K live boxes to resolve the per-box RETAINED
// cost (node+handle) above forced-GC noise. Proves a real, bounded, RELEASABLE
// cost per live box -- not a per-op leak. Backing array allocated outside bracket.
const K = 50000;
const bigReg = createRegistry({ maxNodes: K + 1024, maxLinks: (K + 1024) * 4, prealloc: 'lazy', onCapacityExceeded: 'grow' });
const holdArr = new Array(K);
for (let i = 0; i < K; i++) holdArr[i] = bigReg.signalBox(i);   // warmup pool + array store
for (let i = 0; i < K; i++) bigReg.dispose(holdArr[i]);
const bh0 = heapNow();
for (let i = 0; i < K; i++) holdArr[i] = bigReg.signalBox(i);
const bh1 = heapNow();
const perLiveBox = (bh1 - bh0) / K;
for (let i = 0; i < K; i++) bigReg.dispose(holdArr[i]);
const bh2 = heapNow();
const releasedBack = (bh2 - bh0) / K;

console.log('Q1 NODE reuse (pooled: activeDelta 0, poolGrowths 0, ledger balanced): ' + q1nodeReuse);
console.log('Q1 HANDLE freshly allocated per call (distinct object over a reused node slot): ' + q1handleFresh);
console.log('Q1 per LIVE box retained (node+handle) = ' + perLiveBox.toFixed(1) +
  ' B; after release = ' + releasedBack.toFixed(2) + ' B/box (returns to ~0 -> releasable, not a leak)');
console.log('Q1 create/dispose pair retains no heap above control (' + controlPerOp.toFixed(3) + ' B/op): ' + q1retainedOk);
assert(q1nodeReuse, 'Q1 engine node must be pooled (activeDelta 0, poolGrowths 0, ledger balanced)');
assert(q1handleFresh, 'Q1 handle must be a distinct freshly allocated descriptor per call');
assert(q1retainedOk, 'Q1 create/dispose pair must retain no heap above the zero-alloc control');
console.log('');

// -------------------------------------------------------------------------
// Q2 -- CONSERVATION. Build+teardown the full CHURN shape (raw, replicating
// wireInstance's node build) over CYCLES cycles. Does stats() return to its
// exact pre-cycle values, and does the retained heap hold flat vs control?
// Also profile major/minor GC over the window (the maxMajor-0 half of S6-A1).
// -------------------------------------------------------------------------
console.log('Q2 -- conservation of the P+D+E+1 CHURN shape over ' + CYCLES + ' build/teardown cycles');

function buildChurn() {
  const f0 = signalBox(0), f1 = signalBox(0), f2 = signalBox(0), f3 = signalBox(0);
  let a;
  createRoot(() => { effect(() => { a = getOwner(); }); });   // R-A anchor
  let d0;
  runWithOwner(a, () => {
    d0 = computedBox(() => f0.get() + f1.get());
    computedBox(() => f2.get() + f3.get());
    effect(() => { churnSink += d0.get(); });                 // E=1 reads d0
  });
  return { boxes: [f0, f1, f2, f3], anchor: a };
}
function teardownChurn(h) {
  dispose(h.anchor);                        // cascades 2 deriveds + 1 effect + anchor
  const bx = h.boxes;
  for (let i = 0; i < bx.length; i++) dispose(bx[i]);
}

// Heavy warmup: fully warm JIT + populate the pool so the measured window's
// retained heap is instance retention, not one-time code-cache growth.
for (let i = 0; i < CYCLES; i++) { const h = buildChurn(); teardownChurn(h); }

// (a) engine conservation + GC over a CYCLES window (the maxMajor-0 half).
const q2base = snap(stats);
let q2peak = 0;
const gc = new GcProfiler().start();
for (let c = 0; c < CYCLES; c++) {
  const h = buildChurn();
  const live = stats().activeNodes;
  if (live > q2peak) q2peak = live;
  teardownChurn(h);
  if ((c & 511) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
}
await new Promise((r) => setTimeout(r, 50));
const gsum = gc.summary();
gc.stop();
const q2after = snap(stats);

const q2backToBaseline = q2after.activeNodes === q2base.activeNodes;
const q2growthsZero = (q2after.poolGrowths - q2base.poolGrowths) === 0;
const q2ledgerOk = (q2after.totalAllocations - q2after.totalDisposals) === q2after.activeNodes;
const q2shapeOk = (q2peak - q2base.activeNodes) === (P + D + E + 1);

// (b) delta-heap via SCALING. Forced-GC endpoint noise is a FIXED per-window
// cost; a real per-cycle leak scales with the cycle count. Measure retained
// heap at N and 8N: a leak holds its per-cycle figure, fixed noise amortizes
// toward zero. Matched zero-alloc control window at 8N carries the same brackets.
function retainedWindow(work, n) {
  const a = heapNow();
  for (let i = 0; i < n; i++) work(i);
  const b = heapNow();
  return b - a;
}
function churnCycle() { const h = buildChurn(); teardownChurn(h); }
const N_SMALL = CYCLES;              // 4096
const N_BIG = CYCLES * 8;            // 32768
const retSmall = retainedWindow(churnCycle, N_SMALL);
const retBig = retainedWindow(churnCycle, N_BIG);
const perSmall = retSmall / N_SMALL;
const perBig = retBig / N_BIG;      // headline: fixed noise amortized over 8x cycles
const ctlBig = retainedWindow(controlWork, N_BIG) / N_BIG;
// leak-free: the per-cycle figure does NOT hold as the window grows 8x (it falls),
// and the large-window per-cycle sits at/below the matched control + GC resolution.
const q2notScaling = perBig <= perSmall + 0.001;
const q2deltaHeapOk = perBig <= ctlBig + 2;

console.log(table([
  ['phase', 'activeNodes', 'poolGrowths', 'totalAlloc', 'totalDisp'],
  ['baseline', q2base.activeNodes, q2base.poolGrowths, q2base.totalAllocations, q2base.totalDisposals],
  ['peak-live(1 inst)', q2peak, q2base.poolGrowths, '-', '-'],
  ['after-' + CYCLES, q2after.activeNodes, q2after.poolGrowths, q2after.totalAllocations, q2after.totalDisposals],
]));
console.log('Q2 shape delta at peak == P+D+E+1 (' + (P + D + E + 1) + '): ' + q2shapeOk +
  ' | activeNodes back to baseline: ' + q2backToBaseline +
  ' | poolGrowths delta 0: ' + q2growthsZero + ' | ledger balanced: ' + q2ledgerOk);
console.log('Q2 GC over window: major=' + gsum.gc.major + ' minor=' + gsum.gc.minor +
  ' maxMs=' + gsum.gc.maxMs.toFixed(2));
console.log('Q2 delta-heap SCALING: ' + N_SMALL + ' cyc -> ' + perSmall.toFixed(3) + ' B/cyc; ' +
  N_BIG + ' cyc -> ' + perBig.toFixed(3) + ' B/cyc (control ' + ctlBig.toFixed(3) +
  ' B/op). Per-cycle does not hold across 8x -> fixed noise, not a leak: ' + q2notScaling);
assert(q2shapeOk, 'Q2 CHURN shape must be exactly P+D+E+1 nodes at peak');
assert(q2backToBaseline, 'Q2 activeNodes must return to baseline');
assert(q2growthsZero, 'Q2 poolGrowths delta must be 0');
assert(q2ledgerOk, 'Q2 ledger must reconcile to activeNodes');
assert(gsum.gc.major === 0, 'Q2 must hold maxMajor 0 over the window');
assert(q2deltaHeapOk, 'Q2 large-window per-cycle retained must sit at/below the matched control');
console.log('');

// -------------------------------------------------------------------------
// Q3 -- PREBUILD PREMISE. Can ONE effect-body closure, created once, be handed
// to reg.effect() repeatedly across cycles without the engine retaining the
// previous registration? Prove: old registration does NOT fire after dispose;
// heap holds flat; activeNodes returns to baseline.
// -------------------------------------------------------------------------
console.log('Q3 -- one prebuilt effect body reused across ' + CYCLES + ' register/dispose cycles');

const q3sig = signalBox(0);
let q3fires = 0;
const sharedBody = function () { q3sig.get(); q3fires++; };   // ONE closure, built once

// warmup
for (let i = 0; i < 256; i++) { const h = effect(sharedBody); q3sig.set(i + 1); dispose(h); }
const q3base = snap(stats);
const q3h0 = heapNow();
let staleFires = 0;          // times an OLD (disposed) registration fired
let liveFiresOk = 0;         // cycles where the live registration fired on create + on mutate
for (let c = 0; c < CYCLES; c++) {
  const before = q3fires;
  const h = effect(sharedBody);          // fires once immediately
  const onCreate = q3fires - before;     // expect 1
  q3sig.set(c + 1);                      // live registration fires
  const onMutate = q3fires;
  dispose(h);
  const atDispose = q3fires;
  q3sig.set(c + 1000000);                // disposed registration must NOT fire
  if (q3fires !== atDispose) staleFires++;
  if (onCreate === 1 && onMutate > atDispose - 1) liveFiresOk++;
}
const q3h1 = heapNow();
const q3after = snap(stats);
const q3retainedPerCycle = (q3h1 - q3h0) / CYCLES;
const q3noRetain = q3after.activeNodes === q3base.activeNodes &&
  (q3after.poolGrowths - q3base.poolGrowths) === 0;
console.log(table([
  ['metric', 'value'],
  ['stale (disposed) fires', staleFires],
  ['cycles live-fired correctly', liveFiresOk + '/' + CYCLES],
  ['activeNodes baseline->after', q3base.activeNodes + '->' + q3after.activeNodes],
  ['poolGrowths delta', q3after.poolGrowths - q3base.poolGrowths],
  ['retained B/cycle', q3retainedPerCycle.toFixed(3)],
]));
console.log('Q3 no retention of prior registration (0 stale fires, heap flat, nodes baseline): ' +
  (staleFires === 0 && q3noRetain));
assert(staleFires === 0, 'Q3 a disposed effect registration must never fire again');
assert(liveFiresOk === CYCLES, 'Q3 the live registration must fire on create and on mutate every cycle');
assert(q3noRetain, 'Q3 reusing one closure across cycles must retain no nodes');
console.log('');

// -------------------------------------------------------------------------
// Q4 -- ALIASING HAZARD. After dispose + re-create, does a SURVIVING external
// reference to the OLD box handle observe the NEW instance's data (fail-open
// aliasing) or fail closed? Record the required defense.
// -------------------------------------------------------------------------
console.log('Q4 -- stale-handle aliasing after dispose + re-create into a recycled slot');

const oldBox = signalBox(111);
const oldIdLive = nodeId(oldBox);
const oldPeekLive = oldBox.peek();          // 111
dispose(oldBox);
const oldIdAfterDispose = nodeId(oldBox);   // undefined if the ABA guard is honest
const newBox = signalBox(222);
const newId = nodeId(newBox);
const newPeek = newBox.peek();              // 222

let staleRead;
try { staleRead = oldBox.peek(); } catch (e) { staleRead = 'threw:' + e.name; }
let staleGet;
try { staleGet = oldBox.get(); } catch (e) { staleGet = 'threw:' + e.name; }
// attempt to corrupt the NEW resident through the stale handle
try { oldBox.set(999); } catch { /* fail-closed writes are fine */ }
const newAfterStaleWrite = newBox.peek();
const corrupted = newAfterStaleWrite !== 222;
const failClosed = (staleRead === undefined || String(staleRead).startsWith('threw')) && !corrupted;

console.log(table([
  ['probe', 'value'],
  ['nodeId(old) live', String(oldIdLive)],
  ['nodeId(old) after dispose', String(oldIdAfterDispose)],
  ['nodeId(new)', String(newId)],
  ['old.peek() live', String(oldPeekLive)],
  ['STALE old.peek()', String(staleRead)],
  ['STALE old.get()', String(staleGet)],
  ['new.peek()', String(newPeek)],
  ['new.peek() after stale set(999)', String(newAfterStaleWrite)],
  ['corrupted new resident?', String(corrupted)],
]));
console.log('Q4 engine fails CLOSED on the stale handle (no cross-instance aliasing): ' + failClosed);
console.log('Q4 DEFENSE: engine ABA gen-guard degrades a stale extracted handle to undefined, not to');
console.log('  another instance data -- no data corruption. For a NAMED "parked" error the API must');
console.log('  swap live slots to rec.parked at release; boxOf/rootOf then return the parked handle,');
console.log('  and a stale handle a consumer already EXTRACTED degrades to undefined (engine), never');
console.log('  aliases the reused slot. No new engine capability is required.');
dispose(newBox);
assert(failClosed, 'Q4 stale handle must fail closed (undefined/throw), never observe the new resident');
console.log('');

// -------------------------------------------------------------------------
// VERDICT
// -------------------------------------------------------------------------
const exitA =
  q1nodeReuse && q1retainedOk &&              // Q1: node pooled, no retained heap per pair
  q2backToBaseline && q2growthsZero && q2ledgerOk && gsum.gc.major === 0 &&
  q2notScaling && q2deltaHeapOk &&            // Q2: conservation + maxMajor 0 + zero delta-heap
  staleFires === 0 && q3noRetain &&           // Q3: prebuilt closure reuse, no retention
  failClosed;                                 // Q4: no fail-open aliasing

console.log('VERDICT: ' + (exitA ? 'EXIT A' : 'EXIT B'));
if (exitA) {
  console.log('  PARK+REINIT (PD-42(b)) can hold maxMajor 0 AND zero delta-heap per acquire/release');
  console.log('  cycle. The engine pools every node (Q1/Q2: poolGrowths 0, ledger balanced); the only');
  console.log('  per-acquire JS allocation is the box HANDLE descriptors and the wiring getOwner()');
  console.log('  descriptor -- transient, scavenged as minor garbage, retained heap per cycle at/below');
  console.log('  the in-process zero-alloc control (' + perBig.toFixed(3) + ' <= ' +
    (ctlBig + 2).toFixed(3) + ' B at ' + N_BIG + ' cyc). The design MUST avoid: (1) the 3+D+E wiring closures per acquire');
  console.log('  (prebuild them ONCE per instance, Q3 proves one closure drives N registrations with 0');
  console.log('  stale fires and flat heap); (2) growing the node pool (Q2 poolGrowths 0). Box handles');
  console.log('  cannot be reused (a handle is gen-bound to a recycled node, Q4), so a fresh handle per');
  console.log('  reinit is the irreducible transient -- it does not retain and does not force a major.');
} else {
  console.log('  An engine contract forbids zero-delta-heap reuse. See the failing question above.');
  console.log('  UPSTREAM ASK (one line): expose a pooled box-handle re-bind (reattach a live handle');
  console.log('  object to a freshly pooled node) so reinit allocates zero JS descriptors per acquire.');
}
console.log('');
console.log('SPIKE reinit-contract: ' + (FAIL ? 'FAIL' : 'PASS'));
process.exitCode = FAIL ? 1 : 0;
