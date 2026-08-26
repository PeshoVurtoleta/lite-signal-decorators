// spikes/batched-cost.mjs -- node --expose-gc spikes/batched-cost.mjs
// Measures the documented cost of the @batched decorated method (risk R8): the
// per-call rest-array + thunk it pays to route a method through the registry's
// batch(). Three lanes on equivalent "one signal set" work:
//   raw       -- batch(() => box.set(box.peek() + 1))     (raw batch(fn) baseline)
//   decorated -- inst.bump()  (the package's guarded @batched public method)
//   unbatched -- box.set(box.peek() + 1)                  (no batch at all)
// Speed is aggregated over K cold child processes (like spikes/manual-call.mjs),
// bytes/op + gc major are informational (batched is a COLD, action-grade path,
// never a per-frame path -- it is excluded from the zero-GC torture gates).
//
//   parent: node --expose-gc batched-cost.mjs
//   child:  node --expose-gc batched-cost.mjs --child N   (one cold speed sample -> JSON)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signalBox, batch, dispose } from '@zakkster/lite-signal';
import { measureOps } from '@zakkster/lite-gc-profiler';
import * as pkg from '../SignalDecorators.js';
import { buildClass } from '../test/shared/mock-emitter.mjs';
import { table, median, min, stamp, stampLine } from './_util.mjs';

const OPS = 500000;
const WARMUP = 100000;
const RUNS = 5;
const K = 10;

// A real @batched decorated instance: one reactive signal `n`, a @batched method
// `bump` that increments it. The mock emitter drives the exact code path a
// transpiled `@batched` method compiles to.
function makeDecorated() {
  const C = buildClass({
    name: 'BatchBench',
    classDecorator: pkg.reactiveHost,
    members: [
      { kind: 'accessor', key: 'n', decorator: pkg.reactive, value: () => 0 },
      {
        kind: 'method',
        key: 'bump',
        decorator: pkg.batched,
        body: function () { this.n = this.n + 1; return this.n; },
      },
    ],
  });
  return new C();
}

// The raw + unbatched lanes operate on a bare signalBox doing the same one set.
function makeLanes() {
  const box = signalBox(0);
  const inst = makeDecorated();
  return {
    box,
    inst,
    raw: function () { return batch(() => box.set(box.peek() + 1)); },
    decorated: function () { return inst.bump(); },
    unbatched: function () { box.set(box.peek() + 1); return box.peek(); },
  };
}

function speedOf(variant) {
  const lanes = makeLanes();
  const fn = lanes[variant];
  let sink = 0;
  const runs = [];
  for (let i = 0; i < WARMUP; i++) sink += fn();
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < OPS; i++) sink += fn();
    const t1 = performance.now();
    runs.push((t1 - t0) * 1e6 / OPS); // ns/op
  }
  const mo = measureOps((i) => { sink += fn(); }, { ops: OPS, warmup: WARMUP });
  if (sink < 0) globalThis.__bc_guard = sink;
  dispose(lanes.box);
  pkg.disposeReactive(lanes.inst);
  return { ns: median(runs), bytesPerOp: mo.summary.heap.allocBytes / mo.ops, major: mo.summary.gc.major };
}

function runChild() {
  const out = { ns: {}, bytesPerOp: {}, major: {} };
  for (const v of ['raw', 'decorated', 'unbatched']) {
    const s = speedOf(v);
    out.ns[v] = s.ns; out.bytesPerOp[v] = s.bytesPerOp; out.major[v] = s.major;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
}

function runParent() {
  const self = fileURLToPath(import.meta.url);
  const st = stamp();
  console.log(stampLine(st));
  console.log('');

  console.log('aggregating batched-method cost over K=' + K + ' cold child processes (inner median-of-' + RUNS + ')...');
  const samples = [];
  for (let i = 0; i < K; i++) {
    const res = spawnSync(process.execPath, ['--expose-gc', self, '--child', String(i)], { encoding: 'utf8' });
    if (res.status !== 0) { console.log('CHILD ' + i + ' FAILED:\n' + (res.stderr || '')); process.exitCode = 1; return; }
    const line = res.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop();
    samples.push(JSON.parse(line));
  }
  const aggNs = (v) => { const arr = samples.map((s) => s.ns[v]); return { minMed: min(arr), medMed: median(arr) }; };
  const aggBytes = (v) => median(samples.map((s) => s.bytesPerOp[v]));
  const majorSum = (v) => samples.reduce((a, s) => a + s.major[v], 0);
  console.log('');

  const rows = [['lane', 'ns/op (min-of-med)', 'ns/op (med-of-med)', 'bytes/op', 'maxMajor']];
  for (const v of ['raw', 'decorated', 'unbatched']) {
    const a = aggNs(v);
    rows.push([v, a.minMed.toFixed(2), a.medMed.toFixed(2), aggBytes(v).toFixed(3), String(majorSum(v))]);
  }
  console.log(table(rows));
  console.log('');

  const dec = aggNs('decorated').medMed, raw = aggNs('raw').medMed;
  console.log('NOTE: the @batched decorated method costs ' + dec.toFixed(2) + ' ns/op vs a raw batch(fn) ' +
    raw.toFixed(2) + ' ns/op -- the difference is the guarded rest-array + thunk (risk R8).');
  console.log('  It is an action-grade path (a user gesture, a transaction), not a per-frame path;');
  console.log('  batched is excluded from the zero-GC torture gates by design.');
  console.log('');
  console.log('SPIKE batched-cost: PASS');
  process.exitCode = 0;
}

if (process.argv.includes('--child')) runChild();
else runParent();
