var _Base2;
let _initProto, _initClass, _init_x, _init_extra_x, _init_y, _init_extra_y, _init_s, _init_extra_s, _init_x2, _init_extra_x2, _init_computedKey, _init_extra_computedKey, _initClass2, _init_a, _init_extra_a;
function _applyDecs(e, t, n, r, o, i) { var a, c, u, s, f, l, p, d = Symbol.metadata || Symbol.for("Symbol.metadata"), m = Object.defineProperty, h = Object.create, y = [h(null), h(null)], v = t.length; function g(t, n, r) { return function (o, i) { n && (i = o, o = e); for (var a = 0; a < t.length; a++) i = t[a].apply(o, r ? [i] : []); return r ? i : o; }; } function b(e, t, n, r) { if ("function" != typeof e && (r || void 0 !== e)) throw new TypeError(t + " must " + (n || "be") + " a function" + (r ? "" : " or undefined")); return e; } function applyDec(e, t, n, r, o, i, u, s, f, l, p) { function d(e) { if (!p(e)) throw new TypeError("Attempted to access private element on non-instance"); } var h = [].concat(t[0]), v = t[3], w = !u, D = 1 === o, S = 3 === o, j = 4 === o, E = 2 === o; function I(t, n, r) { return function (o, i) { return n && (i = o, o = e), r && r(o), P[t].call(o, i); }; } if (!w) { var P = {}, k = [], F = S ? "get" : j || D ? "set" : "value"; if (f ? (l || D ? P = { get: _setFunctionName(function () { return v(this); }, r, "get"), set: function (e) { t[4](this, e); } } : P[F] = v, l || _setFunctionName(P[F], r, E ? "" : F)) : l || (P = Object.getOwnPropertyDescriptor(e, r)), !l && !f) { if ((c = y[+s][r]) && 7 !== (c ^ o)) throw Error("Decorating two elements with the same name (" + P[F].name + ") is not supported yet"); y[+s][r] = o < 3 ? 1 : o; } } for (var N = e, O = h.length - 1; O >= 0; O -= n ? 2 : 1) { var T = b(h[O], "A decorator", "be", !0), z = n ? h[O - 1] : void 0, A = {}, H = { kind: ["field", "accessor", "method", "getter", "setter", "class"][o], name: r, metadata: a, addInitializer: function (e, t) { if (e.v) throw new TypeError("attempted to call addInitializer after decoration was finished"); b(t, "An initializer", "be", !0), i.push(t); }.bind(null, A) }; if (w) c = T.call(z, N, H), A.v = 1, b(c, "class decorators", "return") && (N = c);else if (H.static = s, H.private = f, c = H.access = { has: f ? p.bind() : function (e) { return r in e; } }, j || (c.get = f ? E ? function (e) { return d(e), P.value; } : I("get", 0, d) : function (e) { return e[r]; }), E || S || (c.set = f ? I("set", 0, d) : function (e, t) { e[r] = t; }), N = T.call(z, D ? { get: P.get, set: P.set } : P[F], H), A.v = 1, D) { if ("object" == typeof N && N) (c = b(N.get, "accessor.get")) && (P.get = c), (c = b(N.set, "accessor.set")) && (P.set = c), (c = b(N.init, "accessor.init")) && k.unshift(c);else if (void 0 !== N) throw new TypeError("accessor decorators must return an object with get, set, or init properties or undefined"); } else b(N, (l ? "field" : "method") + " decorators", "return") && (l ? k.unshift(N) : P[F] = N); } return o < 2 && u.push(g(k, s, 1), g(i, s, 0)), l || w || (f ? D ? u.splice(-1, 0, I("get", s), I("set", s)) : u.push(E ? P[F] : b.call.bind(P[F])) : m(e, r, P)), N; } function w(e) { return m(e, d, { configurable: !0, enumerable: !0, value: a }); } return void 0 !== i && (a = i[d]), a = h(null == a ? null : a), f = [], l = function (e) { e && f.push(g(e)); }, p = function (t, r) { for (var i = 0; i < n.length; i++) { var a = n[i], c = a[1], l = 7 & c; if ((8 & c) == t && !l == r) { var p = a[2], d = !!a[3], m = 16 & c; applyDec(t ? e : e.prototype, a, m, d ? "#" + p : _toPropertyKey(p), l, l < 2 ? [] : t ? s = s || [] : u = u || [], f, !!t, d, r, t && d ? function (t) { return _checkInRHS(t) === e; } : o); } } }, p(8, 0), p(0, 0), p(8, 1), p(0, 1), l(u), l(s), c = f, v || w(e), { e: c, get c() { var n = []; return v && [w(e = applyDec(e, [t], r, e.name, 5, n)), g(n, 1)]; } }; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _setFunctionName(e, t, n) { "symbol" == typeof t && (t = (t = t.description) ? "[" + t + "]" : ""); try { Object.defineProperty(e, "name", { configurable: !0, value: n ? n + " " + t : t }); } catch (e) {} return e; }
function _checkInRHS(e) { if (Object(e) !== e) throw TypeError("right-hand side of 'in' should be an object, got " + (null !== e ? typeof e : "null")); return e; }
function _identity(t) { return t; }
// fixture.src.ts -- one class family exercising emit laws L1..L8 in a single
// compile. Imports only the instrumented decorators (the package has no source
// in S0). The ".js" extension is required so Node ESM resolves the emitted
// output at runtime; TS bundler resolution and Babel both tolerate it. ASCII-only.

import { mark, replaceClass } from "./instrument.js";
let _Base;
new class extends _identity {
  static [class Base {
    static {
      ({
        e: [_init_s, _init_extra_s, _init_x, _init_extra_x, _init_y, _init_extra_y, _initProto],
        c: [_Base, _initClass]
      } = _applyDecs(this, [mark("C-class")], [[mark("A-x"), 1, "x"], [mark("A-y"), 1, "y"], [mark("G-d"), 3, "d"], [mark("M-m"), 2, "m"], [mark("S-s"), 9, "s"]]));
    }
    #A = (_initProto(this), _init_x(this, 1)); // L2: init at field-def time
    get x() {
      return this.#A;
    }
    set x(v) {
      this.#A = v;
    }
    #B = (_init_extra_x(this), _init_y(this, this.x + 1)); // L2: declaration order -> x's box exists
    get y() {
      return this.#B;
    }
    set y(v) {
      this.#B = v;
    }
    get d() {
      return this.x * 2;
    }
    m() {
      return this.x;
    }
    // L3 witness: this field-init reads this.y (accessor init must have run) and
    // is stamped into __EMIT_LOG so its index is comparable with addInit indices.
    field = (_init_extra_y(this), (() => {
      const g = globalThis;
      (g.__FIELD_LOG ||= []).push(["field-init", "y-visible", this.y]);
      g.__EMIT_LOG.push(["field-init", "field", "field", this.y]);
      return 0;
    })());
    // static lane (L8 note; emit ordering only)
    static get s() {
      return Base.#C;
    }
    static set s(v) {
      Base.#C = v;
    }
    constructor() {
      // L4: new.target inside the base ctor names the most-derived ctor.
      (globalThis.__NT ||= []).push(new.target ? new.target.name : "undefined");
    }
  }];
  #C = _init_s(0);
  constructor() {
    super(_Base), (() => {
      _init_extra_s();
    })(), _initClass();
  }
}();
class Derived extends (_Base2 = _Base) {
  static {
    [_init_x2, _init_extra_x2] = _applyDecs(this, [], [[mark("D-x2"), 1, "x2"]], 0, void 0, _Base2).e;
  }
  constructor(...args) {
    super(...args);
    _init_extra_x2(this);
  }
  // L4 + most-derived rule input
  #A = _init_x2(this, 10);
  get x2() {
    return this.#A;
  }
  set x2(v) {
    this.#A = v;
  }
}
class Plain extends _Base {} // undecorated subclass (most-derived-rule input)

const sym = Symbol("k");
class Symbolic {
  static {
    [_init_computedKey, _init_extra_computedKey] = _applyDecs(this, [], [[mark("SYM"), 1, sym]]).e;
  }
  constructor() {
    _init_extra_computedKey(this);
  }
  #A = _init_computedKey(this, 5); // symbol-named member
  get [sym]() {
    return this.#A;
  }
  set [sym](v) {
    this.#A = v;
  }
}

// L8 replacement exhibit: @replaceClass returns a subclass named "Replaced".
let _Replaceable;
class Replaceable {
  static {
    ({
      e: [_init_a, _init_extra_a],
      c: [_Replaceable, _initClass2]
    } = _applyDecs(this, [replaceClass], [[mark("R-a"), 1, "a"]]));
  }
  constructor() {
    _init_extra_a(this);
  }
  #A = _init_a(this, 7);
  get a() {
    return this.#A;
  }
  set a(v) {
    this.#A = v;
  }
  static {
    _initClass2();
  }
}

// Construct once each so decorators apply and initializers run. Order matters
// for L4: Derived is constructed LAST so __NT's final entry is "Derived".
const base = new _Base();
const plain = new Plain();
const symbolic = new Symbolic();
const replaceable = new _Replaceable();
const derived = new Derived();
const symMeta = Symbol.metadata;
const symMetaDefined = typeof symMeta !== "undefined" && symMeta !== null;
globalThis.__FIXTURE_RESULT = {
  baseX: base.x,
  baseY: base.y,
  baseD: base.d,
  baseM: base.m(),
  baseInstanceofBase: base instanceof _Base,
  derivedInstanceofBase: derived instanceof _Base,
  plainInstanceofBase: plain instanceof _Base,
  symbolicVal: symbolic[sym],
  replaceableInstanceof: replaceable instanceof _Replaceable,
  replaceableName: replaceable.constructor.name,
  staticS: _Base.s,
  symMetaDefined,
  baseMetadata: symMetaDefined ? _Base[symMeta] != null : false,
  derivedInheritsBaseMetadata: symMetaDefined ? Derived[symMeta] != null && Derived[symMeta] === _Base[symMeta] : false
};
export {};
