// test/torture/batch-untrack-torture.mjs -- node --expose-gc test/torture/batch-untrack-torture.mjs
//
// T6 (PLAN-S2b section 1): @batched nesting, exception unwind, and the
// tracking/untracking boundary at the decorator surface, all pinned against the
// lite-signal engine's documented batch contract (Signal.js: batch flushes in a
// `finally`; nested batches merge; only the outermost close triggers a flush).
//
//   1. @batched nesting -- batched calling batched, and batched calling a raw
//      batch(): the owned effect flushes exactly ONCE at the outermost close.
//   2. exception unwind mid-@batched -- a throw after a write still flushes the
//      pre-throw write on batch close (engine contract: NOT transactional); the
//      instance stays consistent and conservation holds.
//   3. boxOf(vm, k).peek() inside a FOREIGN effect adds no edge -- mutating the
//      member never re-runs that effect (re-run count stays 0 for the member's
//      changes; the effect's real dep still fires it).
//   4. untrack() inside a @reactiveEffect body suppresses that read's dep -- a
//      mutation of the untracked member does not re-run the effect; the tracked
//      member does (counted re-runs).
//   5. manual guarded @batched calls nested inside a raw batch coalesce -- one
//      flush at the outer close.
//
// TORTURE_BREAK=batch-untrack-torture: case 3 replaces the peek with a tracked
// get, which adds an edge; the "adds no edge" assertion must catch it.
//
// ASCII-only. MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

import {
    signalBox, effect, batch, untrack, dispose as sigDispose,
} from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, settle, pass, conservationBaseline, assertConserved,
} from "./helpers/harness.mjs";

const NAME = "batch-untrack-torture";

// A shared fire counter for the watch effect on the current M instance. Reset by
// re-reading the instance's own field; kept module-level because a @reactiveEffect
// body is class-level and one instance is live per block.
const fires = { n: 0 };

// M: two signals, one watch effect (counts flushes), and the batched family.
const M = buildClass({
    name: "M",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "a", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "b", decorator: pkg.reactive, value: () => 0 },
        {
            kind: "method",
            key: "watch",
            decorator: pkg.reactiveEffect,
            body: function () { fires.n++; void this.a; void this.b; },
        },
        {
            kind: "method",
            key: "inner",
            decorator: pkg.batched,
            body: function () { this.a = this.a + 1; },
        },
        {
            kind: "method",
            key: "outer",
            decorator: pkg.batched,
            body: function () { this.a = this.a + 1; this.inner(); this.b = this.b + 1; },
        },
        {
            kind: "method",
            key: "outerRaw",
            decorator: pkg.batched,
            body: function () {
                this.a = this.a + 1;
                batch(() => { this.b = this.b + 1; });
                this.a = this.a + 1;
            },
        },
        {
            kind: "method",
            key: "boom",
            decorator: pkg.batched,
            body: function () { this.a = this.a + 1; throw new Error("kaboom"); },
        },
    ],
});

// Warm the pools, then baseline conservation.
{
    const w = new M();
    pkg.disposeReactive(w);
}
const base = conservationBaseline();

// --- case 1: @batched -> @batched, flush at the outermost close ---------------

RUN.op = 1;
{
    fires.n = 0;
    const c = new M();
    check(fires.n === 1, () => "nest-wire: fires=" + fires.n + " expected 1");

    const before = fires.n;
    c.outer();                                  // a+1, inner()->a+1, b+1 : ONE flush
    check(fires.n === before + 1, () => "nest bb: fires delta=" + (fires.n - before) + " expected 1");
    check(c.a === 2, () => "nest bb: a=" + c.a + " expected 2");
    check(c.b === 1, () => "nest bb: b=" + c.b + " expected 1");

    pkg.disposeReactive(c);
}

// --- case 2: @batched -> raw batch(), flush at the outermost close -------------

RUN.op = 2;
{
    fires.n = 0;
    const c = new M();
    const before = fires.n;
    c.outerRaw();                               // a+1, raw batch(b+1), a+1 : ONE flush
    check(fires.n === before + 1, () => "nest b-raw: fires delta=" + (fires.n - before) + " expected 1");
    check(c.a === 2, () => "nest b-raw: a=" + c.a + " expected 2");
    check(c.b === 1, () => "nest b-raw: b=" + c.b + " expected 1");

    pkg.disposeReactive(c);
}

// --- case 3: boxOf peek inside a foreign effect adds no edge (BREAK point) -----

RUN.op = 3;
{
    fires.n = 0;
    const c = new M();
    const gate = signalBox(0);
    const box = pkg.boxOf(c, "a");
    let outerRuns = -1;
    // BREAK swaps the peek for a tracked get, which subscribes the effect to `a`.
    const e = effect(() => {
        outerRuns++;
        gate.get();
        if (breakActive(NAME)) box.get(); else box.peek();
    });
    check(outerRuns === 0, () => "peek-edge: initial outerRuns=" + outerRuns + " expected 0");

    c.a = 42;                                   // peek added no edge -> no re-run
    check(outerRuns === 0, () => "peek-edge: mutating a re-ran the foreign effect (runs=" + outerRuns + ") -- peek added an edge");

    gate.set(1);                                // the effect's REAL dep -> one re-run
    check(outerRuns === 1, () => "peek-edge: real dep did not re-run (runs=" + outerRuns + ")");

    sigDispose(e);
    sigDispose(gate);
    pkg.disposeReactive(c);
}

// --- case 4: untrack() inside a @reactiveEffect body suppresses that dep -------

const fires2 = { n: 0 };
const UntrackC = buildClass({
    name: "UntrackC",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "a", decorator: pkg.reactive, value: () => 0 },
        { kind: "accessor", key: "b", decorator: pkg.reactive, value: () => 0 },
        {
            kind: "method",
            key: "t",
            decorator: pkg.reactiveEffect,
            body: function () {
                fires2.n++;
                void this.a;                    // tracked
                untrack(() => { void this.b; }); // NOT tracked
            },
        },
    ],
});

RUN.op = 4;
{
    fires2.n = 0;
    const c = new UntrackC();
    check(fires2.n === 1, () => "untrack: wire fires=" + fires2.n + " expected 1");

    c.b = 5;                                    // untracked -> no re-run
    check(fires2.n === 1, () => "untrack: mutating b re-ran (fires=" + fires2.n + ") -- untrack did not suppress");

    c.a = 5;                                    // tracked -> re-run
    check(fires2.n === 2, () => "untrack: mutating a did not re-run (fires=" + fires2.n + ")");

    pkg.disposeReactive(c);
}

// --- case 5: manual guarded @batched calls nested in a raw batch coalesce ------

RUN.op = 5;
{
    fires.n = 0;
    const c = new M();
    const before = fires.n;
    const beforeA = c.a;
    batch(() => { c.inner(); c.inner(); });     // two @batched calls, ONE outer flush
    check(fires.n === before + 1, () => "manual-in-batch: fires delta=" + (fires.n - before) + " expected 1");
    check(c.a === beforeA + 2, () => "manual-in-batch: a=" + c.a + " expected " + (beforeA + 2));

    pkg.disposeReactive(c);
}

// --- case 6: exception unwind mid-@batched (pre-throw write flushes) -----------

RUN.op = 6;
{
    fires.n = 0;
    const c = new M();
    const before = fires.n;
    let caught = null;
    try { c.boom(); } catch (e) { caught = e; }
    check(caught instanceof Error && caught.message === "kaboom",
        () => "unwind: threw " + (caught && caught.message) + " expected kaboom");
    // Engine contract: NOT transactional. The pre-throw write to `a` applied and
    // flushed on batch close, so the effect fired once and the instance is
    // consistent.
    check(c.a === 1, () => "unwind: a=" + c.a + " expected 1 (pre-throw write applied)");
    check(fires.n === before + 1, () => "unwind: fires delta=" + (fires.n - before) + " expected 1 (flush on batch close)");

    // The instance stays fully live and usable after the caught throw.
    c.a = 7;
    check(fires.n === before + 2, () => "unwind: instance not consistent after throw (fires=" + fires.n + ")");
    check(c.a === 7, () => "unwind: post-throw write a=" + c.a + " expected 7");

    pkg.disposeReactive(c);
}

await settle();
RUN.op = -1;
assertConserved(base, "batch-untrack teardown");

pass(NAME);
