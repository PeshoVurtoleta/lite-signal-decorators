// spikes/manual-call.mjs -- node --expose-gc spikes/manual-call.mjs
// Closes decision 0004 (D-04): when a decorated method's replacement is called
// manually from inside a foreign tracking scope, do its reads leak as the caller's
// deps, and among the CLEAN (non-leaking) variants which is cheaper on the common
// (untracked) path? Speed is aggregated over K cold child processes.
//
//   parent: node --expose-gc manual-call.mjs
//   child:  node --expose-gc manual-call.mjs --child N   (one cold speed sample -> JSON)
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { signalBox, effect, untrack, isTracking, dispose } from '@zakkster/lite-signal';
import { measureOps } from '@zakkster/lite-gc-profiler';
import { table, median, min, stamp, stampLine } from './_util.mjs';

const OPS = 500000;
const WARMUP = 100000;
const RUNS = 5;
const K = 10;

// Hand-wired stand-in for a decorated method: body(self) reads two signalBoxes.
// Three exposed variants on the SAME shape:
//   raw     -- direct call; reads leak as the caller's deps inside a tracking scope.
//   wrapped -- always untrack; a fresh arrow per call.
//   guarded -- untrack ONLY when a tracking scope is active; else the bare body.
function makeInstance() {
  const self = { a: signalBox(1), b: signalBox(2) };
  const body = (o) => o.a.get() + o.b.get();
  self.raw = function () { return body(this); };
  self.wrapped = function () { return untrack(() => body(this)); };
  self.guarded = function () { return isTracking() ? untrack(() => body(this)) : body(this); };
  return self;
}

// ---- LEAK exhibit: outer effect calls the variant; mutate a dep; count re-runs.
function leakTrial(variant) {
  const inst = makeInstance();
  let reruns = 0, sink = 0;
  const outer = effect(() => { sink += inst[variant].call(inst); reruns++; });
  const afterFirst = reruns;
  inst.a.set(inst.a.peek() + 1);
  const afterMutate = reruns;
  dispose(outer); dispose(inst.a); dispose(inst.b);
  if (sink < 0) globalThis.__mc_guard = sink;
  return afterMutate - afterFirst;
}

// ---- SPEED (child): all three interleaved on the COMMON path (no tracking scope).
function speedOf(variant) {
  const inst = makeInstance();
  const fn = inst[variant];
  let sink = 0;
  const runs = [];
  // warmup
  for (let i = 0; i < WARMUP; i++) sink += fn.call(inst);
  for (let r = 0; r < RUNS; r++) {
    const t0 = performance.now();
    for (let i = 0; i < OPS; i++) sink += fn.call(inst);
    const t1 = performance.now();
    runs.push((t1 - t0) * 1e6 / OPS); // ns/op
  }
  // one measureOps pass for bytes/op + major (informational)
  const mo = measureOps((i) => { sink += fn.call(inst); }, { ops: OPS, warmup: WARMUP });
  if (sink < 0) globalThis.__mc_guard = sink;
  dispose(inst.a); dispose(inst.b);
  return { ns: median(runs), bytesPerOp: mo.summary.heap.allocBytes / mo.ops, major: mo.summary.gc.major };
}

function runChild() {
  const out = { ns: {}, bytesPerOp: {}, major: {} };
  for (const v of ['raw', 'guarded', 'wrapped']) {
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

  // LEAK exhibit runs in-process (deterministic): raw=1, wrapped=0, guarded=0.
  const leak = { raw: leakTrial('raw'), guarded: leakTrial('guarded'), wrapped: leakTrial('wrapped') };
  console.log('LEAK exhibit (outer effect calls variant, mutate a read dep, count outer re-runs):');
  console.log('  raw=' + leak.raw + '  guarded=' + leak.guarded + '  wrapped=' + leak.wrapped +
    '   (raw leaks: caller adopts the reads; guarded/wrapped untrack them)');
  console.log('');

  // SPEED aggregated over K cold children.
  console.log('aggregating common-path speed over K=' + K + ' cold child processes (inner median-of-' + RUNS + ')...');
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

  const rows = [['variant', 'outer-reruns', 'ns/op (min-of-med)', 'ns/op (med-of-med)', 'bytes/op', 'maxMajor', 'clean?']];
  for (const v of ['raw', 'guarded', 'wrapped']) {
    const a = aggNs(v);
    rows.push([v, String(leak[v]), a.minMed.toFixed(2), a.medMed.toFixed(2), aggBytes(v).toFixed(3), String(majorSum(v)), leak[v] === 0 ? 'yes' : 'NO(leaks)']);
  }
  console.log(table(rows));
  console.log('');

  // Policy: choose among the CLEAN options only. raw is disqualified (it leaks).
  const gNs = aggNs('guarded').medMed, wNs = aggNs('wrapped').medMed;
  const cheaper = gNs <= wNs ? 'guarded' : 'wrapped';
  const other = cheaper === 'guarded' ? 'wrapped' : 'guarded';
  const cheaperNs = Math.min(gNs, wNs), otherNs = Math.max(gNs, wNs);
  console.log('POLICY: choose GUARDED or WRAPPED (raw is DISQUALIFIED -- it silently leaks the caller\'s deps;');
  console.log('  a rigor-first package cannot ship that as a "caveat"). Cheaper clean option: ' + cheaper +
    ' at ' + cheaperNs.toFixed(2) + ' ns/op vs ' + other + ' ' + otherNs.toFixed(2) + ' ns/op (' +
    (((otherNs - cheaperNs) / cheaperNs) * 100).toFixed(1) + '% dearer).');
  console.log('  CHOSEN: ' + cheaper + '. guarded pays untrack ONLY inside a foreign tracking scope; on the');
  console.log('  common untracked path it is the bare body (isTracking() is a cheap branch-predicted read).');
  console.log('  NOTE: manual invocation is a COLD path -- the decorated method auto-runs as an effect;');
  console.log('  calling it by hand is the exception, so absolute ns here is informational, not a hot gate.');
  console.log('');

  // Correctness gates: raw must leak; guarded and wrapped must not.
  let FAIL = false;
  if (leak.raw === 0) { FAIL = true; console.log('  ASSERT FAIL: raw was expected to leak'); }
  if (leak.guarded !== 0) { FAIL = true; console.log('  ASSERT FAIL: guarded must not leak'); }
  if (leak.wrapped !== 0) { FAIL = true; console.log('  ASSERT FAIL: wrapped must not leak'); }
  console.log('SPIKE manual-call: ' + (FAIL ? 'FAIL' : 'PASS'));
  process.exitCode = FAIL ? 1 : 0;
}

if (process.argv.includes('--child')) runChild();
else runParent();
