// bench/adapters/signal-utils.mjs -- reference lane: signal-utils + signal-
// polyfill (the TC39 Signals proposal). Both resolve as plain ESM in stock Node
// (PD-16 admission (a)); class reactivity is the documented primitive class API
// (admission (b)): fields hold `new Signal.State(v)`, deriveds `new
// Signal.Computed(fn)`, reads `.get()`, writes `.set()`. signal-utils is thin
// sugar over this exact primitive, so we bind to the primitive (zero sugar tax)
// and stamp BOTH resolved versions. No registry/pool -> no stats() column.
//
// MEMBER-SYNTAX PARITY: the polyfill's native access is method-shaped
// (`vm.f0.get()`). To keep every drive closure line-for-line identical to the
// other engines (`vm.f0 = i`, `s += vm.d0`), each field is wrapped as a PUBLIC
// class getter/setter over its State and each derived as a PUBLIC getter over
// its Computed; derived bodies read `this.fN` (public), routing through the same
// accessor shape as lsd/mobx. The drive closures do the SAME work as lsd.mjs
// (same indices, op mix, reads).
//
// EFFECT FLUSH SEMANTICS (PD-18): the documented Signal.subtle.Watcher pattern.
// The polyfill FORBIDS reading signals inside the watcher notify callback, so
// notify only flips a `dirty` flag; the drive then drains `watcher.getPending()`
// SYNCHRONOUSLY (after the write) and reads each pending computed -- an eager,
// synchronous re-run relative to drive(i). The churn/retention effect Computed
// reads d0 and bumps a live counter, never the sink; it fires once at prime and
// re-runs on the drained write. Teardown calls `watcher.unwatch(eff)` (no fire
// after dispose).

import { Signal } from "signal-polyfill";
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

// --- signal-polyfill class factories (built once per scenario; PD-17) --------

// Assemble a class from a field list + derived list. Each instance holds its own
// Signal.State per field and Signal.Computed per derived; public getters/setters
// give `vm.fN`/`vm.dK` member syntax. Derived getter BODIES are literal named-
// access (`this.f0 + this.f1 + ...`); `new Function` only assembles that literal
// body (never a computed-key `this[k]` read), mirroring lsd.mjs.
function makeSuClass(fields, derivs) {
    const Cls = class SignalUtilsVM {
        constructor() {
            const s = this._s = {};
            for (let i = 0; i < fields.length; i++) s[fields[i]] = new Signal.State(0);
            const c = this._c = {};
            const self = this;
            for (let i = 0; i < derivs.length; i++) {
                const body = derivs[i].body;
                c[derivs[i].name] = new Signal.Computed(() => body.call(self));
            }
        }
    };
    for (let i = 0; i < fields.length; i++) {
        const f = fields[i];
        Object.defineProperty(Cls.prototype, f, {
            get() { return this._s[f].get(); },
            set(v) { this._s[f].set(v); },
            configurable: true, enumerable: true,
        });
    }
    for (let i = 0; i < derivs.length; i++) {
        const name = derivs[i].name;
        Object.defineProperty(Cls.prototype, name, {
            get() { return this._c[name].get(); },
            configurable: true, enumerable: true,
        });
    }
    return Cls;
}

// Standard VM: P=4, D=2 (d0=f0+f1, d1=f2+f3).
function buildStdClass() {
    return makeSuClass(
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
    return makeSuClass(fields, derivs);
}

// Deep VM: P=1 (x), D=64 chain (d0=x+1, dk=d(k-1)+1).
function buildDeepClass() {
    const derivs = [];
    for (let k = 0; k < 64; k++) {
        const prev = k === 0 ? "x" : "d" + (k - 1);
        derivs.push({ name: "d" + k, body: new Function("return this." + prev + " + 1;") });
    }
    return makeSuClass(["x"], derivs);
}

// --- churn/retention share one builder (identical drive) ---------------------
function makeChurn(shape, ctx) {
    const SINK = ctx.sink;
    const liveness = { n: 0 };
    const VM = buildStdClass();
    return {
        drive(i) {
            const vm = new VM();
            let dirty = false;
            const w = new Signal.subtle.Watcher(() => { dirty = true; });
            const e = new Signal.Computed(() => { liveness.n++; return vm.d0; });
            w.watch(e);
            e.get(); // prime -> one construction fire
            switch (i & 3) {
                case 0: vm.f0 = i; break;
                case 1: vm.f1 = i; break;
                case 2: vm.f2 = i; break;
                case 3: vm.f3 = i; break;
            }
            if (dirty) {
                dirty = false;
                const pending = w.getPending();
                for (let k = 0; k < pending.length; k++) pending[k].get();
            }
            const v = vm.d0;
            SINK[i & SINK_MASK] += v;
            w.unwatch(e);
        },
        expectedSum: ctx.expectedSum,
        dispose() {},
        liveness() { return liveness.n; },
    };
}

export const ADAPTER = {
    key: "signal-utils",
    version() { return resolveVersion("signal-utils") + " (+signal-polyfill " + resolveVersion("signal-polyfill") + ")"; },
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
        retention(shape, ctx) { return makeChurn(shape, ctx); },
    },
};
