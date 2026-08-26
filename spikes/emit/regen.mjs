// regen.mjs -- compile the emit fixtures twice (TS + Babel), for both standard
// and legacy decorator emit, into ts-out/ babel-out/ ts-legacy-out/
// babel-legacy-out/, then write hashes.json. Idempotent. Run from the package
// dir: `node spikes/emit/regen.mjs`. ASCII-only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as babel from "@babel/core";

const HERE = dirname(fileURLToPath(import.meta.url)); // .../spikes/emit
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

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function dirBytesAndHashes(dir) {
  const out = {};
  let total = 0;
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".js") && !f.endsWith(".mjs")) continue;
    const p = join(dir, f);
    const buf = readFileSync(p);
    total += buf.length;
    out[f] = createHash("sha256").update(buf).digest("hex");
  }
  return { hashes: out, total, count: Object.keys(out).length };
}

// ---- TS compile ----------------------------------------------------------
function tsc(args, label) {
  const r = spawnSync(process.execPath, [TSC, ...args], {
    cwd: PKG,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    process.stderr.write("[regen] tsc " + label + " FAILED (status " + r.status + ")\n");
    process.stderr.write((r.stdout || "") + (r.stderr || "") + "\n");
    process.exit(1);
  }
  return r;
}

reset(TS_OUT);
reset(TS_LEGACY_OUT);

// Standard emit: experimentalDecorators false. Try bundler resolution; if TS
// rejects the module/resolution pairing, fall back to esnext + bundler.
function tscStandard(moduleMode) {
  return tsc(
    [
      "--target", "es2022",
      "--module", moduleMode,
      "--experimentalDecorators", "false",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
      "--outDir", TS_OUT,
      join(HERE, "fixture.src.ts"),
      join(HERE, "instrument.ts"),
    ],
    "standard(" + moduleMode + ")"
  );
}
{
  const r = spawnSync(
    process.execPath,
    [
      TSC,
      "--target", "es2022",
      "--module", "es2022",
      "--experimentalDecorators", "false",
      "--moduleResolution", "bundler",
      "--skipLibCheck",
      "--outDir", TS_OUT,
      join(HERE, "fixture.src.ts"),
      join(HERE, "instrument.ts"),
    ],
    { cwd: PKG, encoding: "utf8" }
  );
  if (r.status !== 0) {
    // bundler resolution may require module esnext; retry.
    process.stderr.write("[regen] tsc standard(es2022) non-zero, retrying with esnext\n");
    tscStandard("esnext");
  }
}

// Legacy emit: experimentalDecorators true, no metadata.
tsc(
  [
    "--target", "es2022",
    "--module", "es2022",
    "--experimentalDecorators", "true",
    "--emitDecoratorMetadata", "false",
    "--moduleResolution", "bundler",
    "--skipLibCheck",
    "--outDir", TS_LEGACY_OUT,
    join(HERE, "legacy.src.ts"),
  ],
  "legacy"
);

// ---- Babel compile -------------------------------------------------------
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

// Output Babel as .js so the source import "./instrument.js" resolves (package
// is type:module, so .js is ESM) and probe imports the same "fixture.src.js".
for (const name of ["instrument", "fixture.src"]) {
  const out = babelStandard(join(HERE, name + ".ts"));
  writeFileSync(join(BABEL_OUT, name + ".js"), out.code + "\n");
}
{
  const out = babelLegacy(join(HERE, "legacy.src.ts"));
  writeFileSync(join(BABEL_LEGACY_OUT, "legacy.src.js"), out.code + "\n");
}

// ---- hashes + table ------------------------------------------------------
const tsStd = dirBytesAndHashes(TS_OUT);
const babelStd = dirBytesAndHashes(BABEL_OUT);
const tsLeg = dirBytesAndHashes(TS_LEGACY_OUT);
const babelLeg = dirBytesAndHashes(BABEL_LEGACY_OUT);

writeFileSync(
  join(HERE, "hashes.json"),
  JSON.stringify(
    {
      ts: tsStd.hashes,
      babel: babelStd.hashes,
      tsLegacy: tsLeg.hashes,
      babelLegacy: babelLeg.hashes,
    },
    null,
    2
  ) + "\n"
);

function row(label, d) {
  return (
    "  " +
    label.padEnd(16) +
    String(d.count).padStart(5) +
    String(d.total).padStart(12) +
    "   ok"
  );
}
process.stdout.write("emitter            files  totalBytes   ok\n");
process.stdout.write(row("ts (standard)", tsStd) + "\n");
process.stdout.write(row("babel (standard)", babelStd) + "\n");
process.stdout.write(row("ts (legacy)", tsLeg) + "\n");
process.stdout.write(row("babel (legacy)", babelLeg) + "\n");
process.stdout.write("[regen] hashes.json written\n");
