// cookbook/r14-abort-dispose.mjs -- node cookbook/r14-abort-dispose.mjs
//
// Recipe 14 (Working, not gated): tie teardown to an AbortSignal. Stamp
// 2026-08-30. One addEventListener line bridges any AbortController-based
// lifecycle to a VM's single teardown; a `using` binding does the same through
// Symbol.dispose. Snippets live in `#region cookbook:r14.k` spans; the harness is
// OUTSIDE them.
//
// NOT gated: this is a teardown boundary, not a frame path. disposeReactive is
// allocation-free on its success path, but binding it to a scope is a lifecycle
// concern, run once per instance, off any hot loop.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

function fail(msg) {
    process.stderr.write("cookbook r14 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }

// #region cookbook:r14.1
import { defineReactive, disposeReactive, ReactiveDisposedError } from "@zakkster/lite-signal-decorators";

// Bridge any AbortController-based lifecycle to a VM's single teardown: one
// listener, fired once, disposes the instance when the scope aborts. { once: true }
// drops the listener after it fires, so the bridge itself leaves nothing behind --
// the AbortController owns the "when", disposeReactive owns the "what".
const Session = defineReactive(class Session {}, {
    signals: { token: null, active: true },
    deriveds: {},
    effects: {},
});

function bindToScope(vm, signal) {
    signal.addEventListener("abort", () => disposeReactive(vm), { once: true });
    return vm;
}
// #endregion cookbook:r14.1

// #region cookbook:r14.2
// Or let a block scope own it. disposeReactive is also wired to Symbol.dispose,
// so a `using` binding tears the instance down at the end of the block -- the same
// idempotent teardown, no explicit call and no AbortController. Reach for the
// AbortSignal form when the lifetime is an external scope; reach for `using` when
// it is exactly a block.
function inScope() {
    using session = new Session();   // disposed at block exit via Symbol.dispose
    session.token = "abc";
    return session.token;            // teardown fires after the return value is read
}
// #endregion cookbook:r14.2

// --- exercise (harness) -------------------------------------------------------

// 1. The AbortSignal bridge disposes the VM exactly when the scope aborts.
const controller = new AbortController();
const session = bindToScope(new Session(), controller.signal);
session.token = "live";
assert(session.token === "live", "member write before abort was refused");

controller.abort();
let poisoned = null;
try { session.token = "stale"; } catch (e) { if (e instanceof ReactiveDisposedError) poisoned = e.className + "." + e.key; }
assert(poisoned === "Session.token", "abort did not dispose the VM (post-abort write not poisoned): " + poisoned);

// 2. Double-dispose is idempotent: a second teardown is a no-op, not a throw.
const again = disposeReactive(session);
assert(again === false, "disposeReactive on an already-disposed VM did not return false: " + again);

// 3. The `using` form disposes at block exit; the returned value is still read.
const value = inScope();
assert(value === "abc", "using block returned the wrong value: " + value);

// 4. A never-aborted scope leaves its VM live and its listener inert.
const liveController = new AbortController();
const liveSession = bindToScope(new Session(), liveController.signal);
liveSession.token = "kept";
assert(liveSession.token === "kept", "an un-aborted scope disposed its VM early");
disposeReactive(liveSession);

process.stdout.write(
    "cookbook r14 abort-dispose | abort-poison=" + poisoned +
    " double-dispose=" + again + " using=" + value + " | ok\n",
);
