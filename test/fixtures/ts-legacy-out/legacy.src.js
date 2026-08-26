var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
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
class LegacyVM {
    value() {
        return 0;
    }
}
__decorate([
    reactive
], LegacyVM.prototype, "value", null);
// Reference the class so bundlers/emitters cannot elide the decoration.
export const kind = typeof LegacyVM;
