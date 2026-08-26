// bench/scenarios/fleet-read.mjs -- S3-T4 scenario (shape is LAW, PLAN-S3 sec.2).
//
// SHAPE: FLEET of 10_000 view-models, each P=4 (f0..f3), D=2 (d0=f0+f1,
//        d1=f2+f3). SETUP (untimed): for VM v, write f0 = v; f1=f2=f3 stay 0,
//        so d0 of VM v settles at v. Default equality only.
//
// DRIVE (verbatim into every engine's dedicated closure):
//   read d0 of VM (i % 10000) -> sink.
//     vm = VMS[i % 10000]
//     value = vm.d0            (= f0 + f1 = v + 0 = v = i % 10000)
//     SINK[i & 4095] += value
//
// Pure read across the whole fleet: exposes cross-instance IC-shape behaviour
// (the megamorphism hazard measured in decisions/0003). No writes in the timed
// loop -- the computeds are cached; every read is a cache-hit accessor read.
// Reported: ops/s (kill-criterion 1; megamorphism exposure).

export const FLEET = 10_000;

export const SCENARIO = {
    key: "fleet-read",
    title: "FLEET-READ -- 10k VMs, P=4, D=2: read d0 of VM (i%10k)",
    shape: { P: 4, D: 2, VMs: FLEET },
    iters: 2_000_000,
    reported: "ops/s",
    expectedSumFor(iters) {
        let s = 0;
        for (let i = 0; i < iters; i++) s += i % FLEET;
        return s;
    },
};
