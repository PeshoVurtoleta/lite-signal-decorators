# Feature-gap survey -- 2026-08-30

The inverse of `field-survey-2026-08-25.md`: that record asked what this package
has that the field lacks (it chose the five pillars); this one asks what the
MOST-USED decorator libraries have that this package lacks, and grades every
gap so feature-envy cannot turn the package into a clone. Grades: ANTI-GOAL
(violates a stated law), COVERED (already expressible, sometimes better),
RECIPE (composition over the shipped surface or suite members -- cookbook
material), UPSTREAM-EXISTS (the primitive already lives in lite-signal /
lite-devtools territory), ADMISSION-CANDIDATE (a genuine surface gap; faces
the decisions/0009 real-consumer bar).

Method: three parallel web sweeps (MobX; the tracked/signals field; Lit +
TC39 + new-entrant search) against current docs, changelogs, npm download
APIs (week 2026-08-22..28), cross-checked locally against SignalDecorators.js
and the installed lite-signal 1.5.0 surface. The one load-bearing standards
claim was re-verified against tc39/proposals directly on 2026-08-30.

---

## 0. The field, ranked (npm downloads/week, 2026-08-22..28)

| Library | dl/wk | Version (date) | One-line status |
|---|---|---|---|
| lit | 7,385k | 3.x | DOM decorators; signal decorators NOT shipped |
| mobx | 4,020k | 7.0.3 (2026-08-19) | deep-proxy observability; stage-3-protocol decorators |
| @lit-labs/signals | 980k | 0.3.0 (2026-05-14) | mixin/directive only; @property-signal/@computed/@effect decorators remain "potential future work" |
| signal-utils | 824k | 0.21.1 (2024-12-23) | DORMANT 20 months; "not meant for production"; no disposal API |
| @glimmer/tracking | 149k | 1.1.2 (2022-04) | frozen; Ember still on the legacy stage-1 transform; stage-3 accessor RFC unshipped |
| tracked-built-ins | 120k | 4.1.2 (2026-03) | Tracked* collection wrappers |
| signalium | 55k | -- | function-shaped, async-first; not class decorators |
| tracked-toolbox | 28k | 3.0.0 (2026-04) | @localCopy / @trackedReset / @dedupeTracked |
| classy-solid | 1.4k | 0.5.2 | Solid-coupled @signal/@memo/@effect |
| @reactively/decorate | 90 | 0.0.4 (2023-05) | dead |

New-entrant sweep (npm + GitHub, mid-2025 onward): NOTHING >= 1k dl/wk.
Nothing found anywhere ships park/revive pooling, zero-GC accounting,
cost/capacity introspection, or instance-level Symbol.dispose.

---

## 1. Standards facts (the watch record)

| Proposal | Stage | Movement | Verified |
|---|---|---|---|
| proposal-decorators | **2.7 -- DEMOTED from 3** | 2026-05 plenary ("Decorators for Stage 2.7"); had held 3 since 2022-03 | tc39/proposals fetched 2026-08-30 |
| decorator-metadata | 2.7 (moves with it) | 2026-05 | same fetch |
| proposal-signals | 1 (unchanged) | last presented 2024-06; repo push 2026-01-25; signal-polyfill frozen 0.2.2 (2025-01-17) | GitHub/npm |

Engines: no native decorators anywhere (Igalia 2025-02: Edge/V8 impl ~complete
but unshipped; none of the three majors wants to ship first). Symbol.metadata:
TS 5.2+ / Babel 7.23+ emit it; no native engine.

Functional impact on this package: ZERO -- TS 5.x standard emit and Babel
2023-11 implement the same protocol and remain the only emitters; the emit
matrix, fixtures, and the native-lane trigger are unchanged. Docs impact:
REAL -- "Stage-3" phrasing across README.md, llms.txt, package.json
description, and the catalog card is imprecise as of 2026-05. Corrections:
decisions/0011 addendum written 2026-08-30 (the watch paragraph had recorded
"still Stage 3"); field-survey-2026-08-25's same claim was stale at write
time; the shipped-docs accuracy pass is OWNER-GATED (it touches tarball docs,
so it needs a version to carry it -- a 1.1.1 docs patch or the next release).
Suggested phrasing: "TC39 decorators proposal (Stage 2.7 since 2026-05;
TS 5.x / Babel 2023-11 emit unchanged)".

---

## 2. The graded gap matrix (merged, deduplicated)

ANTI-GOAL (law in parentheses):
- deep/proxy observability; @deepSignal (no deep/proxy observation)
- observable array/map/set; Tracked*; Signal* wrappers (no collection wrappers)
- makeAutoObservable / extendObservable annotation inference (fail closed:
  inferred wiring is unverified state; dynamic shape defeats pooled slots --
  defineReactive is the explicit twin)
- flow/CancellablePromise; load/signalFunction/AsyncComputed; signalium
  relays (no async in core; lite-await is the boundary)
- intercept/observe (stated law: rootOf + forEachOwned is the audit path)
- configure() global modes (global config fails open; registries isolate)
- @component / SignalWatcher / Lit @property reflection + @query family
  (no framework/DOM bindings in core)

COVERED (ours equal or stronger):
- @cached + @dedupeTracked -> @derived get + {equals} subsume both (Glimmer
  needs two decorators for what one option does; their @cached does not dedupe)
- @state -> @reactive
- untracked reads -> boxOf(vm, k).peek()
- stopEffects/startEffects -> releaseReactive/reinitReactive (whole-instance
  park beats per-effect toggles; per-effect granularity = surface minimalism)
- spy / getDependencyTree / getObserverTree -> lite-signal onGraphMutation +
  forEachSource/forEachObserver + enableLabels/labelOf (presentation is
  lite-devtools territory)
- Symbol.dispose -> ours is instance-level; MobX ships it on reaction
  disposers only
- isObservable/isComputed/... predicate family -> boxOf() !== undefined; one
  box kind instead of ten wrappers

RECIPE (cookbook wave-2 backlog, one line each):
- when()-as-Promise (+timeout/AbortSignal): @derived predicate + one
  self-disposing effect resolving a lite-await deferred
- reaction two-phase (data-fn -> effect-fn): effect body reads only a
  @derived selector; fireImmediately/delay via {scheduler}
- equality presets (struct/shallow/identity): plain comparator functions
  slotted into {equals}
- AbortSignal -> disposeReactive bridge: one addEventListener line
- computed keepAlive: pin with a no-op @reactiveEffect (MobX docs themselves
  flag keepAlive as leak-prone)
- coerce-on-write (the Lit converter idea): a stackable userland accessor
  decorator under @reactive; {equals} alone does not cover normalization
- async-state triple {state, value, error}: three @reactive members written
  by a plain promise handler at the lifecycle boundary
- signalify-a-POJO: defineReactive is the class twin; two-way sync = two
  effects sharing an {equals} guard
- untrack/peek one-liner (documents reg.untrack which the package already
  consumes internally; a cookbook line, not an export)

UPSTREAM-EXISTS:
- observer-count transitions (0->1 / 1->0): lite-signal observeObservers
  (lite-time / lite-raf already consume it)
- reaction error channel / misuse guards: dev-policy territory
  (lite-devtools), not runtime surface

---

## 3. Admission candidates (the only two that survive)

Recorded here for decisions/-grade consideration; BOTH face the
decisions/0009 real-consumer bar, joining the five already on the ledger
(bump, forEachReactive, snapshotOf, costOfInstance, fleet helpers).

1. **Upstream-keyed resettable local state** (@localCopy / @trackedReset
   unified; spelled as @reactive({ source, reset }) or a @localTo twin).
   The strongest case in the field: shipped independently by two ecosystems
   (tracked-toolbox 27.7k dl/wk with real consumers; signal-utils), and
   glitch-free reset genuinely resists composition -- correct semantics need
   epoch-compare-on-read, while an effect-based recipe clobbers a user write
   one tick late. Our {equals} already covers its compare option.
2. **onObserved sugar** (MobX onBecomeObserved/onBecomeUnobserved -- the
   lazy-resource pattern: subscribe to the websocket only while observed).
   The primitive ALREADY EXISTS upstream (lite-signal observeObservers);
   ship the boxOf + observeObservers recipe first, admit decorator sugar
   only with a named consumer. MobX was still patching theirs in 7.0.1 --
   actively load-bearing for its users.

Explicitly NOT candidates: trace() (MobX deleted the public API in 7.0.0;
the surviving story is matched upstream and belongs to lite-devtools);
when() (recipe); keepAlive (recipe, and leak-prone by MobX's own docs).

---

## 4. Positioning evidence (Publications-refresh ammunition)

- MobX 7 is converging on this package's laws: 7.0.0 removed the ES5/proxy
  fallback, legacy decorators, and public trace; 7.0.1-3 shrink per-atom
  memory (lazy observers_ Set, ~160 B/atom) -- the GC axis we gate is the
  axis the market leader is now chasing.
- The disposal inverse-gap: NOBODY else ships instance disposal. signal-utils
  (824k dl/wk) has none and is 20 months dormant with "not meant for
  production" in its README; classy-solid's stoppable effect documents its
  own leak risk; MobX instances are never disposable.
- @lit-labs/signals (980k dl/wk) still lists its signal decorators as
  unimplemented roadmap -- this package ships today what Lit Labs plans.
- The proposal org's own signal-polyfill README hand-rolls the accessor-
  decorator pattern as a how-to: the standards body documents the demand for
  exactly this package's shape.
- No credible new entrant since mid-2025.

---

## 5. Actions this record triggers

1. decisions/0011 addendum -- DONE 2026-08-30 (decorators Stage 3 -> 2.7).
2. Shipped-docs accuracy pass ("Stage-3" phrasing) -- OWNER-GATED; needs a
   docs version (1.1.1) or rides the next release.
3. Cookbook wave 2 -- section 2's RECIPE list is the planner input, on top
   of PD-38's six deferred recipes.
4. Publications refresh -- section 4 is the material; drafts in
   Publications/ still read v1.0.0.
5. Quarterly watch, next check ~2026-11: decorators 2.7 -> 3 (test262 is
   the gate), signals stage movement, MobX 7.x churn, signal-utils revival,
   @lit-labs/signals decorators landing, any native-engine decorator ship.

Sources: mobx.js.org api/computeds/reactions/actions/configuration +
mobxjs/mobx releases + CHANGELOG; tc39/proposals (fetched 2026-08-30,
primary); tc39/agendas 2026/05; Igalia 2025-02 plenary summary;
proposal-signals + signal-polyfill repos; lit.dev signals + decorators docs;
tracked-tools (toolbox, built-ins) + lume/classy-solid + milomg/reactively
repos; api.npmjs.org last-week download points (2026-08-22..28); local:
LiteSignal/llms.txt (peek, observeObservers, onGraphMutation,
forEachSource/forEachObserver), SignalDecorators.js.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
