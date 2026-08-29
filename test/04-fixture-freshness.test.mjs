// test/04-fixture-freshness.test.mjs -- the compiled fixtures must match their
// sources. Recompute sha256 over every src + out file and compare against the
// checked-in test/fixtures/hashes.json. On ANY drift (a source edited without a
// recompile, or a stale/missing emit), fail with an actionable message telling
// the reader to run `npm run fixtures`. ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderEmitMatrix } from "./fixtures/emit-matrix.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const SRC = join(FIX, "src");
const README = join(HERE, "..", "README.md");

function sha256(file) {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function collect(dir, prefix, ext, into) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
        if (!f.endsWith(ext)) continue;
        into[prefix + "/" + f] = sha256(join(dir, f));
    }
}

test("compiled fixtures are fresh vs hashes.json (else run `npm run fixtures`)", () => {
    const manifestPath = join(FIX, "hashes.json");
    assert.ok(
        existsSync(manifestPath),
        "test/fixtures/hashes.json is missing -- run `npm run fixtures`",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

    const now = {};
    collect(SRC, "src", ".ts", now);
    collect(join(FIX, "ts-out"), "ts-out", ".js", now);
    collect(join(FIX, "babel-out"), "babel-out", ".js", now);
    collect(join(FIX, "ts-legacy-out"), "ts-legacy-out", ".js", now);
    collect(join(FIX, "babel-legacy-out"), "babel-legacy-out", ".js", now);

    const drift = [];
    for (const k of Object.keys(manifest)) {
        if (now[k] === undefined) drift.push(k + " -- missing (recompile needed)");
        else if (now[k] !== manifest[k]) drift.push(k + " -- changed");
    }
    for (const k of Object.keys(now)) {
        if (manifest[k] === undefined) drift.push(k + " -- not in manifest (recompile needed)");
    }

    assert.equal(
        drift.length,
        0,
        "fixture drift detected -- run `npm run fixtures`:\n  " + drift.join("\n  "),
    );
});

test("README emit-support matrix matches the generator (else regenerate the block)", () => {
    const readme = readFileSync(README, "utf8");
    const start = "<!-- EMIT-MATRIX:START -->";
    const end = "<!-- EMIT-MATRIX:END -->";
    const i = readme.indexOf(start);
    const j = readme.indexOf(end);
    assert.ok(i !== -1 && j !== -1 && j > i, "README emit-matrix markers are missing");
    const block = readme.slice(i + start.length, j).replace(/^\n/, "").replace(/\n$/, "");
    assert.equal(
        block,
        renderEmitMatrix(),
        "README emit-support matrix is stale -- regenerate it from " +
            "test/fixtures/emit-matrix.mjs (a fixture hash or toolchain version moved)",
    );
});
