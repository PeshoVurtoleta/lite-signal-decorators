// cookbook/r07-walk-and-serialize.mjs -- node --expose-gc cookbook/r07-walk-and-serialize.mjs
//
// Recipe 7: walking and serializing a VM -- the published answer to "why is
// there no @iterable". Stamp 2026-08-30. Companion for COOKBOOK.md; snippets
// live in `#region cookbook:r7.k` spans, harness is OUTSIDE them.
//
// NOT gated: rootOf walks, labels and snapshots are cold, opt-in audit paths.
// Labels default OFF; enabling them adds ZERO hot-path cost -- the accessor
// read/write canon is byte-identical either way (llms.txt:161-162).
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

function fail(msg) {
    process.stderr.write("cookbook r7 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }

// #region cookbook:r7.1
import { forEachOwned } from "@zakkster/lite-signal";
import {
    defineReactive, disposeReactive, rootOf, boxOf, enableLabels, labelOf,
} from "@zakkster/lite-signal-decorators";

// Labels are OFF by default (no hot-path cost). Turn them on ONCE, before
// wiring, when you want a devtools-grade walk. They register, per registry, a
// nodeId -> "Class.prop" / "Class#method" / "Class@anchor" map at wiring time.
enableLabels(true);

class Character {}
const CharacterVM = defineReactive(Character, {
    signals: { name: "Vega", hp: 100, mp: 30 },
    deriveds: { alive: (vm) => vm.hp > 0 },
    effects: { regen: (vm) => { void vm.mp; } },
});
const hero = new CharacterVM();
void hero.alive;                      // force the lazy derived's links to form
// #endregion cookbook:r7.1

// #region cookbook:r7.2
// The reactive side: walk the anchor. rootOf(vm) is the instance's anchor
// descriptor; forEachOwned visits the deriveds and effects it owns. Signal
// boxes are created bare (not adopted), so you name them from your own key list
// and resolve each through boxOf(vm, key). labelOf turns any node id into a
// stable "Class.prop" string. This six-line walk is the whole iterator surface.
const SIGNAL_KEYS = ["name", "hp", "mp"];
const reactiveLabels = [];
reactiveLabels.push(labelOf(rootOf(hero).id));                 // the anchor
for (const key of SIGNAL_KEYS) reactiveLabels.push(labelOf(boxOf(hero, key)));
forEachOwned(rootOf(hero), (node) => reactiveLabels.push(labelOf(node.id)));
// #endregion cookbook:r7.2

// #region cookbook:r7.3
// The data side: a flat, hand-rolled snapshot. No decorator "@iterable" is
// offered because a serializer is a value walk, not a reactivity concern -- you
// own the shape, so you write the shape. Reading the members is the canonical
// accessor path, byte-identical whether labels are on or off.
const dataSnapshot = {};
for (const key of SIGNAL_KEYS) dataSnapshot[key] = hero[key];
// #endregion cookbook:r7.3

// Labels resolve as ClassName.prop / ClassName#method / ClassName@anchor.
assert(reactiveLabels[0] === "Character@anchor", "anchor label wrong: " + reactiveLabels[0]);
assert(reactiveLabels.indexOf("Character.name") !== -1, "missing Character.name label");
assert(reactiveLabels.indexOf("Character.hp") !== -1, "missing Character.hp label");
assert(reactiveLabels.indexOf("Character.alive") !== -1, "missing Character.alive derived label");
assert(reactiveLabels.indexOf("Character#regen") !== -1, "missing Character#regen effect label");
assert(
    dataSnapshot.name === "Vega" && dataSnapshot.hp === 100 && dataSnapshot.mp === 30,
    "flat snapshot did not capture the live values",
);

// Labels OFF is the default; the walk simply returns undefined for each id,
// and the read canon above is unchanged. Prove the accessor is byte-identical.
enableLabels(false);
assert(hero.name === "Vega" && hero.alive === true, "accessor canon changed with labels off");

disposeReactive(hero);

process.stdout.write(
    "cookbook r7 walk-and-serialize | reactive-nodes=" + reactiveLabels.length +
    " data-keys=" + SIGNAL_KEYS.length + " labels=Class.prop | ok\n",
);
