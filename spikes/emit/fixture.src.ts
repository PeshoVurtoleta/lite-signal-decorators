// fixture.src.ts -- one class family exercising emit laws L1..L8 in a single
// compile. Imports only the instrumented decorators (the package has no source
// in S0). The ".js" extension is required so Node ESM resolves the emitted
// output at runtime; TS bundler resolution and Babel both tolerate it. ASCII-only.

import { mark, replaceClass } from "./instrument.js";

@mark("C-class")
class Base {
  @mark("A-x") accessor x = 1; // L2: init at field-def time
  @mark("A-y") accessor y = this.x + 1; // L2: declaration order -> x's box exists
  @mark("G-d") get d() {
    return this.x * 2;
  }
  @mark("M-m") m() {
    return this.x;
  }
  // L3 witness: this field-init reads this.y (accessor init must have run) and
  // is stamped into __EMIT_LOG so its index is comparable with addInit indices.
  field = (() => {
    const g = globalThis as any;
    (g.__FIELD_LOG ||= []).push(["field-init", "y-visible", this.y]);
    g.__EMIT_LOG.push(["field-init", "field", "field", this.y]);
    return 0;
  })();
  @mark("S-s") static accessor s = 0; // static lane (L8 note; emit ordering only)
  constructor() {
    // L4: new.target inside the base ctor names the most-derived ctor.
    ((globalThis as any).__NT ||= []).push(new.target ? new.target.name : "undefined");
  }
}

class Derived extends Base {
  // L4 + most-derived rule input
  @mark("D-x2") accessor x2 = 10;
}

class Plain extends Base {} // undecorated subclass (most-derived-rule input)

const sym = Symbol("k");
class Symbolic {
  @mark("SYM") accessor [sym] = 5; // symbol-named member
}

// L8 replacement exhibit: @replaceClass returns a subclass named "Replaced".
@replaceClass
class Replaceable {
  @mark("R-a") accessor a = 7;
}

// Construct once each so decorators apply and initializers run. Order matters
// for L4: Derived is constructed LAST so __NT's final entry is "Derived".
const base = new Base();
const plain = new Plain();
const symbolic = new Symbolic();
const replaceable = new Replaceable();
const derived = new Derived();

const symMeta = (Symbol as any).metadata;
const symMetaDefined = typeof symMeta !== "undefined" && symMeta !== null;

(globalThis as any).__FIXTURE_RESULT = {
  baseX: base.x,
  baseY: base.y,
  baseD: base.d,
  baseM: base.m(),
  baseInstanceofBase: base instanceof Base,
  derivedInstanceofBase: derived instanceof Base,
  plainInstanceofBase: plain instanceof Base,
  symbolicVal: (symbolic as any)[sym],
  replaceableInstanceof: replaceable instanceof Replaceable,
  replaceableName: replaceable.constructor.name,
  staticS: (Base as any).s,
  symMetaDefined,
  baseMetadata: symMetaDefined ? (Base as any)[symMeta] != null : false,
  derivedInheritsBaseMetadata: symMetaDefined
    ? (Derived as any)[symMeta] != null && (Derived as any)[symMeta] === (Base as any)[symMeta]
    : false,
};

export {};
