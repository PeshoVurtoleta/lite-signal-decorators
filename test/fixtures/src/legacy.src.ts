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
    @reactive
    value() {
        return 0;
    }
}

// Reference the class so bundlers/emitters cannot elide the decoration.
export const kind = typeof LegacyVM;
