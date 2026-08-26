// test/torture/interop-torture.mjs -- node --expose-gc test/torture/interop-torture.mjs
//
// T5 (PLAN-S2b section 1 + P-2/P-3): decorated <-> raw lite-signal in ONE graph,
// cross-registry engine contracts surfaced UNCHANGED, and the two documented
// D-2f limits pinned as fail-open shapes so any future engine change that lets
// us close them is LOUD.
//
//   A. raw effect reads a DECORATED member through its boxOf handle -- mutating
//      the decorated member re-runs the raw effect.
//   B. a DECORATED @derived reads a RAW signalBox -- the derived recomputes when
//      the raw box changes and when a decorated member changes.
//   C. subscription interop -- boxOf(vm, k).subscribe fires immediately and on
//      every change until unsubscribed.
//   D. cross-registry contract (P-3), asserted RAW, never wrapped: a bound-
//      registry instance's boxOf handle read through DEFAULT-registry helpers
//      surfaces the engine's own contract -- nodeId() is undefined (foreign
//      identity) and a default-registry dispose() is a silent no-op (the box
//      stays live). BREAK routes the nodeId query through the OWNING registry
//      (softening the boundary); the pin must catch it.
//   E. registry.destroy() mid-life (P-3): an outstanding disposeReactive lands
//      on the engine's safe-no-op path, the JS-side poison swap STILL installs
//      (post-dispose touches throw ReactiveDisposedError), and a fresh registry
//      hosts new instances cleanly.
//   F. P-2 documented limits (assert the CURRENT fail-open shape):
//      (a) indirect self-dispose routed through an intermediate RAW computed is
//          NOT caught by D-2f -- the read returns undefined (silent drop), no
//          throw, the instance ends disposed, conservation exact;
//      (b) an untrack()-wrapped self-dispose bypasses the isTracking() gate --
//          same fail-open shape.
//
// TORTURE_BREAK=interop-torture: case D routes the cross-registry nodeId query
// through the owning registry, so the "default sees a foreign handle as
// undefined" pin observes a real id and fails.
//
// ASCII-only. MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

import {
    signalBox, computedBox, effect, dispose as sigDispose,
    createRegistry, nodeId, untrack,
} from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, settle, pass, conservationBaseline, assertConserved,
} from "./helpers/harness.mjs";

const NAME = "interop-torture";

function throwsRDE(fn) {
    try { fn(); } catch (e) { return e instanceof pkg.ReactiveDisposedError; }
    return false;
}

// A minimal decorated host on the DEFAULT registry.
const M = buildClass({
    name: "M",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 0 },
    ],
});

// A decorated derived that reads a module-level RAW signalBox (direction B).
let EXT = null;
const DerC = buildClass({
    name: "DerC",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 1 },
        {
            kind: "getter",
            key: "sum",
            decorator: pkg.derived,
            body: function () { return this.x + EXT.get(); },
        },
    ],
});

// Warm the default pools, then baseline conservation.
{
    const w = new M();
    pkg.disposeReactive(w);
}
const base = conservationBaseline();

// --- A: raw effect reads a decorated member -----------------------------------

RUN.op = 0;
{
    const c = new M();
    const box = pkg.boxOf(c, "x");
    let runs = -1;
    let last = null;
    const e = effect(() => { runs++; last = box.get(); });
    check(runs === 0 && last === 0, () => "A: initial runs=" + runs + " last=" + last);

    c.x = 7;                                    // decorated write -> raw effect re-runs
    check(runs === 1, () => "A: raw effect did not re-run on decorated write (runs=" + runs + ")");
    check(last === 7, () => "A: raw effect read stale decorated value (last=" + last + ")");

    sigDispose(e);
    pkg.disposeReactive(c);
}

// --- B: decorated derived reads a raw box -------------------------------------

RUN.op = 1;
{
    EXT = signalBox(10);
    const c = new DerC();
    check(c.sum === 11, () => "B: initial sum=" + c.sum + " expected 11");

    EXT.set(20);                                // raw change -> derived recomputes
    check(c.sum === 21, () => "B: sum after raw change=" + c.sum + " expected 21");

    c.x = 5;                                    // decorated change -> derived recomputes
    check(c.sum === 25, () => "B: sum after decorated change=" + c.sum + " expected 25");

    pkg.disposeReactive(c);
    sigDispose(EXT);
    EXT = null;
}

// --- C: subscription interop through boxOf handles ----------------------------

RUN.op = 2;
{
    const c = new M();
    const seen = [];
    const unsub = pkg.boxOf(c, "x").subscribe((v) => { seen.push(v); });
    check(seen.length === 1 && seen[0] === 0, () => "C: subscribe did not fire immediately (seen=" + seen.join(",") + ")");

    c.x = 3;
    c.x = 8;
    check(seen.length === 3 && seen[2] === 8, () => "C: subscription missed updates (seen=" + seen.join(",") + ")");

    unsub();
    c.x = 9;                                    // no further delivery after unsub
    check(seen.length === 3, () => "C: subscription fired after unsub (seen=" + seen.join(",") + ")");

    pkg.disposeReactive(c);
}

// --- D: cross-registry contract, surfaced RAW (BREAK point) --------------------

RUN.op = 3;
{
    const regB = createRegistry();
    const BoundC = buildClass({
        name: "BoundC",
        classDecorator: pkg.reactiveHost({ registry: regB }),
        members: [{ kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 5 }],
    });
    const c = new BoundC();
    const box = pkg.boxOf(c, "x");

    // Pin 1: the DEFAULT registry sees a foreign (bound) handle as undefined.
    // BREAK routes the query through the OWNING registry, which returns a real
    // id -- softening away the cross-registry boundary the pin exists to prove.
    const observed = breakActive(NAME) ? regB.nodeId(box) : nodeId(box);
    check(
        observed === undefined,
        () => "D: cross-registry nodeId leaked a foreign identity (observed=" + observed +
            ") -- the default registry must see a bound handle as undefined",
    );

    // Pin 2: a DEFAULT-registry dispose of a bound handle is a silent no-op --
    // the box stays live (asserted via set/read), unchanged and unwrapped.
    sigDispose(box);                            // cross-registry: no-op
    box.set(99);
    check(c.x === 99, () => "D: default-registry dispose was not a no-op (c.x=" + c.x + " expected 99)");

    pkg.disposeReactive(c);                     // proper teardown on the owning registry
    regB.destroy();
}

// --- E: registry.destroy() mid-life -------------------------------------------

RUN.op = 4;
{
    const regD = createRegistry();
    const DC = buildClass({
        name: "DC",
        classDecorator: pkg.reactiveHost({ registry: regD }),
        members: [
            { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 1 },
            { kind: "getter", key: "d", decorator: pkg.derived, body: function () { return this.x + 1; } },
        ],
    });
    const vm = new DC();
    check(vm.x === 1 && vm.d === 2, () => "E: pre-destroy vm.x=" + vm.x + " vm.d=" + vm.d);

    regD.destroy();                             // reset mid-life

    // disposeReactive lands on the engine's safe-no-op path but the JS-side
    // poison swap still installs.
    let moved = null;
    let derr = null;
    try { moved = pkg.disposeReactive(vm); } catch (e) { derr = e; }
    check(derr === null, () => "E: disposeReactive after destroy threw " + (derr && derr.name));
    check(moved === true, () => "E: disposeReactive after destroy returned " + moved);
    check(throwsRDE(() => vm.x), () => "E: post-destroy-dispose vm.x did not throw ReactiveDisposedError");
    check(throwsRDE(() => vm.d), () => "E: post-destroy-dispose vm.d did not throw ReactiveDisposedError");

    // A fresh registry hosts new instances cleanly.
    const regC = createRegistry();
    const FreshC = buildClass({
        name: "FreshC",
        classDecorator: pkg.reactiveHost({ registry: regC }),
        members: [{ kind: "accessor", key: "y", decorator: pkg.reactive, value: () => 2 }],
    });
    const f = new FreshC();
    check(f.y === 2, () => "E: fresh instance y=" + f.y + " expected 2");
    f.y = 9;
    check(f.y === 9, () => "E: fresh instance write y=" + f.y + " expected 9");
    check(pkg.disposeReactive(f) === true, () => "E: fresh dispose did not move");
    check(pkg.disposeReactive(f) === false, () => "E: fresh double-dispose was not idempotent");
    regC.destroy();
}

// --- F(a): indirect self-dispose via an intermediate RAW computed -------------
//
// D-2f's getOwner() sees only the innermost computation -- here the RAW computed,
// whose id is not one of our deriveds -- so the guard does NOT fire. The engine
// then cascades the decorated derived being computed and silently drops the
// value. DOCUMENTED LIMIT: pinned as the current fail-open shape.

let RAWC = null;
const IndC = buildClass({
    name: "IndC",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 0 },
        {
            kind: "getter",
            key: "d",
            decorator: pkg.derived,
            body: function () { return RAWC !== null ? RAWC.get() : this.x; },
        },
    ],
});

RUN.op = 5;
{
    const iv = new IndC();
    RAWC = computedBox(function () { pkg.disposeReactive(iv); return 0; });

    let read;
    let threw = null;
    try { read = iv.d; } catch (e) { threw = e; }
    check(threw === null, () => "F(a): indirect self-dispose THREW (" + (threw && threw.name) +
        ") -- the documented limit changed; D-2f may now catch it (update decisions/0002)");
    check(read === undefined, () => "F(a): read=" + read + " expected undefined (silent drop shape changed)");
    check(pkg.disposeReactive(iv) === false, () => "F(a): instance was not left disposed by the indirect path");

    sigDispose(RAWC);
    RAWC = null;
}

// --- F(b): untrack()-wrapped self-dispose bypasses the isTracking() gate -------
//
// untrack() makes isTracking() false for the duration, so D-2f's gate never
// engages. Same fail-open shape. DOCUMENTED LIMIT.

const UnC = buildClass({
    name: "UnC",
    classDecorator: pkg.reactiveHost,
    members: [
        { kind: "accessor", key: "x", decorator: pkg.reactive, value: () => 0 },
        {
            kind: "getter",
            key: "d2",
            decorator: pkg.derived,
            body: function () { untrack(() => pkg.disposeReactive(this)); return 42; },
        },
    ],
});

RUN.op = 6;
{
    const uv = new UnC();
    let read;
    let threw = null;
    try { read = uv.d2; } catch (e) { threw = e; }
    check(threw === null, () => "F(b): untrack-wrapped self-dispose THREW (" + (threw && threw.name) +
        ") -- the documented limit changed; the untrack gate may now be closed (update decisions/0002)");
    check(read === undefined, () => "F(b): read=" + read + " expected undefined (silent drop shape changed)");
    check(pkg.disposeReactive(uv) === false, () => "F(b): instance was not left disposed by the untrack path");
}

await settle();
RUN.op = -1;
assertConserved(base, "interop teardown");

pass(NAME);
