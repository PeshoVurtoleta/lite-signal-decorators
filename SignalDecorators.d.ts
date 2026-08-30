/**
 * @zakkster/lite-signal-decorators -- Standard-decorators layer over
 * @zakkster/lite-signal.
 *
 * Public type surface for the JavaScript implementation in
 * `SignalDecorators.js`.
 */

import type {
    SignalBox,
    ComputedBox,
    NodeDescriptor,
    Registry,
    RegistryConfig,
    ReactiveHandle,
    EffectScheduler,
} from "@zakkster/lite-signal";

// --- Options ------------------------------------------------------------------

/** Custom equality predicate for a `@reactive` member. Returning `true` halts propagation. */
export interface ReactiveOptions<V> {
    /** Custom equality predicate. Default: `Object.is`. */
    equals?: (a: V, b: V) => boolean;
}

/** Custom equality predicate for a `@derived` member. Returning `true` halts propagation. */
export interface DerivedOptions<V> {
    /** Custom equality predicate. Default: `Object.is`. */
    equals?: (a: V, b: V) => boolean;
}

/** Options for a `@localTo` member. `equals` governs the UPSTREAM compare only. */
export interface LocalToOptions<V> {
    /**
     * Custom equality predicate for the UPSTREAM compare (source vs the last-seen
     * value). A coarse predicate widens how long a local override survives an
     * upstream move. Default: `Object.is`. The write path never compares.
     */
    equals?: (a: V, b: V) => boolean;
}

/** Options for a `@reactiveEffect` method. */
export interface ReactiveEffectOptions {
    /** Optional scheduler forwarded straight to the underlying `effect(fn, { scheduler })`. */
    scheduler?: EffectScheduler;
}

/**
 * Options for `@reactiveHost` / `defineReactive` `host`. A `registry` isolates
 * the entire host chain on a custom lite-signal registry (one registry per
 * chain -- a mixed chain is a named throw).
 */
export interface ReactiveHostOptions {
    /** A `Registry` from lite-signal `createRegistry()`. Omit for the default registry. */
    registry?: Registry;
}

// --- reactive -----------------------------------------------------------------

/**
 * `@reactive accessor x = v` -- declares a per-instance signal, stored in a
 * unique symbol slot and read/written through an unbranched, allocation-free
 * accessor body.
 *
 * Bare application decorates an `accessor`; the factory form validates its
 * options eagerly and returns the same accessor decorator.
 *
 * @example
 * class Counter {
 *   `@reactive` accessor count = 0;
 *   `@reactive`({ equals: (a, b) => a === b }) accessor label = "";
 * }
 */
export function reactive<This, V>(
    target: ClassAccessorDecoratorTarget<This, V>,
    ctx: ClassAccessorDecoratorContext<This, V>,
): ClassAccessorDecoratorResult<This, V>;
export function reactive<V>(
    opts?: ReactiveOptions<V>,
): <This>(
    target: ClassAccessorDecoratorTarget<This, V>,
    ctx: ClassAccessorDecoratorContext<This, V>,
) => ClassAccessorDecoratorResult<This, V>;

// --- derived ------------------------------------------------------------------

/**
 * `@derived get y()` -- declares a lazy computed derived from other reactive
 * members. The getter body becomes a `computedBox` owned by the instance's
 * anchor and cascade-disposes with it.
 *
 * Bare application decorates a `getter`; the factory form validates its options
 * eagerly and returns the same getter decorator.
 *
 * @example
 * class Vector {
 *   `@reactive` accessor x = 3;
 *   `@reactive` accessor y = 4;
 *   `@derived` get len() { return Math.hypot(this.x, this.y); }
 * }
 */
export function derived<This, V>(
    value: (this: This) => V,
    ctx: ClassGetterDecoratorContext<This, V>,
): (this: This) => V;
export function derived<V>(
    opts?: DerivedOptions<V>,
): <This>(
    value: (this: This) => V,
    ctx: ClassGetterDecoratorContext<This, V>,
) => (this: This) => V;

// --- localTo ------------------------------------------------------------------

/**
 * `@localTo(source) accessor x = v` -- upstream-keyed resettable local state.
 * Each read compares the tracked `source(self)` against a per-instance last-seen
 * slot: an unchanged upstream yields the local override, a changed upstream
 * resets to the upstream value (no write on read -- pure). A write always
 * overrides. With an initializer the member STARTS there and resets on the first
 * upstream move (the `@trackedReset` flavor); without one it FOLLOWS upstream
 * from wiring (the `@localCopy` flavor). `source` is REQUIRED. `equals` governs
 * the upstream compare only.
 *
 * The ABA contract (shipped, documented): the reset requires the upstream to
 * change relative to the last adoption, not to have merely moved -- upstream
 * A -> local write X -> upstream B -> upstream back to an equals-A value shows
 * the STALE local X.
 *
 * @example
 * class Editor {
 *   `@reactive` accessor saved = "";
 *   `@localTo`((self) => self.saved) accessor draft = "";
 * }
 */
export function localTo<This, V>(
    source: (this: This, self: This) => V,
    options?: LocalToOptions<V>,
): <T>(
    target: ClassAccessorDecoratorTarget<T, V>,
    ctx: ClassAccessorDecoratorContext<T, V>,
) => ClassAccessorDecoratorResult<T, V>;

// --- reactiveHost -------------------------------------------------------------

/**
 * `@reactiveHost` -- the single wiring site. Wraps the class so its most-derived
 * constructor builds the reactive graph (anchor + every derived + every effect)
 * exactly once, after all field initializers have run.
 *
 * Bare application decorates the class; the factory form
 * (`@reactiveHost({ registry })`) validates its options eagerly and returns the
 * same class decorator. A `registry` isolates the whole host chain.
 */
export function reactiveHost<C extends abstract new (...args: any[]) => any>(
    target: C,
    ctx: ClassDecoratorContext<C>,
): C;
export function reactiveHost(
    opts?: ReactiveHostOptions,
): <C extends abstract new (...args: any[]) => any>(
    target: C,
    ctx: ClassDecoratorContext<C>,
) => C;

// --- reactiveEffect -----------------------------------------------------------

/**
 * `@reactiveEffect m()` -- a method that auto-runs as an effect once the
 * instance is wired (after every field and derived). The auto-effect tracks its
 * reads; the public method is a leak-guarded manual entry (a call inside a
 * foreign tracking scope is untracked, so it records no stray dependencies).
 *
 * Bare application decorates a `method`; the factory form
 * (`@reactiveEffect({ scheduler })`) validates its options eagerly and returns
 * the same method decorator.
 */
export function reactiveEffect<This, Args extends any[], R>(
    value: (this: This, ...args: Args) => R,
    ctx: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>,
): (this: This, ...args: Args) => R;
export function reactiveEffect(
    opts?: ReactiveEffectOptions,
): <This, Args extends any[], R>(
    value: (this: This, ...args: Args) => R,
    ctx: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>,
) => (this: This, ...args: Args) => R;

// --- batched ------------------------------------------------------------------

/**
 * `@batched m()` -- a method whose body runs inside one engine batch, so its
 * writes flush together. Action-grade (one call per user intent), not a
 * per-frame path.
 *
 * Bare application decorates a `method`; the zero-key factory form
 * (`@batched()`) returns the same method decorator. No options in 0.2.0.
 */
export function batched<This, Args extends any[], R>(
    value: (this: This, ...args: Args) => R,
    ctx: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>,
): (this: This, ...args: Args) => R;
export function batched(): <This, Args extends any[], R>(
    value: (this: This, ...args: Args) => R,
    ctx: ClassMethodDecoratorContext<This, (this: This, ...args: Args) => R>,
) => (this: This, ...args: Args) => R;

// --- defineReactive (buildless twin) ------------------------------------------

/** Per-instance signal descriptor for a `defineReactive` `signals` map entry. */
export interface SignalSpec<This = unknown, V = unknown> {
    /** The initial value, verbatim (mutually exclusive with `init`). */
    initial?: V;
    /** A per-instance factory `(self) => value` (mutually exclusive with `initial`). */
    init?: (this: This, self: This) => V;
    /** Custom equality predicate. Default: `Object.is`. */
    equals?: (a: V, b: V) => boolean;
}

/** Local descriptor for a `defineReactive` `locals` map entry (`@localTo` twin). */
export interface LocalSpec<This = unknown, V = unknown> {
    /** The tracked upstream read `(self) => value`. REQUIRED. */
    source: (this: This, self: This) => V;
    /** Custom equality predicate for the upstream compare. Default: `Object.is`. */
    equals?: (a: V, b: V) => boolean;
    /**
     * The initial value. Present -> the member starts here and resets to upstream
     * on the first upstream move (`@trackedReset`). Absent -> the member follows
     * upstream from wiring (`@localCopy`).
     */
    initial?: V;
}

/** Derived descriptor for a `defineReactive` `deriveds` map entry. */
export interface DerivedSpec<This = unknown, V = unknown> {
    /** The compute body `(self) => value`. */
    get: (this: This, self: This) => V;
    /** Custom equality predicate. Default: `Object.is`. */
    equals?: (a: V, b: V) => boolean;
}

/** Effect descriptor for a `defineReactive` `effects` map entry. */
export interface EffectSpec<This = unknown> {
    /** The effect body `(self) => void`, run under the instance's anchor. */
    run: (this: This, self: This) => void;
    /** Optional scheduler forwarded to the underlying effect. */
    scheduler?: EffectScheduler;
}

/**
 * The `defineReactive(Class, spec)` specification. Every section is optional;
 * unknown sections and descriptor keys are named throws.
 */
export interface DefineReactiveSpec<This = any> {
    /**
     * Reactive signals: an array of keys (each initialized to `undefined`) or a
     * map of `key -> plain value | SignalSpec`. A bare function value is a named
     * throw (ambiguous -- use `{ initial: fn }` or `{ init: (self) => value }`).
     */
    signals?: PropertyKey[] | Record<PropertyKey, unknown | SignalSpec<This>>;
    /** Upstream-keyed locals (`@localTo` twin): a map of `key -> LocalSpec`. */
    locals?: Record<PropertyKey, LocalSpec<This>>;
    /** Lazy deriveds: a map of `key -> (self) => value | DerivedSpec`. */
    deriveds?: Record<PropertyKey, ((this: This, self: This) => unknown) | DerivedSpec<This>>;
    /** Auto-effects: a map of `key -> (self) => void | EffectSpec`. */
    effects?: Record<PropertyKey, ((this: This, self: This) => void) | EffectSpec<This>>;
    /** Host options (registry isolation), shared with `@reactiveHost`. */
    host?: ReactiveHostOptions;
}

/**
 * `defineReactive(Class, spec)` -- the buildless twin of the decorators. Installs
 * the accessors, deriveds, and effect methods declared in `spec` on
 * `Class.prototype`, then wraps `Class` through the same host step the
 * decorators use. Returns the wrapper class. Zero decorator syntax required.
 *
 * @throws for an unknown section/descriptor key, an ambiguous signal entry, an
 *   `initial`+`init` conflict, a spec key that collides with a hand-written
 *   member, or an invalid host registry.
 */
export function defineReactive<C extends new (...args: any[]) => any>(
    Class: C,
    spec: DefineReactiveSpec<InstanceType<C>>,
): C;

// --- Lifecycle + lookups ------------------------------------------------------

/**
 * Dispose a reactive instance: cascade its anchor (freeing every derived),
 * dispose each signal box, and poison every slot so later touches throw
 * {@link ReactiveDisposedError}. Idempotent -- a second call returns `false`
 * and changes nothing. Returns `true` on the first successful dispose.
 *
 * @throws if `vm` is not a reactive instance, or is called before wiring.
 */
export function disposeReactive(vm: object): boolean;

/**
 * Release a live reactive instance to the engine pool (PARKED state): cascade its
 * anchor, dispose each signal box, and swap every slot to a parked handle that
 * throws a parked-specific {@link ReactiveDisposedError} on touch. The instance
 * keeps its prebuilt wiring closures so {@link reinitReactive} revives it with
 * zero new closure allocation. Idempotent on an already-parked instance (returns
 * `false`, mirroring {@link disposeReactive}); returns `true` on the first
 * successful release.
 *
 * @throws if `vm` is not a reactive instance, is unwired, is frozen, or was
 *   terminally disposed (a disposed instance cannot be pooled).
 */
export function releaseReactive(vm: object): boolean;

/**
 * Revive a PARKED reactive instance (see {@link releaseReactive}): rebuild its
 * signal boxes -- using `initials`' values where given, else each member's
 * declared initial -- then rebuild the anchor, deriveds, and effects through the
 * instance's prebuilt closures. Atomicity matches construction: any throw
 * mid-reinit leaves the instance terminally disposed. Returns the same `vm`.
 *
 * @param initials optional map of `@reactive` keys to reset values (a non-signal
 *   or unknown key throws with a did-you-mean hint).
 * @throws if `vm` is live, disposed, frozen, unwired, or not a reactive instance.
 */
export function reinitReactive<T extends object>(vm: T, initials?: Record<PropertyKey, unknown>): T;

/**
 * Return the live {@link SignalBox} / {@link ComputedBox} backing a reactive
 * member -- for interop with raw lite-signal code and devtools.
 *
 * @throws {ReactiveDisposedError} if the instance was disposed.
 * @throws if `key` is not a reactive member (with a did-you-mean hint), or `vm`
 *   is not a reactive instance.
 */
export function boxOf<T = unknown>(vm: object, key: PropertyKey): SignalBox<T> | ComputedBox<T>;

/**
 * Return the instance's anchor {@link NodeDescriptor} -- feeds
 * `forEachOwned` / lite-devtools directly.
 *
 * @throws {ReactiveDisposedError} if the instance was disposed.
 * @throws if `vm` is not wired yet, or is not a reactive instance.
 */
export function rootOf(vm: object): NodeDescriptor;

// --- Reactive walk & snapshot (S9) --------------------------------------------

/**
 * The literal kind tag {@link forEachReactive} passes for each visited member: a
 * `@reactive` signal, a `@localTo` local, or a `@derived` computed. Effects and
 * batched actions are non-value-bearing and never appear.
 */
export type ReactiveKind = "signal" | "local" | "derived";

/**
 * Visit every value-bearing reactive member of `vm` in PLAN order -- all signals,
 * then all `@localTo` locals, then all deriveds; within each group declaration-
 * ordered and ancestor-first (a subclass's own members follow its ancestors').
 * `@reactiveEffect` and `@batched` members are EXCLUDED -- they back no box.
 * `fn` receives the member key (symbol keys included), the live {@link SignalBox}
 * / {@link ComputedBox} (exactly what {@link boxOf} returns), the
 * {@link ReactiveKind} literal, and the pass-through `arg` -- which threads caller
 * state without a closure, so the walk is zero-allocation per call and per visit.
 * Returns the number of members visited.
 *
 * @throws {TypeError} if `fn` is not a function.
 * @throws {ReactiveDisposedError} if the instance was disposed or parked.
 * @throws if `vm` is not wired yet, or is not a reactive instance.
 */
export function forEachReactive<A = unknown>(
    vm: object,
    fn: (
        key: PropertyKey,
        box: SignalBox<unknown> | ComputedBox<unknown>,
        kind: ReactiveKind,
        arg: A,
    ) => void,
    arg?: A,
): number;

/**
 * Return a plain object snapshot of every value-bearing reactive member of `vm`
 * -- signals, `@localTo` locals, and deriveds -- keyed by member key (symbol keys
 * included). Each value is read through the ACCESSOR `vm[key]`, NOT the raw box,
 * so `@localTo` compare-on-read and derived compute stay honest. SHALLOW by
 * design: a nested reactive VM is copied by reference, never recursed. The whole
 * read pass runs under one untracked scope when a tracking context is active, so
 * calling this inside an effect does NOT subscribe that effect to every member.
 * The returned object allocates by design -- this is a cold introspection call,
 * never a gated hot path.
 *
 * @throws {ReactiveDisposedError} if the instance was disposed or parked.
 * @throws if `vm` is not wired yet, or is not a reactive instance.
 */
export function snapshotOf(vm: object): Record<PropertyKey, unknown>;

// --- Introspection & audit (S4) -----------------------------------------------

/** The measured per-instance cost of a reactive class, returned by {@link costOf}. */
export interface ReactiveCost {
    /** Total nodes = `signals + locals + deriveds + effects + 1` (the anchor). */
    nodes: number;
    /** Dependency links held after every `@derived` has been read once (0007). */
    links: number;
    /** Count of `@reactive` members. */
    signals: number;
    /** Count of `@localTo` members (each one box node; its seen slot is a plain field). */
    locals: number;
    /** Count of `@derived` members. */
    deriveds: number;
    /** Count of `@reactiveEffect` members. */
    effects: number;
}

/**
 * Measure the settled per-instance cost of a reactive class on its bound
 * registry. Constructs a probe instance (with NO arguments), reads every
 * `@derived` once to force the lazy links, disposes, and verifies the registry
 * floor -- twice, requiring identical deltas. The result is frozen and cached
 * per class.
 *
 * @param Factory the class returned by `@reactiveHost` or `defineReactive`.
 * @throws if `Factory` is not a reactive wrapper class, if the two probes
 *   disagree (a data-dependent read or a polluted registry -- costOf never
 *   guesses), or if dispose does not return the registry to its floor.
 */
export function costOf(Factory: new (...args: any[]) => any): Readonly<ReactiveCost>;

/**
 * Measure the cost of ONE live, wired instance right now -- no probe, no
 * construction, no ctor args, no registry pollution. Returns a per-call frozen
 * `ReactiveCost` in costOf's exact shape, WALKED from the live graph:
 * `nodes = 1 + signals + locals + forEachOwned(rootOf(vm))` (the deriveds and
 * user effects the anchor adopted), and `links` is the un-deduped sum of
 * forEachSource over the anchor, every owned node, and every signal/local box.
 *
 * THE LIVE-VS-PROBE CONTRACT. This number is the truth NOW. costOf forces every
 * derived to report the constructed CEILING; costOfInstance reports what THIS
 * instance costs at this moment, so an unforced lazy derived or an untaken
 * dynamic branch shows FEWER links than costOf for the same shape until the graph
 * is exercised. `nodes` matches regardless. Read every derived once and the two
 * agree exactly. The delta is the feature, not a bug.
 *
 * The frozen result allocates by design, one object per call (UNCACHED -- a live
 * graph mutates, so a cached number would lie). The walk needs no stats() ledger,
 * so costOfInstance measures instances on registries where costOf fails closed.
 *
 * @param vm a live, wired reactive instance.
 * @throws {ReactiveDisposedError} if `vm` was disposed or parked (a parked vm
 *   holds zero nodes; a silent `{ nodes: 0 }` would be indistinguishable from a
 *   bug, so both fail closed).
 * @throws if `vm` is not wired yet, has no reactive plan, or exposes a prewired
 *   member slot.
 */
export function costOfInstance(vm: object): Readonly<ReactiveCost>;

/** A `[Factory, count]` pair for {@link capacityFor}. */
export type InventoryEntry = [new (...args: any[]) => any, number];

/** Options for {@link capacityFor}. */
export interface CapacityForOptions {
    /**
     * Link-budget multiplier (`>= 1`, default `1` = exact). Applied to the link
     * total for workloads with dynamic-dependency (branchy) deriveds whose active
     * branch can read more members than the probe measured. See decisions/0007.
     */
    headroom?: number;
}

/**
 * Size a `createRegistry` config for a stated inventory of `[Factory, count]`
 * pairs. Nodes are exact; links are `sum(cost.links x count)` scaled by
 * `headroom`. Returns a ready `RegistryConfig` with `prealloc: "eager"` and
 * `onCapacityExceeded: "throw"`.
 *
 * @throws on an empty inventory, a non-factory entry, a non-positive/non-integer
 *   count, or a bad `headroom`.
 */
export function capacityFor(
    inventory: InventoryEntry[],
    options?: CapacityForOptions,
): RegistryConfig;

/**
 * Toggle devtools labels (default OFF). While ON, wiring registers a
 * `nodeId -> label` for every node an instance creates (`"Class.prop"`,
 * `"Class#method"`, `"Class@anchor"`) into a per-registry map, and
 * `disposeReactive` unregisters them. OFF adds no hot-path cost.
 *
 * @throws if `on` is not a boolean.
 */
export function enableLabels(on: boolean): void;

/**
 * Resolve a node id (or a handle, via the registry's `nodeId`) to its label, or
 * `undefined` if unlabeled/unknown -- an introspection miss is never an error.
 * `registry` defaults to the default registry.
 */
export function labelOf(
    idOrHandle: number | ReactiveHandle | NodeDescriptor,
    registry?: Registry,
): string | undefined;

/**
 * Toggle the leak auditor (default OFF). While ON, a lazily-created
 * `FinalizationRegistry` reports (one `console.error`) any instance
 * garbage-collected WITHOUT `disposeReactive`, naming the class + shape. OFF: no
 * `FinalizationRegistry` exists and nothing is registered.
 *
 * Note: an instance pinned by its own undisposed derived/effect nodes on a
 * long-lived registry is never collected, so audit cannot fire for it -- that
 * retention is caught by leak torture instead (see decisions/0008).
 *
 * @throws if `on` is not a boolean.
 */
export function auditReactive(on: boolean): void;

// --- Errors -------------------------------------------------------------------

/**
 * Thrown when a disposed reactive member (or root) is read or written. Carries
 * the originating class name and the member key for actionable diagnostics.
 */
export class ReactiveDisposedError extends Error {
    constructor(className: string, key: PropertyKey);
    /** The class whose instance was disposed. */
    className: string;
    /** The reactive member key that was touched after disposal, or `"<root>"`. */
    key: PropertyKey;
}

// --- Version ------------------------------------------------------------------

/** Package version. Kept in lockstep with package.json and llms.txt. */
export const VERSION: "1.4.0";
