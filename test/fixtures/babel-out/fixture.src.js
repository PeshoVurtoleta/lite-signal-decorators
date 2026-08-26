var _Base2;
let _initProto, _initClass, _init_count, _init_extra_count, _init_level, _init_extra_level, _init_computedKey, _init_extra_computedKey, _initProto2, _initClass2, _init_a, _init_extra_a, _initProto3, _initClass3, _init_b, _init_extra_b;
function _applyDecs(e, t, n, r, o, i) { var a, c, u, s, f, l, p, d = Symbol.metadata || Symbol.for("Symbol.metadata"), m = Object.defineProperty, h = Object.create, y = [h(null), h(null)], v = t.length; function g(t, n, r) { return function (o, i) { n && (i = o, o = e); for (var a = 0; a < t.length; a++) i = t[a].apply(o, r ? [i] : []); return r ? i : o; }; } function b(e, t, n, r) { if ("function" != typeof e && (r || void 0 !== e)) throw new TypeError(t + " must " + (n || "be") + " a function" + (r ? "" : " or undefined")); return e; } function applyDec(e, t, n, r, o, i, u, s, f, l, p) { function d(e) { if (!p(e)) throw new TypeError("Attempted to access private element on non-instance"); } var h = [].concat(t[0]), v = t[3], w = !u, D = 1 === o, S = 3 === o, j = 4 === o, E = 2 === o; function I(t, n, r) { return function (o, i) { return n && (i = o, o = e), r && r(o), P[t].call(o, i); }; } if (!w) { var P = {}, k = [], F = S ? "get" : j || D ? "set" : "value"; if (f ? (l || D ? P = { get: _setFunctionName(function () { return v(this); }, r, "get"), set: function (e) { t[4](this, e); } } : P[F] = v, l || _setFunctionName(P[F], r, E ? "" : F)) : l || (P = Object.getOwnPropertyDescriptor(e, r)), !l && !f) { if ((c = y[+s][r]) && 7 !== (c ^ o)) throw Error("Decorating two elements with the same name (" + P[F].name + ") is not supported yet"); y[+s][r] = o < 3 ? 1 : o; } } for (var N = e, O = h.length - 1; O >= 0; O -= n ? 2 : 1) { var T = b(h[O], "A decorator", "be", !0), z = n ? h[O - 1] : void 0, A = {}, H = { kind: ["field", "accessor", "method", "getter", "setter", "class"][o], name: r, metadata: a, addInitializer: function (e, t) { if (e.v) throw new TypeError("attempted to call addInitializer after decoration was finished"); b(t, "An initializer", "be", !0), i.push(t); }.bind(null, A) }; if (w) c = T.call(z, N, H), A.v = 1, b(c, "class decorators", "return") && (N = c);else if (H.static = s, H.private = f, c = H.access = { has: f ? p.bind() : function (e) { return r in e; } }, j || (c.get = f ? E ? function (e) { return d(e), P.value; } : I("get", 0, d) : function (e) { return e[r]; }), E || S || (c.set = f ? I("set", 0, d) : function (e, t) { e[r] = t; }), N = T.call(z, D ? { get: P.get, set: P.set } : P[F], H), A.v = 1, D) { if ("object" == typeof N && N) (c = b(N.get, "accessor.get")) && (P.get = c), (c = b(N.set, "accessor.set")) && (P.set = c), (c = b(N.init, "accessor.init")) && k.unshift(c);else if (void 0 !== N) throw new TypeError("accessor decorators must return an object with get, set, or init properties or undefined"); } else b(N, (l ? "field" : "method") + " decorators", "return") && (l ? k.unshift(N) : P[F] = N); } return o < 2 && u.push(g(k, s, 1), g(i, s, 0)), l || w || (f ? D ? u.splice(-1, 0, I("get", s), I("set", s)) : u.push(E ? P[F] : b.call.bind(P[F])) : m(e, r, P)), N; } function w(e) { return m(e, d, { configurable: !0, enumerable: !0, value: a }); } return void 0 !== i && (a = i[d]), a = h(null == a ? null : a), f = [], l = function (e) { e && f.push(g(e)); }, p = function (t, r) { for (var i = 0; i < n.length; i++) { var a = n[i], c = a[1], l = 7 & c; if ((8 & c) == t && !l == r) { var p = a[2], d = !!a[3], m = 16 & c; applyDec(t ? e : e.prototype, a, m, d ? "#" + p : _toPropertyKey(p), l, l < 2 ? [] : t ? s = s || [] : u = u || [], f, !!t, d, r, t && d ? function (t) { return _checkInRHS(t) === e; } : o); } } }, p(8, 0), p(0, 0), p(8, 1), p(0, 1), l(u), l(s), c = f, v || w(e), { e: c, get c() { var n = []; return v && [w(e = applyDec(e, [t], r, e.name, 5, n)), g(n, 1)]; } }; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == typeof i ? i : i + ""; }
function _toPrimitive(t, r) { if ("object" != typeof t || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != typeof i) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
function _setFunctionName(e, t, n) { "symbol" == typeof t && (t = (t = t.description) ? "[" + t + "]" : ""); try { Object.defineProperty(e, "name", { configurable: !0, value: n ? n + " " + t : t }); } catch (e) {} return e; }
function _checkInRHS(e) { if (Object(e) !== e) throw TypeError("right-hand side of 'in' should be an object, got " + (null !== e ? typeof e : "null")); return e; }
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
export const recompute = {
  double: 0,
  band: 0,
  da: 0,
  db: 0
};

/** Effect-fire counters -- the @reactiveEffect bodies bump these so wire-fire,
 * re-fire, and dispose-stop are observable in the behavior suite. */
export const effectFires = {
  counter: 0,
  derived: 0
};

/** Tolerance equals: values within 0.5 are treated as unchanged. */
function approxEquals(a, b) {
  return Math.abs(a - b) < 0.5;
}

/** A symbol-named reactive member (exported so the suite can address it). */
export const SYM = Symbol("counter-sym");
let _Counter;
class Counter {
  static {
    ({
      e: [_init_count, _init_extra_count, _init_level, _init_extra_level, _init_computedKey, _init_extra_computedKey, _initProto],
      c: [_Counter, _initClass]
    } = _applyDecs(this, [reactiveHost], [[reactive, 1, "count"], [reactive({
      equals: approxEquals
    }), 1, "level"], [reactive, 1, SYM], [derived, 3, "double"], [derived({
      equals: approxEquals
    }), 3, "band"], [reactiveEffect, 2, "onCount"], [batched, 2, "bump"]]));
  }
  #A = (_initProto(this), _init_count(this, 0));
  get count() {
    return this.#A;
  }
  set count(v) {
    this.#A = v;
  }
  #B = (_init_extra_count(this), _init_level(this, 0));
  get level() {
    return this.#B;
  }
  set level(v) {
    this.#B = v;
  }
  #C = (_init_extra_level(this), _init_computedKey(this, "tag"));
  get [SYM]() {
    return this.#C;
  }
  set [SYM](v) {
    this.#C = v;
  }
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
  late = (_init_extra_computedKey(this), this.count + 1);
  static {
    _initClass();
  }
}
export { _Counter as Counter };
let _Base;
class Base {
  static {
    ({
      e: [_init_a, _init_extra_a, _initProto2],
      c: [_Base, _initClass2]
    } = _applyDecs(this, [reactiveHost], [[reactive, 1, "a"], [derived, 3, "da"]]));
  }
  constructor() {
    _init_extra_a(this);
  }
  #A = (_initProto2(this), _init_a(this, 1));
  get a() {
    return this.#A;
  }
  set a(v) {
    this.#A = v;
  }
  get da() {
    recompute.da++;
    return this.a + 100;
  }
  static {
    _initClass2();
  }
}
export { _Base as Base };
let _Derived;
class Derived extends (_Base2 = _Base) {
  static {
    ({
      e: [_init_b, _init_extra_b, _initProto3],
      c: [_Derived, _initClass3]
    } = _applyDecs(this, [reactiveHost], [[reactive, 1, "b"], [derived, 3, "db"], [reactiveEffect, 2, "onDb"]], 0, void 0, _Base2));
  }
  constructor(...args) {
    super(...args);
    _init_extra_b(this);
  }
  #A = (_initProto3(this), _init_b(this, 2));
  get b() {
    return this.#A;
  }
  set b(v) {
    this.#A = v;
  }
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
  static {
    _initClass3();
  }
}

// Undecorated subclass -- wires at Base's (inherited) host mark.
export { _Derived as Derived };
export class Leaf extends _Base {}
