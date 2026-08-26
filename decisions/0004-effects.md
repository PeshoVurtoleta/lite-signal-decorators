# 0004 -- @reactiveEffect wiring + manual-call policy

Status: ACCEPTED (S0), rewritten 2026-08-26 on committed cold-process numbers
after the reviewer flagged the original deciding figures as coming from an
uncommitted throwaway probe. Evidence: `spikes/manual-call.mjs` (guarded variant
now committed; K=10 cold child processes; run
`node --expose-gc spikes/manual-call.mjs`, exits 0), lite-signal 1.5.0.

## Context

`@reactiveEffect` decorates a method that auto-runs as an effect once the
instance is fully wired. The DRAFT returned the raw method, so a MANUAL call to
it from inside another (foreign) tracking scope registers its reads as the
caller's dependencies -- a silent over-subscription (finding D-04). This record
fixes how the auto-effect is wired and what the public method does when called
by hand.

## Correction (why this record was rewritten)

The first cut cited a speed table (raw 4.64 / guarded 6.08 / wrapped 7.12) from
an "integrator re-measurement" that had NO committed script -- unreproducible
from the repo, the exact failure S0 exists to prevent, and the committed spike
at the time measured only raw + wrapped and printed the OPPOSITE policy. The
guarded variant is now a committed method in `spikes/manual-call.mjs`, measured
over K=10 cold processes. The load-bearing correctness result (raw leaks,
untrack does not) always reproduced; only the cost numbers were unverifiable.

## The measured options (committed, K=10 cold-process, common untracked path)

Leak test (call the method inside an outer effect, mutate a dep it read, count
outer re-runs; 0 = clean):

| variant | outer re-runs | ns/op (med-of-med) | clean? |
|---------|---------------|--------------------|--------|
| raw | 1 | 4.81 | NO -- leaks (D-04) |
| guarded (`isTracking() ? untrack(() => body) : body`) | 0 | 6.73 | yes |
| wrapped (`untrack(() => body)`) | 0 | 8.02 | yes |

`gc.major === 0` for all three; bytes/op is informational sampling noise, not a
gate (manual-call is a cold path). Numbers reproduced on an independent
integrator run (raw 4.81 / guarded 6.73 / wrapped 8.02) and match the ordering
of the original throwaway probe -- now committed and re-runnable.

## Decisions

### D-4a -- separate the auto-effect body from the public method (the integration trap).

The auto-effect MUST track (that is how it establishes its dependencies). The
public manual-call method MUST NOT leak. These cannot be the same function: if
the untracked/guarded form were used AS the effect body, the effect would record
zero deps and never re-run. Wiring keeps a reference to the ORIGINAL (tracking)
method for the effect and exposes the guarded form as the public prototype
method:
```
// wiring (host step, under runWithOwner(anchor)):
effect(() => original.call(instance), { scheduler });   // tracks -> re-runs correctly
// public replacement on the prototype:
proto[name] = function (...args) {
  return isTracking() ? untrack(() => original.apply(this, args))
                      : original.apply(this, args);
};
```

### D-4b -- manual-call policy: GUARDED.

The public method uses the `isTracking()`-guarded form. It is clean (no D-04
leak) AND the cheapest clean option (6.73 vs wrapped 8.02 ns/op, 19% cheaper),
paying the `untrack` closure ONLY when actually called inside a foreign tracking
scope (rare); the common untracked path is the bare body behind a
branch-predicted `isTracking()` read. RAW is rejected -- a silent dependency
leak is precisely the bug class this package exists to not have, and "documented
caveat" undersells a rigor-first package when a near-free fix exists. WRAPPED is
rejected as strictly dominated by guarded (same cleanliness, higher common-path
cost). Manual invocation is a COLD path (the method auto-runs as an effect), so
the absolute ns is informational, not a hot-path gate.

### D-4c -- scheduler pass-through.

`@reactiveEffect({ scheduler })` forwards `scheduler` straight to
`effect(fn, { scheduler })` (confirmed in the 1.5.0 d.ts). No wrapping.

## Consequences

- S2 implements D-4a exactly (original for the effect, guarded for the public
  method) and re-measures the guarded common-path number on the real class.
- `batch-untrack-torture` (S2b) pins: a manual call inside a foreign effect adds
  ZERO edges (the guard fires), while the auto-effect re-runs correctly on dep
  change (the original still tracks).
- README migration note: MobX `@action`-style manual invocation maps to a safe
  guarded call here; the auto-effect is the primary contract.

## Evidence

`spikes/manual-call.mjs` (leak test raw=1/guarded=0/wrapped=0; K=10 cold-process
common-path speed raw 4.81 / guarded 6.73 / wrapped 8.02). `isTracking()` is
exported by lite-signal 1.5.0 and is O(1).
