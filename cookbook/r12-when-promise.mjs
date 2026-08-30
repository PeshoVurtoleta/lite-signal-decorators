// cookbook/r12-when-promise.mjs -- node cookbook/r12-when-promise.mjs
//
// Recipe 12 (Working, not gated): wait for a condition, as a Promise. Stamp
// 2026-08-30. The manual "when" under the hood -- a withResolvers deferred plus
// one self-disposing effect that reads a @derived predicate -- and the packaged
// lite-await form (whenSignal through a THUNK, with timeout + AbortSignal
// variants). Snippets live in `#region cookbook:r12.k` spans; the harness is
// OUTSIDE them.
//
// NOT gated: lite-await allocates a Promise per call BY DESIGN -- a lifecycle
// boundary, not a frame path. whenAsync stays refused (PD-30): a Promise per
// call in a hot-looking place is exactly the shape that stays out.
//
// PROBE RESULT (2026-08-30): whenTruthy(boxOf(vm, key), { timeout }) does NOT
// compose -- lite-signal 1.5.0's SignalBox is a non-callable object and
// whenSignal requires a callable source, so it throws "source must be a
// function". You pass a thunk that reads the member; the harness asserts the
// non-callable throw so the honest line stays true.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

function fail(msg) {
    process.stderr.write("cookbook r12 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }

// #region cookbook:r12.1
import { withResolvers } from "@zakkster/lite-await";
import { effect } from "@zakkster/lite-signal";
import { defineReactive } from "@zakkster/lite-signal-decorators";

// A "when" as a Promise, under the hood. The predicate is a @derived member; one
// effect reads it and resolves a withResolvers deferred the first time it holds,
// then disposes ITSELF -- a resolved wait leaks nothing. withResolvers() is one
// Promise per call, allocated at the boundary, never inside a frame loop.
const Connection = defineReactive(class Connection {}, {
    signals: { status: "idle" },
    deriveds: { isLive: (vm) => vm.status === "live" },   // the predicate, as a derived
    effects: {},
});

function whenMember(vm, read, predicate) {
    const { promise, resolve } = withResolvers();
    let settled = false;
    let stop = null;
    stop = effect(() => {
        const value = read(vm);                 // reads the derived -> tracks it
        if (settled) return;
        if (predicate(value)) {
            settled = true;
            resolve(value);
            if (stop) stop();                   // self-dispose on first hit
        }
    });
    return promise;
}
// #endregion cookbook:r12.1

// #region cookbook:r12.2
import { whenSignal, TimeoutError } from "@zakkster/lite-await";

// The packaged form: lite-await's whenSignal reads through a THUNK, never the box
// handle -- a SignalBox (1.5.0) is a non-callable object, so whenTruthy(boxOf(
// vm, key)) throws "source must be a function". Wrap the read in `() => ...` and
// every awaiter option composes: { timeout } rejects TimeoutError if the wait
// never settles; { signal } lets an AbortController tear it down early. whenSignal
// cleans its own effect on every settlement path.
async function untilLive(conn, opts) {
    await whenSignal(() => conn.isLive, (v) => v === true, opts);
    return conn.status;
}
// #endregion cookbook:r12.2

// --- exercise (harness) -------------------------------------------------------

// 1. The manual form resolves on the write that flips the predicate.
const c1 = new Connection();
const live1 = whenMember(c1, (vm) => vm.isLive, (v) => v === true);
c1.status = "live";
const settledValue = await live1;
assert(settledValue === true, "whenMember did not resolve with the predicate value");

// 2. The packaged form, happy path.
const c2 = new Connection();
const p2 = untilLive(c2);
c2.status = "live";
const status2 = await p2;
assert(status2 === "live", "untilLive resolved with the wrong status: " + status2);

// 3. The timeout variant: a wait that never comes true rejects TimeoutError.
const c3 = new Connection();
let timedOut = null;
try {
    await untilLive(c3, { timeout: 10 });     // stays "idle" -> deadline fires
} catch (e) {
    if (e instanceof TimeoutError) timedOut = e.name;
}
assert(timedOut === "TimeoutError", "timeout variant did not reject TimeoutError: " + timedOut);

// 4. The AbortSignal variant: an aborted scope tears the wait down (AbortError).
const c4 = new Connection();
const ctrl = new AbortController();
let aborted = null;
const p4 = untilLive(c4, { signal: ctrl.signal }).catch((e) => { aborted = e.name; });
ctrl.abort();
await p4;
assert(aborted === "AbortError", "abort variant did not reject AbortError: " + aborted);

// 5. The honest line, proven: the box handle itself is NOT a callable source.
import { whenTruthy } from "@zakkster/lite-await";
import { boxOf } from "@zakkster/lite-signal-decorators";
const c5 = new Connection();
let boxThrew = null;
await whenTruthy(boxOf(c5, "status"))          // a SignalBox is not a function
    .catch((e) => { boxThrew = e.constructor.name; });
assert(boxThrew === "TypeError", "whenTruthy(box handle) did not reject TypeError: " + boxThrew);

process.stdout.write(
    "cookbook r12 when-promise | manual=" + settledValue + " packaged=" + status2 +
    " timeout=" + timedOut + " abort=" + aborted + " box-not-callable=" + boxThrew +
    " | ok\n",
);
