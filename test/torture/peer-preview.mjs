#!/usr/bin/env node
// test/torture/peer-preview.mjs -- the FORWARD peer lane (PLAN-S4 PD-25 T5,
// Workstream K). It runs the FULL torture suite against UNRELEASED
// @zakkster/lite-signal dist-tags (`preview` and `canary`) so a breaking engine
// change is caught here -- loudly, per-tag -- before it can reach a release.
//
// How it stays honest without touching the real tree:
//   1. For each tag, scratch-install `@zakkster/lite-signal@<tag>` into an
//      ISOLATED temp dir (os.tmpdir mkdtemp, --ignore-scripts). The real
//      package tree and its node_modules are NEVER mutated.
//   2. Build a COPIED run-root in the scratch: the package sources
//      (SignalDecorators.js + test/) copied in, and a node_modules OVERLAY whose
//      @zakkster/lite-signal is the substituted tag while lite-leak /
//      lite-cleanup / lite-gc-profiler are REAL COPIES of the installed deps
//      (lite-leak imports lite-signal, so it must resolve the SAME substituted
//      instance -- a symlink-to-real would realpath back to the installed 1.5.0
//      and silently duplicate the engine).
//   3. Run `node run-root/test/torture/run.mjs` with TORTURE_SECONDS=3 so the
//      soak lanes stay short. run.mjs reads the substituted peer version from
//      the overlay, so its floor-escalation law makes the two forward scenarios
//      (scope-adoption 1.6.0, using-dispose 1.9.0) RUN, not skip -- no silent
//      green via a below-floor skip.
//
// Verdict policy (A5): the lane REPORTS per-tag and is NON-BLOCKING for the
// release gate. A tag whose suite RAN AND REPORTED (run.mjs exit 0 or 1) counts
// as a completed lane -- a suite FAILURE under a future peer is a loud FINDING,
// not a lane error. A tag whose suite COULD NOT RUN AT ALL (install failure,
// overlay error, killed child, or an unexpected runner exit) is a lane error
// and makes THIS script exit non-zero (78-style loud).
//
// ASCII-only. node:child_process/fs/os/path/url only.

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..", "..");
const REAL_NM = join(PKG_ROOT, "node_modules");

const TAGS = ["preview", "canary"];
// @zakkster deps the suite resolves at runtime. lite-signal is SUBSTITUTED per
// tag; the rest are copied verbatim so their own imports (lite-leak ->
// lite-signal, lite-leak -> lite-cleanup) resolve the overlay's engine.
const COPY_DEPS = ["lite-gc-profiler", "lite-leak", "lite-cleanup"];
const SOAK_SECONDS = "3";

const LANE_INFRA_EXIT = 78;

function log(line) {
    process.stdout.write(line + "\n");
}

// --- install one tag into an isolated scratch dir -----------------------------

function installTag(scratch, tag) {
    const dir = join(scratch, "peer-" + tag);
    mkdirSync(dir, { recursive: true });
    const init = spawnSync(
        "npm", ["init", "-y"],
        { cwd: dir, encoding: "utf8" },
    );
    if (init.status !== 0) {
        return { ok: false, reason: "npm init failed: " + (init.stderr || init.error || "").toString().slice(0, 200) };
    }
    const inst = spawnSync(
        "npm",
        ["install", "@zakkster/lite-signal@" + tag, "--ignore-scripts", "--no-audit", "--no-fund"],
        { cwd: dir, encoding: "utf8" },
    );
    if (inst.status !== 0) {
        return { ok: false, reason: "npm install @" + tag + " failed: " + (inst.stderr || "").trim().split("\n").slice(-2).join(" ") };
    }
    const peer = join(dir, "node_modules", "@zakkster", "lite-signal");
    if (!existsSync(join(peer, "package.json"))) {
        return { ok: false, reason: "installed peer missing package.json" };
    }
    let version = "unknown";
    try {
        version = JSON.parse(readFileSync(join(peer, "package.json"), "utf8")).version;
    } catch (_) { /* reported as unknown */ }
    return { ok: true, peer, version };
}

// --- build the copied run-root overlay ----------------------------------------

function buildRunRoot(scratch, tag, peerDir) {
    const root = join(scratch, "run-" + tag);
    const nm = join(root, "node_modules", "@zakkster");
    mkdirSync(nm, { recursive: true });

    // Package sources (real copies, no symlinks -- node_modules resolution walks
    // up from here to the overlay, not back to the real tree).
    cpSync(join(PKG_ROOT, "SignalDecorators.js"), join(root, "SignalDecorators.js"));
    cpSync(join(PKG_ROOT, "test"), join(root, "test"), { recursive: true });

    // The substituted engine.
    cpSync(peerDir, join(nm, "lite-signal"), { recursive: true });

    // The remaining runtime deps, copied so their own lite-signal / lite-cleanup
    // imports resolve THIS overlay.
    for (const dep of COPY_DEPS) {
        const src = join(REAL_NM, "@zakkster", dep);
        if (existsSync(src)) cpSync(src, join(nm, dep), { recursive: true });
    }
    return root;
}

// --- parse the runner's summary line ------------------------------------------

function parseSummary(out) {
    const m = /(\d+) passed, (\d+) skipped, (\d+) warned, (\d+) failed/.exec(out || "");
    if (!m) return null;
    return { passed: +m[1], skipped: +m[2], warned: +m[3], failed: +m[4] };
}

// --- run the suite against one substituted tag --------------------------------

function runSuite(runRoot) {
    const env = { ...process.env, TORTURE_SECONDS: SOAK_SECONDS };
    delete env.TORTURE_BREAK;
    const child = spawnSync(
        process.execPath,
        [join(runRoot, "test", "torture", "run.mjs")],
        { encoding: "utf8", env, maxBuffer: 32 * 1024 * 1024 },
    );
    return child;
}

// --- main ---------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), "ldc-peer-preview-"));
const verdicts = [];
let laneError = false;

log("");
log("  peer-preview lane -- FULL torture suite vs unreleased @zakkster/lite-signal");
log("  scratch: " + scratch);
log("  tags: " + TAGS.join(", ") + " (soaks at TORTURE_SECONDS=" + SOAK_SECONDS + ")");
log("");

try {
    for (const tag of TAGS) {
        log("  [" + tag + "] installing @zakkster/lite-signal@" + tag + " ...");
        const inst = installTag(scratch, tag);
        if (!inst.ok) {
            verdicts.push({ tag, version: "-", state: "LANE-ERROR", detail: inst.reason });
            laneError = true;
            continue;
        }
        log("  [" + tag + "] resolved " + inst.version + " -- building overlay + running suite ...");
        let runRoot;
        try {
            runRoot = buildRunRoot(scratch, tag, inst.peer);
        } catch (e) {
            verdicts.push({ tag, version: inst.version, state: "LANE-ERROR", detail: "overlay build failed: " + (e && e.message) });
            laneError = true;
            continue;
        }
        const child = runSuite(runRoot);
        const out = (child.stdout || "") + (child.stderr || "");
        const summary = parseSummary(out);

        if (child.status === null) {
            verdicts.push({ tag, version: inst.version, state: "LANE-ERROR", detail: "runner killed (" + (child.signal || "unknown") + ")" });
            laneError = true;
        } else if (child.status !== 0 && child.status !== 1) {
            verdicts.push({ tag, version: inst.version, state: "LANE-ERROR", detail: "runner exit " + child.status + " (could not run)" });
            laneError = true;
        } else if (summary === null) {
            verdicts.push({ tag, version: inst.version, state: "LANE-ERROR", detail: "no summary line -- runner did not report" });
            laneError = true;
        } else {
            const state = child.status === 0 ? "SUITE-GREEN" : "SUITE-FINDING";
            const detail =
                summary.passed + " passed, " + summary.skipped + " skipped, " +
                summary.warned + " warned, " + summary.failed + " failed";
            verdicts.push({ tag, version: inst.version, state, detail });
            if (state === "SUITE-FINDING") {
                // A future-peer regression: report the failing tail loudly.
                const lines = out.split("\n");
                process.stderr.write("  [" + tag + "] FINDING -- suite failed under " + inst.version + ":\n");
                for (let i = Math.max(0, lines.length - 30); i < lines.length; i++) {
                    if (lines[i].length > 0) process.stderr.write("    | " + lines[i] + "\n");
                }
            }
        }
    }
} finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
}

// --- per-tag verdict table ----------------------------------------------------

log("");
log("  " + "-".repeat(72));
log("  peer-preview verdicts");
log("  " + "tag".padEnd(10) + "version".padEnd(20) + "state".padEnd(16) + "detail");
for (const v of verdicts) {
    log("  " + v.tag.padEnd(10) + String(v.version).padEnd(20) + v.state.padEnd(16) + v.detail);
}
log("");
if (laneError) {
    log("  LANE ERROR: at least one tag could not run the suite at all (see above).");
    process.exit(LANE_INFRA_EXIT);
}
log("  lane complete: every tag ran and reported (per-tag findings are non-blocking).");
process.exit(0);
