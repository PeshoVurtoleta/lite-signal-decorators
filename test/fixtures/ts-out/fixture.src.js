// fixture.src.ts -- the S1 reactive class family, compiled by BOTH standard
// emitters (TS 5 `experimentalDecorators: false` and Babel `2023-11`). It is the
// SAME family that test/shared/mock-emitter.mjs builds by hand; 02/03 run the
// identical behavior suite over these compiled emits, so any TS/Babel/mock
// divergence is a bug. The ".js" specifier resolves the real package at both the
// src/ depth and the out-dir depth (../../../SignalDecorators.js). ASCII-only.
var __runInitializers = (this && this.__runInitializers) || function (thisArg, initializers, value) {
    var useValue = arguments.length > 2;
    for (var i = 0; i < initializers.length; i++) {
        value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
    }
    return useValue ? value : void 0;
};
var __esDecorate = (this && this.__esDecorate) || function (ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
    function accept(f) { if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected"); return f; }
    var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
    var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
    var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
    var _, done = false;
    for (var i = decorators.length - 1; i >= 0; i--) {
        var context = {};
        for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
        for (var p in contextIn.access) context.access[p] = contextIn.access[p];
        context.addInitializer = function (f) { if (done) throw new TypeError("Cannot add initializers after decoration has completed"); extraInitializers.push(accept(f || null)); };
        var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
        if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
        }
        else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
        }
    }
    if (target) Object.defineProperty(target, contextIn.name, descriptor);
    done = true;
};
var __propKey = (this && this.__propKey) || function (x) {
    return typeof x === "symbol" ? x : "".concat(x);
};
import * as pkgNs from "../../../SignalDecorators.js";
import { reactive, derived, reactiveHost, reactiveEffect, batched, localTo } from "../../../SignalDecorators.js";
/** The package instance that built these classes (shares its PLANS WeakMap). */
export const pkg = pkgNs;
/** Recompute counters -- the derived bodies bump these so laziness/equals
 * suppression are observable in the behavior suite. */
export const recompute = { double: 0, band: 0, da: 0, db: 0 };
/** Effect-fire counters -- the @reactiveEffect bodies bump these so wire-fire,
 * re-fire, and dispose-stop are observable in the behavior suite. */
export const effectFires = { counter: 0, derived: 0 };
/** Tolerance equals: values within 0.5 are treated as unchanged. */
function approxEquals(a, b) {
    return Math.abs(a - b) < 0.5;
}
/** A symbol-named reactive member (exported so the suite can address it). */
export const SYM = Symbol("counter-sym");
let Counter = (() => {
    var _a;
    let _classDecorators = [reactiveHost];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _instanceExtraInitializers = [];
    let _count_decorators;
    let _count_initializers = [];
    let _count_extraInitializers = [];
    let _level_decorators;
    let _level_initializers = [];
    let _level_extraInitializers = [];
    let _member_decorators;
    let _member_initializers = [];
    let _member_extraInitializers = [];
    let _get_double_decorators;
    let _get_band_decorators;
    let _onCount_decorators;
    let _bump_decorators;
    var Counter = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _get_double_decorators = [derived];
            _get_band_decorators = [derived({ equals: approxEquals })];
            _onCount_decorators = [reactiveEffect];
            _bump_decorators = [batched];
            __esDecorate(this, null, _count_decorators, { kind: "accessor", name: "count", static: false, private: false, access: { has: obj => "count" in obj, get: obj => obj.count, set: (obj, value) => { obj.count = value; } }, metadata: _metadata }, _count_initializers, _count_extraInitializers);
            __esDecorate(this, null, _level_decorators, { kind: "accessor", name: "level", static: false, private: false, access: { has: obj => "level" in obj, get: obj => obj.level, set: (obj, value) => { obj.level = value; } }, metadata: _metadata }, _level_initializers, _level_extraInitializers);
            __esDecorate(this, null, _member_decorators, { kind: "accessor", name: _a, static: false, private: false, access: { has: obj => _a in obj, get: obj => obj[_a], set: (obj, value) => { obj[_a] = value; } }, metadata: _metadata }, _member_initializers, _member_extraInitializers);
            __esDecorate(this, null, _get_double_decorators, { kind: "getter", name: "double", static: false, private: false, access: { has: obj => "double" in obj, get: obj => obj.double }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _get_band_decorators, { kind: "getter", name: "band", static: false, private: false, access: { has: obj => "band" in obj, get: obj => obj.band }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _onCount_decorators, { kind: "method", name: "onCount", static: false, private: false, access: { has: obj => "onCount" in obj, get: obj => obj.onCount }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _bump_decorators, { kind: "method", name: "bump", static: false, private: false, access: { has: obj => "bump" in obj, get: obj => obj.bump }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Counter = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        #count_accessor_storage = (__runInitializers(this, _instanceExtraInitializers), __runInitializers(this, _count_initializers, 0));
        get count() { return this.#count_accessor_storage; }
        set count(value) { this.#count_accessor_storage = value; }
        #level_accessor_storage = (__runInitializers(this, _count_extraInitializers), __runInitializers(this, _level_initializers, 0));
        get level() { return this.#level_accessor_storage; }
        set level(value) { this.#level_accessor_storage = value; }
        #_a_accessor_storage = (__runInitializers(this, _level_extraInitializers), __runInitializers(this, _member_initializers, "tag"));
        get [(_count_decorators = [reactive], _level_decorators = [reactive({ equals: approxEquals })], _member_decorators = [reactive], _a = __propKey(SYM))]() { return this.#_a_accessor_storage; }
        set [_a](value) { this.#_a_accessor_storage = value; }
        get double() {
            recompute.double++;
            return this.count * 2;
        }
        get band() {
            recompute.band++;
            return this.level;
        }
        // @reactiveEffect method: tracks count, fires once at wire, re-fires on a
        // count mutation.
        onCount() {
            effectFires.counter++;
            void this.count;
        }
        // @batched method: coalesces its two writes into one effect flush.
        bump() {
            this.count = this.count + 1;
            this.count = this.count + 1;
        }
        // Plain field reading an earlier accessor (L2 declaration-order read).
        late = (__runInitializers(this, _member_extraInitializers), this.count + 1);
    };
    return Counter = _classThis;
})();
export { Counter };
let Base = (() => {
    let _classDecorators = [reactiveHost];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _instanceExtraInitializers = [];
    let _a_decorators;
    let _a_initializers = [];
    let _a_extraInitializers = [];
    let _get_da_decorators;
    var Base = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _a_decorators = [reactive];
            _get_da_decorators = [derived];
            __esDecorate(this, null, _a_decorators, { kind: "accessor", name: "a", static: false, private: false, access: { has: obj => "a" in obj, get: obj => obj.a, set: (obj, value) => { obj.a = value; } }, metadata: _metadata }, _a_initializers, _a_extraInitializers);
            __esDecorate(this, null, _get_da_decorators, { kind: "getter", name: "da", static: false, private: false, access: { has: obj => "da" in obj, get: obj => obj.da }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Base = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        #a_accessor_storage = (__runInitializers(this, _instanceExtraInitializers), __runInitializers(this, _a_initializers, 1));
        get a() { return this.#a_accessor_storage; }
        set a(value) { this.#a_accessor_storage = value; }
        get da() {
            recompute.da++;
            return this.a + 100;
        }
        constructor() {
            __runInitializers(this, _a_extraInitializers);
        }
    };
    return Base = _classThis;
})();
export { Base };
let Derived = (() => {
    let _classDecorators = [reactiveHost];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _classSuper = Base;
    let _instanceExtraInitializers = [];
    let _b_decorators;
    let _b_initializers = [];
    let _b_extraInitializers = [];
    let _get_db_decorators;
    let _onDb_decorators;
    var Derived = class extends _classSuper {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _b_decorators = [reactive];
            _get_db_decorators = [derived];
            _onDb_decorators = [reactiveEffect];
            __esDecorate(this, null, _b_decorators, { kind: "accessor", name: "b", static: false, private: false, access: { has: obj => "b" in obj, get: obj => obj.b, set: (obj, value) => { obj.b = value; } }, metadata: _metadata }, _b_initializers, _b_extraInitializers);
            __esDecorate(this, null, _get_db_decorators, { kind: "getter", name: "db", static: false, private: false, access: { has: obj => "db" in obj, get: obj => obj.db }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _onDb_decorators, { kind: "method", name: "onDb", static: false, private: false, access: { has: obj => "onDb" in obj, get: obj => obj.onDb }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Derived = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        #b_accessor_storage = (__runInitializers(this, _instanceExtraInitializers), __runInitializers(this, _b_initializers, 2));
        get b() { return this.#b_accessor_storage; }
        set b(value) { this.#b_accessor_storage = value; }
        get db() {
            recompute.db++;
            return this.a + this.b;
        }
        // @reactiveEffect over an inherited-key derived: fires once after the full
        // chain is wired.
        onDb() {
            effectFires.derived++;
            void this.db;
        }
        constructor() {
            super(...arguments);
            __runInitializers(this, _b_extraInitializers);
        }
    };
    return Derived = _classThis;
})();
export { Derived };
// Undecorated subclass -- wires at Base's (inherited) host mark.
export class Leaf extends Base {
}
// @localTo (0014): upstream-keyed resettable local state. `draft` carries an
// initializer, so it STARTS at that value and resets to `src` on the first
// upstream move (the @trackedReset flavor); `mirror` has no initializer, so it
// FOLLOWS `src` from wiring (the @localCopy flavor). Node cost: P=1 (src) + L=2
// (draft, mirror) + 1 anchor = 4 (seen slots are plain fields, 0 nodes).
let Locals = (() => {
    let _classDecorators = [reactiveHost];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _src_decorators;
    let _src_initializers = [];
    let _src_extraInitializers = [];
    let _draft_decorators;
    let _draft_initializers = [];
    let _draft_extraInitializers = [];
    let _mirror_decorators;
    let _mirror_initializers = [];
    let _mirror_extraInitializers = [];
    var Locals = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _src_decorators = [reactive];
            _draft_decorators = [localTo((self) => self.src)];
            _mirror_decorators = [localTo((self) => self.src)];
            __esDecorate(this, null, _src_decorators, { kind: "accessor", name: "src", static: false, private: false, access: { has: obj => "src" in obj, get: obj => obj.src, set: (obj, value) => { obj.src = value; } }, metadata: _metadata }, _src_initializers, _src_extraInitializers);
            __esDecorate(this, null, _draft_decorators, { kind: "accessor", name: "draft", static: false, private: false, access: { has: obj => "draft" in obj, get: obj => obj.draft, set: (obj, value) => { obj.draft = value; } }, metadata: _metadata }, _draft_initializers, _draft_extraInitializers);
            __esDecorate(this, null, _mirror_decorators, { kind: "accessor", name: "mirror", static: false, private: false, access: { has: obj => "mirror" in obj, get: obj => obj.mirror, set: (obj, value) => { obj.mirror = value; } }, metadata: _metadata }, _mirror_initializers, _mirror_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Locals = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        #src_accessor_storage = __runInitializers(this, _src_initializers, 10);
        get src() { return this.#src_accessor_storage; }
        set src(value) { this.#src_accessor_storage = value; }
        #draft_accessor_storage = (__runInitializers(this, _src_extraInitializers), __runInitializers(this, _draft_initializers, 0));
        get draft() { return this.#draft_accessor_storage; }
        set draft(value) { this.#draft_accessor_storage = value; }
        #mirror_accessor_storage = (__runInitializers(this, _draft_extraInitializers), __runInitializers(this, _mirror_initializers, void 0));
        get mirror() { return this.#mirror_accessor_storage; }
        set mirror(value) { this.#mirror_accessor_storage = value; }
        constructor() {
            __runInitializers(this, _mirror_extraInitializers);
        }
    };
    return Locals = _classThis;
})();
export { Locals };
