// cookbook/r10-registry-isolation.mjs -- node --expose-gc cookbook/r10-registry-isolation.mjs
//
// Recipe 10 (Pro, GATED): registry isolation, and what refuses to cross.
// Stamp 2026-08-30. Per-scope worlds via createRegistry; the same-registry-or-
// omit chain rule and its NAMED throw; the cross-registry dispose trap the
// package closes; and the generalized PD-29 rule. Snippets live in
// `#region cookbook:r10.k` spans; harness (gate + asserts + summary) is OUTSIDE.
//
// THE GATE: the DEFAULT-registry stats() stay FROZEN (exact equality) across
// heavy bound-registry churn, and the measured steady-state write loop meets the
// S1 budget (gc.major === 0, maxPauseMs <= 4.0, bytes/op <= 0.589, minors <= an
// in-process zero-alloc control + 128).
// COOKBOOK_BREAK=r10 allocates one object per op in the measured loop -> FAIL.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

import { GcProfiler, checkNoGc, measureOps } from "@zakkster/lite-gc-profiler";

function fail(msg) {
    process.stderr.write("cookbook r10 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }
function settle() {
    return new Promise((r) => { setTimeout(() => { Promise.resolve().then(r); }, 0); });
}

// #region cookbook:r10.1
import { createRegistry, stats } from "@zakkster/lite-signal";
import {
    defineReactive, disposeReactive, capacityFor, ReactiveDisposedError,
} from "@zakkster/lite-signal-decorators";

// One shape, many per-scope WORLDS. Each panel gets its own createRegistry,
// sized from the shape's measured cost. Nothing a panel does can touch another
// world -- or the default registry.
const PANEL_SPEC = {
    signals: { v: 0, rev: 0 },
    deriveds: { status: (vm) => (vm.v > 0 ? "on" : "off") },
    effects: { onRev: (vm) => { void vm.rev; } },
};
const panelProbe = defineReactive(class PanelShape {}, PANEL_SPEC);

const worldA = createRegistry(capacityFor([[panelProbe, 3]]));   // holds a few live panels at once
const worldB = createRegistry(capacityFor([[panelProbe, 1]]));
const PanelA = defineReactive(class PanelA {}, { host: { registry: worldA }, ...PANEL_SPEC });
const PanelB = defineReactive(class PanelB {}, { host: { registry: worldB }, ...PANEL_SPEC });

const a = new PanelA();
const b = new PanelB();
a.v = 10;                                          // touches worldA only
// #endregion cookbook:r10.1

assert(a.status === "on" && b.status === "off", "worlds are not isolated");
assert(worldA.stats().activeNodes > 0 && worldB.stats().activeNodes > 0, "each world holds its own nodes");

// #region cookbook:r10.2
// The chain rule: a subclass may repeat the SAME registry or OMIT it (inheriting
// the ancestor's). Passing a DIFFERENT registry down a hosted chain is a NAMED
// throw -- the outcome you WANT, caught at definition time, not a silent split.
class BaseHost {}
const Hosted = defineReactive(BaseHost, { host: { registry: worldA }, ...PANEL_SPEC });
let chainError = null;
try {
    defineReactive(class Divergent extends Hosted {}, {
        signals: { w: 0 }, deriveds: {}, effects: {}, host: { registry: worldB },
    });
} catch (e) {
    chainError = e;                                // "class Divergent passes a different registry ..."
}
// #endregion cookbook:r10.2

assert(chainError !== null && chainError.name === "TypeError", "chain rule did not throw");
assert(/different registry/.test(chainError.message), "chain throw not named: " + chainError.message);

// #region cookbook:r10.3
// The cross-registry dispose trap the package CLOSES. lite-signal's default
// dispose is a silent no-op across registries, so a custom-registry instance
// torn down through the default would LEAK its nodes. disposeReactive routes
// every engine call through the instance's BOUND registry, so it never does:
// the world's activeNodes actually drop, and any later touch is poisoned.
const scoped = new PanelA();
scoped.v = 3;
const beforeDispose = worldA.stats().activeNodes;
disposeReactive(scoped);
const afterDispose = worldA.stats().activeNodes;
let poisoned = null;
try { scoped.v = 9; } catch (e) { if (e instanceof ReactiveDisposedError) poisoned = e.className + "." + e.key; }
// #endregion cookbook:r10.3

assert(afterDispose < beforeDispose, "bound-registry nodes were not freed (the trap was not closed)");
assert(poisoned === "PanelA.v", "post-dispose touch not poisoned: " + poisoned);

// #region cookbook:r10.4
// The generalized PD-29 rule. lite-store, lite-watch-ex and lite-await all
// capture lite-signal's top-level helpers at IMPORT time, so their signals and
// watchers land in the DEFAULT registry -- always. You cannot tell from a
// README; grep the source for `registry`. If it has zero matches, that library
// is DEFAULT-REGISTRY-ONLY, and it can never track a member you isolated on a
// custom registry. Isolate the CLASS side; let the default-registry tools read
// the default-registry side.
const DEFAULT_REGISTRY_ONLY = true;                // any lib with zero `registry` matches in its source
// #endregion cookbook:r10.4

assert(DEFAULT_REGISTRY_ONLY === true, "PD-29 marker flipped");

// --- the gate: default-registry stats FROZEN across bound-registry churn ------

function snapDefault() { return JSON.stringify(stats()); }

// Warm the bound pools out of the picture, then freeze the default baseline.
const churnWorld = createRegistry(capacityFor([[panelProbe, 1]]));
const PanelChurn = defineReactive(class PanelChurn {}, { host: { registry: churnWorld }, ...PANEL_SPEC });
{
    const warm = new PanelChurn();
    warm.v = 1; warm.rev = 1; void warm.status;
    disposeReactive(warm);
}
const CHURN = 20000;
const defaultBaseline = snapDefault();

for (let c = 0; c < CHURN; c++) {
    const p = new PanelChurn();
    p.v = c & 1023;
    p.rev = c;
    void p.status;
    disposeReactive(p);
}
const defaultAfterChurn = snapDefault();
assert(defaultBaseline === defaultAfterChurn,
    "default registry moved under bound-registry churn:\n  before " + defaultBaseline + "\n  after  " + defaultAfterChurn);

// --- the S1 gate on a zero-alloc bound-registry write loop --------------------

const OPS = 200000;
const WARMUP = 20000;
const BREAK = process.env.COOKBOOK_BREAK === "r10";
let breakSink = 0;

const panel = new PanelA();
// The sabotage hook lives in the HARNESS, never in a published region.
function measured(i) {
    panel.rev = i;                                 // bound-registry write; worldA only
    if (BREAK) { const junk = new Array(1024); junk[0] = i; breakSink += junk[0]; }
    return panel.rev | 0;
}

async function gcWindow(fn, rules) {
    let sink = 0;
    for (let i = 0; i < WARMUP; i++) sink += fn(i) | 0;
    const gc = new GcProfiler().start();
    for (let i = 0; i < OPS; i++) {
        sink += fn(i) | 0;
        if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
    }
    if (sink === -0x7fffffff) process.stdout.write("");   // anti-DCE
    await settle();
    const s = gc.summary();
    gc.stop();
    return { s, report: checkNoGc(s, rules) };
}

const control = await gcWindow((i) => (i & 7), { maxMajor: 0, maxPauseMs: 4 });
const MINOR_LIMIT = control.s.gc.minor + 128;

const bytesPerOp = measureOps(measured, { ops: OPS, warmup: WARMUP, stabilize: true }).bytesPerOp;
const gated = await gcWindow(measured, { maxMajor: 0, maxMinor: MINOR_LIMIT, maxPauseMs: 4 });

// The measured loop touched only worldA -- the default registry is STILL frozen.
assert(snapDefault() === defaultBaseline, "default registry moved under the measured write loop");
assert(gated.report.verdict === "pass",
    "S1 gate violated: " + JSON.stringify(gated.report.violations) +
    " (minor=" + gated.s.gc.minor + " limit=" + MINOR_LIMIT + ")");
assert(gated.s.gc.major === 0, "gate: gc.major " + gated.s.gc.major + " != 0");
assert(gated.s.gc.maxMs <= 4.0, "gate: maxPauseMs " + gated.s.gc.maxMs.toFixed(2) + " > 4.0");
assert(bytesPerOp <= 0.589, "gate: bytes/op " + bytesPerOp + " > 0.589");

disposeReactive(a);
disposeReactive(b);
disposeReactive(panel);

process.stdout.write(
    "cookbook r10 registry-isolation | chain-throw=" + chainError.name +
    " poison=" + poisoned + " default-frozen churn=" + CHURN +
    " | gc major=" + gated.s.gc.major + " minor=" + gated.s.gc.minor +
    "/" + MINOR_LIMIT + " maxMs=" + gated.s.gc.maxMs.toFixed(2) +
    " bytes/op=" + bytesPerOp.toFixed(3) + " | ok\n",
);
