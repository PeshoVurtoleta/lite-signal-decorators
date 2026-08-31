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
// AUTHORITY = FINALIZATION, not a counter trick. Each disposed instance is
// tracked with a shared NOOP cleanup + a numeric tag OUTSIDE any active owner, so
// lite-leak arms NO auto-untrack; the tracker holds it only WEAKLY and we never
// untrack it. After the churn we settle HARD (>= gc()+macrotask passes) and gate
// the finalization residual tracker.size() <= RES: an instance that was really
// reclaimed is collected (size--), one that leaked is not.
//
// (An earlier version tracked from INSIDE a default-registry effect and untracked
// on stop() -- a VARIANT-2 VACUOUS gate: stop() drove size() to 0 BY CONSTRUCTION
// via the auto-registered onCleanup(untrack), so size()===0 held even if the
// instance were retained forever. Fixed here to the finalization-authority
// pattern -- a retention gate must FAIL on a retained object.)
//
// HELD-VALUE CONTRACT (suite law): neither `release` (the shared module noop) nor
// `tag` (a detached primitive) closes over the tracked instance, so finalization
// is never defeated and the tracker cannot report a false-clean. The tracker is
// PLAIN (no kernels, no onLeak-into-a-checked-array): kernels flag held-but-
// -uncollected objects and onLeak fires on COLLECTION -- both break the hold.
//
// GATE after settleHard(): tracker.size() <= RES, audit() finds nothing (no
// kernels), zero warnings.
//
// TORTURE_BREAK=leak-torture leaks one instance every 64 cycles (retains it in a
// module array, never disposed): residual climbs past RES and the gate trips
// (the --controls self-test). TORTURE_LEAK=1 pins EVERY tracked instance in a
// module sink -> residual ~= CYCLES -> the finalization gate trips RED directly.
//
// ASCII-only.

import { createRegistry } from "@zakkster/lite-signal";
import { createLeakTracker } from "@zakkster/lite-leak";
import * as pkg from "../../SignalDecorators.js";
import { buildClass } from "../shared/mock-emitter.mjs";
import {
    RUN, check, breakActive, randInt, pass,
    retainLeak, residualCeiling, settleHard,
} from "./helpers/harness.mjs";

const NAME = "leak-torture";
const CYCLES = 4096;
const LEAK_EVERY = 64;                            // BREAK cadence (> RES leaked)
const RES = residualCeiling(CYCLES);              // finalization residual ceiling

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

const warns = [];

// PLAIN tracker: no kernels, no onLeak. Finalization is the release path, so a
// held-but-uncollected object must NOT be flagged, and onLeak (which fires on
// collection) is not a leak signal here. onWarning stays -- a warning is a real
// finding.
const tracker = createLeakTracker({
    name: NAME,
    onWarning: (w) => warns.push(w.kind + ":" + w.reason),
});

// Held-value-safe cleanup, allocated ONCE. `release` captures nothing; the tag
// passed per-cycle is a primitive.
function release() {}

// TORTURE_LEAK RED control: every tracked instance is pinned here so it can NEVER
// finalize -> residual ~= CYCLES.
const RETAIN = retainLeak();
const __leakSink = [];

// Control retention: leaked instances (TORTURE_BREAK) are parked here so they are
// neither disposed nor collected -- residual stays above RES.
const leakedVms = [];

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

    if (leak) {
        leakedVms.push(vm);           // retained -> can never finalize -> size > RES
    } else {
        pkg.disposeReactive(vm);      // tears down the instance's own reactive tree
    }
    // AUTHORITY: track OUTSIDE any owner -> lite-leak arms no auto-untrack. A
    // disposed vm's only strong ref is the tracker's WeakRef, so finalization is
    // the sole release path; a leaked (retained) vm stays live.
    tracker.track(vm, release, tag);
    if (RETAIN) __leakSink.push(vm);  // RED: pin -> never finalizes.
}
if (sink === -1) console.log("unreachable");
RUN.op = -1;

// --- settle + gate ------------------------------------------------------------

await settleHard(() => tracker.size(), RES);
// Keep the RED sink live ACROSS the settle: a module array written-but-never-read
// after the loop is otherwise liveness-elided by V8 and its contents collected,
// masking the pin. This read forces it to survive every gc() round above.
if (__leakSink.length === -1 || leakedVms.length === -1) console.log("unreachable");

const live = tracker.size();
const findings = tracker.audit();

process.stdout.write(
    "torture: leak-torture residual size=" + live + "/" + RES + " findings=" + findings.length +
    " warnings=" + warns.length + " cycles=" + CYCLES + "\n",
);

check(warns.length === 0, () => "kernel warnings emitted: " + warns.join(","));
check(
    findings.length === 0,
    () => "audit findings: " + findings.map((f) => f.kind + ":" + f.reason).join(","),
);
check(
    live <= RES,
    () => "AUTHORITY finalization residual size()=" + live + " > " + RES +
        " -- instance(s) outlived their disposal",
);

pass(NAME);
