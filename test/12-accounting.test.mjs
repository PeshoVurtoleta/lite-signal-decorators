// test/12-accounting.test.mjs -- costOf + capacityFor (S4 T6, PD-21/PD-22).
//
// Pins the cost-accounting surface against decisions/0007 (capacity policy) and
// the 0002 Q3 cost grid: costOf reproduces the Q3 node counts (1/2/15/29),
// reports the first-full-read link count 0007 measured, is deterministic
// (double-probe identical, frozen + cached by identity), and fails CLOSED on an
// inconclusive/polluted probe or a non-factory. capacityFor sizes an exact
// node/link budget, scales links by headroom, validates its inventory
// fail-closed, and its output holds its stated inventory to the last instance --
// the (k+1)-th throws CapacityError by name (0007's round-trip contract at test
// scale).
//
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRegistry } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import { buildClass } from "./shared/mock-emitter.mjs";

const { reactive, derived, reactiveEffect, reactiveHost, defineReactive, disposeReactive, costOf, capacityFor } = pkg;

// --- shape builders -----------------------------------------------------------

// A (P,D,E) shape where every derived and every effect reads s0 (one source
// each): nodes = P+D+E+1, links = D+E (each reader forms exactly one link).
function decShape(id, P, D, E, reg) {
    const members = [];
    for (let i = 0; i < P; i++) {
        members.push({
            kind: "accessor",
            key: "s" + i,
            decorator: reactive,
            value: (function (v) { return function () { return v; }; })(i),
        });
    }
    for (let i = 0; i < D; i++) {
        members.push({ kind: "getter", key: "d" + i, decorator: derived, body: function () { return this.s0 + 1; } });
    }
    for (let i = 0; i < E; i++) {
        members.push({ kind: "method", key: "e" + i, decorator: reactiveEffect, body: function () { void this.s0; } });
    }
    const host = reg ? reactiveHost({ registry: reg }) : reactiveHost;
    return buildClass({ name: "Acc" + id, classDecorator: host, members });
}

function buildlessShape(id, P, D, E, reg) {
    const signals = {};
    const deriveds = {};
    const effects = {};
    for (let i = 0; i < P; i++) signals["s" + i] = i;
    for (let i = 0; i < D; i++) deriveds["d" + i] = function () { return this.s0 + 1; };
    for (let i = 0; i < E; i++) effects["e" + i] = function () { void this.s0; };
    const spec = { signals, deriveds, effects };
    if (reg) spec.host = { registry: reg };
    return defineReactive({ ["BL" + id]: class {} }["BL" + id], spec);
}

// --- Q3 fixture regression: nodes 1 / 2 / 15 / 29 -----------------------------

test("costOf: Q3 node grid 1/2/15/29 for (P,D,E) = (0,0,0)/(1,0,0)/(8,4,2)/(16,8,4) (mock emit)", () => {
    const grid = [[0, 0, 0, 1], [1, 0, 0, 2], [8, 4, 2, 15], [16, 8, 4, 29]];
    for (const [P, D, E, nodes] of grid) {
        const C = decShape("Q" + P + "_" + D + "_" + E, P, D, E);
        const cost = costOf(C);
        assert.equal(cost.nodes, nodes, `(${P},${D},${E}) nodes = P+D+E+1 = ${nodes}`);
        assert.equal(cost.signals, P, "signals field");
        assert.equal(cost.deriveds, D, "deriveds field");
        assert.equal(cost.effects, E, "effects field");
        // each derived + each effect reads s0 once => D+E first-full-read links
        assert.equal(cost.links, D + E, `(${P},${D},${E}) links = D+E first-full-read`);
    }
});

test("costOf: defineReactive twin matches the mock-emit cost (parity, shape (8,4,2))", () => {
    const dec = costOf(decShape("ParityDec", 8, 4, 2));
    const bl = costOf(buildlessShape("ParityBL", 8, 4, 2));
    assert.equal(bl.nodes, 15, "buildless nodes = 15");
    assert.deepEqual(
        { nodes: bl.nodes, links: bl.links, signals: bl.signals, deriveds: bl.deriveds, effects: bl.effects },
        { nodes: dec.nodes, links: dec.links, signals: dec.signals, deriveds: dec.deriveds, effects: dec.effects },
        "buildless twin cost is identical to the decorated shape",
    );
});

// --- determinism: frozen, cached by identity, integer fields ------------------

test("costOf: deterministic -- same frozen cached object by identity, all fields integer", () => {
    const C = decShape("Det", 3, 2, 1);
    const first = costOf(C);
    const second = costOf(C);
    assert.equal(first, second, "repeat call returns the SAME cached object (identity)");
    assert.ok(Object.isFrozen(first), "the result is frozen");
    for (const k of ["nodes", "links", "signals", "deriveds", "effects"]) {
        assert.ok(Object.prototype.hasOwnProperty.call(first, k), `field ${k} present`);
        assert.ok(Number.isInteger(first[k]), `field ${k} is an integer`);
    }
});

// --- links = first-full-read count (0007 probe table) -------------------------

test("costOf: links are the first-full-read count -- chain 3, fan 9, diamond 4 (0007)", () => {
    // chain: d0 reads a (1); d1 reads d0 + b (2) => 3 links (0007 chain probe).
    const Chain = buildClass({ name: "Chain", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "b", decorator: reactive, value: () => 2 },
        { kind: "getter", key: "d0", decorator: derived, body: function () { return this.a; } },
        { kind: "getter", key: "d1", decorator: derived, body: function () { return this.d0 + this.b; } },
    ] });
    assert.equal(costOf(Chain).links, 3, "chain first-full-read links = 1 + 2 = 3");

    // fan: s2=a+b (2), s3=a+b+c (3), all=a+b+c+d (4) => 9 links (0007 row 1).
    const Fan = buildClass({ name: "Fan", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "b", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "c", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "d", decorator: reactive, value: () => 1 },
        { kind: "getter", key: "s2", decorator: derived, body: function () { return this.a + this.b; } },
        { kind: "getter", key: "s3", decorator: derived, body: function () { return this.a + this.b + this.c; } },
        { kind: "getter", key: "all", decorator: derived, body: function () { return this.a + this.b + this.c + this.d; } },
    ] });
    assert.equal(costOf(Fan).links, 9, "fan first-full-read links = 2 + 3 + 4 = 9 (0007)");

    // diamond: l=a (1), r=a (1), top=l+r (2) => 4 links (0007 row 2); reading the
    // top forces l and r transitively -- the whole settled set is captured.
    const Diamond = buildClass({ name: "Diamond", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "getter", key: "l", decorator: derived, body: function () { return this.a; } },
        { kind: "getter", key: "r", decorator: derived, body: function () { return this.a; } },
        { kind: "getter", key: "top", decorator: derived, body: function () { return this.l + this.r; } },
    ] });
    assert.equal(costOf(Diamond).links, 4, "diamond first-full-read links = 1 + 1 + 2 = 4 (0007)");
});

// --- fail-closed: inconclusive / polluted / non-factory -----------------------

test("costOf: a data-dependent (branchy) derived read is inconclusive -- THROWS, never guesses", () => {
    // Call-count branch: the derived reads a DIFFERENT member set on each call,
    // so the two probes disagree and costOf must fail closed.
    let calls = 0;
    const Branchy = buildClass({ name: "Branchy", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "b", decorator: reactive, value: () => 1 },
        {
            kind: "getter",
            key: "d",
            decorator: derived,
            body: function () { calls++; return (calls % 2 === 0) ? this.a : this.a + this.b; },
        },
    ] });
    assert.throws(
        () => costOf(Branchy),
        (e) => e instanceof Error && /inconclusive/.test(e.message),
        "an inconclusive probe throws instead of returning a guessed cost",
    );
});

test("costOf: a non-factory throws named -- plain object (TypeError) and unwired function (no-plan)", () => {
    assert.throws(
        () => costOf({}),
        (e) => e instanceof TypeError && /must be a @reactiveHost \/ defineReactive wrapper class/.test(e.message),
        "a plain object is not a factory",
    );
    assert.throws(
        () => costOf(function plain() {}),
        (e) => e instanceof Error && /no reactive plan/.test(e.message),
        "a function with no wiring has no plan",
    );
    assert.throws(
        () => costOf(42),
        (e) => e instanceof TypeError,
        "a primitive is not a factory",
    );
});

test("costOf: on a class whose registry was destroyed it re-probes and surfaces the shape cost", () => {
    // The engine's registry.destroy() leaves the registry reusable, so costOf's
    // fresh construct/dispose probe succeeds and returns the deterministic cost
    // (this is the raw engine contract, pinned -- not softened, not guessed).
    const reg = createRegistry({ maxNodes: 64 });
    const C = decShape("Destroyed", 2, 2, 0, reg);   // nodes 5, links 2
    reg.destroy();
    const cost = costOf(C);
    assert.ok(Object.isFrozen(cost), "result frozen");
    assert.equal(cost.nodes, 5, "re-probe returns P+D+E+1 = 5");
    assert.equal(cost.links, 2, "re-probe returns the first-full-read links");
});

// --- capacityFor: config shape + math -----------------------------------------

test("capacityFor: config shape is { maxNodes, maxLinks, prealloc: eager, onCapacityExceeded: throw }", () => {
    const Chain = buildClass({ name: "CapChain", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "getter", key: "d", decorator: derived, body: function () { return this.a; } },
    ] });
    const cfg = capacityFor([[Chain, 1]]);
    assert.deepEqual(Object.keys(cfg).sort(), ["maxLinks", "maxNodes", "onCapacityExceeded", "prealloc"]);
    assert.equal(cfg.prealloc, "eager");
    assert.equal(cfg.onCapacityExceeded, "throw");
    assert.equal(cfg.maxNodes, 3, "P+D+1 = 3");
    assert.equal(cfg.maxLinks, 1, "one first-read link");
});

test("capacityFor: nodes/links exact for a mixed inventory; headroom scales links only", () => {
    const Fan = buildClass({ name: "MixFan", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "b", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "c", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "d", decorator: reactive, value: () => 1 },
        { kind: "getter", key: "s2", decorator: derived, body: function () { return this.a + this.b; } },
        { kind: "getter", key: "s3", decorator: derived, body: function () { return this.a + this.b + this.c; } },
        { kind: "getter", key: "all", decorator: derived, body: function () { return this.a + this.b + this.c + this.d; } },
    ] });                                                        // nodes 8, links 9
    const Chain = buildClass({ name: "MixChain", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "b", decorator: reactive, value: () => 2 },
        { kind: "getter", key: "d0", decorator: derived, body: function () { return this.a; } },
        { kind: "getter", key: "d1", decorator: derived, body: function () { return this.d0 + this.b; } },
    ] });                                                        // nodes 5, links 3

    const cfg = capacityFor([[Fan, 3], [Chain, 2]]);
    assert.equal(cfg.maxNodes, 8 * 3 + 5 * 2, "nodes = sum(cost.nodes x count) = 34");
    assert.equal(cfg.maxLinks, 9 * 3 + 3 * 2, "links = sum(cost.links x count) = 33");

    // headroom multiplies links (ceil), never nodes.
    const scaled = capacityFor([[Chain, 2]], { headroom: 2 });
    assert.equal(scaled.maxNodes, 10, "nodes unaffected by headroom");
    assert.equal(scaled.maxLinks, Math.ceil(3 * 2 * 2), "links x headroom = ceil(12) = 12");
});

test("capacityFor: fail-closed inventory validation (empty, zero/neg/fractional count, non-factory)", () => {
    const Chain = buildClass({ name: "ValChain", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "getter", key: "d", decorator: derived, body: function () { return this.a; } },
    ] });
    assert.throws(() => capacityFor([]), (e) => e instanceof TypeError && /non-empty array/.test(e.message), "empty inventory");
    assert.throws(() => capacityFor([[Chain, 0]]), (e) => e instanceof TypeError && /positive integer count/.test(e.message), "zero count");
    assert.throws(() => capacityFor([[Chain, -1]]), (e) => e instanceof TypeError && /positive integer count/.test(e.message), "negative count");
    assert.throws(() => capacityFor([[Chain, 1.5]]), (e) => e instanceof TypeError && /positive integer count/.test(e.message), "fractional count");
    assert.throws(() => capacityFor([[{}, 1]]), (e) => e instanceof TypeError && /wrapper class/.test(e.message), "non-factory entry");
    assert.throws(() => capacityFor([[Chain, 1]], { headroom: 0 }), (e) => e instanceof TypeError && /headroom/.test(e.message), "headroom < 1");
});

// --- round-trip at test scale: holds exactly k, (k+1)-th throws CapacityError -

test("capacityFor: round-trip -- createRegistry(capacityFor([[C, 10]])) hosts exactly 10, 11th throws, recycles", () => {
    function chain(id, reg) {
        return buildClass({ name: id, classDecorator: reactiveHost({ registry: reg }), members: [
            { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
            { kind: "accessor", key: "b", decorator: reactive, value: () => 2 },
            { kind: "getter", key: "d0", decorator: derived, body: function () { return this.a; } },
            { kind: "getter", key: "d1", decorator: derived, body: function () { return this.d0 + this.b; } },
        ] });
    }
    // cost is shape-determined: probe on a scratch registry, size a fresh one.
    const probeReg = createRegistry({ maxNodes: 64 });
    const cfg = capacityFor([[chain("RTProbe", probeReg), 10]]);   // nodes 50, links 30

    const reg = createRegistry(cfg);
    const C = chain("RTHost", reg);
    const held = [];
    for (let i = 0; i < 10; i++) {
        const c = new C();
        void c.d0;
        assert.equal(c.d1, 3, "all reads work on the hosted instance (d0=a=1, d1=d0+b=1+2=3)");
        held.push(c);
    }
    assert.equal(reg.stats().activeNodes, 50, "exactly 10 x 5 nodes provisioned");

    let over = null;
    try { new C(); } catch (e) { over = e; }
    assert.ok(over !== null, "the 11th construction throws");
    assert.equal(over.name, "CapacityError", "the 11th throws CapacityError by name");

    // recycle: free one, construct one -> succeeds.
    disposeReactive(held[0]);
    const revived = new C();
    assert.equal(revived.a, 1, "after freeing one, the identical construction succeeds (recycling)");
    disposeReactive(revived);
    for (let i = 1; i < held.length; i++) disposeReactive(held[i]);
});
