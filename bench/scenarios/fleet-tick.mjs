// bench/scenarios/fleet-tick.mjs -- S3-T4 scenario (shape is LAW, PLAN-S3 sec.2).
//
// SHAPE: FLEET of 10_000 view-models, each P=4 (f0..f3), D=2 (d0=f0+f1,
//        d1=f2+f3). SETUP (untimed): for VM v, write f1 = v (the per-VM
//        constant summand); f0=f2=f3 stay 0. Default equality only.
//
// DRIVE (verbatim into every engine's dedicated closure):
//   write one field of VM (i % 10000), read its d0 -> sink.
//     vm = VMS[i % 10000]
//     vm.f0 = i
//     value = vm.d0           (= f0 + f1 = i + v = i + (i % 10000))
//     SINK[i & 4095] += value
//
// One write + one derived read per tick, rotating across the fleet: the write
// invalidates d0, the read forces its recompute. Reported: ops/s.

export const FLEET = 10_000;

export const SCENARIO = {
    key: "fleet-tick",
    title: "FLEET-TICK -- 10k VMs, P=4, D=2: write f0 of VM (i%10k), read d0",
    shape: { P: 4, D: 2, VMs: FLEET },
    iters: 1_000_000,
    reported: "ops/s",
    expectedSumFor(iters) {
        let s = 0;
        for (let i = 0; i < iters; i++) s += i + (i % FLEET);
        return s;
    },
};
