// bench/scenarios/churn.mjs -- S3-T4 scenario (shape is LAW, PLAN-S3 sec.2).
// THE HEADLINE (kill-criterion 2).
//
// SHAPE: per iteration, CONSTRUCT a fresh view-model with P=4 (f0..f3, init 0),
//        D=2 (d0=f0+f1, d1=f2+f3), E=1 (one effect that reads d0 and bumps a
//        live counter). Default equality only.
//
// DRIVE (verbatim into every engine's dedicated closure):
//   construct, one write + one derived read, dispose -> sink.
//     vm = construct()               // P=4, D=2, E=1 (effect fires once, live++)
//     switch (i & 3) { 0: f0=i; 1: f1=i; 2: f2=i; 3: f3=i }
//     value = vm.d0                  (fresh VM: only f0/f1 feed d0)
//     SINK[i & 4095] += value
//     dispose(vm)
//
// On a FRESH VM all fields are 0, so after writing field (i&3):
//   (i&3)==0 -> f0=i -> d0=i ;  (i&3)==1 -> f1=i -> d0=i ;  else d0=0.
// Hence value = (i & 3) < 2 ? i : 0. The construct/dispose loop IS the op.
//
// EFFECT DUTY (PD-18): the E=1 effect reads d0 and bumps a live counter once
// per construction (>= iters). Effect timing does NOT touch the sink -- the
// sink is fed only by the drive's own d0 read. Reported: ops/s + maxMajor +
// pool floor (the lite lanes hold F-0 conservation, maxMajor 0).

export const SCENARIO = {
    key: "churn",
    title: "CHURN -- construct(P=4,D=2,E=1), write+read, dispose (per iter)",
    shape: { P: 4, D: 2, E: 1 },
    iters: 200_000,
    reported: "ops/s + maxMajor + pool-floor",
    expectedSumFor(iters) {
        let s = 0;
        for (let i = 0; i < iters; i++) {
            const m = i & 3;
            s += m < 2 ? i : 0;
        }
        return s;
    },
};
