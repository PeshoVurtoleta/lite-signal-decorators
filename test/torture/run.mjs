#!/usr/bin/env node
// test/torture/run.mjs -- the single entry point for the decorator torture
// suite (PLAN-S1 C-1). Each scenario is a standalone `node --expose-gc
// <file>.mjs` executable; the runner spawns them as SERIAL child processes
// rather than importing them. That is deliberate: every scenario asserts on
// GLOBAL pool accounting (stats() F-0) against the default lite-signal
// registry, so two in one process would let the first's residue poison the
// second's baseline. Process isolation is what makes those assertions mean
// anything.
//
// Usage:
//   node test/torture/run.mjs                    # every scenario
//   node test/torture/run.mjs --group semantic   # correctness lane (CI)
//   node test/torture/run.mjs --group soak       # resource soaks (churn-soak + fleet-soak)
//   node test/torture/run.mjs --list             # show the table and exit
//   node test/torture/run.mjs --bail             # stop at the first failure
//   node test/torture/run.mjs --lenient          # floor-escalation FAIL -> WARN
//   node test/torture/run.mjs --controls         # re-run each under TORTURE_BREAK,
//                                                # requiring a NON-ZERO exit
//
// Child exit-code contract (helpers/harness.mjs):
//   0  pass
//   1  fail
//   77 legitimate skip (installed peer below the scenario's floor)
//   78 harness/infrastructure error (a missing fixture, an unreadable manifest)
//
// Floor escalation: a child that exits 77 while the installed peer is AT or
// ABOVE its floor is a FAILURE, not a skip -- the surface should exist, so a
// skip can only mean a dropped export or a broken feature-detect. --lenient
// downgrades that single verdict to a WARN (the S4 peer-preview lane).
//
// ASCII-only. node:child_process/fs/path/url only.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));

const SKIP_EXIT = 77;
const INFRA_EXIT = 78;

// Scenario table. Most scenarios floor at 1.5.0 (signalBox/computedBox + owner
// descriptors); the two forward-compat scenarios floor higher (scope-adoption
// 1.6.0 for createScope, using-dispose 1.9.0 for the engine [Symbol.dispose]
// stamp) and SKIP (77) below their floor. The `semantic` group is the
// correctness lane, `soak` the wall-clock resource lane (churn-soak +
// fleet-soak).
const SCENARIOS = [
    { name: "emit-matrix", file: "emit-matrix.mjs", group: "semantic", floor: "1.5.0", about: "fixture-hash freshness + L-law consequences on both emits" },
    { name: "ordering-torture", file: "ordering-torture.mjs", group: "semantic", floor: "1.5.0", about: "PRNG shapes + full PD-8 rejection matrix" },
    { name: "lifecycle-torture", file: "lifecycle-torture.mjs", group: "semantic", floor: "1.5.0", about: "anchor/cascade/idempotency/DV-1/using" },
    { name: "pool-conservation", file: "pool-conservation.mjs", group: "semantic", floor: "1.5.0", about: "F-0 over churn + S1-A3 capacity-primed mid-wiring" },
    { name: "zerogc-torture", file: "zerogc-torture.mjs", group: "semantic", floor: "1.5.0", about: "zero-GC read/write lanes (maxMajor 0, maxPauseMs 4)" },
    { name: "capacity-torture", file: "capacity-torture.mjs", group: "semantic", floor: "1.5.0", about: "init/wiring capacity atomicity at every failure point x both paths (D-2h)" },
    { name: "disposed-poison", file: "disposed-poison.mjs", group: "semantic", floor: "1.5.0", about: "full post-dispose poison surface + resurrection storm (decorated + buildless)" },
    { name: "leak-torture", file: "leak-torture.mjs", group: "semantic", floor: "1.5.0", about: "lite-leak tracker over 4096 churn cycles (0 live / 0 findings / 0 warnings)" },
    { name: "oracle-fuzzer", file: "oracle-fuzzer.mjs", group: "semantic", floor: "1.5.0", about: "seeded shape fuzzer: decorated vs raw twin, values + fires + opcode tallies" },
    { name: "interop-torture", file: "interop-torture.mjs", group: "semantic", floor: "1.5.0", about: "decorated <-> raw in one graph + cross-registry + P-2 documented limits" },
    { name: "batch-untrack-torture", file: "batch-untrack-torture.mjs", group: "semantic", floor: "1.5.0", about: "@batched nesting/unwind + untrack dep-suppression + peek adds no edge" },
    { name: "reinit-torture", file: "reinit-torture.mjs", group: "semantic", floor: "1.5.0", about: "S6-A1 zero-delta-heap acquire/release + S6-A2 pooled retention + S6-A3 nine-transition park/reinit lattice" },
    { name: "scope-adoption", file: "scope-adoption.mjs", group: "semantic", floor: "1.6.0", about: "forward-compat: createScope adoption alongside a decorated instance -- our P+D+E+1 cascade/poison hold, bare boxes unadopted, one graph zero interference" },
    { name: "using-dispose", file: "using-dispose.mjs", group: "semantic", floor: "1.9.0", about: "forward-compat: engine [Symbol.dispose]/using over handles + disposeReactive interop -- idempotent double-dispose, poison lands, conservation exact" },
    { name: "churn-soak", file: "churn-soak.mjs", group: "soak", floor: "1.5.0", about: "wall-clock construct/use/dispose soak: F-0 + flat heap + gcGate 0" },
    { name: "fleet-soak", file: "fleet-soak.mjs", group: "soak", floor: "1.5.0", about: "10s 2k-VM fleet tick + partial churn rotations: F-0 samples, flat heap, gcGate 0" },
];

// --- semver (hand-rolled triple compare; strip any -tag suffix) ---------------

function versionKey(v) {
    const core = String(v || "").split("-")[0];
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(core);
    if (!m) return -1;
    return (+m[1]) * 1e6 + (+m[2]) * 1e3 + (+m[3]);
}

let peerVersion = null;
try {
    peerVersion = JSON.parse(
        readFileSync(join(HERE, "..", "..", "node_modules", "@zakkster", "lite-signal", "package.json"), "utf8"),
    ).version;
} catch (_) { /* reported below */ }
const peerKey = versionKey(peerVersion);

// --- argv ---------------------------------------------------------------------

const argv = process.argv.slice(2);
let group = null;
let bail = false;
let list = false;
let lenient = false;
let controls = false;

for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--group" || a === "-g") group = argv[++i];
    else if (a === "--bail" || a === "-b") bail = true;
    else if (a === "--list" || a === "-l") list = true;
    else if (a === "--lenient") lenient = true;
    else if (a === "--controls") controls = true;
    else if (a === "--help" || a === "-h") { usage(); process.exit(0); }
    else { console.error("unknown argument: " + a); usage(); process.exit(2); }
}

function usage() {
    process.stdout.write(
        "lite-signal-decorators torture runner\n\n" +
        "  node test/torture/run.mjs [flags]\n\n" +
        "  --group, -g <semantic|soak>   only that group\n" +
        "  --list, -l                    show the scenario table and exit\n" +
        "  --bail, -b                    stop at the first failure\n" +
        "  --lenient                     floor-escalation FAIL -> WARN\n" +
        "  --controls                    re-run each under TORTURE_BREAK; a\n" +
        "                                control that exits 0 FAILS the gate\n",
    );
}

if (list) {
    for (const s of SCENARIOS) {
        process.stdout.write("  " + s.group.padEnd(9) + " " + s.name.padEnd(18) + " floor " + s.floor + "  " + s.about + "\n");
    }
    process.exit(0);
}

// Group selection. Both `semantic` and `soak` carry scenarios from 0.2.0 on.
if (group !== null && group !== "semantic" && group !== "soak") {
    console.error('unknown group "' + group + '" -- expected "semantic" or "soak"');
    process.exit(2);
}
let selected = SCENARIOS;
if (group !== null) selected = selected.filter((s) => s.group === group);

if (peerKey < 0) {
    console.error("  warning: could not read the peer version from node_modules/@zakkster/lite-signal -- floor enforcement disabled");
}

// --- run ----------------------------------------------------------------------
// Children are captured (not inherited) so a passing run stays quiet and a
// failing run can quote the offending tail. --expose-gc is mandatory: the
// zero-GC lanes and settle points need it, and without it they would degrade to
// asserting nothing instead of failing loudly.

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

function spawnScenario(scenario, breakName) {
    const env = { ...process.env };
    if (breakName !== undefined) env.TORTURE_BREAK = breakName;
    else delete env.TORTURE_BREAK;
    return spawnSync(
        process.execPath,
        ["--expose-gc", join(HERE, scenario.file)],
        { encoding: "utf8", env },
    );
}

const results = [];
const t0 = Date.now();

for (const scenario of selected) {
    const started = Date.now();
    let status;    // "pass" | "skip" | "warn" | "fail"
    let detail = "";

    if (controls) {
        // The control sweep: the scenario must sabotage its own central
        // assertion under TORTURE_BREAK and therefore exit NON-ZERO. A control
        // that still exits 0 means the gate cannot fail -- itself a FAIL.
        const child = spawnScenario(scenario, scenario.name);
        const code = child.status;
        if (code === 0) {
            status = "fail";
            detail = "control exited 0 -- the gate cannot fail";
            quoteTail(child);
        } else if (code === null) {
            status = "fail";
            detail = "killed (" + (child.signal || "unknown") + ")";
            quoteTail(child);
        } else {
            status = "pass";
            detail = "broke as required (exit " + code + ")";
        }
    } else {
        const child = spawnScenario(scenario, undefined);
        const code = child.status;
        if (code === 0) {
            status = "pass";
        } else if (code === INFRA_EXIT) {
            status = "fail";
            detail = "infrastructure error (exit 78)";
            quoteTail(child);
        } else if (code === SKIP_EXIT) {
            const floorKey = versionKey(scenario.floor);
            if (peerKey >= 0 && floorKey >= 0 && peerKey >= floorKey) {
                if (lenient) {
                    status = "warn";
                    detail = "skipped at/above floor " + scenario.floor + " (lenient)";
                } else {
                    status = "fail";
                    detail = "skipped, but peer " + peerVersion + " >= floor " + scenario.floor;
                    quoteTail(child);
                }
            } else {
                status = "skip";
                detail = "peer below floor " + scenario.floor;
            }
        } else if (code === null) {
            status = "fail";
            detail = "killed (" + (child.signal || "unknown") + ")";
            quoteTail(child);
        } else {
            status = "fail";
            detail = "exit " + code;
            quoteTail(child);
        }
    }

    const ms = Date.now() - started;
    results.push({ name: scenario.name, group: scenario.group, status, detail, ms });
    if (status === "fail" && bail) {
        process.stderr.write("\n  bailing: " + scenario.name + " -- " + detail + "\n");
        break;
    }
}

// --- summary ------------------------------------------------------------------

const dt = ((Date.now() - t0) / 1000).toFixed(1);
process.stdout.write("\n" + "-".repeat(70) + "\n");
process.stdout.write(
    (controls ? "  CONTROLS " : "  ") +
    "scenario".padEnd(20) + "group".padEnd(11) + "result".padEnd(8) + "ms\n",
);
for (const r of results) {
    const tag = r.status === "pass" ? "pass" : r.status === "skip" ? "skip" : r.status === "warn" ? "WARN" : "FAIL";
    process.stdout.write(
        "  " + r.name.padEnd(20) + r.group.padEnd(11) + tag.padEnd(8) + String(r.ms) +
        (r.detail ? "   (" + r.detail + ")" : "") + "\n",
    );
}
const failed = results.filter((r) => r.status === "fail");
const passed = results.filter((r) => r.status === "pass");
const skipped = results.filter((r) => r.status === "skip");
const warned = results.filter((r) => r.status === "warn");
const notRun = selected.length - results.length;
process.stdout.write(
    "  " + passed.length + " passed, " + skipped.length + " skipped, " +
    warned.length + " warned, " + failed.length + " failed in " + dt + "s" +
    (notRun > 0 ? " (" + notRun + " not run -- bailed)" : "") + "\n",
);

process.exit(failed.length === 0 ? 0 : 1);
