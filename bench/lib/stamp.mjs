// bench/lib/stamp.mjs -- machine-generated provenance header.
//
// ORIGIN: ported from ../../LiteSignal/bench/lib/stamp.mjs (bench protocol v3).
// The registry-specific "single-reference config" prose is trimmed; the machine
// stamp is otherwise the suite's proven form. For THIS bench the load-bearing
// provenance is:
//
//   * node version + arch + platform + CPU model + date    -- host identity.
//   * engine sha256  -- sha of the package main (SignalDecorators.js): a row
//                       cannot be attributed to bytes that no longer exist.
//   * harness sha256 -- the runner bytes that produced the row.
//   * extra.adapters -- every third-party engine's RESOLVED version, so the
//                       table names exactly which mobx/solid/alien it raced.
//
// Hand-written factual headers are abolished: a prose header a human maintains
// WILL drift from the code that produced the run. The stamp is derived from
// live state only.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";

export const PROTOCOLS = Object.freeze({
    PER_ENGINE: "isolated-per-engine",       // one cold process per engine
    PER_ROW: "isolated-per-row",             // one cold process per (engine x scenario)
    SMOKE: "shared-process-smoke",           // many engines in one process -- NEVER publishable
});

function sha256File(path) {
    try {
        return createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch (e) {
        return "unreadable(" + (e && e.code || "err") + ")";
    }
}

function resolvePath(p) {
    if (!p) return null;
    return p.startsWith("file:") ? fileURLToPath(p) : p;
}

// Build a stamp object from LIVE state. `enginePath` and `harnessPath` are hashed
// off disk. `extra` carries the resolved adapter versions + run sizing.
export function makeStamp({ enginePath, harnessPath, config, protocol, reps, extra }) {
    const ep = resolvePath(enginePath);
    const hp = resolvePath(harnessPath);
    const cpu = (os.cpus() && os.cpus()[0] && os.cpus()[0].model) || "unknown-cpu";
    return {
        kind: "bench-stamp/v1",
        date: new Date().toISOString(),
        protocol: protocol || "UNSET",
        reps: reps ?? null,
        node: process.version,
        arch: process.arch,
        platform: process.platform,
        cpu,
        gcExposed: typeof globalThis.gc === "function",
        enginePath: ep,
        engineSha256: ep ? sha256File(ep) : null,
        harnessPath: hp,
        harnessSha256: hp ? sha256File(hp) : null,
        config: config ? { ...config } : null,
        extra: extra || null,
    };
}

// Render the stamp as a comment block for the top of a results file.
export function formatStamp(stamp) {
    const L = [];
    L.push("# ==== BENCH STAMP v1 (machine-generated -- do not hand-edit) ====");
    L.push("# date        : " + stamp.date);
    L.push("# protocol    : " + stamp.protocol + (stamp.reps != null ? "  reps=" + stamp.reps : ""));
    L.push("# host        : " + stamp.cpu + "  " + stamp.platform + "/" + stamp.arch +
        "  node " + stamp.node + "  gc=" + (stamp.gcExposed ? "on" : "OFF"));
    L.push("# engine      : " + stamp.enginePath);
    L.push("# engine.sha  : " + stamp.engineSha256);
    L.push("# harness     : " + stamp.harnessPath);
    L.push("# harness.sha : " + stamp.harnessSha256);
    if (stamp.config) L.push("# config      : " + JSON.stringify(stamp.config));
    if (stamp.extra) L.push("# extra       : " + JSON.stringify(stamp.extra));
    if (!stamp.gcExposed) L.push("# !! WARNING: run with --expose-gc; heap columns are meaningless without it.");
    L.push("# ================================================================");
    return L.join("\n");
}

// Machine-parseable one-liner so aggregators can read the stamp back off a file.
export function formatStampLine(stamp) {
    return "#STAMP " + JSON.stringify(stamp);
}

export function printStamp(stamp) {
    console.log(formatStamp(stamp));
    console.log(formatStampLine(stamp));
}

// Parse the #STAMP line back out of a captured file's text.
export function parseStampFromText(text) {
    const line = text.split(/\r?\n/).find((l) => l.startsWith("#STAMP "));
    if (!line) return null;
    try {
        return JSON.parse(line.slice("#STAMP ".length));
    } catch {
        return null;
    }
}
