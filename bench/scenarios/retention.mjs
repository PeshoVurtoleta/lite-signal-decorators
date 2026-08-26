// bench/scenarios/retention.mjs -- S3-T4 scenario (shape is LAW, PLAN-S3 sec.2).
//
// SHAPE: the CHURN shape (construct P=4/D=2/E=1, one write + one derived read,
//        dispose) run for a FIXED 4096 cycles. Identical drive to churn.mjs;
//        this scenario differs only in what is REPORTED.
//
// DRIVE (verbatim into every engine's dedicated closure -- same as churn):
//     vm = construct()               // P=4, D=2, E=1 (effect fires once, live++)
//     switch (i & 3) { 0: f0=i; 1: f1=i; 2: f2=i; 3: f3=i }
//     value = vm.d0                  (fresh VM: only f0/f1 feed d0)
//     SINK[i & 4095] += value
//     dispose(vm)
//   value = (i & 3) < 2 ? i : 0
//
// REPORTED (NOT ops/s): retained-heap delta, GC collection counts, and for the
// lite lanes F-0 pool conservation to the post-warmup baseline. GATES, not a
// throughput number (PD-19). Effect duty is the churn duty (PD-18).

export const CYCLES = 4096;

export const SCENARIO = {
    key: "retention",
    title: "RETENTION -- 4096 churn cycles: retained-heap + GC gates + pool floor",
    shape: { P: 4, D: 2, E: 1 },
    iters: CYCLES,
    reported: "gates (retained-heap, GC counts, F-0 pool conservation)",
    expectedSumFor(iters) {
        let s = 0;
        for (let i = 0; i < iters; i++) {
            const m = i & 3;
            s += m < 2 ? i : 0;
        }
        return s;
    },
};
