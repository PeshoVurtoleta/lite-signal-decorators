// test/torture/leak-torture.mjs -- node --expose-gc test/torture/leak-torture.mjs
//
// RETENTION torture (PLAN-S2b T3). A lite-leak tracker + the
// owner-cascade-orphan and observer-orphan kernels watch 4096
// construct/use/dispose cycles over a MIXED shape family (P<=8 signals,
// D<=4 deriveds, E<=2 effects) split across three construction paths:
//   - decorated   (buildClass + @reactiveHost, default registry);
//   - defineReactive (buildless spec, default registry);
//   - registry-bound (buildClass + @reactiveHost({ registry }) on a bound
//     createRegistry).
//
// Each instance is tracked with { audit: true } from inside a DEFAULT-registry
// effect, so the tracker captures that effect as the owner and registers an
// onCleanup(untrack) on it. The normal cycle then disposeReactive()s the
// instance (its own detached tree is torn down) and stop()s the tracking
// effect, whose cleanup untracks the handle -- reclamation is DETERMINISTIC,
// not GC-dependent. A leaked instance (retained, tracking effect never
// stopped) keeps its handle live: tracker.size() stays above zero.
//
// HELD-VALUE CONTRACT (suite law): neither `cleanup` (the shared module
// noop `release`) nor `tag` (a detached primitive) closes over the tracked
// instance, so finalization is never defeated and the tracker cannot report a
// false-clean.
//
// GATE after settle(): tracker.size() === 0, audit() finds nothing, zero
// warnings, zero leak callbacks.
//
// TORTURE_BREAK=leak-torture leaks one instance every 512 cycles (skips both
// its disposeReactive and its tracking-effect stop, retaining it): the
// size()===0 gate is what must catch it.
//
// ASCII-only.

import { effect, createRegistry } from "@zakkster/lite-signal";
import {
    createLeakTracker,
    createOwnerCascadeOrphanKernel,
    createObserverOrphanKernel,
} from "@zakkster/lite-leak";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import { RUN, check, breakActive, randInt, settle, pass } from "./helpers/harness.mjs";

const NAME = "leak-torture";
const CYCLES = 4096;
const LEAK_EVERY = 512;                          // BREAK cadence

// --- shape builders (all constructed ONCE, reused across cycles) -------------

// Accessor / getter / method member lists shared by the decorated + bound
// paths (both drive buildClass; only the class decorator differs).
function reactiveMembers(P, D, E) {
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
    return members;
}

function decoratedShape(id, P, D, E) {
    const C = buildClass({
        name: "Dec" + id,
        classDecorator: pkg.reactiveHost,
        members: reactiveMembers(P, D, E),
    });
    C.__hasD = D > 0;
    return C;
}

function boundShape(id, P, D, E, reg) {
    const C = buildClass({
        name: "Bnd" + id,
        classDecorator: pkg.reactiveHost({ registry: reg }),
        members: reactiveMembers(P, D, E),
    });
    C.__hasD = D > 0;
    return C;
}

function defineShape(id, P, D, E) {
    const signals = {};
    for (let i = 0; i < P; i++) signals["s" + i] = 0;
    const deriveds = {};
    for (let i = 0; i < D; i++) deriveds["d" + i] = function () { return this.s0 + 1; };
    const effects = {};
    for (let i = 0; i < E; i++) effects["e" + i] = function () { void this.s0; };
    const Base = class {};
    Object.defineProperty(Base, "name", { value: "Def" + id, configurable: true });
    const C = pkg.defineReactive(Base, { signals, deriveds, effects });
    C.__hasD = D > 0;
    return C;
}

// A bound registry generous enough that the 1024-node default ceiling is never
// the thing under test (decision 0002 D-2e discipline, applied per-thirds).
const boundReg = createRegistry({ maxNodes: 512 });

// Three families, every shape P<=8 / D<=4 / E<=2, at least one signal each.
const DECORATED = [
    decoratedShape(0, 2, 1, 0),
    decoratedShape(1, 5, 3, 1),
    decoratedShape(2, 8, 4, 2),
    decoratedShape(3, 3, 2, 1),
];
const DEFINED = [
    defineShape(0, 1, 0, 0),
    defineShape(1, 4, 2, 1),
    defineShape(2, 7, 4, 2),
    defineShape(3, 3, 1, 1),
];
const BOUND = [
    boundShape(0, 2, 1, 1, boundReg),
    boundShape(1, 6, 3, 2, boundReg),
    boundShape(2, 4, 2, 0, boundReg),
    boundShape(3, 8, 4, 2, boundReg),
];

// --- tracker + kernels --------------------------------------------------------

const leaks = [];
const warns = [];

const tracker = createLeakTracker({
    name: NAME,
    onLeak: (r) => leaks.push(r.kind + ":" + String(r.tag)),
    onWarning: (w) => warns.push(w.kind + ":" + w.reason),
});
// The reactive owner tree (cascade orphans) is the surface this package owns;
// the observer kernel guards a surface the package does not patch, so it must
// stay silent -- a warning from it would itself be a finding.
tracker.registerKernel(createOwnerCascadeOrphanKernel());
tracker.registerKernel(createObserverOrphanKernel());

// Held-value-safe cleanup + audit options, allocated ONCE. `release` captures
// nothing; the tag passed per-cycle is a primitive.
function release() {}
const AUDIT = { audit: true };

// Control retention: leaked instances and their never-stopped tracking effects
// are parked here so they are neither disposed nor collected.
const leakedVms = [];
const leakedStops = [];

// --- churn --------------------------------------------------------------------

let sink = 0;
for (let i = 0; i < CYCLES; i++) {
    RUN.op = i;
    const leak = breakActive(NAME) && (i % LEAK_EVERY === 0);

    // Deterministic thirds; PRNG chooses the shape within a third.
    const third = i % 3;
    const fam = third === 0 ? DECORATED : third === 1 ? DEFINED : BOUND;
    const Shape = fam[randInt(fam.length)];

    // Construct with NO active owner (module scope), so the instance's own
    // detached tree is the only thing its reads/writes touch.
    const vm = new Shape();
    vm.s0 = i & 1023;
    sink = (sink + (Shape.__hasD ? vm.d0 : vm.s0)) | 0;   // exercise the hot accessor/derived
    const tag = i & 255;                                  // detached primitive; no capture

    // Track from inside a default-registry effect -> owner captured, onCleanup
    // registered. The effect body reads nothing reactive, so it runs once.
    const stop = effect(function () {
        tracker.track(vm, release, tag, AUDIT);
    });

    if (leak) {
        leakedVms.push(vm);       // retained -> handle stays live -> size > 0
        leakedStops.push(stop);   // effect never stopped -> untrack never fires
    } else {
        pkg.disposeReactive(vm);  // tears down the instance's own reactive tree
        stop();                   // effect cleanup -> untrack -> size decrements
    }
}
if (sink === -1) console.log("unreachable");
RUN.op = -1;

// --- settle + gate ------------------------------------------------------------

await settle();
globalThis.gc?.();
await settle();

const live = tracker.size();
const findings = tracker.audit();

process.stdout.write(
    "torture: leak-torture size=" + live + "/0 findings=" + findings.length +
    " warnings=" + warns.length + " leaks=" + leaks.length +
    " cycles=" + CYCLES + "\n",
);

check(warns.length === 0, () => "kernel warnings emitted: " + warns.join(","));
check(
    findings.length === 0,
    () => "audit findings: " + findings.map((f) => f.kind + ":" + f.reason).join(","),
);
check(leaks.length === 0, () => "leak callbacks fired: " + leaks.join(","));
check(
    live === 0,
    () => "tracker retained " + live + " handle(s) after settle -- instance(s) outlived their owner",
);

pass(NAME);
