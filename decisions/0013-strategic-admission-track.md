# 0013 -- the strategic-admission track (owner decision, post-1.1.1)

Status: ACCEPTED (owner decision, 2026-08-30, recorded by the integrator).
Supersedes the POLICY of the decisions/0009 real-consumer bar for a named
five-candidate set; supersedes NO prior record's content -- 0009, 0011, and
0012 stand as written and were correct under the policy of their time.

## The decision

The owner directs a feature wave: implement the admission candidates one by
one as real releases. Motivation (owner's, recorded): sustained, substantive
release cadence is a trust signal -- adopters weigh version history and
visible active development when choosing against older incumbents, and the
package's discovery-driven download spikes (observed: 668/day when surfaced,
near-baseline otherwise) do not convert without it. Shipping different and
valuable capability, release after release, is the conversion lever the
owner chooses to pull.

Scope chosen by the owner (option "five of seven"): candidates 6, 3+2, 4,
and 5 ship as FOUR story-grade releases; candidates 1 and 7 stay deferred
with public one-line reasons -- restraint remains part of the brand.

## The second track and its bar

The original bar stands for everything not named here: a new export is
admitted only with a real, named consumer; a recipe is not a consumer.

The STRATEGIC track admits a candidate only if it clears at least one of:

- (a) **impossible or wrong to compose** on the shipped surface -- the
  feature's correct semantics need in-package machinery (localTo:
  glitch-free reset needs compare-on-read; PD-51 proved the composed form
  clobbers a user write one tick late);
- (b) **strengthens a unique pillar** no competitor occupies
  (costOfInstance: the measured-instance story);
- (c) **cuts migration friction with a MobX-parity name** AND carries an
  in-package real consumer (snapshotOf, whose implementation consumes
  forEachReactive -- satisfying the ORIGINAL bar for #2 honestly);
- (d) **serves the flagship audience on a shipped primitive** with the
  demo/bench as a live consumer landing in the same release (fleet helpers
  over capacityFor + createRegistry + park/reinit).

Pure sugar clears neither track. Every strategic admission still pays FULL
freight: spike where semantics are nontrivial, its own torture lane, emit
coverage on both lanes where the surface is decorator-shaped, buildless-twin
parity, the gate, and an owner-approved plan before any code (pipeline law
unchanged).

## The ladder

- **S8 / v1.2.0 -- `@localTo` (candidate 6), the flagship.** Upstream-keyed
  resettable local state, compare-on-read (glitch-free), zero-GC, dispose/
  park/reinit-aware, buildless parity. The one release nobody else can copy
  from a recipe. PLAN-S8; spike-first.
- **S9 / v1.3.0 -- `snapshotOf` + `forEachReactive` (3 + 2).** The
  introspection/migration release: toJS-parity snapshot built ON the walk
  primitive it exports beside.
- **S10 / v1.4.0 -- `costOfInstance` (4).** Kills the measurement-twin
  workaround (0009 candidate 4); the demo consumes it in the same release.
- **S11 / v1.5.0 -- fleet helpers (5).** The gamedev release: sized-registry
  + eager-prealloc + throw convenience over capacityFor + createRegistry +
  the pooled lifecycle; the demo fleet consumes it.

Version numbers are targets; each session's plan may re-stamp if an
intervening patch lands. Each release's CHANGELOG carries the story and the
measured numbers; each is announceable on its own.

## Deferred by name (public reasons)

- **`bump(vm, key)` (candidate 1):** one line of the consumer's own code at
  the mutation site is better than one more export; the rev-stamp pattern is
  taught, not wrapped. Stays behind the original bar.
- **`onObserved` decorator sugar (candidate 7):** r17 ships the pattern on
  the public primitive (2026-08-30); sugar re-enters only with a named
  consumer or demonstrated demand. Stays behind the original bar.

Both may be revisited against real traction data after the ladder ships.

## What does not change

Zero-GC hot-path law, fail-closed law, ASCII, single main file, the frozen
semantics of every shipped export, the torture/gate discipline, pack
minimalism (dev artifacts never enter `files[]`), and the pipeline
(planner -> coder -> reviewer -> qa, owner approves plans, owner publishes).
Surface growth is exactly the named exports of the ladder, nothing else
rides along.

## Addendum 2026-08-30 -- the ladder is CLOSED

Four rungs shipped same-day, each a story-grade release: **v1.2.0** `@localTo`
(criterion (a) -- glitch-free reset needs in-package compare-on-read); **v1.3.0**
`snapshotOf` + `forEachReactive` (criterion (c) -- the toJS-parity snapshot is the
original-bar consumer that admits the walk it exports beside); **v1.4.0**
`costOfInstance` (criterion (b) -- the measured-instance pillar, the demo's
shape-drift wall + HUD the live consumer); **v1.5.0** `createFleet` (criterion (d)
-- the flagship fleet helper, the demo's hand-rolled pool DELETED for it,
net-negative diff). Surface **18 -> 23** across the ladder. Every rung was
spike-or-direct per its own plan, ran the full pipeline, cleared the gate, and
carries its measured numbers in its CHANGELOG entry.

The fleet contract, recorded here (folding the cut decisions/0015): `createFleet(
inventory, bind, opts?)` returns a handle `{ registry, Class, capacity,
acquire(initials?), release(vm), at(i), size(), stats(), dispose() }`. The
eager-prefill law is the spine -- all `capacity` members are constructed and
parked at construction, so `acquire` never constructs (it pops an `Int32Array`
free-list and `reinitReactive`s a parked member) and `release` parks the member
back after a per-fleet symbol slot-stamp check; both hot bodies allocate zero.
Six internal named fail-closed errors guard the misuses -- `FleetExhaustedError`,
`FleetForeignMemberError`, `FleetDoubleReleaseError`, `FleetDisposedError`, a
`RangeError` on out-of-range `at`, and a `TypeError` on a bad `bind`. These are
NOT exported: one exported error class remains the surface law
(`ReactiveDisposedError`); the fleet names are message/name-level, pinned by
test/20. Construction is atomic (a mid-prefill throw disposes what was built and
destroys the fleet-owned registry). `dispose()` disposes every member LIVE AND
PARKED then destroys the registry. The extraction ground is the demo diff (the
hand-rolled pool removed for the helper). The boot-cost honesty: the eager prefill
moves construction to load -- ~7ms one-time at N=4096, reported not hidden, the
price of a zero-alloc steady state.

Candidates 1 (`bump`) and 7 (`onObserved` sugar) REMAIN DEFERRED behind the
original real-consumer bar, restated and unchanged. The original bar RESUMES as
the only track for anything new: the strategic track was a four-rung instrument,
now spent.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
