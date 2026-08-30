// cookbook/r03-budget-an-app.mjs -- node --expose-gc cookbook/r03-budget-an-app.mjs
//
// Recipe 3 -- "Budgeting a whole app."
// capacityFor([[Factory, count], ...]) turns an inventory into a ready
// createRegistry config: maxNodes exact, maxLinks scaled by `headroom`,
// prealloc "eager", onCapacityExceeded "throw". Size the whole app at boot, and
// the k+1-th instance you did not budget for throws CapacityError -- loud, named,
// at the front door, not a slow leak in production.
//
// Not gated (cold): capacityFor is boot-time sizing done once; the CapacityError
// it provokes is a boot-time outcome, not a frame path -- see manifest (r3).
//
// Two things worth knowing (decisions/0007): a FIXED-shape derived provisions
// exactly; a BRANCHY derived whose live branch reads more members than the probe
// measured under-provisions and throws at link formation -- raise `headroom`.
// ASCII only.

const RID = "r3";
function assert(cond, msg) {
    if (!cond) {
        process.stderr.write("cookbook " + RID + " FAIL: " + msg + "\n");
        process.exit(1);
    }
}

// #region cookbook:r3.1
import { createRegistry } from "@zakkster/lite-signal";
import { defineReactive, costOf, capacityFor } from "@zakkster/lite-signal-decorators";

// Three view-model classes in one app.
const Enemy = defineReactive(class {}, {
    signals: { hp: 100, x: 0, y: 0 },                       // P=3
    deriveds: { alive: (self) => self.hp > 0 },             // D=1
    effects: {},                                            // E=0  -> nodes 5
});
const Pickup = defineReactive(class {}, {
    signals: { kind: 0, x: 0, y: 0 },                       // P=3, D=0, E=0 -> nodes 4
    deriveds: {},
    effects: {},
});
const Hud = defineReactive(class {}, {
    signals: { score: 0, combo: 0 },                        // P=2
    deriveds: { rank: (self) => (self.score / 1000) | 0 },  // D=1  -> nodes 4
    effects: {},
});

// One config sized for the whole fleet. Nodes are the exact sum of cost.nodes x
// count; you can read the math straight off costOf.
const config = capacityFor([
    [Enemy, 200],
    [Pickup, 64],
    [Hud, 1],
]);
const budgetedNodes =
    costOf(Enemy).nodes * 200 + costOf(Pickup).nodes * 64 + costOf(Hud).nodes * 1;
// #endregion cookbook:r3.1

assert(config.maxNodes === budgetedNodes,
    "maxNodes " + config.maxNodes + " != summed cost " + budgetedNodes);
assert(config.prealloc === "eager", "prealloc must be eager");
assert(config.onCapacityExceeded === "throw", "onCapacityExceeded must be throw");

// #region cookbook:r3.2
// A BRANCHY derived: the no-arg probe sees hp=100 and reads {hp, a} = 2 links,
// but when hp drops to 0 the live branch reads {hp, a, b, c} = 4. Sizing at the
// default headroom 1 provisions the measured 2, so the 4-link branch throws
// CapacityError at link formation. headroom 3 leaves room for the widest branch.
const Threat = defineReactive(class {}, {
    signals: { hp: 100, a: 1, b: 2, c: 3 },
    deriveds: { level: (self) => (self.hp > 0 ? self.a : self.a + self.b + self.c) },
    effects: {},
});
const roomy = createRegistry(capacityFor([[Threat, 4]], { headroom: 3 }));
const Sized = defineReactive(class {}, {
    signals: { hp: 100, a: 1, b: 2, c: 3 },
    deriveds: { level: (self) => (self.hp > 0 ? self.a : self.a + self.b + self.c) },
    effects: {},
    host: { registry: roomy },
});
let widestBranchFits = true;
try {
    for (let i = 0; i < 4; i++) { const t = new Sized(); t.hp = 0; void t.level; }   // widest branch
} catch (_e) {
    widestBranchFits = false;
}
// #endregion cookbook:r3.2

assert(costOf(Threat).links === 2, "branchy probe links " + costOf(Threat).links + " != 2");
assert(widestBranchFits === true, "headroom 3 should fit the 4-link branch");

// #region cookbook:r3.3
// Provoke the CapacityError on purpose. A registry sized for exactly 3 enemies
// builds 3; the 4th is not in your budget, so `new` throws -- fail closed, at the
// boundary, with a name you can catch.
const tight = createRegistry(capacityFor([[Enemy, 3]]));
const Grunt = defineReactive(class {}, {
    signals: { hp: 100, x: 0, y: 0 },
    deriveds: { alive: (self) => self.hp > 0 },
    effects: {},
    host: { registry: tight },
});
let builtBeforeThrow = 0;
let capacityError = null;
try {
    for (let i = 0; i < 4; i++) { new Grunt(); builtBeforeThrow++; }
} catch (err) {
    capacityError = err.name;                                // "CapacityError" at the 4th
}
// #endregion cookbook:r3.3

assert(builtBeforeThrow === 3, "expected 3 builds before throw, got " + builtBeforeThrow);
assert(capacityError === "CapacityError", "expected CapacityError, got " + capacityError);

process.stdout.write(
    "cookbook r3 budget-an-app | maxNodes=" + config.maxNodes + " (exact) headroom-fits-branchy=" +
    widestBranchFits + " capacity-throws-at=" + (builtBeforeThrow + 1) +
    " (" + capacityError + ") | ok\n",
);
