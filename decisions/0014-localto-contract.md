# 0014 -- the localTo contract (S8-T1 spike ratification)

Status: ACCEPTED (S8-T2). Verdict: **EXIT A** -- ship `@localTo`. Evidence:
`spikes/localto-contract.mjs` run green (exit 0) against the installed peer
`@zakkster/lite-signal` **1.5.0** on 2026-08-30 (Node v26.3.1, arm64, Apple
M4 Pro). Plan: PLAN-S8; policy: decisions/0013 strategic track, criterion
(a) -- PD-51 proved the composed form semantically wrong; this record pins
the in-package semantics the spike measured.

## The ratified shape

`localTo(source, options?)` -- a NEW accessor decorator (NOT an option on
`@reactive`: the shared reactive/derived `validateOptions` key set would
silently admit `@derived({source})`, a fail-open -- planner spelling call,
PLAN-S8). `source` is a REQUIRED tracked `(self) => value` fn called inline
in the read body (no extra node, PD-54). `options.equals` governs ONLY the
upstream compare (PD-56); the write path never compares -- a write always
overrides. Buildless twin: a 5th `defineReactive` spec section
`locals: { key: { source, equals?, initial? } }`, fail closed on a
missing/non-fn source (PD-57). Storage per member: ONE signal box (the local
value) + ONE plain per-instance seen-slot (the last-adopted upstream value)
-- the seen-slot is never reactive. Cost formula: **P + L + D + E + 1**
(measured: P=2,L=1,D=1,E=1 -> 6 nodes exactly; the local's delta is +1 node,
+0 for the slot).

**The read law (purity).** `makeLocalGet` is PURE: call source (tracked),
compare to the seen-slot via equals (default Object.is), return the local
box `.get()` when upstream is unchanged, else the upstream value. NO write
of any box on the read path -- proven write-free by an `onGraphMutation`
tally of 0 node/link/recompute ops over 1e5 reads. The peer TOLERATES
mid-compute writes (measured: no throw, side box observed = 9); tolerance
is noted and UNUSED -- purity stays the design law, so a localTo read is
legal inside any @derived compute.

**The initial-value unification rule** (integrator synthesis, pinned here
for implementation + review): a declared initializer means the member
STARTS at that value and resets on the first upstream move (the
@trackedReset flavor); an OMITTED initializer means the initial is the
source value evaluated once at wiring -- the member FOLLOWS upstream from
the first read (the @localCopy flavor). One decorator, both field
semantics, selected by the natural syntax.

## The ABA contract (shipped, documented, asserted)

No public epoch exists: NodeDescriptor is exactly {id, kind, value}
(Signal.d.ts:165-172); the peer's internal node.version lives behind a
private symbol -- reaching for it is impure and REJECTED. Therefore the
upstream compare is VALUE-based, and the ABA sequence is the contract:
upstream A -> local write X -> upstream B -> upstream returns to an
equals-A value -> the read shows the STALE LOCAL X (the reset requires the
upstream to CHANGE relative to the last adoption, not to have moved
transitively). tracked-toolbox's shipped @localCopy has the same property.
It is documented in README/llms and ASSERTED in torture (S8-A6), never
softened. A custom coarse `equals` widens override survival deliberately
(measured: floor-equals held an override across a 1.0 -> 1.4 upstream move
that Object.is would have reset).

## The lattice (measured, S8-Q6)

- wiring: seen = upstream-at-wiring; read = the initial (per the
  unification rule above).
- local write: box = value, seen = upstream-at-write; read = the override.
- upstream change (per equals): read = upstream (reset); the box keeps the
  stale local until the next write (never written on read).
- reinit (PD-58): box -> initial, seen -> CURRENT upstream; initials[]
  accepts local keys; post-reinit reads follow the rule table from scratch.
- park: the seen-slot is RETAINED as a plain record field; the box node is
  released with the rest and re-created on reinit (both reset per PD-58).
- dispose: the slot is poisoned -- every touch throws the named
  ReactiveDisposedError (the spike's prototype degraded to undefined; the
  SHIPPED path uses the house slot-poison and must throw by name).
- source throw: propagates from the read, ZERO node ops, nothing mutated
  (fail closed; measured with a throwing source).

## Measured budgets (the bar the implementation must hold)

Read AND write loops at N and 8N: **0.000 B/op** (control-relative +2 B
tolerance), gc.major **0**, maxPauseMs 0.07 (<= 4.0), minors 7 vs an
in-process zero-alloc control (+128 law). Tracking shape: a derived over
one local holds EXACTLY 2 source edges (upstream + box), 0 extra nodes over
1e5 reads. Honest hot cost: a localTo read measured **1.69x** a plain box
read -- two tracked reads plus a compare versus one; documented as-is. The
1.0.0 canon (makeGet/makeSet/makeDerivedGet) is untouched by @localTo and
must stay toString-byte-identical (S8-A5).

## Rejected alternatives

- **Epoch via the peer's private node symbol** -- impure, unversioned
  internals; rejected outright.
- **Effect-based reset** -- PD-51: clobbers a user write one tick late;
  the reason this feature exists in-package at all.
- **`@reactive({source})` spelling** -- shared validator fail-open (above).
- **Adopt-on-read (writing the box during read)** -- would make a localTo
  read illegal inside computes and violate purity; the pure compare form
  needs no adoption write.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
