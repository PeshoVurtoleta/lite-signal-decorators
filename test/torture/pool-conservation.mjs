// test/torture/pool-conservation.mjs -- node --expose-gc test/torture/pool-conservation.mjs
//
// FINDING F-0 under churn, the S1-A3/S2a capacity-primed mid-wiring cases, and
// the S2a-A4 registry-isolation case. The first three run on the DEFAULT
// lite-signal registry (decision 0002 D-2e: keep the live set bounded so the
// 1024-node ceiling is never the thing under test); the last runs on a bound
// createRegistry.
//
//   Phase 1 -- 4096 mixed construct/use/dispose cycles over PRNG-varied shapes
//     (P<=8 signals, D<=4 deriveds, E<=3 effects; delta math P+D+E+1, @batched
//     wiring no node) through a 64-slot ring. After full teardown + settle,
//     assertConserved.
//
//   Phase 2a -- prime the registry so a P=1,D=4 construction fits its signal +
//     anchor + first derived but the SECOND derived overflows: CapacityError by
//     name, F-0 intact (PD-7 teardown), fillers freed, revival succeeds.
//
//   Phase 2b -- prime the registry so a P=1,D=2,E=1 construction fits every
//     signal + anchor + all deriveds (headroom P+1+D) but the FIRST EFFECT
//     overflows: CapacityError by name, F-0 intact, fillers freed, revival
//     succeeds.
//
//   Phase 3 -- a shape family bound to createRegistry({ maxNodes: 256 }) churns
//     512 cycles; the DEFAULT registry's stats stay frozen (delta 0, both
//     directions of S2a-A4), and F-0 holds on the bound registry via its own
//     stats().
//
// TORTURE_BREAK=pool-conservation leaks one instance every 256 cycles (skips its
// dispose); the phase-1 conservation assertion is what must catch it.
//
// ASCII-only.

import { signalBox, dispose as sigDispose, stats, createRegistry } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, randInt, conservationBaseline, assertConserved, settle, pass,
} from "./helpers/harness.mjs";

const NAME = "pool-conservation";
const CYCLES = 4096;
const RING = 64;                               // pow2 so RING_MASK covers all slots
const RING_MASK = RING - 1;

// --- shape family (built once; reused across cycles) --------------------------

function makeShape(id, P, D, E, reg) {
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
    const C = buildClass({
        name: "Shape" + id,
        classDecorator: reg ? pkg.reactiveHost({ registry: reg }) : pkg.reactiveHost,
        members,
    });
    C.__P = P;
    C.__D = D;
    C.__E = E;
    return C;
}

const SHAPES = [
    makeShape(0, 1, 0, 0),
    makeShape(1, 3, 2, 1),
    makeShape(2, 5, 4, 3),
    makeShape(3, 8, 4, 2),
    makeShape(4, 2, 1, 1),
    makeShape(5, 6, 3, 2),
];

// Pin the delta math P+D+E+1 for every shape (single anchor, effects counted).
for (let i = 0; i < SHAPES.length; i++) {
    const S = SHAPES[i];
    const b = stats().activeNodes;
    const inst = new S();
    const delta = stats().activeNodes - b;
    check(
        delta === S.__P + S.__D + S.__E + 1,
        () => "shape " + i + ": node delta " + delta + " != P+D+E+1 " + (S.__P + S.__D + S.__E + 1),
    );
    pkg.disposeReactive(inst);
}

// --- phase 1: churn -----------------------------------------------------------

// Warm up so first-touch pool population is not charged to the measured window.
for (let i = 0; i < 128; i++) {
    const inst = new SHAPES[i % SHAPES.length]();
    pkg.disposeReactive(inst);
}

const base = conservationBaseline();
const ring = new Array(RING).fill(null);

for (let i = 0; i < CYCLES; i++) {
    RUN.op = i;
    const slot = i & RING_MASK;
    const prev = ring[slot];
    if (prev !== null) {
        // BREAK: every 256th cycle, skip the previous occupant's dispose and let
        // the overwrite below drop the last reference -> a permanent leak that
        // the end-of-phase conservation assertion must catch.
        const leak = breakActive(NAME) && (i % 256 === 0);
        if (!leak) pkg.disposeReactive(prev);
    }
    const Shape = SHAPES[randInt(SHAPES.length)];
    const inst = new Shape();
    // use: a read + a write through the hot accessors.
    if (inst.s0 !== 0) check(false, () => "cycle " + i + ": s0 initial=" + inst.s0);
    inst.s0 = i;
    if (inst.s0 !== i) check(false, () => "cycle " + i + ": s0 after set=" + inst.s0);
    ring[slot] = inst;
}

// Teardown every surviving occupant.
for (let s = 0; s < RING; s++) {
    if (ring[s] !== null) {
        pkg.disposeReactive(ring[s]);
        ring[s] = null;
    }
}

await settle();
RUN.op = -1;
assertConserved(base, "phase1 churn");

// --- phase 2a: derived-overflow mid-wiring ------------------------------------

// A P=1, D=4 shape: 1 signal + 1 anchor + 4 deriveds. With headroom of exactly 3
// (signal + anchor + one derived), the SECOND derived overflows.
const CapDerived = makeShape(99, 1, 4, 0);
const HEADROOM_D = 3;

const fillersD = [];
while (stats().nodePoolCapacity - stats().activeNodes > HEADROOM_D) {
    fillersD.push(signalBox(0));
}

const capBaseD = conservationBaseline();
let errD = null;
try {
    const doomed = new CapDerived();
    pkg.disposeReactive(doomed);               // unreachable on a correct core
} catch (e) {
    errD = e;
}
check(errD !== null, () => "capacity(derived): construction did not throw at the ceiling");
check(
    errD !== null && errD.name === "CapacityError",
    () => "capacity(derived): error name=" + (errD && errD.name) + " expected CapacityError",
);
assertConserved(capBaseD, "capacity(derived) partial-wiring teardown");

for (let i = 0; i < fillersD.length; i++) sigDispose(fillersD[i]);

const revivedD = new CapDerived();
check(revivedD.s0 === 0, () => "capacity(derived): revived s0=" + revivedD.s0);
check(revivedD.d0 === 1, () => "capacity(derived): revived d0=" + revivedD.d0);
pkg.disposeReactive(revivedD);

// --- phase 2b: FIRST-effect-overflow mid-wiring (S2a) -------------------------

// A P=1, D=2, E=1 shape. Headroom of exactly P + 1 + D = 4 fits every signal,
// the anchor, and all deriveds; the FIRST effect creation overflows.
const CapEffect = makeShape(98, 1, 2, 1);
const HEADROOM_E = 4;

const fillersE = [];
while (stats().nodePoolCapacity - stats().activeNodes > HEADROOM_E) {
    fillersE.push(signalBox(0));
}

const capBaseE = conservationBaseline();
let errE = null;
try {
    const doomed = new CapEffect();
    pkg.disposeReactive(doomed);               // unreachable on a correct core
} catch (e) {
    errE = e;
}
check(errE !== null, () => "capacity(effect): construction did not throw at the ceiling");
check(
    errE !== null && errE.name === "CapacityError",
    () => "capacity(effect): error name=" + (errE && errE.name) + " expected CapacityError",
);
assertConserved(capBaseE, "capacity(effect) partial-wiring teardown");

for (let i = 0; i < fillersE.length; i++) sigDispose(fillersE[i]);

const revivedE = new CapEffect();
check(revivedE.s0 === 0, () => "capacity(effect): revived s0=" + revivedE.s0);
check(revivedE.d0 === 1, () => "capacity(effect): revived d0=" + revivedE.d0);
pkg.disposeReactive(revivedE);

// Back to the phase-1 baseline before the bound-registry phase.
await settle();
assertConserved(base, "post-capacity quiesce");

// --- phase 3: registry isolation (S2a-A4) -------------------------------------

const boundReg = createRegistry({ maxNodes: 256 });
const BOUND = [
    makeShape("B0", 2, 1, 1, boundReg),
    makeShape("B1", 4, 2, 2, boundReg),
    makeShape("B2", 3, 1, 1, boundReg),
    makeShape("B3", 6, 3, 2, boundReg),
];
const BRING = 8;
const BRING_MASK = BRING - 1;
const BCYCLES = 512;

// Warm both pools' first-touch population out of the measured windows.
for (let i = 0; i < 64; i++) {
    const inst = new BOUND[i % BOUND.length]();
    pkg.disposeReactive(inst);
}

// Snapshot the DEFAULT registry: constructing/using/disposing bound instances
// must not move ANY default counter (S2a-A4 direction 1).
const defaultFrozen = conservationBaseline();

// Snapshot the bound registry's own quiescent F-0 counters.
const bs = boundReg.stats();
const boundBase = {
    activeNodes: bs.activeNodes,
    poolGrowths: bs.poolGrowths,
    totalAllocations: bs.totalAllocations,
    totalDisposals: bs.totalDisposals,
};

const bring = new Array(BRING).fill(null);
for (let i = 0; i < BCYCLES; i++) {
    RUN.op = i;
    const slot = i & BRING_MASK;
    const prev = bring[slot];
    if (prev !== null) pkg.disposeReactive(prev);
    const inst = new BOUND[randInt(BOUND.length)]();
    if (inst.s0 !== 0) check(false, () => "bound cycle " + i + ": s0 initial=" + inst.s0);
    inst.s0 = i;
    if (inst.s0 !== i) check(false, () => "bound cycle " + i + ": s0 after set=" + inst.s0);
    bring[slot] = inst;
}
for (let s = 0; s < BRING; s++) {
    if (bring[s] !== null) {
        pkg.disposeReactive(bring[s]);
        bring[s] = null;
    }
}

await settle();
RUN.op = -1;

// Direction 1: the DEFAULT registry never moved.
const df = stats();
check(df.activeNodes === defaultFrozen.activeNodes, () => "isolation: default activeNodes moved by " + (df.activeNodes - defaultFrozen.activeNodes));
check(df.totalAllocations === defaultFrozen.totalAllocations, () => "isolation: default totalAllocations moved by " + (df.totalAllocations - defaultFrozen.totalAllocations));
check(df.totalDisposals === defaultFrozen.totalDisposals, () => "isolation: default totalDisposals moved by " + (df.totalDisposals - defaultFrozen.totalDisposals));
check(df.poolGrowths === defaultFrozen.poolGrowths, () => "isolation: default poolGrowths moved by " + (df.poolGrowths - defaultFrozen.poolGrowths));

// Direction 2 + F-0 on the bound registry via its OWN stats().
const bf = boundReg.stats();
check(bf.activeNodes === boundBase.activeNodes, () => "isolation: bound activeNodes " + bf.activeNodes + " != baseline " + boundBase.activeNodes);
check(bf.poolGrowths - boundBase.poolGrowths === 0, () => "isolation: bound poolGrowths grew by " + (bf.poolGrowths - boundBase.poolGrowths));
check(bf.totalAllocations - bf.totalDisposals === bf.activeNodes, () => "isolation: bound ledger " + (bf.totalAllocations - bf.totalDisposals) + " != activeNodes " + bf.activeNodes);

pass(NAME);
