// test/torture/pool-conservation.mjs -- node --expose-gc test/torture/pool-conservation.mjs
//
// FINDING F-0 under churn, then the S1-A3 capacity-primed mid-wiring case, both
// on the DEFAULT lite-signal registry (decision 0002 D-2e: keep the live set
// bounded so the 1024-node ceiling is never the thing under test).
//
//   Phase 1 -- 4096 mixed construct/use/dispose cycles over PRNG-varied shapes
//     (P<=8 signals, D<=4 deriveds) through a 48-slot ring (max ~48 live
//     instances, well under 900 live nodes). After full teardown + settle,
//     assertConserved: activeNodes back to baseline, poolGrowths delta 0,
//     totalAllocations - totalDisposals === activeNodes.
//
//   Phase 2 -- prime the registry with raw signalBox fillers to N - epsilon, so
//     a P=1,D=4 construction fits its signal + anchor + first derived but the
//     SECOND derived overflows: expect a CapacityError (by name), F-0 intact
//     (the partial wiring was torn down, PD-7), fillers freed, and an identical
//     construction then SUCCEEDS -- the registry is usable again.
//
// TORTURE_BREAK=pool-conservation leaks one instance every 256 cycles (skips
// its dispose); the phase-1 conservation assertion is what must catch it.
//
// ASCII-only.

import { signalBox, dispose as sigDispose, stats } from "@zakkster/lite-signal";
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

function makeShape(id, P, D) {
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
    const C = buildClass({ name: "Shape" + id, classDecorator: pkg.reactiveHost, members });
    C.__P = P;
    C.__D = D;
    return C;
}

const SHAPES = [
    makeShape(0, 1, 0),
    makeShape(1, 3, 2),
    makeShape(2, 5, 4),
    makeShape(3, 8, 4),
    makeShape(4, 2, 1),
    makeShape(5, 6, 3),
];

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

// --- phase 2: S1-A3 capacity-primed mid-wiring --------------------------------

// A P=1, D=4 shape: 1 signal + 1 anchor + 4 deriveds = 6 nodes. With headroom of
// exactly 3 (signal + anchor + one derived), the SECOND derived overflows.
const CapShape = makeShape(99, 1, 4);
const HEADROOM = 3;

const fillers = [];
while (stats().nodePoolCapacity - stats().activeNodes > HEADROOM) {
    fillers.push(signalBox(0));
}

const capBase = conservationBaseline();
let err = null;
try {
    const doomed = new CapShape();
    // Unreachable on a correct core: construction must overflow.
    pkg.disposeReactive(doomed);
} catch (e) {
    err = e;
}
check(err !== null, () => "capacity: construction did not throw at the ceiling");
check(
    err !== null && err.name === "CapacityError",
    () => "capacity: error name=" + (err && err.name) + " expected CapacityError",
);

// PD-7: the partial wiring was torn down -- conservation is exact.
assertConserved(capBase, "capacity partial-wiring teardown");

// Free the fillers; the registry must be usable again.
for (let i = 0; i < fillers.length; i++) sigDispose(fillers[i]);

const revived = new CapShape();
check(revived.s0 === 0, () => "capacity: revived instance s0=" + revived.s0);
check(revived.d0 === 1, () => "capacity: revived instance d0=" + revived.d0);
pkg.disposeReactive(revived);

// Everything is torn down: back to the phase-1 baseline.
await settle();
assertConserved(base, "final quiesce");

pass(NAME);
