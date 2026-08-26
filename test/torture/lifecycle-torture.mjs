// test/torture/lifecycle-torture.mjs -- node --expose-gc test/torture/lifecycle-torture.mjs
//
// The instance lifecycle contract (decision 0002 D-2a/D-2c/D-2d + S2a effects
// PD-12/D-4d):
//   - a wired instance has an anchor and rootOf(vm).kind === "effect";
//   - disposeReactive cascades EXACTLY once: totalDisposals moves by P+D+E+1
//     (anchor + owned deriveds + owned effects + explicitly-disposed signal
//     boxes), no more;
//   - a second disposeReactive is an idempotent no-op: returns false, moves no
//     counter;
//   - DV-1 regression (0002 Q4): an instance CONSTRUCTED INSIDE a raw
//     lite-signal parent effect is detached, so it keeps firing its own
//     subscription after the parent re-runs;
//   - a `using` block disposes via Symbol.dispose;
//   - every post-dispose touch (get/set/boxOf/rootOf) throws
//     ReactiveDisposedError;
//   - S2a effect lanes: start-timing (an effect fires ONCE at leaf wiring, after
//     every field of every class in the chain is initialized -- observed by the
//     fields it records on first run); dispose-stop (a captured box write after
//     disposeReactive fires the effect zero times); D-4d self-dispose BOTH
//     variants (clean: run completes, returns true, conservation exact, the
//     D-2f derived guard does NOT fire; poison-touch: a decorated touch after
//     self-dispose in the same run throws ReactiveDisposedError); and a
//     foreign-manual-call that adds zero edges (an outer effect never re-runs).
//
// TORTURE_BREAK=lifecycle-torture expects a post-dispose box write to re-fire
// the stopped effect (dispose-stop gate) so the control sweep proves it can
// fail.
//
// ASCII-only.

import { signalBox, effect, dispose as sigDispose, stats } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass, makeClasses } from "../shared/mock-emitter.mjs";
import { RUN, check, breakActive, pass } from "./helpers/harness.mjs";

const NAME = "lifecycle-torture";
const { Counter, SYM } = makeClasses(pkg);
// Counter: P=3 signals (count, level, SYM) + D=2 deriveds (double, band) + E=1
// effect (onCount) + 1 anchor => P+D+E+1 = 7. The @batched member wires no node.
const PD1 = 7;

// --- anchor + rootOf ----------------------------------------------------------

RUN.op = 0;
{
    const c = new Counter();
    const root = pkg.rootOf(c);
    check(root !== undefined && root !== null, () => "rootOf returned " + String(root));
    check(root.kind === "effect", () => "anchor kind=" + root.kind + " expected effect");
    pkg.disposeReactive(c);
}

// --- cascade exactly once -----------------------------------------------------

RUN.op = 1;
{
    const c = new Counter();
    const d0 = stats().totalDisposals;
    const moved = pkg.disposeReactive(c);
    const delta = stats().totalDisposals - d0;
    check(moved === true, () => "first dispose returned " + moved);
    check(
        delta === PD1,
        () => "cascade disposed " + delta + " nodes, expected P+D+E+1=" + PD1,
    );
}

// --- idempotent double dispose ------------------------------------------------

RUN.op = 2;
{
    const c = new Counter();
    const first = pkg.disposeReactive(c);
    check(first === true, () => "first dispose returned " + first);

    const disp = stats().totalDisposals;
    const alloc = stats().totalAllocations;
    const active = stats().activeNodes;
    const second = pkg.disposeReactive(c);
    check(second === false, () => "double dispose returned " + second + " expected false");
    check(stats().totalDisposals === disp, () => "double dispose moved totalDisposals");
    check(stats().totalAllocations === alloc, () => "double dispose moved totalAllocations");
    check(stats().activeNodes === active, () => "double dispose moved activeNodes");
}

// --- DV-1 regression: detached-by-default survives a parent re-run ------------

RUN.op = 3;
{
    const dep = signalBox(0);
    let vm = null;
    // The instance is constructed INSIDE a live parent effect. Its own wiring
    // uses createRoot (R-A), so it is NOT adopted by this parent.
    const parent = effect(() => {
        dep.get();
        if (vm === null) vm = new Counter();
    });

    // Observe the instance's own derived through its live box. If the instance
    // were adopted, the parent re-run below would cascade-dispose this derived
    // and no further value would arrive.
    const seen = [];
    const unsub = pkg.boxOf(vm, "double").subscribe((v) => { seen.push(v); });

    vm.count = 1;                              // double 0 -> 2
    vm.count = 2;                              // -> 4
    vm.count = 3;                              // -> 6
    const beforeRerun = seen.length;

    dep.set(1);                               // parent RE-RUNS here
    check(
        pkg.rootOf(vm).kind === "effect",
        () => "DV-1: anchor did not survive the parent re-run",
    );

    vm.count = 5;                             // -> 10, only if still live
    check(
        seen.length === beforeRerun + 1,
        () => "DV-1: derived did not fire after the parent re-run (seen=" + seen.join(",") + ")",
    );
    check(
        seen[seen.length - 1] === 10,
        () => "DV-1: last derived value=" + seen[seen.length - 1] + " expected 10 (seen=" + seen.join(",") + ")",
    );

    unsub();
    pkg.disposeReactive(vm);
    sigDispose(parent);
    sigDispose(dep);
}

// --- using block disposes via Symbol.dispose ----------------------------------

RUN.op = 4;
{
    const before = stats().activeNodes;
    let captured = null;
    {
        using c = new Counter();
        captured = c;
        check(c.count === 0, () => "using: initial count=" + c.count);
    }
    // Block exit ran Symbol.dispose -> full teardown, back to baseline.
    check(
        stats().activeNodes === before,
        () => "using: activeNodes " + stats().activeNodes + " != baseline " + before,
    );
    check(
        pkg.disposeReactive(captured) === false,
        () => "using: instance was not already disposed",
    );
}

// --- post-dispose touches all throw ReactiveDisposedError ---------------------

RUN.op = 5;
{
    const c = new Counter();
    pkg.disposeReactive(c);

    const RDE = pkg.ReactiveDisposedError;
    check(throwsRDE(() => c.count, RDE), () => "post-dispose get did not throw ReactiveDisposedError");
    check(throwsRDE(() => { c.count = 9; }, RDE), () => "post-dispose set did not throw ReactiveDisposedError");
    check(throwsRDE(() => c[SYM], RDE), () => "post-dispose symbol get did not throw ReactiveDisposedError");
    check(throwsRDE(() => c.double, RDE), () => "post-dispose derived get did not throw ReactiveDisposedError");
    check(throwsRDE(() => pkg.boxOf(c, "count"), RDE), () => "post-dispose boxOf did not throw ReactiveDisposedError");
    check(throwsRDE(() => pkg.rootOf(c), RDE), () => "post-dispose rootOf did not throw ReactiveDisposedError");
}

// --- S2a: effect start-timing across the inheritance chain (A1) ---------------
//
// STBase declares an effect BEFORE a plain field, and reads a signal (`b`) that
// only STDerived declares. The single leaf-time wiring means the effect's first
// run sees a=1, b=2, later=42 -- every field of every class initialized.

const STBase = buildClass({
    name: "STBase",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "a", decorator: pkg.reactive, value: () => 1 },
        {
            kind: "method",
            key: "obs",
            decorator: pkg.reactiveEffect,
            body: function () {
                this.__runs = (this.__runs | 0) + 1;
                this.__seen = [this.a, this.b, this.later];
            },
        },
        { kind: "field", key: "later", value: function () { return 42; } },
    ],
});
const STDerived = buildClass({
    name: "STDerived",
    superClass: STBase,
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "b", decorator: pkg.reactive, value: () => 2 },
    ],
});

RUN.op = 6;
{
    const inst = new STDerived();
    check((inst.__runs | 0) === 1, () => "start-timing: effect ran " + (inst.__runs | 0) + " times, expected 1");
    const seen = inst.__seen;
    check(
        Array.isArray(seen) && seen[0] === 1 && seen[1] === 2 && seen[2] === 42,
        () => "start-timing: effect saw " + JSON.stringify(seen) + " expected [1,2,42]",
    );
    pkg.disposeReactive(inst);
}

// --- S2a: dispose-stop (A2) ---------------------------------------------------
//
// A captured box handle is written AFTER disposeReactive; the stopped effect
// must fire zero more times. TORTURE_BREAK expects one extra fire -> fails.

const WatchC = buildClass({
    name: "WatchC",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "n", decorator: pkg.reactive, value: () => 0 },
        {
            kind: "method",
            key: "watch",
            decorator: pkg.reactiveEffect,
            body: function () { this.__runs = (this.__runs | 0) + 1; void this.n; },
        },
    ],
});

RUN.op = 7;
{
    const w = new WatchC();
    check((w.__runs | 0) === 1, () => "dispose-stop: wire-fire=" + (w.__runs | 0) + " expected 1");
    w.n = 5;
    check((w.__runs | 0) === 2, () => "dispose-stop: mutate re-fire=" + (w.__runs | 0) + " expected 2");

    const box = pkg.boxOf(w, "n");             // captured BEFORE dispose
    const moved = pkg.disposeReactive(w);
    check(moved === true, () => "dispose-stop: disposeReactive returned " + moved);

    const runsAtDispose = w.__runs | 0;
    try { box.set(9); } catch (_) { /* the box is torn down; the write fires nothing */ }

    // BREAK sabotages here: the stopped effect must NOT re-fire; the control
    // expects it to (runsAtDispose + 1) and therefore fails.
    const expected = breakActive(NAME) ? runsAtDispose + 1 : runsAtDispose;
    check(
        (w.__runs | 0) === expected,
        () => "dispose-stop: post-dispose runs=" + (w.__runs | 0) + " expected " + expected,
    );
}

// --- S2a: D-4d self-dispose, clean variant (PD-12) ----------------------------
//
// disposeReactive(this) from inside the owned wiring effect: the run completes,
// returns true, no re-runs, conservation exact, and the D-2f derived guard does
// NOT fire (a fire would throw instead of returning true).

let selfCleanRet = null;
const SelfCleanC = buildClass({
    name: "SelfCleanC",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "v", decorator: pkg.reactive, value: () => 0 },
        {
            kind: "method",
            key: "go",
            decorator: pkg.reactiveEffect,
            body: function () {
                this.__runs = (this.__runs | 0) + 1;
                selfCleanRet = pkg.disposeReactive(this);
            },
        },
    ],
});

RUN.op = 8;
{
    const b = stats().activeNodes;
    const inst = new SelfCleanC();
    check(stats().activeNodes === b, () => "self-dispose clean: activeNodes " + stats().activeNodes + " != baseline " + b);
    check((inst.__runs | 0) === 1, () => "self-dispose clean: effect ran " + (inst.__runs | 0) + " times, expected 1");
    check(selfCleanRet === true, () => "self-dispose clean: disposeReactive returned " + selfCleanRet + " (expected true; D-2f guard must not fire)");
    check(pkg.disposeReactive(inst) === false, () => "self-dispose clean: instance was not already disposed");
}

// --- S2a: D-4d self-dispose, poison-touch variant -----------------------------
//
// A decorated-member touch AFTER self-dispose in the same run throws
// ReactiveDisposedError; it propagates out of the wiring effect through the
// wireInstance guard, and conservation is exact after teardown + rethrow.

const SelfPoisonC = buildClass({
    name: "SelfPoisonC",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "v", decorator: pkg.reactive, value: () => 0 },
        {
            kind: "method",
            key: "go",
            decorator: pkg.reactiveEffect,
            body: function () {
                this.__runs = (this.__runs | 0) + 1;
                pkg.disposeReactive(this);
                void this.v;                   // poison touch -> ReactiveDisposedError
            },
        },
    ],
});

RUN.op = 9;
{
    const b = stats().activeNodes;
    let caught = null;
    try { new SelfPoisonC(); } catch (e) { caught = e; }
    check(
        caught instanceof pkg.ReactiveDisposedError,
        () => "self-dispose poison: construction threw " + (caught && caught.name) + " expected ReactiveDisposedError",
    );
    check(stats().activeNodes === b, () => "self-dispose poison: activeNodes " + stats().activeNodes + " != baseline " + b);
}

// --- S2a: foreign-manual-call adds zero edges (A5) ----------------------------
//
// The public @reactiveEffect method untracks when called under tracking, so a
// manual call from inside a FOREIGN effect subscribes that effect to nothing:
// mutating the instance never re-runs the outer effect.

const ManualC = buildClass({
    name: "ManualC",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 0 },
        { kind: "method", key: "touch", decorator: pkg.reactiveEffect, body: function () { void this.x; } },
    ],
});

RUN.op = 10;
{
    const m = new ManualC();
    const gate = signalBox(0);
    let outerRuns = -1;
    const outer = effect(() => { outerRuns++; gate.get(); m.touch(); });
    check(outerRuns === 0, () => "foreign-manual-call: outer initial runs=" + outerRuns + " expected 0");

    m.x = 42;                                  // untracked read inside touch -> zero edges
    check(outerRuns === 0, () => "foreign-manual-call: outer re-ran (runs=" + outerRuns + ") -- the manual call added an edge");

    gate.set(1);                               // outer's REAL dep -> one re-run
    check(outerRuns === 1, () => "foreign-manual-call: outer did not re-run on its real dep (runs=" + outerRuns + ")");

    sigDispose(outer);
    sigDispose(gate);
    pkg.disposeReactive(m);
}

function throwsRDE(fn, RDE) {
    try { fn(); } catch (e) { return e instanceof RDE; }
    return false;
}

pass(NAME);
