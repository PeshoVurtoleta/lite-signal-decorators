// bench/scenarios/vm-write.mjs -- S3-T4 scenario (shape is LAW, PLAN-S3 sec.2).
//
// SHAPE: 1 view-model, P=4 reactive fields (f0,f1,f2,f3, init 0), D=2 deriveds
//        d0 = f0 + f1, d1 = f2 + f3 (fixed-sum shape). Default equality only.
//
// DRIVE (verbatim into every engine's dedicated closure):
//   write field (i & 3) with i, then read d0 -> sink.
//     switch (i & 3) { 0: f0=i; 1: f1=i; 2: f2=i; 3: f3=i }
//     value = d0 (= f0 + f1)
//     SINK[i & 4095] += value            // masked anti-DCE accumulate
//
// After write at iteration i the live fields are: f0 = i - (i & 3) once
// reached, f1 the last i' <= i with (i'&3)==1, etc. d1 is constructed but not
// read (it is part of the P=4/D=2 shape). Reported: ops/s (kill-criterion 1).
//
// expectedSum is analytic: an integer sum, so the masked-slot accumulation
// order in the sink is irrelevant (every value is an integer and the total
// stays < 2^53 -- float64 addition is exact and order-independent there).

export const SCENARIO = {
    key: "vm-write",
    title: "VM-WRITE -- 1 VM, P=4, D=2: write field (i&3), read d0",
    shape: { P: 4, D: 2 },
    iters: 2_000_000,
    reported: "ops/s",
    // Oracle: the exact drive index math in plain arithmetic (no boxes).
    expectedSumFor(iters) {
        const f = [0, 0, 0, 0];
        let s = 0;
        for (let i = 0; i < iters; i++) {
            f[i & 3] = i;
            s += f[0] + f[1];
        }
        return s;
    },
};
