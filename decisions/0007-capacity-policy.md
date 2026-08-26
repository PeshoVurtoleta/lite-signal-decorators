# 0007 -- capacity-sizing policy (costOf links + capacityFor)

Status: ACCEPTED (S4). Closes the open question deferred from 0002:65-67 (link
accounting for `costOf`/`capacityFor`). Evidence: the link-variance probes run
2026-08-26 (peer 1.5.0, Node 26.3.1; scratchpad, numbers pasted below).

## Context

`costOf` returns a measured per-instance `{ nodes, links, ... }`; `capacityFor`
turns an inventory of `[Factory, count]` pairs into a `createRegistry` config.
Nodes are trivially deterministic (R-A law: `P + D + E + 1` per instance, fixed
at decoration -- 0002 Q3). Links are NOT allocated at construction (lite-signal
computeds are lazy: a computed forms its source links only when first read), so
the sizing question is: how many links does a settled instance hold, and is that
number a stable maximum we can provision exactly?

## Measured evidence (activeLinks delta, construct -> read every derived -> dispose)

Fixed-shape deriveds (each derived reads a constant set of members):

| shape | derived reads | links measured | second probe | dispose floor |
|-------|---------------|----------------|--------------|---------------|
| s2=a+b, s3=a+b+c, all=a+b+c+d | 2 + 3 + 4 | 9 | 9 | 0 (exact) |
| diamond l=a,r=a,top=l+r | 1 + 1 + 2 | 4 | 4 (read top only) | 0 (exact) |

- Reading a derived that transitively forces other deriveds yields the SAME
  total (`read-top-only` == `read-all` == 4): first-full-read captures the whole
  settled link set.
- Two independent probes of the same class produce IDENTICAL link counts.
- Dispose returns `activeLinks` to the pre-probe floor every time.

Branchy deriveds (dynamic dependency -- reads depend on a selector signal):

| case | first-read links | after widening the branch |
|------|-------------------|---------------------------|
| out = pick? a : b (each branch reads 2) | 2 | 2 (same width) |
| out = wide? a : (a+b+c) (asymmetric) | 2 (narrow branch) | 4 (wide branch) |

- The engine REPLACES a computed's links on recompute (it does not accumulate):
  `activeLinks` reflects the CURRENTLY-active branch, not a cumulative maximum.
- A derived whose active branch later reads MORE members than the branch taken
  during the probe needs more links than `costOf` measured. Sizing a registry to
  the narrow first-read (`maxLinks: 2`) and then widening the branch throws
  `CapacityError` at link formation (measured -- P-3 loud/named contract).

## Decision

- **Nodes: exact.** `capacityFor` sets `maxNodes = sum(cost.nodes x count)` with
  +0 slack. Node count per instance is deterministic; the only way to need more
  nodes is more instances, which is an inventory change, not headroom.
- **Links: first-full-read sum, with a `headroom` multiplier (default 1.0 =
  exact).** `costOf.links` is the first-full-read `activeLinks` delta, forced by
  reading every `@derived` once; the double-probe guarantees it is deterministic
  or `costOf` throws. `capacityFor` sets
  `maxLinks = max(1, ceil(sum(cost.links x count) x headroom))` -- links are
  floored at the engine's minimum of 1 (after the multiplier) so a signals-only
  inventory (link total 0) still yields a constructible config, since
  `createRegistry` rejects `maxLinks: 0`.
- **The caveat (documented, loud failure mode).** For FIXED-shape deriveds the
  first-full-read link count is the stable maximum and default `headroom: 1`
  provisions exactly. For BRANCHY deriveds whose active branch can read more
  members than the branch measured, the exact sizing under-provisions and the
  engine throws `CapacityError` at link formation (named, per the P-3 raw-engine
  law -- the package never softens it). The `headroom` knob (a multiplier `>= 1`
  applied to links) is the escape hatch for such workload-bound dynamic-
  dependency graphs: size with `capacityFor(inv, { headroom: 2 })` to double the
  link budget. Reaching for `prealloc: "grow"` on the returned config is the
  other option (the caller edits the config; `capacityFor` never picks `grow`
  because its whole value is a deterministic eager budget).

## Consequences

- `costOf` reproduces 0002 Q3 nodes exactly (1 / 2 / 15 / 29 for
  (0,0,0)/(1,0,0)/(8,4,2)/(16,8,4)) and reports links = the settled first-read
  count (0 for a signals-only shape; N for N distinct source reads).
- `capacityFor([[W, k]])` output holds exactly `k` instances of `W` and throws
  `CapacityError` on the `k+1`-th (both node-bound and link-bound), proven in
  capacity-torture's round-trip lanes.
- The open question in 0002:65-67 is CLOSED: links are accounted at first-full-
  read; dynamic-dependency variance is a documented caveat with a headroom knob,
  not a silent guess.

## Evidence

Link-variance probes (fixed shapes stable across reads and probes; branchy
asymmetric branch 2 -> 4 links; tight-sized registry throws `CapacityError` on
widening). All exit 0.
