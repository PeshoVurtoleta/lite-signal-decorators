# torture suite -- @zakkster/lite-signal-decorators

Process-isolated stress + conservation scenarios for the decorator core. Each
scenario is a standalone `node --expose-gc <file>.mjs` executable; the runner
spawns them as serial child processes so one scenario's residue on the global
lite-signal pool cannot poison the next one's baseline.

## Run

```
node test/torture/run.mjs                    # every scenario
node test/torture/run.mjs --group semantic   # correctness lane (CI)
node test/torture/run.mjs --group soak       # resource soaks (empty in 0.1.0)
node test/torture/run.mjs --list             # show the table and exit
node test/torture/run.mjs --bail             # stop at the first failure
node test/torture/run.mjs --lenient          # floor-escalation FAIL -> WARN
node test/torture/run.mjs --controls         # self-test: every scenario's break
```

npm scripts: `torture`, `torture:semantic`, `torture:soak`, `torture:controls`.

Every scenario is independently runnable while iterating:

```
node --expose-gc test/torture/ordering-torture.mjs
```

## Exit codes (child contract)

| code | meaning |
|------|---------|
| 0    | pass |
| 1    | fail |
| 77   | legitimate skip (installed peer below the scenario's floor) |
| 78   | harness/infrastructure error (missing fixture, unreadable manifest) |

Floor escalation: a child that exits 77 while the installed
`@zakkster/lite-signal` peer is AT or ABOVE the scenario's floor is a FAILURE
(the surface should exist -- a skip can only mean a dropped export). `--lenient`
downgrades that single verdict to a WARN.

## TORTURE_BREAK -- the control self-test

Every scenario reads `TORTURE_BREAK`; when it names the running scenario, the
scenario SABOTAGES its own central assertion and must then exit non-zero.
`--controls` runs the whole table with `TORTURE_BREAK=<name>` set and FAILS the
gate for any control that still exits 0 (a gate that cannot fail is not a gate).

| scenario | break injects |
|----------|---------------|
| emit-matrix       | skips the Babel half (completeness counter catches it) |
| ordering-torture  | expects E+1 effect first-runs (the effect start-count gate) |
| lifecycle-torture | expects a post-dispose box write to re-fire the stopped effect |
| pool-conservation | leaks one instance every 256 cycles (skips its dispose) |
| zerogc-torture    | allocates `new Array(1024)` per op in the read lane |

## TORTURE_SEED -- replay

Scenarios using the PRNG (ordering, pool) seed a xorshift32 from `TORTURE_SEED`
(default a fixed literal). Any failing `check` prints `seed=<seed> op=<index>`,
so a case replays exactly:

```
TORTURE_SEED=12345 node --expose-gc test/torture/ordering-torture.mjs
```

## Scenarios

| scenario | group | floor | asserts |
|----------|-------|-------|---------|
| emit-matrix       | semantic | 1.5.0 | fixture-hash freshness + L1(methods)/L2/L4/L6/L8 on the TS AND Babel emits |
| ordering-torture  | semantic | 1.5.0 | PRNG inheritance shapes (single-anchor delta P+D+E+1, declaration order, effect start-once-at-leaf) + full PD-8 rejection matrix (incl. effect/batched rows + stacking) |
| lifecycle-torture | semantic | 1.5.0 | anchor/rootOf, cascade-once (P+D+E+1), idempotent double dispose, DV-1 detachment, `using`, post-dispose throws, effect start-timing, dispose-stop, D-4d self-dispose (clean + poison), foreign-manual-call zero edges |
| pool-conservation | semantic | 1.5.0 | F-0 over 4096 churn cycles (E<=3 shapes) + capacity-primed derived-overflow AND first-effect-overflow CapacityError + registry-isolation (bound churn, default frozen) |
| zerogc-torture    | semantic | 1.5.0 | zero-GC read + write lanes (maxMajor 0, maxPauseMs 4, control-floored maxMinor); the canon is untouched by S2a and batched is excluded (R8) |

The `soak` group is empty in 0.1.0; `--group soak` prints a notice and exits 0.

## S2a effect + registry lanes

The effect lanes (`@reactiveEffect`) drive the mock `method` member kind and the
real emits' method members. They pin: an effect starts exactly once at leaf
wiring after every field of every class in the chain is initialized; a captured
box write after `disposeReactive` fires the effect zero times; D-4d self-dispose
from inside an owned effect (clean return + poison-touch); and that a manual call
of an effect method from a foreign effect adds zero dependency edges. The
registry-isolation lane hosts a shape family on `createRegistry({ maxNodes: 256 })`
and proves the default registry's stats stay frozen while the bound registry's
own `stats()` balances F-0. `@batched` never appears in a zero-GC gate (R8: it
carries a documented per-call thunk cost measured in the Workstream B probe).
