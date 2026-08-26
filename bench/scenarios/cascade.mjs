// bench/scenarios/cascade.mjs -- S3-T4 scenario (shape is LAW, PLAN-S3 sec.2).
//
// SHAPE: 1 view-model, P=64 reactive fields (f0..f63, init 0), D=16 group
//        deriveds g_k = f[4k] + f[4k+1] + f[4k+2] + f[4k+3] (k=0..15), plus 1
//        aggregate derived agg = g0 + g1 + ... + g15 (= sum of all 64 fields).
//        Default equality only.
//
// DRIVE (verbatim into every engine's dedicated closure):
//   write field (i & 63) with i, then read the aggregate -> sink.
//     KEYS = ["f0", ..., "f63"]   // preallocated key table, built once
//     vm[KEYS[i & 63]] = i        // dedicated store-by-index, no shared verb
//     value = vm.agg              (= sum of all 64 fields' last-written values)
//     SINK[i & 4095] += value
//
// The 64-way index write uses a preallocated string-key table (built once at
// setup, never per-iter -- zero allocation). It is a direct store on THIS
// engine's instance, not a cross-engine dispatch verb; each engine's closure
// carries its own copy differing only in the store syntax. Reported: ops/s.

export const P = 64;
export const GROUPS = 16;
export const GROUP = 4;

// Preallocated key table -- shared read-only constant across adapters.
export const KEYS = (() => {
    const a = new Array(P);
    for (let j = 0; j < P; j++) a[j] = "f" + j;
    return a;
})();

export const SCENARIO = {
    key: "cascade",
    title: "CASCADE -- 1 VM, P=64, D=16 groups + 1 aggregate: write field (i&63), read agg",
    shape: { P: P, D: GROUPS, group: GROUP, aggregate: true },
    iters: 500_000,
    reported: "ops/s",
    expectedSumFor(iters) {
        const f = new Array(P).fill(0);
        let s = 0;
        for (let i = 0; i < iters; i++) {
            f[i & 63] = i;
            let a = 0;
            for (let j = 0; j < P; j++) a += f[j];
            s += a;
        }
        return s;
    },
};
