// legacy.src.ts -- L6 second fixture. Compiled with experimentalDecorators:true
// (TS) and version:'legacy' (Babel) to capture the LEGACY call shape
// (target, key, descriptor). Self-contained: no import so it compiles under both
// legacy toolchains without extension-resolution concerns. ASCII-only.
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
function legacyProbe(...args) {
    globalThis.__LEGACY_ARGS = {
        typeofs: args.map((a) => typeof a),
        secondIsString: typeof args[1] === "string",
        secondHasKind: typeof (args[1] && args[1].kind) === "string",
    };
    return undefined;
}
class L {
    method() {
        return 1;
    }
}
__decorate([
    legacyProbe
], L.prototype, "method", null);
new L();
export {};
