/**
 * @zakkster/lite-signal-decorators v0.1.0
 * --------------------
 * Stage-3 decorator layer over @zakkster/lite-signal. Turns a plain class into
 * a reactive view-model with measured per-instance cost and deterministic
 * teardown:
 *   - `@reactive accessor x = v`  -- a per-instance signal box, stored in a
 *      unique symbol slot (0003 S-A), read/written through an unbranched body.
 *   - `@derived get y()`         -- a lazy computedBox, owned by the instance's
 *      anchor so it cascade-disposes with the instance.
 *   - `@reactiveHost`            -- the single wiring site (0001 D-1b): its
 *      most-derived constructor builds the R-A anchor and every derived once.
 *   - `disposeReactive(vm)`      -- idempotent cascade teardown + poison swap
 *      (0002 D-2d); a disposed slot throws ReactiveDisposedError on touch.
 *
 * Ownership model (0002): one detached anchor per instance owns all deriveds;
 * signal boxes are created bare (not adopted) and disposed explicitly. The
 * accessor get/set/derived-get bodies carry exactly one slot load + one
 * monomorphic box call -- zero branches, zero allocation (0003 hot-body canon).
 * The wiring/register/dispose core is decorator-agnostic so `defineReactive`
 * (S2, 0005) can become its second caller without a second implementation.
 *
 * ESM-only. Zero runtime deps beyond the peer @zakkster/lite-signal.
 *
 * MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
 */

import {
    signalBox,
    computedBox,
    effect,
    createRoot,
    getOwner,
    runWithOwner,
    dispose,
    nodeId,
    isTracking,
} from "@zakkster/lite-signal";

// --- Module state -------------------------------------------------------------

// PENDING holds records pushed by member decorators (@reactive/@derived) until
// the class decorator (@reactiveHost) claims them (PD-1). Members and the class
// of one class definition evaluate in one synchronous sequence, so records from
// two classes never interleave; they only linger if a class had reactive
// members but no @reactiveHost -- caught by PD-2/PD-3.
const PENDING = [];

// The plan store (0001 D-1c): module WeakMap keyed by the wrapper constructor.
const PLANS = new WeakMap();

// One module symbol whose VALUE on a constructor is the wrapper itself. `new W`
// wires iff `new.target[HOST_MARK] === W`, so only the deepest host wires (PD-5).
const HOST_MARK = Symbol("lite-signal-decorators.host");

// The instance's anchor NodeDescriptor lives here; DISPOSED after teardown.
const ANCHOR = Symbol("lite-signal-decorators.anchor");

// Marks the poison/prewired handles so boxOf/rootOf recognize them without
// calling get() (PD-4): value is "disposed" or "prewired".
const NONLIVE = Symbol("lite-signal-decorators.nonlive");

// Frozen sentinel written to ANCHOR on dispose (idempotency signal, PD-7).
const DISPOSED = Object.freeze({ [NONLIVE]: "disposed" });

// Known option keys (PD-8 unknown-key did-you-mean set).
const KNOWN_OPTION_KEYS = ["equals"];

// --- ReactiveDisposedError ----------------------------------------------------

/**
 * Thrown when a disposed reactive member (or root) is read or written. Carries
 * the originating class name and the member key for actionable diagnostics.
 */
export class ReactiveDisposedError extends Error {
    constructor(className, key) {
        super(
            "@zakkster/lite-signal-decorators: " +
                className +
                "." +
                String(key) +
                " was used after disposeReactive() -- the reactive graph is gone",
        );
        this.name = "ReactiveDisposedError";
        this.className = className;
        this.key = key;
    }
}

// --- Error-throw helpers (cold; message building allocates only here) ---------

function keyLabel(key) {
    return String(key);
}

function nearestKey(bad, known) {
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < known.length; i++) {
        const d = editDistance(bad, known[i]);
        if (d < bestDist) {
            bestDist = d;
            best = known[i];
        }
    }
    return best;
}

function editDistance(a, b) {
    const al = a.length;
    const bl = b.length;
    if (al === 0) return bl;
    if (bl === 0) return al;
    let prev = new Array(bl + 1);
    let cur = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
    for (let i = 1; i <= al; i++) {
        cur[0] = i;
        const ac = a.charCodeAt(i - 1);
        for (let j = 1; j <= bl; j++) {
            const cost = ac === b.charCodeAt(j - 1) ? 0 : 1;
            let m = prev[j] + 1;
            const ins = cur[j - 1] + 1;
            if (ins < m) m = ins;
            const sub = prev[j - 1] + cost;
            if (sub < m) m = sub;
            cur[j] = m;
        }
        const tmp = prev;
        prev = cur;
        cur = tmp;
    }
    return prev[bl];
}

function throwLegacyEmit(what) {
    throw new TypeError(
        "@zakkster/lite-signal-decorators: " +
            what +
            " received a legacy decorator call (2nd arg is a property key, not a" +
            " standard context). Compile with standard decorators (TS 5" +
            ' `experimentalDecorators: false` / Babel `2023-11`).',
    );
}

function throwWrongKind(what, wantKind, gotKind, fix) {
    throw new TypeError(
        "@zakkster/lite-signal-decorators: " +
            what +
            ' expects to decorate a member of kind "' +
            wantKind +
            '", but got kind "' +
            gotKind +
            '". ' +
            fix,
    );
}

function throwStatic(what, name) {
    throw new TypeError(
        "@zakkster/lite-signal-decorators: " +
            what +
            " cannot decorate the static member " +
            String(name) +
            " -- module-level signals are raw lite-signal territory.",
    );
}

function throwPrivate(what, name) {
    throw new TypeError(
        "@zakkster/lite-signal-decorators: " +
            what +
            " cannot decorate the private (#) member " +
            String(name) +
            " -- private (#) members are not supported in 0.1.0.",
    );
}

function throwBadEquals(what) {
    throw new TypeError(
        "@zakkster/lite-signal-decorators: " +
            what +
            " option `equals` must be a function (a, b) -> boolean.",
    );
}

function throwUnknownOption(what, key) {
    const near = nearestKey(String(key), KNOWN_OPTION_KEYS);
    throw new TypeError(
        "@zakkster/lite-signal-decorators: " +
            what +
            " got unknown option `" +
            String(key) +
            "`" +
            (near ? " -- did you mean `" + near + "`?" : "") +
            " Known options: " +
            KNOWN_OPTION_KEYS.join(", ") +
            ".",
    );
}

function throwHostOptions(key) {
    throw new TypeError(
        "@zakkster/lite-signal-decorators: reactiveHost takes no options in" +
            " 0.1.0" +
            (key !== undefined ? " (got `" + String(key) + "`)" : "") +
            ".",
    );
}

function throwUsage(what) {
    throw new TypeError(
        "@zakkster/lite-signal-decorators: " +
            what +
            " was called with an unrecognized argument shape. Apply it as a bare" +
            " decorator (`@" +
            what +
            "`) or a factory (`@" +
            what +
            "({ ... })`).",
    );
}

function throwOrphans(ctorName, keys) {
    throw new Error(
        "@zakkster/lite-signal-decorators: class " +
            ctorName +
            " claimed reactive members that were never installed on its" +
            " prototype (keys: " +
            keys.join(", ") +
            "). An earlier class used @reactive/@derived without @reactiveHost.",
    );
}

function throwDuplicateKey(ctorName, key) {
    throw new Error(
        "@zakkster/lite-signal-decorators: reactive member " +
            keyLabel(key) +
            " is declared twice across the prototype chain of " +
            ctorName +
            " -- subclass redeclaration of a reactive member is not supported.",
    );
}

function throwDoubleHost(name) {
    throw new Error(
        "@zakkster/lite-signal-decorators: class " +
            name +
            " already has a @reactiveHost wrapper -- do not apply @reactiveHost" +
            " twice.",
    );
}

function throwMissingHost(rec) {
    throw new Error(
        "@zakkster/lite-signal-decorators: reactive member " +
            keyLabel(rec.key) +
            " was constructed without a @reactiveHost -- add @reactiveHost to" +
            " the class that declares it.",
    );
}

function throwNoPlan(what) {
    throw new Error(
        "@zakkster/lite-signal-decorators: " +
            what +
            " received a value that is not a reactive instance (no @reactiveHost" +
            " plan on its constructor chain).",
    );
}

function throwNotWired(what) {
    throw new Error(
        "@zakkster/lite-signal-decorators: " +
            what +
            " called on an instance that is not wired -- called during" +
            " construction, or not a reactive instance.",
    );
}

function throwSelfDisposeInDerived(ctorName, key) {
    throw new Error(
        "@zakkster/lite-signal-decorators: disposeReactive(" +
            ctorName +
            ") was called from inside its own @derived " +
            keyLabel(key) +
            " computation -- derived getters must be pure. Dispose from an" +
            " effect, a subscription, or plain code instead.",
    );
}

function throwUnknownMember(ctorName, key, plan) {
    const avail = [];
    const it = plan.byKey.keys();
    for (let e = it.next(); !e.done; e = it.next()) avail.push(keyLabel(e.value));
    const near = nearestKey(keyLabel(key), avail);
    throw new Error(
        "@zakkster/lite-signal-decorators: boxOf(" +
            ctorName +
            ", " +
            keyLabel(key) +
            ") -- no such reactive member" +
            (near ? " -- did you mean `" + near + "`?" : "") +
            " Available: " +
            avail.join(", ") +
            ".",
    );
}

function throwPrewiredMember(ctorName, key) {
    throw new Error(
        "@zakkster/lite-signal-decorators: " +
            ctorName +
            "." +
            keyLabel(key) +
            " is not yet wired -- accessed before construction completed.",
    );
}

// --- Hot-body factories (section-2 canon; reviewer diffs byte-for-byte) -------

function makeGet(slot) { return function () { return this[slot].get(); }; }
function makeSet(slot) { return function (v) { this[slot].set(v); }; }
function makeDerivedGet(slot) { return function () { return this[slot].get(); }; }

function makeInit(rec) {
    return function (v) {
        if (rec.plan === null) throwMissingHost(rec);
        this[rec.slot] = signalBox(v, rec.opts);
        return v;                              // emitter backing store, unused
    };
}

// --- Option validation (cold) -------------------------------------------------

function isStandardContext(c) {
    return typeof c === "object" && c !== null && typeof c.kind === "string";
}

function validateOptions(what, opts) {
    // Returns a frozen { equals } copy, or undefined for the bare form. Never
    // aliases the caller's object.
    if (opts === undefined || opts === null) return undefined;
    if (typeof opts !== "object") throwUsage(what);
    const keys = Object.keys(opts);
    for (let i = 0; i < keys.length; i++) {
        if (KNOWN_OPTION_KEYS.indexOf(keys[i]) === -1) throwUnknownOption(what, keys[i]);
    }
    if ("equals" in opts && opts.equals !== undefined && typeof opts.equals !== "function") throwBadEquals(what);
    if (opts.equals === undefined) return undefined;
    return Object.freeze({ equals: opts.equals });
}

// --- reactive -----------------------------------------------------------------

function applyReactive(target, ctx, opts) {
    if (!isStandardContext(ctx)) throwLegacyEmit("reactive");
    if (ctx.kind !== "accessor") {
        throwWrongKind("reactive", "accessor", ctx.kind, "write `@reactive accessor x = ...`.");
    }
    if (ctx.static === true) throwStatic("reactive", ctx.name);
    if (ctx.private === true) throwPrivate("reactive", ctx.name);
    const slot = Symbol(typeof ctx.name === "symbol" ? "reactive" : "reactive:" + String(ctx.name));
    const rec = {
        kind: "signal",
        key: ctx.name,
        slot,
        get: makeGet(slot),
        set: makeSet(slot),
        fn: null,
        opts,
        plan: null,
        poison: null,
        prewired: null,
    };
    PENDING.push(rec);
    return { get: rec.get, set: rec.set, init: makeInit(rec) };
}

/**
 * `@reactive accessor x = v` -- declares a per-instance signal. Bare or as a
 * factory `@reactive({ equals })`.
 */
export function reactive(target, ctx) {
    // A decorator APPLICATION always passes >= 2 args (target, context); a
    // FACTORY call passes 0-1 (options or nothing). applyReactive re-checks the
    // context, so a legacy 2-arg call (string context) throws the legacy error.
    if (arguments.length >= 2) return applyReactive(target, ctx, undefined);
    const opts = validateOptions("reactive", target);
    return function (t, c) { return applyReactive(t, c, opts); };
}

// --- derived ------------------------------------------------------------------

function applyDerived(value, ctx, opts) {
    if (!isStandardContext(ctx)) throwLegacyEmit("derived");
    if (ctx.kind !== "getter") {
        throwWrongKind("derived", "getter", ctx.kind, "write `@derived get y() { ... }`.");
    }
    if (ctx.static === true) throwStatic("derived", ctx.name);
    if (ctx.private === true) throwPrivate("derived", ctx.name);
    const slot = Symbol(typeof ctx.name === "symbol" ? "derived" : "derived:" + String(ctx.name));
    const rec = {
        kind: "derived",
        key: ctx.name,
        slot,
        get: makeDerivedGet(slot),
        set: undefined,
        fn: value,
        opts,
        plan: null,
        poison: null,
        prewired: null,
    };
    PENDING.push(rec);
    // PD-3: a derived getter has no init, so register one initializer whose body
    // fails closed if the class was never hosted.
    ctx.addInitializer(function () {
        if (rec.plan === null) throwMissingHost(rec);
    });
    return rec.get;
}

/**
 * `@derived get y()` -- declares a lazy computed derived from other reactive
 * members. Bare or as a factory `@derived({ equals })`.
 */
export function derived(value, ctx) {
    if (arguments.length >= 2) return applyDerived(value, ctx, undefined);
    const opts = validateOptions("derived", value);
    return function (v, c) { return applyDerived(v, c, opts); };
}

// --- Claim + plan (PD-1/2/6) --------------------------------------------------

function buildHandles(rec, ctorName) {
    // Poison: thrown after dispose. Prewired: thrown before wiring installs the
    // own slot. Both frozen, both carrying NONLIVE for marker-tag recognition.
    const key = rec.key;
    rec.poison = Object.freeze({
        [NONLIVE]: "disposed",
        get() { throw new ReactiveDisposedError(ctorName, key); },
        set(v) { throw new ReactiveDisposedError(ctorName, key); },
    });
    if (rec.kind === "signal") {
        rec.prewired = Object.freeze({
            [NONLIVE]: "prewired",
            get() {
                throw new TypeError(
                    "@zakkster/lite-signal-decorators: " + ctorName + "." + keyLabel(key) +
                        " read/write before its initializer ran (declaration order).",
                );
            },
            set(v) {
                throw new TypeError(
                    "@zakkster/lite-signal-decorators: " + ctorName + "." + keyLabel(key) +
                        " read/write before its initializer ran (declaration order).",
                );
            },
        });
    } else {
        rec.prewired = Object.freeze({
            [NONLIVE]: "prewired",
            get() {
                throw new TypeError(
                    "@zakkster/lite-signal-decorators: " + ctorName + "." + keyLabel(key) +
                        " read before construction completed (deriveds are available after wiring).",
                );
            },
            set(v) {
                throw new TypeError(
                    "@zakkster/lite-signal-decorators: " + ctorName + "." + keyLabel(key) +
                        " read before construction completed (deriveds are available after wiring).",
                );
            },
        });
    }
}

function nearestAncestorPlan(C) {
    let p = Object.getPrototypeOf(C);
    while (p !== null && p !== Function.prototype) {
        const plan = PLANS.get(p);
        if (plan !== undefined) return plan;
        p = Object.getPrototypeOf(p);
    }
    return undefined;
}

function claimPlan(C, ctorName) {
    // Drain PENDING wholly FIRST so a broken earlier class cannot poison every
    // later claim forever (PD-2). Validate identity against C.prototype after.
    const own = PENDING.splice(0, PENDING.length);
    const proto = C.prototype;
    const orphans = [];
    for (let i = 0; i < own.length; i++) {
        const rec = own[i];
        const desc = Object.getOwnPropertyDescriptor(proto, rec.key);
        if (desc === undefined || desc.get !== rec.get) orphans.push(keyLabel(rec.key));
    }
    if (orphans.length > 0) throwOrphans(ctorName, orphans);

    const ancestor = nearestAncestorPlan(C);
    const signals = [];
    const deriveds = [];
    const byKey = new Map();
    if (ancestor !== undefined) {
        for (let i = 0; i < ancestor.signals.length; i++) {
            const r = ancestor.signals[i];
            signals.push(r);
            byKey.set(r.key, r);
        }
        for (let i = 0; i < ancestor.deriveds.length; i++) {
            const r = ancestor.deriveds[i];
            deriveds.push(r);
            byKey.set(r.key, r);
        }
    }
    for (let i = 0; i < own.length; i++) {
        const rec = own[i];
        if (byKey.has(rec.key)) throwDuplicateKey(ctorName, rec.key);
        buildHandles(rec, ctorName);
        if (rec.kind === "signal") signals.push(rec);
        else deriveds.push(rec);
        byKey.set(rec.key, rec);
    }

    const plan = {
        ctorName,
        signals: Object.freeze(signals),
        deriveds: Object.freeze(deriveds),
        byKey,
    };
    Object.freeze(plan);
    // Records get their plan pointer (PD-3 missing-host check) then freeze.
    for (let i = 0; i < own.length; i++) {
        own[i].plan = plan;
        Object.freeze(own[i]);
    }
    return plan;
}

// --- Wiring core (decorator-agnostic; 0005) -----------------------------------

function makeDerivedBody(inst, fn) { return function () { return fn.call(inst); }; }

function wireInstance(inst, plan) {
    let a;
    createRoot(() => { effect(() => { a = getOwner(); }); });   // R-A anchor
    inst[ANCHOR] = a;
    try {
        runWithOwner(a, () => {
            const ders = plan.deriveds;
            for (let i = 0; i < ders.length; i++) {
                const d = ders[i];
                inst[d.slot] = computedBox(makeDerivedBody(inst, d.fn), d.opts);
            }
        });
    } catch (e) {
        disposeCore(inst, plan);               // conservation intact
        throw e;                               // CapacityError propagates as-is
    }
}

function disposeCore(inst, plan) {             // assumes not already disposed
    const a = inst[ANCHOR];
    if (a !== undefined && a !== DISPOSED) dispose(a); // cascades owned deriveds
    const sigs = plan.signals;
    for (let i = 0; i < sigs.length; i++) {
        const r = sigs[i];
        const box = inst[r.slot];
        if (box !== undefined && box[NONLIVE] === undefined) dispose(box);
        inst[r.slot] = r.poison;
    }
    const ders = plan.deriveds;
    for (let i = 0; i < ders.length; i++) {
        const r = ders[i];
        inst[r.slot] = r.poison;               // cboxes already cascaded
    }
    inst[ANCHOR] = DISPOSED;
}

// --- reactiveHost -------------------------------------------------------------

function applyReactiveHost(C, ctx) {
    if (!isStandardContext(ctx)) throwLegacyEmit("reactiveHost");
    if (ctx.kind !== "class") {
        throwWrongKind("reactiveHost", "class", ctx.kind, "apply `@reactiveHost` to the class.");
    }
    if (Object.prototype.hasOwnProperty.call(C, HOST_MARK)) throwDoubleHost(ctx.name || C.name);

    const ctorName = ctx.name || C.name;
    const plan = claimPlan(C, ctorName);       // PD-1/2/6

    // PD-4: prewired proto slots -- named errors before wiring, shadowed after.
    for (let i = 0; i < plan.signals.length; i++) {
        const r = plan.signals[i];
        Object.defineProperty(C.prototype, r.slot, {
            value: r.prewired,
            writable: true,
            configurable: true,
            enumerable: false,
        });
    }
    for (let i = 0; i < plan.deriveds.length; i++) {
        const r = plan.deriveds[i];
        Object.defineProperty(C.prototype, r.slot, {
            value: r.prewired,
            writable: true,
            configurable: true,
            enumerable: false,
        });
    }

    class W extends C {
        constructor(...args) {
            super(...args);
            if (new.target[HOST_MARK] === W) wireInstance(this, plan);
        }
    }
    Object.defineProperty(W, HOST_MARK, { value: W });
    Object.defineProperty(W, "name", { value: ctorName });
    // Symbol.dispose reached runtimes after Node 18 (the engines floor); without
    // the guard, older nodes would define a stray "undefined" key and `using`
    // would silently no-op instead of being observably absent.
    if (typeof Symbol.dispose === "symbol") {
        Object.defineProperty(W.prototype, Symbol.dispose, {
            value: function () { disposeReactive(this); },
            writable: true,
            configurable: true,
        });
    }
    PLANS.set(W, plan);
    return W;
}

/**
 * `@reactiveHost` -- the single wiring site. Wraps the class so its most-derived
 * constructor builds the anchor and every derived exactly once. Bare or as a
 * zero-key factory `@reactiveHost()`.
 */
export function reactiveHost(C, ctx) {
    // Standard class-decorator application passes 2 args (class, context).
    if (arguments.length >= 2) return applyReactiveHost(C, ctx);
    // A legacy class decorator is called with just the constructor (1 arg).
    if (typeof C === "function") throwLegacyEmit("reactiveHost");
    // Factory form: bare (), ({}), (undefined) only -- no keys in 0.1.0.
    if (C !== undefined && C !== null) {
        if (typeof C !== "object") throwUsage("reactiveHost");
        const keys = Object.keys(C);
        if (keys.length > 0) throwHostOptions(keys[0]);
    }
    return function (cls, c) { return applyReactiveHost(cls, c); };
}

// --- Lookups (PD-9) -----------------------------------------------------------

function planOf(vm) {
    if (vm === null || vm === undefined) return undefined;
    let c = vm.constructor;
    while (c !== null && c !== undefined && c !== Function.prototype) {
        const plan = PLANS.get(c);
        if (plan !== undefined) return plan;
        c = Object.getPrototypeOf(c);
    }
    return undefined;
}

/**
 * Dispose a reactive instance: cascade its anchor, dispose each signal box, and
 * poison every slot. Idempotent -- a second call returns `false` and changes
 * nothing. Returns `true` on the first successful dispose.
 */
export function disposeReactive(vm) {
    const plan = planOf(vm);
    if (plan === undefined) throwNoPlan("disposeReactive");
    const a = vm[ANCHOR];
    if (a === DISPOSED) return false;          // idempotent no-op
    if (a === undefined) throwNotWired("disposeReactive");
    // Re-entrancy guard (D-2f): disposing this instance from inside one of its
    // OWN @derived computations would cascade the very node being computed, and
    // the engine would silently drop the freshly computed value (fail-open).
    // The isTracking() gate keeps the plain-code dispose path byte-identical and
    // zero-alloc; only under an active tracking context do we pay one getOwner()
    // descriptor to check whether the current computation is one of our deriveds.
    if (isTracking()) {
        const cur = getOwner();
        if (cur !== undefined) {
            const ders = plan.deriveds;
            for (let i = 0; i < ders.length; i++) {
                const h = vm[ders[i].slot];
                if (h !== undefined && h[NONLIVE] === undefined && nodeId(h) === cur.id) {
                    throwSelfDisposeInDerived(plan.ctorName, ders[i].key);
                }
            }
        }
    }
    disposeCore(vm, plan);
    return true;
}

/**
 * Return the live SignalBox/ComputedBox backing a reactive member. Throws
 * `ReactiveDisposedError` if the instance was disposed, and a named error for an
 * unknown key or a non-reactive value.
 */
export function boxOf(vm, key) {
    const plan = planOf(vm);
    if (plan === undefined) throwNoPlan("boxOf");
    const rec = plan.byKey.get(key);
    if (rec === undefined) throwUnknownMember(plan.ctorName, key, plan);
    const h = vm[rec.slot];
    if (h === undefined || h === null) throwNotWired("boxOf");
    const nl = h[NONLIVE];
    if (nl === "disposed") throw new ReactiveDisposedError(plan.ctorName, key);
    if (nl === "prewired") throwPrewiredMember(plan.ctorName, key);
    return h;
}

/**
 * Return the instance's anchor NodeDescriptor -- feeds `forEachOwned`/devtools.
 * Throws `ReactiveDisposedError` after dispose, and a named error before wiring
 * or on a non-reactive value.
 */
export function rootOf(vm) {
    const plan = planOf(vm);
    if (plan === undefined) throwNoPlan("rootOf");
    const a = vm[ANCHOR];
    if (a === undefined) throwNotWired("rootOf");
    if (a === DISPOSED) throw new ReactiveDisposedError(plan.ctorName, "<root>");
    return a;
}

// --- Version ------------------------------------------------------------------

/** Package version. Kept in lockstep with package.json and llms.txt. */
export const VERSION = "0.1.0";
