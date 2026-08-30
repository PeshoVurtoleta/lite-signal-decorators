# Changelog

All notable changes to `@zakkster/lite-signal-decorators` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic
Versioning.

## [1.3.0] - 2026-08-30

The introspection/migration rung of the decisions/0013 strategic-admission
ladder, and the release that proves criterion (c): `snapshotOf` ships as the
MobX-`toJS`-parity export nobody could reach cleanly by composition, and it is
the REAL, NAMED in-package consumer that finally admits `forEachReactive` under
the ORIGINAL 0009 bar (a new export needs a named consumer, and a recipe is not
one). decisions/0009 recorded both as candidates 2 and 3 with the absence
stated plainly; this release admits them together -- `forEachReactive` because
`snapshotOf` is built ON it, `snapshotOf` because it is the MobX-`toJS` parity a
recipe cannot honestly serve. The recorded absence in 0009 is preserved as
pre-admission history, not rewritten. Surface 19 -> 21.

### Added

- **`forEachReactive(vm, fn, arg) -> count`** (20th export) -- a cold walk over
  every value-bearing member. Calls `fn(key, box, kind, arg)` once per member
  and returns the visit count. `kind` is `"signal" | "local" | "derived"`;
  `@reactiveEffect`/`@batched` are EXCLUDED (non-value-bearing -- `boxOf`
  refuses them). Order is PLAN order: signals, then locals, then deriveds, each
  declaration-ordered and ancestor-first (never `Reflect.ownKeys`, so it is
  stable across reinit). Four scalar args, no descriptor object, and the `arg`
  pass-through kills the caller's closure -- a gated zero-alloc walk. Symbol
  keys are visited. Fails closed on non-reactive/unwired/parked/disposed with the
  same named errors as `rootOf`.
- **`snapshotOf(vm) -> object`** (21st export) -- a shallow plain-object copy of
  every value-bearing member, keyed by member key, built ON `forEachReactive`.
  Values are read through the ACCESSOR `vm[key]`, NOT `box.get`, so a `@localTo`
  compare-on-read resets honestly and a `@derived` computes on read (PD-62). The
  whole walk runs under ONE `untrack` when the caller is tracking, so a
  `snapshotOf` inside an effect subscribes to nothing (PD-63). SHALLOW by design
  (PD-64): a nested VM is copied by reference, recursion deferred to a named
  consumer. Symbol keys included (`Reflect.ownKeys` law). Fails closed on
  parked/disposed (`ReactiveDisposedError`, parked vs disposed flavor) and
  non-reactive values. It ALLOCATES the returned object by design -- reported,
  never gated; the walk under it stays zero-alloc.
- **`test/18-introspection.test.mjs`** (22 cases) -- both emit lanes + buildless:
  plan-order walk, symbol keys, kind tags, effect/batched exclusion, count
  return + `arg` pass-through, the untracked-read law (a `snapshotOf` inside an
  effect fires ONCE, then never as every member is written), r7
  `{name,hp,mp,alive}` parity, the PD-62 accessor-read reset honesty, and the
  fail-closed non-reactive/unwired/parked/disposed matrix.
- **The `introspection-torture` lane** (scenario 18 of 18) with its own
  `TORTURE_BREAK` sabotage control: 1e6 hoisted-callback `forEachReactive` walks
  at `maxMajor 0` with control-relative minors, plus 1e5 `snapshotOf` cycles
  whose bytes/op are REPORTED in the summary line, never gated -- the snapshot
  allocates by design and the harness says so out loud.

### Changed

- **The export surface: 19 -> 21** -- an additive MINOR under the 1.0.0 semver
  promise (new exports are minors). The 1.0.0 hot canon
  (`makeGet`/`makeSet`/`makeDerivedGet`) stays byte-identical: both new exports
  are cold and neither moves an accessor byte.
- Three-place version sync to 1.3.0 (`package.json`, the `VERSION` const,
  `llms.txt`); the `test/15` surface-freeze recount 19 -> 21.
- `throwNoBox` message widened to name `@localTo`: `boxOf` serves `@reactive`,
  `@localTo`, and `@derived` members only (locals pass `boxOf`; the message had
  listed only `@reactive`/`@derived`).

### Measured (rig: Node v26.3.1, arm64 Apple M4 Pro, lite-signal 1.5.0)

- 1e6 hoisted-callback `forEachReactive` walks: **0.002 B/walk** (vs the 0.000
  B/op zero-alloc control, within a +2-byte limit), gc major **0**,
  `maxPauseMs <= 4.0`.
- 1e5 `snapshotOf` cycles: **95.8 B/op** -- the returned object, reported as
  "allocates by design", never gated.
- 1e5 construct -> snapshot -> dispose cycles: `tracker.size()` 0, findings 0,
  warnings 0, `activeNodes`/`nodes` back to exact pre-loop baseline; snapshots
  hold no box reference.

Records: decisions/0013 (strategic-admission track, criterion (c)),
decisions/0009 (candidates 2 + 3, now stamped ADMITTED with the pre-admission
absence preserved).

### Gate output (section-10 chain, archived verbatim)

```
  fixtures              OK       exit 0 -- emit fixtures regenerated
  test                  OK       exit 0 -- 313 pass / 0 fail
  test:gc               OK       exit 0 -- 313 pass / 0 fail
  torture               OK       exit 0 -- 16 passed, 2 skipped, 0 warned, 0 failed in 34.9s
  torture:controls      OK       exit 0 -- 18 passed, 0 skipped, 0 warned, 0 failed in 3.7s
  torture:peer-preview  REPORTED NON-BLOCKING -- lane completed (exit 0)
  bench:selftest        OK       exit 0 -- ALL PASS -- 22 passed, 0 failed
  cookbook              OK       exit 0/0 -- corpus 18/18 companions ok; controls 8/8 fail correctly
  pack                  OK       exit 0 -- 7/7 files, exact 7-name set, no demo/ no Publications/
----------------------------------------------------------------------
  GATE PASS -- 8 blocking steps + 1 non-blocking (peer-preview)
```

## [1.2.0] - 2026-08-30

The flagship of the decisions/0013 strategic-admission track: a story-grade,
release-after-release ladder (S8 `@localTo` -> S9 `snapshotOf` -> S10
`costOfInstance` -> S11 fleet helpers), and this is its first rung. `@localTo`
clears strategic criterion (a) -- impossible to compose correctly on the shipped
surface: PD-51 measured the effect-based recipe clobbering a user write one tick
late, so glitch-free reset needs in-package compare-on-read machinery. The one
release nobody else can copy from a recipe.

### Added

- **`@localTo(source, { equals? })`** -- upstream-keyed resettable local state
  (19th export; the 18-member surface grows by exactly one). A field FOLLOWS
  `source(self)` until someone writes it, a write OVERRIDES, and a changed
  upstream RESETS it -- decided by compare-on-read, so it is glitch-free,
  synchronous, and PURE (no box write on the read path; legal inside any
  `@derived`). `source` is a REQUIRED tracked `(self) => value` fn read inline
  (no extra node). `equals` (default `Object.is`) governs the upstream compare
  ONLY -- the write path never compares.
- **The `locals` buildless section** -- `defineReactive(Class, { ..., locals })`
  with `locals: { key: { source, equals?, initial? } }`, the buildless twin of
  `@localTo` (fail closed on a missing/non-fn source), full parity with the
  decorator path on both emit lanes.
- **The initial-value unification rule** (decisions/0014): a declared
  initializer means the member STARTS there and resets on the first upstream
  move (the `@trackedReset` flavor); an OMITTED initializer means the initial is
  the source evaluated once at wiring and the member follows upstream from the
  first read (the `@localCopy` flavor). One decorator, both field semantics,
  selected by the natural syntax.
- **The ABA contract, stated plainly** (decisions/0014, shipped + asserted): no
  public revision counter exists (NodeDescriptor is `{id, kind, value}`), so the
  upstream compare is VALUE-based. Upstream A -> local write X -> upstream B ->
  upstream back to an equals-A value leaves the read showing the STALE LOCAL X --
  the reset requires upstream to change relative to the last adoption, not to
  have moved transitively. tracked-toolbox's `@localCopy` has the same property;
  it is documented in README/llms.txt, pinned in torture (S8-A6), never softened.
- **The `localto-torture` lane** (`test/torture/localto-torture.mjs`, scenario
  13 of 17) with its own `TORTURE_BREAK` sabotage control: the zero-alloc
  read/write storm, the ABA-stale write/reset interleave asserted AS the
  contract, pooled park/reinit box+seen reset, and tracking-edge + pure-compute
  pins.
- **`test/17-localto.test.mjs`** (34 cases) -- the full lattice on both emit
  lanes plus buildless `locals`: read/write/reset, both initial flavors, the ABA
  contract, `equals` override survival, park/reinit reset, `costOf` accounting,
  source-throw fail-closed, and the option/source rejection matrix.
- Emit fixtures extended: `fixture.src.ts` gains a `@localTo` member; the two
  compiled outs + the source hash regenerate (no new fixture row or file).

### Changed

- **The per-instance cost formula is now `P + L + D + E + 1`** (was `P + D + E +
  1`): one signal box per local plus the anchor; the plain per-instance seen-slot
  is never a node (+0). `costOf` returns the `L` term; `capacityFor` sizes it.
  Reflected everywhere the formula appears in README/llms.txt.
- The shipped `SignalDecorators.d.ts` header de-staged to emitter-named
  phrasing (PD-49) -- a 1.1.1 zero-grep escapee (the sweep listed the `.js`
  but not the `.d.ts`), caught by the S8 review.
- **The export surface: 18 -> 19** -- an additive MINOR under the 1.0.0 semver
  promise (new exports are minors). The 1.0.0 hot canon
  (`makeGet`/`makeSet`/`makeDerivedGet`) stays byte-identical: `@localTo` ships
  its own accessor bodies and pays its own measured cost.
- Three-place version sync to 1.2.0 (`package.json`, the `VERSION` const,
  `llms.txt`); the `test/15` surface-freeze recount 18 -> 19.

### Measured (rig: Node v26.3.1, arm64 Apple M4 Pro, lite-signal 1.5.0)

- A `@localTo` read measures **1.69x** a plain decorated read (two tracked reads
  + a compare, versus one box read) -- documented as-is, not softened.
- Read AND write storms at N and 8N: **0.000 B/op** (control-relative +2 B), gc
  major **0**, `maxPauseMs <= 0.08`; a derived over one local holds EXACTLY 2
  source edges (upstream + box), 0 extra nodes over 1e5 reads.
- 4096 park/reinit cycles: `tracker.size()` 0, findings 0, warnings 0,
  `activeNodes` to exact baseline, zero pool growths; release frees exactly
  `P + L + D + E + 1` nodes.

Records: decisions/0013 (strategic-admission track), decisions/0014 (the localTo
contract + the ratified spike numbers), `spikes/localto-contract.mjs` (Q1..Q6,
EXIT A green against peer 1.5.0).

### Gate output (section-10 chain, archived verbatim)

```
  fixtures              OK       exit 0 -- emit fixtures regenerated
  test                  OK       exit 0 -- 291 pass / 0 fail
  test:gc               OK       exit 0 -- 291 pass / 0 fail
  torture               OK       exit 0 -- 15 passed, 2 skipped, 0 warned, 0 failed in 33.5s
  torture:controls      OK       exit 0 -- 17 passed, 0 skipped, 0 warned, 0 failed in 2.8s
  torture:peer-preview  REPORTED NON-BLOCKING -- lane completed (exit 0) [preview 1.9.0-preview.6 SUITE-GREEN 17/0/0/0; canary 1.9.0-canary.1 SUITE-GREEN 17/0/0/0]
  bench:selftest        OK       exit 0 -- ALL PASS -- 22 passed, 0 failed
  cookbook              OK       exit 0/0 -- corpus 18/18 companions ok in 2.1s; controls 8/8 controls fail correctly in 5.1s
  pack                  OK       exit 0 -- 7/7 files, exact 7-name set, no demo/ no Publications/
----------------------------------------------------------------------
  GATE PASS -- 8 blocking steps + 1 non-blocking (peer-preview)
```

## [1.1.1] - 2026-08-30

A docs-accuracy patch. No runtime, fixture, or emit-matrix byte changed; the
accessor canon and every export are byte-identical to 1.1.0. The only test
changes are `test/15`'s cookbook ground-truth recount for wave 2 and two
comment-only lines in the gate's step description -- no budget moved anywhere.
Surface stays at 18 exports; pack stays the same 7-file set.

### Changed

- Standards phrasing pass across README, llms.txt, package.json, the main-file
  header, and the catalog card. TC39 lists the decorators proposal (and
  Decorator Metadata) at Stage 2.7 since the 2026-05 plenary, down from Stage 3;
  the emitters are unchanged -- TypeScript 5.x standard emit and Babel `2023-11`
  remain the only real-world paths, no native engine ships decorators. Each doc
  now names the fact once and refers to the protocol by its emitters everywhere
  else, since stage labels drift and emitter names do not. Only the stage LABEL
  moved: the emit matrix, the committed TS/Babel fixtures, and every test are
  byte-untouched by this pass. Recorded in `research/feature-gap-2026-08-30.md` section 1 and
  the `decisions/0011` addendum. Three-place version sync to 1.1.1
  (`package.json`, the `VERSION` const, `llms.txt`).

### Added

- Cookbook wave 2: six recipes appended, `r12`..`r17`.
  - `r12` -- Wait for a condition, as a Promise.
  - `r13` -- React to a computed value, not every write (GATED).
  - `r14` -- Tie teardown to an AbortSignal.
  - `r15` -- Async state without async in the graph.
  - `r16` -- Read without subscribing.
  - `r17` -- Start the resource when someone is watching (GATED).
- Cookbook gated set grows 6 -> 8 (adds `r13`, `r17`).
- Publications refresh (P3): the outward drafts restamped to the 1.1.x story;
  files stay git-untracked.
- Bench chart artifact (closes ROADMAP open question 5): `bench/chart.mjs`
  renders `bench/results-chart.svg` -- the CHURN lane (ops/s + heapMed per
  adapter) parsed verbatim from the stamped `bench/results.txt`, deterministic
  and dev-side only (never in `files[]`); wired into the README numbers section.

### Gate output (section-10 chain, archived verbatim)

```
  fixtures              OK       exit 0 -- emit fixtures regenerated
  test                  OK       exit 0 -- 257 pass / 0 fail
  test:gc               OK       exit 0 -- 257 pass / 0 fail
  torture               OK       exit 0 -- 14 passed, 2 skipped, 0 warned, 0 failed in 33.1s
  torture:controls      OK       exit 0 -- 16 passed, 0 skipped, 0 warned, 0 failed in 2.0s
  torture:peer-preview  REPORTED NON-BLOCKING -- lane completed (exit 0) [preview   1.9.0-preview.6     SUITE-GREEN     16 passed, 0 skipped, 0 warned, 0 failed; canary    1.9.0-canary.1      SUITE-GREEN     16 passed, 0 skipped, 0 warned, 0 failed]
  bench:selftest        OK       exit 0 -- ALL PASS -- 22 passed, 0 failed
  cookbook              OK       exit 0/0 -- corpus 18/18 companions ok in 2.1s; controls 8/8 controls fail correctly in 5.0s
  pack                  OK       exit 0 -- 7/7 files, exact 7-name set, no demo/ no Publications/
----------------------------------------------------------------------
  GATE PASS -- 8 blocking steps + 1 non-blocking (peer-preview)
```

## [1.1.0] - 2026-08-30

The pooled-lifetime release: an instance is no longer single-lifetime. The
surface grows 16 -> 18 with the additive `releaseReactive` / `reinitReactive`
pair (a MINOR under the 1.0.0 semver promise), and this entry also folds in the
repo-only COOKBOOK work that rode `[Unreleased]` (PD-34). The hot accessor canon
(`makeGet` / `makeSet` / `makeDerivedGet`) and `wireInstance` are **byte-identical
to 1.0.0** -- reinit is a cold-path inverse of dispose, the prebuilt closure set
is built LAZILY at first `releaseReactive`, so the construct-once/dispose-once
path takes zero new bytes and no new branches (git-diff proven; S6-A4). Dist-tag
`latest`. Stage gate archived verbatim below: 257/257 tests on both lanes, torture
16 scenarios (14 run + 2 forward-compat floor-skips) with 16/16 sabotage controls
breaking as required, the peer-preview lane SUITE-GREEN per tag, cookbook corpus
and control sweep green, pack the same 7-file set.

### Added

- `releaseReactive(vm) -> boolean` -- park a LIVE instance to the engine pool:
  cascade the anchor, dispose each signal box, swap every slot to a per-class
  PARKED handle (touch throws `ReactiveDisposedError` with a *parked* message),
  keep the prebuilt wiring closures. A parked instance holds ZERO engine nodes.
  `true` on first release, `false` on park->park (idempotent, mirrors
  double-dispose). Fails closed on a disposed, unwired, frozen, or non-reactive
  value; carries the same self-in-`@derived` re-entrancy guard `disposeReactive`
  does. The closure set is built lazily on first release (0011).
- `reinitReactive(vm, initials?) -> vm` -- revive a PARKED instance: rebuild each
  signal box (`initials[key]` wins, else the plan initial), rebuild anchor +
  deriveds + effects through the SAME prebuilt closures, restore live slots
  (values reset). Atomic -- any throw mid-reinit routes through `disposeCore` and
  lands the instance terminally DISPOSED (a failed revival is final). Fails closed
  on a live, disposed, frozen, unwired, or non-reactive value; `null` is not zero.
- The pooled-lifetime lattice: LIVE / PARKED / DISPOSED on one axis, with all nine
  transitions pinned in `test/16-reinit.test.mjs` (29 cases, both emit lanes) --
  park->reinit->live (values reset), park->dispose (lands DISPOSED, idempotent
  false thereafter), park->park (false), the five `reinitReactive` fail-closed
  states, parked-touch throwing "parked" not "disposed", and `boxOf`/`rootOf`
  agreement. No new error class (PD-44): the PARKED touch reuses
  `ReactiveDisposedError` with a pooled-lifetime message.
- `test/torture/reinit-torture.mjs` (group `semantic`, floor 1.5.0) -- the
  acquire/release gate: 4096 pooled cycles at the churn shape (P=4, D=2, E=1) hold
  `maxMajor 0`, `maxPauseMs <= 4.0`, minors CONTROL-RELATIVE (`MINOR_FLOOR + 128`),
  retained delta-heap at/below the in-process zero-alloc control, and exact pool
  conservation (F-0: `activeNodes` to baseline, `poolGrowths` delta 0, ledger
  balanced). Its `TORTURE_BREAK=reinit-torture` control leaks one un-parked
  instance per cycle and exits non-zero. Torture 15 -> 16 scenarios.
- `bench/scenarios/churn-reuse.mjs` -- the CHURN-shape acquire/release bench lane
  (P=4, D=2, E=1): the `lsd`, `lsd-define`, and hand-wired `lite-raw-boxes` tiers
  pool with retained 0.0KB; `mobx`, `signal-utils`, and `alien-class` return
  `{ unsupported }` with an honest reason (MobX instances are never disposable --
  atoms return only via GC, so there is no release/reinit cycle to pool). Bench
  scenarios 7 -> 8; `bench/results.txt` re-stamped.
- `spikes/reinit-contract.mjs` -- the S6-T1 spike (four questions answered with
  numbers on the installed 1.5.0 peer before a line of `reinitReactive` was
  written): the engine NODE is fully pooled, the JS HANDLE is fresh-per-call but
  never retains, one prebuilt closure drives N registrations with zero stale
  fires, and stale external handles fail CLOSED (no aliasing). Verdict EXIT A.
- `decisions/0010-reinit-contract.md` (the spike contract + the four measured
  tables + the peer-registry watch) and `decisions/0011-reinit-api.md` (the
  two-call API shape, the state lattice, the construction-cost finding, and the
  rejected alternatives).
- `COOKBOOK.md` -- composition recipes over the surface, delivered GitHub-only
  (repo-only, not in `files[]`; decisions/0009): the tarball stays the 7-file
  runtime surface and the shipped README.md and llms.txt point to the cookbook by
  absolute GitHub URL.
- `cookbook/` (dev-only, never shipped): a runnable companion corpus of 12
  recipes (0-11), six GC-gated with `COOKBOOK_BREAK=<id>` sabotage controls and
  six ungated each carrying a published reason; plus `cookbook/manifest.json`,
  the `cookbook/citations.json` cross-package symbol allowlist, and
  `cookbook/run.mjs` -- the `node --expose-gc` per-recipe runner behind
  `npm run cookbook` (with `--controls` for the sabotage sweep and `--list`).
- `test/15-cookbook.test.mjs` -- the drift/parity checker: each fenced block in
  `COOKBOOK.md` is byte-compared against its tagged companion `#region`,
  bidirectionally, with a surface-freeze check (now exactly 18 exports; PD-48,
  second-landing session owns the one number), a citation check, a static-cost
  check, and the shipped-doc-link check.
- `test/gate.mjs` gains a BLOCKING `cookbook` step (the corpus lane plus the
  `COOKBOOK_BREAK` control sweep, both must exit 0), between `bench:selftest` and
  `pack`: the chain is now 8 blocking steps + 1 non-blocking (peer-preview).
- `test/gate.mjs` pack check upgraded from a bare count to a named-set
  assertion: the tarball names must equal exactly {SignalDecorators.js,
  SignalDecorators.d.ts, llms.txt, CHANGELOG.md, README.md, LICENSE,
  package.json}; `EXPECT_FILES` stays 7 and stays asserted, and a same-count
  swap now fails.
- `package.json` `scripts.cookbook` (`node cookbook/run.mjs`) and three pinned
  devDependencies: `@zakkster/lite-store` 1.2.0, `@zakkster/lite-arena` 1.9.0,
  `@zakkster/lite-await` 1.1.1.

### Changed

- The export surface grows 16 -> 18 (additive MINOR): `releaseReactive`,
  `reinitReactive`. The 1.0.0 semver promise holds -- no existing export's
  signature or behavior changed; the hot accessor canon does not move.
- Suite 214 -> 257 tests, green on both the plain and `--expose-gc` lanes:
  `test/15-cookbook.test.mjs` added 14 (214 -> 228), `test/16-reinit.test.mjs`
  added 29 (228 -> 257). Torture 15 -> 16 scenarios; sabotage controls 15 -> 16.
- Docs re-stamped to 1.1.0 across the three version sites
  (`package.json`, `SignalDecorators.js` `VERSION`, `llms.txt`), the README
  Testing/torture/design sections, and the llms.txt Exports header and scope
  note. The llms.txt single-lifetime sentence ("disposed once, never revived") is
  replaced by the pooled-lifetime contract and the three-state lattice, citing
  decisions/0010 and 0011.
- Construction cost is unchanged: the prebuilt closure set is built LAZILY at
  first `releaseReactive` (not at construction), so a construct-once/dispose-once
  instance carries only one WeakMap `has` beyond 1.0.0; `costOf(Factory).nodes`
  still equals P+D+E+1 and `capacity-torture` is unperturbed. Measured evidence
  for why lazy (a stored or transient per-construction bundle tips the
  `maxMajor 0` churn-soak floor) is in decisions/0011.

### Peer-watch note (PD-46)

Outcome (i): nothing promoted. The `npm view @zakkster/lite-signal dist-tags`
probe on 2026-08-30 shows stable `latest` still at **1.5.0**; 1.6.x
(`createScope`) and 1.9.x (engine `Symbol.dispose`) exist only as prerelease tags,
exactly the ones the peer-preview lane already tracks. No per-feature floor is
promoted, `torture:peer-preview` keeps reporting per tag, the `scope-adoption`
and `using-dispose` scenarios keep skipping legitimately below their floors, and
the peer RANGE floor stays `>=1.5.0 <2.0.0`. Recorded in decisions/0010.

### Gate output (section-10 chain, archived verbatim)

```
  fixtures              OK       exit 0 -- emit fixtures regenerated
  test                  OK       exit 0 -- 257 pass / 0 fail
  test:gc               OK       exit 0 -- 257 pass / 0 fail
  torture               OK       exit 0 -- 14 passed, 2 skipped, 0 warned, 0 failed in 33.2s
  torture:controls      OK       exit 0 -- 16 passed, 0 skipped, 0 warned, 0 failed in 2.0s
  torture:peer-preview  REPORTED NON-BLOCKING -- lane completed (exit 0) [preview   1.9.0-preview.6     SUITE-GREEN     16 passed, 0 skipped, 0 warned, 0 failed; canary    1.9.0-canary.1      SUITE-GREEN     16 passed, 0 skipped, 0 warned, 0 failed]
  bench:selftest        OK       exit 0 -- ALL PASS -- 22 passed, 0 failed
  cookbook              OK       exit 0/0 -- corpus 12/12 companions ok in 1.8s; controls 6/6 controls fail correctly in 4.6s
  pack                  OK       exit 0 -- 7/7 files, exact 7-name set, no demo/ no Publications/
----------------------------------------------------------------------
  GATE PASS -- 8 blocking steps + 1 non-blocking (peer-preview)
```

## [1.0.0] - 2026-08-29

The 1.0 release: docs freeze, the fleet playground, and the standing pre-publish
gate. Zero runtime changes -- the 16-export surface ships byte-identical to
0.4.0 (the hot accessor canon is review-diffed to a zero-line diff), and this
release freezes that surface under semver: any later signature change is a major
recorded in a decision file. Dist-tag `latest`. Stage gate, measured at
closeout by the full section-10 chain (archived verbatim below): 214/214 tests
on both lanes; torture 15 scenarios (13 pass + the two forward-compat scenarios
legitimately skipping under the installed 1.5.0 peer) with 15/15 sabotage
controls breaking as required; the peer-preview lane SUITE-GREEN per tag
(15/15, forward scenarios RUNNING) against lite-signal 1.9.0-preview.6 AND
1.9.0-canary.1; the bench sink self-test catching its sabotaged adapter; pack 7
files, no `demo/` or `Publications/`.

### Added

- The fleet-playground demo (`demo/`, dev-only, never in `files[]`): a
  single-file instrument console over a two-plane architecture -- Plane A a
  decorated entity-VM fleet in a `capacityFor`-sized custom registry with
  enforced ceilings, Plane B the telemetry signals in the default registry
  driving five `@zakkster/lite-watch-ex` watchers (`watchUntil`,
  `pausableWatch`, `watchChanged`, `watchMany`, `watchPrevious`). The DOM-free
  core runs headless under the same GC-budget and dispose-storm gates the
  library uses; the PD-29 registry wall is proven by a stats-delta (no watcher
  ever forms an edge into the custom-registry fleet), not by assertion.
- README migration section: MobX 7 and signal-utils translation tables,
  including the closing row MobX cannot write -- `disposeReactive(vm)` is one
  idempotent, node-exact call after which every later touch throws by name.
- README emit-support matrix, generated from `test/fixtures/hashes.json` (9
  entries) under drift-proof `EMIT-MATRIX` markers; `04-fixture-freshness`
  asserts the README block equals the generator, so a re-emit that changes a
  byte is loud, not silent.
- `llms.txt` per-feature forward floors documented alongside the peer range:
  1.6.0 for `createScope`, 1.9.0 for `Symbol.dispose`; the peer range floor
  stays `>=1.5.0 <2.0.0`.
- `gate` script (`test/gate.mjs`): the section-10 pre-publish chain as captured
  child processes -- fixtures, test, test:gc, torture (semantic + soak),
  the TORTURE_BREAK control sweep, the non-blocking peer-preview lane,
  the bench sink self-test, and `npm pack --dry-run` asserting exactly 7 files.
  Every blocking step exits 0 or the gate exits non-zero; peer-preview is
  reported, never gated.
- `Publications/` (dev-only, never shipped): per-channel release drafts and the
  GitHub release notes, centered on the class-reactivity benchmark methodology
  with an explicit invitation for competitor adapter PRs.

### Changed

- Docs re-stamped to reality: Testing sections now read 214 tests across
  fourteen files and 15 torture scenarios (13 run + 2 floor-gated skips), and
  every numeric claim traces to a live stamp (`bench/results.txt`,
  `decisions/0006`, or a gate tail). Version references across README and
  llms.txt move to 1.0.0.
- The 16-export surface is frozen under semver at 1.0.0. The 0.x "frozen for
  0.x" note is retired in favor of the semver promise.

### Fixed

- (Found in review, pass 1 charge C4) An inline-style violation in the demo
  HTML -- a non-custom-property `style=` attribute against the demo CSS law --
  was hoisted into the stylesheet. Custom-property `style="--var: value"` hooks
  remain, per the law.
- (Found in the planner audit) The Testing and gates sections carried
  0.2.0-era numbers (171 tests, "12/12 scenarios", an 11-row file table) two
  stages stale, in violation of the no-claim-without-a-stamp rule. Re-stamped
  against the 1.0.0 tree.

### Gate output (section-10 chain, archived verbatim)

```
  fixtures              OK       exit 0 -- emit fixtures regenerated
  test                  OK       exit 0 -- 214 pass / 0 fail
  test:gc               OK       exit 0 -- 214 pass / 0 fail
  torture               OK       exit 0 -- 13 passed, 2 skipped, 0 warned, 0 failed in 32.7s
  torture:controls      OK       exit 0 -- 15 passed, 0 skipped, 0 warned, 0 failed in 1.9s
  torture:peer-preview  REPORTED NON-BLOCKING -- lane completed (exit 0) [preview 1.9.0-preview.6 SUITE-GREEN 15 passed, 0 skipped, 0 warned, 0 failed; canary 1.9.0-canary.1 SUITE-GREEN 15 passed, 0 skipped, 0 warned, 0 failed]
  bench:selftest        OK       exit 0 -- ALL PASS -- 22 passed, 0 failed
  pack                  OK       exit 0 -- 7/7 files, no demo/ no Publications/
----------------------------------------------------------------------
  GATE PASS -- 7 blocking steps + 1 non-blocking (peer-preview)
```

## [0.4.0] - 2026-08-26

The introspection release: the surface grows 11 -> 16, every addition cold-path
or opt-in, the hot accessor canon byte-identical to 0.3.0 (review-diffed
against the published tarball). Stage gate, measured at closeout: 213/213
tests on both lanes; torture 15 scenarios (13 pass + the two forward-compat
scenarios legitimately skipping under the installed 1.5.0 peer) with 15/15
sabotage controls breaking as required; the peer-preview lane SUITE-GREEN
(15/15, forward scenarios RUNNING) against lite-signal 1.9.0-preview.6 AND
1.9.0-canary.1; pack 7 files.

### Added

- `costOf(Factory)` -- the measured, settled per-instance cost on the class's
  bound registry: `{ nodes, links, signals, deriveds, effects }`, frozen and
  cached per class. Quiet-required, floor-verified, DOUBLE-probed with
  identical-deltas-or-throw: an inconclusive probe (a derived whose read set
  changes between runs, a polluted registry) throws a named error, never
  guesses. `nodes` reproduces the 0002 Q3 grid exactly (P + D + E + 1);
  `links` is the first-full-read count.
- `capacityFor(inventory, { headroom }?)` -- sizes a ready `createRegistry`
  config from `[Factory, count]` pairs: nodes exact, links x `headroom`
  floored at the engine minimum, `prealloc: "eager"`,
  `onCapacityExceeded: "throw"`; fail-closed inventory and options
  validation. The link-headroom policy -- nodes exact; fixed-shape deriveds
  provision exactly at first-full-read; branchy-read deriveds fail LOUD with
  the `headroom` knob as the documented escape -- is recorded with its
  measured evidence in `decisions/0007-capacity-policy.md`, closing 0002's
  open question.
- `enableLabels(on)` / `labelOf(idOrHandle, registry?)` -- opt-in devtools
  identity (default OFF): per-registry `nodeId -> "Class.prop" /
  "Class#method" / "Class@anchor"` maps, per-class shared label strings,
  dispose unregisters, misses return `undefined`. A feature-detected
  integration test walks lite-devtools `graph()`/`toTree` from `rootOf(vm)`
  and resolves every walked node. The one-line devtools `labelResolver`
  upstream proposal is recorded in `decisions/0008-introspection.md`.
- `auditReactive(on)` -- opt-in leak auditor (default OFF): a lazily-created
  `FinalizationRegistry` reports any instance collected without
  `disposeReactive`, naming class and shape; it holds no instance references
  itself, unregisters on dispose, and registers nothing while off (proven by
  a child-process `--expose-gc` test).
- Forward-compat torture: `scope-adoption` (floor 1.6.0) and `using-dispose`
  (floor 1.9.0), written against the REAL probed future engine surfaces
  (1.6.0's `createScope` adoption; 1.9.0's native `[Symbol.dispose]` on
  handles) via a typeof-only feature probe (`test/shared/peer-probe.mjs` --
  never version parsing). Their sabotage controls lie about the probe, so
  they fail loudly even under the current peer. Plus `torture:peer-preview`:
  a scratch-install lane that runs the whole suite against the peer's
  `preview` and `canary` dist-tags and reports per-tag verdicts.
- Tests: `12-accounting` (11), `13-labels-audit` (10, incl. the child-process
  audit fixture), `14-qa-s4-boundary` (21 adversarial pins), and two
  capacityFor round-trip lanes (node-bound and link-bound) in
  capacity-torture. Suite 171 -> 213. Dev-only devDependency:
  `@zakkster/lite-devtools` (integration walk).

### Fixed

- (Found in review) A registry passing the 11-method duck-check but lacking
  `stats()` -- constructible from the public surface -- made `costOf` and
  `capacityFor` die with a raw `TypeError` instead of a named error. Now a
  named, ERR-prefixed throw explains that probing needs a `createRegistry()`
  registry with its stats ledger. The falsified "no reachable raw path"
  claim in 0008 is amended with the counterexample preserved, rejection-
  history style.
- (Found in QA) `capacityFor`'s options guard borrowed decorator-flavored
  usage wording for a plain function call, and accepted an ARRAY as an
  options bag; it now throws the call-form message
  (`options must be a plain object like { headroom: 1.25 }`) for both.
  `null` still means "omitted".
- (Found writing tests) `capacityFor` on a signals-only inventory produced
  `maxLinks: 0`, which `createRegistry` rejects; the returned links are now
  floored at the engine minimum of 1 so every valid inventory yields a
  constructible config.

## [0.3.0] - 2026-08-26

The class-reactivity benchmark release. Zero runtime changes: the 11-export
surface ships logic-identical to 0.2.0 (version constants aside); what this
release adds is the proof. Stage gate, all measured at closeout: 171/171
tests on both lanes; torture 13 scenarios / 13 sabotage controls all
green-and-breakable; the full benchmark matrix 42/42 lanes `sink=ok`, exit 0.

### Added

- `bench/` -- a private, never-shipped benchmark sub-package: six admitted
  engines (`lsd` decorators, `lsd-define` buildless, the `lite-raw-boxes`
  honesty baseline, MobX 7, signal-utils + signal-polyfill, a hand-rolled
  alien-signals class) x seven class-shaped scenarios (vm-write, fleet-read
  and fleet-tick over 10k instances, cascade 64/16+aggregate, deep-vm 64-deep,
  churn as the headline, retention as gates). Ported lite-signal rig: anti-DCE
  sink with analytic expected-sum oracles (skipped work rejects the lane),
  median-of-5 + min, GC-fenced runs with real delta/retained heap columns,
  machine provenance stamps with resolved adapter versions, a sabotaged-adapter
  self-test proving the harness can fail, and machine-gated effect liveness on
  lifecycle lanes. Candidates `classy-solid` and `@reactively/decorate` probed
  and excluded with recorded one-line blockers (solid's stock-Node SSR
  resolution; legacy-only decorators). Reproducible from a clean clone:
  `cd bench && npm install && npm run bench`.
- `fleet-soak` -- the 13th torture scenario (soak group): 2000 VMs (16000 pool
  nodes exactly) under sustained ticks with partial churn rotations for a
  wall-clock budget; per-sample F-0, flat retained heap, gcGate maxMajor 0;
  its sabotage control leaks one VM per rotation and is caught at the first
  sample.
- `decisions/0006-kill-criteria.md` -- the formal verdicts. Criterion 1 (the
  2.0x line vs the hand-written instance-field baseline) CLEARED WITH MARGIN:
  vm-write 0.94x, fleet-read 1.10x (parity, per 0003's tied-layout finding).
  Criterion 2 (churn cleanliness) CLEARED: 0 major and 0 minor collections
  over 4096 lifecycle cycles on every lite lane, pools at floor (asserted
  in-lane), retained settled at-or-below baseline -- and the decorated churn
  loop emits ~12.6x less transient garbage than the hand-rolled equivalent.
  Every competitor number published under the same stamp (AD-6 honesty
  tiering); the wide-shape cascade/deep-vm gap vs raw boxes is recorded as an
  S4 investigation item, not hidden.

### Changed

- README: the measured-numbers section now cites the cross-framework matrix
  and the 0006 verdicts alongside the package's own committed probes; version
  references bumped.
- CHANGELOG release links now point at the package `repository`
  (github.com/PeshoVurtoleta/lite-signal-decorators), matching the new
  `repository`/`homepage`/`funding` fields in package.json.
- `llms.txt` scope note: 0.3.0 adds only dev-side proof; the export surface
  is unchanged and frozen for 0.x.

## [0.2.0] - 2026-08-26

The adversarial-torture release: the 0.2 surface is frozen for 0.x, proven by
the full semantic suite (12 scenarios, 12 failing controls) and a 300-seed
oracle. Stage gate: 171/171 tests on both lanes; torture 12/12 with every
control breaking as required; suite gate `leak=size 0/0 findings=0 warnings=0 |
gc major=0 minor=0`.

### Added

- Seven adversarial torture scenarios (dev-side, never shipped):
  `capacity-torture` (every overflow point x both construction paths, host
  chains, nested constructions -- each atomic), `disposed-poison` (full
  post-dispose surface + resurrection storms), `leak-torture` (lite-leak
  kernels over 4096 cycles), `oracle-fuzzer` (300 seeds x 20k ops, decorated
  vs hand-wired raw twins in lockstep: values, effect fire counts, and graph
  opcode tallies), `interop-torture` (raw/decorated one-graph interop,
  cross-registry and `destroy()` contracts pinned raw, the two documented
  D-2f limits pinned drift-loud), `batch-untrack-torture`, and `churn-soak`
  (wall-clock soak, pools at floor, flat heap).
- The full package README replaces the 0.1.0 stub: positioning, quick start on
  both paths (decorator and buildless), the wiring/teardown model, the
  half-alive-view-model trap trio, a complete API reference with the rejection
  matrix, a verbatim-runnable composability pipeline, the measured numbers
  (storage-bench and batched-cost tables, quoted from their committed probes),
  zero-GC design notes with the allocation table and gate outputs, design
  decisions, the 171-test/12-scenario testing map, compatibility, ecosystem, and
  FAQ. Every behavioral claim and code sample was executed and verified against
  0.2.0 before landing.

### Fixed

- Init-phase capacity atomicity (D-2h, S2b finding P-1): a `CapacityError` thrown
  while creating a decorator signal box during `super()`'s field initialization
  no longer leaks the boxes already created earlier in that construction. A
  module-level scratch-frame protocol tracks in-flight boxes and disposes the
  whole frame LIFO on a throw, so `new` fails closed with zero node leak (F-0
  holds) at every capacity point, on the decorator path (init-phase) and the
  buildless path (wire-time) alike. Hot canon and the dispose path are untouched;
  steady-state cost is one push + one length reset per construction.
  The fix hardened twice under review and torture: the scratch frame is owned
  only by the most-derived (wiring) wrapper, so `@reactiveHost` inheritance
  chains roll back base-class boxes too (an intermediate-host truncation defect
  the reviewer caught with a measured counterexample), and the buildless signal
  wire-loop plus the R-A anchor creation moved inside `wireInstance`'s guard, so
  an overflow at ANY point -- init box, wire-time box, anchor, derived, or
  effect -- tears down exactly what was built and rethrows.

## [0.2.0-preview.1] - 2026-08-26

The full runtime surface. Exports grow from 8 to 11. Published under the
`preview` dist-tag on the same day 0.2.0 went to `latest`.

### Added

- `reactiveEffect` -- `@reactiveEffect m()` (bare) / `@reactiveEffect({ scheduler })`
  (factory): a method that auto-runs as an effect once the instance is wired
  (after every field and every derived). The auto-effect tracks its reads; the
  public method is a leak-guarded manual entry -- a call inside a foreign tracking
  scope is untracked, so it records zero stray dependencies (0004 D-4b). Self-
  dispose from inside an owned effect is allowed with pinned semantics (0004
  D-4d): the current run completes, later decorated-member touches throw
  `ReactiveDisposedError`, no re-runs follow, conservation is exact.
- `batched` -- `@batched m()` (bare) / `@batched()` (factory): runs the method
  body inside one engine batch, coalescing its writes into a single flush.
  Action-grade (one call per user intent), not a per-frame path: it allocates a
  thunk + rest-array per call by design and is excluded from the zero-GC hot-path
  gates.
- `defineReactive(Class, spec)` -- the buildless twin of the decorators (0005).
  `spec` is `{ signals, deriveds, effects, host }`; it installs the members on
  `Class.prototype` and wraps the class through the SAME wiring core the
  decorators use (shared by function identity, not merely behaviorally alike).
  Consumers without a Stage-3 transpiler get the complete feature set.
- `@reactiveHost({ registry })` -- an optional `registry` from lite-signal
  `createRegistry()` isolates the whole host chain. Every engine call routes
  through the bound registry, closing the cross-registry dispose trap (the
  default `dispose` is a silent no-op across registries). One registry per chain:
  a heterogeneous chain or an invalid (duck-check-failing) registry is a named
  throw.

### Changed

- `@reactiveHost` unknown options now report the standard unknown-option
  did-you-mean over `["registry"]` (the 0.1.0 "takes no options" message is
  retired) -- `registry` is now a valid option.
- The duplicate-key error wording now names both causes: subclass redeclaration
  OR two stacked package decorators on one member.
- Internal error-string refactor (housekeeping): the package prefix is hoisted to
  one `ERR` const and cold message building uses template literals; prewired
  handles build their message once and share it. Message text is byte-identical
  to 0.1.0 except the two changes above. Hot accessor bodies are untouched.
- `VERSION` is `"0.2.0-preview.1"`.

### Fixed

- Manual-call identity guard (D-4e): calling a `@reactiveEffect` or `@batched`
  method on a foreign, primitive, null, or cross-class receiver (e.g. via
  `Class.prototype.m.call(...)`) now throws a named error instead of running the
  body against the wrong instance. Uses byKey identity, so a subclass instance
  calling a base-declared method still passes. Cold manual-call path only.
- Frozen-instance dispose refusal (D-2g): `disposeReactive` (and `using`) now
  refuses a frozen instance up front with a named error, atomically -- previously
  it half-disposed (tore down boxes) then threw a raw `TypeError`, leaving
  disposed boxes behind live-looking slots. `Object.seal`/`preventExtensions`
  remain fine.

### Notes

- `@batched` per-call cost, measured by the committed cold-process probe
  (`spikes/batched-cost.mjs`, K=10 cold processes, node 26.3.1, Apple M4 Pro,
  lite-signal 1.5.0): the decorated method 22.12 ns/op vs raw `batch(fn)`
  15.25 vs the plain unbatched method 11.67 (median-of-medians; 0 major GC in
  every lane). The ~7 ns over raw is the guarded rest-array + thunk (risk R8).
  Action-grade, not a per-frame path; never in the zero-GC torture gates.

## [0.1.0] - 2026-08-26

Initial release -- the decorator core.

### Added

- `reactive` -- `@reactive accessor x = v` (bare) / `@reactive({ equals })`
  (factory): a per-instance signal box stored in a unique symbol slot with an
  unbranched, allocation-free accessor body.
- `derived` -- `@derived get y()` (bare) / `@derived({ equals })` (factory): a
  lazy computed owned by the instance's anchor.
- `reactiveHost` -- `@reactiveHost` (bare) / `@reactiveHost()` (factory): the
  single wiring site; its most-derived constructor builds the anchor and every
  derived exactly once, after all field initializers run.
- `disposeReactive(vm)` -- idempotent cascade + poison teardown; returns `true`
  on the first call, `false` thereafter. Also wired to `Symbol.dispose` for
  `using` blocks.
- `boxOf(vm, key)` / `rootOf(vm)` -- live box and anchor-descriptor lookups for
  interop with raw lite-signal and lite-devtools.
- `ReactiveDisposedError` -- named error thrown on any post-dispose touch,
  carrying `className` and `key`.
- Dispose re-entrancy guard (D-2f): calling `disposeReactive(this)` from inside
  the instance's own `@derived` computation throws a named error instead of
  silently dropping the derivation's value.
- `VERSION` constant (`"0.1.0"`).
- Fail-closed rejection matrix (all named, all at decoration time): legacy emit,
  wrong kind, static members, private (#) members, unknown option keys (with a
  nearest-key did-you-mean), non-function `equals`, double host, host options,
  and orphaned members.
- Torture skeleton (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`):
  retention, conservation, lifecycle, and zero-GC lanes.

[1.1.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v1.1.0
[1.0.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v1.0.0
[0.4.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.4.0
[0.3.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.3.0
[0.2.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.2.0
[0.2.0-preview.1]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.2.0-preview.1
[0.1.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.1.0
