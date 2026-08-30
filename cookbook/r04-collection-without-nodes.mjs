// cookbook/r04-collection-without-nodes.mjs -- node --expose-gc cookbook/r04-collection-without-nodes.mjs
//
// Recipe 4 -- "A reactive collection without a node per element."
// The trap is one signal per element: 100k items -> 100k nodes, and a teardown
// that walks forever. The pattern instead: a PLAIN array (or an arena column)
// plus exactly TWO reactive members -- a `rev` stamp and a `length` -- both
// bumped by the mutators. Readers subscribe to `rev`; the data stays plain.
// A 100k-item list costs the OWNER's P+D+E+1 and nothing more.
//
// GATED (gc): a commit (mutate a slot + bump rev) and the read that follows is
// pure propagation -- zero allocation per commit (<= 0.589 B/op). COOKBOOK_BREAK=r4
// allocates one throwaway object per op in the measured loop; the gate fails.
//
// 4b (regions r04.4/.5): a @derived sorted+filtered view over the rev stamp --
// ONE recompute per commit, never per element.
// ASCII only.

const RID = "r4";
function assert(cond, msg) {
    if (!cond) {
        process.stderr.write("cookbook " + RID + " FAIL: " + msg + "\n");
        process.exit(1);
    }
}

// #region cookbook:r4.1
import { stats } from "@zakkster/lite-signal";
import { defineReactive, costOf, disposeReactive } from "@zakkster/lite-signal-decorators";

// The collection owner: two reactive members total, whatever the element count.
// `items` is a plain array -- NOT reactive, NOT a node per element.
class ListBase {
    constructor() { this.items = []; }
    push(v) { this.items.push(v); this.length = this.items.length; this.rev = this.rev + 1; }
    setAt(i, v) { this.items[i] = v; this.rev = this.rev + 1; }   // O(1) in-place commit
    clear() { this.items.length = 0; this.length = 0; this.rev = this.rev + 1; }
}
const List = defineReactive(ListBase, {
    signals: { rev: 0, length: 0 },   // P=2
    deriveds: {},                     // D=0
    effects: {},                      // E=0  -> nodes = 2 + 0 + 0 + 1 = 3
});
// #endregion cookbook:r4.1

// #region cookbook:r4.2
// CB-A5: the per-instance cost is invariant to element count. costOf(List).nodes
// is IDENTICAL at 0, 1, 1000, and 100_000 items, and equals P+D+E+1.
const nodesBySize = {};
let activeAtZero = 0;
let activeAtHundredK = 0;
for (const size of [0, 1, 1000, 100000]) {
    const before = stats().activeNodes;
    const list = new List();
    for (let i = 0; i < size; i++) list.push(i);   // plain-array growth, no new nodes
    nodesBySize[size] = costOf(List).nodes;
    const built = stats().activeNodes - before;     // reactive nodes this list added
    if (size === 0) activeAtZero = built;
    if (size === 100000) activeAtHundredK = built;
    disposeReactive(list);
}
// #endregion cookbook:r4.2

const owner = costOf(List);
const formula = owner.signals + owner.deriveds + owner.effects + 1;
assert(owner.nodes === 3 && formula === 3, "owner nodes " + owner.nodes + " != P+D+E+1");
for (const size of [0, 1, 1000, 100000]) {
    assert(nodesBySize[size] === owner.nodes,
        "costOf.nodes at size " + size + " = " + nodesBySize[size] + " != " + owner.nodes);
}
assert(activeAtHundredK === activeAtZero,
    "100k list added " + activeAtHundredK + " nodes vs " + activeAtZero + " for empty -- per-element node leak");

// #region cookbook:r4.4
// 4b -- a sorted + filtered VIEW, computed once per commit. The @derived reads
// the rev stamp, then scans the plain array. It recomputes when rev changes --
// ONE recompute per commit -- not once per element pushed.
let recomputes = 0;
class LeaderboardBase {
    constructor() { this.scores = []; }
    add(score) { this.scores.push(score); this.rev = this.rev + 1; }   // one commit
}
const Leaderboard = defineReactive(LeaderboardBase, {
    signals: { rev: 0 },
    deriveds: {
        top5: (self) => {
            recomputes++;
            void self.rev;                          // subscribe to the stamp
            return self.scores.slice().sort((a, b) => b - a).slice(0, 5);
        },
    },
    effects: {},
});
// #endregion cookbook:r4.4

// #region cookbook:r4.5
// Build 10 commits, each adding 100 elements. The view is read after each commit.
const board = new Leaderboard();
for (let commit = 0; commit < 10; commit++) {
    for (let k = 0; k < 100; k++) board.add(commit * 100 + k);
    void board.top5;                                // read the view once per commit
}
const top = board.top5;
// recomputes tracks COMMITS (1000 adds -> at most ~ commits + reads), never 1000.
// #endregion cookbook:r4.5

assert(top.length === 5, "top5 length " + top.length + " != 5");
assert(recomputes <= 40, "view recomputed " + recomputes + " times -- should be per-commit, not per-element");
disposeReactive(board);

// ---- gc mini-gate: an in-place commit + read is zero-alloc ----
const hotList = new List();
for (let i = 0; i < 1024; i++) hotList.push(i);       // fixed backing, mutated in place below
await runGcGate(hotList);
disposeReactive(hotList);

process.stdout.write(
    "cookbook r4 collection-without-nodes | nodes=" + owner.nodes + " invariant@[0,1,1e3,1e5]" +
    " active(1e5-0)=" + (activeAtHundredK - activeAtZero) + " view-recomputes=" + recomputes +
    " (per-commit) | ok\n",
);

// -----------------------------------------------------------------------------
// gc mini-gate (measurement plumbing; kept OUT of the published regions)
// -----------------------------------------------------------------------------
async function runGcGate(list) {
    const { GcProfiler, measureOps } = await import("@zakkster/lite-gc-profiler");
    const OPS = 1_000_000;
    const WARMUP = 100_000;
    const MAX_BYTES_PER_OP = 0.589;
    const MAX_PAUSE_MS = 4.0;
    const MINOR_HEADROOM = 128;
    const BREAK = process.env.COOKBOOK_BREAK === RID;

    const stepClean = (i) => { list.setAt(i & 1023, i); return list.rev & 1; };   // commit + read
    const stepBreak = (i) => {
        const trash = new Array(1024);
        trash[0] = i;
        return trash[0] + stepClean(i);
    };
    const hot = BREAK ? stepBreak : stepClean;

    let sink = 0;
    function settleFast() { return new Promise((r) => setTimeout(() => Promise.resolve().then(r), 0)); }
    async function observe(fn) {
        for (let i = 0; i < WARMUP; i++) sink += fn(i) | 0;
        const gc = new GcProfiler().start();
        for (let i = 0; i < OPS; i++) {
            sink += fn(i) | 0;
            if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
        await settleFast();
        const summary = gc.summary();
        gc.stop();
        return summary.gc;
    }

    const controlMinor = (await observe((i) => i & 7)).minor;
    const minorLimit = controlMinor + MINOR_HEADROOM;
    const g = await observe(hot);
    const m = measureOps(hot, { ops: OPS, warmup: WARMUP });
    const bpo = (m.bracketInverted || m.bytesPerOp == null) ? 0 : m.bytesPerOp;
    globalThis.__r4_sink = (globalThis.__r4_sink | 0) + (sink | 0);

    const fail = [];
    if (g.major !== 0) fail.push("major=" + g.major);
    if (g.maxMs > MAX_PAUSE_MS) fail.push("maxPauseMs=" + g.maxMs.toFixed(2));
    if (bpo > MAX_BYTES_PER_OP) fail.push("bytesPerOp=" + bpo.toFixed(4));
    if (g.minor > minorLimit) fail.push("minor=" + g.minor + ">" + minorLimit);
    if (fail.length) {
        process.stderr.write("cookbook " + RID + " gc-gate FAIL: " + fail.join(", ") + "\n");
        process.exit(1);
    }
    process.stdout.write(
        "cookbook r4 gc-gate | commit+read bytes/op=" + bpo.toFixed(4) +
        " (<= " + MAX_BYTES_PER_OP + ") major=" + g.major + " minor=" + g.minor +
        " (limit " + minorLimit + ") maxMs=" + g.maxMs.toFixed(2) + " | ok\n",
    );
}
