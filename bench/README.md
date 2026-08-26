# Benchmark methodology -- the class-reactivity microscope

This folder is a private, never-shipped sub-package. It benchmarks
`@zakkster/lite-signal-decorators` against the class-reactivity field on ONE
rule, inherited from the `@zakkster/lite-signal` rig: **no number is publishable
unless the harness can prove it measured identical work under a stamped,
reproducible protocol.** Every mechanism below makes that rule enforceable by
code, not by trust.

It is not part of the package `files[]`; `npm pack` at the package root shows
`total files: 7` and never this directory. `bench/node_modules/` is gitignored;
`bench/package-lock.json` IS committed so the matrix reproduces from a clean
clone with one command.

---

## Why a CLASS benchmark

The signal-level microscope answers "how fast is one `.get()`". It cannot answer
the questions a decorator layer actually lives or dies on, because those are
per-INSTANCE and per-LIFECYCLE:

- **Per-instance storage.** A decorated accessor's real-world alternative is a
  hand-written instance field `this.bx.get()` (the RAW-FIELD baseline of
  `decisions/0003`), not a module-const signal box. The kill-criterion is the
  decorated read staying within 2.0x of RAW-FIELD -- a ratio only a
  class-shaped harness can measure.
- **Fleet IC-shape megamorphism.** Ten thousand instances of the same VM stress
  V8's inline caches in a way one instance never does; a string-keyed backing
  dict (the layout 0003 rejected) degrades here and nowhere else.
- **Lifecycle churn.** Construct + wire + one write + dispose, repeated, is the
  headline. A decorator layer that allocates on teardown, or fails to recycle
  its owner pool, shows up only under churn and retention -- never in a steady
  `.set` loop.

So the shapes here are class factories driven through the package's own Stage-3
protocol emitter (`test/shared/mock-emitter.mjs`, PD-16): no transpiler in the
bench, one emitter drives every decorator engine, and the emitter's fidelity to
TS 5 / Babel `2023-11` emit is already pinned by the package's own tests.

---

## The engine matrix (`frameworks.mjs`, single source of truth)

`benchmark.mjs` derives its engine list from `ENGINE_KEYS` and asserts an
adapter plus a per-scenario builder exists for every declared key -- the two
files cannot drift silently.

| key | label | kind | class mechanism |
| :--- | :--- | :--- | :--- |
| `lsd` | lite-signal-decorators | ours | `@reactive` / `@derived` / `@reactiveEffect` / `@reactiveHost` via the protocol emitter |
| `lsd-define` | lsd defineReactive | ours | the shipped buildless twin, stock Node |
| `lite-raw-boxes` | lite-signal raw boxes | honesty baseline | instance fields over `signalBox()` + explicit dispose list (the 0003 RAW-FIELD pattern) |
| `mobx` | MobX 7 | ref | documented class API |
| `signal-utils` | signal-utils + signal-polyfill | ref | TC39 polyfill `Signal.State` / `Signal.Computed` in class fields |
| `alien-class` | alien-signals class | ref | instance fields over `alien-signals` primitives |
| `classy-solid` | classy-solid + solid-js | candidate | admitted iff PD-16, else an exclusion line below |
| `reactively` | @reactively/decorate | candidate | admitted iff PD-16, else an exclusion line below |

---

## The seven scenarios (shapes are LAW)

Every adapter builds all seven or returns `{ unsupported: "<reason>" }` for a
scenario. The drive loops are line-for-line the same algorithm across engines
(same op mix, same indices, same reads); no shared verb indirection dilutes the
ratios. Each scenario's exact drive index math is written once in its scenario
file header and copied verbatim into every engine's closure.

| key | shape | drive(i) | reported |
| :--- | :--- | :--- | :--- |
| `vm-write` | 1 VM, P=4, D=2 | write field `i & 3`, read d0 -> sink | ops/s (kill-criterion 1) |
| `fleet-read` | 10,000 VMs, P=4, D=2 | read d0 of VM `i % 10k` -> sink | ops/s (megamorphism exposure) |
| `fleet-tick` | 10,000 VMs, P=4, D=2 | write one field of VM `i % 10k`, read its d0 -> sink | ops/s |
| `cascade` | 1 VM, P=64, D=16 + 1 aggregate | write field `i & 63`, read aggregate -> sink | ops/s |
| `deep-vm` | 1 VM, P=1, chain D=64 | write x, read d63 -> sink | ops/s |
| `churn` | construct (P=4, D=2, E=1), 1 write + 1 read, dispose | the loop IS the op | ops/s (HEADLINE; kill-criterion 2) |
| `retention` | 4096 cycles of the churn shape | -- | retained-heap delta + GC collection counts (GATES, not ops/s) |

---

## Run order

Requires `--expose-gc` on every command. Install deps first (`npm install`).

```sh
# 1. Prove the harness can FAIL: kernel checks + the sabotaged-adapter checksum.
npm run selftest

# 2. The full matrix -- every engine x every scenario, median-of-5, stamped.
npm run bench

# 3. CI smoke: one rep per lane (checksum + drift still enforced).
npm run bench:quick

# Filters, as in the LiteSignal harness:
FW=lsd,mobx SCEN=vm-write,churn npm run bench
```

Output is written to stdout AND appended to `results.txt` under a machine stamp.
The run exits non-zero if any lane's checksum fails.

---

## The anti-DCE sink (`lib/sink.mjs`)

V8's escape analysis deletes computations it can prove have no observable
effect. Every `drive(i)` writes into a `Float64Array(4096)` rooted on
`globalThis`; after each timed loop the sink is summed and checked against the
scenario's analytically derived `expectedSum`. Any elided or skipped work
changes the sum and REJECTS the lane. The sum is a contract, not a soft check,
and it is engine-independent (default equality everywhere), so a "faster"
adapter that writes less is caught on the first run.

Properties that make it un-foldable: a typed array (a typed-element store IC V8
cannot elide), rooted on `globalThis` (always reachable), read AFTER the loop
(every write is load-bearing), indexed with a power-of-two bitmask
(`& (SIZE-1)`, no per-write division). `--expose-gc` is mandatory or the heap
columns are meaningless.

The checksum is proven able to FAIL by `lib/_selftest.mjs`: a minimal fake
adapter that skips every 64th write is REJECTED, while the writes-every-iter
control passes. If that test cannot fail the cheat, no green lane means
anything.

---

## Provenance: the machine stamp (`lib/stamp.mjs`)

Every output begins with a machine-generated `#STAMP`: engine sha256 (of
`SignalDecorators.js`), harness sha256, node version, arch, platform, CPU model,
date, reps, and every third-party adapter's RESOLVED version. Hand-written
factual headers are abolished -- they are how result files drift from the code
that produced them. Aggregation (`lib/collect.mjs` + `lib/guards.mjs`) refuses
to merge files whose stamps disagree (mixed engine hash, mixed protocol, mixed
host) or whose count does not match the claimed reps.

---

## Run sizing and the columns (PD-19)

Each timed run is sized to 50-300 ms (timer noise < 1%); the primary score is
the **median** of 5 runs, with **min** shown alongside for spread. GC is forced
between runs. Columns:

- **median / min** -- median-of-5 timed runs; min for distribution tightness.
- **heapMed / heapP95** -- transient heap allocated per timed run, GC-fenced
  around each run (raw alloc pressure + its tail).
- **retained** -- post-forced-GC heap growth OVER a post-forced-GC baseline
  captured before the lane's timed reps. Every per-run build is disposed inside
  the reps loop, so a clean lane returns to that floor (retained ~ 0KB) and a
  lane that holds memory past dispose moves the column above it. It is a real
  measurement, never a reading subtracted from itself.
- **sink** -- `sink=ok` if the anti-DCE sum matched the oracle; `sink=REJECTED`
  voids the lane and the run exits non-zero.

`churn` and `retention` are effect-duty lanes: each lane exposes `liveness()`
(a monotonically-advanced effect counter, PD-18) and the runner FAILS the lane
with a non-zero exit if `liveness() <= 0` -- a dead effect counter is not a
green lane. `retention` is additionally a GATE lane: fixed 4096 cycles,
reporting `retainedDelta` (post-GC growth over the pre-lane post-GC floor) and
GC `major` / `minor` collection counts, NOT ops/s. `churn` is the headline.

---

## Drift law (PD-17)

A declared engine missing an adapter, or an adapter missing a builder for a
declared scenario, is a runner ERROR -- drift is impossible. The only exception
is a candidate engine (`candidate: true` in `frameworks.mjs`) named in
`adapters/_exclusions.mjs`, which prints its reason and is skipped. A builder
may also return `{ unsupported: "<reason>" }` for a single scenario, which is
printed, not fatal.

---

## Exclusions

Candidate engines admitted or excluded per PD-16 (imports as plain ESM in stock
Node; class reactivity reachable via standard `2023-11` decorators through the
emitter, or via the engine's own documented non-decorator class API). Each
exclusion names its exact blocker.

- `classy-solid` -- EXCLUDED: reactivity is dead in stock Node. solid-js's
  default Node resolution is its non-reactive SSR build, and classy-solid
  imports `solid-js` internally with no deep-import escape, so live class
  reactivity requires running the whole process under `--conditions=browser`
  -- a non-stock-Node run condition.
- `@reactively/decorate` -- EXCLUDED: ships only legacy
  (`experimentalDecorators`) decorators -- signature
  `(proto, key, descriptor)` returning a descriptor -- which the
  standard-2023-11 emitter cannot drive, and the package exposes no
  documented non-decorator class API.
- `mobx` -- ADMITTED via its documented `makeObservable` annotations form
  (both documented forms produce identical checksums; `makeObservable`
  measured fastest-or-equal and needs no emitter).
- `signal-utils` + `signal-polyfill` -- ADMITTED via the TC39 polyfill
  primitives (`Signal.State`/`Signal.Computed`) wrapped as public accessors
  for member-syntax parity; effects use the documented
  `Signal.subtle.Watcher` drain pattern.

---

## Standing rules (enforced by the harness, not by prose)

1. No number is published unless its file carries a stamp and the run exited 0.
2. One shape name = one definition. Every adapter builds the section-2 shape or
   marks it `unsupported`; no adapter does less work than the spec.
3. Budgets and the kill-criterion ratios never widen to pass.
4. The bench is a private sub-package; it never enters the package `files[]`,
   and it never patches around a package bug -- a real bug routes to the core.
