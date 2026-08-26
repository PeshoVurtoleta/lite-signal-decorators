# 0002 -- instance ownership, lifecycle, conservation, poison

Status: ACCEPTED (S0). Evidence: `spikes/ownership.mjs`, `spikes/poison.mjs`
(run `node --expose-gc spikes/ownership.mjs`, `... spikes/poison.mjs`; both
exit 0). Rig: Node v26.3.1, arm64, Apple M4 Pro, lite-signal 1.5.0.

## Context

lite-signal 1.5.0's `createRoot(fn)` runs `fn` fully detached (owner=null,
tracking off) and returns `fn`'s value -- it hands back NO disposer. An owner is
only a computed/effect node. So a per-instance "root" that cascade-disposes an
instance's whole reactive graph is not a given: it must be built, and the build
must be proven. This record fixes the mechanism, the detach policy, the
conservation signal, and the poison-on-dispose layout, all on measured evidence.

## FINDING F-0 -- the conservation signal (correction to BRIEF1)

`nodePoolPopulation`/`linkPoolPopulation` are the counts of ReactiveNode/Link
objects PHYSICALLY CONSTRUCTED (`nodePool.length`). With the default eager
prealloc they start at pool capacity (observed 1024 nodes / 4096 links) and only
ever GROW (via `poolGrowths`); they never shrink on dispose because the pool
reuses slots. So "pools return to their floor" (BRIEF1 sec.1/S1-A3, as written)
is the WRONG signal. The correct conservation / zero-GC invariants, used by
every spike here and by every S1+ torture scenario:

1. `activeNodes` returns to its pre-test baseline after teardown.
2. `poolGrowths === 0` across the run after warmup.
3. `totalAllocations - totalDisposals === activeNodes` in any quiescent moment.

BRIEF1 sec.1 and S1-A3 are amended accordingly; the S1 torture harness helper
implements these three, not `nodePoolPopulation`.

## Decisions

### D-2a -- lifecycle mechanism: R-A (single-anchor cascade).

Build one detached anchor effect per instance and own all deriveds/effects
under it:
```
let anchor;                                   // describe-handle
createRoot(() => { effect(() => { anchor = getOwner(); }); });
runWithOwner(anchor, () => { /* create computedBoxes + effects -> owned */ });
// teardown:
dispose(anchorHandle);                        // cascades to all owned children
```
Q2 evidence (D=4, E=2, expected cascade = anchor + D + E = 7 nodes): both the
`getOwner()` describe-handle and the `effect(...)` return dispose the same owner
and cascade all 7 exactly once (`eachOnce true`, `toBaseline true`); a second
dispose is a zero-change no-op with zero further cleanups (`idempotent true`).

Rejected R-B (flat plan, no anchor): Q3 shows R-A costs exactly +1 node (the
anchor) over R-B across the whole (P,D,E) grid, links identical. That one node
buys a single-handle cascade teardown and keeps `rootOf(vm)` a tree lookup
instead of R-B's flat-array enumeration. The +1 node is the correct price.

Q3 cost grid (per instance):

| P,D,E | R-A nodes | R-A links | R-B nodes | R-B links |
|-------|-----------|-----------|-----------|-----------|
| 0,0,0 | 1 | 0 | 0 | 0 |
| 1,0,0 | 2 | 0 | 1 | 0 |
| 8,4,2 | 15 | 0 | 14 | 0 |
| 16,8,4 | 29 | 0 | 28 | 0 |

(Links are 0 at construction because computeds are lazy -- links form on first
read. `costOf`/`capacityFor` in S4 must account for read-time link growth; see
open question in 0007.)

### D-2b -- `@reactive` signal boxes are created bare in accessor `init` (not adopted).

Q1: a `signalBox` created inside a live effect body is NOT adopted -- disposing
the enclosing effect frees only the effect (activeNodes drop of 1, not 2), and
the box remains live and readable. So the accessor `init` calls `signalBox(v)`
directly; no `createRoot`/`runWithOwner(undefined,...)` wrap is needed for
correctness. Because signals are never owned, they are also never cascade-
disposed by the anchor -- the class dispose plan disposes each `@reactive` box
EXPLICITLY (a pooled signal never returned is a leaked slot: finding D-08).

### D-2c -- detached-by-default (DV-1 resolved).

An instance's anchor is created via `createRoot`, so it is detached from any
enclosing computation. Q4 exhibit:
- ADOPT (child built in a live parent effect, no createRoot): the parent's
  re-run cascade-disposes the VM and installs a fresh one -- the old VM's effect
  is dead (fires 1->2->3, then replaced). The hazard is real.
- DETACH (R-A createRoot): the VM survives the parent re-run and keeps firing
  (1->2->3->5). Correct.
`disposeReactive`/`using` always owns the instance lifecycle. Adoption
(`reactiveHost({ scope: "adopt" })`) is a post-1.0 opt-in admitted only with a
real consumer, never the default.

### D-2d -- dispose order + poison-on-dispose (P3), zero-cost on the live path.

`disposeReactive(instance)`, idempotent via a wired/disposed marker:
1. `dispose(anchorHandle)` -- cascades owned deriveds + effects (once).
2. For each `@reactive` slot in the per-class plan: `dispose(instance[slot])`
   (return the signal box node to the pool), then
   `instance[slot] = POISON[slot]`.
3. Clear label registrations if enabled (0007/S4).

POISON is a per-class, per-property, prebuilt FROZEN handle
(`{ get(){throw new ReactiveDisposedError(cls,key)}, set(){throw...} }`), shared
by all instances of the class, built once at decoration time. `poison.mjs`
proved:
- post-dispose get AND set of every slot throw `ReactiveDisposedError` naming
  `class.prop`;
- the dispose swap is 0 bytes/op (bare `dispose(box); slot = POISON[k]` -- no
  new closures/arrays);
- the live read path is UNBRANCHED -- getter source is
  `function(){ return this[slot].get(); }` with no disposed-ness guard; the
  throw comes from the swapped handle, not a branch (live get 16.07 ns/op,
  0 bytes/op, maxMajor 0);
- conservation (F-0) holds over 1000 install/dispose churn cycles.

### D-2e -- pool-ceiling note (design input for S1 torture + S4 capacity).

The default registry preallocates 1024 nodes / 4096 links with
`onCapacityExceeded: "throw"`. Any scenario with > ~1024 simultaneously-live
reactive nodes (fleet tests, large soaks) must either CHURN (bounded live set)
or run against a sized `createRegistry({ maxNodes, ... })`. S1 conservation
scenarios prove F-0 on the DEFAULT registry via bounded-live churn; fleet-scale
node-count scenarios use a sized registry. This is exactly what `capacityFor`
(S4) automates.

### D-2f -- dispose re-entrancy guard (added 0.1.0, S1 QA finding).

QA (`test/07-qa-boundary.test.mjs`, case 277) found a fail-open hole: a
`@derived` getter whose body calls `disposeReactive(this)` returned
`undefined` for that read, silently. Repro: the read enters the derived's
`boxComputedGet`, the body cascades the anchor via `disposeCore`, the derived's
own node is recycled (gen bump), and on return `boxComputedGet` sees the
generation mismatch and discards the freshly computed value. No throw, no
value -- a silent drop.

Ruling (fail-closed law): a graph self-mutation from inside one's own
derivation is a USER ERROR and must throw named. Derived getters must be pure.
The 0004 precedent -- a documented caveat is not acceptable when a near-free
fix exists -- applies: we throw rather than paper over it in the README.

Mechanism (chosen on alloc profile; verified in `Signal.js`: `isTracking()` and
`nodeId()` are alloc-free, `getOwner()` allocates one descriptor per call):
`disposeReactive`, after the not-wired check and BEFORE `disposeCore`, gates on
`isTracking()`. When false (the plain-code and effect-driven dispose paths) the
path is byte-identical to D-2d and zero-alloc. When true, it pays ONE
`getOwner()` descriptor and scans the plan's deriveds for a live box whose
`nodeId` equals the current owner's `id`; a match throws
`throwSelfDisposeInDerived(ctorName, key)`. No guard lives in `disposeCore` (the
wiring-failure path runs no user code) and the hot bodies are untouched.

Cost profile: zero on the untracked dispose path (the common case, D-2d holds);
one `getOwner()` descriptor allocation under an active tracking context (rare --
e.g. a manager effect disposing children, which remains legal and proceeds).

Two limits, queued to S2b interop-torture, remain engine-level silent-drop
territory until deeper support exists:
(a) an INDIRECT self-dispose routed through an intermediate raw-engine computed
    is NOT caught -- `getOwner()` sees only the innermost computation, whose id
    is the raw computed, not our derived;
(b) wrapping the call in `untrack()` bypasses the `isTracking()` gate entirely.
`@reactiveEffect` self-dispose semantics are an S2a decision, out of scope here.

## Consequences

- One anchor per instance; `rootOf(vm)` returns the anchor handle and feeds
  lite-devtools `forEachOwned`/`graph` directly.
- The class dispose plan is: [dispose anchor] + [dispose each signal box] +
  [poison-swap each slot]; allocation-free; idempotent.
- S1's `disposed-poison` and `pool-conservation` torture scenarios assert D-2d
  and F-0 respectively; `lifecycle-torture` pins the Q4 DV-1 exhibit as a
  regression.

## Evidence

`spikes/ownership.mjs` (Q1..Q5 tables), `spikes/poison.mjs` (throw + 0-byte swap
+ unbranched read + conservation). Both exit 0; SPIKE lines PASS.
