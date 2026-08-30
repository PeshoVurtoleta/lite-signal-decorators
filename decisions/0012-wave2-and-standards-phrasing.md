# 0012 -- cookbook wave 2 admissions and the standards-phrasing pass (S7)

Status: ACCEPTED (S7-T10). What shipped: **v1.1.1**, a docs-tier session in
the owner's priority order P1 standards-accuracy > P2 cookbook wave 2 > P3
publications (P3 the first cut line, P1 never cut). NOTHING WAS CUT: all six
wave-2 recipes shipped, publications refreshed. Zero runtime bytes moved; the
surface stays 18 exports; the pack stays the 7-name set; no test or torture
budget changed.

Rig / stamp: Node v26.3.1, arm64, Apple M4 Pro, `@zakkster/lite-signal`
**1.5.0** (installed peer). Session date **2026-08-30**. Plan: PLAN-S7.
Evidence base: `research/feature-gap-2026-08-30.md` (the graded inverse-gap
survey; TC39 fact primary-verified) and the `decisions/0011` addendum.

## PD-49 -- the standards-phrasing policy

TC39 moved proposal-decorators (and Decorator Metadata) from Stage 3 to
**Stage 2.7** at the 2026-05 plenary; the emitters are unchanged (TypeScript
5.x standard emit, Babel `2023-11`; no native engine). Policy: each shipped
doc names the fact ONCE -- "TC39 decorators proposal (Stage 2.7 since
2026-05; TS 5.x / Babel 2023-11 emit unchanged)" -- and everywhere else names
the protocol by its EMITTERS, because stage labels drift and emitter names do
not. Enforced by a zero-grep law: `[Ss]tage[- ]?3` greps to ZERO across
README.md, llms.txt, package.json, SignalDecorators.js, COOKBOOK.md, and the
catalog card + index line. The main file moved EXACTLY three lines (banner,
header wording, `VERSION`), numstat-proven 3/3; the hot canon, every export,
the emit matrix, and all fixtures are byte-identical -- only the stage LABEL
was wrong, so only labels moved.

**Keyword/tag call (Coder A).** The package.json keyword and the catalog tag
`stage-3` became **`standard-decorators`** -- not `stage-2.7` (a stage token
would reintroduce the exact drift the pass removes) and not a bare drop (that
loses the discovery term). Emitter-named, stable, discoverable, and the
keyword and tag stay byte-consistent.

## PD-50 -- wave-2 admissions (r12..r17, append-only) and the cuts

Admitted, with gc class as shipped in `cookbook/manifest.json`:

- **r12** "Wait for a condition, as a Promise" -- none (lite-await allocates
  a Promise per call by design; a lifecycle boundary). Manual
  `withResolvers` deferred + self-disposing effect, then the packaged
  `whenSignal(() => vm.member, { timeout, signal })` thunk form.
- **r13** "React to a computed value, not every write" -- GATED. The MobX
  `reaction(dataFn, effectFn)` split: the effect body reads only a derived
  selector; `fireImmediately`/delay via `{scheduler}`. The two-effect
  signalify/sync guard folded into its Gotchas as one line.
- **r14** "Tie teardown to an AbortSignal" -- none (a teardown boundary).
  One `addEventListener("abort", ..., { once: true })` line beside `using`.
- **r15** "Async state without async in the graph" -- none (settlement
  allocates at the boundary by design). Three signals {state, value, error}
  written by a plain promise handler; the post-dispose settlement THROWS the
  named poison error and the companion asserts that throw as the wanted
  outcome (r8's law restated at pattern level).
- **r16** "Read without subscribing" -- none (a cold single-read
  demonstration; the torture lanes own read budgets). `boxOf(vm, k).peek()`
  + the engine's `untrack`, with the non-re-export refusal stated in prose.
- **r17** "Start the resource when someone is watching" -- GATED, the
  headliner. The MobX onBecomeObserved pattern over `boxOf(vm, k)` + the
  peer's `observeObservers` (verified public on installed 1.5.0:
  Signal.d.ts:425 top-level, :343 Registry method, hooks
  `{ onConnect?, onDisconnect? }` at :175).

CUT from the research RECIPE list, by name: equality presets (`{equals}`
takes any comparator; wave 1 already shows it in use -- a preset table is
padding); keepAlive pin (teaching a no-op-effect pin would promote a pattern
MobX's own docs flag as leak-prone -- NO SOFTENING); coerce-on-write stacked
decorator (real content, deferred until an emit-matrix-pinned decorator
ORDERING law exists); signalify-POJO/syncSignals (defineReactive IS the
class twin since r0; the sync guard folded into r13). PD-38's six deferred
recipes ALL STAY deferred, re-affirmed unchanged. Wave 2 is
composition-boundary recipes only; none needed new package surface.

## Measured (write-time, S7; independently re-run by the integrator)

- r13: bytes/op **0.135**, major **0**, minors 0 vs control+128, maxPause
  0.00 ms. COOKBOOK_BREAK control: minors 807 > 128 -> exit 1.
- r17: major **0**, minors 9 vs control+128, maxPause 0.07-0.08 ms,
  bytes/op **0.018** (one measurement bracket inverted -- net heap FELL
  across the bracket; both runs are under the 0.589 B/op stamped floor).
  COOKBOOK_BREAK control: minors 407 > 128 -> exit 1.
- r17 retention (S7-A5): 4096 observer transitions, start/stop paired
  4096/4096, leak tracker size 0, activeNodes 2/2 exact baseline,
  poolGrowths delta 0.
- Lane: `node cookbook/run.mjs` 18/18 companions ok; `--controls` 8/8 fail
  correctly. `npm test` 257 pass / 0 fail (the total is UNCHANGED from
  1.1.0: the test/15 recount moved ground-truth constants, not case counts).

## Findings ledger (composition-boundary facts, not surface gaps)

1. **lite-await takes a thunk, not a box.** `whenSignal`/`whenTruthy`
   require a FUNCTION source; a lite-signal `SignalBox` is a non-callable
   object, so the direct `whenTruthy(boxOf(vm, key))` rejects `TypeError`.
   The thunk form `whenSignal(() => vm.member, ...)` composes -- the thunk
   IS the tracked read. r12's companion asserts the rejection honestly.
2. **Top-level `observeObservers` binds the default registry only** (the
   PD-29 wall restated): a custom-registry box is invisible to it
   (`TypeError: not a reactive handle`). Documented in r17; the A5 retention
   proof runs on the default ledger, which conserves exactly.
3. **The laziness gotcha is pinned by assertion, not comment**: r17 asserts
   that CONSTRUCTING a VM fires no `onConnect` and that the first real
   tracked read (an engine effect with a hoisted body) does; transitions are
   driven by effect create/dispose, and the pool reuses the nodes
   (poolGrowths 0).

## PD-51 -- localCopy/trackedReset stays un-implemented

The strongest field candidate (tracked-toolbox + signal-utils both ship it)
is NOT implemented and NOT recipe-forced: glitch-free upstream-keyed reset
needs epoch-compare-on-read, and an effect-based recipe clobbers a user
write one tick late -- shipping that would be fail-open teaching. It stays
an admission candidate behind the decisions/0009 real-consumer bar.

## PD-52 -- Publications/ stays git-untracked

Outward posting copy, not repo artifacts; committing drafts pre-posting
stages stale copies forever. File plan executed: `GITHUB-RELEASE-v1.0.0.md`
archived byte-untouched (it may already be posted);
`GITHUB-RELEASE-v1.1.1.md` created for the 1.1.0 -> 1.1.1 story; the four
post drafts refreshed in place with stamped numbers only. POSTING is the
owner's, always. Versioning them later is one `git add` away and the
owner's call.

## PD-53 -- gated growth is manifest-driven

The gated set is now exactly {r1, r2, r4, r5, r9, r10, r13, r17}. The
runner and the gate derive every count from the manifest, so the cookbook
gate step reports 18/18 + 8/8 with ZERO functional bytes moved in
test/gate.mjs (the integrator de-numbered two stale "all 12" COMMENT lines
to "every manifest companion" -- numstat 2/2, comments only).
test/15-cookbook.test.mjs ground truth recounted 39/39/3/12 ->
**51 regions / 51 doc tags / 3 pointers / 18 companions**; the manifest ids
assertion is r0..r17 exact-order; no check weakened. D2 (MobX parity by
composition): the `autorun / reaction` cell gained r13, the existing `when`
row gained r12 beside r8, and ONE new row maps
`onBecomeObserved / onBecomeUnobserved` -> r17.

## Admission ledger (unchanged)

Seven candidates remain behind the real-consumer bar, none admitted, none
re-litigated: `bump`, `forEachReactive`, `snapshotOf`, `costOfInstance`
(0009), fleet helpers (0011), upstream-keyed resettable local state and
onObserved decorator sugar (research record section 3 -- r17 ships the
RECIPE; sugar still needs a named consumer).

## Verification (green)

Three-place version sync 1.1.1 (package.json = `VERSION` const = llms.txt
L3); `git diff --numstat SignalDecorators.js` = 3/3; live import = 18
exports, VERSION "1.1.1"; zero-grep clean on all seven doc surfaces;
`npm test` 257/257; cookbook lane 18/18 + controls 8/8; ASCII + stray-tag
sweeps clean on every touched file. The full-gate tail is archived under
CHANGELOG `[1.1.1]` at closeout (post-QA), per house pattern.

Reviewer verdict: **APPROVED**, 2 MINOR + 3 NOTE, all resolved pre-QA:
citations.json's whenTruthy line number corrected 230 -> 170 (the signature
and probe were right; only the cite was off); README's cookbook paragraph
"twelve recipes / 16-export surface" restamped "eighteen / 18-export" -- a
line stale since S6 shipped 18 exports, caught by S7's own accuracy charge;
the CHANGELOG [1.1.1] test-change sentence widened to name the gate's two
comment-only lines. NOTEs accepted as-is: r17 relies on the peer's
documented idempotent-unobserve contract (Signal.d.ts:341) without
re-asserting it; the [1.1.1] gate tail is deferred to closeout by design.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
