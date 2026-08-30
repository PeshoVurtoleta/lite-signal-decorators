// cookbook/r16-untrack-peek.mjs -- node cookbook/r16-untrack-peek.mjs
//
// Recipe 16 (Basics, not gated): read without subscribing. Stamp 2026-08-30.
// boxOf(vm, key).peek() reads a member and adds no dependency; the engine's
// untrack does the same for a whole block -- imported from @zakkster/lite-signal,
// deliberately NOT re-exported by this package. Snippets live in `#region
// cookbook:r16.k` spans; the harness is OUTSIDE them.
//
// NOT gated: a cold single-read demonstration. The zerogc torture lanes own the
// read budgets; this recipe shows the escape hatch, not a hot loop.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

function fail(msg) {
    process.stderr.write("cookbook r16 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }

// #region cookbook:r16.1
import { defineReactive, boxOf, disposeReactive } from "@zakkster/lite-signal-decorators";

// Read a member WITHOUT subscribing to it. boxOf(vm, key).peek() returns the live
// value and adds no dependency, even inside a tracking scope -- the escape hatch
// for a read you do not want to react to. peek() is on every box shape: a
// @reactive member is a SignalBox, a @derived member is a ComputedBox, and both
// answer peek().
const Cursor = defineReactive(class Cursor {}, {
    signals: { x: 0, y: 0 },
    deriveds: { dist: (vm) => Math.abs(vm.x) + Math.abs(vm.y) },
    effects: {},
});
const cursor = new Cursor();
cursor.x = 3;
cursor.y = 4;
const xNow = boxOf(cursor, "x").peek();          // 3 -- a SignalBox peek, untracked
const distNow = boxOf(cursor, "dist").peek();    // 7 -- a ComputedBox peek, untracked
// #endregion cookbook:r16.1

// #region cookbook:r16.2
// For a whole block of untracked reads, use the ENGINE's untrack -- imported from
// @zakkster/lite-signal, NOT from this package. The decorators layer deliberately
// does not re-export untrack: keeping it at the engine names where the primitive
// actually lives and holds the read/write surface at 18 exports. Reads inside the
// callback add no dependencies, so a snapshot taken this way never subscribes.
import { untrack } from "@zakkster/lite-signal";

function snapshotUntracked(vm) {
    return untrack(() => ({ x: vm.x, y: vm.y, dist: vm.dist }));
}
// #endregion cookbook:r16.2

// --- exercise (harness) -------------------------------------------------------

assert(xNow === 3, "peek() returned the wrong SignalBox value: " + xNow);
assert(distNow === 7, "peek() returned the wrong ComputedBox value: " + distNow);

// The snapshot reads three members but subscribes to none.
const snap = snapshotUntracked(cursor);
assert(snap.x === 3 && snap.y === 4 && snap.dist === 7, "untracked snapshot read wrong values");

// Proof it does not subscribe: an effect whose only read is peek/untrack must NOT
// re-run when the member changes, while a tracked read effect must.
import { effect } from "@zakkster/lite-signal";
let peekRuns = 0;
let trackedRuns = 0;
const stopPeek = effect(() => { void boxOf(cursor, "x").peek(); peekRuns++; });
const stopTracked = effect(() => { void cursor.x; trackedRuns++; });
assert(peekRuns === 1 && trackedRuns === 1, "effects did not run once at registration");
cursor.x = 99;                                   // move the member
assert(peekRuns === 1, "a peek() read subscribed -- the effect re-ran: " + peekRuns);
assert(trackedRuns === 2, "a tracked read did not re-run: " + trackedRuns);
stopPeek();
stopTracked();
disposeReactive(cursor);

process.stdout.write(
    "cookbook r16 untrack-peek | peek-x=" + xNow + " peek-dist=" + distNow +
    " peek-runs=" + peekRuns + " tracked-runs=" + trackedRuns + " | ok\n",
);
