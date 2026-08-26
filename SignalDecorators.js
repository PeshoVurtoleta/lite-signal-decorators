/**
 * @zakkster/lite-signal-decorators v0.4.0
 * --------------------
 * Stage-3 decorator layer over @zakkster/lite-signal. Turns a plain class into
 * a reactive view-model with measured per-instance cost and deterministic
 * teardown:
 *   - `@reactive accessor x = v`  -- a per-instance signal box, stored in a
 *      unique symbol slot (0003 S-A), read/written through an unbranched body.
 *   - `@derived get y()`         -- a lazy computedBox, owned by the instance's
 *      anchor so it cascade-disposes with the instance.
 *   - `@reactiveEffect m()`      -- a method that auto-runs as an effect after
 *      wiring; the public method is guarded against dependency leaks (0004 D-4b).
 *   - `@batched m()`             -- a method whose body runs inside one engine
 *      batch (action-grade, not a per-frame path).
 *   - `@reactiveHost({ registry })` -- the single wiring site (0001 D-1b); its
 *      most-derived constructor builds the R-A anchor, every derived, and every
 *      effect once. An optional `registry` isolates the whole host chain.
 *   - `defineReactive(Class, spec)` -- the buildless twin (0005): the identical
 *      wiring with zero decorator syntax, one implementation shared by identity.
 *   - `disposeReactive(vm)`      -- idempotent cascade teardown + poison swap
 *      (0002 D-2d); a disposed slot throws ReactiveDisposedError on touch.
 *
 * Ownership model (0002): one detached anchor per instance owns all deriveds and
 * effects; signal boxes are created bare (not adopted) and disposed explicitly.
 * The accessor get/set/derived-get bodies carry exactly one slot load + one
 * monomorphic box call -- zero branches, zero allocation (0003 hot-body canon).
 * Every engine call routes through the host chain's bound registry (PD-11), so a
 * custom-registry instance never leaks through the default `dispose` no-op.
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
    batch,
    untrack,
    stats,
} from "@zakkster/lite-signal";

// --- Module state -------------------------------------------------------------

// PENDING holds records pushed by member decorators (@reactive/@derived/
// @reactiveEffect/@batched) until the class decorator (@reactiveHost) or
// defineReactive claims them (PD-1). Members and the class of one definition
// evaluate in one synchronous sequence, so records from two classes never
// interleave; they only linger if a class had reactive members but no host --
// caught by PD-2/PD-3.
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

// Scratch-frame stack (D-2h): decorator signal boxes are created in accessor
// `init` during super()'s field initialization -- BEFORE wireInstance's
// try/catch exists. Each init pushes its box here; the wrapper constructor
// captures the frame index before super(), drains its own frame LIFO on a throw
// (init-phase CapacityError atomicity), and truncates it on success. The index
// is the frame marker, so nested constructions unwind correctly. Amortizes to
// zero steady-state allocation (one push + one length reset per construction).
const SCRATCH = [];

// Hoisted package prefix (PD-15): every cold error message begins with this.
const ERR = "@zakkster/lite-signal-decorators: ";

// --- Introspection state (S4; all opt-in, all cold/off by default) -----------

// PD-23/PD-24: labels and audit are opt-in debug features. INTROSPECT_ON is the
// single wiring/dispose gate (= LABELS_ON || AUDIT_ON), so the OFF path pays at
// most one flag test at wiring and one at dispose -- the hot accessor canon is
// never touched in either mode.
let LABELS_ON = false;
let AUDIT_ON = false;
let INTROSPECT_ON = false;

// PD-23: per-registry nodeId -> label. nodeIds are per-registry, so a
// module-global Map would collide across registries; the key is the plan's reg
// object (DEFAULT_REG facade or a custom Registry).
const LABEL_MAPS = new WeakMap();       // reg -> Map<number, string>
// Per-plan label strings, built once at first labeled wiring and shared by every
// instance of the class.
const LABEL_STRINGS = new WeakMap();    // plan -> { anchor, signals[], deriveds[], effects[] }
// The instance's registered label ids, so disposeReactive can unregister exactly
// them (effect handles are otherwise discarded). Only written while LABELS_ON.
const LABEL_IDS = Symbol("lite-signal-decorators.labelIds");

// PD-24: costOf result cache (per wrapper class; shape is frozen at decoration).
const COST_CACHE = new WeakMap();       // Factory -> frozen cost object

// PD-24: the audit FinalizationRegistry is created lazily on first enable and
// never torn down (a FR holds no strong refs to its targets). Its held value is
// a plain { className, shape } record -- it must NOT close over the instance.
let AUDIT_FR = null;

// Known option keys per decorator (unknown-key did-you-mean sets, PD-8/PD-11).
const KNOWN_OPTION_KEYS = ["equals"];
const EFFECT_OPTION_KEYS = ["scheduler"];
const HOST_OPTION_KEYS = ["registry"];
const CAP_OPTION_KEYS = ["headroom"];

// --- DEFAULT_REG facade (PD-11) ----------------------------------------------

// The frozen default registry facade, built once from the module imports. Same
// call shape as the Registry subset the package uses. Every engine call routes
// through a plan's `reg`, which is this facade unless a host binds a custom one.
const DEFAULT_REG = Object.freeze({
    signalBox,
    computedBox,
    effect,
    createRoot,
    getOwner,
    runWithOwner,
    dispose,
    nodeId,
    isTracking,
    batch,
    untrack,
    // `stats` is not in REG_METHODS (the duck-check stays at the 11 methods the
    // wiring/dispose paths use); costOf reads it here for the default registry,
    // and every custom Registry from createRegistry() exposes it natively.
    stats,
});

// The 11 method names a valid Registry must expose (duck-check set, PD-11).
const REG_METHODS = [
    "signalBox",
    "computedBox",
    "effect",
    "createRoot",
    "getOwner",
    "runWithOwner",
    "dispose",
    "nodeId",
    "isTracking",
    "batch",
    "untrack",
];

// --- ReactiveDisposedError ----------------------------------------------------

/**
 * Thrown when a disposed reactive member (or root) is read or written. Carries
 * the originating class name and the member key for actionable diagnostics.
 */
export class ReactiveDisposedError extends Error {
    constructor(className, key) {
        super(
            `${ERR}${className}.${String(key)} was used after disposeReactive() -- the reactive graph is gone`,
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
        `${ERR}${what} received a legacy decorator call (2nd arg is a property key, not a standard context). Compile with standard decorators (TS 5 \`experimentalDecorators: false\` / Babel \`2023-11\`).`,
    );
}

function throwWrongKind(what, wantKind, gotKind, fix) {
    throw new TypeError(
        `${ERR}${what} expects to decorate a member of kind "${wantKind}", but got kind "${gotKind}". ${fix}`,
    );
}

function throwStatic(what, name) {
    throw new TypeError(
        `${ERR}${what} cannot decorate the static member ${String(name)} -- module-level signals are raw lite-signal territory.`,
    );
}

function throwPrivate(what, name) {
    throw new TypeError(
        `${ERR}${what} cannot decorate the private (#) member ${String(name)} -- private (#) members are not supported in 0.1.0.`,
    );
}

function throwBadEquals(what) {
    throw new TypeError(
        `${ERR}${what} option \`equals\` must be a function (a, b) -> boolean.`,
    );
}

function throwBadScheduler(what) {
    throw new TypeError(
        `${ERR}${what} option \`scheduler\` must be a function (run) -> void.`,
    );
}

function throwUnknownOption(what, key, known) {
    const near = nearestKey(String(key), known);
    throw new TypeError(
        `${ERR}${what} got unknown option \`${String(key)}\`${near ? ` -- did you mean \`${near}\`?` : ""} Known options: ${known.join(", ")}.`,
    );
}

function throwBatchedOptions(key) {
    throw new TypeError(
        `${ERR}batched got unknown option \`${String(key)}\` -- batched takes no options in 0.2.0.`,
    );
}

function throwBadRegistry(method) {
    throw new TypeError(
        `${ERR}reactiveHost { registry } is missing the \`${method}\` method -- pass a Registry from lite-signal createRegistry(), not a RegistryConfig.`,
    );
}

function throwRegistryMismatch(ctorName) {
    throw new TypeError(
        `${ERR}class ${ctorName} passes a different registry than its @reactiveHost ancestor -- one registry per host chain; a mixed chain would build cross-registry graphs whose deps silently do not link.`,
    );
}

function throwUsage(what) {
    throw new TypeError(
        `${ERR}${what} was called with an unrecognized argument shape. Apply it as a bare decorator (\`@${what}\`) or a factory (\`@${what}({ ... })\`).`,
    );
}

function throwOrphans(ctorName, keys) {
    throw new Error(
        `${ERR}class ${ctorName} claimed reactive members that were never installed on its prototype (keys: ${keys.join(", ")}). An earlier class used @reactive/@derived without @reactiveHost.`,
    );
}

function throwDuplicateKey(ctorName, key) {
    throw new Error(
        `${ERR}reactive member ${keyLabel(key)} is declared twice across the prototype chain of ${ctorName} -- a member key may be claimed only once per host chain (subclass redeclaration, or two stacked package decorators on one member, both trigger this).`,
    );
}

function throwDoubleHost(name) {
    throw new Error(
        `${ERR}class ${name} already has a @reactiveHost wrapper -- do not apply @reactiveHost twice.`,
    );
}

function throwMissingHost(rec) {
    throw new Error(
        `${ERR}reactive member ${keyLabel(rec.key)} was constructed without a @reactiveHost -- add @reactiveHost to the class that declares it.`,
    );
}

function throwNoPlan(what) {
    throw new Error(
        `${ERR}${what} received a value that is not a reactive instance (no @reactiveHost plan on its constructor chain).`,
    );
}

function throwNotWired(what) {
    throw new Error(
        `${ERR}${what} called on an instance that is not wired -- called during construction, or not a reactive instance.`,
    );
}

function throwSelfDisposeInDerived(ctorName, key) {
    throw new Error(
        `${ERR}disposeReactive(${ctorName}) was called from inside its own @derived ${keyLabel(key)} computation -- derived getters must be pure. Dispose from an effect, a subscription, or plain code instead.`,
    );
}

function throwUnknownMember(ctorName, key, plan) {
    const avail = [];
    const it = plan.byKey.keys();
    for (let e = it.next(); !e.done; e = it.next()) avail.push(keyLabel(e.value));
    const near = nearestKey(keyLabel(key), avail);
    throw new Error(
        `${ERR}boxOf(${ctorName}, ${keyLabel(key)}) -- no such reactive member${near ? ` -- did you mean \`${near}\`?` : ""} Available: ${avail.join(", ")}.`,
    );
}

function throwFrozenDispose(ctorName) {
    throw new TypeError(
        `${ERR}disposeReactive(${ctorName}) -- the instance is frozen, so the poison swap cannot be installed. Do not freeze a live reactive instance; dispose first, then freeze.`,
    );
}

function throwPrewiredMember(ctorName, key) {
    throw new Error(
        `${ERR}${ctorName}.${keyLabel(key)} is not yet wired -- accessed before construction completed.`,
    );
}

function throwNoBox(ctorName, key, kind) {
    const what = kind === "effect" ? "@reactiveEffect" : "@batched";
    throw new Error(
        `${ERR}boxOf(${ctorName}, ${keyLabel(key)}) -- ${keyLabel(key)} is a ${what} member and has no backing box; boxOf serves @reactive and @derived members only.`,
    );
}

// --- defineReactive spec-normalization throws (cold) --------------------------

function throwDefineClass() {
    throw new TypeError(
        `${ERR}defineReactive(Class, spec) -- Class must be a constructor function.`,
    );
}

function throwDefineSpec() {
    throw new TypeError(
        `${ERR}defineReactive(Class, spec) -- spec must be an object with signals/deriveds/effects/host sections.`,
    );
}

function throwUnknownSection(key) {
    const near = nearestKey(keyLabel(key), ["signals", "deriveds", "effects", "host"]);
    throw new TypeError(
        `${ERR}defineReactive spec got unknown section \`${keyLabel(key)}\`${near ? ` -- did you mean \`${near}\`?` : ""} Known sections: signals, deriveds, effects, host.`,
    );
}

function throwSpecSignals() {
    throw new TypeError(
        `${ERR}defineReactive spec.signals must be an array of keys or a map of key -> value/descriptor.`,
    );
}

function throwSpecDeriveds() {
    throw new TypeError(
        `${ERR}defineReactive spec.deriveds must be a map of key -> function or { get, equals }.`,
    );
}

function throwSpecEffects() {
    throw new TypeError(
        `${ERR}defineReactive spec.effects must be a map of key -> function or { run, scheduler }.`,
    );
}

function throwAmbiguousSignal(key) {
    throw new TypeError(
        `${ERR}defineReactive signal ${keyLabel(key)} is a bare function -- ambiguous: use { initial: fn } to store the function, or { init: (self) => value } to compute the initial per instance.`,
    );
}

function throwUnknownSignalDescKey(key, dk) {
    const near = nearestKey(keyLabel(dk), ["initial", "init", "equals"]);
    throw new TypeError(
        `${ERR}defineReactive signal ${keyLabel(key)} got unknown descriptor key \`${keyLabel(dk)}\`${near ? ` -- did you mean \`${near}\`?` : ""} Known keys: initial, init, equals.`,
    );
}

function throwSignalInitialInitConflict(key) {
    throw new TypeError(
        `${ERR}defineReactive signal ${keyLabel(key)} sets both \`initial\` and \`init\` -- give one: \`initial\` for a verbatim value, \`init\` for a per-instance factory.`,
    );
}

function throwSignalInitNotFn(key) {
    throw new TypeError(
        `${ERR}defineReactive signal ${keyLabel(key)} \`init\` must be a function (self) -> value.`,
    );
}

function throwUnknownDerivedDescKey(key, dk) {
    const near = nearestKey(keyLabel(dk), ["get", "equals"]);
    throw new TypeError(
        `${ERR}defineReactive derived ${keyLabel(key)} got unknown descriptor key \`${keyLabel(dk)}\`${near ? ` -- did you mean \`${near}\`?` : ""} Known keys: get, equals.`,
    );
}

function throwDerivedGetNotFn(key) {
    throw new TypeError(
        `${ERR}defineReactive derived ${keyLabel(key)} \`get\` must be a function (self) -> value.`,
    );
}

function throwBadDerived(key) {
    throw new TypeError(
        `${ERR}defineReactive derived ${keyLabel(key)} must be a function (self) -> value or { get, equals }.`,
    );
}

function throwUnknownEffectDescKey(key, dk) {
    const near = nearestKey(keyLabel(dk), ["run", "scheduler"]);
    throw new TypeError(
        `${ERR}defineReactive effect ${keyLabel(key)} got unknown descriptor key \`${keyLabel(dk)}\`${near ? ` -- did you mean \`${near}\`?` : ""} Known keys: run, scheduler.`,
    );
}

function throwEffectRunNotFn(key) {
    throw new TypeError(
        `${ERR}defineReactive effect ${keyLabel(key)} \`run\` must be a function (self) -> void.`,
    );
}

function throwBadEffect(key) {
    throw new TypeError(
        `${ERR}defineReactive effect ${keyLabel(key)} must be a function (self) -> void or { run, scheduler }.`,
    );
}

function throwSpecCollision(className, key) {
    throw new TypeError(
        `${ERR}defineReactive spec declares ${keyLabel(key)}, but ${className}.prototype already owns that member -- a spec-declared member cannot collide with a hand-written one.`,
    );
}

// --- Hot-body factories (section-2 canon; reviewer diffs byte-for-byte) -------

function makeGet(slot) { return function () { return this[slot].get(); }; }
function makeSet(slot) { return function (v) { this[slot].set(v); }; }
function makeDerivedGet(slot) { return function () { return this[slot].get(); }; }

function makeInit(rec) {
    return function (v) {
        if (rec.plan === null) throwMissingHost(rec);
        const box = rec.plan.reg.signalBox(v, rec.opts);
        this[rec.slot] = box;
        SCRATCH.push(box);                     // D-2h: track for init-phase rollback
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
        if (KNOWN_OPTION_KEYS.indexOf(keys[i]) === -1) throwUnknownOption(what, keys[i], KNOWN_OPTION_KEYS);
    }
    if ("equals" in opts && opts.equals !== undefined && typeof opts.equals !== "function") throwBadEquals(what);
    if (opts.equals === undefined) return undefined;
    return Object.freeze({ equals: opts.equals });
}

function validateEffectOptions(opts) {
    // Returns a frozen { scheduler } copy, or undefined for the bare form.
    if (opts === undefined || opts === null) return undefined;
    if (typeof opts !== "object") throwUsage("reactiveEffect");
    const keys = Object.keys(opts);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== "scheduler") throwUnknownOption("reactiveEffect", keys[i], EFFECT_OPTION_KEYS);
    }
    if ("scheduler" in opts && opts.scheduler !== undefined && typeof opts.scheduler !== "function") throwBadScheduler("reactiveEffect");
    if (opts.scheduler === undefined) return undefined;
    return Object.freeze({ scheduler: opts.scheduler });
}

function validateBatchedOptions(opts) {
    // batched takes no options in 0.2.0: bare + zero-key factory only.
    if (opts === undefined || opts === null) return;
    if (typeof opts !== "object") throwUsage("batched");
    const keys = Object.keys(opts);
    if (keys.length > 0) throwBatchedOptions(keys[0]);
}

function validateRegistry(registry) {
    // Duck-check: every REG_METHODS name must be a function. First missing
    // method names the throw (catches a RegistryConfig or a partial facade).
    if (typeof registry !== "object" || registry === null) throwBadRegistry(REG_METHODS[0]);
    for (let i = 0; i < REG_METHODS.length; i++) {
        if (typeof registry[REG_METHODS[i]] !== "function") throwBadRegistry(REG_METHODS[i]);
    }
    return registry;
}

function validateHostOptions(opts) {
    // Returns the validated Registry, or undefined for the bare/no-registry
    // form. Shared by @reactiveHost({ registry }) and defineReactive spec.host.
    if (opts === undefined || opts === null) return undefined;
    if (typeof opts !== "object") throwUsage("reactiveHost");
    const keys = Object.keys(opts);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== "registry") throwUnknownOption("reactiveHost", keys[i], HOST_OPTION_KEYS);
    }
    if (opts.registry === undefined) return undefined;
    return validateRegistry(opts.registry);
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
        initFn: null,                          // decorator boxes are born at init
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
        initFn: null,
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

// --- reactiveEffect (PD-12) ---------------------------------------------------

function makeEffectPublic(rec) {
    // D-4b guarded form: manual calls never leak deps into a foreign tracking
    // scope. The `p === null` guard makes a prototype-level or pre-host call fail
    // closed. The rest-array + (rare) untrack closure is the 0004-measured
    // manual-call cost -- a COLD path by contract.
    const fn = rec.fn;
    return function (...args) {
        const p = rec.plan;
        if (p === null) throwMissingHost(rec);
        // Identity guard (D-4e): `this` must be a reactive instance whose plan
        // merges THIS rec by reference (byKey identity, not plan identity, so a
        // Derived instance calling a Base-declared method still passes). A null,
        // primitive, foreign, or cross-class receiver fails closed here.
        const ip = planOf(this);
        if (ip === undefined || ip.byKey.get(rec.key) !== rec) {
            throwNotWired(`${p.ctorName}.${keyLabel(rec.key)}`);
        }
        const reg = p.reg;
        return reg.isTracking()
            ? reg.untrack(() => fn.apply(this, args))
            : fn.apply(this, args);
    };
}

function applyReactiveEffect(value, ctx, opts) {
    if (!isStandardContext(ctx)) throwLegacyEmit("reactiveEffect");
    if (ctx.kind !== "method") {
        throwWrongKind("reactiveEffect", "method", ctx.kind, "write `@reactiveEffect m() { ... }`.");
    }
    if (ctx.static === true) throwStatic("reactiveEffect", ctx.name);
    if (ctx.private === true) throwPrivate("reactiveEffect", ctx.name);
    const rec = {
        kind: "effect",
        key: ctx.name,
        pub: null,
        fn: value,
        opts,
        plan: null,
    };
    rec.pub = makeEffectPublic(rec);
    PENDING.push(rec);
    ctx.addInitializer(function () {
        if (rec.plan === null) throwMissingHost(rec);
    });
    return rec.pub;
}

/**
 * `@reactiveEffect m()` -- a method that auto-runs as an effect once the
 * instance is wired. Bare or as a factory `@reactiveEffect({ scheduler })`.
 */
export function reactiveEffect(value, ctx) {
    if (arguments.length >= 2) return applyReactiveEffect(value, ctx, undefined);
    const opts = validateEffectOptions(value);
    return function (v, c) { return applyReactiveEffect(v, c, opts); };
}

// --- batched (PD-13) ----------------------------------------------------------

function makeBatchedPublic(rec) {
    // Every call runs the body inside one engine batch. The per-call thunk +
    // rest array is the DOCUMENTED action-grade cost (R8) -- not a per-frame
    // path. The `p === null` guard fails closed before wiring.
    const fn = rec.fn;
    return function (...args) {
        const p = rec.plan;
        if (p === null) throwMissingHost(rec);
        // Identity guard (D-4e): same byKey-identity check as the effect form.
        const ip = planOf(this);
        if (ip === undefined || ip.byKey.get(rec.key) !== rec) {
            throwNotWired(`${p.ctorName}.${keyLabel(rec.key)}`);
        }
        return p.reg.batch(() => fn.apply(this, args));
    };
}

function applyBatched(value, ctx) {
    if (!isStandardContext(ctx)) throwLegacyEmit("batched");
    if (ctx.kind !== "method") {
        throwWrongKind("batched", "method", ctx.kind, "write `@batched m() { ... }`.");
    }
    if (ctx.static === true) throwStatic("batched", ctx.name);
    if (ctx.private === true) throwPrivate("batched", ctx.name);
    const rec = {
        kind: "batched",
        key: ctx.name,
        pub: null,
        fn: value,
        opts: undefined,
        plan: null,
    };
    rec.pub = makeBatchedPublic(rec);
    PENDING.push(rec);
    ctx.addInitializer(function () {
        if (rec.plan === null) throwMissingHost(rec);
    });
    return rec.pub;
}

/**
 * `@batched m()` -- a method whose body runs inside one engine batch. Bare or
 * as a zero-key factory `@batched()`. Action-grade, not a per-frame path.
 */
export function batched(value, ctx) {
    if (arguments.length >= 2) return applyBatched(value, ctx);
    validateBatchedOptions(value);
    return function (v, c) { return applyBatched(v, c); };
}

// --- Claim + plan (PD-1/2/6) --------------------------------------------------

function buildHandles(rec, ctorName) {
    // Poison: thrown after dispose. Prewired: thrown before wiring installs the
    // own slot. Both frozen, both carrying NONLIVE for marker-tag recognition.
    // The prewired message is built ONCE and shared by get + set (PD-15).
    const key = rec.key;
    rec.poison = Object.freeze({
        [NONLIVE]: "disposed",
        get() { throw new ReactiveDisposedError(ctorName, key); },
        set(v) { throw new ReactiveDisposedError(ctorName, key); },
    });
    const msg = rec.kind === "signal"
        ? `${ERR}${ctorName}.${keyLabel(key)} read/write before its initializer ran (declaration order).`
        : `${ERR}${ctorName}.${keyLabel(key)} read before construction completed (deriveds are available after wiring).`;
    rec.prewired = Object.freeze({
        [NONLIVE]: "prewired",
        get() { throw new TypeError(msg); },
        set(v) { throw new TypeError(msg); },
    });
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

function claimPlan(C, ctorName, registry) {
    // Drain PENDING wholly FIRST so a broken earlier class cannot poison every
    // later claim forever (PD-2). Validate identity against C.prototype after.
    const own = PENDING.splice(0, PENDING.length);
    const proto = C.prototype;

    // Registry resolution + heterogeneity law (PD-11, fail closed).
    const ancestor = nearestAncestorPlan(C);
    let reg;
    if (registry !== undefined) {
        if (ancestor !== undefined && ancestor.reg !== registry) throwRegistryMismatch(ctorName);
        reg = registry;
    } else if (ancestor !== undefined) {
        reg = ancestor.reg;
    } else {
        reg = DEFAULT_REG;
    }

    const signals = [];
    const deriveds = [];
    const effects = [];
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
        for (let i = 0; i < ancestor.effects.length; i++) {
            const r = ancestor.effects[i];
            effects.push(r);
            byKey.set(r.key, r);
        }
    }

    // Duplicate-key law FIRST (PD-13): subclass redeclaration OR two stacked
    // package decorators on one member. Stacking installs only the outermost on
    // the prototype, so this must precede the orphan check to name the real
    // cause instead of a misleading "orphan".
    const ownSeen = new Set();
    for (let i = 0; i < own.length; i++) {
        const key = own[i].key;
        if (byKey.has(key) || ownSeen.has(key)) throwDuplicateKey(ctorName, key);
        ownSeen.add(key);
    }

    // Orphan check: every own rec must be installed on the prototype.
    const orphans = [];
    for (let i = 0; i < own.length; i++) {
        const rec = own[i];
        const desc = Object.getOwnPropertyDescriptor(proto, rec.key);
        let installed;
        if (rec.kind === "signal" || rec.kind === "derived") {
            installed = desc !== undefined && desc.get === rec.get;
        } else {
            installed = desc !== undefined && desc.value === rec.pub;
        }
        if (!installed) orphans.push(keyLabel(rec.key));
    }
    if (orphans.length > 0) throwOrphans(ctorName, orphans);

    for (let i = 0; i < own.length; i++) {
        const rec = own[i];
        if (rec.kind === "signal" || rec.kind === "derived") buildHandles(rec, ctorName);
        if (rec.kind === "signal") signals.push(rec);
        else if (rec.kind === "derived") deriveds.push(rec);
        else if (rec.kind === "effect") effects.push(rec);
        // batched recs join byKey only (no node) for reg resolution + diagnostics.
        byKey.set(rec.key, rec);
    }

    const plan = {
        ctorName,
        reg,
        signals: Object.freeze(signals),
        deriveds: Object.freeze(deriveds),
        effects: Object.freeze(effects),
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

function makeDerivedBody(inst, fn) { return function () { return fn.call(inst, inst); }; }
function makeEffectBody(inst, fn) { return function () { return fn.call(inst, inst); }; }

function wireInstance(inst, plan) {
    const reg = plan.reg;
    // The WHOLE wiring phase is atomic (D-2h): the buildless box loop and the
    // R-A anchor creation sit INSIDE the try, so a CapacityError at a buildless
    // box (mid-loop) or at the anchor effect (headroom P exactly) still routes
    // through disposeCore. By this point W has already truncated its SCRATCH
    // frame (decorator path) or never populated it (buildless), so disposeCore
    // is the sole wiring-phase cleaner -- no double dispose. disposeCore tolerates
    // every partial state (ANCHOR undefined -> skipped; prewired slots -> skipped).
    try {
        // Buildless signals: create bare boxes in spec order BEFORE the anchor.
        // Decorator boxes already exist from field-init time (initFn === null).
        const sigs = plan.signals;
        for (let i = 0; i < sigs.length; i++) {
            const r = sigs[i];
            if (r.initFn !== null) inst[r.slot] = reg.signalBox(r.initFn(inst), r.opts);
        }
        let a;
        reg.createRoot(() => { reg.effect(() => { a = reg.getOwner(); }); });   // R-A anchor
        inst[ANCHOR] = a;
        reg.runWithOwner(a, () => {
            const ders = plan.deriveds;
            for (let i = 0; i < ders.length; i++) {
                const d = ders[i];
                inst[d.slot] = reg.computedBox(makeDerivedBody(inst, d.fn), d.opts);
            }
            // Effects wire AFTER every derived (D-4a): the first synchronous run
            // sees every field and every derived. Dispose handles are DISCARDED --
            // teardown is the anchor cascade. The ONE introspection flag test
            // (S4, PD-23/24): the OFF branch is byte-identical to 0.3.0; the ON
            // branch captures effect handles for labeling + registers audit.
            const effs = plan.effects;
            if (INTROSPECT_ON) {
                const effHandles = LABELS_ON ? [] : null;
                for (let i = 0; i < effs.length; i++) {
                    const h = reg.effect(makeEffectBody(inst, effs[i].fn), effs[i].opts);
                    if (effHandles !== null) effHandles.push(h);
                }
                introspectWire(inst, plan, reg, effHandles);
            } else {
                for (let i = 0; i < effs.length; i++) {
                    const e = effs[i];
                    reg.effect(makeEffectBody(inst, e.fn), e.opts);
                }
            }
        });
    } catch (e) {
        disposeCore(inst, plan);               // conservation intact
        throw e;                               // CapacityError propagates as-is
    }
}

function disposeCore(inst, plan) {             // assumes not already disposed
    const reg = plan.reg;
    const a = inst[ANCHOR];
    if (a !== undefined && a !== DISPOSED) reg.dispose(a); // cascades deriveds + effects
    const sigs = plan.signals;
    for (let i = 0; i < sigs.length; i++) {
        const r = sigs[i];
        const box = inst[r.slot];
        if (box !== undefined && box[NONLIVE] === undefined) reg.dispose(box);
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

function applyReactiveHost(C, ctx, registry) {
    if (!isStandardContext(ctx)) throwLegacyEmit("reactiveHost");
    if (ctx.kind !== "class") {
        throwWrongKind("reactiveHost", "class", ctx.kind, "apply `@reactiveHost` to the class.");
    }
    if (Object.prototype.hasOwnProperty.call(C, HOST_MARK)) throwDoubleHost(ctx.name || C.name);

    const ctorName = ctx.name || C.name;
    const plan = claimPlan(C, ctorName, registry);   // PD-1/2/6/11

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
            // D-2h scratch frame, gated on the most-derived host (PD-5): ONLY the
            // wiring W runs the frame protocol. Its super() spans the whole chain,
            // so its single [f, end) frame covers every base + derived init box.
            // Intermediate hosts must NOT capture/truncate their own frame -- doing
            // so would evict their base init boxes before a derived init overflows,
            // leaking them (the intermediate-host defect). Non-wiring hosts just
            // call plain super() and leave their boxes in the leaf's frame.
            if (new.target[HOST_MARK] === W) {
                const f = SCRATCH.length;
                try {
                    super(...args);
                } catch (e) {
                    for (let i = SCRATCH.length - 1; i >= f; i--) plan.reg.dispose(SCRATCH.pop());
                    throw e;
                }
                SCRATCH.length = f;             // success: clear the frame before wiring
                wireInstance(this, plan);
            } else {
                super(...args);
            }
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
 * constructor builds the anchor, every derived, and every effect exactly once.
 * Bare, or as a factory `@reactiveHost({ registry })` to isolate the host chain
 * on a custom lite-signal registry.
 */
export function reactiveHost(C, ctx) {
    // Standard class-decorator application passes 2 args (class, context).
    if (arguments.length >= 2) return applyReactiveHost(C, ctx, undefined);
    // A legacy class decorator is called with just the constructor (1 arg).
    if (typeof C === "function") throwLegacyEmit("reactiveHost");
    // Factory form: bare (), ({}), ({ registry }) -- validated + duck-checked.
    const registry = validateHostOptions(C);
    return function (cls, c) { return applyReactiveHost(cls, c, registry); };
}

// --- defineReactive (PD-14, buildless twin -- shares the wiring by identity) ---

function makeSignalRecFromValue(key, initFn, opts) {
    const slot = Symbol(typeof key === "symbol" ? "reactive" : "reactive:" + String(key));
    return {
        kind: "signal",
        key,
        slot,
        get: makeGet(slot),
        set: makeSet(slot),
        fn: null,
        opts,
        plan: null,
        poison: null,
        prewired: null,
        initFn,
    };
}

function normalizeEquals(entry, what) {
    if (!("equals" in entry)) return undefined;
    const eq = entry.equals;
    if (eq === undefined) return undefined;
    if (typeof eq !== "function") throwBadEquals(what);
    return Object.freeze({ equals: eq });
}

function normalizeSignalEntry(key, entry) {
    // Non-function, non-object -> the initial value verbatim.
    if (typeof entry === "function") throwAmbiguousSignal(key);
    if (entry === null || typeof entry !== "object") {
        const initial = entry;
        return makeSignalRecFromValue(key, function () { return initial; }, undefined);
    }
    // Descriptor { initial | init | equals }.
    const dkeys = Reflect.ownKeys(entry);
    for (let i = 0; i < dkeys.length; i++) {
        const dk = dkeys[i];
        if (dk !== "initial" && dk !== "init" && dk !== "equals") throwUnknownSignalDescKey(key, dk);
    }
    const hasInitial = Object.prototype.hasOwnProperty.call(entry, "initial");
    const hasInit = Object.prototype.hasOwnProperty.call(entry, "init");
    if (hasInitial && hasInit) throwSignalInitialInitConflict(key);
    let initFn;
    if (hasInit) {
        const init = entry.init;
        if (typeof init !== "function") throwSignalInitNotFn(key);
        initFn = function (inst) { return init.call(inst, inst); };
    } else if (hasInitial) {
        const initial = entry.initial;
        initFn = function () { return initial; };
    } else {
        initFn = function () { return undefined; };
    }
    const opts = normalizeEquals(entry, `defineReactive signal ${keyLabel(key)}`);
    return makeSignalRecFromValue(key, initFn, opts);
}

function normalizeSignals(spec, recs) {
    const s = spec.signals;
    if (s === undefined) return;
    if (Array.isArray(s)) {
        for (let i = 0; i < s.length; i++) {
            recs.push(makeSignalRecFromValue(s[i], function () { return undefined; }, undefined));
        }
        return;
    }
    if (s === null || typeof s !== "object") throwSpecSignals();
    const keys = Reflect.ownKeys(s);
    for (let i = 0; i < keys.length; i++) {
        recs.push(normalizeSignalEntry(keys[i], s[keys[i]]));
    }
}

function makeDerivedRec(key, fn, opts) {
    const slot = Symbol(typeof key === "symbol" ? "derived" : "derived:" + String(key));
    return {
        kind: "derived",
        key,
        slot,
        get: makeDerivedGet(slot),
        set: undefined,
        fn,
        opts,
        plan: null,
        poison: null,
        prewired: null,
        initFn: null,
    };
}

function normalizeDeriveds(spec, recs) {
    const d = spec.deriveds;
    if (d === undefined) return;
    if (d === null || typeof d !== "object" || Array.isArray(d)) throwSpecDeriveds();
    const keys = Reflect.ownKeys(d);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const entry = d[key];
        let fn;
        let opts;
        if (typeof entry === "function") {
            fn = entry;
            opts = undefined;
        } else if (entry !== null && typeof entry === "object") {
            const dkeys = Reflect.ownKeys(entry);
            for (let j = 0; j < dkeys.length; j++) {
                const dk = dkeys[j];
                if (dk !== "get" && dk !== "equals") throwUnknownDerivedDescKey(key, dk);
            }
            if (typeof entry.get !== "function") throwDerivedGetNotFn(key);
            fn = entry.get;
            opts = normalizeEquals(entry, `defineReactive derived ${keyLabel(key)}`);
        } else {
            throwBadDerived(key);
        }
        recs.push(makeDerivedRec(key, fn, opts));
    }
}

function makeEffectRec(key, fn, opts) {
    const rec = { kind: "effect", key, pub: null, fn, opts, plan: null };
    rec.pub = makeEffectPublic(rec);
    return rec;
}

function normalizeEffects(spec, recs) {
    const e = spec.effects;
    if (e === undefined) return;
    if (e === null || typeof e !== "object" || Array.isArray(e)) throwSpecEffects();
    const keys = Reflect.ownKeys(e);
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const entry = e[key];
        let fn;
        let opts;
        if (typeof entry === "function") {
            fn = entry;
            opts = undefined;
        } else if (entry !== null && typeof entry === "object") {
            const dkeys = Reflect.ownKeys(entry);
            for (let j = 0; j < dkeys.length; j++) {
                const dk = dkeys[j];
                if (dk !== "run" && dk !== "scheduler") throwUnknownEffectDescKey(key, dk);
            }
            if (typeof entry.run !== "function") throwEffectRunNotFn(key);
            fn = entry.run;
            if (entry.scheduler !== undefined && typeof entry.scheduler !== "function") {
                throwBadScheduler(`defineReactive effect ${keyLabel(key)}`);
            }
            opts = entry.scheduler === undefined ? undefined : Object.freeze({ scheduler: entry.scheduler });
        } else {
            throwBadEffect(key);
        }
        recs.push(makeEffectRec(key, fn, opts));
    }
}

function installRec(rec, proto) {
    if (rec.kind === "signal") {
        Object.defineProperty(proto, rec.key, {
            get: rec.get,
            set: rec.set,
            enumerable: true,
            configurable: true,
        });
    } else if (rec.kind === "derived") {
        Object.defineProperty(proto, rec.key, {
            get: rec.get,
            enumerable: true,
            configurable: true,
        });
    } else {                                   // effect
        Object.defineProperty(proto, rec.key, {
            value: rec.pub,
            writable: true,
            enumerable: false,
            configurable: true,
        });
    }
}

/**
 * `defineReactive(Class, spec)` -- the buildless twin of the decorators. Builds
 * the SAME per-class plan the decorators build (same factories, same wiring),
 * installs the accessors + effect methods on `Class.prototype`, and wraps the
 * class through the SAME host step. Zero decorator syntax required.
 */
export function defineReactive(Class, spec) {
    if (typeof Class !== "function") throwDefineClass();
    if (spec === null || typeof spec !== "object") throwDefineSpec();
    const sections = Reflect.ownKeys(spec);
    for (let i = 0; i < sections.length; i++) {
        const k = sections[i];
        if (k !== "signals" && k !== "deriveds" && k !== "effects" && k !== "host") {
            throwUnknownSection(k);
        }
    }

    const recs = [];
    normalizeSignals(spec, recs);              // signals first (spec/wire order)
    normalizeDeriveds(spec, recs);
    normalizeEffects(spec, recs);
    const registry = validateHostOptions(spec.host);   // shared PD-11 validation

    // Collision + within-spec duplicate law: check before installing anything,
    // so a rejected spec leaves the prototype and PENDING untouched.
    const proto = Class.prototype;
    const seen = new Set();
    for (let i = 0; i < recs.length; i++) {
        const key = recs[i].key;
        if (seen.has(key)) throwDuplicateKey(Class.name, key);
        seen.add(key);
        if (Object.prototype.hasOwnProperty.call(proto, key)) throwSpecCollision(Class.name, key);
    }

    for (let i = 0; i < recs.length; i++) {
        installRec(recs[i], proto);
        PENDING.push(recs[i]);
    }
    return applyReactiveHost(Class, { kind: "class", name: Class.name }, registry);
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
    // Refuse up front on a frozen instance (D-2g): the poison swap cannot be
    // installed, so proceeding would half-dispose (boxes torn down) then throw a
    // raw TypeError, leaving disposed boxes behind live-looking slots. Refusing
    // here is ATOMIC -- nothing is disposed. seal/preventExtensions stay fine
    // (slots remain writable); only isFrozen blocks the swap.
    if (Object.isFrozen(vm)) throwFrozenDispose(plan.ctorName);
    const reg = plan.reg;
    // Re-entrancy guard (D-2f): disposing this instance from inside one of its
    // OWN @derived computations would cascade the very node being computed, and
    // the engine would silently drop the freshly computed value (fail-open).
    // The isTracking() gate keeps the plain-code dispose path byte-identical and
    // zero-alloc; only under an active tracking context do we pay one getOwner()
    // descriptor to check whether the current computation is one of our deriveds.
    // Effects are NOT in plan.deriveds, so a D-4d self-dispose from an owned
    // effect never matches here -- the guard fires only for deriveds.
    if (reg.isTracking()) {
        const cur = reg.getOwner();
        if (cur !== undefined) {
            const ders = plan.deriveds;
            for (let i = 0; i < ders.length; i++) {
                const h = vm[ders[i].slot];
                if (h !== undefined && h[NONLIVE] === undefined && reg.nodeId(h) === cur.id) {
                    throwSelfDisposeInDerived(plan.ctorName, ders[i].key);
                }
            }
        }
    }
    // S4 introspection cleanup (one flag test on the OFF dispose path): drop this
    // instance's label entries and unregister it from the audit FR so a proper
    // dispose is never mistaken for a silent death.
    if (INTROSPECT_ON) introspectDispose(vm, reg);
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
    if (rec.kind === "effect" || rec.kind === "batched") throwNoBox(plan.ctorName, key, rec.kind);
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

// --- Introspection & audit (S4; all cold / opt-in) ----------------------------

function throwCostFactory() {
    throw new TypeError(
        `${ERR}costOf(Factory) -- Factory must be a @reactiveHost / defineReactive wrapper class.`,
    );
}

function throwCostNoPlan() {
    throw new Error(
        `${ERR}costOf(Factory) -- that class has no reactive plan; pass the class returned by @reactiveHost or defineReactive, not the undecorated inner class.`,
    );
}

function throwCostNoStats(name) {
    throw new TypeError(
        `${ERR}costOf(${name}) -- the bound registry has no stats() ledger; costOf/capacityFor need a createRegistry() registry (which always carries the stats ledger). A hand-rolled 11-method registry facade cannot be probed.`,
    );
}

function throwCostInconclusive(name, a, b) {
    throw new Error(
        `${ERR}costOf(${name}) -- inconclusive: two probes disagreed (nodes ${a.nodes}/${b.nodes}, links ${a.links}/${b.links}). A data-dependent derived read, or a registry mutated mid-probe, makes the cost non-deterministic; costOf fails closed rather than guess.`,
    );
}

function throwCostNodeMismatch(name, got, want) {
    throw new Error(
        `${ERR}costOf(${name}) -- probed node count ${got} != P+D+E+1 (${want}); the bound registry was not quiet during the probe.`,
    );
}

function throwCostFloor(name) {
    throw new Error(
        `${ERR}costOf(${name}) -- dispose did not return the bound registry to its pre-probe floor; the probe could not run against a quiet registry.`,
    );
}

// costOf runs the probe twice and requires identical deltas: an inconclusive
// probe is a fail-closed THROW, never a guessed number (PD-21).
function probeCost(Factory, plan, reg) {
    const before = reg.stats();
    const inst = new Factory();
    const ders = plan.deriveds;
    for (let i = 0; i < ders.length; i++) void inst[ders[i].key];   // force lazy links
    const mid = reg.stats();
    const nodes = mid.activeNodes - before.activeNodes;
    const links = mid.activeLinks - before.activeLinks;
    disposeReactive(inst);
    const after = reg.stats();
    if (after.activeNodes !== before.activeNodes || after.activeLinks !== before.activeLinks) {
        throwCostFloor(plan.ctorName);
    }
    return { nodes, links };
}

/**
 * Measure the settled per-instance cost of a reactive class on its bound
 * registry: construct, read every `@derived` once (forcing the lazy links),
 * snapshot, dispose, verify the floor -- twice, requiring identical deltas.
 * Returns a frozen `{ nodes, links, signals, deriveds, effects }`; `nodes`
 * equals P+D+E+1. Cached per class. Throws (never guesses) on an inconclusive
 * or polluted probe. Constructs the probe instance with no arguments.
 */
export function costOf(Factory) {
    if (typeof Factory !== "function") throwCostFactory();
    const cached = COST_CACHE.get(Factory);
    if (cached !== undefined) return cached;
    const plan = PLANS.get(Factory);
    if (plan === undefined) throwCostNoPlan();
    const reg = plan.reg;
    // The 11-method REG_METHODS duck-check excludes stats (the wiring/dispose
    // paths never need it), so a hand-rolled facade can be duck-valid yet lack
    // stats -- guard here rather than let probeCost throw a raw TypeError.
    if (typeof reg.stats !== "function") throwCostNoStats(plan.ctorName);
    const first = probeCost(Factory, plan, reg);
    const second = probeCost(Factory, plan, reg);
    if (first.nodes !== second.nodes || first.links !== second.links) {
        throwCostInconclusive(plan.ctorName, first, second);
    }
    const sig = plan.signals.length;
    const der = plan.deriveds.length;
    const eff = plan.effects.length;
    const expected = sig + der + eff + 1;
    if (first.nodes !== expected) throwCostNodeMismatch(plan.ctorName, first.nodes, expected);
    const result = Object.freeze({
        nodes: first.nodes,
        links: first.links,
        signals: sig,
        deriveds: der,
        effects: eff,
    });
    COST_CACHE.set(Factory, result);
    return result;
}

function throwCapInventory() {
    throw new TypeError(
        `${ERR}capacityFor(inventory) -- inventory must be a non-empty array of [Factory, count] pairs.`,
    );
}

function throwCapPair(i) {
    throw new TypeError(
        `${ERR}capacityFor -- inventory[${i}] must be a [Factory, count] pair.`,
    );
}

function throwCapFactory(i) {
    throw new TypeError(
        `${ERR}capacityFor -- inventory[${i}][0] must be a @reactiveHost / defineReactive wrapper class.`,
    );
}

function throwCapCount(i) {
    throw new TypeError(
        `${ERR}capacityFor -- inventory[${i}][1] must be a positive integer count.`,
    );
}

function throwCapHeadroom() {
    throw new TypeError(
        `${ERR}capacityFor -- headroom must be a finite number >= 1.`,
    );
}

function throwCapOptions(options) {
    const got = Array.isArray(options) ? "an array" : typeof options;
    throw new TypeError(
        `${ERR}capacityFor(inventory, options?) -- options must be a plain object like { headroom: 1.25 }; got ${got}.`,
    );
}

/**
 * Size a `createRegistry` config for a stated inventory of `[Factory, count]`
 * pairs. Nodes are exact (`sum(cost.nodes x count)`); links are
 * `sum(cost.links x count)` scaled by `headroom` (default 1 -- exact; see
 * decisions/0007). Returns
 * `{ maxNodes, maxLinks, prealloc: "eager", onCapacityExceeded: "throw" }`.
 * Fail-closed on a non-factory, a non-positive/non-integer count, an empty
 * inventory, or a bad `headroom`.
 */
export function capacityFor(inventory, options) {
    if (!Array.isArray(inventory) || inventory.length === 0) throwCapInventory();
    let headroom = 1;
    if (options !== undefined && options !== null) {   // null == omitted (preserved)
        if (typeof options !== "object" || Array.isArray(options)) throwCapOptions(options);
        const okeys = Object.keys(options);
        for (let i = 0; i < okeys.length; i++) {
            if (okeys[i] !== "headroom") throwUnknownOption("capacityFor", okeys[i], CAP_OPTION_KEYS);
        }
        if (options.headroom !== undefined) {
            const h = options.headroom;
            if (typeof h !== "number" || !isFinite(h) || h < 1) throwCapHeadroom();
            headroom = h;
        }
    }
    let totalNodes = 0;
    let totalLinks = 0;
    for (let i = 0; i < inventory.length; i++) {
        const pair = inventory[i];
        if (!Array.isArray(pair) || pair.length !== 2) throwCapPair(i);
        const Factory = pair[0];
        const count = pair[1];
        if (typeof Factory !== "function") throwCapFactory(i);
        if (typeof count !== "number" || !Number.isInteger(count) || count <= 0) throwCapCount(i);
        const cost = costOf(Factory);
        totalNodes += cost.nodes * count;
        totalLinks += cost.links * count;
    }
    return {
        maxNodes: totalNodes,                          // exact -- nodes are deterministic
        // links x headroom, floored at the engine minimum of 1 (createRegistry
        // rejects maxLinks: 0) so a signals-only inventory still yields a
        // constructible config (0007). Floor is applied AFTER the multiplier.
        maxLinks: Math.max(1, Math.ceil(totalLinks * headroom)),
        prealloc: "eager",
        onCapacityExceeded: "throw",
    };
}

function throwFlagArg(what) {
    throw new TypeError(`${ERR}${what}(on) -- on must be a boolean.`);
}

// Per-class label strings, built once and shared by every instance (PD-23).
function labelStringsFor(plan) {
    let s = LABEL_STRINGS.get(plan);
    if (s !== undefined) return s;
    const name = plan.ctorName;
    const sig = [];
    for (let i = 0; i < plan.signals.length; i++) sig.push(`${name}.${keyLabel(plan.signals[i].key)}`);
    const der = [];
    for (let i = 0; i < plan.deriveds.length; i++) der.push(`${name}.${keyLabel(plan.deriveds[i].key)}`);
    const eff = [];
    for (let i = 0; i < plan.effects.length; i++) eff.push(`${name}#${keyLabel(plan.effects[i].key)}`);
    s = { anchor: `${name}@anchor`, signals: sig, deriveds: der, effects: eff };
    LABEL_STRINGS.set(plan, s);
    return s;
}

function registerLabels(inst, plan, reg, effHandles) {
    let map = LABEL_MAPS.get(reg);
    if (map === undefined) {
        map = new Map();
        LABEL_MAPS.set(reg, map);
    }
    const strings = labelStringsFor(plan);
    const ids = [];
    const anchorId = reg.nodeId(inst[ANCHOR]);
    if (anchorId !== undefined) { map.set(anchorId, strings.anchor); ids.push(anchorId); }
    const sigs = plan.signals;
    for (let i = 0; i < sigs.length; i++) {
        const id = reg.nodeId(inst[sigs[i].slot]);
        if (id !== undefined) { map.set(id, strings.signals[i]); ids.push(id); }
    }
    const ders = plan.deriveds;
    for (let i = 0; i < ders.length; i++) {
        const id = reg.nodeId(inst[ders[i].slot]);
        if (id !== undefined) { map.set(id, strings.deriveds[i]); ids.push(id); }
    }
    if (effHandles !== null) {
        for (let i = 0; i < effHandles.length; i++) {
            const id = reg.nodeId(effHandles[i]);
            if (id !== undefined) { map.set(id, strings.effects[i]); ids.push(id); }
        }
    }
    inst[LABEL_IDS] = ids;
}

function auditShape(plan) {
    return `P=${plan.signals.length} D=${plan.deriveds.length} E=${plan.effects.length}`;
}

function auditFinalize(held) {
    // held is a plain { className, shape } record -- it never references the
    // (now-collected) instance, so the FR cannot itself retain what it watches.
    console.error(
        `${ERR}auditReactive: an instance of ${held.className} (${held.shape}) was garbage-collected without disposeReactive() -- its reactive graph was reclaimed by GC, not by you. Dispose at end of life: disposeReactive(vm), or a \`using\` block.`,
    );
}

// Wiring-time introspection (S4): only reached when INTROSPECT_ON. Registers
// per-node labels (while LABELS_ON) and the audit FR entry (while AUDIT_ON).
function introspectWire(inst, plan, reg, effHandles) {
    if (LABELS_ON) registerLabels(inst, plan, reg, effHandles);
    if (AUDIT_ON && AUDIT_FR !== null) {
        AUDIT_FR.register(inst, { className: plan.ctorName, shape: auditShape(plan) }, inst);
    }
}

// Dispose-time introspection (S4): only reached when INTROSPECT_ON. Drops this
// instance's label entries and unregisters it from the audit FR.
function introspectDispose(vm, reg) {
    const ids = vm[LABEL_IDS];
    if (ids !== undefined) {
        const map = LABEL_MAPS.get(reg);
        if (map !== undefined) for (let i = 0; i < ids.length; i++) map.delete(ids[i]);
        vm[LABEL_IDS] = undefined;
    }
    if (AUDIT_FR !== null) AUDIT_FR.unregister(vm);
}

/**
 * Toggle devtools labels (default OFF). While ON, wiring registers a
 * `nodeId -> "Class.prop" / "Class#method" / "Class@anchor"` label for every
 * node an instance creates, into a per-registry map; `disposeReactive`
 * unregisters them. OFF adds no hot-path cost (the accessor canon is untouched).
 */
export function enableLabels(on) {
    if (typeof on !== "boolean") throwFlagArg("enableLabels");
    LABELS_ON = on;
    INTROSPECT_ON = LABELS_ON || AUDIT_ON;
}

/**
 * Resolve a node id (or a handle, via the registry's `nodeId`) to its label, or
 * `undefined` if unlabeled/unknown -- an introspection miss is never an error.
 * `registry` defaults to the default registry; pass a custom `Registry` to look
 * up nodes it owns.
 */
export function labelOf(idOrHandle, registry) {
    const reg = registry === undefined || registry === null ? DEFAULT_REG : registry;
    if (typeof reg !== "object" || reg === null) return undefined;
    let id;
    if (typeof idOrHandle === "number") {
        id = idOrHandle;
    } else if (idOrHandle !== null && typeof idOrHandle === "object" && typeof reg.nodeId === "function") {
        id = reg.nodeId(idOrHandle);
        if (id === undefined) return undefined;
    } else {
        return undefined;
    }
    const map = LABEL_MAPS.get(reg);
    if (map === undefined) return undefined;
    return map.get(id);
}

/**
 * Toggle the leak auditor (default OFF). While ON, a lazily-created
 * FinalizationRegistry reports (one `console.error`) any instance that is
 * garbage-collected WITHOUT `disposeReactive` -- naming the class + shape. OFF:
 * no FinalizationRegistry exists and nothing is registered.
 */
export function auditReactive(on) {
    if (typeof on !== "boolean") throwFlagArg("auditReactive");
    if (on && AUDIT_FR === null && typeof FinalizationRegistry === "function") {
        AUDIT_FR = new FinalizationRegistry(auditFinalize);
    }
    AUDIT_ON = on;
    INTROSPECT_ON = LABELS_ON || AUDIT_ON;
}

// --- Version ------------------------------------------------------------------

/** Package version. Kept in lockstep with package.json and llms.txt. */
export const VERSION = "0.4.0";
