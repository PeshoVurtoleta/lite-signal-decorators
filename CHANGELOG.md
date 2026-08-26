# Changelog

All notable changes to `@zakkster/lite-signal-decorators` are documented here.
The format follows Keep a Changelog; this project adheres to Semantic
Versioning.

## [0.4.0] - 2026-08-26

The introspection release: the surface grows 11 -> 16, every addition cold-path
or opt-in, the hot accessor canon byte-identical to 0.3.0 (review-diffed
against the published tarball). Stage gate, measured at closeout: 213/213
tests on both lanes; torture 15 scenarios (13 pass + the two forward-compat
scenarios legitimately skipping under the installed 1.5.0 peer) with 15/15
sabotage controls breaking as required; the peer-preview lane SUITE-GREEN
(15/15, forward scenarios RUNNING) against lite-signal 1.9.0-preview.6 AND
1.9.0-canary.1; pack 7 files.

### Added

- `costOf(Factory)` -- the measured, settled per-instance cost on the class's
  bound registry: `{ nodes, links, signals, deriveds, effects }`, frozen and
  cached per class. Quiet-required, floor-verified, DOUBLE-probed with
  identical-deltas-or-throw: an inconclusive probe (a derived whose read set
  changes between runs, a polluted registry) throws a named error, never
  guesses. `nodes` reproduces the 0002 Q3 grid exactly (P + D + E + 1);
  `links` is the first-full-read count.
- `capacityFor(inventory, { headroom }?)` -- sizes a ready `createRegistry`
  config from `[Factory, count]` pairs: nodes exact, links x `headroom`
  floored at the engine minimum, `prealloc: "eager"`,
  `onCapacityExceeded: "throw"`; fail-closed inventory and options
  validation. The link-headroom policy -- nodes exact; fixed-shape deriveds
  provision exactly at first-full-read; branchy-read deriveds fail LOUD with
  the `headroom` knob as the documented escape -- is recorded with its
  measured evidence in `decisions/0007-capacity-policy.md`, closing 0002's
  open question.
- `enableLabels(on)` / `labelOf(idOrHandle, registry?)` -- opt-in devtools
  identity (default OFF): per-registry `nodeId -> "Class.prop" /
  "Class#method" / "Class@anchor"` maps, per-class shared label strings,
  dispose unregisters, misses return `undefined`. A feature-detected
  integration test walks lite-devtools `graph()`/`toTree` from `rootOf(vm)`
  and resolves every walked node. The one-line devtools `labelResolver`
  upstream proposal is recorded in `decisions/0008-introspection.md`.
- `auditReactive(on)` -- opt-in leak auditor (default OFF): a lazily-created
  `FinalizationRegistry` reports any instance collected without
  `disposeReactive`, naming class and shape; it holds no instance references
  itself, unregisters on dispose, and registers nothing while off (proven by
  a child-process `--expose-gc` test).
- Forward-compat torture: `scope-adoption` (floor 1.6.0) and `using-dispose`
  (floor 1.9.0), written against the REAL probed future engine surfaces
  (1.6.0's `createScope` adoption; 1.9.0's native `[Symbol.dispose]` on
  handles) via a typeof-only feature probe (`test/shared/peer-probe.mjs` --
  never version parsing). Their sabotage controls lie about the probe, so
  they fail loudly even under the current peer. Plus `torture:peer-preview`:
  a scratch-install lane that runs the whole suite against the peer's
  `preview` and `canary` dist-tags and reports per-tag verdicts.
- Tests: `12-accounting` (11), `13-labels-audit` (10, incl. the child-process
  audit fixture), `14-qa-s4-boundary` (21 adversarial pins), and two
  capacityFor round-trip lanes (node-bound and link-bound) in
  capacity-torture. Suite 171 -> 213. Dev-only devDependency:
  `@zakkster/lite-devtools` (integration walk).

### Fixed

- (Found in review) A registry passing the 11-method duck-check but lacking
  `stats()` -- constructible from the public surface -- made `costOf` and
  `capacityFor` die with a raw `TypeError` instead of a named error. Now a
  named, ERR-prefixed throw explains that probing needs a `createRegistry()`
  registry with its stats ledger. The falsified "no reachable raw path"
  claim in 0008 is amended with the counterexample preserved, rejection-
  history style.
- (Found in QA) `capacityFor`'s options guard borrowed decorator-flavored
  usage wording for a plain function call, and accepted an ARRAY as an
  options bag; it now throws the call-form message
  (`options must be a plain object like { headroom: 1.25 }`) for both.
  `null` still means "omitted".
- (Found writing tests) `capacityFor` on a signals-only inventory produced
  `maxLinks: 0`, which `createRegistry` rejects; the returned links are now
  floored at the engine minimum of 1 so every valid inventory yields a
  constructible config.

## [0.3.0] - 2026-08-26

The class-reactivity benchmark release. Zero runtime changes: the 11-export
surface ships logic-identical to 0.2.0 (version constants aside); what this
release adds is the proof. Stage gate, all measured at closeout: 171/171
tests on both lanes; torture 13 scenarios / 13 sabotage controls all
green-and-breakable; the full benchmark matrix 42/42 lanes `sink=ok`, exit 0.

### Added

- `bench/` -- a private, never-shipped benchmark sub-package: six admitted
  engines (`lsd` decorators, `lsd-define` buildless, the `lite-raw-boxes`
  honesty baseline, MobX 7, signal-utils + signal-polyfill, a hand-rolled
  alien-signals class) x seven class-shaped scenarios (vm-write, fleet-read
  and fleet-tick over 10k instances, cascade 64/16+aggregate, deep-vm 64-deep,
  churn as the headline, retention as gates). Ported lite-signal rig: anti-DCE
  sink with analytic expected-sum oracles (skipped work rejects the lane),
  median-of-5 + min, GC-fenced runs with real delta/retained heap columns,
  machine provenance stamps with resolved adapter versions, a sabotaged-adapter
  self-test proving the harness can fail, and machine-gated effect liveness on
  lifecycle lanes. Candidates `classy-solid` and `@reactively/decorate` probed
  and excluded with recorded one-line blockers (solid's stock-Node SSR
  resolution; legacy-only decorators). Reproducible from a clean clone:
  `cd bench && npm install && npm run bench`.
- `fleet-soak` -- the 13th torture scenario (soak group): 2000 VMs (16000 pool
  nodes exactly) under sustained ticks with partial churn rotations for a
  wall-clock budget; per-sample F-0, flat retained heap, gcGate maxMajor 0;
  its sabotage control leaks one VM per rotation and is caught at the first
  sample.
- `decisions/0006-kill-criteria.md` -- the formal verdicts. Criterion 1 (the
  2.0x line vs the hand-written instance-field baseline) CLEARED WITH MARGIN:
  vm-write 0.94x, fleet-read 1.10x (parity, per 0003's tied-layout finding).
  Criterion 2 (churn cleanliness) CLEARED: 0 major and 0 minor collections
  over 4096 lifecycle cycles on every lite lane, pools at floor (asserted
  in-lane), retained settled at-or-below baseline -- and the decorated churn
  loop emits ~12.6x less transient garbage than the hand-rolled equivalent.
  Every competitor number published under the same stamp (AD-6 honesty
  tiering); the wide-shape cascade/deep-vm gap vs raw boxes is recorded as an
  S4 investigation item, not hidden.

### Changed

- README: the measured-numbers section now cites the cross-framework matrix
  and the 0006 verdicts alongside the package's own committed probes; version
  references bumped.
- CHANGELOG release links now point at the package `repository`
  (github.com/PeshoVurtoleta/lite-signal-decorators), matching the new
  `repository`/`homepage`/`funding` fields in package.json.
- `llms.txt` scope note: 0.3.0 adds only dev-side proof; the export surface
  is unchanged and frozen for 0.x.

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

The full runtime surface. Exports grow from 8 to 11. Published under the
`preview` dist-tag on the same day 0.2.0 went to `latest`.

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

[0.4.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.4.0
[0.3.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.3.0
[0.2.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.2.0
[0.2.0-preview.1]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.2.0-preview.1
[0.1.0]: https://github.com/PeshoVurtoleta/lite-signal-decorators/releases/tag/v0.1.0
