// probe.mjs -- evaluate emit laws L1..L8 against BOTH emitters' compiled output
// and print one verdict block per law with observed(ts) | observed(babel) |
// expected | verdict. Exits 0 iff every strict law (L1-L4, L6-L8) is PASS on
// both emitters; L5 is a record-and-report law (its expected value anticipates a
// context.metadata divergence). Run: node spikes/emit/probe.mjs. ASCII-only.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

// Base member decorator tags in source order (for L1/L7).
const BASE_MEMBERS = ["A-x", "A-y", "G-d", "M-m"];

function resetGlobals() {
  const g = globalThis;
  g.__EMIT_LOG = undefined;
  g.__FIELD_LOG = undefined;
  g.__NT = undefined;
  g.__STANDARD_ARGS = undefined;
  g.__FIXTURE_RESULT = undefined;
}

async function loadStandard(subdir) {
  resetGlobals();
  const url = pathToFileURL(join(HERE, subdir, "fixture.src.js")).href;
  await import(url);
  const g = globalThis;
  return {
    log: [...(g.__EMIT_LOG || [])],
    fieldLog: [...(g.__FIELD_LOG || [])],
    nt: [...(g.__NT || [])],
    std: g.__STANDARD_ARGS ? { ...g.__STANDARD_ARGS } : null,
    result: g.__FIXTURE_RESULT ? { ...g.__FIXTURE_RESULT } : null,
  };
}

async function loadLegacy(subdir) {
  globalThis.__LEGACY_ARGS = undefined;
  const url = pathToFileURL(join(HERE, subdir, "legacy.src.js")).href;
  await import(url);
  return globalThis.__LEGACY_ARGS ? { ...globalThis.__LEGACY_ARGS } : null;
}

// ---- small log query helpers ---------------------------------------------
function firstIndex(log, pred) {
  for (let i = 0; i < log.length; i++) if (pred(log[i])) return i;
  return -1;
}
function applyIndexByTag(log, tag) {
  return firstIndex(log, (e) => e[0] === "apply" && e[3] === tag);
}
function applyIndexByName(log, kind, name) {
  return firstIndex(log, (e) => e[0] === "apply" && e[1] === kind && e[2] === name);
}

// ---- law evaluators -------------------------------------------------------
// Each returns { ts, babel, expected, verdict, strict }.
// strict=true means a ts/babel disagreement is a FAIL. L5 is strict=false.

function L1(ts, babel) {
  const expected = "member applies x,y,d,m in source order; class applies after all members";
  function obs(s) {
    const idx = BASE_MEMBERS.map((t) => applyIndexByTag(s.log, t));
    const classIdx = applyIndexByTag(s.log, "C-class");
    const staticIdx = applyIndexByTag(s.log, "S-s");
    const ordered = idx.every((v, i) => i === 0 || (v > idx[i - 1] && v >= 0));
    const classLast = classIdx > Math.max(...idx);
    return {
      ok: ordered && classLast && idx.every((v) => v >= 0),
      text:
        "x,y,d,m@[" + idx.join(",") + "] class@" + classIdx +
        " (static s@" + staticIdx + " applies first)",
    };
  }
  const a = obs(ts), b = obs(babel);
  return {
    ts: a.text, babel: b.text, expected,
    verdict: a.ok && b.ok ? "PASS" : "FAIL", strict: true, diverge: a.ok !== b.ok,
  };
}

function L2(ts, babel) {
  const expected = "init accessor x before init accessor y; base.y === 2";
  function obs(s) {
    const xi = firstIndex(s.log, (e) => e[0] === "init" && e[3] === "A-x");
    const yi = firstIndex(s.log, (e) => e[0] === "init" && e[3] === "A-y");
    const y = s.result ? s.result.baseY : NaN;
    return { ok: xi >= 0 && yi > xi && y === 2, text: "init x@" + xi + " < init y@" + yi + "; baseY=" + y };
  }
  const a = obs(ts), b = obs(babel);
  return { ts: a.text, babel: b.text, expected, verdict: a.ok && b.ok ? "PASS" : "FAIL", strict: true, diverge: a.ok !== b.ok };
}

function L3(ts, babel) {
  const expected = "first addInit(method m) index < first field-init index (D-01 trap)";
  function obs(s) {
    const ai = firstIndex(s.log, (e) => e[0] === "addInit" && e[3] === "M-m");
    const fi = firstIndex(s.log, (e) => e[0] === "field-init");
    const di = firstIndex(s.log, (e) => e[0] === "addInit" && e[3] === "G-d");
    return {
      ok: ai >= 0 && fi >= 0 && ai < fi,
      text: "addInit m@" + ai + " (getter d@" + di + ") < field-init@" + fi,
    };
  }
  const a = obs(ts), b = obs(babel);
  return { ts: a.text, babel: b.text, expected, verdict: a.ok && b.ok ? "PASS" : "FAIL", strict: true, diverge: a.ok !== b.ok };
}

function L4(ts, babel) {
  const expected = 'new Derived() -> Base ctor new.target is "Derived" (most-derived)';
  function obs(s) {
    const last = s.nt.length ? s.nt[s.nt.length - 1] : "(none)";
    return { ok: last === "Derived", text: "__NT=" + JSON.stringify(s.nt) + " last=" + last };
  }
  const a = obs(ts), b = obs(babel);
  return { ts: a.text, babel: b.text, expected, verdict: a.ok && b.ok ? "PASS" : "FAIL", strict: true, diverge: a.ok !== b.ok };
}

function L5(ts, babel) {
  const expected =
    "record actual: host Symbol.metadata undefined; emitters MAY expose a context.metadata object";
  function obs(s) {
    const metaCount = s.log.filter((e) => e[0] === "meta-present").length;
    const r = s.result || {};
    return {
      text:
        "ctx.metadata present on " + metaCount + " applies; " +
        "Symbol.metadata defined=" + r.symMetaDefined +
        "; Class[Symbol.metadata] Base->Derived inherits=" + r.derivedInheritsBaseMetadata,
      metaCount,
    };
  }
  const a = obs(ts), b = obs(babel);
  // Not strict: divergence in ctx.metadata is anticipated by the law itself.
  const diverge = (a.metaCount > 0) !== (b.metaCount > 0);
  const verdict = diverge ? "RECORD(DIVERGE)" : "RECORD(agree)";
  return { ts: a.text, babel: b.text, expected, verdict, strict: false, diverge };
}

function L6(ts, babel, tsLeg, babelLeg) {
  const expected =
    "standard 2nd arg has string .kind; legacy 2nd arg is the string key (no .kind). Predicate: typeof arg2.kind === 'string'";
  function stdText(s) {
    return "std typeofs=" + JSON.stringify(s.std.typeofs) + " secondHasKind=" + s.std.secondHasKind;
  }
  function legText(l) {
    return "legacy typeofs=" + JSON.stringify(l.typeofs) + " secondHasKind=" + l.secondHasKind +
      " secondIsString=" + l.secondIsString;
  }
  const tsOk = ts.std.secondHasKind === true && tsLeg.secondHasKind === false && tsLeg.secondIsString === true;
  const bOk = babel.std.secondHasKind === true && babelLeg.secondHasKind === false && babelLeg.secondIsString === true;
  return {
    ts: stdText(ts) + " | " + legText(tsLeg),
    babel: stdText(babel) + " | " + legText(babelLeg),
    expected,
    verdict: tsOk && bOk ? "PASS" : "FAIL",
    strict: true,
    diverge: tsOk !== bOk,
  };
}

function L7(ts, babel) {
  const expected = "factory @mark(tag) applies carry the exact tag argument for each member";
  const wants = [
    ["accessor", "x", "A-x"],
    ["accessor", "y", "A-y"],
    ["getter", "d", "G-d"],
    ["method", "m", "M-m"],
    ["class", "Base", "C-class"],
  ];
  function obs(s) {
    let ok = true;
    const seen = [];
    for (const [kind, name, tag] of wants) {
      const i = applyIndexByName(s.log, kind, name);
      const got = i >= 0 ? s.log[i][3] : "(missing)";
      seen.push(name + ":" + got);
      if (got !== tag) ok = false;
    }
    return { ok, text: seen.join(" ") };
  }
  const a = obs(ts), b = obs(babel);
  return { ts: a.text, babel: b.text, expected, verdict: a.ok && b.ok ? "PASS" : "FAIL", strict: true, diverge: a.ok !== b.ok };
}

function L8(ts, babel) {
  const expected =
    "identity-return class dec: new Base() instanceof Base; replacement class dec: instance still instanceof, ctor.name=Replaced";
  function obs(s) {
    const r = s.result || {};
    const ok = r.baseInstanceofBase === true && r.replaceableInstanceof === true && r.replaceableName === "Replaced";
    return {
      ok,
      text:
        "base instanceof Base=" + r.baseInstanceofBase +
        "; replaceable instanceof=" + r.replaceableInstanceof +
        " name=" + r.replaceableName,
    };
  }
  const a = obs(ts), b = obs(babel);
  return { ts: a.text, babel: b.text, expected, verdict: a.ok && b.ok ? "PASS" : "FAIL", strict: true, diverge: a.ok !== b.ok };
}

// ---- run ------------------------------------------------------------------
const ts = await loadStandard("ts-out");
const babel = await loadStandard("babel-out");
const tsLeg = await loadLegacy("ts-legacy-out");
const babelLeg = await loadLegacy("babel-legacy-out");

const laws = [
  ["L1 apply order + class-last", L1(ts, babel)],
  ["L2 accessor init order", L2(ts, babel)],
  ["L3 addInit before field-init", L3(ts, babel)],
  ["L4 new.target most-derived", L4(ts, babel)],
  ["L5 context/Symbol.metadata", L5(ts, babel)],
  ["L6 legacy vs standard shape", L6(ts, babel, tsLeg, babelLeg)],
  ["L7 factory args on apply", L7(ts, babel)],
  ["L8 class-dec identity/replace", L8(ts, babel)],
];

const SEP = "-".repeat(78);
process.stdout.write(SEP + "\n");
process.stdout.write("SPIKE emit -- L1..L8 on TS (standard) and Babel (standard)\n");
process.stdout.write(SEP + "\n");

let strictFail = false;
const divergences = [];
for (const [title, r] of laws) {
  if (r.strict && r.verdict !== "PASS") strictFail = true;
  if (r.diverge) divergences.push([title, r]);
  process.stdout.write(title + "  [" + r.verdict + "]\n");
  process.stdout.write("  expected: " + r.expected + "\n");
  process.stdout.write("  ts:       " + r.ts + "\n");
  process.stdout.write("  babel:    " + r.babel + "\n");
  process.stdout.write("\n");
}

// Compact verdict table.
process.stdout.write(SEP + "\n");
process.stdout.write("law                              | verdict\n");
process.stdout.write(SEP + "\n");
for (const [title, r] of laws) {
  process.stdout.write(title.padEnd(32) + " | " + r.verdict + "\n");
}
process.stdout.write(SEP + "\n");

// Divergence report (ts vs babel differ in observed text).
process.stdout.write("TS/Babel semantic divergences (law-relevant outcome differs):\n");
if (divergences.length === 0) {
  process.stdout.write("  (none -- every law's outcome is identical on both emitters)\n");
} else {
  for (const [title, r] of divergences) {
    const strictNote = r.strict ? "STRICT-FAIL" : "recorded (within law's expected)";
    process.stdout.write("  " + title + " -> " + strictNote + "\n");
    process.stdout.write("     ts:    " + r.ts + "\n");
    process.stdout.write("     babel: " + r.babel + "\n");
  }
}
process.stdout.write(SEP + "\n");

// Detection predicate summary (L6).
process.stdout.write("Legacy-vs-standard detection predicate: typeof arg2 === 'object' && typeof arg2.kind === 'string' => STANDARD; else LEGACY\n");
process.stdout.write("  standard(ts):    " + JSON.stringify(ts.std) + "\n");
process.stdout.write("  standard(babel): " + JSON.stringify(babel.std) + "\n");
process.stdout.write("  legacy(ts):      " + JSON.stringify(tsLeg) + "\n");
process.stdout.write("  legacy(babel):   " + JSON.stringify(babelLeg) + "\n");
process.stdout.write(SEP + "\n");

const pass = !strictFail;
process.stdout.write("SPIKE emit: " + (pass ? "PASS" : "FAIL") + "\n");
process.exit(pass ? 0 : 1);
