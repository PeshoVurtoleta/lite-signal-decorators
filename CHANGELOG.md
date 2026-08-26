# Changelog

All notable changes to `@zakkster/lite-signal-decorators` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic
Versioning.

## [0.2.0] - 2026-08-26

The adversarial-torture release: the 0.2 surface is frozen for 0.x, proven by
the full semantic suite (12 scenarios, 12 failing controls) and a 300-seed
oracle. Stage gate: 171/171 tests on both lanes; torture 12/12 with every
control breaking as required; suite gate `leak=size 0/0 findings=0 warnings=0 |
gc major=0 minor=0`.

### Added

- Seven adversarial torture scenarios (dev-side, never shipped):
  `capacity-torture` (every overflow point x both construction paths, host
  chains, nested constructions -- each atomic), `disposed-poison` (full
  post-dispose surface + resurrection storms), `leak-torture` (lite-leak
  kernels over 4096 cycles), `oracle-fuzzer` (300 seeds x 20k ops, decorated
  vs hand-wired raw twins in lockstep: values, effect fire counts, and graph
  opcode tallies), `interop-torture` (raw/decorated one-graph interop,
  cross-registry and `destroy()` contracts pinned raw, the two documented
  D-2f limits pinned drift-loud), `batch-untrack-torture`, and `churn-soak`
  (wall-clock soak, pools at floor, flat heap).
- The full package README replaces the 0.1.0 stub: positioning, quick start on
  both paths (decorator and buildless), the wiring/teardown model, the
  half-alive-view-model trap trio, a complete API reference with the rejection
  matrix, a verbatim-runnable composability pipeline, the measured numbers
  (storage-bench and batched-cost tables, quoted from their committed probes),
  zero-GC design notes with the allocation table and gate outputs, design
  decisions, the 171-test/12-scenario testing map, compatibility, ecosystem, and
  FAQ. Every behavioral claim and code sample was executed and verified against
  0.2.0 before landing.

### Fixed

- Init-phase capacity atomicity (D-2h, S2b finding P-1): a `CapacityError` thrown
  while creating a decorator signal box during `super()`'s field initialization
  no longer leaks the boxes already created earlier in that construction. A
  module-level scratch-frame protocol tracks in-flight boxes and disposes the
  whole frame LIFO on a throw, so `new` fails closed with zero node leak (F-0
  holds) at every capacity point, on the decorator path (init-phase) and the
  buildless path (wire-time) alike. Hot canon and the dispose path are untouched;
  steady-state cost is one push + one length reset per construction.
  The fix hardened twice under review and torture: the scratch frame is owned
  only by the most-derived (wiring) wrapper, so `@reactiveHost` inheritance
  chains roll back base-class boxes too (an intermediate-host truncation defect
  the reviewer caught with a measured counterexample), and the buildless signal
  wire-loop plus the R-A anchor creation moved inside `wireInstance`'s guard, so
  an overflow at ANY point -- init box, wire-time box, anchor, derived, or
  effect -- tears down exactly what was built and rethrows.

## [0.2.0-preview.1] - 2026-08-26

The full runtime surface. Exports grow from 8 to 11. Never published: the
preview publish was pending npm authentication when 0.2.0 superseded it; the
changes below first shipped with 0.2.0.

### Added

- `reactiveEffect` -- `@reactiveEffect m()` (bare) / `@reactiveEffect({ scheduler })`
  (factory): a method that auto-runs as an effect once the instance is wired
  (after every field and every derived). The auto-effect tracks its reads; the
  public method is a leak-guarded manual entry -- a call inside a foreign tracking
  scope is untracked, so it records zero stray dependencies (0004 D-4b). Self-
  dispose from inside an owned effect is allowed with pinned semantics (0004
  D-4d): the current run completes, later decorated-member touches throw
  `ReactiveDisposedError`, no re-runs follow, conservation is exact.
- `batched` -- `@batched m()` (bare) / `@batched()` (factory): runs the method
  body inside one engine batch, coalescing its writes into a single flush.
  Action-grade (one call per user intent), not a per-frame path: it allocates a
  thunk + rest-array per call by design and is excluded from the zero-GC hot-path
  gates.
- `defineReactive(Class, spec)` -- the buildless twin of the decorators (0005).
  `spec` is `{ signals, deriveds, effects, host }`; it installs the members on
  `Class.prototype` and wraps the class through the SAME wiring core the
  decorators use (shared by function identity, not merely behaviorally alike).
  Consumers without a Stage-3 transpiler get the complete feature set.
- `@reactiveHost({ registry })` -- an optional `registry` from lite-signal
  `createRegistry()` isolates the whole host chain. Every engine call routes
  through the bound registry, closing the cross-registry dispose trap (the
  default `dispose` is a silent no-op across registries). One registry per chain:
  a heterogeneous chain or an invalid (duck-check-failing) registry is a named
  throw.

### Changed

- `@reactiveHost` unknown options now report the standard unknown-option
  did-you-mean over `["registry"]` (the 0.1.0 "takes no options" message is
  retired) -- `registry` is now a valid option.
- The duplicate-key error wording now names both causes: subclass redeclaration
  OR two stacked package decorators on one member.
- Internal error-string refactor (housekeeping): the package prefix is hoisted to
  one `ERR` const and cold message building uses template literals; prewired
  handles build their message once and share it. Message text is byte-identical
  to 0.1.0 except the two changes above. Hot accessor bodies are untouched.
- `VERSION` is `"0.2.0-preview.1"`.

### Fixed

- Manual-call identity guard (D-4e): calling a `@reactiveEffect` or `@batched`
  method on a foreign, primitive, null, or cross-class receiver (e.g. via
  `Class.prototype.m.call(...)`) now throws a named error instead of running the
  body against the wrong instance. Uses byKey identity, so a subclass instance
  calling a base-declared method still passes. Cold manual-call path only.
- Frozen-instance dispose refusal (D-2g): `disposeReactive` (and `using`) now
  refuses a frozen instance up front with a named error, atomically -- previously
  it half-disposed (tore down boxes) then threw a raw `TypeError`, leaving
  disposed boxes behind live-looking slots. `Object.seal`/`preventExtensions`
  remain fine.

### Notes

- `@batched` per-call cost, measured by the committed cold-process probe
  (`spikes/batched-cost.mjs`, K=10 cold processes, node 26.3.1, Apple M4 Pro,
  lite-signal 1.5.0): the decorated method 22.12 ns/op vs raw `batch(fn)`
  15.25 vs the plain unbatched method 11.67 (median-of-medians; 0 major GC in
  every lane). The ~7 ns over raw is the guarded rest-array + thunk (risk R8).
  Action-grade, not a per-frame path; never in the zero-GC torture gates.

## [0.1.0] - 2026-08-26

Initial release -- the decorator core.

### Added

- `reactive` -- `@reactive accessor x = v` (bare) / `@reactive({ equals })`
  (factory): a per-instance signal box stored in a unique symbol slot with an
  unbranched, allocation-free accessor body.
- `derived` -- `@derived get y()` (bare) / `@derived({ equals })` (factory): a
  lazy computed owned by the instance's anchor.
- `reactiveHost` -- `@reactiveHost` (bare) / `@reactiveHost()` (factory): the
  single wiring site; its most-derived constructor builds the anchor and every
  derived exactly once, after all field initializers run.
- `disposeReactive(vm)` -- idempotent cascade + poison teardown; returns `true`
  on the first call, `false` thereafter. Also wired to `Symbol.dispose` for
  `using` blocks.
- `boxOf(vm, key)` / `rootOf(vm)` -- live box and anchor-descriptor lookups for
  interop with raw lite-signal and lite-devtools.
- `ReactiveDisposedError` -- named error thrown on any post-dispose touch,
  carrying `className` and `key`.
- Dispose re-entrancy guard (D-2f): calling `disposeReactive(this)` from inside
  the instance's own `@derived` computation throws a named error instead of
  silently dropping the derivation's value.
- `VERSION` constant (`"0.1.0"`).
- Fail-closed rejection matrix (all named, all at decoration time): legacy emit,
  wrong kind, static members, private (#) members, unknown option keys (with a
  nearest-key did-you-mean), non-function `equals`, double host, host options,
  and orphaned members.
- Torture skeleton (`@zakkster/lite-leak` + `@zakkster/lite-gc-profiler`):
  retention, conservation, lifecycle, and zero-GC lanes.

[0.2.0]: https://github.com/zakkster/lite-signal-decorators/releases/tag/v0.2.0
[0.2.0-preview.1]: https://github.com/zakkster/lite-signal-decorators/releases/tag/v0.2.0-preview.1
[0.1.0]: https://github.com/zakkster/lite-signal-decorators/releases/tag/v0.1.0
