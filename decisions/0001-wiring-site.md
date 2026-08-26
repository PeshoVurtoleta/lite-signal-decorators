# 0001 -- single wiring site + the emit-ordering laws

Status: ACCEPTED (S0). Evidence: `spikes/emit/probe.mjs` (run
`node spikes/emit/regen.mjs && node spikes/emit/probe.mjs`, both exit 0).

## Context

Stage-3 decorators run their hooks at fixed points in class construction. The
DRAFT crashed because it created reactive nodes from a non-static method's
`addInitializer`, which fires BEFORE instance fields exist (finding D-01). The
architecture must be built on the ACTUAL, measured ordering of both real-world
emitters (TS 5 standard emit and Babel `plugin-proposal-decorators` `2023-11`),
not on the proposal text. This record pins that ordering and derives the wiring
rule from it.

## The eight laws, as measured on both emitters

| Law | Result | Observed (TS / Babel) |
|-----|--------|-----------------------|
| L1 member apply = source order; class applies last | PASS both | members `x,y,d,m` in order, class after all; **static member decorators apply FIRST, before instance members, on both** |
| L2 accessor `init` at field-def time, declaration order | PASS both | `init x` before `init y`; `y = this.x + 1` yields `2` (x's box exists when y initializes) |
| L3 method/getter `addInitializer` runs BEFORE field initializers | PASS both (the D-01 trap) | TS: addInit(d)@12, addInit(m)@13, field-init@16 -> 13<16. Babel: addInit(d)@21, addInit(m)@22, field-init@25 -> 22<25 |
| L4 `new.target` in base ctor = most-derived ctor | PASS both | `new Base/Plain/Derived` -> new.target Base/Plain/Derived respectively |
| L5 `context.metadata` / `Symbol.metadata` | RECORD (DIVERGE) | TS exposes `ctx.metadata` on 0 applies; Babel on 9; NEITHER sets `Class[Symbol.metadata]`; no Base->Derived metadata inheritance observable; host `Symbol.metadata` undefined |
| L6 legacy vs standard call shape | PASS both | standard 2nd arg = context object with `.kind` string; legacy 2nd arg = string property key. Identical shapes across emitters |
| L7 factory args present on apply | PASS both | each apply carries the `tag` passed to `mark(tag)` |
| L8 class-decorator identity/replacement | PASS both | identity-return keeps `instanceof`; returning a subclass rebinds the class binding (`constructor.name` becomes the replacement's) |

## Decisions

### D-1a -- member decorators only REGISTER and REPLACE; they never create nodes.

Because L3 holds on both emitters, a non-static method/getter `addInitializer`
runs before instance fields exist. Therefore NO member decorator may create a
reactive node from `addInitializer`. Member decorators do exactly two things,
both cheap and node-free:
- REGISTER the member into the per-class plan (at decoration time, once per
  class).
- REPLACE the member's accessor/getter to route through its slot.

The ONE creation a member decorator performs is the `@reactive` accessor's
`init` hook creating its `signalBox` -- and L2 proves that is safe and correctly
ordered: `init` runs at field-def time in declaration order, so a later field
initializer that reads an earlier accessor sees a live box (`y = this.x + 1`
worked). All deriveds/effects are created later, in the single wiring site.

### D-1b -- the single wiring site is the `@reactiveHost` most-derived constructor.

All per-instance wiring (the R-A anchor, `@derived` computedBoxes, and
`@reactiveEffect` effects) happens in ONE place: `@reactiveHost`'s subclass
constructor, AFTER `super(...)` returns -- i.e. after every field initializer
of the whole class has run. L4 gives the most-derived guard: the wrapper wires
only when `new.target` resolves to this wrapper's own host mark, so a decorated
base under a decorated subclass wires exactly once, at the deepest host, with
all fields of the final class present. Metadata merges down the chain; effects
start exactly once.

### D-1c -- the plan store is a module `WeakMap<constructor, plan>`; metadata is an optional Babel-only fast path.

L5 is the decisive divergence. `Symbol.metadata` is undefined on Node 26 and
NEITHER emitter populates `Class[Symbol.metadata]`; only Babel exposes a
`context.metadata` object, and it does not inherit down the prototype chain
observably. Relying on metadata for the plan store would be correct under Babel
and broken under TS. Therefore the plan store DEFAULTS to a module
`WeakMap<constructor, plan>`, keyed by the class the decorator was applied to;
`context.metadata`, when present, is used only as an optional cache and is
feature-detected, never required.

### D-1d -- legacy emit is rejected at decoration time by an emitter-agnostic predicate.

L6 shows the standard-vs-legacy signatures are identical across TS and Babel.
Decorators detect their calling convention with:
`isStandard = (typeof arg2 === "object" && arg2 !== null && typeof arg2.kind === "string")`.
A legacy/`experimentalDecorators` call (2nd arg is a string property key) throws
a named error at decoration time -- fail closed, per suite law. This is
reliable on both toolchains.

### D-1e -- static members are rejected, and the rejection is fail-fast.

Decorating a static member throws (module-level signals are raw lite-signal
territory). L1's static-first ordering means this throw fires before any
instance registration on a class that mistakenly decorates a static member --
the failure surfaces at the earliest possible point.

## Consequences

- The D-01 crash is structurally impossible: no member decorator path creates a
  derived/effect node, and the only member-time creation (`@reactive` init) is
  proven correctly ordered.
- S1 implements one plan-store accessor that reads WeakMap-first,
  metadata-as-cache; one most-derived guard; one legacy-detection predicate
  used by every decorator entry.
- The emit-matrix torture scenario (S1) pins L1..L8 as regression assertions
  against checked-in fixtures from BOTH emitters, with a freshness hash so
  emitter drift is loud.

## Evidence

`spikes/emit/{instrument.ts, fixture.src.ts, legacy.src.ts, regen.mjs,
probe.mjs}`, outputs under `spikes/emit/{ts-out, babel-out, ts-legacy-out,
babel-legacy-out}`, hashes in `spikes/emit/hashes.json`. Probe prints the
verbatim L1..L8 table above; SPIKE emit: PASS.
