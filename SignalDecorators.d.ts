/**
 * @zakkster/lite-signal-decorators -- Stage-3 decorator layer over
 * @zakkster/lite-signal.
 *
 * Public type surface for the JavaScript implementation in
 * `SignalDecorators.js`.
 */

import type { SignalBox, ComputedBox, NodeDescriptor } from "@zakkster/lite-signal";

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
 * constructor builds the reactive graph (anchor + every derived) exactly once,
 * after all field initializers have run.
 *
 * Bare application decorates the class; the zero-key factory form
 * (`@reactiveHost()`) returns the same class decorator. No options are accepted
 * in 0.1.0.
 */
export function reactiveHost<C extends abstract new (...args: any[]) => any>(
    target: C,
    ctx: ClassDecoratorContext<C>,
): C;
export function reactiveHost(): <C extends abstract new (...args: any[]) => any>(
    target: C,
    ctx: ClassDecoratorContext<C>,
) => C;

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
export const VERSION: string;
