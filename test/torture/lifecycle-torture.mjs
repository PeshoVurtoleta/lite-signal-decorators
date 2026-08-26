// test/torture/lifecycle-torture.mjs -- node --expose-gc test/torture/lifecycle-torture.mjs
//
// The instance lifecycle contract (decision 0002 D-2a/D-2c/D-2d):
//   - a wired instance has an anchor and rootOf(vm).kind === "effect";
//   - disposeReactive cascades EXACTLY once: totalDisposals moves by P+D+1
//     (anchor + owned deriveds + explicitly-disposed signal boxes), no more;
//   - a second disposeReactive is an idempotent no-op: it returns false and
//     moves no counter;
//   - DV-1 regression (0002 Q4): an instance CONSTRUCTED INSIDE a raw
//     lite-signal parent effect is detached, so it keeps firing its own
//     subscription after the parent re-runs -- the derived observes 2,4,6 then,
//     past the parent re-run, 10 (count driven 1,2,3 then 5);
//   - a `using` block disposes via Symbol.dispose;
//   - every post-dispose touch (get/set/boxOf/rootOf) throws
//     ReactiveDisposedError.
//
// TORTURE_BREAK=lifecycle-torture makes the double-dispose assertion expect
// `true`, so the control sweep proves that gate can fail.
//
// ASCII-only.

import { signalBox, effect, dispose as sigDispose, stats } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { makeClasses } from "../shared/mock-emitter.mjs";
import { RUN, check, breakActive, pass } from "./helpers/harness.mjs";

const NAME = "lifecycle-torture";
const { Counter, SYM } = makeClasses(pkg);
// Counter: P=3 signals (count, level, SYM) + D=2 deriveds (double, band) + 1
// anchor => P+D+1 = 6.
const PD1 = 6;

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
        () => "cascade disposed " + delta + " nodes, expected P+D+1=" + PD1,
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

    // BREAK sabotages exactly here: the second dispose is a no-op returning
    // false; the control expects true and therefore fails.
    const expected = breakActive(NAME) ? true : false;
    check(second === expected, () => "double dispose returned " + second + " expected " + expected);
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

function throwsRDE(fn, RDE) {
    try { fn(); } catch (e) { return e instanceof RDE; }
    return false;
}

pass(NAME);
