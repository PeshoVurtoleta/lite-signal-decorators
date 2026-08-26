// bench/lib/_selftest.mjs -- proves the ported measurement kernel works AND that
// the anti-DCE checksum can FAIL a cheating adapter (S3-T5). If the sink cannot
// reject skipped work, no green lane means anything. Run:
//   node --expose-gc lib/_selftest.mjs   (from bench/)
//
// ORIGIN: the kernel-selftest pattern is ported from
//   ../../LiteSignal/bench/lib/_selftest.mjs; the LiteSignal-only cases
//   (registry config echo, schedule sentinel) are dropped and the SABOTAGE
//   adapter test (this package's contract) is added.

import { makeStamp, formatStamp, formatStampLine, parseStampFromText, PROTOCOLS } from "./stamp.mjs";
import { summarizeSamples, median, primaryScore } from "./stats.mjs";
import * as G from "./guards.mjs";
import { SINK, SINK_MASK, resetSink, sinkSum, verifySink } from "./sink.mjs";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  FAIL " + msg); } };

// --- stats: median primary, textbook even-n rule ---------------------------------
ok(median([3, 1, 2]) === 2, "median odd = middle");
ok(median([1, 2, 3, 4]) === 2.5, "median even = mean of middles");
const s = summarizeSamples([10, 12, 11, 13, 100]);
ok(s.median === 12, "summarize median");
ok(s.min === 10 && s.max === 100, "summarize min/max");
ok(primaryScore([5, 5, 5]) === 5, "primaryScore is median");

// --- stamp: machine provenance round-trips ---------------------------------------
const stamp = makeStamp({
    enginePath: new URL("../../SignalDecorators.js", import.meta.url).href,
    harnessPath: import.meta.url,
    protocol: PROTOCOLS.PER_ENGINE,
    reps: 5,
    extra: { adapters: { lsd: "0.3.0" } },
});
ok(/^[0-9a-f]{64}$/.test(stamp.engineSha256), "engine sha256 computed off disk");
ok(/^[0-9a-f]{64}$/.test(stamp.harnessSha256), "harness sha256 computed off disk");
ok(stamp.extra.adapters.lsd === "0.3.0", "stamp carries resolved adapter versions");
const text = formatStamp(stamp) + "\n" + formatStampLine(stamp) + "\nsome data row\n";
const parsed = parseStampFromText(text);
ok(parsed && parsed.engineSha256 === stamp.engineSha256, "stamp survives text round-trip");

// --- guards: dead sink, checksum, expected, stamp consistency --------------------
{
    const v = G.makeVerdict();
    G.checkDeadSink(v, "vm-write/lsd", 0);
    ok(!v.ok && /DEAD SINK/.test(v.failures[0]), "deadSink guard catches sink=0");
}
{
    const v = G.makeVerdict();
    G.checkChecksum(v, "vm-write/lsd", 100, 128);
    ok(!v.ok && /CHECKSUM MISMATCH/.test(v.failures[0]), "checksum guard catches unequal work");
    const v2 = G.makeVerdict();
    G.checkChecksum(v2, "vm-write/lsd", 128, 128);
    ok(v2.ok, "checksum guard passes on equal work");
}
{
    const v = G.makeVerdict();
    G.checkExpected(v, "churn", "lsd", { sum: 42, count: 7 }, { sum: 42, count: 9 });
    ok(!v.ok && /EXPECTED COUNT/.test(v.failures[0]), "expected guard catches wrong count");
}
{
    const base = { engineSha256: "a".repeat(64), protocol: PROTOCOLS.PER_ENGINE, cpu: "M4 Pro", node: "v22", arch: "arm64" };
    const good = [1, 2, 3].map((i) => ({ path: "rep" + i, stamp: { ...base } }));
    ok(G.assertStampsConsistent(good).ok, "consistent stamps merge");
    const mixed = [{ path: "a", stamp: { ...base } }, { path: "b", stamp: { ...base, engineSha256: "b".repeat(64) } }];
    ok(!G.assertStampsConsistent(mixed).ok, "mixed engine hashes refused");
    ok(!G.assertRepCount(good, 10, "lsd").ok, "rep-count guard catches 'median of 10' over 3 files");
}

// --- sink: reset / sum / verify --------------------------------------------------
resetSink();
ok(sinkSum() === 0, "resetSink zeroes the array");
SINK[7] = 3; SINK[9] = 4;
ok(sinkSum() === 7, "sinkSum totals the whole array");
ok(verifySink(7).ok, "verifySink ok on a matching sum");
ok(!verifySink(8).ok, "verifySink rejects a mismatched sum");

// --- S3-T5 SABOTAGE: the checksum MUST reject an adapter that skips work ----------
// A minimal fake adapter, shaped like a real one, over a single accumulator slot.
// The control writes every iteration; the sabotage skips every 64th write, so its
// final sink omits those terms and the checksum catches it.
const N = 2048;
const SLOT = 0;
const EXPECTED = (N * (N + 1)) / 2;   // sum_{i=0}^{N-1} (i+1)

const sabotageAdapter = {
    key: "_sabotage",
    version: () => "0.0.0-fake",
    build: {
        probe: (shape, ctx, opts) => {
            let s = 0;
            const skip = opts && opts.sabotage;
            return {
                expectedSum: EXPECTED,
                drive(i) {
                    if (skip && (i & 63) === 0) return;   // <-- skipped work
                    s += (i + 1);
                    ctx.sink[(ctx.slot) & ctx.mask] = s;
                },
                dispose() {},
            };
        },
    },
};

function runFake(sabotage) {
    resetSink();
    const lane = sabotageAdapter.build.probe(null, { sink: SINK, slot: SLOT, mask: SINK_MASK }, { sabotage });
    for (let i = 0; i < N; i++) lane.drive(i);
    lane.dispose();
    return verifySink(EXPECTED);
}

const control = runFake(false);
ok(control.ok, "SABOTAGE control (writes every iter) PASSES the checksum");
const cheat = runFake(true);
ok(!cheat.ok, "SABOTAGE cheat (skips every 64th write) is REJECTED by the checksum (got=" + cheat.got + " want=" + EXPECTED + ")");

console.log("\n" + (fail === 0 ? "ALL PASS" : "FAILURES") + " -- " + pass + " passed, " + fail + " failed");
process.exitCode = fail === 0 ? 0 : 1;
