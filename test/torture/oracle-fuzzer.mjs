// test/torture/oracle-fuzzer.mjs -- node --expose-gc test/torture/oracle-fuzzer.mjs
//
// T4 (PLAN-S2b section 1): a differential oracle. A seeded (xorshift32) shape
// generator produces a random reactive graph -- P in 1..8 signals (a random
// subset carrying a tolerance `equals`), D in 0..8 deriveds (each reading 1..3
// random EARLIER members, so chains and diamonds arise by construction), E in
// 0..4 effects (each reading 1..2 members and bumping a counter). Each shape is
// realized TWICE:
//   - the DECORATED lane, built through the real package via mock-emitter
//     buildClass (@reactive / @derived / @reactiveEffect / @batched);
//   - a hand-wired RAW twin (signalBox/computedBox/effect + a createRoot anchor)
//     that replicates wireInstance EXACTLY and imports NOTHING from the package
//     in its construction. Same reads, same writes, same equals fns.
//
// Three passes per seed, all driven from the SAME op script (regenerated from a
// captured op-seed so every pass is byte-identical):
//   1. LOCKSTEP -- construct both twins, drive 20k mixed ops (direct accessor
//      write vs raw box.set; @batched bursts of 2..5 vs raw batch()), and after
//      EVERY op compare every signal value, every derived value, and every
//      effect fire count. Dispose both, assert F-0.
//   2/3. TALLY -- reconstruct each twin ALONE, attach the single global
//      onGraphMutation listener AFTER construction, drive the same script,
//      detach BEFORE dispose, and tally opcodes over the drive window only. The
//      two windows are separate because onGraphMutation is a single global slot.
//      The decorated and raw opcode tallies must match.
//
// Corpus: SEEDS env (default DEFAULT_SEEDS). A full corpus fits the child
// timeout; SEEDS scales it up. Any divergence prints seedIndex + shapeSeed + op
// index + member; TORTURE_SEED=<shapeSeed> reproduces that shape as seed 0.
//
// TORTURE_BREAK=oracle-fuzzer: the decorated lane silently skips every 1024th
// write. The lockstep value comparison must catch it.
//
// ASCII-only. MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

import {
    signalBox, computedBox, effect, createRoot, getOwner, runWithOwner,
    dispose as sigDispose, batch, onGraphMutation, stats,
} from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass, approxEquals } from "../shared/mock-emitter.mjs";
import {
    SEED, RUN, check, breakActive, makePrng, settle, pass,
    conservationBaseline, assertConserved,
} from "./helpers/harness.mjs";

const NAME = "oracle-fuzzer";

// Corpus + drive sizing. DEFAULT_SEEDS is what a plain run covers inside the
// child timeout; SEEDS raises it for the full corpus. OPS is fixed per BRIEF.
const DEFAULT_SEEDS = 300;
const SEEDS = (() => {
    const raw = process.env.SEEDS;
    if (raw === undefined) return DEFAULT_SEEDS;
    const n = Number(raw) | 0;
    return n > 0 ? n : DEFAULT_SEEDS;
})();
const OPS = 20000;

const BROKEN = breakActive(NAME);

// --- decorated write path (the ONLY sabotage point) ---------------------------
// Every decorated write -- direct or inside a @batched burst -- routes here so
// the BREAK skip is a single, honest injection. Under BREAK, every 1024th write
// is silently dropped; the raw twin never skips, so the lockstep value compare
// diverges.
let WRITE_COUNT = 0;
function decWrite(inst, key, v) {
    if (BROKEN) {
        WRITE_COUNT++;
        if ((WRITE_COUNT & 1023) === 0) return;
    }
    inst[key] = v;
}

// Reused burst scratch (2..5 writes): {j, v}. Mutated in place per batch op and
// consumed synchronously by both lanes, so no per-op array is allocated.
const BURST = [
    { j: 0, v: 0 }, { j: 0, v: 0 }, { j: 0, v: 0 }, { j: 0, v: 0 }, { j: 0, v: 0 },
];

// Active shape context (single-threaded, one shape at a time) so the class-level
// @batched body can reach the current shape's signal keys.
let CUR = null;

// --- shape generation ---------------------------------------------------------
//
// A shape is fully determined by a single 32-bit seed. Member index space:
// signals occupy [0, P); deriveds occupy [P, P+D). A value is a multiple of 0.5
// (exact in float) so sums never drift and `===` is a sound comparison; halves
// exercise the tolerance `equals` boundary (|delta| == 0.5 is NOT suppressed).

function keyOf(m, P) {
    return m < P ? "s" + m : "d" + (m - P);
}

function genVal(rng) {
    return (rng() % 40) / 2;                    // 0, 0.5, ... 19.5
}

function genShape(seed) {
    const rng = makePrng(seed);
    const P = 1 + (rng() % 8);                  // 1..8
    const D = rng() % 9;                        // 0..8
    const E = rng() % 5;                        // 0..4

    const sigInit = new Array(P);
    const sigEquals = new Array(P);
    const sigKeys = new Array(P);
    for (let j = 0; j < P; j++) {
        sigInit[j] = (rng() % 40) / 2;
        sigEquals[j] = (rng() & 1) === 0;       // a random subset carries equals
        sigKeys[j] = "s" + j;
    }

    const derReads = new Array(D);
    const derKeys = new Array(D);
    for (let k = 0; k < D; k++) {
        const avail = P + k;                    // members declared before this one
        let cnt = 1 + (rng() % 3);              // 1..3
        if (cnt > avail) cnt = avail;
        const reads = new Array(cnt);
        for (let t = 0; t < cnt; t++) reads[t] = rng() % avail;
        derReads[k] = reads;
        derKeys[k] = "d" + k;
    }

    const effReads = new Array(E);
    const members = P + D;
    for (let i = 0; i < E; i++) {
        let cnt = 1 + (rng() % 2);              // 1..2
        if (cnt > members) cnt = members;
        const reads = new Array(cnt);
        for (let t = 0; t < cnt; t++) reads[t] = rng() % members;
        effReads[i] = reads;
    }

    // Precompute the read-key arrays the decorated bodies close over.
    const derReadKeys = new Array(D);
    for (let k = 0; k < D; k++) {
        const reads = derReads[k];
        const keys = new Array(reads.length);
        for (let t = 0; t < reads.length; t++) keys[t] = keyOf(reads[t], P);
        derReadKeys[k] = keys;
    }
    const effReadKeys = new Array(E);
    for (let i = 0; i < E; i++) {
        const reads = effReads[i];
        const keys = new Array(reads.length);
        for (let t = 0; t < reads.length; t++) keys[t] = keyOf(reads[t], P);
        effReadKeys[i] = keys;
    }

    return {
        P, D, E, sigInit, sigEquals, sigKeys, derKeys,
        derReads, effReads, derReadKeys, effReadKeys,
    };
}

// --- decorated realization (built once per shape) -----------------------------

function buildDecorated(shape) {
    const { P, D, E, sigInit, sigEquals, sigKeys, derReadKeys, effReadKeys } = shape;
    const members = [];
    for (let j = 0; j < P; j++) {
        const init = sigInit[j];
        members.push({
            kind: "accessor",
            key: sigKeys[j],
            decorator: sigEquals[j] ? pkg.reactive({ equals: approxEquals }) : pkg.reactive,
            value: function () { return init; },
        });
    }
    for (let k = 0; k < D; k++) {
        const keys = derReadKeys[k];
        members.push({
            kind: "getter",
            key: shape.derKeys[k],
            decorator: pkg.derived,
            body: function () {
                let s = 0;
                for (let t = 0; t < keys.length; t++) s += this[keys[t]];
                return s;
            },
        });
    }
    // Per-instance effect fire counters live in a plain field so the shared
    // class-level effect body bumps the RIGHT instance's array (fields init
    // before leaf-time wiring, so __c exists when the effect first fires).
    for (let i = 0; i < E; i++) {
        const keys = effReadKeys[i];
        const idx = i;
        members.push({
            kind: "method",
            key: "e" + i,
            decorator: pkg.reactiveEffect,
            body: function () {
                let s = 0;
                for (let t = 0; t < keys.length; t++) s += this[keys[t]];
                this.__c[idx]++;
                void s;
            },
        });
    }
    // @batched burst: writes routed through decWrite (the BREAK injection point).
    members.push({
        kind: "method",
        key: "burst",
        decorator: pkg.batched,
        body: function (burst, len) {
            const keys = CUR.sigKeys;
            for (let i = 0; i < len; i++) decWrite(this, keys[burst[i].j], burst[i].v);
        },
    });
    members.push({
        kind: "field",
        key: "__c",
        value: function () { return new Array(E).fill(0); },
    });

    return buildClass({ name: "Oracle", classDecorator: pkg.reactiveHost, members });
}

// --- raw twin (imports nothing from the package; replicates wireInstance) ------

function makeRaw(shape, counters) {
    const { P, D, E, sigInit, sigEquals, derReads, effReads } = shape;
    // Bare signal boxes in spec order BEFORE the anchor (wireInstance).
    const signals = new Array(P);
    for (let j = 0; j < P; j++) {
        signals[j] = signalBox(sigInit[j], sigEquals[j] ? { equals: approxEquals } : undefined);
    }
    let a;
    createRoot(() => { effect(() => { a = getOwner(); }); });   // R-A anchor
    const deriveds = new Array(D);
    runWithOwner(a, () => {
        for (let k = 0; k < D; k++) {
            const reads = derReads[k];
            deriveds[k] = computedBox(function () {
                let s = 0;
                for (let t = 0; t < reads.length; t++) {
                    const m = reads[t];
                    s += m < P ? signals[m].get() : deriveds[m - P].get();
                }
                return s;
            });
        }
        for (let i = 0; i < E; i++) {
            const reads = effReads[i];
            const idx = i;
            effect(function () {
                let s = 0;
                for (let t = 0; t < reads.length; t++) {
                    const m = reads[t];
                    s += m < P ? signals[m].get() : deriveds[m - P].get();
                }
                counters[idx]++;
                void s;
            });
        }
    });
    return { signals, deriveds, anchor: a };
}

function disposeRaw(raw) {
    sigDispose(raw.anchor);                     // cascades deriveds + effects
    const sigs = raw.signals;
    for (let j = 0; j < sigs.length; j++) sigDispose(sigs[j]);   // signals are not owned
}

// --- op application (shared by all passes) ------------------------------------
//
// `applyOp` draws one op from `rng` and applies it to whichever lanes are
// present. Passing the decorated vm and/or the raw twin selects the lane. The
// op stream is identical for a given rng seed regardless of which lanes run.

function drawAndApply(rng, shape, vm, raw) {
    const P = shape.P;
    const sigKeys = shape.sigKeys;
    if ((rng() & 1) === 0) {
        // direct single write
        const j = rng() % P;
        const v = genVal(rng);
        if (vm !== null) decWrite(vm, sigKeys[j], v);
        if (raw !== null) raw.signals[j].set(v);
    } else {
        // @batched burst of 2..5 writes
        const k = 2 + (rng() % 4);              // 2..5
        for (let t = 0; t < k; t++) {
            BURST[t].j = rng() % P;
            BURST[t].v = genVal(rng);
        }
        if (vm !== null) vm.burst(BURST, k);
        if (raw !== null) {
            batch(function () {
                for (let t = 0; t < k; t++) raw.signals[BURST[t].j].set(BURST[t].v);
            });
        }
    }
}

// --- lockstep pass: value + fire-count parity ---------------------------------

function compareState(shape, vm, raw, seedIdx, shapeSeed, opIdx) {
    const P = shape.P, D = shape.D, E = shape.E;
    const sigKeys = shape.sigKeys, derKeys = shape.derKeys;
    const raws = raw.signals, rawd = raw.deriveds;
    for (let j = 0; j < P; j++) {
        const dv = vm[sigKeys[j]];
        const rv = raws[j].peek();
        check(dv === rv, () => diverge(seedIdx, shapeSeed, opIdx, "signal " + sigKeys[j],
            "decorated=" + dv + " raw=" + rv));
    }
    for (let k = 0; k < D; k++) {
        const dv = vm[derKeys[k]];
        const rv = rawd[k].peek();
        check(dv === rv, () => diverge(seedIdx, shapeSeed, opIdx, "derived " + derKeys[k],
            "decorated=" + dv + " raw=" + rv));
    }
    const dc = vm.__c;
    for (let i = 0; i < E; i++) {
        check(dc[i] === raw.counters[i], () => diverge(seedIdx, shapeSeed, opIdx, "effect e" + i,
            "decorated fires=" + dc[i] + " raw fires=" + raw.counters[i]));
    }
}

function diverge(seedIdx, shapeSeed, opIdx, member, detail) {
    return "ORACLE DIVERGENCE seedIdx=" + seedIdx + " shapeSeed=" + (shapeSeed >>> 0) +
        " op=" + opIdx + " member=" + member + " -- " + detail +
        " (replay: TORTURE_SEED=" + (shapeSeed >>> 0) + " SEEDS=1)";
}

function runLockstep(shape, opSeed, seedIdx, shapeSeed) {
    const C = shape.C;
    const vm = new C();
    const counters = new Array(shape.E).fill(0);
    const raw = makeRaw(shape, counters);
    raw.counters = counters;

    // Construction parity: both lanes fired each effect exactly once.
    compareState(shape, vm, raw, seedIdx, shapeSeed, -1);

    const rng = makePrng(opSeed);
    for (let opIdx = 0; opIdx < OPS; opIdx++) {
        RUN.op = opIdx;
        drawAndApply(rng, shape, vm, raw);
        compareState(shape, vm, raw, seedIdx, shapeSeed, opIdx);
    }
    RUN.op = -1;

    pkg.disposeReactive(vm);
    disposeRaw(raw);
}

// --- tally pass: opcode parity over the drive window --------------------------

function tallyDecorated(shape, opSeed) {
    const C = shape.C;
    const vm = new C();
    const tally = [0, 0, 0, 0, 0, 0];
    const off = onGraphMutation(function (op) { tally[op]++; });
    const rng = makePrng(opSeed);
    for (let opIdx = 0; opIdx < OPS; opIdx++) drawAndApply(rng, shape, vm, null);
    off();
    pkg.disposeReactive(vm);
    return tally;
}

function tallyRaw(shape, opSeed) {
    const counters = new Array(shape.E).fill(0);
    const raw = makeRaw(shape, counters);
    const tally = [0, 0, 0, 0, 0, 0];
    const off = onGraphMutation(function (op) { tally[op]++; });
    const rng = makePrng(opSeed);
    for (let opIdx = 0; opIdx < OPS; opIdx++) drawAndApply(rng, shape, null, raw);
    off();
    disposeRaw(raw);
    return tally;
}

function compareTallies(talD, talR, seedIdx, shapeSeed) {
    for (let op = 1; op <= 5; op++) {
        check(talD[op] === talR[op], () => "ORACLE OPCODE DIVERGENCE seedIdx=" + seedIdx +
            " shapeSeed=" + (shapeSeed >>> 0) + " opcode=" + op +
            " decorated=" + talD[op] + " raw=" + talR[op] +
            " (replay: TORTURE_SEED=" + (shapeSeed >>> 0) + " SEEDS=1)");
    }
}

// --- corpus -------------------------------------------------------------------
//
// shapeSeed_0 == SEED exactly (so TORTURE_SEED=<printed> reproduces a failing
// shape as the first iteration); subsequent seeds are spread by an xorshift
// step. Shape + ops are fully determined by shapeSeed alone.

function nextSeed(s) {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return (s >>> 0) || 1;
}

// Warm up the pools so first-touch population is not charged to conservation.
{
    const warm = genShape(0x1234abcd);
    warm.C = buildDecorated(warm);
    const vm = new warm.C();
    const counters = new Array(warm.E).fill(0);
    const raw = makeRaw(warm, counters);
    pkg.disposeReactive(vm);
    disposeRaw(raw);
}

const base = conservationBaseline();

let shapeSeed = SEED >>> 0;
for (let seedIdx = 0; seedIdx < SEEDS; seedIdx++) {
    const shape = genShape(shapeSeed);
    shape.C = buildDecorated(shape);
    CUR = shape;

    // Capture an op-seed AFTER shape generation so every pass regenerates the
    // identical op stream.
    const opSeed = makePrng(shapeSeed ^ 0x5bd1e995)() || 1;

    runLockstep(shape, opSeed, seedIdx, shapeSeed);
    const talD = tallyDecorated(shape, opSeed);
    const talR = tallyRaw(shape, opSeed);
    compareTallies(talD, talR, seedIdx, shapeSeed);

    shapeSeed = nextSeed(shapeSeed);
}

await settle();
RUN.op = -1;
assertConserved(base, "oracle corpus teardown");

pass(NAME);
