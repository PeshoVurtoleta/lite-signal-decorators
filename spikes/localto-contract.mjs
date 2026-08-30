// spikes/localto-contract.mjs -- node --expose-gc spikes/localto-contract.mjs
// Closes S8-T1 / decision 0014. Six questions on the INSTALLED lite-signal peer
// (1.5.0) that decide, BEFORE a line of makeLocalGet/makeLocalSet is written,
// whether @localTo (upstream-keyed resettable local state, 0013 flagship) has a
// SHIPPABLE contract (exit A) or S8 stops for lack of semantics (exit B).
//
// The spike PROTOTYPES the localTo mechanics in userland -- plain per-instance
// boxes, a plain last-seen slot, and the public decorators surface where a real
// twin helps -- to answer the questions before any implementation exists. It
// patches nothing and monkey-patches nothing. The shipped canon
// (makeGet/makeSet/makeDerivedGet) is never touched; the read-ratio uses the
// public accessor bodies mirrored as standalone functions.
//
// Harness discipline (inherited from reinit-contract.mjs): scratch is allocated
// OUTSIDE every measured loop; each measured window is warmed then bracketed by a
// double-forced GC; an in-process zero-alloc control shares the process so the
// bar is measured, not assumed; assertion messages are built only on failure.
// Numbers are MEASURED on the peer, never assumed, never softened. ASCII only.
import {
  signalBox, computedBox, effect, createRoot, getOwner, runWithOwner,
  dispose, stats, describe, forEachSource, onGraphMutation,
} from '@zakkster/lite-signal';
import { defineReactive, costOf } from '../SignalDecorators.js';
import { GcProfiler } from '@zakkster/lite-gc-profiler';
import { table, stamp, stampLine, median } from './_util.mjs';

let FAIL = false;
function assert(cond, msg) { if (!cond) { FAIL = true; console.log('  ASSERT FAIL: ' + msg); } }

const HAS_GC = typeof globalThis.gc === 'function';
if (!HAS_GC) {
  console.log('localto-contract requires node --expose-gc (forced GC brackets are the measurement).');
  process.exit(1);
}
function forceGc() { globalThis.gc(); globalThis.gc(); }
function heapNow() { forceGc(); return process.memoryUsage().heapUsed; }
async function settle() { await new Promise((r) => setTimeout(r, 50)); }

const s = stamp();
console.log(stampLine(s));
console.log('');

// The peer default equals is Object.is (probed: node.equals === [Function: is]).
// The PROPOSED read body equals-compares the tracked upstream against a plain
// per-instance seen-slot; the default mirrors the peer.
const defaultEquals = Object.is;

// Anti-DCE sinks, module scope so no per-op closure captures them.
let readSink = 0;
let writeSink = 0;
let ctlSink = 0;

// --- PROTOTYPE of the two proposed hot bodies (userland, no implementation) ---
// makeLocalGet: call the tracked upstream fn, equals-compare it against the plain
// last-seen slot; return the local box on an unchanged upstream, else upstream.
// WRITE-FREE: no assignment, no box.set, no graph mutation on the read path.
function makeLocalGet(source, eq) {
  return function () {
    const up = source.call(this, this);
    if (eq(up, this.seen)) return this.box.get();
    return up;
  };
}
// makeLocalSet: local box .set + seen-slot store (upstream-at-write-time). The
// write path never compares -- a write always overrides (PD-56). The seen capture
// runs outside any tracking context (a setter is untracked), so source.call is a
// plain untracked read: zero allocation, no subscription.
function makeLocalSet(source) {
  return function (v) {
    this.box.set(v);
    this.seen = source.call(this, this);
  };
}
// A prototyped local: one box (an engine node) + one plain seen-slot (a JS field).
// seen is seeded to the upstream value at wiring (Q6 initial-wiring law).
function wireLocal(upstreamBox, initial, sourceFn) {
  return { up: upstreamBox, box: signalBox(initial), seen: upstreamBox.peek(), src: sourceFn };
}
function upstreamSource() { return this.up.get(); }   // PD-54 tracked (self)=>value

// =========================================================================
// Q1 -- PURITY. Capture verbatim what the peer does on a box write inside a
// computed's compute fn, then prove the PROPOSED read shape is write-free by
// tallying every graph mutation over 1e5 reads (expected 0 node create/dispose).
// =========================================================================
console.log('Q1 -- purity: peer write-in-compute behavior + write-free read tally');

// (a) verbatim peer behavior on a mid-compute box write.
const q1w = signalBox(0);
const q1s = signalBox(1);
let q1peer;
try {
  const c = computedBox(() => { q1w.set(9); return q1s.get(); });
  c.get();
  q1peer = 'TOLERATED (no throw); side box observed = ' + q1w.peek();
} catch (e) {
  q1peer = 'THREW ' + e.name + ': ' + e.message;
}
console.log('  peer 1.5.0 box write inside a computed compute fn: ' + q1peer);
console.log('  DESIGN LAW (unchanged regardless): the read body stays write-free (purity).');

// (b) write-free proof: tally graph mutations over Q1_N proposed reads.
const Q1_N = 100000;
const q1host = wireLocal(signalBox(42), 7, upstreamSource);
q1host.seen = q1host.up.peek();                 // seen == upstream -> box branch taken
const q1get = makeLocalGet(upstreamSource, defaultEquals);
let opNodeCreate = 0, opNodeDispose = 0, opLinkAdd = 0, opLinkRemove = 0, opRecompute = 0;
// warmup outside the tallied window
for (let i = 0; i < 4096; i++) readSink += q1get.call(q1host);
const q1off = onGraphMutation((op) => {
  if (op === 1) opNodeCreate++;
  else if (op === 2) opNodeDispose++;
  else if (op === 3) opLinkAdd++;
  else if (op === 4) opLinkRemove++;
  else if (op === 5) opRecompute++;
});
for (let i = 0; i < Q1_N; i++) readSink += q1get.call(q1host);
q1off();
const q1nodeOps = opNodeCreate + opNodeDispose;
const q1totalOps = q1nodeOps + opLinkAdd + opLinkRemove + opRecompute;
console.log(table([
  ['op', 'node-create(1)', 'node-dispose(2)', 'link-add(3)', 'link-remove(4)', 'recompute(5)'],
  [Q1_N + ' reads', opNodeCreate, opNodeDispose, opLinkAdd, opLinkRemove, opRecompute],
]));
console.log('  Q1 node ops over ' + Q1_N + ' reads = ' + q1nodeOps +
  ' (total graph mutations = ' + q1totalOps + ') -> read is write-free: ' + (q1nodeOps === 0));
const q1purity = q1nodeOps === 0 && q1totalOps === 0;
assert(q1nodeOps === 0, 'Q1 proposed read must create/dispose 0 nodes over ' + Q1_N + ' reads');
assert(q1totalOps === 0, 'Q1 proposed read must emit 0 graph mutations (write-free) outside tracking');
console.log('');

// =========================================================================
// Q2 -- ABA. Sweep the peer surface for ANY per-box version/revision/epoch on
// the PUBLIC NodeDescriptor. If none, pin the value-compare ABA sequence as the
// CONTRACT-CANDIDATE, and demonstrate the {equals} variant on the upstream
// compare.
// =========================================================================
console.log('Q2 -- ABA: public epoch sweep + value-compare contract demonstration');

const q2desc = describe(signalBox(5));
const q2keys = Object.keys(q2desc);
const epochNames = ['version', 'revision', 'epoch', 'rev', 'gen', 'seq'];
let publicEpoch = null;
for (let i = 0; i < epochNames.length; i++) {
  if (q2keys.indexOf(epochNames[i]) !== -1) publicEpoch = epochNames[i];
}
console.log('  public NodeDescriptor keys = [' + q2keys.join(', ') + ']');
console.log('  per-box version/revision/epoch on the PUBLIC surface: ' +
  (publicEpoch === null ? 'NONE FOUND (Signal.d.ts:165-172 confirmed: {id,kind,value})' : publicEpoch));
console.log('  NOTE: the internal node carries a private Symbol(node_ptr).version/gen -- unstable,');
console.log('  not a public contract; using it would be an impure counter trick (REJECTED up front).');

// value-compare ABA: upstream A -> local write X -> upstream B -> upstream back
// to an equals-A value: the read resurrects the STALE local X. This is the
// shipped contract candidate (tracked-toolbox precedent).
const q2up = signalBox('A');
const q2host = wireLocal(q2up, 'init', upstreamSource);
const q2get = makeLocalGet(upstreamSource, defaultEquals);
const q2set = makeLocalSet(upstreamSource);
const q2trace = [];
q2host.seen = q2up.peek();                       // wiring: seen = 'A'
q2trace.push(['wiring (seen=A, box=init)', 'read', String(q2get.call(q2host))]);       // up A==seen -> box 'init'
q2set.call(q2host, 'X');                          // local write: box='X', seen='A'
q2trace.push(['local write X (seen=A, box=X)', 'read', String(q2get.call(q2host))]);   // up A==seen -> box 'X'
q2up.set('B');                                    // upstream moves A->B
q2trace.push(['upstream A->B', 'read', String(q2get.call(q2host))]);                   // up B!=seen A -> 'B'
q2up.set('A');                                    // upstream returns to an equals-A value
q2trace.push(['upstream B->A (ABA)', 'read', String(q2get.call(q2host))]);             // up A==seen A -> STALE 'X'
const abaStale = q2get.call(q2host) === 'X';
console.log(table([['transition', 'op', 'value']].concat(q2trace)));
console.log('  Q2 ABA outcome: after upstream returns to an equals-A value, the read shows the');
console.log('  STALE local (X): ' + abaStale + '  <- CONTRACT-CANDIDATE (value-compare, documented ABA)');

// {equals} variant: a custom equals governs ONLY the upstream compare. A coarse
// equals (bucket to integer) treats a small upstream move as "unchanged", so the
// local override survives a move the default Object.is would have reset.
const q2coarse = (a, b) => Math.floor(a) === Math.floor(b);
const q2eup = signalBox(1.0);
const q2ehost = wireLocal(q2eup, 0, upstreamSource);
const q2eget = makeLocalGet(upstreamSource, q2coarse);
const q2eset = makeLocalSet(upstreamSource);
q2ehost.seen = q2eup.peek();                      // seen = 1.0
q2eset.call(q2ehost, 99);                         // override: box=99, seen=1.0
const q2eBeforeDefault = Object.is(1.4, 1.0);     // default would reset (1.4 !== 1.0)
q2eup.set(1.4);                                   // small upstream move within the bucket
const q2eCoarse = String(q2eget.call(q2ehost));   // coarse eq(1.4,1.0)->same bucket -> override 99 held
console.log('  Q2 {equals} variant: coarse equals (floor) suppresses the reset on a 1.0->1.4 move.');
console.log('    default Object.is(1.4,1.0) would reset (equal? ' + q2eBeforeDefault + ');' +
  ' coarse equals holds the override -> read = ' + q2eCoarse);
const q2equalsOk = q2eCoarse === '99' && q2eBeforeDefault === false;
const q2shippable = publicEpoch === null && abaStale && q2equalsOk;
assert(abaStale, 'Q2 ABA must resurrect the stale local as the contract candidate');
assert(q2equalsOk, 'Q2 custom equals must govern the upstream compare and suppress the reset');
console.log('');

// =========================================================================
// Q3 -- COST. A local contributes EXACTLY 1 box (engine node) + 1 plain seen-slot
// (a JS field, NOT a node). costOf a real twin (P=2,D=1,E=1) is P+D+E+1; the
// prototyped local adds exactly 1 node -> the P+L+D+E+1 formula, target 6.
// =========================================================================
console.log('Q3 -- cost: costOf twin + local box delta == P+L+D+E+1');

const P = 2, L = 1, D = 1, E = 1;
const Twin = defineReactive(class LocalCostTwin {}, {
  signals: { a: 0, b: 0 },
  deriveds: { sum: (self) => self.a + self.b },
  effects: { e: (self) => { readSink += self.sum; } },
});
const twinCost = costOf(Twin);                    // public, exact: P+D+E+1 = 5

// the prototyped local's box: measure the activeNodes delta of one signalBox, and
// confirm the seen-slot (a plain object field) adds 0 nodes.
for (let i = 0; i < 1024; i++) dispose(signalBox(0));   // warm the pool
const beforeBox = stats().activeNodes;
const localBox = signalBox(0);
const afterBox = stats().activeNodes;
const localHost = { box: localBox, seen: 0 };     // seen-slot: a plain JS field
const afterSeen = stats().activeNodes;            // assigning a plain field: no node
const boxNodes = afterBox - beforeBox;
const seenNodes = afterSeen - afterBox;
dispose(localBox);

const formulaNodes = P + L + D + E + 1;
const measuredNodes = twinCost.nodes + boxNodes;
console.log(table([
  ['term', 'P (signals)', 'L (locals)', 'D (deriveds)', 'E (effects)', '+1 anchor', 'nodes'],
  ['costOf twin', twinCost.signals, 0, twinCost.deriveds, twinCost.effects, 1, twinCost.nodes],
  ['+ 1 local', 0, L, 0, 0, 0, boxNodes],
  ['total', P, L, D, E, 1, measuredNodes],
]));
console.log('  Q3 local contributes: box nodes = ' + boxNodes + ', seen-slot nodes = ' + seenNodes +
  ' (plain field). P+L+D+E+1 = ' + formulaNodes + '; measured = ' + measuredNodes +
  ' -> ' + (measuredNodes === formulaNodes && formulaNodes === 6));
assert(twinCost.nodes === P + D + E + 1, 'Q3 costOf twin must be P+D+E+1 = ' + (P + D + E + 1));
assert(boxNodes === 1, 'Q3 a local must contribute exactly 1 engine node (the box)');
assert(seenNodes === 0, 'Q3 the seen-slot must be a plain field (0 nodes)');
assert(measuredNodes === 6, 'Q3 P+L+D+E+1 must total 6 for P=2,L=1,D=1,E=1');
console.log('');

// =========================================================================
// Q4 -- TRACKING. A derived reading one prototyped local subscribes to EXACTLY 2
// sources (upstream box edge + local box edge), 0 extra nodes per read.
// =========================================================================
console.log('Q4 -- tracking: forEachSource on a derived over one local == 2 edges');

const q4up = signalBox(3);
const q4host = wireLocal(q4up, 5, upstreamSource);
q4host.seen = q4up.peek();                        // seen == upstream -> read touches the box too
const q4get = makeLocalGet(upstreamSource, defaultEquals);
const q4before = stats().activeNodes;
const q4der = computedBox(function () { return q4get.call(q4host); });
q4der.get();                                      // force the first compute (subscribes)
const q4descs = [];
forEachSource(q4der, (d) => q4descs.push(d.kind));
const q4afterWire = stats().activeNodes;
// zero extra nodes per read: re-read many times, activeNodes must not move.
for (let i = 0; i < 100000; i++) readSink += (q4der.peek(), q4get.call(q4host));
const q4afterReads = stats().activeNodes;
dispose(q4der);
console.log('  descriptor count = ' + q4descs.length + ' kinds = [' + q4descs.join(', ') + ']');
console.log('  nodes after 1e5 reads delta = ' + (q4afterReads - q4afterWire) + ' (0 extra nodes per read)');
const q4ok = q4descs.length === 2 && (q4afterReads - q4afterWire) === 0;
assert(q4descs.length === 2, 'Q4 a derived over one local must subscribe to exactly 2 sources');
assert((q4afterReads - q4afterWire) === 0, 'Q4 reads must create 0 extra nodes');
console.log('');

// =========================================================================
// Q5 -- HOT. Prototyped local read/write at N and 8N (1e6/8e6): gc.major 0,
// maxPauseMs <= 4.0, delta-heap per op <= zero-alloc control + 2 B, minors <=
// control + 128. Plus the honest read-cost ratio vs a plain @reactive box read.
// =========================================================================
console.log('Q5 -- hot: read/write budgets at N and 8N vs an in-process control');

const HOT = 1000000;
const HOT8 = HOT * 8;

// prototyped local, seeded so the read takes the box branch (returns local value).
const hotUp = signalBox(1);
const hotHost = wireLocal(hotUp, 100, upstreamSource);
hotHost.seen = hotUp.peek();
const hotGet = makeLocalGet(upstreamSource, defaultEquals);
const hotSet = makeLocalSet(upstreamSource);

// plain @reactive-style read (the makeGet body: this.slot.get()) as the ratio base.
const plainHost = { box: signalBox(100) };
function plainGet() { return this.box.get(); }

// zero-alloc control: a pre-allocated box read (no allocation, no branch).
const ctlBox = signalBox(7);
function ctlWork(i) { ctlSink += ctlBox.peek() + (i & 1); }

function readWork(i) { readSink += hotGet.call(hotHost) + (i & 1); }
function writeWork(i) { hotSet.call(hotHost, i); writeSink += (i & 1); }

// delta-heap per op via forced-GC brackets (a real per-op leak scales; fixed
// endpoint noise amortizes as N grows).
function deltaPerOp(work, n) {
  for (let i = 0; i < 8192; i++) work(i);         // warm
  const a = heapNow();
  for (let i = 0; i < n; i++) work(i);
  const b = heapNow();
  return (b - a) / n;
}
const ctlPerOpN = deltaPerOp(ctlWork, HOT);
const ctlPerOp8 = deltaPerOp(ctlWork, HOT8);
const readPerOpN = deltaPerOp(readWork, HOT);
const readPerOp8 = deltaPerOp(readWork, HOT8);
const writePerOpN = deltaPerOp(writeWork, HOT);
const writePerOp8 = deltaPerOp(writeWork, HOT8);

// GC window: 1e6 reads + 1e6 writes under the profiler (major/minor/maxMs), plus a
// matched control window for the minors bar.
async function gcWindow(work, n) {
  forceGc();
  const gc = new GcProfiler().start();
  for (let i = 0; i < n; i++) work(i);
  gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
  await settle();
  const sum = gc.summary();
  gc.stop();
  return sum;
}
const ctlSum = await gcWindow(ctlWork, HOT + HOT);
const rwSum = await gcWindow((i) => { readWork(i); writeWork(i); }, HOT);   // 1e6 read+write

// read-cost ratio vs the plain box read (median of timed runs, honest number).
function timeLoop(fn, iters) {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn(i);
  return performance.now() - t0;
}
for (let i = 0; i < 5; i++) { timeLoop((k) => readSink += hotGet.call(hotHost), HOT); timeLoop(() => readSink += plainGet.call(plainHost), HOT); }
const localTimes = [], plainTimes = [];
for (let r = 0; r < 9; r++) {
  localTimes.push(timeLoop((k) => readSink += hotGet.call(hotHost), HOT));
  plainTimes.push(timeLoop(() => readSink += plainGet.call(plainHost), HOT));
}
const localNs = median(localTimes) * 1e6 / HOT;
const plainNs = median(plainTimes) * 1e6 / HOT;
const readRatio = localNs / plainNs;

console.log(table([
  ['metric', 'read', 'write', 'control'],
  ['B/op @N (1e6)', readPerOpN.toFixed(3), writePerOpN.toFixed(3), ctlPerOpN.toFixed(3)],
  ['B/op @8N (8e6)', readPerOp8.toFixed(3), writePerOp8.toFixed(3), ctlPerOp8.toFixed(3)],
]));
console.log('  Q5 GC over 1e6 read+write: major=' + rwSum.gc.major + ' minor=' + rwSum.gc.minor +
  ' maxMs=' + rwSum.gc.maxMs.toFixed(2) + ' (control minor=' + ctlSum.gc.minor + ')');
console.log('  Q5 read cost: local=' + localNs.toFixed(2) + ' ns/op, plain box=' + plainNs.toFixed(2) +
  ' ns/op -> ratio ' + readRatio.toFixed(2) + 'x (honest: two tracked reads + a compare vs one)');
console.log('  Q5 canon untouched: the spike imports the shipped module read-only; it measures the');
console.log('  proposed bodies as standalone functions and never writes SignalDecorators.js.');

const q5major = rwSum.gc.major === 0;
const q5pause = rwSum.gc.maxMs <= 4.0;
const q5readHeap = readPerOp8 <= ctlPerOp8 + 2;
const q5writeHeap = writePerOp8 <= ctlPerOp8 + 2;
const q5minors = rwSum.gc.minor <= ctlSum.gc.minor + 128;
assert(q5major, 'Q5 gc.major must be 0 over the hot window');
assert(q5pause, 'Q5 maxPauseMs must be <= 4.0');
assert(q5readHeap, 'Q5 read delta-heap must sit at/below control + 2 B/op at 8N');
assert(q5writeHeap, 'Q5 write delta-heap must sit at/below control + 2 B/op at 8N');
assert(q5minors, 'Q5 minors must sit at/below control + 128');
console.log('');

// =========================================================================
// Q6 -- LATTICE. The seen-slot value after each transition, by experiment where
// the prototype allows and by stated design elsewhere. Each a labeled line.
// =========================================================================
console.log('Q6 -- lattice: the seen-slot law per transition');

// initial wiring: seen = upstream at wiring; box = initial.
const l6up = signalBox('U0');
const l6host = wireLocal(l6up, 'INIT', upstreamSource);
const l6get = makeLocalGet(upstreamSource, defaultEquals);
const l6set = makeLocalSet(upstreamSource);
l6host.seen = l6up.peek();
console.log('  wiring        : seen = upstream@wiring (' + l6host.seen + '); read = ' +
  l6get.call(l6host) + ' (box=INIT while upstream stationary)');

// local write: seen = upstream at write time; read = written value.
l6set.call(l6host, 'W1');
console.log('  local write   : seen = upstream@write (' + l6host.seen + '); read = ' +
  l6get.call(l6host) + ' (override held while upstream stationary)');

// reinit (PD-58): box -> initial, seen -> CURRENT upstream. Consequence: the
// post-reinit read follows upstream until the first write. Demonstrate by moving
// upstream after reinit -> the read tracks it.
l6up.set('U1');                                    // upstream moved before reinit
l6host.box.set('INIT');                            // reinit: box -> initial
l6host.seen = l6up.peek();                          // reinit: seen -> CURRENT upstream (U1)
const l6postReinitStationary = l6get.call(l6host);  // up U1 == seen U1 -> box INIT (narrow window)
l6up.set('U2');                                     // upstream moves off the reinit value
const l6postReinitFollow = l6get.call(l6host);      // up U2 != seen U1 -> follows upstream U2
console.log('  reinit        : box -> INIT, seen -> CURRENT upstream (' + l6host.seen +
  '); read follows upstream on next move (' + l6postReinitStationary + ' -> ' + l6postReinitFollow + ')');

// dispose: slot irrelevant, member poisoned. Demonstrate the box disposed -> the
// read fails closed: the peer's ABA gen-guard DEGRADES a disposed box handle to
// undefined (never aliases another instance -- reinit-contract Q4). The real
// @localTo dispose additionally poisons the slot for a NAMED ReactiveDisposedError.
const l6dhost = wireLocal(signalBox('D'), 'DI', upstreamSource);
l6dhost.seen = l6dhost.up.peek();
dispose(l6dhost.box);
let l6disp, l6dispClosed;
try {
  const v = l6get.call(l6dhost);
  l6disp = 'degraded->' + String(v);              // undefined: no aliasing, no cross-instance data
  l6dispClosed = v === undefined;
} catch (e) { l6disp = 'throw:' + e.name; l6dispClosed = true; }
console.log('  dispose       : seen-slot irrelevant, member poisoned; read on a disposed box = ' + l6disp +
  ' (fail-closed: ' + l6dispClosed + '; the shipped path poisons the slot -> ReactiveDisposedError)');

// park: state the design. The seen-slot is plain per-instance JS state on the
// record; on park it is RETAINED alongside the other plain fields (no box handle
// held -- the box node is released and re-created on reinit). Reinit resets it.
console.log('  park          : seen-slot RETAINED (plain record field); box node released, ' +
  're-created on reinit which resets both (design, PD-58)');

// source throw: propagates from the read, mutates nothing (PD-56 fail closed).
const l6thost = { up: signalBox(0), box: signalBox('SB'), seen: 0 };
function throwingSource() { throw new RangeError('upstream boom'); }
const l6tget = makeLocalGet(throwingSource, defaultEquals);
let l6toff = 0;
const l6t = onGraphMutation((op) => { if (op === 1 || op === 2) l6toff++; });
let l6throw;
try { l6throw = String(l6tget.call(l6thost)); } catch (e) { l6throw = 'propagated:' + e.name; }
l6t();
console.log('  source throw  : ' + l6throw + '; node ops during the throwing read = ' + l6toff +
  ' (propagates, mutates nothing)');

// {equals} governs ONLY the upstream compare (PD-56): a custom equals suppresses
// a reset the default would have applied (already measured in Q2; restate here).
console.log('  {equals}      : governs the UPSTREAM compare ONLY; the write path never compares.');
console.log('    coarse equals held the override across a 1.0->1.4 move (Q2): read = ' + q2eCoarse);

const q6ok = l6get.call(l6host) === 'U2' && l6postReinitFollow === 'U2' &&
  l6dispClosed && l6throw === 'propagated:RangeError' && l6toff === 0;
assert(l6postReinitFollow === 'U2', 'Q6 post-reinit read must follow upstream on the next move');
assert(l6dispClosed, 'Q6 a read on a disposed box must fail closed (degrade to undefined or throw)');
assert(l6throw === 'propagated:RangeError' && l6toff === 0, 'Q6 a source throw must propagate and mutate nothing');
console.log('');

// =========================================================================
// EXIT
// =========================================================================
const exitA = q1purity && q2shippable;
console.log('EXIT: ' + (exitA ? 'EXIT A' : 'EXIT B'));
if (exitA) {
  console.log('  Q1 purity holds (write-free read proven: 0 node ops / 0 graph mutations over ' +
    Q1_N + ' reads),');
  console.log('  and Q2 lands on a SHIPPABLE contract: value-compare-on-read against a plain seen-slot,');
  console.log('  with the documented ABA (upstream A->write->B->A resurrects the stale local, ' +
    'tracked-toolbox');
  console.log('  precedent). No public per-box epoch exists (NodeDescriptor is {id,kind,value}); the');
  console.log('  internal node.version is private and impure -- REJECTED. {equals} governs the upstream');
  console.log('  compare only (PD-56). S8 proceeds: makeLocalGet/makeLocalSet, localTo, P+L+D+E+1.');
} else {
  console.log('  S8 STOPS -- no API without semantics. Blocking fact: ' +
    (!q1purity ? 'the proposed read is NOT write-free.' :
      (publicEpoch === null && !abaStale ? 'value-compare does not yield a stable ABA contract.' :
        'no shippable contract (no epoch, no value-compare).')));
}
console.log('');
console.log('SPIKE localto-contract: ' + (FAIL ? 'FAIL' : 'PASS'));
process.exitCode = FAIL ? 1 : 0;
