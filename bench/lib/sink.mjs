// bench/lib/sink.mjs -- the anti-DCE sink kernel + the per-scenario checksum contract.
//
// ORIGIN: extracted from the sink section of
//   ../../LiteSignal/bench/lib/benchmark.mjs (bench protocol v3). In the source
//   rig the sink lived inline in the runner; here it is a module so every adapter
//   and the runner share the one array and the one contract.
//
// WHY IT CANNOT BE FOLDED AWAY (V8 escape analysis):
//   * a typed array (Float64Array) -- a typed-element store IC V8 cannot elide,
//     and Float64 specifically because Uint32 writes can be optimised away if V8
//     can prove the slots are never read in the same iteration.
//   * rooted on globalThis -- always reachable, never tree-shaken.
//   * read AFTER the loop (summed into the checksum) -- every write is load-bearing.
//   * indexed with a power-of-two bitmask (& SINK_MASK) -- no per-write division.
//
// THE CONTRACT. Each scenario's drive(i) writes into the sink; after a full pass
// of `iters` iterations the summed sink MUST equal the scenario's analytically
// derived expectedSum. Default equality everywhere (no custom equals in bench
// shapes), so the expected sum is engine-independent: a "faster" adapter that
// writes less produces a different sum and its lane is REJECTED. `--expose-gc`
// is mandatory or the heap columns the runner prints are meaningless.

export const SINK_SIZE = 4096;
export const SINK_MASK = SINK_SIZE - 1;

// The one shared sink, rooted on globalThis so it survives every optimiser pass.
export const SINK = new Float64Array(SINK_SIZE);
globalThis.__LSD_BENCH_SINK = SINK;

// Zero the sink before each timed run so a run's checksum reflects only that run.
export function resetSink() {
    for (let i = 0; i < SINK_SIZE; i++) SINK[i] = 0;
}

// Sum the whole sink into the checksum. Called once, after the timed loop.
export function sinkSum() {
    let s = 0;
    for (let i = 0; i < SINK_SIZE; i++) s += SINK[i];
    return s;
}

// The verdict for one lane. `got` is the summed sink; `expected` is the scenario's
// analytic value. Exact equality -- integer workloads inside the Float64 safe
// range must reproduce the sum bit-for-bit.
export function verifySink(expected) {
    const got = sinkSum();
    return { ok: got === expected, got, expected };
}
