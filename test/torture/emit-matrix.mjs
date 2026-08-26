// test/torture/emit-matrix.mjs -- node --expose-gc test/torture/emit-matrix.mjs
//
// The ONE scenario about the real emitters (every other scenario drives the
// mock). Two jobs:
//   1. fixture-hash freshness -- re-hash every src + emitted file inline and
//      compare against test/fixtures/hashes.json; drift means the committed
//      emit no longer matches the source, so the behavioral checks below are
//      testing stale bytes. (The hashing mirrors test/fixtures/regen.mjs; we do
//      NOT import regen -- it runs tsc/babel at module load.)
//   2. behavioral L-law consequences on BOTH the TS and the Babel emit:
//        L1  member decorators apply in SOURCE order WITH METHODS PRESENT, and
//            the class decorator applies LAST: the @reactiveEffect method
//            (declared mid-class) is claimed + wired (fires exactly once at
//            construction) and the @batched method is installed and callable at
//            its source position -- had reactiveHost applied before the member
//            decorators, neither would be in the plan;
//        L2  a field initializer reads an earlier accessor's live box
//            (`late === count + 1`);
//        L4  constructing Derived allocates exactly ONE anchor -- node delta is
//            its merged P+D+E+1 (6, with the onDb effect), never doubled for the
//            base chain;
//        L6  a dynamic import of the matching LEGACY out-dir rejects with the
//            named legacy-decorator error;
//        L8  the wrapper preserves `instanceof` the original class and its
//            `.name`.
//
// Completeness is itself gated: each emit that runs its four laws bumps a
// counter, cross-checked against the expected total. TORTURE_BREAK=emit-matrix
// skips the Babel half, and the counter mismatch is what catches the hole.
//
// ASCII-only.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { stats } from "@zakkster/lite-signal";
import { check, breakActive, pass, dieInfra } from "./helpers/harness.mjs";

const NAME = "emit-matrix";
const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "..", "fixtures");

// --- 1. fixture-hash freshness (inline; mirrors regen.mjs collect) ------------

function sha256(file) {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function collect(dir, prefix, ext, into) {
    for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith(ext)) continue;
        into[prefix + "/" + f] = sha256(join(dir, f));
    }
}

let manifest;
try {
    manifest = JSON.parse(readFileSync(join(FIX, "hashes.json"), "utf8"));
} catch (e) {
    dieInfra("cannot read test/fixtures/hashes.json -- run `npm run fixtures` (" + e.message + ")");
}

const fresh = {};
collect(join(FIX, "src"), "src", ".ts", fresh);
collect(join(FIX, "ts-out"), "ts-out", ".js", fresh);
collect(join(FIX, "babel-out"), "babel-out", ".js", fresh);
collect(join(FIX, "ts-legacy-out"), "ts-legacy-out", ".js", fresh);
collect(join(FIX, "babel-legacy-out"), "babel-legacy-out", ".js", fresh);

const manifestKeys = Object.keys(manifest).sort();
const freshKeys = Object.keys(fresh).sort();
check(
    manifestKeys.length === freshKeys.length,
    () => "fixture manifest has " + manifestKeys.length + " keys, recomputed " +
        freshKeys.length + " -- run `npm run fixtures`",
);
for (const k of freshKeys) {
    check(
        manifest[k] === fresh[k],
        () => "fixture drift at " + k + " -- run `npm run fixtures`",
    );
}

// --- 2. behavioral L-laws over both emits -------------------------------------

const tsNs = await import("../fixtures/ts-out/fixture.src.js");
const babelNs = await import("../fixtures/babel-out/fixture.src.js");

// Each entry: the emit namespace + its matching legacy out-dir specifier.
const EMITS = [
    { label: "ts", ns: tsNs, legacy: "../fixtures/ts-legacy-out/legacy.src.js" },
    { label: "babel", ns: babelNs, legacy: "../fixtures/babel-legacy-out/legacy.src.js" },
];

const LAWS_PER_EMIT = 5;
const EXPECTED_LAWS = EMITS.length * LAWS_PER_EMIT;
let lawsRun = 0;

for (const emit of EMITS) {
    // The self-sabotage: drop the Babel half. The completeness counter below is
    // what must notice the matrix is now incomplete.
    if (breakActive(NAME) && emit.label === "babel") continue;

    const ns = emit.ns;
    const pkg = ns.pkg;

    // L1 -- member decorators (INCLUDING methods) apply in source order; the
    // class decorator applies last. The @reactiveEffect method fires exactly
    // once at wiring and the @batched method is installed + callable.
    {
        const before = ns.effectFires.counter;
        const c = new ns.Counter();
        const fired = ns.effectFires.counter - before;
        check(fired === 1, () => emit.label + " L1: onCount wire-fire=" + fired + " expected 1");
        check(typeof c.onCount === "function", () => emit.label + " L1: effect public method onCount not installed");
        check(typeof c.bump === "function", () => emit.label + " L1: batched method bump not installed");
        const c0 = c.count;
        c.bump();                              // batched: count += 1 twice, coalesced
        check(c.count === c0 + 2, () => emit.label + " L1: bump advanced count to " + c.count + " expected " + (c0 + 2));
        pkg.disposeReactive(c);
        lawsRun++;
    }

    // L2 -- declaration-order field read sees an earlier accessor's live box.
    {
        const c = new ns.Counter();
        check(
            c.late === c.count + 1,
            () => emit.label + " L2: late=" + c.late + " expected count+1=" + (c.count + 1),
        );
        pkg.disposeReactive(c);
        lawsRun++;
    }

    // L4 -- a decorated subclass wires ONE anchor: Derived is P=2,D=2,E=1 (onDb)
    // -> delta 6.
    {
        const before = stats().activeNodes;
        const d = new ns.Derived();
        const delta = stats().activeNodes - before;
        check(
            delta === 6,
            () => emit.label + " L4: Derived node delta=" + delta + " expected 6 (single anchor)",
        );
        pkg.disposeReactive(d);
        lawsRun++;
    }

    // L6 -- importing the matching legacy emit rejects with the named error.
    {
        let rejected = false;
        let msg = "";
        try {
            await import(emit.legacy);
        } catch (e) {
            rejected = e instanceof TypeError && /legacy decorator call/.test(e.message);
            msg = e && e.message ? e.message : String(e);
        }
        check(
            rejected,
            () => emit.label + " L6: legacy import did not reject with the named legacy error (got: " + msg + ")",
        );
        lawsRun++;
    }

    // L8 -- instanceof + preserved .name across the wrapper.
    {
        const d = new ns.Derived();
        check(d instanceof ns.Base, () => emit.label + " L8: Derived not instanceof Base");
        check(ns.Derived.name === "Derived", () => emit.label + " L8: wrapper name=" + ns.Derived.name);
        check(ns.Base.name === "Base", () => emit.label + " L8: Base name=" + ns.Base.name);
        pkg.disposeReactive(d);
        lawsRun++;
    }
}

// Completeness gate: the whole matrix must have run. This is the assertion the
// TORTURE_BREAK half-run trips.
check(
    lawsRun === EXPECTED_LAWS,
    () => "incomplete matrix: ran " + lawsRun + " of " + EXPECTED_LAWS +
        " L-law checks -- an emit was skipped",
);

pass(NAME);
