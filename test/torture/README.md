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
| ordering-torture  | inverts one PD-8 rejection assertion (static-member) |
| lifecycle-torture | expects the second disposeReactive to return true |
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
| emit-matrix       | semantic | 1.5.0 | fixture-hash freshness + L2/L4/L6/L8 on the TS AND Babel emits |
| ordering-torture  | semantic | 1.5.0 | PRNG inheritance shapes (single-anchor delta, declaration order) + full PD-8 rejection matrix |
| lifecycle-torture | semantic | 1.5.0 | anchor/rootOf, cascade-once, idempotent double dispose, DV-1 detachment, `using`, post-dispose throws |
| pool-conservation | semantic | 1.5.0 | F-0 over 4096 churn cycles + S1-A3 capacity-primed mid-wiring CapacityError |
| zerogc-torture    | semantic | 1.5.0 | zero-GC read + write lanes (maxMajor 0, maxPauseMs 4, control-floored maxMinor) |

The `soak` group is empty in 0.1.0; `--group soak` prints a notice and exits 0.
