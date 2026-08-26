var _class;
function _applyDecoratedDescriptor(i, e, r, n, l) { var a = {}; return Object.keys(n).forEach(function (i) { a[i] = n[i]; }), a.enumerable = !!a.enumerable, a.configurable = !!a.configurable, ("value" in a || a.initializer) && (a.writable = !0), a = r.slice().reverse().reduce(function (r, n) { return n(i, e, r) || r; }, a), l && void 0 !== a.initializer && (a.value = a.initializer ? a.initializer.call(l) : void 0, a.initializer = void 0), void 0 === a.initializer ? (Object.defineProperty(i, e, a), null) : a; }
// legacy.src.ts -- a rejection fixture. Compiled with legacy decorators (TS
// `experimentalDecorators: true` / Babel `version: "legacy"`), so applying
// @reactive passes the LEGACY call shape (target, propertyKey, descriptor) --
// the 2nd arg is a string key, not a standard context. The package must reject
// this at decoration time (module evaluation), so a dynamic import REJECTS with
// the named "legacy decorator call" TypeError. ASCII-only.
//
// @ts-nocheck -- this file is intentionally mis-decorated for the legacy emit;
// its type-correctness is irrelevant, only its runtime throw matters.
import { reactive } from "../../../SignalDecorators.js";
let LegacyVM = (_class = class LegacyVM {
  value() {
    return 0;
  }
}, _applyDecoratedDescriptor(_class.prototype, "value", [reactive], Object.getOwnPropertyDescriptor(_class.prototype, "value"), _class.prototype), _class); // Reference the class so bundlers/emitters cannot elide the decoration.
export const kind = typeof LegacyVM;
