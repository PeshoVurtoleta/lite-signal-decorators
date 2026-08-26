// legacy.src.ts -- L6 second fixture. Compiled with experimentalDecorators:true
// (TS) and version:'legacy' (Babel) to capture the LEGACY call shape
// (target, key, descriptor). Self-contained: no import so it compiles under both
// legacy toolchains without extension-resolution concerns. ASCII-only.

function legacyProbe(...args: any[]) {
  (globalThis as any).__LEGACY_ARGS = {
    typeofs: args.map((a) => typeof a),
    secondIsString: typeof args[1] === "string",
    secondHasKind: typeof (args[1] && args[1].kind) === "string",
  };
  return undefined as any;
}

class L {
  @legacyProbe
  method() {
    return 1;
  }
}

new L();

export {};
