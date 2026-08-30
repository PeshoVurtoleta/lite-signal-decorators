// cookbook/r05-rev-stamped-boundary.mjs -- node --expose-gc cookbook/r05-rev-stamped-boundary.mjs
//
// Recipe 5 -- "The rev-stamped deep-subtree boundary."
// The flatness law made concrete. A 2-3 level plain-object subtree lives behind
// ONE @reactive `rev` at its root. The mutation SITE bumps rev; readers subscribe
// to rev and re-read the plain tree. No proxy, no node per field, no deep
// tracking. A multi-field edit wrapped in a batch is ONE commit -- one effect
// flush, not one per field.
//
// GATED (gc): the commit edge -- edit a plain field, bump rev, let the effect
// re-run -- is pure propagation, zero allocation per commit (<= 0.589 B/op).
// COOKBOOK_BREAK=r5 allocates one throwaway object per op; the gate fails.
//
// ANTI-PATTERN, named: a dirty-check polling loop that re-scans the whole tree
// every frame turns an O(1) edge into an O(tree) scan and hides staleness
// instead of failing on it. The rev stamp is the O(1) edge; poll nothing.
// ASCII only.

const RID = "r5";
function assert(cond, msg) {
    if (!cond) {
        process.stderr.write("cookbook " + RID + " FAIL: " + msg + "\n");
        process.exit(1);
    }
}

// #region cookbook:r5.1
import { createRegistry } from "@zakkster/lite-signal";
import { defineReactive, costOf, disposeReactive } from "@zakkster/lite-signal-decorators";

// One reactive `rev` and one effect that reacts to commits. `tree` is a plain
// nested object -- two or three levels deep -- and carries NO reactive nodes.
let commits = 0;
class DocumentBase {
    constructor() {
        this.tree = { meta: { title: "", tags: [] }, body: { blocks: [], wordCount: 0 } };
    }
    // The mutation SITE: touch plain data, then stamp. Callers batch multi-field
    // edits (see r05.2) so a whole edit is ONE commit.
    setTitle(t) { this.tree.meta.title = t; this.rev = this.rev + 1; }
    setWordCount(n) { this.tree.body.wordCount = n; this.rev = this.rev + 1; }
}
// Bound to its own registry so multi-field edits can batch via registry.batch().
const registry = createRegistry({
    maxNodes: 64, maxLinks: 64, prealloc: "eager", onCapacityExceeded: "throw",
});
const Document = defineReactive(DocumentBase, {
    signals: { rev: 0 },                                    // P=1
    deriveds: {},                                           // D=0
    effects: { onCommit: (self) => { commits++; void self.rev; } },   // E=1 -> nodes 3
    host: { registry },
});
// #endregion cookbook:r5.1

// #region cookbook:r5.2
// A multi-field edit. Three plain writes, three rev bumps -- but wrapped in
// registry.batch(...) they coalesce into ONE effect flush. That is the buildless
// spelling of @batched: action-grade (one call per user intent), and it
// allocates a thunk per call by design -- so it is the user-intent path, not the
// per-frame path.
const doc = new Document();
const wireCommits = commits;                               // effect fired once at wire

// Unbatched: three bumps -> three commits.
doc.setTitle("draft");
doc.setWordCount(10);
doc.setTitle("final");
const unbatchedCommits = commits - wireCommits;            // 3

// Batched: the same three edits, ONE commit.
const beforeBatch = commits;
registry.batch(() => {
    doc.tree.meta.title = "shipped";
    doc.rev = doc.rev + 1;
    doc.tree.body.wordCount = 1200;
    doc.rev = doc.rev + 1;
    doc.tree.meta.tags.push("done");
    doc.rev = doc.rev + 1;
});
const batchedCommits = commits - beforeBatch;              // 1
// #endregion cookbook:r5.2

assert(unbatchedCommits === 3, "unbatched edit produced " + unbatchedCommits + " commits, expected 3");
assert(batchedCommits === 1, "batched edit produced " + batchedCommits + " commits, expected 1");

// #region cookbook:r5.3
// THE ANTI-PATTERN (do NOT do this): a dirty-check poll that re-scans the tree
// every frame to find what changed --
//
//   function pollFrame(doc, lastSeen) {          // O(tree) EVERY frame
//       const snap = JSON.stringify(doc.tree);   // walks the whole subtree
//       if (snap !== lastSeen) { rerender(); }   // and still misses in-place edits
//       return snap;
//   }
//
// It converts the O(1) rev edge into an O(tree) scan per frame and hides
// staleness instead of failing on it. The rev stamp is the edge: subscribe to
// rev, and a commit tells you exactly once that the tree changed.
// #endregion cookbook:r5.3

// #region cookbook:r5.4
// CB-A5: the boundary cost is invariant to subtree size. costOf(Document).nodes
// is IDENTICAL whether the tree holds 0, 1, 1000, or 100_000 plain fields, and
// registry activeNodes after a 100_000-field tree equals the empty-tree value --
// because the fields are plain data, never nodes.
import { stats } from "@zakkster/lite-signal";
const nodesBySize = {};
let activeAtZero = 0;
let activeAtHundredK = 0;
for (const size of [0, 1, 1000, 100000]) {
    const before = stats().activeNodes;
    const d = new Document();
    for (let k = 0; k < size; k++) d.tree.body.blocks.push({ id: k, text: k });   // plain data
    d.rev = d.rev + 1;                                       // one commit, any size
    nodesBySize[size] = costOf(Document).nodes;
    const built = stats().activeNodes - before;
    if (size === 0) activeAtZero = built;
    if (size === 100000) activeAtHundredK = built;
    disposeReactive(d);
}
// #endregion cookbook:r5.4

const owner = costOf(Document);
const formula = owner.signals + owner.deriveds + owner.effects + 1;
assert(owner.nodes === 3 && formula === 3, "owner nodes " + owner.nodes + " != P+D+E+1");
for (const size of [0, 1, 1000, 100000]) {
    assert(nodesBySize[size] === owner.nodes,
        "costOf.nodes at subtree size " + size + " = " + nodesBySize[size] + " != " + owner.nodes);
}
assert(activeAtHundredK === activeAtZero,
    "100k-field tree added " + activeAtHundredK + " nodes vs " + activeAtZero + " empty -- per-field node leak");

// ---- gc mini-gate: the commit edge is zero-alloc ----
await runGcGate(doc);
disposeReactive(doc);

process.stdout.write(
    "cookbook r5 rev-stamped-boundary | unbatched=" + unbatchedCommits + " batched=" + batchedCommits +
    " (one commit) nodes=" + owner.nodes + " invariant@[0,1,1e3,1e5] active(1e5-0)=" +
    (activeAtHundredK - activeAtZero) + " | ok\n",
);

// -----------------------------------------------------------------------------
// gc mini-gate (measurement plumbing; kept OUT of the published regions)
// -----------------------------------------------------------------------------
async function runGcGate(document) {
    const { GcProfiler, measureOps } = await import("@zakkster/lite-gc-profiler");
    const OPS = 1_000_000;
    const WARMUP = 100_000;
    const MAX_BYTES_PER_OP = 0.589;
    const MAX_PAUSE_MS = 4.0;
    const MINOR_HEADROOM = 128;
    const BREAK = process.env.COOKBOOK_BREAK === RID;

    // The commit edge: touch a plain field, bump rev, the onCommit effect re-runs.
    const stepClean = (i) => { document.tree.body.wordCount = i & 1023; document.rev = document.rev + 1; return document.rev & 1; };
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
    globalThis.__r5_sink = (globalThis.__r5_sink | 0) + (sink | 0);

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
        "cookbook r5 gc-gate | commit-edge bytes/op=" + bpo.toFixed(4) +
        " (<= " + MAX_BYTES_PER_OP + ") major=" + g.major + " minor=" + g.minor +
        " (limit " + minorLimit + ") maxMs=" + g.maxMs.toFixed(2) + " | ok\n",
    );
}
