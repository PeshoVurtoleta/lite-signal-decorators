// fixture.src.ts -- the S1 reactive class family, compiled by BOTH standard
// emitters (TS 5 `experimentalDecorators: false` and Babel `2023-11`). It is the
// SAME family that test/shared/mock-emitter.mjs builds by hand; 02/03 run the
// identical behavior suite over these compiled emits, so any TS/Babel/mock
// divergence is a bug. The ".js" specifier resolves the real package at both the
// src/ depth and the out-dir depth (../../../SignalDecorators.js). ASCII-only.

import * as pkgNs from "../../../SignalDecorators.js";
import { reactive, derived, reactiveHost, reactiveEffect, batched } from "../../../SignalDecorators.js";

/** The package instance that built these classes (shares its PLANS WeakMap). */
export const pkg = pkgNs;

/** Recompute counters -- the derived bodies bump these so laziness/equals
 * suppression are observable in the behavior suite. */
export const recompute = { double: 0, band: 0, da: 0, db: 0 };

/** Effect-fire counters -- the @reactiveEffect bodies bump these so wire-fire,
 * re-fire, and dispose-stop are observable in the behavior suite. */
export const effectFires = { counter: 0, derived: 0 };

/** Tolerance equals: values within 0.5 are treated as unchanged. */
function approxEquals(a: number, b: number): boolean {
    return Math.abs(a - b) < 0.5;
}

/** A symbol-named reactive member (exported so the suite can address it). */
export const SYM: unique symbol = Symbol("counter-sym");

@reactiveHost
export class Counter {
    @reactive accessor count = 0;
    @reactive({ equals: approxEquals }) accessor level = 0;
    @reactive accessor [SYM] = "tag";

    @derived get double() {
        recompute.double++;
        return this.count * 2;
    }

    @derived({ equals: approxEquals }) get band() {
        recompute.band++;
        return this.level;
    }

    // @reactiveEffect method: tracks count, fires once at wire, re-fires on a
    // count mutation.
    @reactiveEffect onCount() {
        effectFires.counter++;
        void this.count;
    }

    // @batched method: coalesces its two writes into one effect flush.
    @batched bump() {
        this.count = this.count + 1;
        this.count = this.count + 1;
    }

    // Plain field reading an earlier accessor (L2 declaration-order read).
    late = this.count + 1;
}

@reactiveHost
export class Base {
    @reactive accessor a = 1;

    @derived get da() {
        recompute.da++;
        return this.a + 100;
    }
}

@reactiveHost
export class Derived extends Base {
    @reactive accessor b = 2;

    @derived get db() {
        recompute.db++;
        return this.a + this.b;
    }

    // @reactiveEffect over an inherited-key derived: fires once after the full
    // chain is wired.
    @reactiveEffect onDb() {
        effectFires.derived++;
        void this.db;
    }
}

// Undecorated subclass -- wires at Base's (inherited) host mark.
export class Leaf extends Base {}
