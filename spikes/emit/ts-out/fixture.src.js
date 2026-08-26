// fixture.src.ts -- one class family exercising emit laws L1..L8 in a single
// compile. Imports only the instrumented decorators (the package has no source
// in S0). The ".js" extension is required so Node ESM resolves the emitted
// output at runtime; TS bundler resolution and Babel both tolerate it. ASCII-only.
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
var __setFunctionName = (this && this.__setFunctionName) || function (f, name, prefix) {
    if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
    return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
};
var __classPrivateFieldGet = (this && this.__classPrivateFieldGet) || function (receiver, state, kind, f) {
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = (this && this.__classPrivateFieldSet) || function (receiver, state, value, kind, f) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return (kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value)), value;
};
import { mark, replaceClass } from "./instrument.js";
let Base = (() => {
    var _Base_s_accessor_storage;
    let _classDecorators = [mark("C-class")];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _instanceExtraInitializers = [];
    let _static_s_decorators;
    let _static_s_initializers = [];
    let _static_s_extraInitializers = [];
    let _x_decorators;
    let _x_initializers = [];
    let _x_extraInitializers = [];
    let _y_decorators;
    let _y_initializers = [];
    let _y_extraInitializers = [];
    let _get_d_decorators;
    let _m_decorators;
    var Base = class {
        static { _classThis = this; }
        static { __setFunctionName(this, "Base"); }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _x_decorators = [mark("A-x")];
            _y_decorators = [mark("A-y")];
            _get_d_decorators = [mark("G-d")];
            _m_decorators = [mark("M-m")];
            _static_s_decorators = [mark("S-s")];
            __esDecorate(this, null, _static_s_decorators, { kind: "accessor", name: "s", static: true, private: false, access: { has: obj => "s" in obj, get: obj => obj.s, set: (obj, value) => { obj.s = value; } }, metadata: _metadata }, _static_s_initializers, _static_s_extraInitializers);
            __esDecorate(this, null, _x_decorators, { kind: "accessor", name: "x", static: false, private: false, access: { has: obj => "x" in obj, get: obj => obj.x, set: (obj, value) => { obj.x = value; } }, metadata: _metadata }, _x_initializers, _x_extraInitializers);
            __esDecorate(this, null, _y_decorators, { kind: "accessor", name: "y", static: false, private: false, access: { has: obj => "y" in obj, get: obj => obj.y, set: (obj, value) => { obj.y = value; } }, metadata: _metadata }, _y_initializers, _y_extraInitializers);
            __esDecorate(this, null, _get_d_decorators, { kind: "getter", name: "d", static: false, private: false, access: { has: obj => "d" in obj, get: obj => obj.d }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(this, null, _m_decorators, { kind: "method", name: "m", static: false, private: false, access: { has: obj => "m" in obj, get: obj => obj.m }, metadata: _metadata }, null, _instanceExtraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Base = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #x_accessor_storage = (__runInitializers(this, _instanceExtraInitializers), __runInitializers(this, _x_initializers, 1));
        get x() { return this.#x_accessor_storage; } // L2: init at field-def time
        set x(value) { this.#x_accessor_storage = value; }
        #y_accessor_storage = (__runInitializers(this, _x_extraInitializers), __runInitializers(this, _y_initializers, this.x + 1));
        get y() { return this.#y_accessor_storage; } // L2: declaration order -> x's box exists
        set y(value) { this.#y_accessor_storage = value; }
        get d() {
            return this.x * 2;
        }
        m() {
            return this.x;
        }
        // L3 witness: this field-init reads this.y (accessor init must have run) and
        // is stamped into __EMIT_LOG so its index is comparable with addInit indices.
        field = (__runInitializers(this, _y_extraInitializers), (() => {
            const g = globalThis;
            (g.__FIELD_LOG ||= []).push(["field-init", "y-visible", this.y]);
            g.__EMIT_LOG.push(["field-init", "field", "field", this.y]);
            return 0;
        })());
        static {
            _Base_s_accessor_storage = { value: __runInitializers(_classThis, _static_s_initializers, 0) };
        }
        static get s() { return __classPrivateFieldGet(_classThis, _classThis, "f", _Base_s_accessor_storage); } // static lane (L8 note; emit ordering only)
        static set s(value) { __classPrivateFieldSet(_classThis, _classThis, value, "f", _Base_s_accessor_storage); }
        constructor() {
            // L4: new.target inside the base ctor names the most-derived ctor.
            (globalThis.__NT ||= []).push(new.target ? new.target.name : "undefined");
        }
        static {
            __runInitializers(_classThis, _static_s_extraInitializers);
            __runInitializers(_classThis, _classExtraInitializers);
        }
    };
    return Base = _classThis;
})();
let Derived = (() => {
    let _classSuper = Base;
    let _x2_decorators;
    let _x2_initializers = [];
    let _x2_extraInitializers = [];
    return class Derived extends _classSuper {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
            _x2_decorators = [mark("D-x2")];
            __esDecorate(this, null, _x2_decorators, { kind: "accessor", name: "x2", static: false, private: false, access: { has: obj => "x2" in obj, get: obj => obj.x2, set: (obj, value) => { obj.x2 = value; } }, metadata: _metadata }, _x2_initializers, _x2_extraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #x2_accessor_storage = __runInitializers(this, _x2_initializers, 10);
        // L4 + most-derived rule input
        get x2() { return this.#x2_accessor_storage; }
        set x2(value) { this.#x2_accessor_storage = value; }
        constructor() {
            super(...arguments);
            __runInitializers(this, _x2_extraInitializers);
        }
    };
})();
class Plain extends Base {
} // undecorated subclass (most-derived-rule input)
const sym = Symbol("k");
let Symbolic = (() => {
    var _a;
    let _member_decorators;
    let _member_initializers = [];
    let _member_extraInitializers = [];
    return class Symbolic {
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            __esDecorate(this, null, _member_decorators, { kind: "accessor", name: _a, static: false, private: false, access: { has: obj => _a in obj, get: obj => obj[_a], set: (obj, value) => { obj[_a] = value; } }, metadata: _metadata }, _member_initializers, _member_extraInitializers);
            if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
        }
        #_a_accessor_storage = __runInitializers(this, _member_initializers, 5);
        get [(_member_decorators = [mark("SYM")], _a = __propKey(sym))]() { return this.#_a_accessor_storage; } // symbol-named member
        set [_a](value) { this.#_a_accessor_storage = value; }
        constructor() {
            __runInitializers(this, _member_extraInitializers);
        }
    };
})();
// L8 replacement exhibit: @replaceClass returns a subclass named "Replaced".
let Replaceable = (() => {
    let _classDecorators = [replaceClass];
    let _classDescriptor;
    let _classExtraInitializers = [];
    let _classThis;
    let _a_decorators;
    let _a_initializers = [];
    let _a_extraInitializers = [];
    var Replaceable = class {
        static { _classThis = this; }
        static {
            const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(null) : void 0;
            _a_decorators = [mark("R-a")];
            __esDecorate(this, null, _a_decorators, { kind: "accessor", name: "a", static: false, private: false, access: { has: obj => "a" in obj, get: obj => obj.a, set: (obj, value) => { obj.a = value; } }, metadata: _metadata }, _a_initializers, _a_extraInitializers);
            __esDecorate(null, _classDescriptor = { value: _classThis }, _classDecorators, { kind: "class", name: _classThis.name, metadata: _metadata }, null, _classExtraInitializers);
            Replaceable = _classThis = _classDescriptor.value;
            if (_metadata) Object.defineProperty(_classThis, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
            __runInitializers(_classThis, _classExtraInitializers);
        }
        #a_accessor_storage = __runInitializers(this, _a_initializers, 7);
        get a() { return this.#a_accessor_storage; }
        set a(value) { this.#a_accessor_storage = value; }
        constructor() {
            __runInitializers(this, _a_extraInitializers);
        }
    };
    return Replaceable = _classThis;
})();
// Construct once each so decorators apply and initializers run. Order matters
// for L4: Derived is constructed LAST so __NT's final entry is "Derived".
const base = new Base();
const plain = new Plain();
const symbolic = new Symbolic();
const replaceable = new Replaceable();
const derived = new Derived();
const symMeta = Symbol.metadata;
const symMetaDefined = typeof symMeta !== "undefined" && symMeta !== null;
globalThis.__FIXTURE_RESULT = {
    baseX: base.x,
    baseY: base.y,
    baseD: base.d,
    baseM: base.m(),
    baseInstanceofBase: base instanceof Base,
    derivedInstanceofBase: derived instanceof Base,
    plainInstanceofBase: plain instanceof Base,
    symbolicVal: symbolic[sym],
    replaceableInstanceof: replaceable instanceof Replaceable,
    replaceableName: replaceable.constructor.name,
    staticS: Base.s,
    symMetaDefined,
    baseMetadata: symMetaDefined ? Base[symMeta] != null : false,
    derivedInheritsBaseMetadata: symMetaDefined
        ? Derived[symMeta] != null && Derived[symMeta] === Base[symMeta]
        : false,
};
