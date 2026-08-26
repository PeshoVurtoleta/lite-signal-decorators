var _class;
function _applyDecoratedDescriptor(i, e, r, n, l) { var a = {}; return Object.keys(n).forEach(function (i) { a[i] = n[i]; }), a.enumerable = !!a.enumerable, a.configurable = !!a.configurable, ("value" in a || a.initializer) && (a.writable = !0), a = r.slice().reverse().reduce(function (r, n) { return n(i, e, r) || r; }, a), l && void 0 !== a.initializer && (a.value = a.initializer ? a.initializer.call(l) : void 0, a.initializer = void 0), void 0 === a.initializer ? (Object.defineProperty(i, e, a), null) : a; }
// legacy.src.ts -- L6 second fixture. Compiled with experimentalDecorators:true
// (TS) and version:'legacy' (Babel) to capture the LEGACY call shape
// (target, key, descriptor). Self-contained: no import so it compiles under both
// legacy toolchains without extension-resolution concerns. ASCII-only.

function legacyProbe(...args) {
  globalThis.__LEGACY_ARGS = {
    typeofs: args.map(a => typeof a),
    secondIsString: typeof args[1] === "string",
    secondHasKind: typeof (args[1] && args[1].kind) === "string"
  };
  return undefined;
}
let L = (_class = class L {
  method() {
    return 1;
  }
}, _applyDecoratedDescriptor(_class.prototype, "method", [legacyProbe], Object.getOwnPropertyDescriptor(_class.prototype, "method"), _class.prototype), _class);
new L();
export {};
