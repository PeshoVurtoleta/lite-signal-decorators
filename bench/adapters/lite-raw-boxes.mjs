// bench/adapters/lite-raw-boxes.mjs -- the HONESTY BASELINE: a hand-written
// class over @zakkster/lite-signal primitives, no decorators, the RAW-FIELD
// pattern from decisions/0003 (instance fields `this.bx = reg.signalBox(v)`,
// derived getters over `reg.computedBox`, an explicit dispose list). This is the
// real-world alternative a developer writes by hand; the "ours" lanes are judged
// against THIS, not against a module-const floor (0003 kill-criterion 1).
//
// Lifecycle mirrors the package's own wiring (SignalDecorators.js disposeCore):
// an anchor owner captured via createRoot + effect(getOwner); deriveds and the
// effect created under runWithOwner(anchor) so the anchor cascade tears them
// down; signal boxes are bare and disposed explicitly. REGISTRY LAW: a dedicated
// sized registry with onCapacityExceeded:"throw"; churn/retention pool columns
// read reg.stats().
//
// The drive closures do the SAME work as lsd.mjs (same indices, same op mix,
// same reads) -- they differ only in the member-access syntax (`vm.fN.set(i)` /
// `vm.dK.get()`), which is the honest hand-written form being compared.
//
// EFFECT FLUSH SEMANTICS (PD-18): reg.effect runs synchronously once at wire and
// synchronously on a tracked change; the churn/retention effect reads d0 and
// bumps a live counter, never the sink.

import { createRegistry } from "@zakkster/lite-signal";
import { KEYS as CASCADE_KEYS } from "../scenarios/cascade.mjs";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const SINK_MASK = 4095;

function pow2AtLeast(n) {
    let p = 1;
    while (p < n) p <<= 1;
    return p;
}
function sizeRegistry(numVMs, nodesPerVM) {
    return Math.max(256, pow2AtLeast((numVMs + 1) * nodesPerVM + 64));
}

// Resolve the peer engine's real version for the provenance stamp (walk up from
// the resolved entry file to the package's own package.json).
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

// --- Raw VM factories (RAW-FIELD; hand-written lifecycle) ---------------------

function makeStdRaw(reg, withEffect, liveness) {
    let anchor;
    reg.createRoot(() => { reg.effect(() => { anchor = reg.getOwner(); }); });
    const f0 = reg.signalBox(0), f1 = reg.signalBox(0), f2 = reg.signalBox(0), f3 = reg.signalBox(0);
    let d0, d1;
    reg.runWithOwner(anchor, () => {
        d0 = reg.computedBox(() => f0.get() + f1.get());
        d1 = reg.computedBox(() => f2.get() + f3.get());
        if (withEffect) reg.effect(() => { liveness.n++; void d0.get(); });
    });
    return {
        f0, f1, f2, f3, d0, d1,
        dispose() {
            reg.dispose(anchor);   // cascades d0, d1, and the effect
            reg.dispose(f0); reg.dispose(f1); reg.dispose(f2); reg.dispose(f3);
        },
    };
}

function makeCascadeRaw(reg) {
    let anchor;
    reg.createRoot(() => { reg.effect(() => { anchor = reg.getOwner(); }); });
    const f = new Array(64);
    for (let j = 0; j < 64; j++) f[j] = reg.signalBox(0);
    const g = new Array(16);
    let agg;
    reg.runWithOwner(anchor, () => {
        for (let k = 0; k < 16; k++) {
            const a = f[4 * k], b = f[4 * k + 1], c = f[4 * k + 2], d = f[4 * k + 3];
            g[k] = reg.computedBox(() => a.get() + b.get() + c.get() + d.get());
        }
        agg = reg.computedBox(() => { let s = 0; for (let k = 0; k < 16; k++) s += g[k].get(); return s; });
    });
    const vm = {
        agg,
        dispose() { reg.dispose(anchor); for (let j = 0; j < 64; j++) reg.dispose(f[j]); },
    };
    for (let j = 0; j < 64; j++) vm["f" + j] = f[j];
    return vm;
}

function makeDeepRaw(reg) {
    let anchor;
    reg.createRoot(() => { reg.effect(() => { anchor = reg.getOwner(); }); });
    const x = reg.signalBox(0);
    const d = new Array(64);
    reg.runWithOwner(anchor, () => {
        let prev = x;
        for (let k = 0; k < 64; k++) { const p = prev; d[k] = reg.computedBox(() => p.get() + 1); prev = d[k]; }
    });
    return {
        x, d63: d[63],
        dispose() { reg.dispose(anchor); reg.dispose(x); },
    };
}

function makeChurn(shape, ctx) {
    const SINK = ctx.sink;
    const liveness = { n: 0 };
    const reg = createRegistry({ maxNodes: sizeRegistry(2, 4 + 2 + 1 + 1), onCapacityExceeded: "throw" });
    return {
        drive(i) {
            const vm = makeStdRaw(reg, true, liveness);
            switch (i & 3) {
                case 0: vm.f0.set(i); break;
                case 1: vm.f1.set(i); break;
                case 2: vm.f2.set(i); break;
                case 3: vm.f3.set(i); break;
            }
            const v = vm.d0.get();
            SINK[i & SINK_MASK] += v;
            vm.dispose();
        },
        expectedSum: ctx.expectedSum,
        dispose() { reg.destroy(); },
        stats() { return reg.stats(); },
        liveness() { return liveness.n; },
    };
}

export const ADAPTER = {
    key: "lite-raw-boxes",
    version() { return resolveVersion("@zakkster/lite-signal"); },
    build: {
        "vm-write"(shape, ctx) {
            const SINK = ctx.sink;
            const reg = createRegistry({ maxNodes: sizeRegistry(1, 4 + 2 + 0 + 1), onCapacityExceeded: "throw" });
            const vm = makeStdRaw(reg, false, null);
            return {
                drive(i) {
                    switch (i & 3) {
                        case 0: vm.f0.set(i); break;
                        case 1: vm.f1.set(i); break;
                        case 2: vm.f2.set(i); break;
                        case 3: vm.f3.set(i); break;
                    }
                    const v = vm.d0.get();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { vm.dispose(); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        "fleet-read"(shape, ctx) {
            const SINK = ctx.sink;
            const F = shape.VMs;
            const reg = createRegistry({ maxNodes: sizeRegistry(F, 4 + 2 + 0 + 1), onCapacityExceeded: "throw" });
            const vms = new Array(F);
            for (let v = 0; v < F; v++) { const o = makeStdRaw(reg, false, null); o.f0.set(v); vms[v] = o; }
            return {
                drive(i) {
                    const vm = vms[i % F];
                    const v = vm.d0.get();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { for (let v = 0; v < F; v++) vms[v].dispose(); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        "fleet-tick"(shape, ctx) {
            const SINK = ctx.sink;
            const F = shape.VMs;
            const reg = createRegistry({ maxNodes: sizeRegistry(F, 4 + 2 + 0 + 1), onCapacityExceeded: "throw" });
            const vms = new Array(F);
            for (let v = 0; v < F; v++) { const o = makeStdRaw(reg, false, null); o.f1.set(v); vms[v] = o; }
            return {
                drive(i) {
                    const vm = vms[i % F];
                    vm.f0.set(i);
                    const v = vm.d0.get();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { for (let v = 0; v < F; v++) vms[v].dispose(); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        cascade(shape, ctx) {
            const SINK = ctx.sink;
            const reg = createRegistry({ maxNodes: sizeRegistry(1, 64 + 17 + 0 + 1), onCapacityExceeded: "throw" });
            const vm = makeCascadeRaw(reg);
            return {
                drive(i) {
                    vm[CASCADE_KEYS[i & 63]].set(i);
                    const v = vm.agg.get();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { vm.dispose(); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        "deep-vm"(shape, ctx) {
            const SINK = ctx.sink;
            const reg = createRegistry({ maxNodes: sizeRegistry(1, 1 + 64 + 0 + 1), onCapacityExceeded: "throw" });
            const vm = makeDeepRaw(reg);
            return {
                drive(i) {
                    vm.x.set(i);
                    const v = vm.d63.get();
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() { vm.dispose(); reg.destroy(); },
                stats() { return reg.stats(); },
            };
        },

        churn(shape, ctx) { return makeChurn(shape, ctx); },
        retention(shape, ctx) { return makeChurn(shape, ctx); },
    },
};
