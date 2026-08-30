// cookbook/r15-async-state.mjs -- node cookbook/r15-async-state.mjs
//
// Recipe 15 (Working, not gated): async state without async in the graph. Stamp
// 2026-08-30. Three plain reactive members {state, value, error} written by a
// PLAIN promise handler at the settlement boundary; nothing async lives in the
// reactive graph. A settlement that lands AFTER disposeReactive THROWS the named
// poison error -- the WANTED outcome, r8's law restated at the pattern level.
// Snippets live in `#region cookbook:r15.k` spans; the harness is OUTSIDE them.
//
// NOT gated: settlement allocates at the boundary by design (the promise handler
// and the Promise itself). The graph only ever sees synchronous signal writes;
// the allocation is the lifecycle edge, not a frame path.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

function fail(msg) {
    process.stderr.write("cookbook r15 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }

// #region cookbook:r15.1
import { defineReactive, disposeReactive, ReactiveDisposedError } from "@zakkster/lite-signal-decorators";

// Three plain reactive members model an async result -- state, value, error --
// and NOTHING async lives in the reactive graph. A plain promise handler writes
// the members at the settlement boundary; the graph only ever sees synchronous
// signal writes, so every reader (a derived, an effect, a watcher) stays in the
// zero-GC world. lite-await's fromPromise packages this exact three-state shape
// as one signal when you want the packaged form.
const Query = defineReactive(class Query {}, {
    signals: { state: "idle", value: null, error: null },
    deriveds: { settled: (vm) => vm.state === "done" || vm.state === "failed" },
    effects: {},
});

function run(vm, promise) {
    vm.state = "pending";
    promise.then(
        (v) => { vm.value = v; vm.state = "done"; },      // plain handler, synchronous writes
        (e) => { vm.error = e; vm.state = "failed"; },
    );
    return vm;
}
// #endregion cookbook:r15.1

// #region cookbook:r15.2
// The settlement boundary is where a late promise meets a dead instance. After
// disposeReactive, every member slot is poisoned, so a settlement that lands
// after teardown THROWS ReactiveDisposedError naming Class.key -- the WANTED
// outcome: a stale async write is loud, never a phantom mutation on an object
// nobody owns anymore. A real handler lets that throw propagate to a rejection
// sink; the graph is never silently corrupted.
function settleInto(vm, value) {
    try {
        vm.value = value;
        vm.state = "done";
        return { landed: true, error: null };
    } catch (e) {
        if (e instanceof ReactiveDisposedError) return { landed: false, error: e.className + "." + e.key };
        throw e;
    }
}
// #endregion cookbook:r15.2

// --- exercise (harness) -------------------------------------------------------

// A controllable promise so the companion is deterministic.
let release;
const gate = new Promise((res) => { release = () => res({ id: 7 }); });

// 1. The happy path: a plain handler writes the members; the graph stays sync.
const q = new Query();
run(q, gate);
assert(q.state === "pending", "run did not move the query to pending");
release();
await new Promise((r) => setTimeout(r, 0));
assert(q.state === "done" && q.value.id === 7, "settlement did not write the members");
assert(q.settled === true, "the derived did not see the synchronous write");

// 2. The poison boundary: a settlement after dispose THROWS -- the wanted outcome.
disposeReactive(q);
const outcome = settleInto(q, { id: 9 });
assert(outcome.landed === false, "a post-dispose settlement was allowed to land silently");
assert(outcome.error === "Query.value", "wrong poison target on the late settlement: " + outcome.error);

process.stdout.write(
    "cookbook r15 async-state | state=done value=7 settled=true late-settlement-refused=" +
    outcome.error + " | ok\n",
);
