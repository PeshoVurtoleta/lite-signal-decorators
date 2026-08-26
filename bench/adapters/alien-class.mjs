// bench/adapters/alien-class.mjs -- reference lane: a hand-rolled class over
// alien-signals primitives (instance fields over signal()/computed()/effect()).
// alien-signals resolves as plain ESM in stock Node (PD-16 admission (a)); its
// class reactivity is the documented non-decorator primitive API (admission
// (b)). It has no registry/pool -- so no stats() column; it reports its own
// measured GC collections in the runner, being a reference engine.
//
// The drive closures do the SAME work as lsd.mjs (same indices, op mix, reads),
// differing only in alien's call-style access: `vm.fN(i)` writes, `vm.dK()`
// reads.
//
// EFFECT FLUSH SEMANTICS (PD-18): alien-signals `effect` runs synchronously once
// at creation and synchronously on a tracked change (pull graph, eager effects).
// The churn/retention effect reads d0 and bumps a live counter, never the sink;
// teardown calls the effect's returned stop function.

import { signal, computed, effect } from "alien-signals";
import { KEYS as CASCADE_KEYS } from "../scenarios/cascade.mjs";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SINK_MASK = 4095;

function resolveVersion(spec) {
    const require = createRequire(import.meta.url);
    let dir;
    try { dir = dirname(require.resolve(spec)); } catch { return "unknown"; }
    for (let depth = 0; depth < 8; depth++) {
        const pj = join(dir, "package.json");
        if (existsSync(pj)) {
            try {
                const m = JSON.parse(readFileSync(pj, "utf8"));
                if (m.name === spec) return m.version;
            } catch { /* keep walking */ }
        }
        const up = dirname(dir);
        if (up === dir) break;
        dir = up;
    }
    return "unknown";
}

// --- Alien VM factories ------------------------------------------------------

function makeStdAlien(withEffect, liveness) {
    const f0 = signal(0), f1 = signal(0), f2 = signal(0), f3 = signal(0);
    const d0 = computed(() => f0() + f1());
    const d1 = computed(() => f2() + f3());
    let stop = null;
    if (withEffect) stop = effect(() => { liveness.n++; void d0(); });
    return {
        f0, f1, f2, f3, d0, d1,
        dispose() { if (stop) stop(); },
    };
}

function makeCascadeAlien() {
    const f = new Array(64);
    for (let j = 0; j < 64; j++) f[j] = signal(0);
    const g = new Array(16);
    for (let k = 0; k < 16; k++) {
        const a = f[4 * k], b = f[4 * k + 1], c = f[4 * k + 2], d = f[4 * k + 3];
        g[k] = computed(() => a() + b() + c() + d());
    }
    const agg = computed(() => { let s = 0; for (let k = 0; k < 16; k++) s += g[k](); return s; });
    const vm = { agg, dispose() {} };
    for (let j = 0; j < 64; j++) vm["f" + j] = f[j];
    return vm;
}

function makeDeepAlien() {
    const x = signal(0);
    const d = new Array(64);
    let prev = x;
    for (let k = 0; k < 64; k++) { const p = prev; d[k] = computed(() => p() + 1); prev = d[k]; }
    return { x, d63: d[63], dispose() {} };
}

function makeChurn(shape, ctx) {
    const SINK = ctx.sink;
    const liveness = { n: 0 };
    return {
        drive(i) {
            const vm = makeStdAlien(true, liveness);
            switch (i & 3) {
                case 0: vm.f0(i); break;
                case 1: vm.f1(i); break;
                case 2: vm.f2(i); break;
                case 3: vm.f3(i); break;
            }
            const v = vm.d0();
            SINK[i & SINK_MASK] += v;
            vm.dispose();
        },
        expectedSum: ctx.expectedSum,
        dispose() {},
        liveness() { return liveness.n; },
    };
}

export const ADAPTER = {
    key: "alien-class",
    version() { return resolveVersion("alien-signals"); },
    build: {
        "vm-write"(shape, ctx) {
            const SINK = ctx.sink;
            const vm = makeStdAlien(false, null);
            return {
                drive(i) {
                    switch (i & 3) {
                        case 0: vm.f0(i); break;
                        case 1: vm.f1(i); break;
                        case 2: vm.f2(i); break;
                        case 3: vm.f3(i); break;
                    }
                    const v = vm.d0();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { vm.dispose(); },
            };
        },

        "fleet-read"(shape, ctx) {
            const SINK = ctx.sink;
            const F = shape.VMs;
            const vms = new Array(F);
            for (let v = 0; v < F; v++) { const o = makeStdAlien(false, null); o.f0(v); vms[v] = o; }
            return {
                drive(i) {
                    const vm = vms[i % F];
                    const v = vm.d0();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { for (let v = 0; v < F; v++) vms[v].dispose(); },
            };
        },

        "fleet-tick"(shape, ctx) {
            const SINK = ctx.sink;
            const F = shape.VMs;
            const vms = new Array(F);
            for (let v = 0; v < F; v++) { const o = makeStdAlien(false, null); o.f1(v); vms[v] = o; }
            return {
                drive(i) {
                    const vm = vms[i % F];
                    vm.f0(i);
                    const v = vm.d0();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { for (let v = 0; v < F; v++) vms[v].dispose(); },
            };
        },

        cascade(shape, ctx) {
            const SINK = ctx.sink;
            const vm = makeCascadeAlien();
            return {
                drive(i) {
                    vm[CASCADE_KEYS[i & 63]](i);
                    const v = vm.agg();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { vm.dispose(); },
            };
        },

        "deep-vm"(shape, ctx) {
            const SINK = ctx.sink;
            const vm = makeDeepAlien();
            return {
                drive(i) {
                    vm.x(i);
                    const v = vm.d63();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { vm.dispose(); },
            };
        },

        churn(shape, ctx) { return makeChurn(shape, ctx); },
        retention(shape, ctx) { return makeChurn(shape, ctx); },
    },
};
