// static.src.ts -- a rejection fixture, compiled by BOTH standard emitters. It
// decorates a STATIC accessor with @reactive; L1 makes static member decorators
// apply first, so the package throws "cannot decorate the static member" at
// decoration time (module evaluation). A dynamic import therefore REJECTS with
// the named TypeError. ASCII-only.
//
// @ts-nocheck -- intentionally rejected usage; only its runtime throw matters.
import { reactive } from "../../../SignalDecorators.js";

class StaticVM {
    @reactive static accessor count = 0;
}

// Reference the class so the decoration is not elided.
export const kind = typeof StaticVM;
