// test/fixtures/regen.mjs -- regenerate the compiled decorator fixtures and the
// freshness manifest. Compiles, from test/fixtures/src/:
//   fixture.src.ts + static.src.ts  --standard--> ts-out/  AND  babel-out/
//   legacy.src.ts                   --legacy---->  ts-legacy-out/ AND babel-legacy-out/
// then writes hashes.json (sha256 of every src + out file, keys sorted). Runs
// from anywhere; module resolution is anchored to the package dir. Idempotent:
// a second run produces byte-identical output (tsc/babel are deterministic here;
// the fixtures carry no timestamps). ASCII-only. Run: `node test/fixtures/regen.mjs`.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    readFileSync,
    writeFileSync,
    mkdirSync,
    rmSync,
    readdirSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as babel from "@babel/core";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../test/fixtures
const SRC = join(HERE, "src");
const PKG = resolve(HERE, "..", ".."); // package dir
const TSC = join(PKG, "node_modules", "typescript", "bin", "tsc");

const TS_OUT = join(HERE, "ts-out");
const BABEL_OUT = join(HERE, "babel-out");
const TS_LEGACY_OUT = join(HERE, "ts-legacy-out");
const BABEL_LEGACY_OUT = join(HERE, "babel-legacy-out");

function reset(dir) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
}

// ---- TS compile --------------------------------------------------------------

function tsc(args, label) {
    const r = spawnSync(process.execPath, [TSC, ...args], {
        cwd: PKG,
        encoding: "utf8",
    });
    if (r.status !== 0) {
        process.stderr.write(
            "[regen] tsc " + label + " FAILED (status " + r.status + ")\n",
        );
        process.stderr.write((r.stdout || "") + (r.stderr || "") + "\n");
        process.exit(1);
    }
    return r;
}

reset(TS_OUT);
reset(TS_LEGACY_OUT);

// Standard emit (experimentalDecorators false). Try module es2022; if the
// module/resolution pairing is rejected, fall back to esnext (mirrors the S0
// spike's proven pattern).
function tscStandard(moduleMode) {
    return spawnSync(
        process.execPath,
        [
            TSC,
            "--target", "es2022",
            "--module", moduleMode,
            "--experimentalDecorators", "false",
            "--moduleResolution", "bundler",
            "--skipLibCheck",
            "--rootDir", SRC,
            "--outDir", TS_OUT,
            join(SRC, "fixture.src.ts"),
            join(SRC, "static.src.ts"),
        ],
        { cwd: PKG, encoding: "utf8" },
    );
}
{
    const r = tscStandard("es2022");
    if (r.status !== 0) {
        process.stderr.write("[regen] tsc standard(es2022) non-zero, retrying esnext\n");
        const r2 = tscStandard("esnext");
        if (r2.status !== 0) {
            process.stderr.write("[regen] tsc standard FAILED (status " + r2.status + ")\n");
            process.stderr.write((r2.stdout || "") + (r2.stderr || "") + "\n");
            process.exit(1);
        }
    }
}

// Legacy emit (experimentalDecorators true, no metadata).
tsc(
    [
        "--target", "es2022",
        "--module", "es2022",
        "--experimentalDecorators", "true",
        "--emitDecoratorMetadata", "false",
        "--moduleResolution", "bundler",
        "--skipLibCheck",
        "--rootDir", SRC,
        "--outDir", TS_LEGACY_OUT,
        join(SRC, "legacy.src.ts"),
    ],
    "legacy",
);

// ---- Babel compile -----------------------------------------------------------

reset(BABEL_OUT);
reset(BABEL_LEGACY_OUT);

function babelStandard(file) {
    return babel.transformFileSync(file, {
        filename: file,
        cwd: PKG,
        configFile: false,
        babelrc: false,
        presets: [
            ["@babel/preset-typescript", { onlyRemoveTypeImports: true, allowDeclareFields: true }],
        ],
        plugins: [["@babel/plugin-proposal-decorators", { version: "2023-11" }]],
    });
}

function babelLegacy(file) {
    return babel.transformFileSync(file, {
        filename: file,
        cwd: PKG,
        configFile: false,
        babelrc: false,
        presets: [
            ["@babel/preset-typescript", { onlyRemoveTypeImports: true, allowDeclareFields: true }],
        ],
        plugins: [["@babel/plugin-proposal-decorators", { version: "legacy" }]],
    });
}

for (const name of ["fixture.src", "static.src"]) {
    const out = babelStandard(join(SRC, name + ".ts"));
    writeFileSync(join(BABEL_OUT, name + ".js"), out.code + "\n");
}
{
    const out = babelLegacy(join(SRC, "legacy.src.ts"));
    writeFileSync(join(BABEL_LEGACY_OUT, "legacy.src.js"), out.code + "\n");
}

// ---- hashes ------------------------------------------------------------------
// One flat map keyed by path relative to test/fixtures/, over every source .ts
// and every emitted .js, keys sorted for deterministic output.

function sha256(file) {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function collect(dir, prefix, ext, into) {
    for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith(ext)) continue;
        into[prefix + "/" + f] = sha256(join(dir, f));
    }
}

const flat = {};
collect(SRC, "src", ".ts", flat);
collect(TS_OUT, "ts-out", ".js", flat);
collect(BABEL_OUT, "babel-out", ".js", flat);
collect(TS_LEGACY_OUT, "ts-legacy-out", ".js", flat);
collect(BABEL_LEGACY_OUT, "babel-legacy-out", ".js", flat);

const sorted = {};
for (const k of Object.keys(flat).sort()) sorted[k] = flat[k];

writeFileSync(join(HERE, "hashes.json"), JSON.stringify(sorted, null, 2) + "\n");

const keys = Object.keys(sorted);
process.stdout.write("[regen] " + keys.length + " files hashed:\n");
for (const k of keys) process.stdout.write("  " + k + "  " + sorted[k].slice(0, 12) + "\n");
process.stdout.write("[regen] test/fixtures/hashes.json written\n");
