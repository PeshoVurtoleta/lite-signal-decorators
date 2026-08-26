// bench/scenarios/deep-vm.mjs -- S3-T4 scenario (shape is LAW, PLAN-S3 sec.2).
//
// SHAPE: 1 view-model, P=1 reactive field (x, init 0), a chain of D=64
//        deriveds: d0 = x + 1, dk = d(k-1) + 1 (k=1..63). So d63 = x + 64.
//        Default equality only.
//
// DRIVE (verbatim into every engine's dedicated closure):
//   write x, then read the chain tip d63 -> sink.
//     vm.x = i
//     value = vm.d63          (= x + 64 = i + 64)
//     SINK[i & 4095] += value
//
// One write at the head propagates the full 64-deep computed chain; the read
// pulls the tip. Reported: ops/s.

export const DEPTH = 64;

export const SCENARIO = {
    key: "deep-vm",
    title: "DEEP-VM -- 1 VM, P=1, D=64 chain: write x, read d63",
    shape: { P: 1, depth: DEPTH },
    iters: 500_000,
    reported: "ops/s",
    expectedSumFor(iters) {
        let s = 0;
        for (let i = 0; i < iters; i++) s += i + DEPTH;
        return s;
    },
};
