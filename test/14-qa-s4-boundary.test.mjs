// test/14-qa-s4-boundary.test.mjs -- independent QA adversarial boundary
// coverage for S4 (PLAN-S4.md section 10 / DONE-WHEN A1..A5), authored AFTER
// reviewer APPROVED (one REJECTED cycle -- the recorded 0008 amendment: an
// 11-method duck-valid registry facade WITHOUT stats() used to leak a raw
// TypeError out of costOf; that closure is pinned here first). This file's
// job is the S4 surface edges 12-accounting/13-labels-audit did not exercise:
// the stats-less facade closure on BOTH costOf and capacityFor; the
// signals-only degenerate capacityFor config (maxLinks floored to 1);
// headroom's full boundary set (0, negative, NaN, Infinity, -0, fractional
// accept); capacityFor's inventory/options malformed shapes (non-array
// inventory, malformed pairs, the call-form options-shape error naming what
// was received, an ARRAY options rejected by name, `null` preserved as
// "omitted"); duplicate-factory summation; costOf/
// capacityFor parity on the defineReactive twin; labelOf misses on foreign
// handles, never-registered numeric ids, and the boundary-matrix value set
// (0/-0/NaN/null/undefined) while ON; enableLabels/auditReactive double-
// enable and double-disable idempotency, including the audit-only (labels
// OFF) INTROSPECT_ON OR-gate; costOf cache identity surviving enableLabels/
// auditReactive flips; the audit-ON disposed-then-dropped no-report proof
// (fixture reuse) with an added clean-process/exit-code check; and two
// adversarial cases the planner did not enumerate: costOf called RE-ENTRANTLY
// from inside an active effect on the SAME registry must not pollute the
// caller's dependency tracking, and disposing an instance from WITHIN its own
// forEachOwned walk (labels ON) must not corrupt a SIBLING instance's label
// entries.
//
// Every claim below was measured against the real module before being
// pinned -- see the QA report for anything that surfaced as a FINDING rather
// than a clean PASS.
//
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRegistry } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import { buildClass } from "./shared/mock-emitter.mjs";

const {
    reactive, derived, reactiveEffect, reactiveHost, defineReactive,
    disposeReactive, costOf, capacityFor, labelOf, enableLabels, auditReactive,
    rootOf, boxOf,
} = pkg;

const REG_METHODS = [
    "signalBox", "computedBox", "effect", "createRoot", "getOwner",
    "runWithOwner", "dispose", "nodeId", "isTracking", "batch", "untrack",
];

// A 11-method duck-valid facade bound to a REAL registry, deliberately missing
// `stats` (stats is NOT in REG_METHODS -- the wiring/dispose duck-check never
// needed it; costOf/capacityFor do).
function statslessFacade() {
    const real = createRegistry({ maxNodes: 64 });
    const facade = {};
    for (const m of REG_METHODS) facade[m] = real[m].bind(real);
    return facade;
}

// === Cluster A: the review-finding closure (D-8a amendment) ===================

test("QA-A1: an 11-method duck-valid registry facade WITHOUT stats() -- costOf throws the named ERR-prefixed TypeError naming the ledger", () => {
    const facade = statslessFacade();
    const W = defineReactive(class NoStatsCost {}, {
        signals: { x: 1 },
        deriveds: { d: (self) => self.x },
        host: { registry: facade },
    });
    const w = new W();
    assert.equal(w.x, 1, "the class wires and runs fine on the facade -- only costOf needs stats()");
    assert.throws(
        () => costOf(W),
        (e) =>
            e instanceof TypeError &&
            e.message.startsWith("@zakkster/lite-signal-decorators: ") &&
            /stats\(\) ledger/.test(e.message) &&
            /createRegistry\(\) registry/.test(e.message),
        "named, ERR-prefixed, and names the stats() ledger with the fix",
    );
    disposeReactive(w);
});

test("QA-A2: capacityFor([[W, 2]]) surfaces the SAME named error through its costOf call, unwrapped", () => {
    const facade = statslessFacade();
    const W = defineReactive(class NoStatsCap {}, { signals: { x: 1 }, host: { registry: facade } });
    let costErr = null;
    try { costOf(W); } catch (e) { costErr = e; }
    assert.ok(costErr !== null, "precondition: costOf itself throws");
    assert.throws(
        () => capacityFor([[W, 2]]),
        (e) => e instanceof TypeError && e.message === costErr.message,
        "capacityFor's thrown message is IDENTICAL to costOf's -- not a rewrap, not a generic capacityFor error",
    );
});

// === Cluster B: signals-only degenerate case (0007 link floor) ================

test("QA-B1: a signals-only inventory -- costOf.links === 0, capacityFor floors maxLinks to 1, config constructs and hosts N", () => {
    const S = defineReactive(class SignalsOnly {}, { signals: { a: 1, b: 2, c: 3 } });
    const cost = costOf(S);
    assert.equal(cost.links, 0, "no deriveds -- zero settled links");
    assert.equal(cost.nodes, 4, "P+D+E+1 = 3+0+0+1");

    const cfg = capacityFor([[S, 5]]);
    assert.equal(cfg.maxLinks, 1, "floored at the engine minimum of 1 (createRegistry rejects maxLinks: 0)");
    assert.equal(cfg.maxNodes, 20, "exact -- 4 x 5");

    const reg = createRegistry(cfg);
    const HostedS = defineReactive(class HostedSignalsOnly {}, { signals: { a: 1, b: 2, c: 3 }, host: { registry: reg } });
    const held = [];
    for (let i = 0; i < 5; i++) held.push(new HostedS());
    assert.equal(reg.stats().activeNodes, 20, "the degenerate (link-floor) config still hosts exactly the stated inventory");
    for (const h of held) disposeReactive(h);
});

// === Cluster C: capacityFor headroom -- the full boundary set ==================

test("QA-C1: headroom boundary matrix -- 0/negative/NaN/Infinity/-0 all throw named; 1.5 (fractional >= 1) is a documented accept", () => {
    const Chain = defineReactive(class HeadroomChain {}, {
        signals: { a: 1 },
        deriveds: { d: (self) => self.a },
    }); // nodes P+D+E+1 = 1+1+0+1 = 3, links 1
    for (const bad of [0, -1, NaN, Infinity, -Infinity, -0]) {
        assert.throws(
            () => capacityFor([[Chain, 1]], { headroom: bad }),
            (e) => e instanceof TypeError && /headroom must be a finite number >= 1/.test(e.message),
            `headroom ${bad} throws named`,
        );
    }
    // fractional >= 1 is accepted -- ceil is applied to the scaled link total.
    const scaled = capacityFor([[Chain, 1]], { headroom: 1.5 });
    assert.equal(scaled.maxLinks, Math.ceil(1 * 1.5), "headroom 1.5 accepted -- ceil(1.5) = 2");
    assert.equal(scaled.maxNodes, 3, "nodes never scale by headroom");
});

// === Cluster D: capacityFor inventory/options malformed shapes =================

test("QA-D1: inventory boundary matrix -- null/undefined/plain-object/string/number all throw the SAME named 'non-empty array' error", () => {
    for (const bad of [null, undefined, {}, "x", 5, NaN]) {
        assert.throws(
            () => capacityFor(bad),
            (e) => e instanceof TypeError && /non-empty array of \[Factory, count\] pairs/.test(e.message),
            `capacityFor(${String(bad)}) throws the inventory-shape error`,
        );
    }
});

test("QA-D2: malformed pair shapes -- length 1, length 3, and a non-array pair all throw the SAME pair error naming the index", () => {
    const Chain = defineReactive(class PairChain {}, { signals: { a: 1 } });
    assert.throws(() => capacityFor([[Chain]]), (e) => e instanceof TypeError && /inventory\[0\] must be a \[Factory, count\] pair/.test(e.message), "length-1 pair");
    assert.throws(() => capacityFor([[Chain, 1, 2]]), (e) => e instanceof TypeError && /inventory\[0\] must be a \[Factory, count\] pair/.test(e.message), "length-3 pair");
    assert.throws(() => capacityFor([{ 0: Chain, 1: 1 }]), (e) => e instanceof TypeError && /inventory\[0\] must be a \[Factory, count\] pair/.test(e.message), "non-array pair (array-like object)");
    // the index in the message tracks position, not just "first bad entry".
    assert.throws(() => capacityFor([[Chain, 1], [Chain]]), (e) => /inventory\[1\]/.test(e.message), "the SECOND bad pair is named by its own index");
});

test("QA-D3: capacityFor(inv, <non-object options>) throws the named, ERR-prefixed call-form TypeError naming the shape and what was received", () => {
    const Chain = defineReactive(class OptChain {}, { signals: { a: 1 } });
    assert.throws(
        () => capacityFor([[Chain, 1]], "bad"),
        (e) =>
            e instanceof TypeError &&
            e.message.startsWith("@zakkster/lite-signal-decorators: ") &&
            /capacityFor\(inventory, options\?\)/.test(e.message) &&
            /options must be a plain object like \{ headroom: 1\.25 \}/.test(e.message) &&
            /got string/.test(e.message),
        "call-form message: names the call shape, the expected { headroom } object, and the actual typeof received",
    );
    assert.throws(
        () => capacityFor([[Chain, 1]], 5),
        (e) => e instanceof TypeError && /got number/.test(e.message),
        "the 'got <typeof>' tail tracks the actual bad-options type",
    );
});

test("QA-D4: capacityFor(inv, []) (an array) is REJECTED -- named ERR-prefixed TypeError naming 'an array', not silently accepted as a no-op", () => {
    const Chain = defineReactive(class ArrOptChain {}, { signals: { a: 1 }, deriveds: { d: (self) => self.a } });
    assert.throws(
        () => capacityFor([[Chain, 1]], []),
        (e) =>
            e instanceof TypeError &&
            e.message.startsWith("@zakkster/lite-signal-decorators: ") &&
            /options must be a plain object like \{ headroom: 1\.25 \}/.test(e.message) &&
            /got an array/.test(e.message),
        "an array is explicitly excluded from the plain-object options check and named 'an array', not typeof 'object'",
    );
    // a genuinely empty plain object is still the documented no-op accept.
    const withEmptyObject = capacityFor([[Chain, 1]], {});
    assert.deepEqual(withEmptyObject, capacityFor([[Chain, 1]]), "{} behaves identically to omitting options entirely");
});

test("QA-D6: capacityFor(inv, null) is preserved as 'omitted' -- default headroom applies, no throw", () => {
    const Chain = defineReactive(class NullOptChain {}, { signals: { a: 1 }, deriveds: { d: (self) => self.a } });
    const withNull = capacityFor([[Chain, 1]], null);
    const withOmitted = capacityFor([[Chain, 1]]);
    assert.deepEqual(withNull, withOmitted, "options: null is treated identically to an omitted second argument");
});

test("QA-D5: duplicate Factory entries in one inventory are summed, never deduped", () => {
    const Chain = defineReactive(class DupChain {}, { signals: { a: 1 }, deriveds: { d: (self) => self.a } }); // nodes 3, links 1
    const cfg = capacityFor([[Chain, 2], [Chain, 3]]);
    assert.equal(cfg.maxNodes, 3 * 5, "5 total instances of the SAME class, summed not deduped");
    assert.equal(cfg.maxLinks, 1 * 5, "links likewise summed across the duplicate entries");
});

// === Cluster E: costOf/capacityFor parity on the defineReactive twin ===========

test("QA-E1: capacityFor parity -- decorated and buildless twins of the identical shape produce the IDENTICAL config", () => {
    const Dec = buildClass({ name: "ParityCapDec", classDecorator: reactiveHost, members: [
        { kind: "accessor", key: "a", decorator: reactive, value: () => 1 },
        { kind: "accessor", key: "b", decorator: reactive, value: () => 2 },
        { kind: "getter", key: "d0", decorator: derived, body: function () { return this.a; } },
        { kind: "getter", key: "d1", decorator: derived, body: function () { return this.d0 + this.b; } },
        { kind: "method", key: "e0", decorator: reactiveEffect, body: function () { void this.a; } },
    ] });
    const BL = defineReactive(class ParityCapBL {}, {
        signals: { a: 1, b: 2 },
        deriveds: { d0: (self) => self.a, d1: (self) => self.d0 + self.b },
        effects: { e0: (self) => { void self.a; } },
    });
    const decCfg = capacityFor([[Dec, 4]]);
    const blCfg = capacityFor([[BL, 4]]);
    assert.deepEqual(decCfg, blCfg, "same shape, same instance count -- identical maxNodes/maxLinks regardless of front door");
});

// === Cluster F: labelOf misses -- foreign handles, unregistered ids, boundary values ==

test("QA-F1: labelOf on a foreign/garbage handle (while ON) returns undefined, never throws", () => {
    enableLabels(true);
    try {
        const reg = createRegistry({ maxNodes: 64 });
        const garbageCases = [
            ["{}", {}],
            ["[]", []],
            ["new Date()", new Date()],
            ["Object.create(null)", Object.create(null)],
            ["Symbol(x)", Symbol("x")],
            ["function(){}", function () {}],
        ];
        for (const [label, garbage] of garbageCases) {
            let v;
            assert.doesNotThrow(() => { v = labelOf(garbage, reg); }, `labelOf(${label}) must not throw`);
            assert.equal(v, undefined, `foreign handle ${label} is an introspection miss, not an error`);
        }
    } finally {
        enableLabels(false);
    }
});

test("QA-F2: labelOf on a plain number id that was never registered returns undefined (while ON)", () => {
    enableLabels(true);
    try {
        const reg = createRegistry({ maxNodes: 64 });
        const W = defineReactive(class NeverRegistered {}, { signals: { x: 1 }, host: { registry: reg } });
        const w = new W(); // registers a handful of small ids
        disposeReactive(w);
        assert.equal(labelOf(999999999, reg), undefined, "a large never-issued numeric id misses cleanly");
    } finally {
        enableLabels(false);
    }
});

test("QA-F3: labelOf boundary matrix (0, -0, NaN, null, undefined) all resolve to undefined while ON, none throw", () => {
    enableLabels(true);
    try {
        const reg = createRegistry({ maxNodes: 64 });
        for (const v of [0, -0, NaN, null, undefined]) {
            let got;
            assert.doesNotThrow(() => { got = labelOf(v, reg); }, `labelOf(${v}) must not throw`);
            // 0/-0 MAY coincide with a real issued id on some registries -- the
            // contract under test here is "never throws", not "always misses";
            // a fresh untouched registry has issued nothing yet, so all miss.
            assert.equal(got, undefined, `labelOf(${v}) on a fresh registry misses`);
        }
    } finally {
        enableLabels(false);
    }
});

test("QA-F4: a handle from a totally unrelated registry misses on `reg` (cross-registry foreign handle, not just a foreign object)", () => {
    enableLabels(true);
    try {
        const regA = createRegistry({ maxNodes: 64 });
        const regB = createRegistry({ maxNodes: 64 });
        const W = defineReactive(class CrossRegForeign {}, { signals: { x: 1 }, host: { registry: regA } });
        const w = new W();
        assert.equal(labelOf(rootOf(w), regB), undefined, "regA's live handle resolves through regB.nodeId to undefined -- a clean miss, not a crash");
        disposeReactive(w);
    } finally {
        enableLabels(false);
    }
});

// === Cluster G: enableLabels/auditReactive double-enable/disable idempotency ===

test("QA-G1: enableLabels double-enable then double-disable is idempotent (no throw, consistent end state)", () => {
    enableLabels(true);
    enableLabels(true);
    const reg = createRegistry({ maxNodes: 64 });
    const W = defineReactive(class DoubleEnableW {}, { signals: { x: 1 }, host: { registry: reg } });
    const w = new W();
    assert.equal(labelOf(rootOf(w), reg), "DoubleEnableW@anchor", "labels still register normally after a redundant second enable");
    disposeReactive(w);
    enableLabels(false);
    enableLabels(false);
    const w2 = new W();
    assert.equal(labelOf(rootOf(w2), reg), undefined, "after a redundant second disable, a fresh instance is unlabeled");
    disposeReactive(w2);
});

test("QA-G2: auditReactive double-enable/disable is idempotent, and audit-only ON (labels OFF) never populates the label map (INTROSPECT_ON OR-gate)", () => {
    assert.doesNotThrow(() => { auditReactive(true); auditReactive(true); }, "double auditReactive(true) does not throw or recreate the FinalizationRegistry visibly");
    try {
        const reg = createRegistry({ maxNodes: 64 });
        const W = defineReactive(class AuditOnlyGate {}, { signals: { x: 1 }, host: { registry: reg } });
        const w = new W();
        assert.equal(labelOf(rootOf(w), reg), undefined, "audit ON / labels OFF -- INTROSPECT_ON fires wiring, but the label branch stays gated by LABELS_ON specifically");
        disposeReactive(w);
    } finally {
        auditReactive(false);
        auditReactive(false);
    }
});

// === Cluster H: costOf cache identity survives enableLabels/auditReactive flips =

test("QA-H1: costOf's cached result identity is stable across enableLabels AND auditReactive flips", () => {
    const C = defineReactive(class CacheStableC {}, { signals: { a: 1 }, deriveds: { d: (self) => self.a } });
    const c1 = costOf(C);
    enableLabels(true);
    const c2 = costOf(C);
    auditReactive(true);
    const c3 = costOf(C);
    enableLabels(false);
    auditReactive(false);
    const c4 = costOf(C);
    assert.equal(c1, c2, "identity stable across enableLabels(true)");
    assert.equal(c2, c3, "identity stable across auditReactive(true)");
    assert.equal(c3, c4, "identity stable back to both OFF -- the cache is invalidated by nothing (PD-21)");
});

// === Cluster I: audit-ON disposed-then-dropped -> no report (fixture reuse) ====

function runAuditFixture(mode) {
    const fixture = fileURLToPath(new URL("fixtures/audit-drop.mjs", import.meta.url));
    return spawnSync(process.execPath, ["--expose-gc", fixture, mode], { encoding: "utf8" });
}

test("QA-I1: an audit-ON instance that IS disposed then dropped produces NO report, AND the child process exits clean (unregister proof + process-health check)", () => {
    const res = runAuditFixture("disposed");
    const out = (res.stdout || "") + (res.stderr || "");
    assert.equal(res.status, 0, "the fixture process exits 0 -- disposeReactive's unregister does not leave the FR in a bad state");
    assert.match(out, /AUDIT_FIXTURE_DONE disposed/, "the fixture ran to completion");
    assert.doesNotMatch(
        out,
        /auditReactive: an instance of Dropped/,
        "a disposed-then-dropped instance is never reported -- disposeReactive's unregister proves out under real GC",
    );
    assert.doesNotMatch(out, /Error/, "no unrelated error text leaked onto stdout/stderr");
});

// === Cluster J: adversarial edges the planner did not enumerate ===============

test("QA-J1 ADVERSARIAL: costOf called RE-ENTRANTLY from inside an active effect (same registry) does not pollute the caller's dependency tracking", () => {
    const reg = createRegistry({ maxNodes: 256 });
    const Probe = defineReactive(class ReentrantProbe {}, {
        signals: { a: 1 },
        deriveds: { d: (self) => self.a + 1 },
        host: { registry: reg },
    });
    let runs = 0;
    let lastCost = null;
    const Outer = defineReactive(class ReentrantOuter {}, {
        signals: { trigger: 0 },
        effects: { eff: (self) => { void self.trigger; runs++; lastCost = costOf(Probe); } },
        host: { registry: reg },
    });
    const outer = new Outer();
    assert.equal(runs, 1, "auto-run at wiring");
    outer.trigger = 1;
    assert.equal(runs, 2, "one write -> exactly one re-run (costOf's probe construct/read/dispose added no stray dependency)");
    outer.trigger = 2;
    assert.equal(runs, 3, "still exactly one run per write");
    assert.equal(lastCost, costOf(Probe), "the re-entrant result is the SAME cached, correct object");
    disposeReactive(outer);
});

test("QA-J2 ADVERSARIAL: disposing an instance from WITHIN its own forEachOwned walk (labels ON) does not corrupt a SIBLING instance's label entries", () => {
    enableLabels(true);
    try {
        const reg = createRegistry({ maxNodes: 64 });
        const W = defineReactive(class IterDisposeW {}, {
            signals: { x: 1 },
            deriveds: { d: (self) => self.x },
            effects: { e: (self) => { void self.x; } },
            host: { registry: reg },
        });
        const sibling = new W();
        const target = new W();
        const siblingAnchorId = reg.nodeId(rootOf(sibling));

        let disposedMidWalk = false;
        reg.forEachOwned(rootOf(target), () => {
            if (!disposedMidWalk) {
                disposeReactive(target);   // dispose-during-iteration, self-targeted
                disposedMidWalk = true;
            }
        });
        assert.ok(disposedMidWalk, "the walk ran at least one step before dispose");
        assert.equal(
            labelOf(siblingAnchorId, reg), "IterDisposeW@anchor",
            "the sibling's label survives untouched -- dispose-during-iteration only unregisters the disposed instance's own ids",
        );
        disposeReactive(sibling);
    } finally {
        enableLabels(false);
    }
});
