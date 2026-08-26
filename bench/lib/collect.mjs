// bench/lib/collect.mjs -- the aggregator seam. Reads captured rep files, enforces
// the stamp/rep-count guards BEFORE any medianing, then reduces.
//
// ORIGIN: ported from ../../LiteSignal/bench/lib/collect.mjs (bench protocol v3).
// Semantics preserved; only this header comment is new. Data-row parsing is
// caller-supplied (this module owns provenance + reduction, never row syntax).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStampFromText } from "./stamp.mjs";
import { assertStampsConsistent, assertRepCount } from "./guards.mjs";
import { median } from "./stats.mjs";

// Load every `${engineKey}-rep*.txt` in dir, attach its parsed stamp.
export function loadRepFiles(dir, engineKey) {
    const names = readdirSync(dir).filter((f) => f.startsWith(engineKey + "-rep") && f.endsWith(".txt"));
    return names.map((name) => {
        const path = join(dir, name);
        const text = readFileSync(path, "utf8");
        return { path, name, text, stamp: parseStampFromText(text) };
    });
}

// Guarded collect for ONE engine. rowParser(text) -> Map<test, number>.
export function collectEngine(dir, engineKey, claimedReps, rowParser) {
    const files = loadRepFiles(dir, engineKey);
    const consistent = assertStampsConsistent(files);
    if (!consistent.ok) return { ok: false, reason: engineKey + ": " + consistent.reason };
    if (claimedReps != null) {
        const rc = assertRepCount(files, claimedReps, engineKey);
        if (!rc.ok) return { ok: false, reason: rc.reason };
    }
    const acc = new Map();
    for (const f of files) {
        const rows = rowParser(f.text);
        for (const [test, val] of rows) {
            if (!acc.has(test)) acc.set(test, []);
            acc.get(test).push(val);
        }
    }
    const perTest = new Map();
    const perTestSpread = new Map();
    for (const [test, vals] of acc) {
        const m = median(vals);
        perTest.set(test, m);
        perTestSpread.set(test, m > 0 ? (Math.max(...vals) - Math.min(...vals)) / m * 100 : 0);
    }
    return {
        ok: true,
        engineSha: consistent.engineSha,
        protocol: consistent.protocol,
        host: consistent.host,
        reps: files.length,
        perTest,
        perTestSpread,
    };
}
