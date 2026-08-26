# S0 spikes -- summary

All spikes run on Node v26.3.1, arm64, 12x Apple M4 Pro, 2026-08-26, against
`@zakkster/lite-signal@1.5.0`. Every spike is standalone and exits 0.

Re-run everything:
```
node spikes/emit/regen.mjs && node spikes/emit/probe.mjs
node --expose-gc spikes/ownership.mjs
node --expose-gc spikes/storage-bench.mjs
node --expose-gc spikes/manual-call.mjs
node --expose-gc spikes/poison.mjs
node --expose-gc spikes/buildless.mjs
```

## Per-spike verdicts

| Spike | Closes | Verdict |
|-------|--------|---------|
| emit/probe | 0001 wiring-site, L1..L8 | PASS (7 laws PASS, L5 documented divergence) |
| ownership | 0002 lifecycle, R-A vs R-B, DV-1, F-0 | PASS (R-A viable, detached-by-default correct) |
| storage-bench | 0003 storage, kill-crit 1 | PASS (K=10 cold-process; S-A symbol chosen; kill-crit-1 CLEARED at ~1.01x vs instance-field baseline) |
| manual-call | 0004 effects/manual-call | PASS (K=10 cold-process; guarded policy, committed variant) |
| poison | 0002 poison-on-dispose | PASS (throws, 0-byte swap, unbranched read) |
| buildless | 0005 defineReactive | PASS (shared function identity) |

## Kill criteria -> measured baselines

| Kill criterion (ROADMAP sec.0) | Measured result | Status |
|--------------------------------|-----------------|--------|
| 1. Decorated read within ~2.0x of raw `signalBox.get()` | K=10 cold-process: winner ~1.01x vs the honest instance-field baseline (worst-case ~1.08x); the ~2.1x vs a module-const is the signalBox indirection cost EVERY reactive property pays (RAW-FIELD is itself 2.13x), not a decorator tax; layouts allocation-free (major 0, <0.6 B/op floor) | CLEARED WITH MARGIN -- README leads with the honest "~1.0x vs instance-field, ~2x vs module-const (shared indirection)" framing (AD-6) |
| 2. Churn holds `maxMajor: 0`, conservation | poison.mjs 1000 install/dispose cycles: activeNodes to baseline, poolGrowths 0, alloc-disp reconciles; storage read/write 0 bytes/op maxMajor 0 | ON TRACK -- full 4096-cycle churn + fleet soak proven in S1/S2 |
| 3. TS vs Babel emit agree on load-bearing laws | L1..L8: all load-bearing laws identical on both emitters; only L5 (metadata exposure) differs and is handled by the WeakMap-default plan store | CLEARED -- no fail-closed rejection needed; both emitters supported |

## Design determined by S0 (inputs to S1)

- **Wiring (0001):** member decorators only register + replace; no member
  `addInitializer` creates nodes (L3/D-01 structurally avoided). Single wiring
  site = most-derived `@reactiveHost` ctor after `super()` (L4). Plan store =
  module `WeakMap<ctor, plan>`; `context.metadata` is a Babel-only optional
  cache. Legacy emit rejected by `typeof arg2.kind === "string"` predicate.
- **Lifecycle (0002):** R-A single anchor (`createRoot` + `effect` + `getOwner`
  + `runWithOwner`); +1 node/instance; cascade dispose exactly-once + idempotent.
  Detached-by-default (DV-1). `@reactive` boxes created bare in `init`, disposed
  explicitly by the class plan. Conservation via F-0 (activeNodes / poolGrowths /
  reconcile), NOT nodePoolPopulation.
- **Storage (0003):** S-A symbol slot; `this[SLOT].get()` / `this[SLOT].set(v)`
  (same symbol-slot mechanism 0002's poison/dispose already uses). S-A/S-B tied
  on read ns; S-A chosen on poison-consistency + emitter-independence + fleet.
- **Effects (0004):** auto-effect wraps the ORIGINAL tracking method; the public
  method is the `isTracking()`-GUARDED form (clean + cheapest clean option);
  scheduler passes straight through.
- **Poison (0002):** per-class prebuilt frozen handles; 0-byte dispose swap;
  unbranched live read; post-dispose get/set throw `ReactiveDisposedError`.
- **Buildless (0005):** `defineReactive` shares the exact register/install/wire
  function identities with the decorator entries.
- **Pool ceiling (0002):** default registry is 1024 nodes / 4096 links, throw
  policy -> S1 conservation scenarios churn a bounded live set on the default
  registry; fleet-scale node-count scenarios use a sized `createRegistry`.

## Findings folded in

- F-0 -- conservation signal correction (in 0002).
- D-01 -- avoided structurally (0001, L3 evidence).
- D-03 -- dict rejected on measured fleet megamorphism (0003).
- D-04 -- manual-call leak fixed by the guarded form + original/public split
  (0004); the DRAFT's "return raw method" would have leaked, and a naive
  untracked reuse would have broken the auto-effect (integration trap, recorded).
- D-08 -- pooled signals disposed explicitly by the class plan (0002).

## DONE-WHEN (S0-A1..A5)

- S0-A1 every spike runs via `node --expose-gc` and exits 0 -- YES.
- S0-A2 L1..L8 hold on both emitters (L5 divergence recorded) -- YES (0001).
- S0-A3 Q1..Q5 answered with reproducible exhibits, nothing assumed -- YES (0002).
- S0-A4 storage winner within 2.0x of raw, else consequence recorded -- YES
  (rewritten on K=10 cold-process aggregation): winner ~1.01x vs the honest
  instance-field baseline, CLEARED WITH MARGIN; the ~2.1x vs module-const is
  the shared signalBox indirection cost, recorded in 0003 with the AD-6
  three-tier framing. The earlier single-process 1.711x/S-B verdict was
  rejected by QA + reviewer and superseded.
- S0-A5 decisions 0000..0005 exist with OPTIONS/NUMBERS/CHOICE/CONSEQUENCES,
  none deferred -- YES.

S0 is fully determined by recorded numbers; S1's design has no open assumptions.
