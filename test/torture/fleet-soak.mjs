// test/torture/fleet-soak.mjs -- node --expose-gc test/torture/fleet-soak.mjs [--seconds N]
//
// SUSTAINED FLEET soak (PLAN-S3, group: soak). The FLEET-TICK shape from the
// bench (P=4, D=2, E=1 per VM) scaled to a standing fleet of 2000 VMs on a
// DEDICATED registry, then driven under a wall-clock budget. It proves the
// package holds a large LIVE population flat while lifecycle churns beneath it:
//
//   - a standing fleet of 2000 VMs (half decorated via the mock emitter, half
//     defineReactive) lives on createRegistry({ maxNodes: 16384,
//     onCapacityExceeded: "throw" }) -- one dedicated registry so a single
//     baseline governs the whole soak and no default-registry residue leaks in;
//   - every tick writes one field of a ROTATING VM and reads its derived into a
//     local sink (FLEET-TICK); each write re-fires that VM's owned effect, so a
//     module-level effect counter advances as a liveness witness;
//   - every ~1s sample ALSO runs a partial churn rotation -- dispose then
//     reconstruct a 128-VM slice in place -- so lifecycle churns UNDER the tick
//     load without ever moving the standing population off its floor.
//
// Per ~1s sample, with the fleet quiescent between rotations, assert:
//   - F-0 on the dedicated registry: activeNodes == 2000 x (4+2+1+1) == 16000
//     EXACTLY, poolGrowths delta 0 after warmup, ledger balanced
//     (totalAllocations - totalDisposals == activeNodes);
//   - retained heap flat across samples (churn-soak's robust median method);
//   - the effect counter advanced since the previous sample (liveness).
//
// End: dispose the whole fleet, settle(), assert conservation back to the
// pre-fleet baseline (activeNodes 0) and gcGate maxMajor 0 over the whole soak.
//
// Budget: --seconds N (argv) or TORTURE_SECONDS env; default 10.
//
// TORTURE_BREAK=fleet-soak leaks ONE VM per churn rotation (its dispose is
// skipped while its slot is overwritten): activeNodes climbs off the 16000
// floor and the very next F-0 sample assertion catches it.
//
// ASCII-only.

import { GcProfiler } from "@zakkster/lite-gc-profiler";
import { createRegistry } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import { RUN, check, breakActive, settle, pass } from "./helpers/harness.mjs";

const NAME = "fleet-soak";

// --- fleet + shape geometry ---------------------------------------------------

const FLEET = 2000;                 // standing population
const HALF = FLEET / 2;             // [0, HALF) decorated; [HALF, FLEET) define
const P = 4, D = 2, E = 1;          // FLEET-TICK shape
const NODES_PER_VM = P + D + E + 1; // P signals + D deriveds + E effects + anchor
const EXPECTED_NODES = FLEET * NODES_PER_VM; // 2000 x 8 == 16000
const MAX_NODES = 16384;            // headroom 384 over the standing population
const ROTATE_SLICE = 128;           // VMs churned per ~1s sample

const SAMPLE_INTERVAL_MS = 1000;    // ~1s sample cadence
const TICK_CHECK_MASK = 4095;       // consult the clock every 4096 ticks, not per tick

// Module-level effect counter -- the effect body bumps it WITHOUT closing over
// any instance (only `this.s0` is read, `this` is not captured).
let effectFires = 0;

// --- budget (argv --seconds, else TORTURE_SECONDS env, else default) ----------

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

// --- the dedicated registry ---------------------------------------------------

const reg = createRegistry({ maxNodes: MAX_NODES, onCapacityExceeded: "throw" });

// --- shape builders (built ONCE, before the measured window) ------------------

function decoratedMembers() {
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
            body: (function (k) { return function () { return this["s" + k] + 1; }; })(i),
        });
    }
    members.push({
        kind: "method",
        key: "e0",
        decorator: pkg.reactiveEffect,
        body: function () { effectFires++; void this.s0; },
    });
    return members;
}

const DecShape = buildClass({
    name: "FleetDec",
    classDecorator: pkg.reactiveHost({ registry: reg }),
    members: decoratedMembers(),
});

function makeDefShape() {
    const signals = {};
    for (let i = 0; i < P; i++) signals["s" + i] = 0;
    const deriveds = {};
    for (let i = 0; i < D; i++) {
        deriveds["d" + i] = (function (k) { return function () { return this["s" + k] + 1; }; })(i);
    }
    const effects = { e0: function () { effectFires++; void this.s0; } };
    const Base = class {};
    Object.defineProperty(Base, "name", { value: "FleetDef", configurable: true });
    return pkg.defineReactive(Base, { signals, deriveds, effects, host: { registry: reg } });
}

const DefShape = makeDefShape();

// A VM at fleet index j: decorated in the first half, defineReactive in the
// second. Half-and-half so both construction paths churn under the same load.
function makeVm(j) {
    return j < HALF ? new DecShape() : new DefShape();
}

// --- build the standing fleet (OUT of the measured baseline) ------------------

const preFleet = reg.stats();       // pre-fleet baseline (activeNodes 0)

const fleet = new Array(FLEET);
for (let j = 0; j < FLEET; j++) fleet[j] = makeVm(j);

// Sanity: the standing population is exactly the expected node count.
{
    const s = reg.stats();
    check(
        s.activeNodes === EXPECTED_NODES,
        () => "fleet build: activeNodes " + s.activeNodes + " != expected " + EXPECTED_NODES,
    );
}

// Baseline AFTER the fleet exists: pool growth from here on must be zero (the
// pool already spans the standing population; rotations only recycle nodes).
const basePoolGrowths = reg.stats().poolGrowths;

// Control retention: leaked VMs parked here (never disposed) so they stay off
// the floor and cannot be reclaimed.
const leaked = [];

// --- soak ---------------------------------------------------------------------

const heapSamples = [];
const gc = new GcProfiler().start();

const t0 = performance.now();
const deadline = t0 + SECONDS * 1000;
let nextSampleAt = t0 + SAMPLE_INTERVAL_MS;

let sink = 0;
let tick = 0;
let vmIdx = 0;
let rotStart = 0;
let lastEffectFires = effectFires;
let samples = 0;

for (;;) {
    // FLEET-TICK: write one field of the rotating VM, read its derived to sink.
    const vm = fleet[vmIdx];
    vm.s0 = tick & 1023;
    sink = (sink + vm.d0) | 0;
    vmIdx++;
    if (vmIdx === FLEET) vmIdx = 0;
    tick++;

    if ((tick & TICK_CHECK_MASK) === 0) {
        const now = performance.now();
        if (now >= nextSampleAt) {
            RUN.op = tick;

            // Partial churn rotation: dispose then reconstruct a 128-VM slice in
            // place. Each VM is torn down and immediately rebuilt, so the peak
            // population never exceeds the standing count -- no capacity spill.
            const doLeak = breakActive(NAME);
            for (let k = 0; k < ROTATE_SLICE; k++) {
                const j = (rotStart + k) % FLEET;
                const old = fleet[j];
                if (doLeak && k === 0) leaked.push(old);   // BREAK: skip its dispose
                else pkg.disposeReactive(old);
                fleet[j] = makeVm(j);
            }
            rotStart = (rotStart + ROTATE_SLICE) % FLEET;

            // F-0 between rotations: the standing population is back at the floor.
            const s = reg.stats();
            check(
                s.activeNodes === EXPECTED_NODES,
                () => "fleet floor: activeNodes " + s.activeNodes + " != expected " +
                    EXPECTED_NODES + " at tick " + tick,
            );
            check(
                s.poolGrowths - basePoolGrowths === 0,
                () => "fleet floor: poolGrowths grew by " + (s.poolGrowths - basePoolGrowths) +
                    " at tick " + tick,
            );
            check(
                s.totalAllocations - s.totalDisposals === s.activeNodes,
                () => "fleet floor: ledger " + (s.totalAllocations - s.totalDisposals) +
                    " != activeNodes " + s.activeNodes + " at tick " + tick,
            );

            // Liveness: the tick load re-fires owned effects, so the counter must
            // have advanced since the previous sample.
            check(
                effectFires > lastEffectFires,
                () => "fleet liveness: effect counter stalled at " + effectFires +
                    " (prev " + lastEffectFires + ") at tick " + tick,
            );
            lastEffectFires = effectFires;

            const heap = process.memoryUsage().heapUsed;
            gc.sampleHeap(now, heap);
            heapSamples.push(heap);
            samples++;
            nextSampleAt += SAMPLE_INTERVAL_MS;
        }
        if (now >= deadline) break;
    }
}
if (sink === -1) console.log("unreachable");
RUN.op = -1;

// --- teardown + gates ---------------------------------------------------------

for (let j = 0; j < FLEET; j++) {
    pkg.disposeReactive(fleet[j]);
    fleet[j] = null;
}

await settle();
const summary = gc.summary();
gc.stop();

// Conservation: the whole fleet is gone -- the dedicated registry is back at its
// pre-fleet baseline (activeNodes 0). Non-break only: a BREAK run exits at the
// first F-0 sample long before reaching here.
{
    const s = reg.stats();
    check(
        s.activeNodes === preFleet.activeNodes,
        () => "fleet teardown: activeNodes " + s.activeNodes + " != pre-fleet baseline " +
            preFleet.activeNodes,
    );
    check(
        s.totalAllocations - s.totalDisposals === s.activeNodes,
        () => "fleet teardown: ledger " + (s.totalAllocations - s.totalDisposals) +
            " != activeNodes " + s.activeNodes,
    );
}

// gc budget: zero major collections over the whole soak (a promotion leak in the
// standing fleet surfaces here even if the node ledger balances).
check(
    summary.gc.major === 0,
    () => "fleet soak provoked " + summary.gc.major + " major GC(s) (minor=" +
        summary.gc.minor + ", maxMs=" + summary.gc.maxMs.toFixed(2) + ")",
);

// heap flat: median of the late window vs the early window (robust to the
// minor-GC sawtooth); a genuine retention lift raises the whole distribution.
check(
    heapSamples.length >= 2,
    () => "fleet soak too short: only " + heapSamples.length + " heap sample(s) -- raise --seconds",
);
const half = Math.floor(heapSamples.length / 2);
const early = median(heapSamples.slice(0, half === 0 ? 1 : half));
const late = median(heapSamples.slice(half));
const growth = late - early;
const tol = Math.max(Math.floor(early * 0.25), 8 * 1024 * 1024);
check(
    growth <= tol,
    () => "fleet heap not flat: early median " + early + " -> late median " + late +
        " (growth " + growth + " > tol " + tol + ")",
);

process.stdout.write(
    "torture: fleet-soak seconds=" + SECONDS + " fleet=" + FLEET +
    " nodes=" + EXPECTED_NODES + " ticks=" + tick + " samples=" + samples +
    " rotSlice=" + ROTATE_SLICE + " effectFires=" + effectFires +
    " | floor=16000 gc major=" + summary.gc.major + " minor=" + summary.gc.minor +
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
