# Changelog

All notable changes to `@zakkster/lite-signal-decorators` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic
Versioning.

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

[0.1.0]: https://github.com/zakkster/lite-signal-decorators/releases/tag/v0.1.0
