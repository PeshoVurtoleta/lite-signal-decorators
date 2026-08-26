// test/torture/capacity-torture.mjs -- node --expose-gc test/torture/capacity-torture.mjs
//
// Init-phase + wiring-phase capacity atomicity (PLAN-S2b T1, decision 0002
// D-2h). The default registry is primed with filler signal boxes to N-epsilon
// so a CapacityError lands at EACH construction failure point, x BOTH paths
// (decorated via the mock emitter; buildless via defineReactive):
//
//   (a) the K-th signal box     -- decorator path: created in accessor `init`
//                                  during super() field-init, BEFORE
//                                  wireInstance's try/catch (the P-1/D-2h lane,
//                                  guarded by the SCRATCH-frame rollback);
//                                  buildless path: created in wireInstance's
//                                  wire loop.
//   (b) the anchor              -- headroom = P exactly: every signal fits, the
//                                  R-A anchor effect overflows.
//   (c) the m-th derived        -- headroom = P + 1 + (m-1).
//   (d) the m-th effect         -- headroom = P + 1 + D + (m-1).
//
// Every point asserts: a CapacityError propagates BY NAME out of `new`;
// conservation is exact after the partial construction unwinds (F-0 via
// assertConserved -- activeNodes back to the primed baseline, poolGrowths delta
// 0, ledger balances); then, with the fillers freed, the IDENTICAL construction
// succeeds. A NESTED case (an Outer field initializer constructing an inner
// reactive VM whose signal init overflows) proves the SCRATCH frame index is a
// LIFO marker: the inner wrapper drains its own frame first, the outer wrapper
// then drains what remains -- net zero leak.
//
// TORTURE_BREAK=capacity-torture skips the filler-free before each revival, so
// the "identical construction succeeds" assertion (revival must NOT throw) is
// the gate that must fail.
//
// ASCII-only.

import { signalBox, dispose as sigDispose, stats } from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, conservationBaseline, assertConserved, settle, pass,
} from "./helpers/harness.mjs";

const NAME = "capacity-torture";

// --- shape builders: structurally identical decorated + buildless twins -------

function decShape(id, P, D, E) {
    const members = [];
    for (let i = 0; i < P; i++) {
        members.push({
            kind: "accessor",
            key: "s" + i,
            decorator: pkg.reactive,
            value: (function (v) { return function () { return v; }; })(i),
        });
    }
    for (let i = 0; i < D; i++) {
        members.push({
            kind: "getter",
            key: "d" + i,
            decorator: pkg.derived,
            body: function () { return this.s0 + 1; },
        });
    }
    for (let i = 0; i < E; i++) {
        members.push({
            kind: "method",
            key: "e" + i,
            decorator: pkg.reactiveEffect,
            body: function () { void this.s0; },
        });
    }
    return buildClass({ name: "Dec" + id, classDecorator: pkg.reactiveHost, members });
}

function buildlessShape(id, P, D, E) {
    const signals = {};
    const deriveds = {};
    const effects = {};
    for (let i = 0; i < P; i++) signals["s" + i] = i;
    for (let i = 0; i < D; i++) deriveds["d" + i] = function () { return this.s0 + 1; };
    for (let i = 0; i < E; i++) effects["e" + i] = function () { void this.s0; };
    const Class = { ["BL" + id]: class {} }["BL" + id];
    return pkg.defineReactive(Class, { signals, deriveds, effects });
}

// Host-chain twins: EVERY level carries @reactiveHost, so only the leaf wires
// (PD-5), but every level's field init pushes its boxes into the leaf's single
// SCRATCH frame. An intermediate host that truncated its own frame would evict
// its base boxes before a derived overflow (the D-2h intermediate-host defect);
// these lanes prove the corrected most-derived-gated protocol reclaims the whole
// chain.

function acc(key) {
    return { kind: "accessor", key, decorator: pkg.reactive, value: () => 0 };
}

function chain2(id) {
    const Base = buildClass({
        name: "HBase" + id,
        classDecorator: pkg.reactiveHost,
        members: [acc("b0"), acc("b1")],
    });
    return buildClass({
        name: "HDer" + id,
        superClass: Base,
        classDecorator: pkg.reactiveHost,
        members: [acc("d0"), acc("d1")],
    });
}

function chain3(id) {
    const Base = buildClass({
        name: "TBase" + id,
        classDecorator: pkg.reactiveHost,
        members: [acc("b0")],
    });
    const Mid = buildClass({
        name: "TMid" + id,
        superClass: Base,
        classDecorator: pkg.reactiveHost,
        members: [acc("m0")],
    });
    return buildClass({
        name: "TLeaf" + id,
        superClass: Mid,
        classDecorator: pkg.reactiveHost,
        members: [acc("l0")],
    });
}

// --- one failure point --------------------------------------------------------
//
// Prime the pool to leave exactly `headroom` free nodes, construct at the
// ceiling (must throw CapacityError by name), assert F-0, free the fillers, then
// prove the identical construction now succeeds.

function runCase(label, Shape, headroom, checkKey) {
    const key = checkKey === undefined ? "s0" : checkKey;
    // Warm one full construct/dispose so first-touch pool population is not
    // charged to the primed window (poolGrowths must stay 0).
    { const w = new Shape(); pkg.disposeReactive(w); }

    const fillers = [];
    while (stats().nodePoolCapacity - stats().activeNodes > headroom) {
        fillers.push(signalBox(0));
    }

    const capBase = conservationBaseline();    // baseline INCLUDES the fillers
    let err = null;
    try {
        const doomed = new Shape();
        pkg.disposeReactive(doomed);           // unreachable on a correct core
    } catch (e) {
        err = e;
    }
    check(err !== null, () => label + ": construction did not throw at the ceiling");
    check(
        err.name === "CapacityError",
        () => label + ": error name=" + err.name + " expected CapacityError",
    );
    assertConserved(capBase, label + " partial-construction teardown");

    // BREAK: skip the filler-free, so the revival below overflows and its
    // "must not throw" assertion fails.
    if (!breakActive(NAME)) {
        for (let i = 0; i < fillers.length; i++) sigDispose(fillers[i]);
    }

    let revived = null;
    let rerr = null;
    try { revived = new Shape(); } catch (e) { rerr = e; }
    check(rerr === null, () => label + ": revival threw " + (rerr && rerr.name) + " after fillers freed");
    check(revived[key] === 0, () => label + ": revived " + key + "=" + revived[key]);
    pkg.disposeReactive(revived);

    // Non-break path already freed; nothing held. (Break dies at the revival
    // check above, so control flow never reaches here.)
}

// (a) K-th signal box -- P=3, headroom=2: s0, s1 fit; s2 overflows.
RUN.op = 0;
runCase("(a) dec K-th signal", decShape("Asig", 3, 0, 0), 2);
RUN.op = 1;
runCase("(a) buildless K-th signal", buildlessShape("Asig", 3, 0, 0), 2);

// (b) anchor -- P=2, D=1, headroom=2: both signals fit; the anchor overflows.
RUN.op = 2;
runCase("(b) dec anchor", decShape("Banc", 2, 1, 0), 2);
RUN.op = 3;
runCase("(b) buildless anchor", buildlessShape("Banc", 2, 1, 0), 2);

// (c) m-th derived -- P=1, D=3, headroom=P+1+(m-1)=3 (m=2): signal + anchor +
// first derived fit; the second derived overflows.
RUN.op = 4;
runCase("(c) dec 2nd derived", decShape("Cder", 1, 3, 0), 3);
RUN.op = 5;
runCase("(c) buildless 2nd derived", buildlessShape("Cder", 1, 3, 0), 3);

// (d) m-th effect -- P=1, D=1, E=2, headroom=P+1+D+(m-1)=3 (m=1): signal +
// anchor + derived fit; the first effect overflows.
RUN.op = 6;
runCase("(d) dec 1st effect", decShape("Deff", 1, 1, 2), 3);
RUN.op = 7;
runCase("(d) buildless 1st effect", buildlessShape("Deff", 1, 1, 2), 3);

// --- host-chain init overflow: whole-chain frame reclaim ----------------------
//
// Base@reactiveHost <- Derived@reactiveHost: the leaf's super() spans both
// class bodies, so its single SCRATCH frame [f, end) must cover every base +
// derived init box. The reviewer's intermediate-host defect leaked the base
// boxes when an intermediate wrapper truncated its own frame; the corrected
// most-derived-gated protocol reclaims the whole chain. Init order across the
// chain is b0, b1, d0, d1.

// (a) overflow at Derived's FIRST init box (d0 -- 3rd overall); Base's two boxes
// must be reclaimed. headroom 2: b0, b1 fit; d0 overflows.
RUN.op = 9;
runCase("host-chain (a) derived-first init", chain2("A"), 2, "b0");

// (b) mirror -- overflow at BASE's second box (b1 -- 2nd overall); the frame
// drains the single already-created base box (b0). headroom 1.
RUN.op = 10;
runCase("host-chain (b) base-second init", chain2("B"), 1, "b0");

// (c) 3-level chain (host <- host <- host) overflowing at the LEAF's init box
// (l0 -- 3rd overall); base + mid boxes reclaimed. headroom 2.
RUN.op = 11;
runCase("host-chain (c) 3-level leaf init", chain3("C"), 2, "b0");

// --- nested construction: LIFO frame unwind -----------------------------------
//
// Outer declares a signal `s0` then a plain field `inner` whose initializer
// constructs a reactive Inner. Priming leaves room for outer.s0 + inner.s0 +
// inner.s1, so inner.s2 overflows DURING inner's super() field-init. The inner
// wrapper drains its SCRATCH frame first (inner.s0, inner.s1), the error
// propagates out of outer's super(), and the outer wrapper drains what remains
// (outer.s0). Net leak zero -- the frame index proved a correct LIFO marker.

RUN.op = 12;
{
    const Inner = decShape("NInner", 3, 0, 0);
    const Outer = buildClass({
        name: "NOuter",
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "s0", decorator: pkg.reactive, value: () => 0 },
            { kind: "field", key: "inner", value: function () { return new Inner(); } },
        ],
    });

    // Warm: a full construct populates every node kind; dispose both VMs (the
    // inner is an unmanaged field, disposed explicitly).
    { const w = new Outer(); pkg.disposeReactive(w.inner); pkg.disposeReactive(w); }

    const headroom = 3;                        // outer.s0 + inner.s0 + inner.s1
    const fillers = [];
    while (stats().nodePoolCapacity - stats().activeNodes > headroom) {
        fillers.push(signalBox(0));
    }

    const capBase = conservationBaseline();
    let err = null;
    try {
        const w = new Outer();
        pkg.disposeReactive(w.inner);
        pkg.disposeReactive(w);
    } catch (e) {
        err = e;
    }
    check(err !== null, () => "nested: construction did not throw at the ceiling");
    check(
        err.name === "CapacityError",
        () => "nested: error name=" + err.name + " expected CapacityError",
    );
    assertConserved(capBase, "nested LIFO-unwind teardown");

    if (!breakActive(NAME)) {
        for (let i = 0; i < fillers.length; i++) sigDispose(fillers[i]);
    }

    let w = null;
    let rerr = null;
    try { w = new Outer(); } catch (e) { rerr = e; }
    check(rerr === null, () => "nested: revival threw " + (rerr && rerr.name) + " after fillers freed");
    check(w.s0 === 0, () => "nested: revived outer s0=" + w.s0);
    check(w.inner.s0 === 0, () => "nested: revived inner s0=" + w.inner.s0);
    pkg.disposeReactive(w.inner);
    pkg.disposeReactive(w);
}

// --- final quiesce ------------------------------------------------------------

await settle();
RUN.op = -1;
pass(NAME);
