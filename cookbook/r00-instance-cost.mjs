// cookbook/r00-instance-cost.mjs -- node --expose-gc cookbook/r00-instance-cost.mjs
//
// Recipe 0 -- "Just show me what one instance costs."
// costOf() reports a class's settled per-instance node/link cost. The number is
// shape-determined (nodes = P + D + E + 1) and measured, not guessed: costOf
// double-probes and THROWS on an inconclusive read rather than return a lie.
//
// Not gated (cold): sizing is decoration-time work, done once, never a frame
// path -- see cookbook/manifest.json (r0, gc: "none") for the published reason.
//
// The published snippets live between the #region markers; everything else is
// the standalone-runner scaffolding (assertions + the one summary line).
// ASCII only.

const RID = "r0";
function assert(cond, msg) {
    if (!cond) {
        process.stderr.write("cookbook " + RID + " FAIL: " + msg + "\n");
        process.exit(1);
    }
}

// #region cookbook:r0.1
import { defineReactive, costOf } from "@zakkster/lite-signal-decorators";

// A small view-model: 2 reactive signals (P), 1 lazy derived (D), 0 effects (E).
// defineReactive is the buildless twin of the @reactiveHost decorator stack --
// same wiring core, so a decorated `class Vitals` costs exactly what this costs.
class VitalsBase {}
const Vitals = defineReactive(VitalsBase, {
    signals: { hp: 100, mp: 50 },
    deriveds: { alive: (self) => self.hp > 0 },
    effects: {},
});

const cost = costOf(Vitals);
// nodes = P + D + E + 1 (the anchor). Here: 2 + 1 + 0 + 1 = 4.
// links = the first-full-read dependency count: `alive` reads `hp` once -> 1.
const expectedNodes = cost.signals + cost.deriveds + cost.effects + 1;
// #endregion cookbook:r0.1

assert(cost.nodes === 4, "expected 4 nodes, got " + cost.nodes);
assert(cost.nodes === expectedNodes, "nodes " + cost.nodes + " != P+D+E+1 " + expectedNodes);
assert(cost.links === 1, "expected 1 link, got " + cost.links);
assert(cost.signals === 2 && cost.deriveds === 1 && cost.effects === 0, "shape counts wrong");

// #region cookbook:r0.2
// costOf is frozen and cached per class: the second call returns the SAME
// object, and a class you never size costs you nothing.
const again = costOf(Vitals);
const cached = again === cost;                 // true -- identity, not a re-probe
const frozen = Object.isFrozen(cost);          // true -- you cannot mutate a fact
// #endregion cookbook:r0.2

assert(cached === true, "costOf result is not cached by identity");
assert(frozen === true, "costOf result is not frozen");

// #region cookbook:r0.3
// costOf never guesses. It probes TWICE and requires identical deltas; a
// data-dependent derived (one whose dependency set changes between reads) makes
// the two probes disagree, and costOf THROWS instead of returning a number that
// would be wrong for half your instances.
let probe = 0;
class FlakyBase {}
const Flaky = defineReactive(FlakyBase, {
    signals: { a: 1, b: 2 },
    // reads a DIFFERENT number of members on successive probes -> links disagree.
    deriveds: { d: (self) => ((probe++ & 1) ? self.a : self.a + self.b) },
    effects: {},
});

let threwName = null;
try {
    costOf(Flaky);                             // never returns here
} catch (err) {
    threwName = err.name;                      // the honest outcome: a throw
}
// #endregion cookbook:r0.3

assert(threwName !== null, "costOf did not throw on an inconclusive probe");

process.stdout.write(
    "cookbook r0 instance-cost | nodes=" + cost.nodes + " (P" + cost.signals +
    "+D" + cost.deriveds + "+E" + cost.effects + "+1) links=" + cost.links +
    " cached=" + cached + " inconclusive-throws=" + (threwName !== null) + " | ok\n",
);
