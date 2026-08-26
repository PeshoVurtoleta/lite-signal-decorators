// test/13-labels-audit.test.mjs -- enableLabels/labelOf + auditReactive (S4 T6,
// PD-23/PD-24).
//
// Labels: OFF by default (a fresh instance resolves to undefined, no map
// entries); ON, every decorated member kind AND the anchor resolve through
// labelOf -- "Class.prop" (signal/derived), "Class#method" (effect),
// "Class@anchor" -- via rootOf/boxOf handles and a forEachOwned walk. Maps are
// per-registry: a wrong-registry lookup misses, numerically colliding ids never
// cross-resolve, and disposeReactive unregisters. The defineReactive twin labels
// identically. A feature-detected devtools graph() walk resolves every one of
// OUR nodes.
//
// Audit: a child-process `--expose-gc` fixture drops an instance without
// disposeReactive and the parent asserts the audit console.error line appeared;
// a disposed control is silent; audit OFF is silent (no FinalizationRegistry).
// enableLabels/auditReactive reject a non-boolean argument (fail closed).
//
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRegistry } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import { buildClass } from "./shared/mock-emitter.mjs";

const { reactive, derived, reactiveEffect, reactiveHost, defineReactive, disposeReactive, rootOf, boxOf, labelOf, enableLabels, auditReactive } = pkg;

// A Widget shape with one of every kind: signal x, derived dbl, effect eff.
function widget(name, reg) {
    return buildClass({ name, classDecorator: reactiveHost({ registry: reg }), members: [
        { kind: "accessor", key: "x", decorator: reactive, value: () => 1 },
        { kind: "getter", key: "dbl", decorator: derived, body: function () { return this.x * 2; } },
        { kind: "method", key: "eff", decorator: reactiveEffect, body: function () { void this.x; } },
    ] });
}

// Collect every label reachable for an instance on registry `reg`.
function collectLabels(vm, reg) {
    const labels = new Set();
    labels.add(labelOf(rootOf(vm), reg));                 // anchor
    labels.add(labelOf(boxOf(vm, "x"), reg));             // signal (box handle)
    labels.add(labelOf(boxOf(vm, "dbl"), reg));           // derived (box handle)
    reg.forEachOwned(rootOf(vm), (node) => {              // owned: derived + effect
        labels.add(labelOf(node, reg));
    });
    return labels;
}

// --- labels OFF (default) -----------------------------------------------------

test("labels OFF (default): labelOf misses for a fresh instance's rootOf handle", () => {
    enableLabels(false);
    const reg = createRegistry({ maxNodes: 64 });
    const W = widget("OffWidget", reg);
    const w = new W();
    assert.equal(labelOf(rootOf(w), reg), undefined, "no label while OFF");
    assert.equal(labelOf(boxOf(w, "x"), reg), undefined, "no signal label while OFF");
    disposeReactive(w);
});

// --- labels ON: every member kind + anchor resolve ---------------------------

test("labels ON: every member kind and the anchor resolve through labelOf", () => {
    enableLabels(true);
    try {
        const reg = createRegistry({ maxNodes: 64 });
        const W = widget("Widget", reg);
        const w = new W();
        assert.equal(labelOf(rootOf(w), reg), "Widget@anchor", "anchor label");
        assert.equal(labelOf(boxOf(w, "x"), reg), "Widget.x", "signal label (box handle, nodeId path)");
        assert.equal(labelOf(boxOf(w, "dbl"), reg), "Widget.dbl", "derived label (box handle)");

        const labels = collectLabels(w, reg);
        for (const want of ["Widget@anchor", "Widget.x", "Widget.dbl", "Widget#eff"]) {
            assert.ok(labels.has(want), `label ${want} resolves via rootOf/boxOf/forEachOwned`);
        }
        disposeReactive(w);
    } finally {
        enableLabels(false);
    }
});

// --- per-registry isolation + numeric id collision ---------------------------

test("labels: per-registry isolation -- wrong registry misses, colliding ids never cross-resolve", () => {
    enableLabels(true);
    try {
        const rA = createRegistry({ maxNodes: 64 });
        const rB = createRegistry({ maxNodes: 64 });
        const WA = widget("Alpha", rA);
        const WB = widget("Beta", rB);
        const a = new WA();
        const b = new WB();

        const idA = rA.nodeId(rootOf(a));
        const idB = rB.nodeId(rootOf(b));
        assert.equal(idA, idB, "the two anchors carry numerically colliding ids (per-registry ids)");

        // right registry hits, wrong registry misses.
        assert.equal(labelOf(idA, rA), "Alpha@anchor", "right registry resolves");
        assert.equal(labelOf(idA, rB), "Beta@anchor", "same numeric id on rB resolves to rB's own node, never rA's");
        assert.notEqual(labelOf(idA, rA), labelOf(idA, rB), "colliding ids never cross-resolve");

        // a handle looked up on the wrong registry misses (nodeId path).
        assert.equal(labelOf(rootOf(a), rB), undefined, "a's anchor handle is unknown to rB");
        disposeReactive(a);
        disposeReactive(b);
    } finally {
        enableLabels(false);
    }
});

// --- disposeReactive unregisters ---------------------------------------------

test("labels: disposeReactive unregisters -- the old ids miss after teardown", () => {
    enableLabels(true);
    try {
        const reg = createRegistry({ maxNodes: 64 });
        const W = widget("Ephemeral", reg);
        const w = new W();
        const anchorId = reg.nodeId(rootOf(w));
        assert.equal(labelOf(anchorId, reg), "Ephemeral@anchor", "labeled while live");
        disposeReactive(w);
        assert.equal(labelOf(anchorId, reg), undefined, "the anchor id misses after dispose");
    } finally {
        enableLabels(false);
    }
});

// --- defineReactive twin parity ----------------------------------------------

test("labels: the defineReactive twin labels every member kind identically", () => {
    enableLabels(true);
    try {
        const reg = createRegistry({ maxNodes: 64 });
        const W = defineReactive(class Twin {}, {
            signals: { x: 1 },
            deriveds: { dbl: (self) => self.x * 2 },
            effects: { eff: (self) => { void self.x; } },
            host: { registry: reg },
        });
        const w = new W();
        assert.equal(labelOf(rootOf(w), reg), "Twin@anchor", "buildless anchor label");
        assert.equal(labelOf(boxOf(w, "x"), reg), "Twin.x", "buildless signal label");
        assert.equal(labelOf(boxOf(w, "dbl"), reg), "Twin.dbl", "buildless derived label");
        const labels = collectLabels(w, reg);
        assert.ok(labels.has("Twin#eff"), "buildless effect label resolves via the walk");
        disposeReactive(w);
    } finally {
        enableLabels(false);
    }
});

// --- devtools integration (feature-detected) ---------------------------------

test("labels: a devtools graph() walk resolves every one of OUR nodes (feature-detected)", async (t) => {
    let D;
    try {
        D = await import("@zakkster/lite-devtools");
    } catch (_) {
        t.skip("@zakkster/lite-devtools not installed");
        return;
    }
    enableLabels(true);
    try {
        // Default-registry instance so devtools' graph walk (which introspects the
        // default registry) sees it; labelOf defaults to the default registry too.
        const W = buildClass({ name: "DevWidget", classDecorator: reactiveHost, members: [
            { kind: "accessor", key: "x", decorator: reactive, value: () => 1 },
            { kind: "getter", key: "dbl", decorator: derived, body: function () { return this.x * 2; } },
            { kind: "method", key: "eff", decorator: reactiveEffect, body: function () { void this.x; } },
        ] });
        const w = new W();
        void w.dbl;                                       // force the lazy link
        const g = D.graph(rootOf(w), { owners: true });   // owner edges reach anchor + owned
        assert.ok(g.nodes.length >= 4, "the walk reached the anchor, signal, derived, and effect");
        const resolved = [];
        for (const node of g.nodes) {
            const id = node.id;
            const label = labelOf(id);                    // default registry
            assert.ok(label !== undefined, `devtools node id ${id} resolves through labelOf (${label})`);
            resolved.push(label);
        }
        for (const want of ["DevWidget@anchor", "DevWidget.x", "DevWidget.dbl", "DevWidget#eff"]) {
            assert.ok(resolved.includes(want), `${want} present in the devtools walk`);
        }
        disposeReactive(w);
    } finally {
        enableLabels(false);
    }
});

// --- auditReactive: child-process finalization catch -------------------------

function runAuditFixture(mode) {
    const fixture = fileURLToPath(new URL("fixtures/audit-drop.mjs", import.meta.url));
    const res = spawnSync(process.execPath, ["--expose-gc", fixture, mode], { encoding: "utf8" });
    return (res.stdout || "") + (res.stderr || "");
}

const AUDIT_LINE = /auditReactive: an instance of Dropped \(P=1 D=1 E=1\) was garbage-collected without disposeReactive/;

test("audit ON: an instance dropped without disposeReactive is reported (child-process --expose-gc)", () => {
    const out = runAuditFixture("drop");
    assert.match(out, /AUDIT_FIXTURE_DONE drop/, "the fixture ran to completion");
    assert.match(out, AUDIT_LINE, "the audit line named the dropped class + shape");
});

test("audit ON: an instance that IS disposed is NOT reported", () => {
    const out = runAuditFixture("disposed");
    assert.match(out, /AUDIT_FIXTURE_DONE disposed/, "the fixture ran to completion");
    assert.doesNotMatch(out, AUDIT_LINE, "a disposed instance produces no audit report");
});

test("audit OFF: no FinalizationRegistry effect -- a dropped instance is silent", () => {
    const out = runAuditFixture("off");
    assert.match(out, /AUDIT_FIXTURE_DONE off/, "the fixture ran to completion");
    assert.doesNotMatch(out, AUDIT_LINE, "with audit OFF, a dropped instance is silent");
});

// --- argument validation (fail closed) ---------------------------------------

test("enableLabels/auditReactive: a non-boolean argument throws (fail closed)", () => {
    for (const bad of [1, 0, "true", null, undefined, {}]) {
        assert.throws(
            () => enableLabels(bad),
            (e) => e instanceof TypeError && /must be a boolean/.test(e.message),
            `enableLabels(${String(bad)}) throws`,
        );
        assert.throws(
            () => auditReactive(bad),
            (e) => e instanceof TypeError && /must be a boolean/.test(e.message),
            `auditReactive(${String(bad)}) throws`,
        );
    }
    // restore: leave both flags OFF for any later file-level state.
    enableLabels(false);
    auditReactive(false);
});
