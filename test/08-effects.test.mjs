// test/08-effects.test.mjs -- the @reactiveEffect + @batched contract (S2a).
// Runs the counted effect contract (S2a-A1 wire timing, S2a-A2 dispose-stop,
// D-04 manual-call untracking) over ALL THREE build paths -- the mock emitter
// and both compiled fixture emits -- then the emit-agnostic structural cases
// once through the mock: the S2a-A1 inheritance matrix, scheduler pass-through,
// the D-4d self-dispose semantics (clean self-dispose allowed; post-dispose
// member touch throws ReactiveDisposedError; the D-2f derived guard does NOT
// fire from an effect), the stacked-decorator duplicate-key rejection, the
// missing-host manual method call, and S2a-A4 registry isolation (both ways).
//
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
    stats,
    createRegistry,
    effect as liteEffect,
    dispose as liteDispose,
} from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import * as tsClasses from "./fixtures/ts-out/fixture.src.js";
import * as babelClasses from "./fixtures/babel-out/fixture.src.js";
import {
    makeClasses,
    buildClass,
    makeClassContext,
} from "./shared/mock-emitter.mjs";

const { reactive, derived, reactiveHost, reactiveEffect, batched, boxOf, disposeReactive, ReactiveDisposedError } = pkg;

function active() {
    return stats().activeNodes;
}

function drainPending() {
    try {
        reactiveHost(class Drain {}, makeClassContext("Drain"));
    } catch (_) {
        // orphan records were present; the buffer is now empty.
    }
}

// --- The counted effect contract, run over each build path --------------------

function runEffectContract(t, classes, label) {
    const { Counter, Derived, effectFires } = classes;

    t.test(label + ": S2a-A1 effect fires exactly once at leaf wiring (counted)", () => {
        let base = effectFires.counter;
        const c = new Counter();
        assert.equal(effectFires.counter - base, 1, "onCount fired once, and only at wire");
        disposeReactive(c);

        // Inheritance: the leaf-wired effect fires once after the whole chain.
        base = effectFires.derived;
        const d = new Derived();
        assert.equal(effectFires.derived - base, 1, "onDb fired once across the chain");
        disposeReactive(d);
    });

    t.test(label + ": S2a-A2 post-dispose write via a captured box fires zero effects", () => {
        const c = new Counter();
        const box = boxOf(c, "count");        // captured while still live
        disposeReactive(c);
        const base = effectFires.counter;
        try { box.set(42); } catch (_) { /* disposed slot: irrelevant to the count */ }
        assert.equal(effectFires.counter - base, 0, "no effect executions after dispose");
    });

    t.test(label + ": D-04 a manual call inside a foreign effect adds zero edges", () => {
        const c = new Counter();
        let foreignRuns = 0;
        // The foreign effect calls the GUARDED public method; its count read must
        // be untracked, so the foreign effect never adopts count as a dependency.
        const stop = liteEffect(() => { foreignRuns++; c.onCount(); });
        const afterFirst = foreignRuns;
        c.count = c.count + 1;                 // c's own auto-effect re-runs; foreign must not
        assert.equal(foreignRuns - afterFirst, 0, "foreign effect did not adopt the count read");
        liteDispose(stop);
        disposeReactive(c);
    });
}

test("effect contract over the mock-built family", (t) => {
    drainPending();
    runEffectContract(t, makeClasses(pkg), "mock");
});

test("effect contract over the TS standard emit", (t) => {
    runEffectContract(t, tsClasses, "ts");
});

test("effect contract over the Babel 2023-11 emit", (t) => {
    runEffectContract(t, babelClasses, "babel");
});

// --- S2a-A1 inheritance matrix: base effect fires after the leaf's last field -

test("S2a-A1 matrix: a base effect never fires before a subclass field initializer", () => {
    drainPending();
    const rec = { fires: 0, seen: null };
    const GA = buildClass({
        name: "GA",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "g", decorator: reactive, value: () => 1 },
            {
                kind: "method",
                key: "probe",
                decorator: reactiveEffect,
                // Reads a plain field declared on the SUBCLASS; if the effect
                // fired before the leaf's field init, leafField would be undefined.
                body: function () { rec.fires++; rec.seen = this.g + (this.leafField || 0); },
            },
        ],
    });
    const GB = buildClass({
        name: "GB",
        superClass: GA,
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "h", decorator: reactive, value: () => 2 },
            { kind: "field", key: "leafField", value: () => 100 },
        ],
    });
    const b = new GB();
    assert.equal(rec.fires, 1, "the effect fired exactly once, at leaf wiring");
    assert.equal(rec.seen, 101, "the effect saw g=1 AND the fully-initialized leaf field=100");
    disposeReactive(b);

    // Also the single-class case: effect reads a field declared AFTER it.
    drainPending();
    const r2 = { fires: 0, seen: null };
    const P = buildClass({
        name: "LateField",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            {
                kind: "method",
                key: "probe",
                decorator: reactiveEffect,
                body: function () { r2.fires++; r2.seen = this.tail; },
            },
            { kind: "field", key: "tail", value: function () { return this.a + 41; } },
        ],
    });
    const p = new P();
    assert.equal(r2.fires, 1);
    assert.equal(r2.seen, 42, "the effect saw the field initialized after it in source order");
    disposeReactive(p);
});

// --- D-4c scheduler pass-through ----------------------------------------------

test("scheduler pass-through: a capturing scheduler receives the flush thunk", () => {
    drainPending();
    const captured = [];
    let fires = 0;
    const C = buildClass({
        name: "Scheduled",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 0 },
            {
                kind: "method",
                key: "eff",
                decorator: reactiveEffect({ scheduler: (run) => { captured.push(run); } }),
                body: function () { fires++; void this.v; },
            },
        ],
    });
    const c = new C();
    // With a scheduler, the first run is deferred THROUGH the trampoline.
    assert.equal(captured.length, 1, "scheduler received exactly one flush thunk");
    assert.equal(typeof captured[0], "function", "the thunk is callable");
    assert.equal(fires, 0, "deferred: the effect body has not run yet");
    captured[0]();
    assert.equal(fires, 1, "running the thunk fires the effect body once");
    disposeReactive(c);
});

// --- D-4d self-dispose semantics ----------------------------------------------

test("D-4d: a clean self-dispose from inside an owned effect is allowed (fire counts + conservation)", () => {
    drainPending();
    const log = { fires: 0, ret: null };
    const C = buildClass({
        name: "CleanSelfDispose",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 1 },
            {
                kind: "method",
                key: "selfKill",
                decorator: reactiveEffect,
                body: function () {
                    log.fires++;
                    void this.v;                  // track v (isTracking() true here)
                    // Clean return after the dispose: no further member touch.
                    log.ret = disposeReactive(this);
                },
            },
        ],
    });
    const baseline = active();
    const c = new C();
    assert.equal(log.fires, 1, "the effect ran once then self-disposed cleanly");
    assert.equal(log.ret, true, "self-dispose returned true (NOT the D-2f derived-guard throw)");
    assert.equal(active(), baseline, "conservation exact after the self-dispose");
});

test("D-4d: a post-dispose member touch inside the same run throws ReactiveDisposedError", () => {
    drainPending();
    const log = { fires: 0 };
    const C = buildClass({
        name: "SelfDisposeThenTouch",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 1 },
            {
                kind: "method",
                key: "selfKill",
                decorator: reactiveEffect,
                body: function () {
                    log.fires++;
                    void this.v;
                    disposeReactive(this);
                    void this.v;                  // poison: must throw ReactiveDisposedError
                },
            },
        ],
    });
    const baseline = active();
    assert.throws(
        () => new C(),
        (e) => e instanceof ReactiveDisposedError,
        "the post-dispose touch propagates as ReactiveDisposedError",
    );
    assert.equal(active(), baseline, "conservation exact despite the throwing first run");
});

// --- Stacked-decorator rejection (PD-13) --------------------------------------

test("stacking @batched + @reactiveEffect on one key -> duplicate-key throw naming stacking", () => {
    drainPending();
    // Faithful to `@batched @reactiveEffect act() {}`: reactiveEffect applies
    // first (innermost), batched wraps its result -- both register key "act" in
    // one class, which PD-13 says must surface as the duplicate-key throw.
    const stacked = function (body, ctx) { return batched(reactiveEffect(body, ctx), ctx); };
    assert.throws(
        () => buildClass({
            name: "Stacked",
            classDecorator: reactiveHost,
            members: [
                { kind: "method", key: "act", decorator: stacked, body: function () {} },
            ],
        }),
        (e) => /declared twice/.test(e.message) && /stack/i.test(e.message),
    );
    drainPending();
});

// --- Missing-host manual method call ------------------------------------------

test("missing-host: calling a decorated method with no @reactiveHost throws named", () => {
    drainPending();
    const NoHost = buildClass({
        name: "NoHostMethod",
        members: [
            { kind: "method", key: "m", decorator: reactiveEffect, body: function () {} },
        ],
    });
    // The guarded public method fails closed when its rec was never hosted.
    assert.throws(
        () => NoHost.prototype.m.call({}),
        (e) => /without a @reactiveHost/.test(e.message),
    );
    drainPending();   // absorb the un-hosted method rec left in PENDING
});

// --- S2a-A4 registry isolation, both directions -------------------------------

test("S2a-A4: a custom-registry host leaves the default registry stats delta at zero", () => {
    drainPending();
    const reg = createRegistry({ maxNodes: 64 });
    const C = buildClass({
        name: "Isolated",
        classDecorator: reactiveHost({ registry: reg }),
        members: [
            { kind: "accessor", key: "v", decorator: reactive, value: () => 1 },
            { kind: "getter", key: "d", decorator: derived, body: function () { return this.v + 1; } },
            { kind: "method", key: "eff", decorator: reactiveEffect, body: function () { void this.d; } },
        ],
    });

    const defBefore = active();
    const regBefore = reg.stats().activeNodes;
    const c = new C();
    assert.equal(active() - defBefore, 0, "default registry untouched by the custom-registry instance");
    assert.ok(reg.stats().activeNodes - regBefore > 0, "custom registry actually allocated the graph");
    c.v = 5;
    assert.equal(active() - defBefore, 0, "default still untouched after a mutation");
    disposeReactive(c);
    assert.equal(reg.stats().activeNodes - regBefore, 0, "custom registry back to its baseline");
    assert.equal(active() - defBefore, 0, "default never moved");
});

test("S2a-A4 vice versa: a default-registry host leaves a custom registry stats delta at zero", () => {
    drainPending();
    const reg = createRegistry({ maxNodes: 64 });
    const { Counter } = makeClasses(pkg);          // default-registry hosted

    const regBefore = reg.stats().activeNodes;
    const defBefore = active();
    const c = new Counter();
    assert.ok(active() - defBefore > 0, "default registry allocated the graph");
    assert.equal(reg.stats().activeNodes - regBefore, 0, "custom registry frozen while the default churns");
    c.count = 7;
    assert.equal(reg.stats().activeNodes - regBefore, 0, "custom registry still frozen after a mutation");
    disposeReactive(c);
    assert.equal(reg.stats().activeNodes - regBefore, 0, "custom registry never moved");
});
