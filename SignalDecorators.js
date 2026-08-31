/**
 * @zakkster/lite-signal-decorators v1.5.1
 * --------------------
 * Standard-decorators layer over @zakkster/lite-signal. Turns a plain class into
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
    forEachOwned,
    forEachSource,
    createRegistry,
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

// Marks the poison/prewired/parked handles so boxOf/rootOf recognize them
// without calling get() (PD-4): value is "disposed", "prewired", or "parked".
const NONLIVE = Symbol("lite-signal-decorators.nonlive");

// Frozen sentinel written to ANCHOR on dispose (idempotency signal, PD-7).
const DISPOSED = Object.freeze({ [NONLIVE]: "disposed" });

// PD-44: frozen sentinel written to ANCHOR on releaseReactive(), the PARKED
// state. Distinct from DISPOSED so the lattice tells a pooled instance (revivable
// by reinitReactive) from a terminally-disposed one; both carry NONLIVE so
// disposeCore/boxOf/rootOf classify them without touching a live node.
const PARKED = Object.freeze({ [NONLIVE]: "parked" });

// PD-42: the per-instance prebuilt closure set (S6-T2). Built at first wiring
// (transient) and rebuilt+RETAINED at first releaseReactive, then reused by every
// acquire (buildGraph) so a reinit allocates ZERO new closures (0010 Q3). Holds
// the createRoot thunk, the anchor effect body, the runWithOwner thunk, and the
// per-derived and per-effect bodies. Kept in one module-private slot on the
// instance; a construct-once/dispose-once instance never stores it (S6-A6: the
// prebuild adds no retained construction cost, so churn-soak's maxMajor 0 holds).
const CLOSURES = Symbol("lite-signal-decorators.closures");

// PD-44: decorator-signal initials for reinit value reset. A decorator signal's
// initial is its field-initializer value, captured (per member, first-seen) in
// makeInit -- NOT retained per instance, so construct-once churn pays nothing.
// Buildless signals reset via their plan initFn instead; a caller override always
// wins. Keyed by the frozen signal rec (bounded by the class member count).
const SIG_INITIAL = new WeakMap();

// S8/PD-58: decorator-local field-initial for reinit reset. A @localTo member's
// field-initializer value is captured (per member, first-seen) in makeLocalInit --
// undefined means "no initializer" (the @localCopy flavor: reinit reseeds the box
// from the current upstream). Buildless locals carry hasInitial + initFn on the
// rec instead. Keyed by the frozen local rec (bounded by the class member count).
const LOCAL_INITIAL = new WeakMap();

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
const LOCAL_OPTION_KEYS = ["equals"];
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
    // `forEachOwned`/`forEachSource` join the facade the same way (S10): each
    // registry owns its NODE_PTR symbol, so a handle is walkable ONLY by the
    // registry that minted it. costOfInstance routes its walk through a plan's
    // own `reg`, so the default-registry path needs these two here; a custom
    // Registry from createRegistry() carries them natively. Not in REG_METHODS
    // (the wiring/dispose paths never walk).
    forEachOwned,
    forEachSource,
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
 * Thrown when a disposed OR parked reactive member (or root) is read or written.
 * Carries the originating class name and the member key for actionable
 * diagnostics. The optional `parked` flag selects a pooled-lifetime message so a
 * touch on a released-to-pool instance reads differently from a zombie (PD-44) --
 * one error class, two states, no surface growth.
 */
export class ReactiveDisposedError extends Error {
    constructor(className, key, parked) {
        super(
            parked
                ? `${ERR}${className}.${String(key)} was released to the pool (parked) -- call reinitReactive() to revive it before use`
                : `${ERR}${className}.${String(key)} was used after disposeReactive() -- the reactive graph is gone`,
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

function throwLocalSource() {
    throw new TypeError(
        `${ERR}localTo requires a source function: write \`@localTo((self) => self.upstream) accessor x = ...\`. \`source\` is a tracked (self) -> value read, not an option.`,
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

function throwSelfDisposeInDerived(ctorName, key, op) {
    // `op` defaults to disposeReactive so the 1.0.0 call site's message stays
    // byte-identical; releaseReactive passes its own name (same fail-open hazard).
    const fn = op === undefined ? "disposeReactive" : op;
    const verb = op === undefined ? "Dispose" : "Release";
    throw new Error(
        `${ERR}${fn}(${ctorName}) was called from inside its own @derived ${keyLabel(key)} computation -- derived getters must be pure. ${verb} from an effect, a subscription, or plain code instead.`,
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

function throwReleaseDisposed(ctorName) {
    throw new Error(
        `${ERR}releaseReactive(${ctorName}) -- the instance was disposed (terminal) and cannot be released to the pool. disposeReactive is final; releaseReactive parks a LIVE instance for reinitReactive to revive.`,
    );
}

function throwReleaseFrozen(ctorName) {
    throw new TypeError(
        `${ERR}releaseReactive(${ctorName}) -- the instance is frozen, so the parked-handle swap cannot be installed. Do not freeze a live reactive instance.`,
    );
}

function throwReinitLive(ctorName) {
    throw new Error(
        `${ERR}reinitReactive(${ctorName}) -- the instance is live; call releaseReactive() to park it before reinitReactive() revives it.`,
    );
}

function throwReinitDisposed(ctorName) {
    throw new Error(
        `${ERR}reinitReactive(${ctorName}) -- the instance was disposed (terminal); a disposed instance cannot be revived. Construct a fresh one.`,
    );
}

function throwReinitFrozen(ctorName) {
    throw new TypeError(
        `${ERR}reinitReactive(${ctorName}) -- the instance is frozen, so live handles cannot be restored into its slots. Do not freeze a parked instance.`,
    );
}

function throwReinitInitials(ctorName) {
    throw new TypeError(
        `${ERR}reinitReactive(${ctorName}, initials) -- initials must be an object mapping @reactive keys to their reset values.`,
    );
}

function throwReinitInitialsKey(ctorName, key, plan) {
    const avail = [];
    for (let i = 0; i < plan.signals.length; i++) avail.push(keyLabel(plan.signals[i].key));
    for (let i = 0; i < plan.locals.length; i++) avail.push(keyLabel(plan.locals[i].key));
    const near = nearestKey(keyLabel(key), avail);
    throw new Error(
        `${ERR}reinitReactive(${ctorName}) initials carries key \`${keyLabel(key)}\` that is not a @reactive signal or @localTo member${near ? ` -- did you mean \`${near}\`?` : ""} Resettable keys: ${avail.join(", ")}.`,
    );
}

function throwNoBox(ctorName, key, kind) {
    const what = kind === "effect" ? "@reactiveEffect" : "@batched";
    throw new Error(
        `${ERR}boxOf(${ctorName}, ${keyLabel(key)}) -- ${keyLabel(key)} is a ${what} member and has no backing box; boxOf serves @reactive, @localTo, and @derived members only.`,
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
    const near = nearestKey(keyLabel(key), ["signals", "locals", "deriveds", "effects", "host"]);
    throw new TypeError(
        `${ERR}defineReactive spec got unknown section \`${keyLabel(key)}\`${near ? ` -- did you mean \`${near}\`?` : ""} Known sections: signals, locals, deriveds, effects, host.`,
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

function throwSpecLocals() {
    throw new TypeError(
        `${ERR}defineReactive spec.locals must be a map of key -> { source, equals?, initial? }.`,
    );
}

function throwUnknownLocalDescKey(key, dk) {
    const near = nearestKey(keyLabel(dk), ["source", "equals", "initial"]);
    throw new TypeError(
        `${ERR}defineReactive local ${keyLabel(key)} got unknown descriptor key \`${keyLabel(dk)}\`${near ? ` -- did you mean \`${near}\`?` : ""} Known keys: source, equals, initial.`,
    );
}

function throwLocalSourceNotFn(key) {
    throw new TypeError(
        `${ERR}defineReactive local ${keyLabel(key)} \`source\` must be a function (self) -> value.`,
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

// S8 hot bodies (0014): the @localTo accessor pair. NEW bodies -- the 1.0.0 canon
// above stays byte-identical (S8-A5); @localTo pays its own measured cost. Both
// are prebuilt ONCE per member and close over the member's slots + source + equals,
// so a read/write allocates nothing (the same prebuilt-closure discipline as
// makeGet/makeSet). Two per-instance stores back a local: the box slot (a signal
// node, the local value) and the seen slot (a PLAIN field, the last-adopted
// upstream value). makeLocalGet is PURE (0014 read law): it calls the tracked
// source, equals-compares it against the seen slot, and returns the local box on
// an UNCHANGED upstream, else the upstream value -- never writing any box on the
// read path, so a localTo read is legal inside any @derived compute.
function makeLocalGet(rec) {
    const source = rec.source;
    const eq = rec.eq;
    const boxSlot = rec.slot;
    const seenSlot = rec.seenSlot;
    return function () {
        const up = source.call(this, this);
        if (eq(up, this[seenSlot])) return this[boxSlot].get();
        return up;
    };
}
// makeLocalSet: box.set (a write always overrides -- PD-56 never compares) + seen
// slot = upstream-at-write. The seen capture must NOT subscribe: a write inside an
// effect body runs under that effect's tracking scope, so a tracked source read
// there would silently link the effect to the upstream (a fail-open dep leak,
// measured: reg.isTracking() -> a bare source read re-fires the effect on an
// upstream move). The isTracking() gate untracks ONLY under an active scope --
// the same idiom makeEffectPublic uses (D-4b) -- so the plain-code write path
// (the hot path) stays a zero-alloc source.call, and only the rare in-effect write
// pays the untrack thunk. reg comes from the frozen rec.plan (set at claimPlan).
function makeLocalSet(rec) {
    const source = rec.source;
    const boxSlot = rec.slot;
    const seenSlot = rec.seenSlot;
    return function (v) {
        this[boxSlot].set(v);
        const reg = rec.plan.reg;
        this[seenSlot] = reg.isTracking()
            ? reg.untrack(() => source.call(this, this))
            : source.call(this, this);
    };
}

function makeInit(rec) {
    return function (v) {
        if (rec.plan === null) throwMissingHost(rec);
        const box = rec.plan.reg.signalBox(v, rec.opts);
        this[rec.slot] = box;
        SCRATCH.push(box);                     // D-2h: track for init-phase rollback
        // PD-44: record the first-seen field-initializer value as this decorator
        // signal's reinit reset value (per member, once; no per-instance retention).
        if (!SIG_INITIAL.has(rec)) SIG_INITIAL.set(rec, v);
        return v;                              // emitter backing store, unused
    };
}

// S8 (cold): seed one @localTo member's two stores on an instance. seen = the
// source read at wiring, UNTRACKED (wiring/reinit must register no dependency);
// the box starts at the declared initial when present, else at that same upstream
// value (the initial-value unification rule, 0014: an initializer -> @trackedReset
// flavor; no initializer -> @localCopy flavor). Returns the box for SCRATCH
// rollback. Shared by the decorator init, the buildless wire loop, and reinit.
function seedLocal(inst, rec, reg, hasInitial, initialValue) {
    const source = rec.source;
    const seen = reg.isTracking()
        ? reg.untrack(() => source.call(inst, inst))
        : source.call(inst, inst);
    // The box is created WITHOUT the equals opts: {equals} governs the UPSTREAM
    // compare only (PD-56); the box uses default equals so a local write always
    // propagates (a write overrides, never suppresses).
    const box = reg.signalBox(hasInitial ? initialValue : seen);
    inst[rec.slot] = box;
    inst[rec.seenSlot] = seen;
    return box;
}

// S8 (cold): the frozen local rec, shared by the decorator (@localTo) and buildless
// (spec.locals) paths. eq defaults to Object.is (0014 read law). initFn is null for
// the decorator path (the box is born at field-init time, like a decorator signal)
// and a per-instance factory for the buildless path (born in wireInstance).
function makeLocalRec(key, slot, seenSlot, source, opts, initFn, hasInitial) {
    const eq = opts !== undefined && opts.equals !== undefined ? opts.equals : Object.is;
    const rec = {
        kind: "local",
        key,
        slot,
        seenSlot,
        source,
        eq,
        opts,
        get: null,
        set: null,
        fn: null,
        plan: null,
        poison: null,
        prewired: null,
        parked: null,
        initFn,
        hasInitial,
    };
    rec.get = makeLocalGet(rec);
    rec.set = makeLocalSet(rec);
    return rec;
}

// S8 (cold): the decorator @localTo init -- mirrors makeInit. The box + seen are
// born during super()'s field initialization; the box joins the SCRATCH frame for
// init-phase rollback. The field-initial value is captured per member (undefined
// means "no initializer" -> the @localCopy reset flavor) for reinit.
function makeLocalInit(rec) {
    return function (v) {
        if (rec.plan === null) throwMissingHost(rec);
        const box = seedLocal(this, rec, rec.plan.reg, v !== undefined, v);
        SCRATCH.push(box);                     // D-2h: track for init-phase rollback
        if (!LOCAL_INITIAL.has(rec)) LOCAL_INITIAL.set(rec, v);
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

function validateLocalOptions(opts) {
    // localTo's OWN key set (equals only) -- NOT the shared reactive/derived
    // validator: admitting `source` there would silently accept @derived({source})
    // (fail-open, PLAN-S8 spelling call). Returns a frozen { equals } or undefined.
    if (opts === undefined || opts === null) return undefined;
    if (typeof opts !== "object") throwUsage("localTo");
    const keys = Object.keys(opts);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== "equals") throwUnknownOption("localTo", keys[i], LOCAL_OPTION_KEYS);
    }
    if ("equals" in opts && opts.equals !== undefined && typeof opts.equals !== "function") throwBadEquals("localTo");
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
        parked: null,
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

// --- localTo (S8, 0014) -------------------------------------------------------

function applyLocalTo(target, ctx, source, opts) {
    if (!isStandardContext(ctx)) throwLegacyEmit("localTo");
    if (ctx.kind !== "accessor") {
        throwWrongKind("localTo", "accessor", ctx.kind, "write `@localTo(source) accessor x = ...`.");
    }
    if (ctx.static === true) throwStatic("localTo", ctx.name);
    if (ctx.private === true) throwPrivate("localTo", ctx.name);
    const nm = typeof ctx.name === "symbol" ? "local" : "local:" + String(ctx.name);
    const rec = makeLocalRec(ctx.name, Symbol(nm), Symbol(nm + ":seen"), source, opts, null, false);
    PENDING.push(rec);
    return { get: rec.get, set: rec.set, init: makeLocalInit(rec) };
}

/**
 * `@localTo(source) accessor x = v` -- upstream-keyed resettable local state
 * (0014). Reads compare the tracked `source(self)` against a per-instance
 * last-seen slot: an unchanged upstream yields the local override, a changed
 * upstream resets to it. A write always overrides. With an initializer the member
 * STARTS there and resets on the first upstream move; without one it FOLLOWS
 * upstream from wiring. `@localTo(source)` or `@localTo(source, { equals })` --
 * `equals` governs the upstream compare ONLY. `source` is REQUIRED.
 */
export function localTo(source, options) {
    if (typeof source !== "function") throwLocalSource();
    const opts = validateLocalOptions(options);
    return function (t, c) { return applyLocalTo(t, c, source, opts); };
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
        parked: null,
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
    const msg = rec.kind === "signal" || rec.kind === "local"
        ? `${ERR}${ctorName}.${keyLabel(key)} read/write before its initializer ran (declaration order).`
        : `${ERR}${ctorName}.${keyLabel(key)} read before construction completed (deriveds are available after wiring).`;
    rec.prewired = Object.freeze({
        [NONLIVE]: "prewired",
        get() { throw new TypeError(msg); },
        set(v) { throw new TypeError(msg); },
    });
    // PD-44: parked handle -- swapped into every slot at releaseReactive(). A
    // touch on a pooled instance throws a parked-specific ReactiveDisposedError
    // (naming Class.prop) so a use-after-release reads differently from a
    // use-after-dispose. Frozen, NONLIVE-tagged so disposeCore skips it.
    rec.parked = Object.freeze({
        [NONLIVE]: "parked",
        get() { throw new ReactiveDisposedError(ctorName, key, true); },
        set(v) { throw new ReactiveDisposedError(ctorName, key, true); },
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
    const locals = [];
    const deriveds = [];
    const effects = [];
    const byKey = new Map();
    if (ancestor !== undefined) {
        for (let i = 0; i < ancestor.signals.length; i++) {
            const r = ancestor.signals[i];
            signals.push(r);
            byKey.set(r.key, r);
        }
        // PD-55: locals live in their OWN array; L is a first-class accounting term.
        for (let i = 0; i < ancestor.locals.length; i++) {
            const r = ancestor.locals[i];
            locals.push(r);
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
        if (rec.kind === "signal" || rec.kind === "derived" || rec.kind === "local") {
            installed = desc !== undefined && desc.get === rec.get;
        } else {
            installed = desc !== undefined && desc.value === rec.pub;
        }
        if (!installed) orphans.push(keyLabel(rec.key));
    }
    if (orphans.length > 0) throwOrphans(ctorName, orphans);

    for (let i = 0; i < own.length; i++) {
        const rec = own[i];
        if (rec.kind === "signal" || rec.kind === "derived" || rec.kind === "local") buildHandles(rec, ctorName);
        if (rec.kind === "signal") signals.push(rec);
        else if (rec.kind === "local") locals.push(rec);
        else if (rec.kind === "derived") deriveds.push(rec);
        else if (rec.kind === "effect") effects.push(rec);
        // batched recs join byKey only (no node) for reg resolution + diagnostics.
        byKey.set(rec.key, rec);
    }

    const plan = {
        ctorName,
        reg,
        signals: Object.freeze(signals),
        locals: Object.freeze(locals),
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

// PD-42: build the per-instance closure set -- the createRoot thunk, the anchor
// effect body (writes the owner straight into inst[ANCHOR]), the runWithOwner
// thunk (rebuilds deriveds + effects), one body per derived, one per effect. The
// engine retains nothing of a disposed registration (0010 Q3), so these exact
// closure objects re-register on every acquire (buildGraph) with zero new
// allocation. Built LAZILY at first releaseReactive and retained on the instance,
// so a reused instance amortizes the closure cost to zero across acquire/release
// cycles -- while a construct-once/dispose-once instance never allocates it (0011:
// building it at first wiring measured 140 / 1 major GC in churn-soak, both over
// the maxMajor-0 floor; the construct path stays byte-identical to 1.0.0). Cold.
function prebuildClosures(inst, plan) {
    const reg = plan.reg;
    const ders = plan.deriveds;
    const effs = plan.effects;
    const derivedBodies = new Array(ders.length);
    for (let i = 0; i < ders.length; i++) derivedBodies[i] = makeDerivedBody(inst, ders[i].fn);
    const effectBodies = new Array(effs.length);
    for (let i = 0; i < effs.length; i++) effectBodies[i] = makeEffectBody(inst, effs[i].fn);
    const anchorBody = function () { inst[ANCHOR] = reg.getOwner(); };
    const bundle = {
        createRootThunk: function () { reg.effect(anchorBody); },
        runOwnerThunk: null,
        derivedBodies,
        effectBodies,
    };
    // The runWithOwner thunk carries the SAME OFF/ON introspection branch the
    // 1.0.0 wireInstance carried; the flags are read at CALL time, so a prebuilt
    // closure honors a later enableLabels()/auditReactive() exactly as before.
    // Effects wire AFTER every derived (D-4a): the first synchronous run sees
    // every field and every derived. Dispose handles are DISCARDED -- teardown is
    // the anchor cascade.
    bundle.runOwnerThunk = function () {
        for (let i = 0; i < ders.length; i++) {
            inst[ders[i].slot] = reg.computedBox(derivedBodies[i], ders[i].opts);
        }
        if (INTROSPECT_ON) {
            const effHandles = LABELS_ON ? [] : null;
            for (let i = 0; i < effs.length; i++) {
                const h = reg.effect(effectBodies[i], effs[i].opts);
                if (effHandles !== null) effHandles.push(h);
            }
            introspectWire(inst, plan, reg, effHandles);
        } else {
            for (let i = 0; i < effs.length; i++) {
                reg.effect(effectBodies[i], effs[i].opts);
            }
        }
    };
    return bundle;
}

// The node-building body invoked by reinit (S6-T2): build the R-A anchor, then the
// deriveds + effects under it, all through a PREBUILT closure set. Signal boxes
// are NOT built here -- reinit creates them first (all boxes, with reset values) --
// because the value source differs between construction and reinit while the
// anchor/derived/effect build is identical. wireInstance keeps its own inline node
// build (below) so the construct-once path allocates exactly as 1.0.0 did (0011).
function buildGraph(inst, plan, closures) {
    const reg = plan.reg;
    reg.createRoot(closures.createRootThunk);          // R-A anchor -> inst[ANCHOR]
    reg.runWithOwner(inst[ANCHOR], closures.runOwnerThunk);
}

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
        // Buildless locals: seed box + seen in spec order BEFORE the anchor.
        // Decorator locals already exist from field-init time (initFn === null).
        const locs = plan.locals;
        for (let i = 0; i < locs.length; i++) {
            const r = locs[i];
            if (r.initFn !== null) seedLocal(inst, r, reg, r.hasInitial, r.initFn(inst));
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
    // PARKED holds no live anchor node (releaseReactive already cascaded it), so a
    // dispose-on-parked must NOT re-dispose the sentinel -- it only swaps the
    // parked handles to poison below and lands the instance DISPOSED.
    if (a !== undefined && a !== DISPOSED && a !== PARKED) reg.dispose(a); // cascades deriveds + effects
    const sigs = plan.signals;
    for (let i = 0; i < sigs.length; i++) {
        const r = sigs[i];
        const box = inst[r.slot];
        if (box !== undefined && box[NONLIVE] === undefined) reg.dispose(box);
        inst[r.slot] = r.poison;
    }
    // S8: locals dispose exactly like signals -- dispose the box, poison the box
    // slot (a touch throws the named ReactiveDisposedError, 0014 dispose lattice).
    // The seen slot is a plain field; it is left as-is (the poisoned box guards it).
    const locs = plan.locals;
    for (let i = 0; i < locs.length; i++) {
        const r = locs[i];
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
    // S8: a local's box slot gets the same prewired guard (the seen slot is a
    // plain field, undefined until init -- no proto guard needed).
    for (let i = 0; i < plan.locals.length; i++) {
        const r = plan.locals[i];
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
        parked: null,
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

// S8/PD-57: the buildless `locals` section -- { key: { source, equals?, initial? } }.
// Fail closed on a missing/non-fn source (a local without a source is meaningless).
// An `initial` present selects the @trackedReset flavor; absent, the @localCopy
// flavor (initFn returns undefined, hasInitial false -> seedLocal reads upstream).
function normalizeLocalEntry(key, entry) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throwLocalSourceNotFn(key);
    const dkeys = Reflect.ownKeys(entry);
    for (let i = 0; i < dkeys.length; i++) {
        const dk = dkeys[i];
        if (dk !== "source" && dk !== "equals" && dk !== "initial") throwUnknownLocalDescKey(key, dk);
    }
    const source = entry.source;
    if (typeof source !== "function") throwLocalSourceNotFn(key);
    const opts = normalizeEquals(entry, `defineReactive local ${keyLabel(key)}`);
    const hasInitial = Object.prototype.hasOwnProperty.call(entry, "initial");
    const initial = hasInitial ? entry.initial : undefined;
    const initFn = function () { return initial; };
    const slot = Symbol(typeof key === "symbol" ? "local" : "local:" + String(key));
    const seenSlot = Symbol(typeof key === "symbol" ? "local:seen" : "local:" + String(key) + ":seen");
    return makeLocalRec(key, slot, seenSlot, source, opts, initFn, hasInitial);
}

function normalizeLocals(spec, recs) {
    const l = spec.locals;
    if (l === undefined) return;
    if (l === null || typeof l !== "object" || Array.isArray(l)) throwSpecLocals();
    const keys = Reflect.ownKeys(l);
    for (let i = 0; i < keys.length; i++) {
        recs.push(normalizeLocalEntry(keys[i], l[keys[i]]));
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
        parked: null,
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
    } else if (rec.kind === "local") {
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
        if (k !== "signals" && k !== "locals" && k !== "deriveds" && k !== "effects" && k !== "host") {
            throwUnknownSection(k);
        }
    }

    const recs = [];
    normalizeSignals(spec, recs);              // signals first (spec/wire order)
    normalizeLocals(spec, recs);               // locals second (PD-57)
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

// --- Pooled lifecycle: release + reinit (S6-T3, PD-42(b)/PD-44) ---------------

// The cold inverse of buildGraph: tear the graph down to the engine pool exactly
// as disposeCore does (anchor cascade + per-box dispose) but swap every slot to
// its per-class PARKED handle (not poison), keep the prebuilt CLOSURES slot, and
// set ANCHOR to the PARKED sentinel. A parked instance holds ZERO engine nodes.
function releaseCore(inst, plan) {             // assumes a LIVE instance
    const reg = plan.reg;
    const a = inst[ANCHOR];
    if (a !== undefined && a !== DISPOSED && a !== PARKED) reg.dispose(a); // cascades deriveds + effects
    const sigs = plan.signals;
    for (let i = 0; i < sigs.length; i++) {
        const r = sigs[i];
        const box = inst[r.slot];
        if (box !== undefined && box[NONLIVE] === undefined) reg.dispose(box);
        inst[r.slot] = r.parked;
    }
    // S8: a parked local releases its box node (swap the box slot to the parked
    // handle) but RETAINS the seen slot as a plain record field (0014 park lattice);
    // reinit re-creates the box and resets both (PD-58).
    const locs = plan.locals;
    for (let i = 0; i < locs.length; i++) {
        const r = locs[i];
        const box = inst[r.slot];
        if (box !== undefined && box[NONLIVE] === undefined) reg.dispose(box);
        inst[r.slot] = r.parked;
    }
    const ders = plan.deriveds;
    for (let i = 0; i < ders.length; i++) {
        inst[ders[i].slot] = ders[i].parked;   // cboxes already cascaded
    }
    inst[ANCHOR] = PARKED;
}

/**
 * Release a live reactive instance to the engine pool: cascade its anchor,
 * dispose each signal box, and swap every slot to a PARKED handle that throws a
 * parked-specific `ReactiveDisposedError` on touch. The instance keeps its
 * prebuilt wiring closures so `reinitReactive(vm)` can revive it with zero new
 * closure allocation. Idempotent on an already-parked instance (returns `false`,
 * mirroring `disposeReactive`'s double-dispose contract); returns `true` on the
 * first successful release. Fails closed (named throw) on a non-reactive value, an
 * unwired instance, a frozen instance, or a terminally-disposed one -- a disposed
 * instance is gone and cannot be pooled (0011).
 */
export function releaseReactive(vm) {
    const plan = planOf(vm);
    if (plan === undefined) throwNoPlan("releaseReactive");
    const a = vm[ANCHOR];
    if (a === PARKED) return false;            // idempotent park->park (0011)
    if (a === DISPOSED) throwReleaseDisposed(plan.ctorName);
    if (a === undefined) throwNotWired("releaseReactive");
    if (Object.isFrozen(vm)) throwReleaseFrozen(plan.ctorName);
    const reg = plan.reg;
    // Same re-entrancy guard disposeReactive carries (D-2f): releasing from inside
    // one of this instance's OWN @derived computations would cascade the very node
    // being computed (fail-open). The isTracking() gate keeps the plain-code path
    // zero-alloc; only under tracking do we pay one getOwner() descriptor.
    if (reg.isTracking()) {
        const cur = reg.getOwner();
        if (cur !== undefined) {
            const ders = plan.deriveds;
            for (let i = 0; i < ders.length; i++) {
                const h = vm[ders[i].slot];
                if (h !== undefined && h[NONLIVE] === undefined && reg.nodeId(h) === cur.id) {
                    throwSelfDisposeInDerived(plan.ctorName, ders[i].key, "releaseReactive");
                }
            }
        }
    }
    if (INTROSPECT_ON) introspectDispose(vm, reg);
    // Retain the prebuilt closure set on first release (reuse intent now known):
    // every later reinit re-registers these exact closures with zero new
    // allocation (0010 Q3), amortizing the cost to zero across acquire/release.
    if (vm[CLOSURES] === undefined) vm[CLOSURES] = prebuildClosures(vm, plan);
    releaseCore(vm, plan);
    return true;
}

/**
 * Revive a PARKED reactive instance: rebuild its signal boxes (with `initials`'
 * values where given, else the plan's initials), rebuild the anchor, deriveds,
 * and effects through the PREBUILT closures, and restore every slot to a live
 * handle. Atomicity is identical to construction -- any throw mid-reinit routes
 * through disposeCore, leaving conservation exact and the instance terminally
 * DISPOSED (a failed revival is final; fail closed). Returns the same `vm`.
 * Requires PARKED: fails closed (named throw) on a live, disposed, frozen,
 * unwired, or non-reactive value -- null is not zero.
 */
export function reinitReactive(vm, initials) {
    const plan = planOf(vm);
    if (plan === undefined) throwNoPlan("reinitReactive");
    const a = vm[ANCHOR];
    if (a === DISPOSED) throwReinitDisposed(plan.ctorName);
    if (a === undefined) throwNotWired("reinitReactive");
    if (a !== PARKED) throwReinitLive(plan.ctorName);      // a live anchor node
    if (Object.isFrozen(vm)) throwReinitFrozen(plan.ctorName);
    if (initials !== undefined) {
        if (initials === null || typeof initials !== "object") throwReinitInitials(plan.ctorName);
        const ikeys = Reflect.ownKeys(initials);
        for (let i = 0; i < ikeys.length; i++) {
            const rec = plan.byKey.get(ikeys[i]);
            // PD-58: initials[] accepts @reactive signal keys AND @localTo keys.
            if (rec === undefined || (rec.kind !== "signal" && rec.kind !== "local")) {
                throwReinitInitialsKey(plan.ctorName, ikeys[i], plan);
            }
        }
    }
    const reg = plan.reg;
    const closures = vm[CLOSURES];
    try {
        // Rebuild every signal box with its reset value: caller override first,
        // then the buildless plan initFn, then the decorator field-initial captured
        // per member in makeInit. Boxes rebuild BEFORE buildGraph so deriveds and
        // effects see them on the first synchronous run (D-4a), same as construction.
        const sigs = plan.signals;
        for (let i = 0; i < sigs.length; i++) {
            const r = sigs[i];
            let v;
            if (initials !== undefined && Object.prototype.hasOwnProperty.call(initials, r.key)) {
                v = initials[r.key];
            } else if (r.initFn !== null) {
                v = r.initFn(vm);
            } else {
                v = SIG_INITIAL.get(r);
            }
            vm[r.slot] = reg.signalBox(v, r.opts);
        }
        // PD-58: each local resets its box -> initial AND its seen slot -> the
        // CURRENT upstream (seedLocal reads source untracked). Precedence mirrors
        // the signal loop: caller override, then the buildless plan initFn (with its
        // hasInitial flag), then the decorator field-initial captured in
        // makeLocalInit (undefined -> the @localCopy flavor: reseed the box from
        // the current upstream). Locals rebuild BEFORE buildGraph so deriveds/effects
        // see them on the first synchronous run (D-4a), same as construction.
        const locs = plan.locals;
        for (let i = 0; i < locs.length; i++) {
            const r = locs[i];
            let hasInitial;
            let v;
            if (initials !== undefined && Object.prototype.hasOwnProperty.call(initials, r.key)) {
                hasInitial = true;
                v = initials[r.key];
            } else if (r.initFn !== null) {
                hasInitial = r.hasInitial;
                v = r.initFn(vm);
            } else {
                v = LOCAL_INITIAL.get(r);
                hasInitial = v !== undefined;
            }
            seedLocal(vm, r, reg, hasInitial, v);
        }
        buildGraph(vm, plan, closures);
    } catch (e) {
        disposeCore(vm, plan);                 // failed revival is terminal -> DISPOSED
        throw e;
    }
    return vm;
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
    if (nl === "parked") throw new ReactiveDisposedError(plan.ctorName, key, true);
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
    if (a === PARKED) throw new ReactiveDisposedError(plan.ctorName, "<root>", true);
    return a;
}

// --- Reactive walk & snapshot (S9; cold / opt-in) -----------------------------

// Hoisted kind literals -- passed by forEachReactive so a walk carries zero
// per-visit bytes beyond its four scalar args (no per-member string allocation).
const KIND_SIGNAL = "signal";
const KIND_LOCAL = "local";
const KIND_DERIVED = "derived";

function throwForEachFn() {
    throw new TypeError(
        `${ERR}forEachReactive(vm, fn) -- fn must be a function; it is called fn(key, box, kind, arg) once per reactive member.`,
    );
}

/**
 * Visit every value-bearing reactive member of `vm` in PLAN order -- all signals,
 * then all @localTo locals, then all deriveds; each group declaration-ordered and
 * ancestor-first -- invoking `fn(key, box, kind, arg)` per member and returning
 * the visit count. `box` is the live SignalBox/ComputedBox (exactly what boxOf
 * returns); `kind` is the literal "signal" | "local" | "derived". @reactiveEffect
 * and @batched members are EXCLUDED (non-value-bearing; boxOf refuses them). The
 * `arg` pass-through threads caller state without a closure, so the walk is
 * zero-allocation per call and per visit.
 *
 * @throws {TypeError} if `fn` is not a function.
 * @throws {ReactiveDisposedError} if the instance was disposed or parked.
 * @throws if `vm` is not wired yet, or is not a reactive instance.
 */
export function forEachReactive(vm, fn, arg) {
    if (typeof fn !== "function") throwForEachFn();
    const plan = planOf(vm);
    if (plan === undefined) throwNoPlan("forEachReactive");
    const a = vm[ANCHOR];
    if (a === undefined) throwNotWired("forEachReactive");
    if (a === DISPOSED) throw new ReactiveDisposedError(plan.ctorName, "<root>");
    if (a === PARKED) throw new ReactiveDisposedError(plan.ctorName, "<root>", true);
    let n = 0;
    const sigs = plan.signals;
    for (let i = 0; i < sigs.length; i++) {
        const r = sigs[i];
        const h = vm[r.slot];
        if (h !== undefined && h[NONLIVE] === "prewired") throwPrewiredMember(plan.ctorName, r.key);
        fn(r.key, h, KIND_SIGNAL, arg);
        n++;
    }
    const locs = plan.locals;
    for (let i = 0; i < locs.length; i++) {
        const r = locs[i];
        const h = vm[r.slot];
        if (h !== undefined && h[NONLIVE] === "prewired") throwPrewiredMember(plan.ctorName, r.key);
        fn(r.key, h, KIND_LOCAL, arg);
        n++;
    }
    const ders = plan.deriveds;
    for (let i = 0; i < ders.length; i++) {
        const r = ders[i];
        const h = vm[r.slot];
        if (h !== undefined && h[NONLIVE] === "prewired") throwPrewiredMember(plan.ctorName, r.key);
        fn(r.key, h, KIND_DERIVED, arg);
        n++;
    }
    return n;
}

// snapshotOf's per-member visitor -- the forEachReactive walk contract
// (key, box, kind, arg). snapshotOf IS forEachReactive's named in-package
// consumer: the fill is ROUTED through the walk (0009 candidate 2 / 0013 (c)
// admission ground), not a private duplicate. The carrier `arg` threads both the
// instance and the output object so the visitor stays a hoisted, closure-free
// function. The read is the ACCESSOR vm[key] (PD-62), NOT box.get -- so @localTo
// compare-on-read and derived compute stay honest; `box`/`kind` are unused here,
// which the walk contract permits (a consumer reads only the fields it needs).
function snapshotVisit(key, box, kind, arg) {
    arg.out[key] = arg.vm[key];
}

/**
 * Return a plain `{}` snapshot of every value-bearing reactive member of `vm` --
 * signals, @localTo locals, and deriveds -- keyed by member key (symbol keys
 * included), each value read through the ACCESSOR `vm[key]` (so @localTo
 * compare-on-read and derived compute stay honest). SHALLOW by design: a nested
 * reactive VM is copied by reference, never recursed. The whole read pass runs
 * under ONE untrack thunk when a tracking scope is active (the makeLocalSet
 * idiom), so calling snapshotOf inside an effect does NOT subscribe the effect to
 * every member. The returned object allocates by design -- this is a cold
 * introspection call, never a gated hot path.
 *
 * @throws {ReactiveDisposedError} if the instance was disposed or parked.
 * @throws if `vm` is not wired yet, or is not a reactive instance.
 */
export function snapshotOf(vm) {
    const plan = planOf(vm);
    if (plan === undefined) throwNoPlan("snapshotOf");
    const a = vm[ANCHOR];
    if (a === undefined) throwNotWired("snapshotOf");
    if (a === DISPOSED) throw new ReactiveDisposedError(plan.ctorName, "<root>");
    if (a === PARKED) throw new ReactiveDisposedError(plan.ctorName, "<root>", true);
    const out = {};
    const carrier = { vm, out };                 // allocates by design (cold call)
    const reg = plan.reg;
    if (reg.isTracking()) reg.untrack(() => forEachReactive(vm, snapshotVisit, carrier));
    else forEachReactive(vm, snapshotVisit, carrier);
    return out;
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
        `${ERR}costOf(${name}) -- probed node count ${got} != P+L+D+E+1 (${want}); the bound registry was not quiet during the probe.`,
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
 * Returns a frozen `{ nodes, links, signals, locals, deriveds, effects }`;
 * `nodes` equals P+L+D+E+1. Cached per class. Throws (never guesses) on an
 * inconclusive or polluted probe. Constructs the probe instance with no arguments.
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
    const loc = plan.locals.length;
    const der = plan.deriveds.length;
    const eff = plan.effects.length;
    // S8: each @localTo member is exactly 1 box node (its seen slot is a plain
    // field, 0 nodes), so the node formula is P + L + D + E + 1 (0014 cost law).
    const expected = sig + loc + der + eff + 1;
    if (first.nodes !== expected) throwCostNodeMismatch(plan.ctorName, first.nodes, expected);
    const result = Object.freeze({
        nodes: first.nodes,
        links: first.links,
        signals: sig,
        locals: loc,
        deriveds: der,
        effects: eff,
    });
    COST_CACHE.set(Factory, result);
    return result;
}

// Module-level walk accumulators for costOfInstance. forEachOwned/forEachSource
// call fn(descriptor) with NO carrier arg, so the visitor cannot thread state
// through a parameter the way forEachReactive's `arg` does. Reusing three module
// slots (never a per-call closure) keeps the frozen result the ONLY allocation
// (PD-69). Non-reentrant by construction: a cost walk never re-enters
// costOfInstance, so the single-threaded ESM model makes the shared slots safe.
let COST_INSTANCE_REG = null;
let COST_INSTANCE_OWNED = 0;
let COST_INSTANCE_LINKS = 0;

// Tally one source edge (called per forEachSource visit across anchor, owned
// nodes, and signal/local boxes).
function costInstanceLinkVisit(node) {
    COST_INSTANCE_LINKS++;
}

// Tally one owned node (a derived or user effect adopted by the anchor) and fold
// its source edges into the link total in the same pass.
function costInstanceOwnedVisit(node) {
    COST_INSTANCE_OWNED++;
    COST_INSTANCE_REG.forEachSource(node, costInstanceLinkVisit);
}

/**
 * Measure the cost of ONE live, wired instance right now -- no probe, no
 * construction, no ctor args, no registry pollution. Returns a per-call frozen
 * `{ nodes, links, signals, locals, deriveds, effects }` in costOf's exact shape.
 * `nodes` is WALKED: 1 (the anchor) + plan.signals.length + plan.locals.length +
 * every child forEachOwned(rootOf(vm)) yields (the deriveds and user effects the
 * anchor adopted -- signal/local boxes are built pre-anchor and unadopted, so
 * they are never owned). `links` is the sum of forEachSource over the anchor,
 * every owned node, and every signal/local box, WITHOUT dedupe -- one edge per
 * observer, matching costOf's activeLinks delta. Kind counts are read from the
 * plan arrays, never walked.
 *
 * THE LIVE-VS-PROBE CONTRACT. This number is the truth NOW. costOf constructs a
 * throwaway probe and FORCES every derived (:2079) to report the constructed
 * CEILING -- "what will an instance of this class cost". costOfInstance reports
 * what THIS instance costs at this moment: an unforced lazy derived and an
 * untaken dynamic branch have formed no links yet, so `links` reads BELOW
 * costOf's for the same shape until the graph is exercised. `nodes` matches
 * regardless (owned children exist whether or not their links have formed). Read
 * every derived once and the two agree exactly (A1 parity). The delta is the
 * feature, not a bug -- fewer links means the instance has not paid for a branch
 * it has not taken.
 *
 * ALLOCATION HONESTY. The frozen result allocates by design, one object per call,
 * exactly like snapshotOf -- this is a cold introspection call, never a gated hot
 * path (PD-69). There is no out-param variant; no consumer needs one. The walk
 * itself allocates nothing (module-slot visitors, no per-call closure).
 *
 * UNCACHED (PD-70). costOf caches per class because a class shape is frozen at
 * decoration; a live instance graph MUTATES (a derived forces, a branch flips),
 * so a cached number would lie. Every call re-walks.
 *
 * WORKS WHERE costOf CANNOT (PD-72). The walk needs no stats() ledger, so
 * costOfInstance measures an instance on a hand-rolled registry that carries the
 * introspection walkers but not stats -- exactly the case costOf fails closed on
 * (:2049).
 *
 * @throws {ReactiveDisposedError} if the instance was disposed or parked -- a
 *   parked vm holds ZERO nodes, and a silent `{ nodes: 0 }` is indistinguishable
 *   from a bug, so both states fail closed (PD-71).
 * @throws if `vm` is not wired yet, has no reactive plan, or exposes a prewired
 *   member slot.
 */
export function costOfInstance(vm) {
    const plan = planOf(vm);
    if (plan === undefined) throwNoPlan("costOfInstance");
    const a = vm[ANCHOR];
    if (a === undefined) throwNotWired("costOfInstance");
    if (a === DISPOSED) throw new ReactiveDisposedError(plan.ctorName, "<root>");
    if (a === PARKED) throw new ReactiveDisposedError(plan.ctorName, "<root>", true);
    const reg = plan.reg;
    COST_INSTANCE_REG = reg;
    COST_INSTANCE_OWNED = 0;
    COST_INSTANCE_LINKS = 0;
    // Owned nodes = deriveds + user effects the anchor adopted; each contributes
    // its source edges to the link tally as it is visited. Signals/locals are
    // built pre-anchor (unadopted), so forEachOwned never yields them (:1234-1248).
    reg.forEachOwned(a, costInstanceOwnedVisit);
    // The anchor's own source edges.
    reg.forEachSource(a, costInstanceLinkVisit);
    // Signal + local boxes are not owned -- read each from its slot (the walker
    // idiom from forEachReactive) and fold its source edges in. A prewired slot
    // is impossible past the wired guard above, but the check fails closed if a
    // partially-built instance is ever measured.
    const sigs = plan.signals;
    for (let i = 0; i < sigs.length; i++) {
        const h = vm[sigs[i].slot];
        if (h !== undefined && h[NONLIVE] === "prewired") throwPrewiredMember(plan.ctorName, sigs[i].key);
        reg.forEachSource(h, costInstanceLinkVisit);
    }
    const locs = plan.locals;
    for (let i = 0; i < locs.length; i++) {
        const h = vm[locs[i].slot];
        if (h !== undefined && h[NONLIVE] === "prewired") throwPrewiredMember(plan.ctorName, locs[i].key);
        reg.forEachSource(h, costInstanceLinkVisit);
    }
    const sig = sigs.length;
    const loc = locs.length;
    const der = plan.deriveds.length;
    const eff = plan.effects.length;
    const nodes = 1 + sig + loc + COST_INSTANCE_OWNED;
    const links = COST_INSTANCE_LINKS;
    COST_INSTANCE_REG = null;                    // drop the registry ref (cold)
    return Object.freeze({
        nodes: nodes,
        links: links,
        signals: sig,
        locals: loc,
        deriveds: der,
        effects: eff,
    });
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

// --- createFleet (S11; the fleet helper over the shipped primitives) ----------
//
// The flagship-audience helper (0013 (d)): capacityFor -> createRegistry -> bind
// -> EAGER-prefill N parked members over a slot array + an Int32Array free-list.
// The demo's hand-rolled pool (loop.ts) is the extracted spec, so acquire/release
// are the extracted spawn/kill: reinitReactive/releaseReactive with zero-alloc
// bookkeeping. Cold construction; the hot acquire/release/at bodies are prebuilt
// closures over the fleet's arrays (zero allocation, fail-closed guards only).
//
// SLOT STAMP (PD-77 forcing condition resolved): ownership is proven by a
// per-fleet Symbol stamped onto each vm at prefill carrying its slot index -- a
// plain (symbol-keyed) integer field, NOT a WeakMap. A field read is one property
// load (zero allocation, monomorphic); a WeakMap.get is a slower hash probe AND
// retains a parallel table for the fleet's lifetime. The stamp is minted per
// fleet, so a foreign vm (no stamp, or another fleet's stamp) reads `undefined`
// for THIS fleet's symbol and fails closed. slots[i] === vm re-confirms identity;
// releaseReactive() returning false (already parked) is the double-release check.

function throwFleetBind() {
    throw new TypeError(
        `${ERR}createFleet(inventory, bind, opts?) -- bind must be a function (registry) -> BoundClass.`,
    );
}

function throwFleetBindReturn() {
    throw new TypeError(
        `${ERR}createFleet -- bind(registry) must return the bound class (a constructor); the fleet constructs its members from it.`,
    );
}

function throwFleetExhausted(ctorName, capacity) {
    // Named so a caller can catch the capacity ceiling distinctly. The registry's
    // own CapacityError is unreachable (all N are prealloc'd), so this pre-check
    // is the ONLY exhaustion signal.
    const e = new Error(
        `${ERR}fleet<${ctorName}> is exhausted -- all ${capacity} members are live. release() one before acquire(), or size the fleet larger; capacity is fixed at construction (eager prefill).`,
    );
    e.name = "FleetExhaustedError";
    throw e;
}

function throwFleetForeign(ctorName) {
    const e = new Error(
        `${ERR}release(vm) -- vm was not acquired from this fleet<${ctorName}> (no matching slot stamp). Release only members this fleet handed out.`,
    );
    e.name = "FleetForeignMemberError";
    throw e;
}

function throwFleetDoubleRelease(ctorName) {
    const e = new Error(
        `${ERR}release(vm) -- vm is already parked in fleet<${ctorName}> (double release). Each acquire() pairs with exactly one release().`,
    );
    e.name = "FleetDoubleReleaseError";
    throw e;
}

function throwFleetDead(ctorName, op) {
    const e = new Error(
        `${ERR}${op}() -- fleet<${ctorName}> was disposed; its members are torn down and its registry is destroyed. Construct a new fleet.`,
    );
    e.name = "FleetDisposedError";
    throw e;
}

function throwFleetRange(ctorName, i, capacity) {
    throw new RangeError(
        `${ERR}at(${String(i)}) -- index out of bounds for fleet<${ctorName}> [0, ${capacity}).`,
    );
}

/**
 * Build a fixed-capacity fleet of reactive instances over the shipped primitives.
 * COLD construction sizes a registry from `inventory` (capacityFor), builds it
 * (createRegistry), hands it to `bind(registry)` so the caller binds its decorated
 * class to that registry and returns it, then EAGER-constructs and PARKS one
 * member per inventory unit (PD-75: acquire never constructs). Returns a Fleet
 * handle `{ registry, Class, capacity, acquire, release, at, size, stats,
 * dispose }`.
 *
 * HOT: `acquire(initials?)` pops the free-list and reinitReactive()s a parked
 * member (throws `FleetExhaustedError` at capacity); `release(vm)` validates the
 * slot stamp, releaseReactive()s the member back to the pool (throws on a foreign
 * vm or a double release), and pushes its slot. `at(i)` is a bounds-checked
 * slot read; `size()` is the live count; `stats()` passes the registry ledger
 * through. Both hot bodies allocate nothing.
 *
 * `dispose()` disposes every member (live AND parked -> DISPOSED), destroys the
 * fleet-owned registry, and marks the fleet dead; every later call fails closed
 * with a named throw. Construction is atomic: any mid-prefill throw disposes the
 * already-built members and destroys the registry before rethrowing (fail closed).
 *
 * @throws {TypeError} if `bind` is not a function or does not return a constructor.
 * @throws if `inventory`/`opts` are invalid (via capacityFor's fail-closed checks).
 */
export function createFleet(inventory, bind, opts) {
    if (typeof bind !== "function") throwFleetBind();
    // capacityFor validates inventory + opts (unknown-key did-you-mean, headroom)
    // and returns the eager/throw config; reuse its fail-closed checks wholesale.
    const config = capacityFor(inventory, opts);
    // Total prefill count = the sum of the inventory units (each pair[1] is a
    // validated positive integer by the time capacityFor returned).
    let capacity = 0;
    for (let i = 0; i < inventory.length; i++) capacity += inventory[i][1];

    // The fleet OWNS this registry (dispose() destroys it). Any throw from here
    // on routes through the atomic-cleanup catch below.
    const registry = createRegistry(config);
    const STAMP = Symbol("lite-signal-decorators.fleet");
    const slots = new Array(capacity);
    const free = new Int32Array(capacity);      // free-list: free[0..freeTop) = idle slots
    let Class;
    let ctorName;
    let built = 0;
    try {
        Class = bind(registry);
        if (typeof Class !== "function") throwFleetBindReturn();
        ctorName = Class.name || "fleet";
        for (let i = 0; i < capacity; i++) {
            const vm = new Class();             // eager construct on the fleet's registry
            vm[STAMP] = i;                      // slot stamp: ownership + slot index
            releaseReactive(vm);                // park it (PD-75); nodes return to pool
            slots[i] = vm;
            free[i] = i;
            built = i + 1;
        }
    } catch (e) {
        for (let j = 0; j < built; j++) disposeReactive(slots[j]);
        registry.destroy();                     // tear the fleet-owned registry down
        throw e;                                // atomic: nothing half-built survives
    }

    let freeTop = capacity;                     // all slots idle (all parked)
    let dead = false;

    // HOT: revive the head parked slot. reinitReactive resets its boxes to
    // `initials` (undefined = the plan's reset values) with zero closure alloc.
    // ORDERING (mirrors fleetRelease): PEEK the candidate via free[freeTop-1],
    // run the FALLIBLE reinit FIRST, and decrement freeTop only AFTER it succeeds.
    // reinit throws named on bad initials (e.g. acquire({typo:1})) and on an
    // out-of-band-disposed member; decrementing before it would strand the popped
    // slot above freeTop -- lost capacity, over-reported size(). Fail closed:
    // freeTop moves only on success, so a rejected acquire leaves the slot
    // acquirable. (a) The disposed case: a member disposed out of band via at()
    // wedges at the free-list head -- every acquire rethrows reinit's named
    // "disposed (terminal)" error, refusing loudly rather than eroding capacity
    // silently. Left as (a) not (b): reinit's disposed and bad-initials throws are
    // both plain Errors with no distinct code/class, so dropping only the disposed
    // slot would need brittle message-matching -- a fail-open hazard worse than an
    // honest, named refusal.
    function fleetAcquire(initials) {
        if (dead) throwFleetDead(ctorName, "acquire");
        if (freeTop === 0) throwFleetExhausted(ctorName, capacity);
        const i = free[freeTop - 1];
        const vm = slots[i];
        reinitReactive(vm, initials);
        freeTop = freeTop - 1;
        return vm;
    }

    // HOT: validate ownership by the slot stamp, then park. `vm[STAMP]` is
    // `undefined` for a foreign or non-object vm (fail closed); slots[i] === vm
    // re-confirms identity; releaseReactive() false is the double-release signal.
    function fleetRelease(vm) {
        if (dead) throwFleetDead(ctorName, "release");
        const i = vm !== null && typeof vm === "object" ? vm[STAMP] : undefined;
        if (i === undefined || slots[i] !== vm) throwFleetForeign(ctorName);
        if (!releaseReactive(vm)) throwFleetDoubleRelease(ctorName);
        free[freeTop] = i;
        freeTop = freeTop + 1;
        return vm;
    }

    // HOT: bounds-checked slot read (live OR parked). `i >>> 0` folds negative and
    // out-of-range into one unsigned compare.
    function fleetAt(i) {
        if (dead) throwFleetDead(ctorName, "at");
        if ((i >>> 0) >= capacity) throwFleetRange(ctorName, i, capacity);
        return slots[i];
    }

    function fleetSize() {
        if (dead) throwFleetDead(ctorName, "size");
        return capacity - freeTop;              // live = capacity - idle
    }

    // The fleet-owned registry always comes from createRegistry(), which always
    // carries the stats ledger, so this is a straight pass-through.
    function fleetStats() {
        if (dead) throwFleetDead(ctorName, "stats");
        return registry.stats();
    }

    // Dispose every member (live AND parked; disposeReactive on a parked member
    // lands it DISPOSED), then destroy the registry. Idempotent: a second call
    // no-ops. After dispose, every hot method fails closed via the `dead` guard.
    function fleetDispose() {
        if (dead) return;
        dead = true;
        for (let i = 0; i < capacity; i++) disposeReactive(slots[i]);
        registry.destroy();
    }

    return {
        registry,
        Class,
        capacity,
        acquire: fleetAcquire,
        release: fleetRelease,
        at: fleetAt,
        size: fleetSize,
        stats: fleetStats,
        dispose: fleetDispose,
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
    const loc = [];
    for (let i = 0; i < plan.locals.length; i++) loc.push(`${name}.${keyLabel(plan.locals[i].key)}`);
    const der = [];
    for (let i = 0; i < plan.deriveds.length; i++) der.push(`${name}.${keyLabel(plan.deriveds[i].key)}`);
    const eff = [];
    for (let i = 0; i < plan.effects.length; i++) eff.push(`${name}#${keyLabel(plan.effects[i].key)}`);
    s = { anchor: `${name}@anchor`, signals: sig, locals: loc, deriveds: der, effects: eff };
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
    const locs = plan.locals;
    for (let i = 0; i < locs.length; i++) {
        const id = reg.nodeId(inst[locs[i].slot]);
        if (id !== undefined) { map.set(id, strings.locals[i]); ids.push(id); }
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
export const VERSION = "1.5.1";
