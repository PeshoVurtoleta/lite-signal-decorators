/**
 * @zakkster/lite-signal-decorators -- Stage-3 decorator layer over
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
export const VERSION: "0.2.0-preview.1";
