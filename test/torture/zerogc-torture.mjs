// test/torture/zerogc-torture.mjs -- node --expose-gc test/torture/zerogc-torture.mjs
//
// The zero-GC hot-path claim, made falsifiable. One instance (P=4 signals, D=2
// deriveds) is built in setup; then two measured lanes run through gcGate:
//   READ  -- masked-index reads of the signal accessors and derived getters,
//            accumulated into a sink (anti-DCE) and cross-checked against a
//            precomputed checksum;
//   WRITE -- signal sets with changing values.
// Both gate maxMajor: 0 and maxPauseMs: 4.
//
// The S0 lesson (decision 0003): allocBytes/op has a sampling NOISE FLOOR, so
// we do not gate bytes === 0. We gate the observable of an allocation storm --
// GC events -- with maxMajor: 0, maxPauseMs: 4, AND a maxMinor limit whose floor
// is MEASURED from a known-zero-alloc control body in THIS same process (never a
// hardcoded budget). A clean read lane provokes ~0 minors; the BREAK
// (new Array(1024) per op) provokes thousands -- far above the control floor.
//
// TORTURE_BREAK=zerogc-torture makes the READ lane allocate a 1024-slot array
// per op; the maxMinor gate is what catches it.
//
// ASCII-only.

import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import { check, breakActive, gcGate, pass } from "./helpers/harness.mjs";

const NAME = "zerogc-torture";

// --- the instance under test (setup may allocate freely) ----------------------

const members = [];
for (let i = 0; i < 4; i++) {
    members.push({
        kind: "accessor",
        key: "s" + i,
        decorator: pkg.reactive,
        value: (function (v) { return function () { return v; }; })(i),
    });
}
members.push({ kind: "getter", key: "d0", decorator: pkg.derived, body: function () { return this.s0 + this.s1; } });
members.push({ kind: "getter", key: "d1", decorator: pkg.derived, body: function () { return this.s2 + this.s3; } });
const VM = buildClass({ name: "ZeroGcVM", classDecorator: pkg.reactiveHost, members });
const vm = new VM();
// s0..s3 = 0,1,2,3 ; d0 = 1 ; d1 = 5.

// Eight preallocated readers, masked with & 7 (power-of-2 index). No closures or
// strings are built inside the measured loop.
const READERS = [
    () => vm.s0, () => vm.s1, () => vm.s2, () => vm.s3,
    () => vm.d0, () => vm.d1, () => vm.s0, () => vm.s1,
];
// Sum of one full cycle of the eight readers: 0+1+2+3+1+5+0+1 = 13.
const CYCLE_SUM = 13;

const OPS = 1_000_000;
const WARMUP = 50_000;

// --- correctness checksum (anti-DCE, verified) --------------------------------
// A deterministic pass over a whole number of cycles must equal N/8 * CYCLE_SUM.

{
    const N = 8000;
    let sum = 0;
    for (let i = 0; i < N; i++) sum += READERS[i & 7]();
    const expected = (N / 8) * CYCLE_SUM;
    check(sum === expected, () => "read checksum " + sum + " != expected " + expected);
}

// --- control floor: minors provoked by a known zero-alloc body ----------------
// Measured in-process (per decision 0003). The read/write budgets derive from
// it, so the gate never rests on a hardcoded number.

const controlSummary = await gcGate("control", (i) => (i & 7), {
    ops: OPS,
    warmup: WARMUP,
    maxMajor: 0,
    maxPauseMs: 4,
});
const MINOR_FLOOR = controlSummary.gc.minor;
// Headroom over the floor absorbs V8 background scavenges (self-noise is a few
// minors per window); the BREAK sits ~4000 minors above this, unmistakably.
const MINOR_LIMIT = MINOR_FLOOR + 128;

// --- READ lane ----------------------------------------------------------------

const readClean = (i) => READERS[i & 7]();
const readBreak = (i) => { const a = new Array(1024); a[0] = i; return a[0] + READERS[i & 7](); };
const readFn = breakActive(NAME) ? readBreak : readClean;

await gcGate("read", readFn, {
    ops: OPS,
    warmup: WARMUP,
    maxMajor: 0,
    maxMinor: MINOR_LIMIT,
    maxPauseMs: 4,
});

// --- WRITE lane ---------------------------------------------------------------

const writeFn = (i) => { vm.s0 = (i & 1023); return vm.s0; };

await gcGate("write", writeFn, {
    ops: OPS,
    warmup: WARMUP,
    maxMajor: 0,
    maxMinor: MINOR_LIMIT,
    maxPauseMs: 4,
});

pass(NAME);
