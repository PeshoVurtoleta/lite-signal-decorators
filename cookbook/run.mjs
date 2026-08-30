#!/usr/bin/env node
// cookbook/run.mjs -- the executable lane for the COOKBOOK.md companion corpus
// (CB-T5, PD-37). Every recipe in cookbook/manifest.json has a standalone
// companion; this runner spawns each as a SERIAL child process under
// `node --expose-gc`, exactly as test/torture/run.mjs does. Process isolation
// is deliberate: the gated recipes assert on GLOBAL default-registry stats(),
// so two in one process would let the first's residue poison the second's
// baseline. The runner keys on CHILD EXIT CODE, streaming each companion's one
// summary line for the reader.
//
// Usage:
//   node cookbook/run.mjs                 # run all companions (default)
//   node cookbook/run.mjs --controls      # sabotage each gated recipe with
//                                         # COOKBOOK_BREAK=<id>; each MUST fail
//   node cookbook/run.mjs --list          # print the manifest table and exit
//
// Runner-level FAILURES (honesty enforced, not requested):
//   - a gc:"none" recipe whose `reason` is empty or missing;
//   - a companion file named by the manifest that is missing on disk;
//   - a companion that exits non-zero (default mode);
//   - a gated companion that exits ZERO under COOKBOOK_BREAK (--controls) --
//     a gate that cannot fail is not a gate.
//
// ASCII-only. node:child_process/fs/path/url only.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

// --- manifest -----------------------------------------------------------------

let manifest;
try {
    manifest = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
} catch (e) {
    process.stderr.write("cookbook: cannot read manifest.json -- " + e.message + "\n");
    process.exit(1);
}
const RECIPES = Array.isArray(manifest.recipes) ? manifest.recipes : [];
if (RECIPES.length === 0) {
    process.stderr.write("cookbook: manifest carries no recipes\n");
    process.exit(1);
}
const GATED = RECIPES.filter((r) => r.gc === "gated");

// --- argv ---------------------------------------------------------------------

const argv = process.argv.slice(2);
let list = false;
let controls = false;
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list" || a === "-l") list = true;
    else if (a === "--controls" || a === "-c") controls = true;
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else { process.stderr.write("unknown argument: " + a + "\n"); usage(); process.exit(2); }
}

function usage() {
    process.stdout.write(
        "lite-signal-decorators cookbook runner\n\n" +
        "  node cookbook/run.mjs [flags]\n\n" +
        "  --list, -l        print the manifest table and exit\n" +
        "  --controls, -c    sabotage each gated recipe (COOKBOOK_BREAK); each must fail\n",
    );
}

if (list) {
    process.stdout.write("  id".padEnd(6) + "gc".padEnd(8) + "tier".padEnd(9) + "companion\n");
    for (const r of RECIPES) {
        process.stdout.write(
            "  " + String(r.id).padEnd(4) + String(r.gc).padEnd(8) +
            String(r.tier).padEnd(9) + String(r.companion) + "\n",
        );
    }
    process.exit(0);
}

// --- manifest honesty gate (both run modes) -----------------------------------
// A gc:"none" recipe must publish a real reason, and every named companion must
// exist on disk. Either breach is a runner FAILURE before a single child runs.

const manifestErrors = [];
for (const r of RECIPES) {
    if (r.gc !== "none" && r.gc !== "gated") {
        manifestErrors.push(r.id + ': gc must be "none" or "gated", got "' + r.gc + '"');
    }
    if (r.gc === "none" && (typeof r.reason !== "string" || r.reason.trim() === "")) {
        manifestErrors.push(r.id + ': gc "none" requires a non-empty reason');
    }
    if (typeof r.companion !== "string" || !existsSync(join(ROOT, r.companion))) {
        manifestErrors.push(r.id + ": companion missing -- " + r.companion);
    }
}
if (manifestErrors.length > 0) {
    process.stderr.write("cookbook: manifest is not honest --\n");
    for (const m of manifestErrors) process.stderr.write("  " + m + "\n");
    process.exit(1);
}

// --- child spawn --------------------------------------------------------------

const TAIL_LINES = 24;

function quoteTail(child) {
    const out = (child.stdout || "") + (child.stderr || "");
    const lines = out.split("\n");
    const start = Math.max(0, lines.length - TAIL_LINES);
    process.stderr.write("  --- output tail ---\n");
    for (let i = start; i < lines.length; i++) {
        if (lines[i].length > 0) process.stderr.write("  | " + lines[i] + "\n");
    }
}

function summaryLine(child) {
    const lines = (child.stdout || "").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i].trim().length > 0) return lines[i].trim();
    }
    return "(no summary line)";
}

function spawnCompanion(recipe, breakId) {
    const env = { ...process.env };
    if (breakId !== undefined) env.COOKBOOK_BREAK = breakId;
    else delete env.COOKBOOK_BREAK;
    return spawnSync(
        process.execPath,
        ["--expose-gc", join(ROOT, recipe.companion)],
        { encoding: "utf8", env },
    );
}

// --- run ----------------------------------------------------------------------

const t0 = Date.now();
const results = [];

if (controls) {
    // Each gated recipe must sabotage its own measured loop under COOKBOOK_BREAK
    // and exit NON-ZERO. A control that still exits 0 means the gate cannot fail.
    for (const r of GATED) {
        const started = Date.now();
        const child = spawnCompanion(r, r.id);
        const code = child.status;
        let ok, detail;
        if (code === 0) { ok = false; detail = "exited 0 -- the gate cannot fail"; quoteTail(child); }
        else if (code === null) { ok = false; detail = "killed (" + (child.signal || "unknown") + ")"; quoteTail(child); }
        else { ok = true; detail = "broke as required (exit " + code + ")"; }
        results.push({ id: r.id, ok, detail, ms: Date.now() - started });
    }
} else {
    for (const r of RECIPES) {
        const started = Date.now();
        const child = spawnCompanion(r, undefined);
        const code = child.status;
        let ok, detail;
        if (code === 0) { ok = true; detail = summaryLine(child); }
        else if (code === null) { ok = false; detail = "killed (" + (child.signal || "unknown") + ")"; quoteTail(child); }
        else { ok = false; detail = "exit " + code; quoteTail(child); }
        results.push({ id: r.id, ok, detail, ms: Date.now() - started });
    }
}

// --- summary ------------------------------------------------------------------

const dt = ((Date.now() - t0) / 1000).toFixed(1);
process.stdout.write("\n" + "-".repeat(70) + "\n");
for (const r of results) {
    const tag = r.ok ? "ok  " : "FAIL";
    process.stdout.write("  " + String(r.id).padEnd(5) + tag + "  " + String(r.ms).padStart(6) + "ms  " + r.detail + "\n");
}

const passed = results.filter((r) => r.ok).length;
const total = results.length;
process.stdout.write("-".repeat(70) + "\n");

if (controls) {
    const line = passed + "/" + total + " controls fail correctly";
    process.stdout.write("cookbook lane: " + line + " in " + dt + "s\n");
    process.exit(passed === total ? 0 : 1);
}

process.stdout.write("cookbook lane: " + passed + "/" + total + " companions ok in " + dt + "s\n");
process.exit(passed === total ? 0 : 1);
