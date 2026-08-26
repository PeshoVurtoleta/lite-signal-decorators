# 0008 -- introspection & audit (costOf, labels, auditReactive)

Status: ACCEPTED (S4). Evidence: the S4 scratchpad probes (costOf Q3 +
double-probe determinism; per-registry labels + devtools walk; audit
child-process catch), all run 2026-08-26, peer 1.5.0, Node 26.3.1.

## Context

S4 grows the surface 11 -> 16 with cost accounting, devtools identity, and a
leak auditor. The binding constraint: the hot accessor canon
(`makeGet`/`makeSet`/`makeDerivedGet` + the accessor wiring) stays
byte-identical, and OFF-mode measures identical to 0.3.0. Everything new is
cold-path or opt-in.

## Decisions

### D-8a -- costOf measures, twice, or throws (PD-21).

`costOf(Factory)` runs a stats-delta probe on the factory's BOUND registry
(`plan.reg`; the DEFAULT_REG facade carries `stats` so the default registry works
without adding `stats` to the 11-method duck-check set -- and a custom registry
that lacks stats is refused up front by a named guard, see the amendment below):
snapshot, construct, read
every `@derived` once (forcing the lazy links -- 0007), snapshot, dispose,
verify the registry returned to its pre-probe floor. It runs TWICE and requires
IDENTICAL `{nodes, links}` deltas; a disagreement (a data-dependent derived read,
or a registry mutated mid-probe) THROWS -- an inconclusive cost is a fail-closed
result, never a guessed number. Node count is cross-checked against the R-A law
`P+D+E+1` and a floor-verify failure throws. Result is frozen and cached per
class in a `WeakMap` (shape is frozen at decoration, so nothing invalidates it).
Cold path; constructs the probe instance with no arguments (documented).

Rejected: returning a best-effort number on divergence (a lying cost is worse
than no cost); measuring on a throwaway registry (cost is registry-independent by
shape, but probing the bound registry also proves the class actually wires there).

### D-8b -- labels are per-class strings in per-registry maps, gated once (PD-23).

`enableLabels(bool)` flips a module flag (default OFF). Node ids are PER-REGISTRY,
so labels live in `WeakMap<reg, Map<nodeId, string>>` keyed by the plan's `reg`
(the facade or a custom Registry) -- a module-global map would collide across
registries. Label STRINGS (`"Class.prop"` for signals/deriveds, `"Class#method"`
for effects, `"Class@anchor"`) are built once per class and shared by every
instance. `labelOf(idOrHandle, registry?)` resolves a handle through the
registry's `nodeId`; an unknown id returns `undefined` (an introspection miss is
not an error). `disposeReactive` unregisters the instance's entries while ON
(the instance stores its registered ids under a private symbol, because effect
dispose handles are otherwise discarded); entries left by an OFF flip drop lazily
(the map is debug state).

OFF-mode law, honored: labels + audit share ONE combined gate
`INTROSPECT_ON = LABELS_ON || AUDIT_ON`, tested exactly ONCE at wiring and ONCE
at dispose. The OFF wiring branch is byte-identical to 0.3.0 (the effect loop is
duplicated, not branched per-iteration), so no per-node flag test and no
allocation land on the OFF path; the hot accessor canon is untouched. A3 zerogc
lanes pass unchanged.

Rejected: a module-global id->label map (cross-registry id collision); labeling
via `forEachOwned` order-matching (fragile -- captured effect handles map 1:1 to
plan order instead); a per-instance flag test in the effect loop (would tax the
OFF path E times per construction).

### D-8c -- audit is an opt-in FinalizationRegistry, created lazily (PD-24).

`auditReactive(bool)` (default OFF). On first enable it lazily creates ONE
`FinalizationRegistry`; while ON, wiring registers each instance (held value =
a plain `{ className, shape }` record that does NOT close over the instance, so
the FR never retains what it watches; unregister token = the instance) and
`disposeReactive` unregisters it. A collected-without-dispose instance triggers
one `console.error` naming the class + shape. OFF: no FR exists, nothing is
registered, wiring/hot paths measure unchanged.

**Honest limitation (recorded).** A FinalizationRegistry fires only when the
TARGET is collected. An undisposed instance whose `@derived`/`@reactiveEffect`
node bodies close over `this` is PINNED by those nodes as long as their registry
is alive -- so on a long-lived (e.g. default) registry such an instance is never
collected and audit cannot fire for it. That retention IS the leak, and it is
caught structurally by the retention/leak torture lanes, not by audit. Audit's
FR catch fires for instances that DO reach GC without dispose -- most usefully a
per-scope registry dropped whole (instance + nodes collectable together), proven
in the child-process test. Documented so the tool's reach is not oversold.

### D-8d -- diagnostics: the cold mis-assembly paths were already named (PD-24b).

The mandate was to enumerate the reachable raw-`TypeError` paths a
mis-assembled/half-wired class can hit and upgrade exactly those to named errors
at cold sites. The enumeration (probe: unhosted construction; reads/dispose/
boxOf/rootOf on an unwired `Object.create(W.prototype)`; a decorated method
called on a foreign/`{}` receiver; boxOf/rootOf/dispose on null/primitive/plain
object) found EVERY reachable cold-path failure ALREADY fails closed with a named
error -- the S1/S2 design (missing-host `throwMissingHost`, PD-4 prewired named
`TypeError`, `throwNotWired`, `throwNoPlan`, the D-4e identity guard, the D-2h
rollback) leaves no reachable raw path, and the hot accessor bodies (excluded by
law) are shielded by the prewired/poison handles. The S4 additions therefore
contribute named validation for the NEW surfaces only (`costOf`/`capacityFor`/
`labelOf`/`enableLabels`/`auditReactive` bad-arg + inconclusive paths). Finding:
no raw upgrade was reachable; the invariant is recorded so a future regression is
loud.

**Amendment (S4 review -- the "no reachable raw path" claim above was falsified
for one S4-introduced path; recorded, not erased).** The reviewer found a raw
path the enumeration missed: the 11-method REG_METHODS duck-check deliberately
EXCLUDES `stats`, so a hand-rolled registry facade constructible from the public
surface (`@reactiveHost({ registry })` / `defineReactive` `host: { registry }`)
can be duck-valid yet lack `stats()`. `costOf` on a class bound to such a
registry reached `probeCost`'s `reg.stats()` and threw a RAW
`TypeError: reg.stats is not a function` -- no ERR prefix, no fix hint -- and
`capacityFor` inherited it through its `costOf` calls. Closure: `costOf` now
guards `typeof reg.stats !== "function"` immediately after resolving `plan.reg`
and throws the named `throwCostNoStats(ctorName)` (ERR-prefixed, naming the class,
with the fix: use a `createRegistry()` registry, which always carries the stats
ledger). `capacityFor` surfaces the SAME named error unwrapped through its costOf
call. The invariant "every reachable cold path fails closed named" now holds for
the S4 surface too; the falsification is preserved here so the gap in the original
enumeration is not silently forgotten.

## Devtools upstream proposal (recorded for the user; LiteDevtools NOT edited)

lite-devtools 1.4.0 exports `graph()/toTree/...` with NO label hook. Our
`labelOf(id, registry)` already annotates a devtools walk from `rootOf(vm)`
today (the integration test resolves ids the walker yields), needing no devtools
cooperation. The one-line upstream ask to make it first-class:

> **Proposal:** `graph()` / `toTree()` accept an optional `labelResolver(id) =>
> string | undefined` so hosts can annotate nodes inline (lite-signal-decorators
> would pass its `labelOf`), instead of the host post-joining ids to labels.

Surfaced to the user; not implemented in LiteDevtools' repo this stage.

## Evidence

costOf Q3 nodes 1/2/15/29 + double-probe identical + cache identity; capacityFor
`[[Widget,3]]` -> `{maxNodes:12,maxLinks:6,...}` holding exactly 3 (4th throws
`CapacityError`); labels resolve for anchor/signal/derived/effect and via a
`forEachOwned` walk, and clear on dispose; audit child-process reports exactly
the dropped instance (per-scope registry), never the disposed one.
