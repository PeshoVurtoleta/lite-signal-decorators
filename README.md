# @zakkster/lite-signal-decorators

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-signal-decorators.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-signal-decorators)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Zero-GC](https://img.shields.io/badge/Zero--GC-Engine-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-signal-decorators?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-signal-decorators)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-signal-decorators?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-signal-decorators)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-signal-decorators?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-signal-decorators)
[![lite-signal peer](https://img.shields.io/npm/dependency-version/@zakkster/lite-signal-decorators/peer/@zakkster/lite-signal?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-signal)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational?style=for-the-badge)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](https://opensource.org/licenses/MIT)

> Standard decorators (TC39 decorators proposal, Stage 2.7 since 2026-05; TS
> 5.x / Babel 2023-11 emit unchanged) that turn a plain class into a reactive
> view-model with a measured per-property cost, one deterministic teardown, and
> poison-on-dispose safety -- built on @zakkster/lite-signal.

**`@reactive accessor` fields, `@derived` getters, `@reactiveEffect` methods, `@batched` actions, one `@reactiveHost` wiring site -- and `disposeReactive()` tears the whole instance down in one call, every time, with nothing left dangling. A decorated read costs ~1.0x a hand-written instance-field signal read. An instance costs exactly P + D + E + 1 pool nodes and gives all of them back on dispose. A buildless twin, `defineReactive()`, delivers the identical feature set with zero transpiler.**

```js
import { reactive, derived, reactiveHost, disposeReactive } from "@zakkster/lite-signal-decorators";

@reactiveHost
class Vector {
  @reactive accessor x = 3;
  @reactive accessor y = 4;
  @derived get len() { return Math.hypot(this.x, this.y); }
}

const v = new Vector();
v.len;              // 5
v.x = 6;
v.len;              // 7.211...
disposeReactive(v); // cascade teardown; later touches throw ReactiveDisposedError
```

No base class to extend. No `makeObservable(this, {...})` mirror object to keep in sync. No "did I remember to dispose the reaction?" -- the instance IS the lifetime, and when it ends, every box, computed, and effect it owns ends with it, provably (a 4096-cycle leak gate and a wall-clock churn soak run on every change).

---

## Contents

- [The reactive class layer the ecosystem was missing](#the-reactive-class-layer-the-ecosystem-was-missing)
- [What you get](#what-you-get)
- [How it works](#how-it-works)
- [The half-alive view-model trap](#the-half-alive-view-model-trap)
- [API reference](#api-reference)
- [Composability](#composability)
- [The numbers](#the-numbers)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing (for clients & QA)](#testing-for-clients--qa)
- [Compatibility](#compatibility)
- [Migrating from MobX 7 & signal-utils](#migrating-from-mobx-7--signal-utils)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [FAQ](#faq) - [License](#license)

---

## The reactive class layer the ecosystem was missing

Fine-grained signal engines are function-shaped: `signal()`, `computed()`, `effect()`. Real applications are often class-shaped: an entity in a fleet, a HUD panel, a document model -- a thing with identity, N reactive properties, derived state, reactions, and a *death*. The gap between the two is where reactive class layers historically go wrong: MobX-style decorators bring GC pressure and administration objects; hand-rolling `this.x = signal(0)` per class brings copy-pasted dispose lists that drift out of sync with the fields.

`lite-signal-decorators` is that layer done with lite-signal's discipline: **zero allocation on the hot path, a measured cost for everything else, and fail-closed on every unverified state.** Every property you declare is accounted for -- created at a known point, owned by a known root, destroyed by one call, poisoned afterward so a stale reference throws by name instead of misbehaving silently.

### Install

```bash
npm i @zakkster/lite-signal-decorators @zakkster/lite-signal
```

`@zakkster/lite-signal` (`>=1.5.0 <2.0.0`) is a **peer dependency**, and that is a correctness requirement, not a formality: your decorated instances, your raw signals, and the engine's node pool must live in ONE reactive graph. A second nested copy of the engine would silently split that graph. Install both at the top level.

ESM-only. Ships TypeScript definitions. Node >= 18. The `@` syntax needs a standard-decorators toolchain (TypeScript 5 or Babel `2023-11` -- see [Compatibility](#compatibility)); [`defineReactive`](#definereactiveclass-spec---class) needs nothing.

### Quick start

```js
import {
  reactive, derived, reactiveEffect, batched, reactiveHost, disposeReactive,
} from "@zakkster/lite-signal-decorators";

@reactiveHost
class Player {
  @reactive accessor hp = 100;
  @reactive accessor shield = 50;

  @derived get effectiveHp() { return this.hp + this.shield * 0.5; }
  @derived get status() { return this.effectiveHp > 60 ? "healthy" : "critical"; }

  // Auto-runs as an effect once the instance is wired; re-runs only when
  // `status` actually CHANGES -- the derived's equality cutoff absorbs the rest.
  @reactiveEffect onStatus() { hud.textContent = this.status; }

  // Both writes coalesce into ONE propagation flush.
  @batched hit(dmg) {
    const absorbed = Math.min(this.shield, dmg);
    this.shield -= absorbed;
    this.hp -= dmg - absorbed;
  }
}

const p = new Player();  // exactly 2 + 2 + 1 + 1 = 6 pool nodes (P + D + E + 1)
p.hit(80);               // shield 0, hp 70 -> status still "healthy": effect does NOT re-run
p.hit(20);               // hp 50 -> "critical": effect runs once
disposeReactive(p);      // effect stopped, deriveds + boxes disposed, slots poisoned
```

No transpiler? The **buildless twin** takes a plain class and a spec, and routes through the *same* wiring core (shared by function identity, not merely behaviorally alike) -- this exact form runs in stock Node:

```js
import { batch } from "@zakkster/lite-signal";
import { defineReactive, disposeReactive } from "@zakkster/lite-signal-decorators";

class Player {
  hit(dmg) {
    batch(() => {
      const absorbed = Math.min(this.shield, dmg);
      this.shield -= absorbed;
      this.hp -= dmg - absorbed;
    });
  }
}

const ReactivePlayer = defineReactive(Player, {
  signals: { hp: 100, shield: 50 },
  deriveds: {
    effectiveHp: (self) => self.hp + self.shield * 0.5,
    status: (self) => (self.effectiveHp > 60 ? "healthy" : "critical"),
  },
  effects: { onStatus: (self) => { hud.textContent = self.status; } },
});
```

---

## What you get

- **`@reactive accessor x = v`** -- a per-instance signal box in a unique symbol slot. The read body is one slot load + one monomorphic box call: zero branches, zero allocation.
- **`@derived get y()`** -- a lazy computed owned by the instance's anchor, with optional custom `equals` for change-cutoff.
- **`@reactiveEffect m()`** -- a method that auto-runs as an effect after wiring. Manual calls are leak-guarded (a call inside a foreign tracking scope is untracked, so it records zero stray dependencies) and identity-guarded (a foreign receiver throws by name instead of running against garbage).
- **`@batched m()`** -- the method body inside one engine batch: N writes, one flush. Action-grade by design, with a measured per-call cost -- not a per-frame path.
- **`@reactiveHost`** -- the single wiring site. Its most-derived constructor builds the anchor, every derived, and every effect exactly once, after all fields of all classes in the chain initialize. `@reactiveHost({ registry })` binds the whole chain to an isolated lite-signal registry.
- **`defineReactive(Class, spec)`** -- the complete feature set with zero decorator syntax.
- **One deterministic teardown** -- `disposeReactive(vm)` (or a `using` block): anchor cascade, box disposal, poison swap, idempotent, allocation-free on the success path.
- **Fail-closed everything** -- statics, private `#` members, unknown options, duplicate keys, orphaned members, invalid registries, half-valid specs: all named throws at decoration time, with a nearest-key did-you-mean where a typo is likely.
- **Interop that stays raw** -- `boxOf(vm, key)` hands you the live engine box; `rootOf(vm)` hands the anchor descriptor to `forEachOwned` / lite-devtools. Decorated and hand-written signals share one graph.

---

## How it works

```mermaid
flowchart TB
    A["new Player()"] --> B["field init: each @reactive creates its<br/>signal box in a symbol slot<br/>(scratch-frame tracked)"]
    B --> C["most-derived wrapper wires ONCE:<br/>anchor root -> every @derived -> every @reactiveEffect"]
    C --> D["LIVE: reads track, writes propagate,<br/>effects re-run on real changes"]
    D --> E["disposeReactive(p) / end of using block"]
    E --> F["anchor cascade: effects + deriveds die"]
    F --> G["each signal box disposed -> nodes return to the pool"]
    G --> H["every slot swapped for POISON:<br/>any later touch throws ReactiveDisposedError"]
    B -. "throw at ANY point" .-> R["frame drained LIFO:<br/>zero nodes leak (atomic construction)"]
    C -. "throw at ANY point" .-> R
```

Decoration happens once per class: each decorator validates its placement (fail closed) and registers the member in the class's wiring plan. Construction happens per instance: field initializers create the signal boxes, then the most-derived `@reactiveHost` wrapper -- and only it, so inheritance chains wire exactly once -- creates one anchor root and, under that owner, every derived and every effect in declaration order. Disposal reverses it: the anchor cascade takes the deriveds and effects, the boxes are disposed explicitly, and every slot is replaced by a poison handle.

<details>
<summary><strong>Deep-dive: the core surface, mechanically</strong></summary>

**The hot path is canon.** The accessor bodies are frozen as:

```js
function makeGet(slot) { return function () { return this[slot].get(); }; }
function makeSet(slot) { return function (v) { this[slot].set(v); }; }
```

One symbol-slot load, one monomorphic call, no branch, no closure state beyond the slot. The zero-GC torture lane diffs behavior against this shape on every change; the storage layout (a unique per-property `Symbol` on the instance) was chosen over a private-backing or dictionary layout on measured fleet behavior and poison-mechanism consistency ([decisions/0003](decisions/0003-storage.md)).

**Ownership is asymmetric on purpose.** The anchor (one `createRoot` per instance) owns the deriveds and effects, so one cascade kills them all in the engine. Signal boxes are created *bare* -- not adopted by the anchor -- and disposed explicitly by `disposeReactive`. That split is what makes the accessor read body branch-free: a box that can never be half-owned needs no liveness check on the hot path; the poison swap provides the post-dispose throw instead.

**Poison is a slot swap, not a flag.** After dispose, `instance[SLOT]` holds a poison handle whose `get`/`set` throw `ReactiveDisposedError` naming `Class.key`. The read body stays the unbranched canon -- disposal changes what the slot *holds*, never what the accessor *does*.

**Effects wire last and guard their manual door.** The auto-effect wraps the original method and starts at wiring, after every field and every derived of the whole chain exists. The public method you call by hand is a guard: inside a foreign tracking scope it runs the body `untrack`-ed (zero stray edges); on a receiver that was never wired to this member's class family it throws by name (byKey identity, so a subclass instance calling a base-declared method passes).

**Construction is atomic at every capacity point.** Signal boxes are born during `super()` field initialization -- *before* any try/catch of the wiring phase could exist. A module-level scratch frame records each box as it is created; the frame is owned by the most-derived wrapper only, so a `CapacityError` (or any throw) at ANY point -- K-th box, the anchor, m-th derived, m-th effect, on either construction path -- drains the frame LIFO through the bound registry and rethrows. `new` either returns a fully-wired instance or leaves the pool exactly as it found it. Nested constructions (a field initializer building another reactive VM) unwind correctly because the frame marker is a stack index. ([decisions/0002](decisions/0002-ownership-and-lifecycle.md), D-2h -- including the two hardenings review and torture forced.)

</details>

---

## The half-alive view-model trap

The failure mode this package is built against is not "reactivity doesn't work" -- it is the **half-alive instance**: an object that looks disposed from one side and alive from the other. It has three classic doors, and each one is closed and torture-pinned:

**1. The dangling-teardown door.** In ad-hoc class reactivity you collect dispose functions by hand; miss one and a dead panel keeps recomputing forever. Here the instance's whole graph hangs off one anchor plus a box list the *package* maintains, `disposeReactive` is idempotent, and -- the part hand-rolled layers never do -- every slot is **poisoned** afterward. A stale captured reference doesn't quietly read a frozen value or resurrect an effect; it throws `ReactiveDisposedError` with the class and key in hand. A scripted resurrection storm (every post-dispose call sequence: captured-box writes, `using` re-entry, double dispose, cross-instance writes) must produce zero effect executions and zero derived recomputes, on every release.

**2. The cross-registry door.** lite-signal's default `dispose` is documented as a *silent no-op* across registries -- the engine's one fail-open corner. A class layer that creates boxes on a custom registry but disposes through top-level helpers would leak every node while returning normally. So the package refuses the door entirely: `@reactiveHost({ registry })` binds the WHOLE host chain, every engine call routes through the bound registry, and a subclass trying to bind a *different* registry is a named throw. One chain, one graph, no silent mismatch.

**3. The mid-construction door.** A capacity overflow while the K-th of P boxes is being created would classically leak boxes 1..K-1 -- `new` throws, nobody owns the orphans, conservation is off by K-1 forever. The scratch-frame protocol ([deep-dive above](#how-it-works)) makes construction transactional: any throw at any creation point tears down exactly what was built, LIFO, and rethrows. The torture suite primes a registry to N-epsilon and drives the overflow into *every* failure point on *both* construction paths, asserting node-exact conservation and that the identical construction succeeds once headroom returns.

---

## API reference

### Member decorators

All four take a bare form and a factory form (`@reactive` and `@reactive({...})` both work).

| Decorator | Placement | Options | Behavior |
|---|---|---|---|
| `@reactive` | `accessor x = v` | `equals(a, b)` | Per-instance signal box in a symbol slot. Read tracks; write propagates; custom `equals` suppresses no-op writes. |
| `@derived` | `get y()` | `equals(a, b)` | Lazy computed owned by the anchor. Recomputes on dependency change; `equals` cuts propagation when the result is unchanged. |
| `@reactiveEffect` | `m()` | `scheduler(run)` | Auto-runs as an effect at wiring, re-runs on tracked changes. `scheduler` defers re-runs (frame coalescing etc.). Manual calls: leak-guarded + identity-guarded. |
| `@batched` | `m()` | -- | Runs the body inside one engine batch: all writes flush once, at close. Nesting flushes at the outermost close. Action-grade -- see [the numbers](#the-numbers). |

### Class decorator

| Form | Behavior |
|---|---|
| `@reactiveHost` | The single wiring site; wraps the class so the anchor + deriveds + effects are built exactly once, after all fields of the whole chain initialize. A subclass of a host may itself be a host (inheriting or repeating the chain's registry) -- however many hosts a chain carries, only the most-derived one wires. A decorated member in a hierarchy that never gets a host is the orphan throw. |
| `@reactiveHost({ registry })` | Same, with every engine call routed through a `Registry` from lite-signal's `createRegistry()`. The value is duck-checked (all 11 engine methods); one registry per host chain -- a subclass may repeat the same object or omit it, never substitute another. |

### `defineReactive(Class, spec) -> Class'`

The buildless twin. Installs the members on `Class.prototype`, wraps the class through the same host step, returns the wrapped class.

| Spec key | Shape | Notes |
|---|---|---|
| `signals` | `["a", "b"]` or `{ key: value \| { initial \| init \| equals } }` | A plain non-function value is the initial. `initial` is taken verbatim; `init(self)` computes per instance; a bare function is a named throw (ambiguous -- wrap it). |
| `deriveds` | `{ key: (self) => value \| { get, equals } }` | |
| `effects` | `{ key: (self) => void \| { run, scheduler } }` | Map only. |
| `host` | `{ registry }` or omitted | Same validation as `@reactiveHost`. |

Symbol keys work (`Reflect.ownKeys`). A spec key colliding with an own property of `Class.prototype` is a named throw. The class's own constructor runs *before* wiring, so it must not touch spec-declared members (a prewired handle turns any such touch into a named error) -- put initials in the spec. There is no `batched` section: buildless callers use `batch`/`registry.batch` directly. Post-construction behavior is in full parity with the decorator path -- a 300-seed fuzzer holds both forms in lockstep to prove it.

### Lifecycle & interop

| Export | Signature | Behavior |
|---|---|---|
| `disposeReactive` | `(vm) => boolean` | Cascade + poison teardown. `true` on the first call, `false` after (idempotent). Also wired to `Symbol.dispose`, so `using vm = new Player()` disposes at block exit. Refuses a frozen instance up front (named throw, nothing half-done). |
| `releaseReactive` | `(vm) => boolean` | Park a LIVE instance to the engine pool: cascade the anchor, dispose each box, swap every slot to a PARKED handle (touch throws `ReactiveDisposedError` with a *parked* message), keep the prebuilt wiring closures. A parked instance holds ZERO engine nodes. `true` on first release, `false` on park->park (idempotent). Fails closed on a disposed, unwired, frozen, or non-reactive value. Pooled-lifetime contract: [decisions/0010](decisions/0010-reinit-contract.md), [0011](decisions/0011-reinit-api.md). |
| `reinitReactive` | `(vm, initials?) => vm` | Revive a PARKED instance: rebuild each box (`initials[key]` wins, else the plan initial), rebuild anchor + deriveds + effects through the SAME prebuilt closures, restore live slots (values reset). Atomic -- a throw mid-reinit lands the instance DISPOSED (a failed revival is final). Fails closed on a live, disposed, frozen, unwired, or non-reactive value. |
| `boxOf` | `(vm, key) => SignalBox \| ComputedBox` | The live engine box behind a `@reactive`/`@derived` member -- `.peek()`, `.subscribe()`, raw interop. Unknown key: named throw with a did-you-mean. After dispose: `ReactiveDisposedError`. |
| `rootOf` | `(vm) => NodeDescriptor` | The instance's anchor descriptor -- feeds `forEachOwned` and lite-devtools. Throws `ReactiveDisposedError` after dispose. |

### Introspection & audit (1.0.0)

| Export | Signature | Behavior |
|---|---|---|
| `costOf` | `(Factory) => { nodes, links, signals, deriveds, effects }` | The measured, settled per-instance cost, probed on the class's bound registry (frozen result, cached per class). Double-probed: an inconclusive or polluted probe THROWS -- never a guess. `nodes` is exactly P + D + E + 1; `links` is the first-full-read link count. |
| `capacityFor` | `(inventory, { headroom }?) => RegistryConfig` | Sizes a `createRegistry` config from `[Factory, count]` pairs: nodes exact, links x `headroom` (floored at the engine minimum of 1), `prealloc: "eager"`, `onCapacityExceeded: "throw"`. Fail-closed inventory and options validation. Link policy + caveats: [decisions/0007](decisions/0007-capacity-policy.md). |
| `enableLabels` / `labelOf` | `(on)` / `(idOrHandle, registry?) => string \| undefined` | Opt-in devtools identity (default OFF): while on, wiring registers per-registry `nodeId -> "Class.prop"` / `"Class#method"` / `"Class@anchor"`; dispose unregisters. `labelOf` misses return `undefined`, never throw. |
| `auditReactive` | `(on)` | Opt-in leak auditor (default OFF): a lazily-created `FinalizationRegistry` reports any instance collected WITHOUT `disposeReactive`, naming class and shape. Holds no instance references itself; zero cost and zero registrations while off. |

With labels and audit off, the zero-GC budgets are byte-identical to 0.3.0 -- the hot accessor canon is untouched by all four (review-diffed against the published 0.3.0 tarball).

### Errors & constants

| Export | Value |
|---|---|
| `ReactiveDisposedError` | `extends Error`; `name: "ReactiveDisposedError"`; fields `className`, `key`. Thrown on ANY touch of a disposed instance's surface. |
| `VERSION` | `"1.1.1"` |

### The rejection matrix

Everything below is a **named throw at decoration/definition time** -- never a silent downgrade: legacy (experimental) decorator emit; wrong decorator kind; static members; private `#` members; unknown option keys (nearest-key did-you-mean); non-function `equals`/`scheduler`; double `@reactiveHost`; unknown host options; orphaned members (a decorated member whose class never gets a host); duplicate keys (subclass redeclaration or two stacked package decorators on one member); an invalid or partial `registry`; a heterogeneous registry chain; and every malformed `defineReactive` spec shape.

---

## Composability

Decorated instances, raw engine code, an isolated registry, and devtools introspection -- one graph, end to end. This block is buildless, so it runs verbatim in stock Node:

```js
import { createRegistry } from "@zakkster/lite-signal";
import { defineReactive, disposeReactive, boxOf, rootOf } from "@zakkster/lite-signal-decorators";

// An isolated world: its own node pool, its own graph.
const world = createRegistry({ maxNodes: 256, onCapacityExceeded: "throw" });

class Ship {}
const ReactiveShip = defineReactive(Ship, {
  signals: { hull: 100 },
  deriveds: { dead: (self) => self.hull <= 0 },
  host: { registry: world },
});

const fleet = Array.from({ length: 3 }, () => new ReactiveShip());

// A RAW engine effect in the same graph, reading a decorated member:
const stop = world.effect(() => {
  console.log("dead ships:", fleet.filter((s) => s.dead).length);
});                                    // logs: dead ships: 0

fleet[1].hull = 0;                     // decorated write -> raw effect: dead ships: 1

// boxOf hands the live box -- raw writes flow back the other way:
boxOf(fleet[0], "hull").set(-5);       // raw write -> decorated derived: dead ships: 2

// rootOf feeds the registry's ownership walk (and lite-devtools):
world.forEachOwned(rootOf(fleet[2]), (d) => console.log("owned node:", d.kind));

// Deterministic shutdown, conservation-exact:
world.dispose(stop);
for (const s of fleet) disposeReactive(s);
console.log(world.stats().activeNodes); // 0 -- every node returned to the pool
```

The default registry never notices any of it: bound-registry churn leaves outside `stats()` frozen (torture-pinned). And because `boxOf` returns the *engine's* box, everything lite-signal composes with -- subscriptions, `peek`, batch, untrack, lite-raf frame effects -- composes with decorated members too.

### Predicate-gated watchers (`@zakkster/lite-watch-ex`)

`lite-watch-ex` adds one-shot, pausable, and change-gated watchers over the same engine. Its sources are plain **thunks** (`() => vm.hp`, never a box handle), and every watcher creates its effect node in the **default registry** -- so wire one only to a **default-registry** instance (one with no `host.registry`), never across a custom-registry fleet, where the edge would cross a boundary the engine's default `dispose` cannot see:

```js
import { watchUntil } from "@zakkster/lite-watch-ex";
import { defineReactive } from "@zakkster/lite-signal-decorators";

// Default-registry instance -- no host.registry, so it lives in the default graph.
const ReactivePlayer = defineReactive(class Player {}, { signals: { hp: 100 } });
const vm = new ReactivePlayer();

// Fires ONCE when hp crosses the threshold, then self-disposes:
watchUntil(() => vm.hp, (h) => h <= 25, (h) => console.log("low hp:", h));

vm.hp = 40;  // predicate false -> no fire
vm.hp = 20;  // predicate true  -> "low hp: 20", watcher disposes itself
```

The [`fleet-playground` demo](demo/fleet-playground.html) shows the safe split at scale: decorated entity VMs in an enforced custom registry, all watchers on a separate default-registry telemetry plane.

---

## The numbers

Measured, not asserted: every figure below comes from a committed probe you can re-run, and the repository's gates fail if the zero-allocation claims drift. Rig for the figures quoted: Node v26.3.1, arm64 (Apple M4 Pro), lite-signal 1.5.0, K=10 cold child processes, inner median-of-5, anti-DCE sink. The ratios are what is stable across machines, not the absolute nanoseconds.

### The honest read cost (`spikes/storage-bench.mjs`)

The fair baseline for a decorated property is a hand-written instance field (`this.bx.get()`) -- not a module-level signal, which no one writes in a class:

| Read | vs module-const box | vs instance-field box | 10k-instance fleet (ns/op) |
|---|---:|---:|---:|
| Module-const `signalBox` (floor) | 1.000x | 0.464x | 5.22 |
| Hand-written instance field | 2.13x | 1.000x | 6.57 |
| **Decorated accessor (this package)** | **2.12x** | **~1.0x** (median 1.01x, worst cold-vs-cold 1.08x) | **7.81** |
| String-keyed dict layout (rejected) | 2.19x | 1.03x | 9.93 |

A decorated reactive property costs **~1.0x a hand-written instance-field signal read**; both are ~2x a module-level signal because that is the cost of per-instance storage, paid either way -- an engine indirection, not a decorator tax. Writes are ~2.5-3x a module-const read across all instance layouts (box `.set` propagation dominates; inherent to any reactive write). The rejected dictionary layout is the one that *degrades at fleet scale* (cross-instance IC megamorphism) -- the hazard only a class-shaped benchmark exposes, and the reason this package doesn't use one.

### `@batched` per call (`spikes/batched-cost.mjs`)

| Path | ns/op |
|---|---:|
| Plain unbatched method (2 writes) | 11.67 |
| Raw `batch(fn)` | 15.25 |
| `@batched` method | 22.12 |

The ~7 ns over raw batch is the guarded thunk + rest-array the decorator allocates per call -- **by design**. `@batched` is action-grade (one call per user intent), deliberately excluded from the zero-GC gates; per-frame hot lanes stay on plain accessor writes.

### Per instance

`P + D + E + 1` pool nodes -- one per signal, per derived, per effect, plus the anchor. All of them return to the pool on dispose: conservation is node-exact (`activeNodes` to baseline, zero pool growths, allocations minus disposals reconciled) over 4096-cycle churn and a wall-clock soak.

<details>
<summary><strong>Zero-GC design notes: the allocation table + the gates</strong></summary>

| Operation | Allocates | Notes |
|---|---|---|
| `vm.x` read | none | `this[SLOT].get()` -- allocation-free within measurement resolution (<= the 0.589 B/op noise-floor control; `gc.major === 0` in every lane) |
| `vm.x = v` write | none | `this[SLOT].set(v)`; propagation runs on engine pool nodes, not fresh heap |
| `@derived get` read | none | lazy computed read |
| Effect re-run | none retained | gated: zero major GC across the read/write torture lanes |
| `@batched m()` call | 1 thunk + 1 rest array | the documented, measured exception (+7 ns vs raw batch); action-grade only |
| `new Host()` | P + D + E + 1 pool nodes | plus the instance itself; nodes recycle on dispose (F-0 conservation) |
| `disposeReactive(vm)` | none | allocation-free success path; poison handles are prebuilt per member at decoration time |
| `boxOf` / `rootOf` / any throw | cold path | introspection and failure paths may allocate; never on the hot path |

The gates that hold it (run on every change, all green at 1.1.1):

- `npm test` / `npm run test:gc` -- **257/257** on both lanes.
- Suite gate (lite-leak + lite-gc-profiler): `leak=size 0/0 findings=0 warnings=0 | gc major=0 minor=0 maxMs=0.00 | ok`.
- Torture: **16 scenarios** (zero-GC read/write lanes at `maxMajor 0, maxPauseMs 4`; 4096-cycle leak gate at 0 live / 0 findings / 0 warnings; capacity atomicity at every overflow point; a 300-seed x 20k-op oracle with zero divergences; the `reinit-torture` acquire/release gate) -- **14 run + 2 that skip correctly below their peer floors** (`scope-adoption` needs 1.6.0, `using-dispose` needs 1.9.0; the installed peer is 1.5.0). A skip *below* a floor is the forward-compat design working; a skip *at or above* it is a FAIL (run.mjs enforces floor-escalation). Every scenario carries a `TORTURE_BREAK` sabotage control that must exit non-zero -- **16/16 controls** prove each gate can actually fail.
- `churn-soak` + `fleet-soak`: sustained construct/use/dispose and a 10s 2k-VM fleet tick; pools at floor and retained heap flat at every sample.

The cross-framework matrix lives in `bench/` (private, never shipped): six engines -- both our tiers, the hand-written `lite-raw-boxes` baseline, MobX 7, signal-utils/signal-polyfill, and a hand-rolled alien-signals class -- across eight class-shaped scenarios (including the `churn-reuse` acquire/release lane, where the lite tiers pool with zero retained growth and MobX/signal-utils/alien-class are structurally `unsupported` -- no disposable instance lifecycle to pool), checksum-verified for identical work, stamped into `bench/results.txt`. The formal verdicts are in [`decisions/0006-kill-criteria.md`](decisions/0006-kill-criteria.md): the decorated path measured **0.94x** the hand-written baseline on vm-write and **1.10x** on a 10k-instance fleet read (the 2.0x kill line cleared with margin), and **0 major + 0 minor GC over 4096 construct/use/dispose cycles** with pools at floor -- while emitting ~12.6x less transient garbage per churn run than the hand-rolled class it replaces.

![CHURN benchmark: ops/s and transient heap per adapter](https://raw.githubusercontent.com/PeshoVurtoleta/lite-signal-decorators/main/bench/results-chart.svg)

The chart above is generated from the stamped `bench/results.txt` by `bench/chart.mjs` (`node bench/chart.mjs`) -- it plots the CHURN lane for every adapter at full scale, including `alien-class`, the hand-rolled reference that has no disposable instance lifecycle to pool.

</details>

---

## Design decisions worth knowing

Full rationale lives in [`decisions/`](decisions/) -- each is a numbered, dated record with its measured evidence. The ones that shape daily use:

- **One registry per host chain.** `@reactiveHost({ registry })` binds everything; a descendant passing a *different* registry is a named throw. This is what closes the engine's silent cross-registry dispose no-op. `setDefaultRegistry` mid-life is out of contract (the facade captures import-time bindings).
- **Derived getters must be pure -- effects may self-dispose.** `disposeReactive(this)` from inside your own `@derived` computation throws by name (it would silently drop the derivation's value). From inside an *owned* `@reactiveEffect` it is allowed with pinned semantics: the current run completes, later decorated touches in that body throw `ReactiveDisposedError`, no re-runs follow, conservation stays exact.
- **Two documented limits of the derived guard** (pinned in torture so drift is loud): an indirect self-dispose routed through an intermediate *raw* computed is not catchable with the 1.5.0 engine surface, and an explicit `untrack()` wrap bypasses the guard -- the escape hatch working as intended.
- **Manual effect/batched calls are guarded twice.** Inside a foreign tracking scope the body runs untracked (zero stray dependency edges); on a foreign/null/primitive/cross-class receiver it throws by name. Subclass instances calling base-declared methods pass (byKey identity).
- **Frozen instances refuse disposal up front.** `Object.freeze(vm)` makes the poison swap impossible, so `disposeReactive` throws by name *before* touching anything -- no half-dispose. `seal`/`preventExtensions` are fine.
- **Symbol-slot storage.** Chosen over the emitter's private backing (emitter-dependent codegen) and a dict (fleet megamorphism, measured) -- and it is the same mechanism poison uses, so storage, dispose, and poison are one design.
- **Statics and `#` privates are rejected, not half-supported.** A module-level signal belongs to raw lite-signal; a private member can't be reached by the wiring protocol -- both are named decoration-time throws.
- **Pooled reinit is an identity-stable arena tool, not a speed shortcut (1.1.0).** `releaseReactive(vm)` parks a live instance to the engine pool and `reinitReactive(vm, initials?)` revives it -- a three-state lattice (live / parked / disposed) over the same instance, so consumers keep the object reference across turnover. It holds its gate: over 4096 acquire/release cycles at the churn shape (P=4, D=2, E=1) it measures **0 major GC**, retained delta-heap **at or below the in-process zero-alloc control**, and exact pool conservation (`activeNodes` back to baseline, zero pool growths, a parked instance holding 0 engine nodes). The honest throughput number, same shape, 2026-08-30 stamp (module 1.1.0): plain construct/dispose CHURN is *faster* -- **1323K ops/s** vs reuse's **1159K** -- because construction is already allocation-light and pool-conserving, so reinit is not a per-op win. Reach for it when you need identity-stable pooled instances under sustained turnover with zero retained growth (an arena/fleet primitive), not when you want raw op speed. MobX has no equivalent lifecycle at all: its instances are never disposable, so there is no release/reinit cycle to pool ([decisions/0010](decisions/0010-reinit-contract.md), [0011](decisions/0011-reinit-api.md)).

---

## Testing (for clients & QA)

```bash
npm test            # node --test, 257 tests
npm run test:gc     # the same 257 with --expose-gc (enables the allocation assertions)
npm run gate        # the full pre-publish chain (section 10): fixtures -> test -> test:gc -> torture -> controls -> peer-preview (non-blocking) -> bench selftest -> cookbook -> pack
```

**257 tests** across sixteen files, all green at 1.1.1. The decorator protocol is tested three times over: against a mock standard-decorators emitter *and* against committed real TypeScript 5 and Babel `2023-11` emits, so both toolchains' codegen is pinned, not assumed.

| File | Tests | Covers |
|---|---:|---|
| `01-protocol-mock` | 30 | Decorator protocol on the mock standard-decorators emitter: wiring, values, options, rejection matrix |
| `02-fixtures-ts` | 19 | The same laws on real TypeScript 5 emit (committed fixtures) |
| `03-fixtures-babel` | 19 | The same laws on real Babel `2023-11` emit |
| `04-fixture-freshness` | 2 | Fixture hashes match the sources (stale-emit guard) + the README emit-matrix block matches its generator |
| `05-wiring` | 5 | Anchor creation, wiring order, leaf-wires-once |
| `06-dispose` | 6 | Cascade, idempotency, poison, `using` |
| `07-qa-boundary` | 13 | S1 adversarial boundary pins |
| `08-effects` | 20 | `@reactiveEffect`/`@batched`: auto-run timing, untracking, scheduler, self-dispose, inheritance, registries |
| `09-buildless` | 16 | `defineReactive` parity + the spec rejection matrix |
| `10-qa-s2a-boundary` | 34 | Adversarial pins: identity guard, frozen dispose, registry heterogeneity, stacking |
| `11-qa-s2b-boundary` | 8 | Construction-throw boundaries: init-phase drain, chain-base throws, overflow storms |
| `12-accounting` | 11 | `costOf` node/link/shape grid (double-probe, frozen + cached, fail-closed) + `capacityFor` budget sizing |
| `13-labels-audit` | 10 | `enableLabels`/`labelOf` per-registry identity + `auditReactive` leak reporting, both opt-in and default-OFF |
| `14-qa-s4-boundary` | 21 | S4 adversarial edges: stats-less facade closure, signals-only capacity floor, label/audit boundary matrix |
| `15-cookbook` | 14 | [`COOKBOOK.md`](https://github.com/PeshoVurtoleta/lite-signal-decorators/blob/main/COOKBOOK.md) drift/parity: each fenced block byte-compared against its tagged companion `#region` (both directions + both-way coverage), surface freeze (exactly 18 exports), citation allowlist, link law, static-cost probe |
| `16-reinit` | 29 | Pooled-reinit lattice on both emit lanes: park/reinit/dispose transitions, the five `reinitReactive` fail-closed states, parked-touch throws by name, `initials` boundary matrix (0..N+1 keys, null/undefined, NaN/-0 verbatim), `Symbol.dispose` on a parked instance, accessor descriptors byte-identical across reinit, self-release re-entrancy, ledger conservation |

### Emit-support matrix

Three fixture sources, two standard-decorators emitters, both emit lanes -- every cell below is a committed, hash-pinned fixture (the `04-fixture-freshness` guard above). The table is generated from the fixture manifest, so a re-emit that changes a byte is loud, not silent:

<!-- EMIT-MATRIX:START -->
Generated by `node test/fixtures/emit-matrix.mjs` from `test/fixtures/hashes.json` -- do not hand-edit. Toolchain pinned by the committed fixtures: **TypeScript 5.9.3**, **@babel/core 7.29.7** + **@babel/plugin-proposal-decorators 7.29.7** (`version: 2023-11`). Each `sha256` is the first 12 hex of the committed emit; `npm run fixtures` regenerates and `test/04-fixture-freshness` fails loudly on any drift.

| Source | Emitter | Emit lane | Compiled output | sha256 | At decoration time |
|---|---|---|---|---|---|
| `fixture.src.ts` | TypeScript 5 | standard 2023-11 | `ts-out/fixture.src.js` | `1a3fc0f943bf` | accepted -- full decorator surface wired + pinned green |
| `fixture.src.ts` | Babel | standard 2023-11 | `babel-out/fixture.src.js` | `eb9dfb5939b1` | accepted -- full decorator surface wired + pinned green |
| `static.src.ts` | TypeScript 5 | standard 2023-11 | `ts-out/static.src.js` | `d2a03e3d5f70` | rejected -- static member is a named throw at decoration time |
| `static.src.ts` | Babel | standard 2023-11 | `babel-out/static.src.js` | `dc936c5aa235` | rejected -- static member is a named throw at decoration time |
| `legacy.src.ts` | TypeScript 5 | legacy (experimental) | `ts-legacy-out/legacy.src.js` | `c1059b1d37b1` | rejected -- legacy emit -> named rejection at decoration time |
| `legacy.src.ts` | Babel | legacy (experimental) | `babel-legacy-out/legacy.src.js` | `1d35a02c57ce` | rejected -- legacy emit -> named rejection at decoration time |

Source hashes: `fixture.src.ts` `fb492a396340`, `static.src.ts` `81fb649965e6`, `legacy.src.ts` `30ac3dabaf7c`.
<!-- EMIT-MATRIX:END -->

### The torture suite (dev-side, never shipped)

Process-isolated stress scenarios built on `@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`:

```bash
npm run torture             # all 16 scenarios (14 run + 2 floor-gated skips)
npm run torture:semantic    # the correctness lane (CI)
npm run torture:soak        # the wall-clock churn + fleet soaks
npm run torture:controls    # sabotage self-test: every scenario must FAIL when broken
```

Sixteen scenarios: emit-matrix, ordering, lifecycle, pool-conservation, zero-GC lanes, capacity atomicity (every overflow point x both construction paths), the full disposed-poison surface + resurrection storms, a 4096-cycle lite-leak gate, a **300-seed x 20k-op oracle fuzzer** (decorated vs hand-wired raw twin in lockstep: every derived value, every effect fire count, every graph opcode tally), raw/decorated interop + cross-registry + `registry.destroy()` contracts, batch/untrack semantics, the `reinit-torture` acquire/release gate (4096 pooled cycles: `maxMajor 0`, retained delta-heap at/below the in-process zero-alloc control, exact pool conservation), the wall-clock churn soak, and a 10s 2k-VM fleet soak -- plus two forward-compat scenarios (`scope-adoption`, `using-dispose`) that **skip correctly** while the installed peer sits below their per-feature floors (1.6.0 `createScope`, 1.9.0 `Symbol.dispose`). A skip below a floor is the design working; a skip at or above it is a FAIL. On the installed 1.5.0 peer: 14 pass, 2 skip. Every scenario carries a `TORTURE_BREAK` sabotage control that must exit non-zero -- a gate that cannot fail is not a gate. Seeded lanes replay exactly via `TORTURE_SEED`.

### The cookbook lane (dev-side, never shipped)

Every code block in [`COOKBOOK.md`](https://github.com/PeshoVurtoleta/lite-signal-decorators/blob/main/COOKBOOK.md) is byte-identical to a runnable companion in `cookbook/` (dev-only, never in `files[]`):

```bash
npm run cookbook            # run all 12 companions under node --expose-gc
npm run cookbook -- --controls  # sabotage sweep: every gated recipe must FAIL when broken
npm run cookbook -- --list      # the manifest: id, title, tier, gc verdict
```

Twelve recipe companions, six of them GC-gated (r1, r2, r4, r5, r9, r10) at the S1 budget (`gc.major === 0`, `maxPauseMs <= 4.0`, `<= 0.589` B/op with control-relative minors) and each carrying a `COOKBOOK_BREAK=<id>` sabotage control; the other six publish a non-empty reason in the manifest. Latest lane tails: `cookbook lane: 12/12 companions ok in 1.8s` and, under `--controls`, `cookbook lane: 6/6 controls fail correctly in 4.6s`. `test/15-cookbook.test.mjs` drift-checks the document against the companions in both directions (a one-byte edit either side fails, naming the recipe), and the gate runs the lane as a blocking step -- the chain is now 8 blocking steps + 1 non-blocking.

### The fleet demo (dev-side, never shipped)

A single-file instrument console -- [`demo/fleet-playground.html`](demo/fleet-playground.html) -- drives a two-plane capacity fleet: decorated entity VMs in an enforced custom registry, telemetry watchers in the default registry. Its DOM-free core runs headless under the same gates the library uses:

```bash
npm run demo:build          # esbuild bundle -> demo/bundle.js + rewrite demo/bundle.sha256
npm run demo:check          # verify the committed bundle matches its recorded hash
npm run demo:gc             # headless GC-budget lane over the fleet core (maxMajor 0)
npm run demo:storm          # headless dispose-storm retention lane (lite-leak, size 0)
```

The `demo/` directory is dev-only -- it never enters `package.json` `files[]` and never ships to consumers.

---

## Compatibility

| Path | Requirement |
|---|---|
| `@` decorator syntax | A standard-decorators (2023-11) toolchain: **TypeScript >= 5.0** (standard decorators -- leave `experimentalDecorators` unset/false) or **Babel** with `["@babel/plugin-proposal-decorators", { "version": "2023-11" }]`. Both emits are first-class: the suite pins each with committed fixtures. |
| `defineReactive` | Nothing. Any ESM runtime. |
| Runtime | Node >= 18 (ESM-only, `sideEffects: false`); browsers via any ESM bundler or native modules. No DOM dependency anywhere in the package. |
| Peer | `@zakkster/lite-signal` `>=1.5.0 <2.0.0`, installed at the top level (one engine instance, one graph). |

Native (untranspiled) `@` decorators in engines: not shipped anywhere yet -- until they are, the decorator syntax is toolchain-only and `defineReactive` is the no-build door.

---

## Migrating from MobX 7 & signal-utils

The decorator vocabulary maps almost one-to-one; what changes is the lifetime story. Both libraries below leave teardown to the garbage collector -- this package makes it a single deterministic call.

### From MobX 7

| MobX 7 | lite-signal-decorators |
|---|---|
| `@observable accessor x` | `@reactive accessor x` |
| `@computed get y()` | `@derived get y()` |
| `@action m()` | `@batched m()` |
| `makeObservable(this, {...})` | `@reactiveHost` -- one wiring site, no mirror object to keep in sync |
| `reaction(...)` / `autorun(...)` | `@reactiveEffect m()` |
| reaction disposers only; the instance itself is never disposable | **`disposeReactive(vm)` -- one call, idempotent, node-exact, and every later touch throws by name. MobX has no equivalent; its per-instance graph ends when the collector decides.** |

### From signal-utils

Verified against the installed `signal-utils@0.21.1`: `@signal` (on accessors or getters) and `@cached` (on getters) are the two decorators in its surface.

| signal-utils 0.21 | lite-signal-decorators |
|---|---|
| `@signal accessor x` (or `@signal get x`) | `@reactive accessor x` |
| `@cached get y()` | `@derived get y()` |
| no disposal API at all | `disposeReactive(vm)` -- **and it disposes**: cascade teardown, poison swap, node-exact conservation |
| Standard-decorators build required | `defineReactive(Class, spec)` -- the buildless door signal-utils has no equivalent for |

The cross-framework numbers behind this table are stamped in [`decisions/0006-kill-criteria.md`](decisions/0006-kill-criteria.md) (both engines measured through their documented class APIs at checksum-identical work).

---

## What this is not

- **Not a home for module-level or global signals.** That is raw `lite-signal` territory; `static` members are rejected by design.
- **Not a deep/proxy observation layer.** No `observable.deep`, no wrapped Arrays/Maps/Sets, no proxy magic -- the reactive unit is a declared member, not a traversed object graph. Collections are `@zakkster/lite-project` territory.
- **Not a per-frame action system.** `@batched` costs a measured thunk per call -- fine for "one call per user intent", wrong inside a render loop. Per-frame hot lanes stay on plain accessor writes (and frame *scheduling* belongs to `lite-raf`).
- **Not a framework, renderer, or component model.** It ends at the reactive view-model; DOM binding is `lite-signal-dom`'s job.
- **Not a general meta-programming kit.** Five decorators, one wiring law -- not an open decorator toolbox. It does one thing: turn a class into a reactive view-model with a provable lifetime.
- **Not a MobX API shim.** No `makeObservable`, no administration objects -- and no GC-based cleanup: disposal is explicit, deterministic, and verified, because "the collector will get it eventually" is not a lifecycle.
- **Not a legacy-decorators consumer.** TypeScript `experimentalDecorators` emit is detected by call shape at decoration time and rejected with a named error -- never "works differently under legacy".
- **Not usable as `@` syntax without a toolchain** -- that is exactly what `defineReactive` exists for.

---

## Ecosystem

| Package | Relation |
|---|---|
| [`@zakkster/lite-signal`](https://www.npmjs.com/package/@zakkster/lite-signal) | The engine underneath -- pooled fine-grained signals. The one peer dependency. |
| `@zakkster/lite-signal-dom` | DOM bindings for the same engine -- where a view-model meets actual elements. |
| `@zakkster/lite-raf` | Frame-rate scheduling for the same graph; the frame-coalescing pattern the `scheduler` option on `@reactiveEffect` exists to plug into. |
| `@zakkster/lite-devtools` | Graph inspection; `rootOf(vm)` + `forEachOwned` is the hook it walks. |
| [`@zakkster/lite-watch-ex`](https://www.npmjs.com/package/@zakkster/lite-watch-ex) | One-shot / predicate-gated / pausable watchers over the same engine; thunk sources, default-registry effects -- see the [registry note](#composability) before pointing one at a decorated member. |
| `@zakkster/lite-leak` + `@zakkster/lite-gc-profiler` | The dev-side harness that proves every retention and allocation claim in this README. Never shipped to consumers. |

### The cookbook

[`COOKBOOK.md`](https://github.com/PeshoVurtoleta/lite-signal-decorators/blob/main/COOKBOOK.md) collects eighteen composition recipes over the frozen 18-export surface -- how to build the things this package deliberately does not ship a decorator for, by composing the ones it does. Its headline is the **MobX-parity-by-composition matrix**, mapping each remaining MobX construct (`observable.array`, `observable.map`, `observable.deep`, `toJS`, `when`, `runInAction`, `observe`/`intercept`) to a decorator, a suite member, or a recipe -- extending the migration tables above to the rest of MobX with the honest note per row. It walks the **two-plane fleet** (a sim plane of arena columns written raw per frame beside a reactive plane of a handful of committed members), the reactive-collection-without-a-node-per-element pattern, and the **lite-store boundary** where document state meets class state -- stated plainly as the one path that is *not* zero-GC, and why. Every code block is byte-verified against a runnable, GC-gated companion in `cookbook/` (`npm run cookbook`), so a quoted recipe cannot drift from working code. It is delivered GitHub-only -- the installed tarball stays the lean 7-file runtime surface (decisions/0009).

---

## FAQ

**Why the `accessor` keyword?**
It is the standard-decorators protocol mechanism that gives a decorator both an `init` hook (create the box during field initialization -- eagerly, so the getter carries no `if (!box)` lazy branch) and replaceable get/set bodies, without per-instance `defineProperty` calls or a base class. `@reactive` on a plain field is a named throw pointing you to `accessor`.

**How is this different from MobX's `@observable`?**
Philosophy: MobX trades allocation and administration overhead for maximal transparency; this package trades a little syntax (`accessor`, explicit dispose) for zero hot-path allocation, a node-exact instance cost, and a teardown you can prove. There is no proxy, no administration object per instance, and nothing is left for the GC to find "eventually" -- which is precisely what makes 10k-instance fleets and long sessions flat.

**Why explicit dispose? Can't the GC handle it?**
Reactive nodes live in lite-signal's pre-allocated pool and effects are *reachable from the graph* -- a forgotten view-model is not garbage, it is a live subscriber that keeps firing. `FinalizationRegistry` is non-deterministic and unobservable in torture terms. Explicit `disposeReactive` (or `using`) is one call, idempotent, allocation-free -- and the poison swap turns any lifecycle bug into a named, debuggable throw instead of a silent leak.

**What happens if the pool fills up mid-`new`?**
The engine's `CapacityError` propagates from the constructor and construction is **atomic**: everything already created for that instance is rolled back, node-exact -- no leak, and the same construction succeeds once headroom exists. If you need more headroom, size the registry:

```js
import { createRegistry } from "@zakkster/lite-signal";
const world = createRegistry({ maxNodes: 8192, onCapacityExceeded: "grow" });

@reactiveHost({ registry: world })
class Entity { /* ... */ }
```

**Can decorated instances and raw lite-signal code share a graph?**
Yes -- that is a torture-pinned contract, both directions: raw effects reading decorated members, decorated deriveds reading raw boxes, subscriptions through `boxOf` handles. Decorated members ARE engine boxes; there is no wrapper layer to cross.

**Why is passing a different registry to a subclass an error?**
Because an instance whose base-class boxes live in one pool and whose subclass boxes live in another cannot be disposed correctly by anyone -- the engine's cross-registry dispose is a silent no-op. One chain, one registry is the only shape with a provable teardown, so any other shape throws at decoration time.

**Is `@batched` free?**
No, and the README says so with numbers: 22.12 ns/op vs 15.25 raw vs 11.67 unbatched on the reference rig -- a thunk + rest-array per call. Use it for actions; keep per-frame writes on plain accessors.

**Where are `costOf`, labels, the audit hook, private members?**
All three are part of the frozen 1.0.0 surface -- `costOf`/`capacityFor` (measured capacity accounting), `enableLabels`/`labelOf` (devtools identity), and `auditReactive` (leak audit), all cold-path or opt-in with the hot canon untouched. Private-member support remains out. The `llms.txt` scope note tracks exactly what is and isn't included.

---

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
