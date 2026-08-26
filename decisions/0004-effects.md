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

## D-4d -- self-dispose from an owned effect (added 0.2.0-preview.1, S2a)

Status: ACCEPTED (S2a). Evidence: probe run 2026-08-26 (peer 1.5.0, Node 26.3.1,
`scratchpad/d4d-probe.mjs`), recorded verbatim below.

### Context

`@reactiveEffect` wires the auto-effect UNDER the instance anchor (D-4a). A body
that calls `disposeReactive(this)` therefore cascades the very owner it is
running in. The question S2a must pin: is that allowed, and with what semantics?
An effect is not a `@derived`, so the D-2f purity guard (which fires only for a
derived disposing its own computation) must NOT intercept it.

### Probe (run 2026-08-26, peer 1.5.0, Node 26.3.1)

| Case | Result |
|------|--------|
| dispose(anchor) from inside an OWNED effect, clean return | fires exact (3), no throw, conservation exact |
| same, then keep reading a bare signal in the same run | read succeeds, no throw, conservation exact |
| effect body throws on FIRST run under runWithOwner | propagates synchronously to the effect() call site |
| nodeId(effectDisposeHandle) === getOwner().id inside the body | true |

### Ruling: self-dispose from an owned effect is ALLOWED.

Pinned semantics:

- The CURRENT run completes normally; a clean return does not throw.
- Any LATER decorated-member touch in the remaining body throws
  `ReactiveDisposedError` (the poison law -- the slot was swapped for its poison
  handle by `disposeCore`), named `Class.key`.
- No FUTURE re-runs: the effect node was cascaded by the anchor dispose, so a
  subsequent dependency change re-runs nothing.
- Conservation is EXACT: `disposeCore` runs once (idempotency sentinel on the
  anchor), and a second `disposeReactive(this)` returns `false`.
- The `disposeReactive(this)` call returns `true`.
- The D-2f derived guard must NOT fire for effects: it iterates `plan.deriveds`
  only, and an effect owner's `nodeId` never matches a derived slot's box, so a
  self-dispose from an owned effect is never mistaken for a derived's impure
  self-dispose. A test pins this non-interference.

### Consequences

- `disposeReactive` keeps its D-2f guard scoped to deriveds; effects pass
  through to `disposeCore` unimpeded.
- Documented in llms.txt beside the D-2f line.

### D-4e -- manual-call identity guard (added 0.2.0-preview.1, S2a QA finding)

Status: ACCEPTED (S2a QA). Applies to BOTH manual public forms: the
`@reactiveEffect` guarded method AND the `@batched` batched method.

QA repro: extract a decorated method function and call it on a wrong receiver --
`Class.prototype.m.call(foreign)`, `.call(null)`, `.call(primitive)`, or on an
UNRELATED reactive instance of another host. The old public form only checked
`rec.plan === null` (a per-rec, receiver-blind guard), so a manual call on a
foreign `this` sailed past it and ran the body against a receiver that has no
matching slots -- surfacing a confusing raw error (or worse, a partial effect)
instead of a named fail-closed refusal.

Ruling: after the `p === null` missing-host check, add a plan-membership check on
`this`:
```
const ip = planOf(this);
if (ip === undefined || ip.byKey.get(rec.key) !== rec) throwNotWired(`${p.ctorName}.${keyLabel(rec.key)}`);
```
Mechanism -- byKey IDENTITY, not plan identity: ancestor recs are merged into a
subclass plan BY REFERENCE, so a `Derived` instance calling a `Base`-declared
method resolves `ip.byKey.get(key) === rec` and passes. A foreign/cross-class
reactive instance has a different rec (or none) under that key and fails closed;
`planOf(null | primitive | plain object)` returns undefined and fails closed --
all through the existing `throwNotWired` message shape. During-construction
calls still pass this check (the plan exists) and fail closed DOWNSTREAM via the
PD-4 prewired slots (unchanged). A disposed instance still passes (its plan and
byKey are intact) and fails closed via the poison slots -- preserving QA's
disposed-contrast pin.

Cost: the check is on the COLD manual-call path only (`@reactiveEffect` auto-runs
as an effect over the ORIGINAL fn, which is untouched; `@batched` is action-grade
by contract). Zero effect on the hot accessor canon or the auto-effect body.

QA repro lives in `test/10-qa-s2a-boundary.test.mjs` (manual-call clusters E1/E2).
