# 0006 -- kill-criteria verdicts (S3, the class-reactivity benchmark)

Status: ACCEPTED (S3, 2026-08-26). Evidence: `bench/results.txt` (stamped:
node v26.3.1, arm64, Apple M4 Pro, engine sha 5543bee8..., reps 5, all lanes
`sink=ok`, run exit 0). Reproduce from a clean clone with one command chain:
`cd bench && npm install && npm run bench` (the harness self-test is
`npm run selftest`; it must FAIL the sabotaged adapter first, and does).

## Context

ROADMAP sec.0 set two kill criteria the package must clear before the 1.0
line, to be judged by the first class-shaped harness (BRIEF1 S3):

1. **The 2.0x line.** The decorated hot path stays within 2.0x of the honest
   baseline -- a hand-written instance-field lite-signal class
   (`lite-raw-boxes`, the 0003 RAW-FIELD pattern) -- on VM-WRITE and
   FLEET-READ.
2. **Churn cleanliness.** Construct/use/dispose churn holds `maxMajor: 0`
   with pools at floor (F-0), i.e. the lifecycle story survives measurement.

Method: 6 admitted engines x 7 scenarios, anti-DCE sink with analytic
expected-sum oracles (any skipped work rejects the lane), median-of-5 with
min, GC-fenced runs, per-lane real retained column, effect-liveness
machine-gated on lifecycle lanes. Candidates `classy-solid` and
`@reactively/decorate` were probed and excluded per PD-16 (reasons in
`bench/adapters/_exclusions.mjs`, verified independently by review).

## Criterion 1 -- the 2.0x line: **CLEARED WITH MARGIN**

Medians, this stamp (ratio = lane / lite-raw-boxes):

| lane | vm-write | ratio | fleet-read | ratio |
|---|---:|---:|---:|---:|
| lite-raw-boxes (baseline) | 56.66ms | 1.000x | 26.93ms | 1.000x |
| **lsd (decorators)** | **53.41ms** | **0.94x** | **29.72ms** | **1.10x** |
| lsd-define (buildless) | 69.50ms | 1.23x | 27.91ms | 1.04x |

- vm-write at 0.94x reproduces 0003's finding that the symbol-slot accessor
  and a hand-written instance field are statistically TIED (~1.0x, winner
  swaps between cold runs; treat 0.94x as "at parity", not "faster").
- fleet-read at 1.10x over 10k instances confirms the S-A layout does not
  degrade at fleet scale (the megamorphism hazard that killed the dict
  layout).
- Both numbers sit far inside 2.0x. The "lead with the bad number"
  positioning-rewrite branch is NOT taken.

## Criterion 2 -- churn cleanliness: **CLEARED**

| lane | retention (4096 cycles) | gc.major | gc.minor | churn transient heap/run |
|---|---:|---:|---:|---:|
| **lsd** | retainedDelta -87.5KB | **0** | **0** | 3.7MB |
| lsd-define | -146.7KB | 0 | 0 | 0.9MB |
| lite-raw-boxes | -145.6KB | 0 | 0 | 46.7MB |
| mobx | +26.7KB | 0 | 1 | 49.8MB |
| signal-utils | +108.5KB | 0 | 1 | 19.5MB |
| alien-class | +0.6KB | 0 | 0 | 28.8MB |

- All three lite lanes: zero major AND zero minor collections across 4096
  lifecycle cycles, retained delta at-or-below the post-GC baseline (the
  negative deltas are settle-below-floor, not growth). Pool F-0 (activeNodes
  to baseline, poolGrowths 0, allocations == disposals) is asserted INSIDE
  the churn and retention lanes -- a violation exits non-zero; this run
  exited 0. The package-suite `fleet-soak` scenario independently holds F-0
  + flat heap + gcGate maxMajor 0 under 10s of fleet load with churn
  rotations.
- The decorated churn loop generates ~12.6x less transient garbage per run
  than the hand-rolled raw-boxes churn (3.7MB vs 46.7MB) -- the per-class
  plan does at decoration time what the hand-written class re-does per
  instance.

## Published context (AD-6 honesty tiering -- every number ships)

- `alien-class` is the fastest engine on most ops/s lanes (churn 7914K/s vs
  our 1332K/s). Its churn speed rides on ~28.8MB/run of transient garbage
  (7.8x ours) swept by the collector -- the classic speed-vs-GC-pressure
  trade this suite exists to refuse. Reported, not hidden.
- Wide/deep NON-criterion shapes show a real gap vs raw boxes: cascade
  (P=64/D=16+agg) 2.31x, deep-vm (64-deep chain) 1.59x, identical for lsd
  and lsd-define (so it is the shared anchor-owned wiring, not decorator
  emit). Recorded as an S4 investigation candidate (owned-computed recompute
  overhead at wide shapes); the criterion lanes are unaffected.
- Measurement condition on cascade: the lite-raw-boxes and alien-class
  aggregates use a 16-read loop while the other four lanes use literal
  16-term bodies; review measured the difference as not flattering any
  ratio (all lanes do 16 computed reads), and cascade is not a criterion
  lane. Noted for precision.
- mobx 7.0.3 and signal-utils 0.21.1 lanes report their own measured
  collections and heap (e.g. fleet-read transient heap: mobx ~31.9MB,
  signal-utils ~7.8MB, ours ~0.4MB per run); their numbers are stamped and
  reproducible, measured through their documented class APIs at identical
  semantic work (checksum-proven).

## Consequences

- Both criteria CLEARED: the package proceeds toward S4/S5 with the
  positioning unchanged -- the README's honest-baseline lead (~1.0x
  instance-field, measured) now carries a cross-framework stamp behind it.
- The cascade/deep-vm gap is on the S4 docket (capacity accounting stage)
  as a measured, bounded observation -- never to be optimized by weakening
  the wiring's ownership guarantees.
- `bench/results.txt` is the canonical stamped artifact; any future engine
  or adapter change re-runs the full matrix and appends a new stamp.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
