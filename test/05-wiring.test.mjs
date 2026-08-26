// test/05-wiring.test.mjs -- the wiring laws, driven through the mock emitter so
// arbitrary inheritance shapes can be assembled: declaration-order init (L2),
// the most-derived single-wiring rule down a three-deep decorated chain (L4),
// missing-host first-touch, double-host rejection, and ancestor-plan merge made
// observable via boxOf on inherited keys. Node deltas are P signals + D deriveds
// + 1 anchor (decisions/0002). ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import {
    buildClass,
    makeAccessorContext,
    makeClassContext,
} from "./shared/mock-emitter.mjs";

const { reactive, derived, reactiveHost, boxOf, rootOf, disposeReactive } = pkg;

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

test("L2 declaration-order: accessor init and field init read earlier members", () => {
    drainPending();
    const C = buildClass({
        name: "Ordered",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "x", decorator: reactive, value: () => 1 },
            // accessor init reads the earlier accessor's live box (L2).
            { kind: "accessor", key: "y", decorator: reactive, value: function () { return this.x + 1; } },
            // plain field reads the earlier accessor.
            { kind: "field", key: "z", value: function () { return this.y + 1; } },
        ],
    });
    const c = new C();
    assert.equal(c.x, 1);
    assert.equal(c.y, 2);
    assert.equal(c.z, 3);
    disposeReactive(c);
});

test("L4 three-deep decorated chain wires exactly once at the deepest host", () => {
    drainPending();
    const A = buildClass({
        name: "A3",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "a", decorator: reactive, value: () => 1 }],
    });
    const B = buildClass({
        name: "B3",
        superClass: A,
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "b", decorator: reactive, value: () => 2 }],
    });
    const C = buildClass({
        name: "C3",
        superClass: B,
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "c", decorator: reactive, value: () => 3 },
            { kind: "getter", key: "sum", decorator: derived, body: function () { return this.a + this.b + this.c; } },
        ],
    });

    const before = active();
    const g = new C();
    // Merged plan: P=3 (a,b,c) + D=1 (sum) + 1 anchor = 5. A single anchor --
    // NOT 3 anchors -- proves the intermediate hosts skipped wiring.
    assert.equal(active() - before, 5, "single-anchor delta for the 3-deep chain");
    assert.equal(g.a, 1);
    assert.equal(g.b, 2);
    assert.equal(g.c, 3);
    assert.equal(g.sum, 6);
    assert.ok(g instanceof A && g instanceof B);
    // Exactly one anchor descriptor.
    assert.equal(rootOf(g).kind, "effect");
    disposeReactive(g);
    // Disposing the single anchor returns everything to baseline.
    assert.equal(active(), before);
});

test("ancestor plan merge: inherited keys reachable through boxOf", () => {
    drainPending();
    const Base = buildClass({
        name: "MergeBase",
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "base", decorator: reactive, value: () => 10 }],
    });
    const Sub = buildClass({
        name: "MergeSub",
        superClass: Base,
        classDecorator: reactiveHost,
        members: [{ kind: "accessor", key: "own", decorator: reactive, value: () => 20 }],
    });
    const s = new Sub();
    assert.equal(boxOf(s, "base").peek(), 10, "inherited key");
    assert.equal(boxOf(s, "own").peek(), 20, "own key");
    disposeReactive(s);
});

test("missing-host first-touch throws named at first construction", () => {
    drainPending();
    const NoHost = buildClass({
        name: "NoHostWiring",
        members: [{ kind: "accessor", key: "v", decorator: reactive, value: () => 0 }],
    });
    assert.throws(
        () => new NoHost(),
        (e) => /without a @reactiveHost/.test(e.message),
    );
    drainPending();
});

test("double-host is rejected", () => {
    drainPending();
    const Once = reactiveHost(class Host {}, makeClassContext("Host"));
    assert.throws(
        () => reactiveHost(Once, makeClassContext("Host")),
        (e) => /already has a @reactiveHost wrapper/.test(e.message),
    );
});
