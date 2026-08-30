// cookbook/r06-lite-store-boundary.mjs -- node --expose-gc cookbook/r06-lite-store-boundary.mjs
//
// Recipe 6: the lite-store boundary -- document state meets class state.
// Stamp 2026-08-30. Companion for COOKBOOK.md; every published snippet lives in
// a `#region cookbook:r6.k` span and is byte-identical to the fenced block in
// the document. Harness (asserts + the summary line) is OUTSIDE every region.
//
// NOT gated: this boundary is deliberately NOT zero-GC (lite-store allocates a
// property signal LAZILY on first tracked read, and snapshot() deep-copies).
// The recipe says so in its own words; the manifest carries the reason.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

function fail(msg) {
    process.stderr.write("cookbook r6 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }

// #region cookbook:r6.1
import { store, unwrap, snapshot, reconcile, dispose as disposeStore } from "@zakkster/lite-store";
import { effect } from "@zakkster/lite-signal";
import { defineReactive, disposeReactive } from "@zakkster/lite-signal-decorators";

// One side: document-shaped state in a lite-store proxy. Deep, open-ended,
// serializable -- the shape a document editor actually has.
const doc = store({
    title: "Draft",
    wordCount: 0,
    meta: { author: "Ada", tags: ["draft"] },
});

// The other side: a class-shaped view-model. Fixed members, a measured cost,
// one deterministic teardown. (defineReactive is the buildless twin of the
// decorator syntax -- identical wiring, runnable without a transpiler.)
class EditorVMBase {}
const EditorVM = defineReactive(EditorVMBase, {
    signals: { title: "", words: 0, saving: false },
    deriveds: { headline: (vm) => vm.title + " (" + vm.words + " words)" },
    effects: {},
});
const view = new EditorVM();
// #endregion cookbook:r6.1

// #region cookbook:r6.2
// EXACTLY ONE effect bridges the seam. store's lazy per-key signals live in the
// DEFAULT registry, so the bridge is a default-registry effect: it READS store
// properties (a tracked read crosses the wall) and pushes plain VALUES into the
// VM by member writes (a value-push does not need to track). Direction is
// one-way: document -> view-model, one effect, no polling.
const stopBridge = effect(() => {
    view.title = doc.title;
    view.words = doc.wordCount;
});
// #endregion cookbook:r6.2

// A mutation on the document side re-runs the bridge and lands in the VM.
doc.title = "Chapter One";
doc.wordCount = 1200;
assert(view.title === "Chapter One", "bridge did not push title");
assert(view.words === 1200, "bridge did not push wordCount");
assert(view.headline === "Chapter One (1200 words)", "derived headline stale");

// #region cookbook:r6.3
// Serializing and patching stay on the document side. snapshot() is a DEEP
// plain-data copy (it allocates -- a cold save path, never a frame path);
// reconcile() diff-applies a next shape, patching only the leaves that differ.
const saved = snapshot(doc);           // deep copy -> safe to stringify/persist
reconcile(doc, { title: "Chapter One", wordCount: 1400, meta: { author: "Ada", tags: ["review"] } });
// GOTCHA: this boundary is NOT zero-GC. lite-store allocates a signal per key
// on first tracked read, and snapshot() deep-copies. It also inherits the
// PD-29 wall: a DEFAULT-registry watcher (this bridge) can never track a member
// living on a CUSTOM registry, so the VM side that receives the push is the
// side you isolate with a bound registry, never the store.
const raw = unwrap(doc);               // the underlying target, no proxy
// #endregion cookbook:r6.3

assert(saved.title === "Chapter One" && saved.wordCount === 1200, "snapshot not a point-in-time deep copy");
assert(view.words === 1400, "reconcile did not re-run the bridge");
assert(raw.meta.tags[0] === "review", "unwrap did not expose the reconciled target");

// Teardown: each side owns its own lifecycle.
stopBridge();
disposeReactive(view);
disposeStore(doc);

process.stdout.write(
    "cookbook r6 lite-store-boundary | headline=\"" + saved.title +
    "\" words:1200->1400 zero-gc=NO | ok\n",
);
