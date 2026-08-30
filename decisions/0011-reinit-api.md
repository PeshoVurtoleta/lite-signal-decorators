# 0011 -- pooled-reinit API shape (release + reinit, the PARKED state)

Status: ACCEPTED (S6-T3). Verdict: **EXIT A** ships a TWO-call lifecycle --
`releaseReactive(vm)` parks a live instance, `reinitReactive(vm, initials?)`
revives a parked one. The surface grows 16 -> **18**. Evidence:
`decisions/0010-reinit-contract.md` (the spike numbers this rests on),
`SignalDecorators.js` (the implementation), the S6 lattice smoke and the full
torture/controls/test chain green (below).

Rig / stamp: Node v26.3.1, arm64, Apple M4 Pro, `@zakkster/lite-signal` **1.5.0**
(installed peer). Session date **2026-08-30**.

## Context

0010 (the spike) returned EXIT A: PARK+REINIT per PD-42(b) can hold `maxMajor 0`
and zero delta-heap per acquire/release cycle. The engine pools every node
(`poolGrowths` delta 0, ledger balanced), one prebuilt effect body drives N
registrations with zero stale fires (Q3), and stale external handles fail CLOSED
(Q4). This record fixes the API shape those numbers permit and pins the state
lattice, the idempotency call, and the rejected alternatives.

## Decision -- a two-call lifecycle, 18 exports

`releaseReactive(vm) -> boolean` parks a LIVE instance: cascade its anchor,
dispose each signal box, swap every slot to a per-class PARKED handle (frozen,
`[NONLIVE]: "parked"`, throws a parked-specific `ReactiveDisposedError` naming
`Class.prop`), keep the prebuilt closure set, and set `ANCHOR` to the PARKED
sentinel. A parked instance holds **zero** engine nodes.

`reinitReactive(vm, initials?) -> vm` revives a PARKED instance: rebuild each
signal box (caller `initials[key]` wins, else the buildless plan `initFn`, else
the decorator field-initial captured per member in `makeInit`), then rebuild the
anchor + deriveds + effects through the PREBUILT closures via `buildGraph`, and
restore live handles into every slot.

**Why two calls, not one.** PD-42(b) is a two-phase lifecycle by nature: parking
and reviving are distinct transitions with distinct fail-closed guards and
distinct return contracts (a boolean release-or-not vs the revived `vm`).
`disposeReactive`'s signature is frozen at `(vm) -> boolean` under the 1.0.0
semver promise and cannot grow an `options` param to double as "park", so the
release half needs its own name. A single `reinitReactive` that internally
parked-then-revived is not expressible: the pool holds parked instances between
transitions, so the acquire and the release are separated in time by the
consumer's own code, not by one call.

**Surface: 16 -> 18** (additive MINOR): `releaseReactive`, `reinitReactive`. No
error class is added (PD-44): the PARKED touch reuses `ReactiveDisposedError`
with an optional `parked` flag selecting a pooled-lifetime message. `test/15`
CB-A2's export-count assertion is restamped 16 -> 18 (PD-48, second-landing
session owns the one number); `cookbook/citations.json` carries no self-count and
is untouched.

## The state lattice (S6-A3, fail closed)

Three states on one axis -- `ANCHOR` is a live node (LIVE), the PARKED sentinel
(PARKED), or the DISPOSED sentinel (DISPOSED); `undefined` is unwired. Pinned:

- LIVE -> PARKED (releaseReactive, returns true), PARKED -> LIVE (reinitReactive,
  values reset), PARKED -> DISPOSED (disposeReactive swaps parked handles to
  poison, lands DISPOSED, idempotent).
- **park -> park is idempotent false-return.** `releaseReactive` on an
  already-parked instance returns `false`, changing nothing -- the SAME contract
  `disposeReactive` uses for double-dispose. Justification: release is the
  pooling analog of dispose; a pool manager returning a handle it already
  returned is a benign double-free, not a logic error, so it should not force a
  try/catch around every pool return. A named throw was the alternative; rejected
  because it makes defensive release cost an exception, and symmetry with the
  1.0.0 double-dispose contract is the least-surprising choice.
- **release -> disposed is a NAMED throw** (not idempotent-false). A disposed
  instance is terminally gone and CANNOT be pooled; a caller that tries to
  release it believes it can reuse it and is wrong -- fail closed with a named
  error rather than silently return false and hand back a corpse.
- reinitReactive fail-closed on five states, each a NAMED throw, zero silent
  no-ops (null is not zero): on live, on disposed, on frozen, on unwired, on
  non-reactive. releaseReactive fail-closed on non-reactive, unwired, frozen,
  disposed, plus the same self-in-`@derived` re-entrancy guard `disposeReactive`
  carries (fail-open cascade of the computing node).
- Every member touch on a PARKED instance throws with "parked" in the message
  (not "disposed"); `boxOf`/`rootOf` each gain one cold branch and agree.

**Atomicity.** reinit runs OUTSIDE any constructor, so it cannot borrow the
SCRATCH init-rollback frame; it owns a try/catch that routes any mid-reinit throw
through `disposeCore`, leaving conservation exact and the instance terminally
DISPOSED -- a failed revival is final (fail closed). `disposeCore` was taught to
skip the PARKED sentinel so a dispose-on-parked does not re-dispose it.

## Construction-cost finding (PD-42 CONSEQUENCES, a number not a silence)

PD-42/S6-T2 specified `wireInstance = prebuild + buildGraph`, storing the closure
set at first wiring. Measured against the stamped churn-soak gate (`maxMajor 0`,
a NEW instance constructed and disposed every cycle, never reused):

| prebuild placement | churn-soak major GC | verdict |
|--------------------|---------------------|---------|
| stored at first wiring (retained) | 140 | FAIL |
| built at first wiring (transient bundle) | 1 | FAIL |
| built lazily at first releaseReactive | **0** | PASS |

A construct-once/dispose-once instance never reuses, so any per-construction
closure-bundle allocation is pure tax with no amortization, and even a transient
bundle's container objects tipped one promotion over the `maxMajor 0` floor. The
gate does not widen. Therefore `wireInstance` stays **byte-identical to 1.0.0**
(its inline node build, its try/catch + `disposeCore` rollback contract verbatim
-- capacity-torture unperturbed), and the prebuilt closure set is built LAZILY at
first `releaseReactive`, when reuse intent is known, and retained for every later
reinit. The amortization property 0010 relies on is preserved intact: the
closures are built ONCE per reused instance and re-registered across all N
acquire/release cycles with zero new allocation (0010 Q3). `buildGraph` is the
shared node-builder invoked by reinit; the decorator field-initials live in a
`rec`-keyed WeakMap populated in `makeInit` (per member, once; zero per-instance
retention), so the construct path carries only one WeakMap `has` beyond 1.0.0.
The hot accessor canon (`makeGet`/`makeSet`/`makeDerivedGet`) is byte-identical
(S6-A4, git-diff proven).

## Rejected alternatives

- **PD-42(a) -- `reinitReactive` re-runs `wireInstance`.** Allocates 3+D+E
  closures per acquire (6 per CHURN cycle at P=4/D=2/E=1); the zero-delta-heap
  gate fails without ever reaching the engine. Rejected by 0010's arithmetic; the
  prebuilt closure set exists precisely to avoid it.
- **PD-42(c) -- keep the graph fully live, release only resets values.** Not
  expressible on the 1.5.0 surface: effects are stopped only by disposing them
  and their handles are discarded at wiring (`SignalDecorators.js` effect loop),
  so "stop without dispose" has no API. A parked instance would keep E live
  effects firing on every mutation of a pooled object -- a correctness hazard,
  not a saving. Rejected.
- **Single-call acquire/release fused into `reinitReactive`.** Not expressible:
  the pool holds parked instances between transitions (see above).

## S6-T5 -- native-decorator watch (quarterly)

TC39 decorators remain **Stage 3**; no shipping JS runtime executes decorator
syntax natively (Node 26.3.1 does not). The package's emit matrix therefore
tracks the two real emitters (TypeScript `experimentalDecorators: false`, Babel
`2023-11`) and the compiled-demo caveat stands. TRIGGER that adds a native emit
lane and drops the caveat: a stable JS runtime (V8/Node `latest`, not a flag)
executing `accessor`-field + method decorators with the standard
context/`addInitializer` protocol this package already targets -- at which point
`test/torture/emit-matrix.mjs` gains a native lane run under that runtime and the
README caveat is struck. Until then this is a watch item, re-checked each S-cycle,
never a milestone. No native runtime = no native lane; the mock-emitter faithfully
reproduces the standard emit and the gate proves the contract.

## Fleet helpers -- the fifth admission candidate (NOT admitted)

PLAN-COOKBOOK's `decisions/0009` records four adjacent admission CANDIDATES under
the real-consumer bar (`bump`, `forEachReactive`, `snapshotOf`, `costOfInstance`).
S6 references that record and does not re-decide, absorb, renumber, or
re-litigate any of the four. A lite-arena-style **fleet helper** (a decorated-VM
handle over arena rows) is recorded here as a FIFTH candidate under the same
unchanged bar (PD-47): admitted only with a named, existing consumer that needs
it -- not a demo, not a recipe, not a bench adapter, not a hypothetical. There is
no such consumer. It stays OUT. The pooled-reinit lifecycle this session ships is
the primitive a future fleet helper would build ON; shipping the primitive does
not lower the helper's admission bar.

## Verification (green)

- Lattice smoke (scratchpad): live->release->reinit->live with values reset
  (10/5/15), parked touch throws with "parked", parked holds 0 nodes, park->park
  returns false, reinit overrides, reinit-on-live/disposed/non-reactive throw,
  dispose-on-parked lands DISPOSED (not parked) and is idempotent-false, costOf
  unperturbed (5 nodes / 3 links), 1000 acquire/release cycles return to baseline.
- `npm test`: 228 pass, 0 fail. `npm run torture`: 13 pass + 2 legitimate
  floor-skips (scope-adoption 1.6.0, using-dispose 1.9.0), churn-soak major=0,
  capacity-torture unperturbed. `npm run torture:controls`: 15/15 break as
  required. `node --expose-gc test/torture.mjs`: leak=0 findings=0 gc major=0.
  (These are the S6-T3 write-time numbers -- before test/16 and reinit-torture
  landed.)
- Shipped-state verification (post S6-T6/T7/T8): `npm test` 257 pass / 0 fail;
  `npm run torture` 16 scenarios (14 pass + the same 2 floor-skips);
  `npm run torture:controls` 16/16 break as required; gate
  `GATE PASS -- 8 blocking steps + 1 non-blocking` -- the verbatim tail is
  archived in CHANGELOG.md under [1.1.0].
- Hot canon `git diff HEAD`: `makeGet`/`makeSet`/`makeDerivedGet` empty;
  `wireInstance` body empty.

## Addendum 2026-08-30 -- standards-watch correction

The native-decorator watch paragraph above recorded proposal-decorators as
"still Stage 3". Verified against tc39/proposals on 2026-08-30: Decorators
and Decorator Metadata are listed at **Stage 2.7** -- moved at the 2026-05
plenary (agenda item "Decorators for Stage 2.7") after holding Stage 3 since
2022-03. Functional impact zero: TS 5.x standard emit and Babel 2023-11
implement the same protocol and remain the only emitters; no engine ships
native decorators; the native-emit-lane trigger is unchanged (test262 is now
the explicit gate back to 3). The shipped docs' "Stage-3" phrasing is
imprecise as of 2026-05; that accuracy pass is owner-gated (tarball docs need
a version to carry them). Full record: research/feature-gap-2026-08-30.md.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
