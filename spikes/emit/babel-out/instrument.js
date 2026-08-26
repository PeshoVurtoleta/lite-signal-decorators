// instrument.ts -- instrumented standard decorators for the S0 emit spikes.
// Each decorator pushes [phase, kind, name, tag] tuples into a module-level LOG
// exposed on globalThis.__EMIT_LOG. Compiled twice (TS + Babel) by regen.mjs.
// ASCII-only.

export const LOG = [];
globalThis.__EMIT_LOG = LOG;

// mark(tag) returns a decorator usable on accessor | getter | method | class.
// It records apply order (L1/L7), accessor init timing (L2), method/getter
// addInitializer timing (L3), and context.metadata presence (L5).
export function mark(tag) {
  return function (value, ctx) {
    // L6 companion: capture the standard call shape once.
    if (!globalThis.__STANDARD_ARGS) {
      globalThis.__STANDARD_ARGS = {
        typeofs: [typeof value, typeof ctx],
        secondHasKind: typeof (ctx && ctx.kind) === "string"
      };
    }
    LOG.push(["apply", ctx.kind, String(ctx.name), tag]); // L1/L7
    if (ctx.metadata) LOG.push(["meta-present", ctx.kind, String(ctx.name), tag]); // L5
    if (ctx.kind === "accessor") {
      return {
        init(v) {
          LOG.push(["init", "accessor", String(ctx.name), tag]); // L2
          return v;
        },
        get() {
          return value.get.call(this);
        },
        set(x) {
          value.set.call(this, x);
        }
      };
    }
    if (ctx.addInitializer) {
      ctx.addInitializer(function () {
        LOG.push(["addInit", ctx.kind, String(ctx.name), tag]); // L3 (the D-01 trap)
      });
    }
    return value;
  };
}

// L8 exhibit: a class decorator that REPLACES the class with a subclass.
export function replaceClass(value, ctx) {
  LOG.push(["apply", ctx.kind, String(ctx.name), "replaceClass"]);
  return class Replaced extends value {};
}

// L6 detector data: records the argument typeof tuple of whatever call shape it
// receives. Under standard emit the 2nd arg is a context object with a string
// .kind; under legacy emit the 2nd arg is the property key (a string).
export function legacyShapeProbe(...args) {
  globalThis.__LEGACY_ARGS = {
    typeofs: args.map(a => typeof a),
    secondIsString: typeof args[1] === "string",
    secondHasKind: typeof (args[1] && args[1].kind) === "string"
  };
  return undefined;
}
