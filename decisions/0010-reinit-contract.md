# 0010 -- pooled reinit contract (the S6 spike)

Status: ACCEPTED (S6-T1). Verdict: **EXIT A** -- PARK+REINIT (PD-42(b)) can hold
`maxMajor 0` AND zero delta-heap per acquire/release cycle on the installed peer.
Evidence: `spikes/reinit-contract.mjs` (run `node --expose-gc
spikes/reinit-contract.mjs`; exits 0, prints the four tables + the VERDICT line).

Rig / stamp: Node v26.3.1, arm64, Apple M4 Pro, `@zakkster/lite-signal` **1.5.0**
(installed peer, `node_modules/@zakkster/lite-signal/package.json:3`). Session
date **2026-08-30**; the spike's auto-provenance line reads `date=2026-08-29`
from the machine clock -- both are recorded so neither is a silent edit.

## Context

PD-41 makes S6 spike-first: the roadmap ship bar is `maxMajor 0` AND zero
delta-heap per acquire/release cycle, and three of the four allocation sources
are already visible in the source (the 3+D+E wiring closures, the instance
object, the effect nodes the cascade destroyed). The fourth -- whether
`reg.signalBox()` / `reg.computedBox()` / `reg.effect()` hand back POOLED handle
objects or freshly allocated JS descriptors on the 1.5.0 engine -- is not
answerable from this repo and is the single fact that decides feasibility. This
record measures it, plus three companion questions, and selects exit A or B
BEFORE a line of `reinitReactive` is written. An ambiguous result is exit B by
law (PD-29: unproven means hazardous).

The CHURN shape (`bench/scenarios/churn.mjs:28`) is the unit under test: P=4
signal boxes, D=2 derived boxes, E=1 effect, +1 R-A anchor = **P+D+E+1 = 8**
engine nodes per instance. The probe replicates `wireInstance`'s node build
(`SignalDecorators.js:874-924`) raw against the peer registry.

## The four questions

- **Q1 (feasibility)** -- do `signalBox`/`computedBox`/`effect` return pooled
  handle objects or fresh JS descriptors per call? Distinguish engine NODE reuse
  (stats/pool) from JS HANDLE allocation (heap), because both matter.
- **Q2 (conservation)** -- after `dispose(anchor)` + per-box dispose, does
  re-creating the same P+D+E+1 shape return `stats()` to its exact pre-cycle
  values (`activeNodes`, `poolGrowths` delta 0, ledger balanced) over 4096
  cycles, at `maxMajor 0` and zero delta-heap?
- **Q3 (prebuild premise)** -- can ONE effect-body closure created once be handed
  to `reg.effect()` repeatedly across cycles without the engine retaining the
  previous registration?
- **Q4 (aliasing hazard)** -- after dispose + re-create, does a SURVIVING
  external reference to the OLD box handle observe the new instance's data
  (fail-open aliasing) or fail closed?

## Measured numbers (Node v26.3.1, 2026-08-30, peer 1.5.0)

Q1 -- 100_000 create/dispose pairs, forced-GC brackets, zero-alloc control in
the same process:

| prim | activeDelta | poolGrowths | ledgerOk | fresh handle? | retained B/pair |
|------|-------------|-------------|----------|---------------|-----------------|
| signalBox | 0 | 0 | true | true | -0.027 |
| computedBox | 0 | 0 | true | true | 0.035 |
| effect | 0 | 0 | true | true | 0.000 |
| zero-alloc-ctl | 0 | 0 | true | - | -0.011 |

Per LIVE box retained (node+handle, sized registry, K=50_000) = ~0.0 B while
held above forced-GC noise resolution; returns to ~0.01 B/box after release.

Q2 -- 4096 build/teardown cycles of the CHURN shape:

| phase | activeNodes | poolGrowths | totalAlloc | totalDisp |
|-------|-------------|-------------|------------|-----------|
| baseline | 1 | 0 | 669639 | 669638 |
| peak-live (1 inst) | 9 | 0 | - | - |
| after-4096 | 1 | 0 | 702407 | 702406 |

- shape delta at peak == P+D+E+1 (8): true; activeNodes back to baseline: true;
  poolGrowths delta 0: true; ledger balanced: true.
- GC over the window: **major=0**, minor=0, maxMs=0.00.
- delta-heap SCALING: 4096 cyc -> 2.109 B/cyc; 32768 cyc -> 0.639 B/cyc
  (matched zero-alloc control 0.182 B/op). The per-cycle figure does NOT hold as
  the window grows 8x -- it falls -- which is the signature of fixed forced-GC
  endpoint noise, not a per-cycle leak. (A real leak holds its per-cycle byte
  count regardless of N; fixed noise amortizes toward zero.)

Q3 -- one prebuilt effect body reused across 4096 register/dispose cycles:

| metric | value |
|--------|-------|
| stale (disposed) fires | 0 |
| cycles live-fired correctly | 4096/4096 |
| activeNodes baseline->after | 2->2 |
| poolGrowths delta | 0 |
| retained B/cycle | 3.867 (noise) |

Q4 -- stale-handle aliasing after dispose + re-create into a recycled slot:

| probe | value |
|-------|-------|
| nodeId(old) live | 1001673 |
| nodeId(old) after dispose | undefined |
| nodeId(new) | 1001674 |
| old.peek() live | 111 |
| STALE old.peek() | undefined |
| STALE old.get() | undefined |
| new.peek() | 222 |
| new.peek() after stale set(999) | 222 |
| corrupted new resident? | false |

## Findings

### Q1 -- NODE pooled, HANDLE freshly allocated per call, neither retains.

The engine NODE is fully pooled: over 100_000 create/dispose pairs of each of
`signalBox`/`computedBox`/`effect`, `activeNodes` delta is 0, `poolGrowths` delta
is 0, and the ledger stays balanced (`totalAllocations - totalDisposals ===
activeNodes`). No pool growth, no node allocation on the steady-state churn.

The JS HANDLE is a fresh object per call: a create/dispose/create sequence
reuses the node slot (`nodeId` is monotonic, the disposed handle's `nodeId`
degrades to `undefined`) but yields a DISTINCT handle object (`h1 !== h2`). This
matches the peer's own documentation -- a box handle is an `Object.create(proto)`
descriptor, not a pooled object. Consequence for the design: **a handle cannot
be re-pointed at a new node; reinit must build a fresh descriptor per acquire.**

Crucially, neither cost RETAINS. The retained heap per create/dispose pair sits
at or below the in-process zero-alloc control (all rows within +/-0.04 B/pair vs
the control's -0.011 B/op). The fresh handle is transient garbage the moment its
node is disposed -- scavenged as minor garbage, never promoted.

### Q2 -- the CHURN shape conserves exactly and holds maxMajor 0.

Building and tearing the full P+D+E+1 graph 4096 times returns `activeNodes` to
its exact baseline, holds `poolGrowths` delta at 0, keeps the ledger balanced,
and the peak live-node delta is exactly 8 (= P+D+E+1). The GC profiler reports
**major=0, minor=0** over the window. Delta-heap, measured by scaling (the honest
reading against forced-GC endpoint noise), FALLS from 2.109 to 0.639 B/cycle as
the window grows 4096 -> 32768, landing at/below the matched zero-alloc control +
the GC resolution budget. There is no per-cycle heap growth: the engine
conserves, and the only per-acquire allocation (fresh handles + the wiring
`getOwner()` descriptor) is transient minor garbage.

### Q3 -- one prebuilt closure drives N registrations with zero retention.

Handing a SINGLE effect-body closure to `reg.effect()` across 4096 cycles: the
disposed registration fires **0** times after its dispose (the new registration
fires correctly on create and on mutate every one of 4096 cycles), `activeNodes`
returns to baseline, `poolGrowths` delta is 0, and retained heap is flat (noise).
The engine retains nothing of a disposed registration, so the PD-42 premise holds
directly: the 3+D+E wiring closures can be built ONCE per instance and re-fed to
the engine on every acquire without accumulation.

### Q4 -- the engine fails CLOSED; no fail-open aliasing.

After disposing a box and re-creating one into the recycled slot, the stale
handle's `peek()`/`get()` both return `undefined` (the ABA gen-stamp guard the
peer documents for `peek()`/`read()`/`set()`), `nodeId` degrades to `undefined`,
and a stale `set(999)` does NOT corrupt the new resident (`new.peek()` stays
222). There is no cross-instance aliasing at the engine level.

Required defense (recorded for Coder A): the engine already prevents data
corruption, but a consumer holding a `boxOf` handle deserves a NAMED error, not a
silent `undefined`. So at RELEASE the API must swap each live slot to its
per-class `rec.parked` handle (PD-44); `boxOf`/`rootOf` then return the parked
handle and throw a parked-specific `ReactiveDisposedError` on touch. A handle a
consumer already EXTRACTED before release degrades to `undefined` (engine ABA
guard), never aliases the reused slot. **No new engine capability is required.**

## VERDICT -- EXIT A (binding)

PARK+REINIT per PD-42(b) can hold `maxMajor 0` AND zero delta-heap per
acquire/release cycle. The numbers prove the prebuilt-closure-set approach
suffices:

- **maxMajor 0** is available: Q2 measures major=0 (and minor=0) over a
  4096-cycle window; the transient per-acquire garbage (handles + one
  `getOwner()` descriptor) is minor-scavenged, never promoted.
- **zero delta-heap** is available: Q1/Q2 show the engine pools every node
  (`poolGrowths` delta 0, ledger balanced, `activeNodes` back to baseline) and no
  create/dispose or build/teardown cycle retains heap above the in-process
  zero-alloc control (Q2 delta-heap falls to 0.639 B/cyc at 32768 cyc <= control
  0.182 + GC resolution; the scaling proves it is fixed noise, not a leak).

The design MUST avoid two allocations, and the numbers show how:

1. **The 3+D+E wiring closures per acquire** (`SignalDecorators.js:874-924`: the
   `createRoot` thunk, the anchor `effect` body, the `runWithOwner` thunk, plus
   one `makeDerivedBody` per derived and one `makeEffectBody` per effect). A
   reinit that re-calls `wireInstance` allocates 3+D+E = 6 closures per CHURN
   cycle and the gate fails by construction. Q3 proves the fix: one closure,
   built once, drives N registrations with 0 stale fires and flat heap -- so the
   closure set is prebuilt ONCE at first wiring and stored in one instance slot,
   amortized to zero across acquire/release cycles.
2. **Growing the node pool** (Q2 `poolGrowths` delta 0). Reinit re-acquires into
   the same pool; a sized registry (0002 D-2e / S4 `capacityFor`) covers
   fleet-scale live sets.

The irreducible per-acquire transient is the box HANDLE descriptors -- a handle
is gen-bound to a recycled node (Q4), so it cannot be reused and reinit builds a
fresh one per box. Q1 proves this transient does not retain and does not force a
major, so it fits under the stamped budgets (`maxMajor 0` STRICT, minors
CONTROL-RELATIVE at `MINOR_FLOOR + 128`).

Consequence: S6 proceeds to exit A -- `reinitReactive` ships as export #17 (and
the release half if 0011's shape rationale admits it), gated by
`test/torture/reinit-torture.mjs` at the stamped budgets, with the llms.txt
`:206-210` single-lifetime sentence resolved by name (S6-T8). This spike is the
gate; no `reinitReactive` line is written before this record exists.

## Peer-registry watch (PD-46)

`npm view @zakkster/lite-signal dist-tags` on 2026-08-30:

```
latest:       1.5.0
rc:           1.5.0-rc.2
next:         1.4.0-next.0
beta:         1.6.0-beta-1
prview:       1.6.0-preview.1
preview:      1.9.0-preview.6
canary:       1.9.0-canary.1
alpha:        1.8.0-alpha.7
experimental: 1.8.0-experimental.1
```

**Outcome (i): nothing promoted.** The stable `latest` tag is still **1.5.0**.
1.6.x (`createScope`) exists only as prerelease (`beta` 1.6.0-beta-1, `prview`
1.6.0-preview.1); 1.9.x (engine `Symbol.dispose`) exists only as prerelease
(`preview` 1.9.0-preview.6, `canary` 1.9.0-canary.1) -- exactly the tags the
gate's peer-preview lane already tracks. Therefore no per-feature floor is
promoted this session, `torture:peer-preview` keeps reporting per tag, the
`scope-adoption` and `using-dispose` scenarios keep skipping 77 legitimately, and
the peer RANGE floor stays `>=1.5.0 <2.0.0`. Detection remains export-probing
only (PD-25); no semver string parsing enters the runtime. This is recorded so a
reader does not wonder why the two scenarios skip.

## Evidence

`spikes/reinit-contract.mjs` (Q1..Q4 tables + VERDICT; exits 0, SPIKE line PASS).
dist-tags probe run 2026-08-30. Consumed by S6-T2/T3 (exit A implementation) and
S6-T4 (peer watch). Numbers are reported as measured; the exit-A verdict follows
the arithmetic against S6-A1's bar, not the desired outcome.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
