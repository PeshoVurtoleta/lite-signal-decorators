#!/usr/bin/env node
// test/gate.mjs -- the 1.0 pre-publish gate chain (BRIEF1 section 10, PLAN-S5
// S5b-T3). It runs the release bar as a sequence of captured child processes so
// every step's summary line is capturable and archivable in CHANGELOG [1.0.0].
//
// The chain (blocking unless marked non-blocking):
//   1. fixtures            regen the emit fixtures (drift caught by step 2's 04-freshness)
//   2. test                node --test, all three emit lanes
//   3. test:gc             the same suite under --expose-gc (allocation assertions live)
//   4. torture             all 15 scenarios (13 run + 2 legitimate floor-skips)
//   5. torture:controls    the TORTURE_BREAK sweep -- every scenario must FAIL when broken
//   6. torture:peer-preview NON-BLOCKING -- forward peer lane, reported not gated
//   7. bench selftest      the anti-DCE sink self-test (a cheating adapter must be caught)
//   8. cookbook            the COOKBOOK.md companion lane (all 12 under --expose-gc) AND
//                          its COOKBOOK_BREAK control sweep -- both must exit 0
//   9. pack                npm pack --dry-run -- exactly the 7-name shipped set, no demo/ no Publications/
//
// Exit 0 iff every BLOCKING step exited 0 and pack reports exactly the 7-name set.
// The peer-preview outcome is printed but never changes this script's exit code.
//
// ASCII-only. node:child_process/fs/path/url only.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const EXPECT_FILES = 7;
// The exact shipped tarball name set (CB-A6a). A count of 7 is necessary but not
// sufficient: an unlisted name at count 7 (a swap) must still FAIL. EXPECT_FILES
// stays 7 and stays asserted; this set hardens the check's shape, not its number.
const EXPECT_NAMES = [
    "SignalDecorators.js",
    "SignalDecorators.d.ts",
    "llms.txt",
    "CHANGELOG.md",
    "README.md",
    "LICENSE",
    "package.json",
];

function run(cmd, args, opts) {
    return spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...(opts || {}) });
}

const summary = [];
let blockingFailed = false;

function record(name, ok, detail) {
    const tag = ok === null ? "REPORTED" : ok ? "OK" : "FAIL";
    const line = "  " + name.padEnd(22) + tag.padEnd(9) + (detail || "");
    summary.push(line);
    process.stdout.write(line + "\n");
    if (ok === false) blockingFailed = true;
}

// --- step 1: fixtures ---------------------------------------------------------
let r = run("npm", ["run", "--silent", "fixtures"]);
record("fixtures", r.status === 0, "exit " + r.status + " -- emit fixtures regenerated");

// --- step 2: test -------------------------------------------------------------
r = run("npm", ["test", "--silent"]);
record("test", r.status === 0, testDetail(r));

// --- step 3: test:gc ----------------------------------------------------------
r = run("npm", ["run", "--silent", "test:gc"]);
record("test:gc", r.status === 0, testDetail(r));

// --- step 4: torture (semantic + soak, all 15) --------------------------------
r = run("npm", ["run", "--silent", "torture"]);
record("torture", r.status === 0, tortureDetail(r));

// --- step 5: TORTURE_BREAK sweep ----------------------------------------------
r = run("npm", ["run", "--silent", "torture:controls"]);
record("torture:controls", r.status === 0, tortureDetail(r));

// --- step 6: peer-preview (NON-BLOCKING) --------------------------------------
r = run("npm", ["run", "--silent", "torture:peer-preview"]);
{
    const ok = r.status === 0;
    // Non-blocking: report the outcome, never gate on it. A per-tag suite
    // FAILURE under a future peer is a loud FINDING, not a release blocker.
    const detail = "NON-BLOCKING -- lane " + (ok ? "completed" : "did not complete") +
        " (exit " + r.status + ")" + peerPreviewTail(r);
    record("torture:peer-preview", null, detail);
}

// --- step 7: bench sink self-test ---------------------------------------------
r = run("npm", ["run", "--silent", "selftest"], { cwd: join(ROOT, "bench") });
record("bench:selftest", r.status === 0, benchDetail(r));

// --- step 8: cookbook lane (BLOCKING) -----------------------------------------
// Two child runs, both must exit 0: the corpus lane (all 12 companions under
// `node --expose-gc` via the runner) AND the COOKBOOK_BREAK control sweep (each
// gated recipe must FAIL when sabotaged -- a gate that cannot fail is not a
// gate). The step is OK only when BOTH exit 0; its detail carries both summaries.
{
    const rMain = run("node", ["cookbook/run.mjs"]);
    const rCtl = run("node", ["cookbook/run.mjs", "--controls"]);
    const ok = rMain.status === 0 && rCtl.status === 0;
    record("cookbook", ok, "exit " + rMain.status + "/" + rCtl.status +
        " -- corpus " + cookbookTail(rMain) + "; controls " + cookbookTail(rCtl));
}

// --- step 9: npm pack --dry-run (exactly the 7-name set) ----------------------
r = run("npm", ["pack", "--dry-run", "--json"]);
{
    let count = -1;
    let names = [];
    try {
        const j = JSON.parse(r.stdout);
        const e = Array.isArray(j) ? j[0] : Object.values(j)[0];
        names = (e.files || []).map((f) => f.path || f);
        count = names.length;
    } catch (_) { /* count stays -1 -> FAIL */ }
    const stray = names.filter((n) => n.startsWith("demo/") || n.startsWith("Publications/"));
    // NAMED-SET assertion (CB-A6a): the tarball names must equal EXPECT_NAMES
    // exactly. Count is still asserted (== EXPECT_FILES) so a short or long set
    // fails; the set membership catches a same-count SWAP that a bare count misses.
    const nameSet = new Set(names);
    const missing = EXPECT_NAMES.filter((n) => !nameSet.has(n));
    const unlisted = names.filter((n) => !EXPECT_NAMES.includes(n));
    const setOk = missing.length === 0 && unlisted.length === 0;
    const ok = r.status === 0 && count === EXPECT_FILES && setOk && stray.length === 0;
    let detail = "exit " + r.status + " -- " + count + "/" + EXPECT_FILES + " files";
    if (stray.length) detail += " STRAY: " + stray.join(",");
    else if (missing.length) detail += " MISSING: " + missing.join(",");
    else if (unlisted.length) detail += " UNLISTED: " + unlisted.join(",");
    else detail += ", exact 7-name set, no demo/ no Publications/";
    record("pack", ok, detail);
}

// --- verdict ------------------------------------------------------------------
process.stdout.write("\n" + "-".repeat(70) + "\n");
process.stdout.write("  GATE " + (blockingFailed ? "FAIL" : "PASS") +
    " -- 8 blocking steps + 1 non-blocking (peer-preview)\n");
process.exit(blockingFailed ? 1 : 0);

// --- detail extractors --------------------------------------------------------

function lastMatch(text, re) {
    const lines = String(text || "").split("\n");
    let hit = "";
    for (const l of lines) if (re.test(l)) hit = l.trim();
    return hit;
}

function testDetail(child) {
    const out = (child.stdout || "") + (child.stderr || "");
    // node --test reporters end with "... pass 214" and "... fail 0" summary
    // lines (spec uses an info glyph prefix, tap uses "# pass"). Match either.
    const passN = /(?:^|\s)pass\s+(\d+)\s*$/m.exec(out);
    const failN = /(?:^|\s)fail\s+(\d+)\s*$/m.exec(out);
    if (passN) return "exit " + child.status + " -- " + passN[1] + " pass / " + (failN ? failN[1] : "0") + " fail";
    return "exit " + child.status;
}

function tortureDetail(child) {
    const out = (child.stdout || "") + (child.stderr || "");
    const tail = lastMatch(out, /passed,.*failed in/);
    return "exit " + child.status + (tail ? " -- " + tail : "");
}

function cookbookTail(child) {
    const out = (child.stdout || "") + (child.stderr || "");
    const tail = lastMatch(out, /cookbook lane:/);
    return tail ? tail.replace(/^cookbook lane:\s*/, "") : "exit " + child.status;
}

function benchDetail(child) {
    const out = (child.stdout || "") + (child.stderr || "");
    const tail = lastMatch(out, /(ALL PASS|FAILURES)\s*--/);
    return "exit " + child.status + (tail ? " -- " + tail : "");
}

function peerPreviewTail(child) {
    const out = (child.stdout || "") + (child.stderr || "");
    const tags = [];
    for (const l of out.split("\n")) {
        const m = /(preview|canary)[^A-Za-z].*(SUITE-GREEN|RAN|FINDING|infra|error|passed|failed)/i.exec(l);
        if (m) tags.push(l.trim());
    }
    return tags.length ? " [" + tags.slice(-2).join("; ") + "]" : "";
}
