// bench/scenarios/churn-reuse.mjs -- S6-T7 scenario (shape is LAW, mirrors CHURN).
// THE REUSE COUNTERPART to CHURN: same VM shape, but the measured op is
// acquire/release over a POOL of pre-constructed PARKED instances, not
// construct/dispose of a fresh one. CHURN measures first construction; this lane
// measures REUSE.
//
// SHAPE: identical to CHURN -- P=4 (f0..f3, init 0), D=2 (d0=f0+f1, d1=f2+f3),
//        E=1 (an effect that reads d0 and bumps a live counter). Default equality.
//
// POOL / WARMUP DISCIPLINE (the crux): the pool of N instances is CONSTRUCTED and
// PARKED inside build() -- i.e. in the harness's warmup phase and once more before
// each timed rep -- OUTSIDE the timed drive() loop. The timed region therefore
// pays ZERO first-construction cost; it measures only reinit -> touch -> release
// against instances that already exist and already hold their prebuilt closures
// (built lazily at first release, decisions/0011). This is the published number
// that shows whether pooled reuse beats construct/dispose churn.
//
// DRIVE (verbatim into every engine's dedicated closure):
//   acquire a parked instance, reinit (resets fields to 0), write TWO props,
//   read the derived (the effect fires once, live++), sink the read, release.
//     vm = pool[i & POOL_MASK]        // a PARKED instance (0 engine nodes)
//     reinit(vm)                      // revive: P=4,D=2,E=1 rebuilt, all fields 0
//     vm.f0 = i ; vm.f1 = i           // touch two props (both feed d0)
//     value = vm.d0                   // = f0 + f1 = 2*i (effect also read it)
//     SINK[i & 4095] += value
//     release(vm)                     // park again -> 0 engine nodes
//
// After reinit all fields are 0; writing f0=i and f1=i gives d0 = 2*i. Hence
// value = 2*i every iteration. The reinit/release cycle IS the op.
//
// EFFECT DUTY (PD-18): the E=1 effect reads d0 and bumps a live counter once per
// reinit (>= iters). Effect timing does NOT touch the sink -- the sink is fed only
// by the drive's own d0 read, exactly as CHURN. Reported: ops/s + maxMajor +
// pool floor (the lite lanes hold F-0 conservation, maxMajor 0).

export const SCENARIO = {
    key: "churn-reuse",
    title: "CHURN-REUSE -- reinit(P=4,D=2,E=1) + write+read + release, over a parked pool",
    shape: { P: 4, D: 2, E: 1 },
    iters: 200_000,
    reported: "ops/s + maxMajor + pool-floor",
    expectedSumFor(iters) {
        let s = 0;
        for (let i = 0; i < iters; i++) s += 2 * i;   // d0 = f0 + f1 = i + i
        return s;
    },
};
