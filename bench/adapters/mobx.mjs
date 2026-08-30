// bench/adapters/mobx.mjs -- reference lane: MobX 7 class reactivity.
// mobx resolves as plain ESM in stock Node (PD-16 admission (a)); its class
// reactivity is the documented non-decorator class API `makeObservable`
// (admission (b)).
//
// FORM CHOSEN: makeObservable(this, { fN: observable, dK: computed }) -- MobX's
// documented canonical class API. Probed against the standard-2023-11 accessor-
// decorator form (mobx.observable / mobx.computed driven through the package's
// own emitter): both produce IDENTICAL checksums; makeObservable is consistently
// fastest-or-equal (vm-write 200k: ~21.4ms vs ~23.2ms) and needs no emitter, so
// it is the fastest CORRECT documented form here.
//
// configure({ enforceActions: "never" }): the bench drives PLAIN field writes
// (`vm.f0 = i`) outside mobx actions -- the same honest write path every other
// engine uses; without this mobx would throw. mobx has no registry/pool, so no
// stats() column; it reports its own measured GC collections in the runner.
//
// The drive closures do the SAME work as lsd.mjs (same indices, op mix, reads),
// differing only in mobx member-access style (getter reads `vm.dK`, plain field
// writes `vm.fN = i`).
//
// EFFECT FLUSH SEMANTICS (PD-18): mobx `autorun` runs synchronously once at
// creation and synchronously on a tracked change (eager reactions). The churn/
// retention effect reads d0 and bumps a live counter, never the sink; teardown
// calls autorun's returned disposer (no fire after dispose).

import * as mobx from "mobx";
import { KEYS as CASCADE_KEYS } from "../scenarios/cascade.mjs";
import { createRequire } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

mobx.configure({ enforceActions: "never" });

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

// --- MobX class factories (built once per scenario; PD-17) -------------------

// Assemble a mobx class from a field list + derived list. Fields init 0 in the
// ctor (own props), then makeObservable(this, annotations) makes them reactive.
// Derived getters live on the prototype; `new Function` only assembles a LITERAL
// named-access body (`this.f0 + this.f1 + ...`) exactly as a hand-written class
// would emit -- never a computed-key `this[k]` read (that keyed-load artifact
// would unfairly tax the lane), mirroring lsd.mjs's cascade/deep builders.
function makeMobxClass(fields, derivs) {
    const anno = {};
    for (let i = 0; i < fields.length; i++) anno[fields[i]] = mobx.observable;
    for (let i = 0; i < derivs.length; i++) anno[derivs[i].name] = mobx.computed;
    const Cls = class MobxVM {
        constructor() {
            for (let i = 0; i < fields.length; i++) this[fields[i]] = 0;
            mobx.makeObservable(this, anno);
        }
    };
    for (let i = 0; i < derivs.length; i++) {
        Object.defineProperty(Cls.prototype, derivs[i].name, {
            get: derivs[i].body, configurable: true, enumerable: true,
        });
    }
    return Cls;
}

// Standard VM: P=4, D=2 (d0=f0+f1, d1=f2+f3).
function buildStdClass() {
    return makeMobxClass(
        ["f0", "f1", "f2", "f3"],
        [
            { name: "d0", body: function () { return this.f0 + this.f1; } },
            { name: "d1", body: function () { return this.f2 + this.f3; } },
        ]);
}

// Cascade VM: P=64, D=16 group deriveds (each over 4 fields) + 1 aggregate.
function buildCascadeClass() {
    const fields = new Array(64);
    for (let j = 0; j < 64; j++) fields[j] = "f" + j;
    const derivs = [];
    for (let k = 0; k < 16; k++) {
        const body = new Function(
            "return this.f" + (4 * k) + " + this.f" + (4 * k + 1) +
            " + this.f" + (4 * k + 2) + " + this.f" + (4 * k + 3) + ";");
        derivs.push({ name: "g" + k, body });
    }
    let aggExpr = "return this.g0";
    for (let k = 1; k < 16; k++) aggExpr += " + this.g" + k;
    derivs.push({ name: "agg", body: new Function(aggExpr + ";") });
    return makeMobxClass(fields, derivs);
}

// Deep VM: P=1 (x), D=64 chain (d0=x+1, dk=d(k-1)+1).
function buildDeepClass() {
    const derivs = [];
    for (let k = 0; k < 64; k++) {
        const prev = k === 0 ? "x" : "d" + (k - 1);
        derivs.push({ name: "d" + k, body: new Function("return this." + prev + " + 1;") });
    }
    return makeMobxClass(["x"], derivs);
}

// --- churn/retention share one builder (identical drive) ---------------------
function makeChurn(shape, ctx) {
    const SINK = ctx.sink;
    const liveness = { n: 0 };
    const VM = buildStdClass();
    return {
        drive(i) {
            const vm = new VM();
            const stop = mobx.autorun(() => { liveness.n++; void vm.d0; });
            switch (i & 3) {
                case 0: vm.f0 = i; break;
                case 1: vm.f1 = i; break;
                case 2: vm.f2 = i; break;
                case 3: vm.f3 = i; break;
            }
            const v = vm.d0;
            SINK[i & SINK_MASK] += v;
            stop();
        },
        expectedSum: ctx.expectedSum,
        dispose() {},
        liveness() { return liveness.n; },
    };
}

export const ADAPTER = {
    key: "mobx",
    version() { return resolveVersion("mobx"); },
    build: {
        "vm-write"(shape, ctx) {
            const SINK = ctx.sink;
            const VM = buildStdClass();
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
                dispose() {},
            };
        },

        "fleet-read"(shape, ctx) {
            const SINK = ctx.sink;
            const F = shape.VMs;
            const VM = buildStdClass();
            const vms = new Array(F);
            for (let v = 0; v < F; v++) { const o = new VM(); o.f0 = v; vms[v] = o; }
            return {
                drive(i) {
                    const vm = vms[i % F];
                    const v = vm.d0;
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() {},
            };
        },

        "fleet-tick"(shape, ctx) {
            const SINK = ctx.sink;
            const F = shape.VMs;
            const VM = buildStdClass();
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
                dispose() {},
            };
        },

        cascade(shape, ctx) {
            const SINK = ctx.sink;
            const VM = buildCascadeClass();
            const vm = new VM();
            return {
                drive(i) {
                    vm[CASCADE_KEYS[i & 63]] = i;
                    const v = vm.agg;
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() {},
            };
        },

        "deep-vm"(shape, ctx) {
            const SINK = ctx.sink;
            const VM = buildDeepClass();
            const vm = new VM();
            return {
                drive(i) {
                    vm.x = i;
                    const v = vm.d63;
                    SINK[i & SINK_MASK] += v;
                },
                expectedSum: ctx.expectedSum,
                dispose() {},
            };
        },

        churn(shape, ctx) { return makeChurn(shape, ctx); },
        "churn-reuse"() {
            return { unsupported: "MobX instances are never disposable -- observable atoms are reclaimed only by GC, so there is no release/reinit cycle to pool (only construct-and-drop, which is the CHURN lane)." };
        },
        retention(shape, ctx) { return makeChurn(shape, ctx); },
    },
};
