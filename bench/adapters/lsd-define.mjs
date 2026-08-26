// bench/adapters/lsd-define.mjs -- the "ours" buildless twin: the SAME package,
// wired through `defineReactive(Class, spec)` with zero decorator syntax (the
// package's real no-build path, stock Node). Same wiring core as the decorator
// lane by function identity, so post-construction behaviour is in full parity.
//
// The drive closures are line-for-line identical to lsd.mjs (direct member
// access on the instance: `vm.fN = i`, `s = vm.dK`) -- only the CLASS-BUILD step
// differs (defineReactive spec vs the emitter). REGISTRY LAW and effect duty
// (PD-18) are identical to lsd.mjs.
//
// EFFECT FLUSH SEMANTICS (PD-18): the buildless effect is the SAME auto-effect
// as the decorator path -- synchronous first run after wiring, synchronous
// re-run on a tracked change; reads d0, bumps a live counter, never the sink.

import { defineReactive, disposeReactive, VERSION } from "../../SignalDecorators.js";
import { createRegistry } from "@zakkster/lite-signal";
import { KEYS as CASCADE_KEYS } from "../scenarios/cascade.mjs";

const SINK_MASK = 4095;

function pow2AtLeast(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
function sizeRegistry(numVMs, nodesPerVM) {
    return Math.max(256, pow2AtLeast((numVMs + 1) * nodesPerVM + 64));
}

// --- Class factories (defineReactive specs; class code lives once) -----------

function buildStdDefine(reg, withEffect, liveness) {
    const spec = {
        signals: { f0: 0, f1: 0, f2: 0, f3: 0 },
        deriveds: {
            d0: (s) => s.f0 + s.f1,
            d1: (s) => s.f2 + s.f3,
        },
        host: { registry: reg },
    };
    if (withEffect) spec.effects = { e0: (s) => { liveness.n++; void s.d0; } };
    return defineReactive(class {}, spec);
}

// Derived bodies use LITERAL named member access (`s.f0 + s.f1 + ...`), the
// buildless equivalent of a hand-written derivation -- `new Function` only
// assembles that literal body once at build time (a computed-key read `s[k]`
// would be a keyed-load artifact that unfairly taxes the ours lane).
function buildCascadeDefine(reg) {
    const signals = {};
    for (let j = 0; j < 64; j++) signals["f" + j] = 0;
    const deriveds = {};
    for (let k = 0; k < 16; k++) {
        deriveds["g" + k] = new Function(
            "s", "return s.f" + (4 * k) + " + s.f" + (4 * k + 1) +
            " + s.f" + (4 * k + 2) + " + s.f" + (4 * k + 3) + ";");
    }
    let aggExpr = "return s.g0";
    for (let k = 1; k < 16; k++) aggExpr += " + s.g" + k;
    deriveds.agg = new Function("s", aggExpr + ";");
    return defineReactive(class {}, { signals, deriveds, host: { registry: reg } });
}

function buildDeepDefine(reg) {
    const signals = { x: 0 };
    const deriveds = {};
    for (let k = 0; k < 64; k++) {
        const prev = k === 0 ? "x" : "d" + (k - 1);
        deriveds["d" + k] = new Function("s", "return s." + prev + " + 1;");
    }
    return defineReactive(class {}, { signals, deriveds, host: { registry: reg } });
}

function makeChurn(shape, ctx) {
    const SINK = ctx.sink;
    const liveness = { n: 0 };
    const reg = createRegistry({ maxNodes: sizeRegistry(2, 4 + 2 + 1 + 1), onCapacityExceeded: "throw" });
    const VM = buildStdDefine(reg, true, liveness);
    return {
        drive(i) {
            const vm = new VM();
            switch (i & 3) {
                case 0: vm.f0 = i; break;
                case 1: vm.f1 = i; break;
                case 2: vm.f2 = i; break;
                case 3: vm.f3 = i; break;
            }
            const v = vm.d0;
            SINK[i & SINK_MASK] += v;
            disposeReactive(vm);
        },
        expectedSum: ctx.expectedSum,
        dispose() { reg.destroy(); },
        stats() { return reg.stats(); },
        liveness() { return liveness.n; },
    };
}

export const ADAPTER = {
    key: "lsd-define",
    version() { return VERSION; },
    build: {
        "vm-write"(shape, ctx) {
            const SINK = ctx.sink;
            const reg = createRegistry({ maxNodes: sizeRegistry(1, 4 + 2 + 0 + 1), onCapacityExceeded: "throw" });
            const VM = buildStdDefine(reg, false, null);
            const vm = new VM();
            return {
                drive(i) {
                    switch (i & 3) {
                        case 0: vm.f0 = i; break;
                        case 1: vm.f1 = i; break;
                        case 2: vm.f2 = i; break;
                        case 3: vm.f3 = i; break;
                    }
                    const v = vm.d0;
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { disposeReactive(vm); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        "fleet-read"(shape, ctx) {
            const SINK = ctx.sink;
            const F = shape.VMs;
            const reg = createRegistry({ maxNodes: sizeRegistry(F, 4 + 2 + 0 + 1), onCapacityExceeded: "throw" });
            const VM = buildStdDefine(reg, false, null);
            const vms = new Array(F);
            for (let v = 0; v < F; v++) { const o = new VM(); o.f0 = v; vms[v] = o; }
            return {
                drive(i) {
                    const vm = vms[i % F];
                    const v = vm.d0;
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { for (let v = 0; v < F; v++) disposeReactive(vms[v]); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        "fleet-tick"(shape, ctx) {
            const SINK = ctx.sink;
            const F = shape.VMs;
            const reg = createRegistry({ maxNodes: sizeRegistry(F, 4 + 2 + 0 + 1), onCapacityExceeded: "throw" });
            const VM = buildStdDefine(reg, false, null);
            const vms = new Array(F);
            for (let v = 0; v < F; v++) { const o = new VM(); o.f1 = v; vms[v] = o; }
            return {
                drive(i) {
                    const vm = vms[i % F];
                    vm.f0 = i;
                    const v = vm.d0;
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { for (let v = 0; v < F; v++) disposeReactive(vms[v]); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        cascade(shape, ctx) {
            const SINK = ctx.sink;
            const reg = createRegistry({ maxNodes: sizeRegistry(1, 64 + 17 + 0 + 1), onCapacityExceeded: "throw" });
            const VM = buildCascadeDefine(reg);
            const vm = new VM();
            return {
                drive(i) {
                    vm[CASCADE_KEYS[i & 63]] = i;
                    const v = vm.agg;
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { disposeReactive(vm); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        "deep-vm"(shape, ctx) {
            const SINK = ctx.sink;
            const reg = createRegistry({ maxNodes: sizeRegistry(1, 1 + 64 + 0 + 1), onCapacityExceeded: "throw" });
            const VM = buildDeepDefine(reg);
            const vm = new VM();
            return {
                drive(i) {
                    vm.x = i;
                    const v = vm.d63;
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { disposeReactive(vm); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        churn(shape, ctx) { return makeChurn(shape, ctx); },
        retention(shape, ctx) { return makeChurn(shape, ctx); },
    },
};
