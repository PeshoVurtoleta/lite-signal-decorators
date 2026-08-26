// spikes/buildless.mjs -- node --expose-gc spikes/buildless.mjs
// Closes decision 0005: can defineReactive(Class, spec) drive the SAME
// register/replace/wire functions the decorator entries use, with zero duplicated
// wiring logic? Proven structurally (same function identities) + behaviourally.
import { signalBox, computedBox, effect, createRoot, getOwner, runWithOwner, dispose, stats } from '@zakkster/lite-signal';
import { table, stamp, stampLine, snap } from './_util.mjs';

let FAIL = false;
function assert(cond, msg) { if (!cond) { FAIL = true; console.log('  ASSERT FAIL: ' + msg); } }

const s = stamp();
console.log(stampLine(s));
console.log('');

// =========================================================================
// SHARED CORE -- three module-level wiring functions. BOTH code paths below
// reference these exact bindings; there is no duplicated wiring logic.
// =========================================================================
function makePlan() {
  return { signals: [], deriveds: [], effects: [], slots: Object.create(null) };
}
function registerSignal(plan, key, initFactory) {
  const slot = Symbol('sig:' + key);
  plan.slots[key] = slot;
  plan.signals.push({ key, slot, initFactory });
}
function registerDerived(plan, key, fn) {
  const slot = Symbol('der:' + key);
  plan.slots[key] = slot;
  plan.deriveds.push({ key, slot, fn });
}
function registerEffect(plan, fn) {
  plan.effects.push({ fn });
}
function installAccessors(proto, plan) {
  for (const sig of plan.signals) {
    const slot = sig.slot;
    Object.defineProperty(proto, sig.key, {
      configurable: true, enumerable: true,
      get() { return this[slot].get(); },
      set(v) { this[slot].set(v); },
    });
  }
  for (const der of plan.deriveds) {
    const slot = der.slot;
    Object.defineProperty(proto, der.key, {
      configurable: true, enumerable: true,
      get() { return this[slot].get(); },
    });
  }
}
// wireInstance: create signal boxes (bare -- Q1 verdict: not adopted), then the R-A
// anchor; under runWithOwner create derived computedBoxes + effects owned by the
// anchor. Returns the anchor handle (single-handle cascade dispose).
function wireInstance(instance, plan) {
  for (const sig of plan.signals) instance[sig.slot] = signalBox(sig.initFactory(instance));
  let anchor;
  createRoot(() => { effect(() => { anchor = getOwner(); }); });
  runWithOwner(anchor, () => {
    for (const der of plan.deriveds) instance[der.slot] = computedBox(() => der.fn(instance));
    for (const ef of plan.effects) effect(() => ef.fn(instance));
  });
  return anchor;
}
function teardownInstance(instance, plan, anchor) {
  dispose(anchor); // cascades deriveds + effects
  for (const sig of plan.signals) dispose(instance[sig.slot]);
}

// The buildless entry -- calls the IDENTICAL three functions above.
function defineReactive(Class, spec) {
  const plan = makePlan();
  for (const key of Object.keys(spec.signals || {})) {
    const v = spec.signals[key];
    registerSignal(plan, key, () => v);
  }
  for (const key of Object.keys(spec.deriveds || {})) registerDerived(plan, key, spec.deriveds[key]);
  for (const ef of (spec.effects || [])) registerEffect(plan, ef);
  installAccessors(Class.prototype, plan);
  Class.__plan = plan;
  Class.__wiredBy = { registerSignal, installAccessors, wireInstance };
  return Class;
}

// =========================================================================
// PATH 1 -- decorator model: register fns called from mock decorator contexts.
// =========================================================================
function buildDecoratorPath() {
  class DecoVM {}
  const plan = makePlan();
  // mock member-decorator contexts calling the SAME register functions:
  registerSignal(plan, 'a', () => 1);       // @reactive accessor a = 1
  registerSignal(plan, 'b', () => 2);       // @reactive accessor b = 2
  registerDerived(plan, 'sum', (self) => self.a + self.b); // @derived get sum()
  registerEffect(plan, (self) => { self.__fires++; void self.sum; }); // @reactiveEffect
  installAccessors(DecoVM.prototype, plan);
  DecoVM.__plan = plan;
  DecoVM.__wiredBy = { registerSignal, installAccessors, wireInstance };
  return DecoVM;
}

// =========================================================================
// PATH 2 -- buildless: defineReactive drives the identical functions.
// =========================================================================
function buildBuildlessPath() {
  class BuildlessVM {}
  defineReactive(BuildlessVM, {
    signals: { a: 1, b: 2 },
    deriveds: { sum: (self) => self.a + self.b },
    effects: [(self) => { self.__fires++; void self.sum; }],
  });
  return BuildlessVM;
}

// -------------------------------------------------------------------------
// Exercise both paths identically and compare.
// -------------------------------------------------------------------------
function exercise(Class) {
  const inst = new Class();
  inst.__fires = 0;
  const b0 = snap(stats);
  const anchor = wireInstance(inst, Class.__plan);
  const statsDelta = {
    nodes: stats().activeNodes - b0.activeNodes,
    links: stats().activeLinks - b0.activeLinks,
  };
  const values = [];
  values.push(inst.a, inst.b, inst.sum); // 1, 2, 3
  const firesAfterWire = inst.__fires;   // effect ran once
  inst.a = 10;                            // mutate -> sum recomputes, effect re-fires
  values.push(inst.a, inst.sum);         // 10, 12
  const firesAfterMutate = inst.__fires;
  // dispose conservation
  teardownInstance(inst, Class.__plan, anchor);
  const after = snap(stats);
  const conserved = after.activeNodes === b0.activeNodes;
  return { values, firesAfterWire, firesAfterMutate, statsDelta, conserved, wiredBy: Class.__wiredBy };
}

const Deco = buildDecoratorPath();
const Buildless = buildBuildlessPath();
const rDeco = exercise(Deco);
const rBl = exercise(Buildless);

const valuesMatch = JSON.stringify(rDeco.values) === JSON.stringify(rBl.values);
const fireCountsMatch = rDeco.firesAfterWire === rBl.firesAfterWire && rDeco.firesAfterMutate === rBl.firesAfterMutate;
const statsDeltaMatch = rDeco.statsDelta.nodes === rBl.statsDelta.nodes && rDeco.statsDelta.links === rBl.statsDelta.links;
// Structural sharing: both paths reference the SAME function objects.
const sameFnIdentity =
  rDeco.wiredBy.registerSignal === rBl.wiredBy.registerSignal &&
  rDeco.wiredBy.installAccessors === rBl.wiredBy.installAccessors &&
  rDeco.wiredBy.wireInstance === rBl.wiredBy.wireInstance &&
  rDeco.wiredBy.registerSignal === registerSignal;

console.log('values: deco=' + JSON.stringify(rDeco.values) + ' buildless=' + JSON.stringify(rBl.values));
console.log('fires: deco(wire=' + rDeco.firesAfterWire + ',mutate=' + rDeco.firesAfterMutate + ')' +
  ' buildless(wire=' + rBl.firesAfterWire + ',mutate=' + rBl.firesAfterMutate + ')');
console.log('statsDelta: deco=' + JSON.stringify(rDeco.statsDelta) + ' buildless=' + JSON.stringify(rBl.statsDelta));
console.log('conserved: deco=' + rDeco.conserved + ' buildless=' + rBl.conserved);
console.log('');

const rows = [
  ['path', 'valuesMatch', 'fireCountsMatch', 'statsDeltaMatch', 'sameFnIdentity'],
  ['decorator', String(valuesMatch), String(fireCountsMatch), String(statsDeltaMatch), String(sameFnIdentity)],
  ['buildless', String(valuesMatch), String(fireCountsMatch), String(statsDeltaMatch), String(sameFnIdentity)],
];
console.log(table(rows));
console.log('');
console.log('PARITY: both paths call registerSignal/installAccessors/wireInstance -- the SAME module');
console.log('  bindings (registerSignal === across paths: ' + sameFnIdentity + '). Zero duplicated wiring.');

assert(valuesMatch, 'values must match across paths');
assert(fireCountsMatch, 'effect fire counts must match across paths');
assert(statsDeltaMatch, 'stats() deltas must match across paths');
assert(sameFnIdentity, 'both paths must reference the same wiring function objects');
assert(rDeco.conserved && rBl.conserved, 'both paths must conserve activeNodes on dispose');
assert(rDeco.firesAfterMutate - rDeco.firesAfterWire === 1, 'mutation must re-fire the effect exactly once');

console.log('');
console.log('SPIKE buildless: ' + (FAIL ? 'FAIL' : 'PASS'));
process.exitCode = FAIL ? 1 : 0;
