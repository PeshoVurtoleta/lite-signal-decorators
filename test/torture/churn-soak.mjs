// test/torture/churn-soak.mjs -- node --expose-gc test/torture/churn-soak.mjs [--seconds N]
//
// SUSTAINED soak (PLAN-S2b T7, group: soak). A wall-clock budget of sustained
// construct/use/dispose over the mixed shape family (decorated + defineReactive
// on the default registry, P<=8 / D<=4 / E<=2) proves the package holds its
// resources FLAT under prolonged churn:
//
//   - pool floor: at every checkpoint the default registry is back at the
//     post-warmup baseline (F-0: activeNodes == baseline, poolGrowths delta 0,
//     ledger balanced) -- nothing lives between cycles;
//   - heap flat: retained heap does not grow monotonically across ~1s samples,
//     compared as a ROBUST statistic (median of the late window vs the early
//     window) rather than a single reading;
//   - gc budget: ZERO major collections over the whole soak (maxMajor 0). A
//     promotion leak surfaces here even if the pool ledger somehow balances.
//
// Every shape and closure is built OUTSIDE the measured window; the churn loop
// allocates nothing beyond the `new Shape()` under test. Checkpoint bookkeeping
// (stats(), a heap sample) runs once every CHECK cycles, never per cycle.
//
// Budget: --seconds N (argv) or TORTURE_SECONDS env; default 10.
//
// TORTURE_BREAK=churn-soak leaks one instance every 1024 cycles (retained, not
// disposed): activeNodes climbs off the floor and the F-0 checkpoint catches it.
//
// ASCII-only.

import { GcProfiler } from "@zakkster/lite-gc-profiler";
import { createRegistry, stats } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, randInt, conservationBaseline, settle, pass,
} from "./helpers/harness.mjs";

const NAME = "churn-soak";
const LEAK_EVERY = 1024;                          // BREAK cadence
const CHECK_MASK = 8191;                          // F-0 checkpoint every 8192 cycles
const HEAP_INTERVAL_MS = 1000;                    // ~1s heap sampling cadence

// --- budget (argv --seconds, else TORTURE_SECONDS env, else default) ---------

function readSeconds() {
    const argv = process.argv.slice(2);
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--seconds" || argv[i] === "-s") {
            const n = Number(argv[i + 1]);
            if (Number.isFinite(n) && n > 0) return n;
        }
    }
    const env = process.env.TORTURE_SECONDS;
    if (env !== undefined) {
        const n = Number(env);
        if (Number.isFinite(n) && n > 0) return n;
    }
    return 10;
}

const SECONDS = readSeconds();

// --- shape builders (built ONCE, before the measured window) -----------------

function reactiveMembers(P, D, E) {
    const members = [];
    for (let i = 0; i < P; i++) {
        members.push({
            kind: "accessor",
            key: "s" + i,
            decorator: pkg.reactive,
            value: (function (v) { return function () { return v; }; })(i),
        });
    }
    for (let i = 0; i < D; i++) {
        members.push({
            kind: "getter",
            key: "d" + i,
            decorator: pkg.derived,
            body: function () { return this.s0 + 1; },
        });
    }
    for (let i = 0; i < E; i++) {
        members.push({
            kind: "method",
            key: "e" + i,
            decorator: pkg.reactiveEffect,
            body: function () { void this.s0; },
        });
    }
    return members;
}

function decoratedShape(id, P, D, E) {
    const C = buildClass({
        name: "Dec" + id,
        classDecorator: pkg.reactiveHost,
        members: reactiveMembers(P, D, E),
    });
    C.__hasD = D > 0;
    return C;
}

function defineShape(id, P, D, E) {
    const signals = {};
    for (let i = 0; i < P; i++) signals["s" + i] = 0;
    const deriveds = {};
    for (let i = 0; i < D; i++) deriveds["d" + i] = function () { return this.s0 + 1; };
    const effects = {};
    for (let i = 0; i < E; i++) effects["e" + i] = function () { void this.s0; };
    const Base = class {};
    Object.defineProperty(Base, "name", { value: "Def" + id, configurable: true });
    const C = pkg.defineReactive(Base, { signals, deriveds, effects });
    C.__hasD = D > 0;
    return C;
}

// Mixed family, all on the DEFAULT registry so one baseline governs the whole
// soak. Every shape P<=8 / D<=4 / E<=2, at least one signal.
const FAMILY = [
    decoratedShape(0, 2, 1, 0),
    decoratedShape(1, 5, 3, 1),
    decoratedShape(2, 8, 4, 2),
    defineShape(0, 1, 0, 0),
    defineShape(1, 4, 2, 1),
    defineShape(2, 7, 4, 2),
    defineShape(3, 3, 1, 1),
];

// Control retention: leaked instances parked here (never disposed).
const leakedVms = [];

// A throwaway bound registry keeps createRegistry imported/exercised without
// touching the default baseline; unused otherwise.
void createRegistry;

// --- warmup (populate first-touch pool slots OUT of the measured baseline) ---

for (let i = 0; i < 256; i++) {
    const inst = new FAMILY[i % FAMILY.length]();
    pkg.disposeReactive(inst);
}

const base = conservationBaseline();

// --- soak ---------------------------------------------------------------------

const heapSamples = [];
const gc = new GcProfiler().start();

const t0 = performance.now();
const deadline = t0 + SECONDS * 1000;
let nextHeapAt = t0 + HEAP_INTERVAL_MS;

let sink = 0;
let i = 0;
for (;;) {
    const leak = breakActive(NAME) && (i % LEAK_EVERY === 0);
    const Shape = FAMILY[randInt(FAMILY.length)];

    const vm = new Shape();
    vm.s0 = i & 1023;
    sink = (sink + (Shape.__hasD ? vm.d0 : vm.s0)) | 0;

    if (leak) leakedVms.push(vm);                 // retained -> off the floor
    else pkg.disposeReactive(vm);                 // immediate teardown -> at floor

    i++;

    if ((i & CHECK_MASK) === 0) {
        RUN.op = i;
        // Pool floor (F-0): nothing lives between cycles.
        const s = stats();
        check(
            s.activeNodes === base.activeNodes,
            () => "soak floor: activeNodes " + s.activeNodes + " != baseline " +
                base.activeNodes + " at cycle " + i,
        );
        check(
            s.poolGrowths - base.poolGrowths === 0,
            () => "soak floor: poolGrowths grew by " + (s.poolGrowths - base.poolGrowths) +
                " at cycle " + i,
        );
        check(
            s.totalAllocations - s.totalDisposals === s.activeNodes,
            () => "soak floor: ledger " + (s.totalAllocations - s.totalDisposals) +
                " != activeNodes " + s.activeNodes + " at cycle " + i,
        );

        const now = performance.now();
        if (now >= nextHeapAt) {
            const heap = process.memoryUsage().heapUsed;
            gc.sampleHeap(now, heap);
            heapSamples.push(heap);
            nextHeapAt += HEAP_INTERVAL_MS;
        }
        if (now >= deadline) break;
    }
}
if (sink === -1) console.log("unreachable");
RUN.op = -1;

// --- settle + gates -----------------------------------------------------------

await settle();
const summary = gc.summary();
gc.stop();

// gc budget: zero majors over the entire soak (maxMajor 0). Asserting on the
// observed count directly avoids the tri-state verdict; a soak this size always
// provokes minor collections, so the window is never empty.
check(
    summary.gc.major === 0,
    () => "soak provoked " + summary.gc.major + " major GC(s) (minor=" + summary.gc.minor +
        ", maxMs=" + summary.gc.maxMs.toFixed(2) + ")",
);

// heap flat: compare the median of the late window against the early window. A
// median resists the sawtooth of minor-GC noise; a genuine retention leak lifts
// the whole distribution.
check(
    heapSamples.length >= 2,
    () => "soak too short: only " + heapSamples.length + " heap sample(s) -- raise --seconds",
);
const half = Math.floor(heapSamples.length / 2);
const early = median(heapSamples.slice(0, half === 0 ? 1 : half));
const late = median(heapSamples.slice(half));
const growth = late - early;
// Generous tolerance: the precise leak gate is the F-0 floor above; this is the
// belt-and-suspenders check against slow old-gen creep. 25% of the early median
// or 8 MiB, whichever is larger.
const tol = Math.max(Math.floor(early * 0.25), 8 * 1024 * 1024);
check(
    growth <= tol,
    () => "soak heap not flat: early median " + early + " -> late median " + late +
        " (growth " + growth + " > tol " + tol + ")",
);

process.stdout.write(
    "torture: churn-soak seconds=" + SECONDS + " cycles=" + i +
    " samples=" + heapSamples.length +
    " | floor=baseline gc major=" + summary.gc.major + " minor=" + summary.gc.minor +
    " maxMs=" + summary.gc.maxMs.toFixed(2) +
    " | heap early=" + early + " late=" + late + " tol=" + tol + "\n",
);

pass(NAME);

// --- helpers ------------------------------------------------------------------

function median(arr) {
    const b = arr.slice().sort((x, y) => x - y);
    const n = b.length;
    if (n === 0) return 0;
    return n % 2 === 1 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
}
