// test/shared/mock-emitter.mjs -- a faithful plain-JS Stage-3 mini-emitter.
//
// It reproduces exactly what TS 5 standard emit and Babel `2023-11` generate,
// so a class built here drives the SAME code path in @zakkster/lite-signal-
// decorators as a transpiled class. The emit laws it honors (measured in
// decisions/0001):
//   L1 -- member decorators apply in SOURCE order; the class decorator applies
//         LAST (statics, when present, apply before instance members).
//   L2 -- accessor `init` runs at field-def time, in DECLARATION order, with
//         `this` bound; a later field initializer that reads an earlier accessor
//         sees a live box.
//   L3 -- `addInitializer` callbacks run at construction start, BEFORE any field
//         initializer of that class body.
//   L4 -- the class decorator wraps the class; `new.target` in a base ctor names
//         the most-derived ctor, so the deepest @reactiveHost wires once.
//
// Public API (kept small + stable; Workstream C torture scenarios import this):
//   makeAccessorContext(name, opts?)  -- a standard accessor-decorator context.
//   makeGetterContext(name, opts?)    -- a standard getter-decorator context.
//   makeMethodContext(name, opts?)    -- a standard method-decorator context.
//   makeClassContext(name, opts?)     -- a standard class-decorator context.
//   buildClass(spec)                  -- assemble one class from a member spec,
//                                        applying decorators via the protocol
//                                        above; returns the wrapper (or the raw
//                                        inner class when spec.classDecorator is
//                                        absent, e.g. missing-host scenarios).
//   makeClasses(pkg)                  -- the S1 fixture class family built
//                                        through the REAL package: same members,
//                                        same names, same recompute counters as
//                                        test/fixtures/src/fixture.src.ts.
//
// ASCII-only. Zero dependencies beyond the package under test (passed in).

// --- Standard-shaped decorator contexts --------------------------------------

const NOOP = function () {};

/**
 * A standard accessor-decorator context. `opts` overrides { static, private,
 * addInitializer } for rejection-matrix probes.
 */
export function makeAccessorContext(name, opts) {
    const o = opts || {};
    return {
        kind: "accessor",
        name,
        static: o.static === true,
        private: o.private === true,
        access: { has() {}, get() {}, set() {} },
        addInitializer: o.addInitializer || NOOP,
    };
}

/**
 * A standard getter-decorator context.
 */
export function makeGetterContext(name, opts) {
    const o = opts || {};
    return {
        kind: "getter",
        name,
        static: o.static === true,
        private: o.private === true,
        access: { has() {}, get() {} },
        addInitializer: o.addInitializer || NOOP,
    };
}

/**
 * A standard method-decorator context. `opts` overrides { static, private,
 * addInitializer } for rejection-matrix probes.
 */
export function makeMethodContext(name, opts) {
    const o = opts || {};
    return {
        kind: "method",
        name,
        static: o.static === true,
        private: o.private === true,
        access: { has() {}, get() {} },
        addInitializer: o.addInitializer || NOOP,
    };
}

/**
 * A standard class-decorator context.
 */
export function makeClassContext(name, opts) {
    const o = opts || {};
    return {
        kind: "class",
        name,
        addInitializer: o.addInitializer || NOOP,
    };
}

// --- buildClass ---------------------------------------------------------------
//
// spec = {
//   name: string,
//   superClass?: Function,          // the class to extend (a decorated wrapper)
//   members: Member[],              // in SOURCE order
//   classDecorator?: Function,      // e.g. pkg.reactiveHost; omit for no-host
// }
// Member (in source order):
//   { kind: "accessor", key, decorator, value?: (this) => v }
//   { kind: "getter",   key, decorator, body: function () {...} }
//   { kind: "method",   key, decorator, body: function () {...} }
//   { kind: "field",    key, value: (this) => v }   // plain field, no decorator
//
// `decorator` is a fully-formed decorator (bare fn or a factory's result), so a
// factory member passes e.g. `pkg.reactive({ equals })`.

/**
 * Assemble one class from a member spec, applying member decorators in source
 * order and the class decorator last, honoring L1..L4.
 */
export function buildClass(spec) {
    const addInits = [];        // L3: run at construction start, before fields.
    const declInits = [];       // L2: accessor inits + plain fields, decl order.

    let Inner;
    if (spec.superClass) {
        Inner = class extends spec.superClass {
            constructor(...args) {
                super(...args);
                for (let i = 0; i < addInits.length; i++) addInits[i].call(this);
                for (let i = 0; i < declInits.length; i++) declInits[i].call(this);
            }
        };
    } else {
        Inner = class {
            constructor() {
                for (let i = 0; i < addInits.length; i++) addInits[i].call(this);
                for (let i = 0; i < declInits.length; i++) declInits[i].call(this);
            }
        };
    }
    const proto = Inner.prototype;

    const members = spec.members || [];
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (m.kind === "accessor") {
            const ctx = makeAccessorContext(m.key, {
                addInitializer(fn) { addInits.push(fn); },
            });
            // Stage-3 accessor target is the auto-accessor's { get, set }; the
            // package ignores it. The result's get/set install at class-def time.
            const res = m.decorator({ get() {}, set() {} }, ctx);
            Object.defineProperty(proto, m.key, {
                get: res.get,
                set: res.set,
                enumerable: true,
                configurable: true,
            });
            const init = res.init;
            const valueThunk = m.value;
            declInits.push(function () {
                // Real emit: stored = init.call(this, <initial-value expr>).
                const v = valueThunk ? valueThunk.call(this) : undefined;
                if (typeof init === "function") init.call(this, v);
            });
        } else if (m.kind === "getter") {
            const ctx = makeGetterContext(m.key, {
                addInitializer(fn) { addInits.push(fn); },
            });
            const res = m.decorator(m.body, ctx);
            Object.defineProperty(proto, m.key, {
                get: res,
                enumerable: true,
                configurable: true,
            });
            // Getters have no per-instance field init.
        } else if (m.kind === "method") {
            const ctx = makeMethodContext(m.key, {
                addInitializer(fn) { addInits.push(fn); },
            });
            // Standard method decorator: called with (originalMethod, context);
            // its return value replaces the method (installed as desc.value). The
            // package returns the guarded public form here; the auto-effect keeps
            // the original internally. Methods are non-enumerable own props.
            const res = m.decorator(m.body, ctx);
            Object.defineProperty(proto, m.key, {
                value: res,
                writable: true,
                enumerable: false,
                configurable: true,
            });
            // Methods have no per-instance field init.
        } else if (m.kind === "field") {
            const valueThunk = m.value;
            const key = m.key;
            declInits.push(function () {
                this[key] = valueThunk ? valueThunk.call(this) : undefined;
            });
        } else {
            throw new Error("mock-emitter: unknown member kind " + String(m.kind));
        }
    }

    Object.defineProperty(Inner, "name", { value: spec.name, configurable: true });

    if (spec.classDecorator) {
        return spec.classDecorator(Inner, makeClassContext(spec.name));
    }
    return Inner;
}

// --- makeClasses: the S1 fixture family, built through the real package -------
//
// This is the SAME family (same members, names, and recompute counters) that
// test/fixtures/src/fixture.src.ts compiles. 02/03 run the behavior suite over
// the compiled emits; 01 runs it over THIS build. Any divergence is a bug.
//
// Node-count deltas at construction (P signals + D deriveds + E effects + 1
// anchor; @batched members wire no node):
//   Counter -> P=3 (count, level, SYM), D=2 (double, band), E=1 (onCount) => 7
//   Base    -> P=1 (a),                 D=1 (da),           E=0           => 3
//   Derived -> P=2 (a, b),              D=2 (da, db),       E=1 (onDb)    => 6
//   Leaf    -> Base's plan (undecorated subclass)                        => 3

/** Tolerance equals: treats values within 0.5 as unchanged (suppresses set). */
export function approxEquals(a, b) {
    return Math.abs(a - b) < 0.5;
}

/**
 * Build the S1/S2a class family through the real package `pkg`. Returns
 * `{ Counter, Base, Derived, Leaf, SYM, recompute, effectFires, pkg }` -- the
 * exact shape the behavior suite consumes.
 */
export function makeClasses(pkg) {
    const SYM = Symbol("counter-sym");
    // Recompute counters -- the derived bodies bump these so the behavior suite
    // can assert laziness and equals-suppression as OBSERVABLES.
    const recompute = { double: 0, band: 0, da: 0, db: 0 };
    // Effect-fire counters -- the @reactiveEffect bodies bump these so the suite
    // can assert wire-fire=1, mutate re-fire, and dispose-stop as OBSERVABLES.
    const effectFires = { counter: 0, derived: 0 };

    const Counter = buildClass({
        name: "Counter",
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "count", decorator: pkg.reactive, value: () => 0 },
            {
                kind: "accessor",
                key: "level",
                decorator: pkg.reactive({ equals: approxEquals }),
                value: () => 0,
            },
            { kind: "accessor", key: SYM, decorator: pkg.reactive, value: () => "tag" },
            {
                kind: "getter",
                key: "double",
                decorator: pkg.derived,
                body: function () { recompute.double++; return this.count * 2; },
            },
            {
                kind: "getter",
                key: "band",
                decorator: pkg.derived({ equals: approxEquals }),
                body: function () { recompute.band++; return this.level; },
            },
            // @reactiveEffect method: tracks count, fires once at wire, re-fires
            // on a count mutation (E=1 node).
            {
                kind: "method",
                key: "onCount",
                decorator: pkg.reactiveEffect,
                body: function () { effectFires.counter++; void this.count; },
            },
            // @batched method: coalesces its two writes into one effect flush
            // (wires no node).
            {
                kind: "method",
                key: "bump",
                decorator: pkg.batched,
                body: function () {
                    this.count = this.count + 1;
                    this.count = this.count + 1;
                },
            },
            // Plain field reading an earlier accessor (L2 declaration-order read).
            { kind: "field", key: "late", value: function () { return this.count + 1; } },
        ],
    });

    const Base = buildClass({
        name: "Base",
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "a", decorator: pkg.reactive, value: () => 1 },
            {
                kind: "getter",
                key: "da",
                decorator: pkg.derived,
                body: function () { recompute.da++; return this.a + 100; },
            },
        ],
    });

    const Derived = buildClass({
        name: "Derived",
        superClass: Base,
        classDecorator: pkg.reactiveHost,
        members: [
            { kind: "accessor", key: "b", decorator: pkg.reactive, value: () => 2 },
            {
                kind: "getter",
                key: "db",
                decorator: pkg.derived,
                body: function () { recompute.db++; return this.a + this.b; },
            },
            // @reactiveEffect over an inherited-key derived: fires once after the
            // full chain is wired (E=1 node in the merged plan).
            {
                kind: "method",
                key: "onDb",
                decorator: pkg.reactiveEffect,
                body: function () { effectFires.derived++; void this.db; },
            },
        ],
    });

    // Undecorated subclass -- wires at Base's (inherited) host mark.
    const Leaf = buildClass({
        name: "Leaf",
        superClass: Base,
        members: [],
    });

    return { Counter, Base, Derived, Leaf, SYM, recompute, effectFires, pkg };
}
