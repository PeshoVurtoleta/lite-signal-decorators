// bench/adapters/lsd.mjs -- the "ours" lane: @zakkster/lite-signal-decorators
// driven through the package's OWN Stage-3 protocol emitter (PD-16). Classes are
// assembled by test/shared/mock-emitter.mjs `buildClass`, whose emit fidelity to
// TS 5 / Babel 2023-11 is pinned by tests 02/03 -- so a class built here drives
// the SAME code path as a transpiled one.
//
// Members: @reactive accessors, @derived getters, @reactiveEffect method
// (churn/retention only), @reactiveHost({ registry }). Dispose: disposeReactive.
//
// REGISTRY LAW: every scenario runs on a DEDICATED lite-signal registry sized
// for its node budget with onCapacityExceeded:"throw" -- a capacity throw here
// would be a bench bug, never a masked pass. Pool-floor / conservation columns
// (churn, retention) read THAT registry's stats().
//
// EFFECT FLUSH SEMANTICS (PD-18): @reactiveEffect auto-runs synchronously once
// the instance is wired (D-4a: after every derived) and re-runs synchronously on
// a tracked change. The churn/retention effect reads d0 and bumps a live counter
// each run (liveness proof); it never writes the sink.

import {
    reactive,
    derived,
    reactiveEffect,
    reactiveHost,
    disposeReactive,
    VERSION,
} from "../../SignalDecorators.js";
import { buildClass } from "../../test/shared/mock-emitter.mjs";
import { createRegistry } from "@zakkster/lite-signal";
import { KEYS as CASCADE_KEYS } from "../scenarios/cascade.mjs";

const SINK_MASK = 4095;

// nodes per VM = P reactive + D deriveds + E effects + 1 anchor.
function pow2AtLeast(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
function sizeRegistry(numVMs, nodesPerVM) {
    return Math.max(256, pow2AtLeast((numVMs + 1) * nodesPerVM + 64));
}

// --- Class factories (built once per scenario; PD-17: class code lives once) ---

// Standard VM: P=4, D=2 (d0=f0+f1, d1=f2+f3), optional E=1 effect over d0.
function buildStdClass(reg, withEffect, liveness) {
    const members = [
        { kind: "accessor", key: "f0", decorator: reactive, value: () => 0 },
        { kind: "accessor", key: "f1", decorator: reactive, value: () => 0 },
        { kind: "accessor", key: "f2", decorator: reactive, value: () => 0 },
        { kind: "accessor", key: "f3", decorator: reactive, value: () => 0 },
        { kind: "getter", key: "d0", decorator: derived, body: function () { return this.f0 + this.f1; } },
        { kind: "getter", key: "d1", decorator: derived, body: function () { return this.f2 + this.f3; } },
    ];
    if (withEffect) {
        members.push({
            kind: "method",
            key: "e0",
            decorator: reactiveEffect,
            body: function () { liveness.n++; void this.d0; },
        });
    }
    return buildClass({ name: "StdVM", classDecorator: reactiveHost({ registry: reg }), members });
}

// Cascade VM: P=64, D=16 group deriveds (each over 4 fields) + 1 aggregate.
// Derived bodies are generated with LITERAL named member access (`this.f0 +
// this.f1 + ...`) exactly as a hand-written / transpiled cascade class emits --
// `new Function` here only assembles that literal body at class-build time (the
// alternative, a computed-key read `this[k]`, would be a keyed-load artifact
// no real decorated class carries and would unfairly tax the ours lane).
function buildCascadeClass(reg) {
    const members = [];
    for (let j = 0; j < 64; j++) {
        members.push({ kind: "accessor", key: "f" + j, decorator: reactive, value: () => 0 });
    }
    for (let k = 0; k < 16; k++) {
        const body = new Function(
            "return this.f" + (4 * k) + " + this.f" + (4 * k + 1) +
            " + this.f" + (4 * k + 2) + " + this.f" + (4 * k + 3) + ";");
        members.push({ kind: "getter", key: "g" + k, decorator: derived, body });
    }
    let aggExpr = "return this.g0";
    for (let k = 1; k < 16; k++) aggExpr += " + this.g" + k;
    members.push({ kind: "getter", key: "agg", decorator: derived, body: new Function(aggExpr + ";") });
    return buildClass({ name: "CascadeVM", classDecorator: reactiveHost({ registry: reg }), members });
}

// Deep VM: P=1 (x), D=64 chain (d0=x+1, dk=d(k-1)+1). Literal named access per
// getter (transpiler-faithful; see buildCascadeClass on `new Function`).
function buildDeepClass(reg) {
    const members = [{ kind: "accessor", key: "x", decorator: reactive, value: () => 0 }];
    for (let k = 0; k < 64; k++) {
        const prev = k === 0 ? "x" : "d" + (k - 1);
        members.push({ kind: "getter", key: "d" + k, decorator: derived, body: new Function("return this." + prev + " + 1;") });
    }
    return buildClass({ name: "DeepVM", classDecorator: reactiveHost({ registry: reg }), members });
}

// --- Churn/retention share one builder (identical drive) ---------------------
function makeChurn(shape, ctx) {
    const SINK = ctx.sink;
    const liveness = { n: 0 };
    const reg = createRegistry({ maxNodes: sizeRegistry(2, 4 + 2 + 1 + 1), onCapacityExceeded: "throw" });
    const VM = buildStdClass(reg, true, liveness);
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
    key: "lsd",
    version() { return VERSION; },
    build: {
        "vm-write"(shape, ctx) {
            const SINK = ctx.sink;
            const reg = createRegistry({ maxNodes: sizeRegistry(1, 4 + 2 + 0 + 1), onCapacityExceeded: "throw" });
            const VM = buildStdClass(reg, false, null);
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
            const VM = buildStdClass(reg, false, null);
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
            const VM = buildStdClass(reg, false, null);
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
            const VM = buildCascadeClass(reg);
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
            const VM = buildDeepClass(reg);
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
