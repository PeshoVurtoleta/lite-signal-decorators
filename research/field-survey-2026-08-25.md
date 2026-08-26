# Field survey -- class-decorator reactive state, 2026-08-25

Raw research record backing ROADMAP.md section 1. Graduates into
`decisions/0000-field-survey.md` at S0. All claims verified against sources
on 2026-08-25 unless flagged.

## 0. Standards substrate

- **proposal-decorators: Stage 3, no native engine.** V8 and SpiderMonkey
  implementations in progress (SpiderMonkey: Bugzilla 1781212, "intent to
  prototype"); test262 coverage incomplete blocks Stage 4. Real-world
  emitters: TypeScript >= 5.0 standard emit (no flag; `experimentalDecorators`
  is the legacy mode) and Babel `@babel/plugin-proposal-decorators` with
  `version: "2023-05"` or later (current config `"2023-11"`).
  https://github.com/tc39/proposal-decorators
  https://bugzilla.mozilla.org/show_bug.cgi?id=1781212
- **proposal-signals: Stage 1**, deliberately (heavy prototyping before
  Stage 2). `Signal.State` / `Signal.Computed` / `Signal.subtle.Watcher`.
  The proposal README itself blesses the decorator pattern: "Class fields
  can be made Signal-based with a simple accessor decorator."
  `signal-polyfill` latest **0.2.2, published 2025-01-17** (~19 months
  without a release). No debug-naming API.
  https://github.com/tc39/proposal-signals
- **Explicit Resource Management SHIPPED natively**: `using`/`Symbol.dispose`
  in Chrome 127+/134, Safari 18+, Firefox 132+, Node 24. The disposal-first
  substrate is cross-browser NOW (decorators are not).
  https://v8.dev/features/explicit-resource-management
- FLAGGED: `Symbol.metadata` (decorator-metadata proposal) stage claims
  conflict across sources (2023 Stage-3 advancement vs one 2026 article).
  TS 5.2+ implements it. Treat as feature-detect-only regardless.

## 1. signal-utils (proposal-signals org)

- v0.21.1, last publish 2024-12-23 -- ~20 months stale with issues still
  accumulating (into Jul 2026). README: "not meant to be used in
  production." ~118 stars, 19 open issues.
- Exports: `@signal` (accessor + getter), `@localCopy`, `@deepSignal`,
  `@dedupe` (wip); SignalArray/Object/Map/Set/WeakMap/WeakSet; async
  helpers; subtle: microtask `effect()`, `reaction()`, `batch()`.
- Mechanism (verified in source): accessor `init` returns
  `new Signal.State(value)` -- one State per decorated property per
  instance; getter -> one `Signal.Computed` per instance via WeakMap.
- **Disposal: none.** No Symbol.dispose, no cleanup APIs anywhere.
- Open pain: #101 batchedEffect stops running; #103 dependent-effect desync
  (Jul 2026); #87 AsyncComputed cannot abort; #98 "Debugging signal trees"
  (naming/devtools ask, open); #95 no benchmarks backing claims.
  https://github.com/proposal-signals/signal-utils

## 2. MobX

- **Current: MobX 7.0.3.** MobX 7 supports ONLY standard decorators;
  legacy `experimentalDecorators` users stay on MobX 6. Stage-3 support
  landed in 6.11: `@observable accessor x` (accessor keyword mandatory);
  with standard decorators `makeObservable(this)` no longer required.
  Weststrate: standard decorators are "30% less runtime overhead" via
  stable class shape.
- Per-instance allocation (verified in observableobject.ts): hidden `$mobx`
  -> one ObservableObjectAdministration per instance holding a
  `values_: Map`, `keysAtom_: Atom`, `pendingKeys_: Map`, `name_`, plus one
  ObservableValue atom per observable property per instance. PR #3884:
  disabling useDefineForClassFields bought ~10% memory / 10-16% perf, 23%
  reduction in ObservableValue shallow size -- per-property atoms dominate
  heap at "hundreds of thousands of instances."
- Devtools naming (verified in source): DEV builds auto-generate
  `${constructor.name}@${id}` per object and `${name}.${key}` per atom --
  DEV-only, dynamic, instance-counter-based.
- Footguns (documented): reactions "are only garbage collected if all
  objects they observe are garbage collected themselves"; keepAlive
  computed leak; ObservableMap `_hasMap` retains every key ever used
  (#2031); MST 40MB data -> ~16GB heap (#1683); `@observable accessor`
  props are non-enumerable (breaks Object.keys/JSON.stringify); subclasses
  must redeclare `@action` on overrides.
- **Disposal: documents `[Symbol.dispose]` on reaction DISPOSERS** plus a
  DisposableStack pattern. Reactions only -- nothing makes observable
  INSTANCES disposable, and per-property atoms are reclaimed only by GC.
  https://mobx.js.org/enabling-decorators.html
  https://github.com/mobxjs/mobx/pull/3884

## 3. Ember / Glimmer @tracked

- Revision-tag architecture: tags validated against one global monotonic
  revision counter; consumed on read, dirtied on write.
- Per-instance (verified in @glimmer/validator meta.ts): global
  `WeakMap<object, Map<PropertyKey, UpdatableTag>>`; Map + tag lazily
  allocated on first access per property per instance. (Value-cell storage
  location NOT independently verified -- flagged.)
- Decorators: still the LEGACY decorator transform (RFC 408/440); no
  Stage-3 migration found through Ember 7.0 (released 2026-05-29, "no new
  public API"). glimmer-vm repo archived 2026-01-06, merged into
  emberjs/ember.js monorepo.
- `@cached` documented as overhead ("avoid unless the getter is
  expensive"); deep tracking warned against for large/frequent data.
  https://blog.emberjs.com/ember-released-7-0/

## 4. Lit

- `@property`/`@state` are component-coarse (a set schedules re-render).
  Lit 3 supports legacy AND standard decorators (accessor required for
  standard); official docs still recommend experimental decorators because
  standard-decorator compiler output "is unfortunately large."
- `@lit-labs/signals` v0.3.0 (lit ^2||^3 + signal-polyfill ^0.2.2):
  SignalWatcher mixin, watch() directive, signal-aware html tag.
  **No decorators.** Explicitly experimental. Docs list a
  planned-but-MISSING feature: "A `@property()` decorator that uses
  signals for storage, to unify reactive properties and signals." Open as
  of Aug 2026 -- even Lit's own roadmap wants a signal-backed property
  decorator that does not exist.
  https://lit.dev/docs/data/signals/

## 5. Angular

- v22 (2026-06-03): Signal Forms, async reactivity APIs stable, zoneless
  default direction. Signal surface is entirely FUNCTIONS (signal,
  computed, effect, input, output, model, linkedSignal, resource).
  `@Input()`/`@Output()` remain legacy, not signal-backed. Zero signal
  decorators; direction is away from decorators. `debugName` is manual.
  https://blog.angular.dev/announcing-angular-v22-c52bb83a4664

## 6. Vue

- Class API dead upstream (vue-class-component unmaintained); community:
  vue-facing-decorator (TS), vue3-class-component (uses Stage-3 decorators
  + metadata, pure JS).
- Vue 3.6 (RC 2026-07-18; final not confirmed as of 2026-08-25 --
  flagged): `@vue/reactivity` REWRITTEN ON alien-signals; Vapor Mode
  feature-complete.
  https://github.com/vuejs/core/releases/tag/v3.6.0-rc.1

## 7. Other decorator/signal libraries

| Library | Decorators | Emit | Per-instance allocation | Disposal | Status |
|---|---|---|---|---|---|
| classy-solid 0.5.2 (lume) | `@signal`, `@memo`, `@effect`, `@component`, `@untracked` | Stage-3 only (Babel 2022-03 config) | one Solid createSignal per @signal prop per instance | stopEffects()/startEffects(); auto-cleanup only inside Solid owners | active |
| @reactively/decorate (milomg) | `@reactively` | LEGACY only; requires `extends HasReactive` + createReactives(this) | `__reactive` record: one Reactive node per prop per instance | none documented | quiet |
| alien-signals | none (engine) | -- | one node per signal (no pooling) | effectScope() | very active; perf-leader tier; core of Vue 3.6; ported into XState |
| @preact/signals | none | -- | one object per signal | effect disposer; createModel instances expose `[Symbol.dispose]` | active; React integration is function-components only |
| signalium 3.0.3 | none | -- | per-primitive objects | relay teardowns | active |
| @maverick-js/signals 6.0.0 | none | -- | computation nodes | root()/dispose()/onDispose() | publish date unverified -- flagged |
| oby | none | -- | observable objects | $.root manual | active |
| statin | none (explicitly anti-decorator) | -- | -- | reaction disposers | stable/feature-complete |

## 8. Benchmarks

js-reactivity-benchmark (milomg): alien-signals, Angular, Preact,
Reactively, S.js, Solid, Svelte 5, Tansu, Vue, x-reactivity -- entirely
function-based; tracks GC overhead per test; MobX and signal-polyfill not
included. **No class-based reactivity benchmark exists anywhere.**
https://github.com/milomg/js-reactivity-benchmark

## 9. Whitespace matrix

| Capability | Prior art | Verdict |
|---|---|---|
| (a) instance-level Symbol.dispose/using | MobX: reaction disposers only; Preact createModel: models disposable | No DECORATOR library makes decorated instances disposable, and nobody couples disposal to storage reclamation |
| (b) pooled / zero-alloc instance churn | none anywhere; every decorator lib allocates >= 1 object per property per instance | Completely open |
| (c) per-class static memory-cost accounting | none; closest is MobX PR #3884 measuring after the fact | Completely open |
| (d) auto ClassName.prop devtools labels | MobX DEV-only dynamic `ClassName@id.prop`; Ember DEBUG tags; Angular manual debugName; polyfill: nothing (signal-utils #98 open ask) | Open for signal-style libs: static, zero-cost naming |
| (e) class-shaped benchmark suite | none | Completely open |

**Composite gap**: Stage-3 accessor decorators + fixed per-class slot layout
+ pooled per-instance storage + instance-level using/dispose returning nodes
to the pool + static memory accounting + class-churn benchmark. Every
incumbent fails at least three of these; most fail all five. The two
structural findings that make the niche real: (1) the only maintained
Stage-3 signal-decorator packages are signal-utils (20 months stale, "not
for production", no disposal) and MobX 7 (admin + Map + atom per property
per instance); (2) disposal-leak complaints are the single most consistent
pain thread across MobX and signal-utils -- while the `using` substrate
just went cross-browser.

## Flagged / unverified

- Symbol.metadata exact current stage (conflicting claims; feature-detect
  regardless).
- Vue 3.6 final release status as of 2026-08-25.
- Ember tracked value-cell storage location (tag side-table verified).
- @maverick-js/signals 6.0.0 and signalium 3.0.3 publish dates.
- No official absolute bytes-per-instance numbers exist for MobX/Ember;
  only the relative numbers cited above.
