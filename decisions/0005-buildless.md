# 0005 -- buildless co-export (defineReactive)

Status: ACCEPTED (S0). Evidence: `spikes/buildless.mjs`
(run `node --expose-gc spikes/buildless.mjs`, exits 0), lite-signal 1.5.0.

## Context

Stage-3 decorators are transpiler-only (0000/0001): a consumer of the `@` syntax
needs TS 5+ or Babel. This is the first package in the suite whose ergonomic
surface is unusable buildless -- including the suite's own demos. The mitigation
(ROADMAP sec.1) is a functional co-export `defineReactive(Class, spec)` that does
the identical wiring with zero decorator syntax. This record proves that the two
entry points can share 100% of the wiring code -- not merely behave alike, but
call the SAME functions -- so there is one implementation to test and maintain,
not two.

## Measured parity

`spikes/buildless.mjs` modelled the S1 shared core as three standalone functions
(`registerSignal`, `installAccessors`, `wireInstance`) and drove them two ways:
via mock decorator contexts (the decorator path) and via
`defineReactive(Class, { signals, deriveds, effects })` (the buildless path).

| path | valuesMatch | fireCountsMatch | statsDeltaMatch | sameFnIdentity |
|------|-------------|-----------------|-----------------|----------------|
| decorator | true | true | true | true |
| buildless | true | true | true | true |

Both paths produced identical values `[1,2,3,10,12]`, identical effect fire
counts (wire=1, mutate=2), identical `stats()` delta `{ nodes: 5, links: 3 }`,
and identical dispose conservation. Crucially, both paths reference the SAME
module bindings -- `registerSignal === registerSignal`,
`installAccessors === installAccessors`, `wireInstance === wireInstance` across
the two code paths (`sameFnIdentity: true`). There is no duplicated wiring logic;
the decorator entries and `defineReactive` are two thin front-ends over one core.

## Decision

Ship `defineReactive(Class, spec)` in S2 as a thin adapter that normalizes `spec`
into the SAME per-class plan the decorators build, then calls the SAME
register/install/wire functions. Spec shape (S2 finalizes types):
```
defineReactive(Class, {
  signals:  ['a', 'b'] | { a: {equals}, b: {} },   // -> @reactive
  deriveds: { sum: self => self.a + self.b },        // -> @derived
  effects:  [ self => { ...; return cleanup } ],     // -> @reactiveEffect
  host:     { registry } | undefined,                // -> @reactiveHost opts
})
```
`defineReactive` installs accessors on `Class.prototype` via
`Object.defineProperty` (mirroring what the accessor decorator's get/set
compile to) and wires instances through the same host step. Buildless consumers
get the COMPLETE feature set: reactive props, deriveds, effects, disposal,
poison, capacity accounting -- everything the decorator path has.

## Consequences

- S1 writes the register/install/wire core as decorator-agnostic functions from
  the start (the decorators are the first caller; `defineReactive` is the
  second, in S2).
- The S2 `08-buildless` test runs ONE shared behavior suite against a decorated
  class AND its `defineReactive` twin; the suite file contains zero decorator
  syntax.
- The demo (S5b) and any buildless consumer use `defineReactive`; the README
  quick-start leads with it so the first code a reader runs needs no transpiler.

## Evidence

`spikes/buildless.mjs` (parity + shared-function-identity table above).
