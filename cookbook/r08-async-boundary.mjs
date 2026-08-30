// cookbook/r08-async-boundary.mjs -- node --expose-gc cookbook/r08-async-boundary.mjs
//
// Recipe 8: the async boundary. lite-await at LIFECYCLE boundaries only -- a
// promise settles INTO a signal, never inside a frame loop. Stamp 2026-08-30.
// Companion for COOKBOOK.md; snippets live in `#region cookbook:r8.k` spans,
// harness is OUTSIDE them.
//
// NOT gated: lite-await allocates a Promise per call BY DESIGN. That is a
// lifecycle boundary cost, not a frame path, so it is out of the zero-GC lane.
// whenAsync stays refused per PD-30 (it allocates a Promise per call in a place
// that pretends to be hot) -- fromPromise / whenSignal are the boundary tools.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

function fail(msg) {
    process.stderr.write("cookbook r8 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }

// #region cookbook:r8.1
import { fromPromise, whenSignal } from "@zakkster/lite-await";
import { defineReactive, disposeReactive, ReactiveDisposedError } from "@zakkster/lite-signal-decorators";

// fromPromise(promise, initial) settles a promise INTO a signal: it reads
// `pending` now and flips to `resolved`/`rejected` later. The signal lives in
// the default registry. This is a boundary call -- one per load, not per frame.
function loadProfile(id) {
    return fromPromise(fetchProfile(id), { name: "(loading)" });
}

class ProfileCard {}
const ProfileCardVM = defineReactive(ProfileCard, {
    signals: { name: "(loading)", ready: false },
    deriveds: {},
    effects: {},
});
// #endregion cookbook:r8.1

// #region cookbook:r8.2
// whenSignal(source, predicate) is the wait-for-condition shape: it resolves
// with the first value where the predicate holds, then cleans its own effect.
// The source READS a reactive member, so a later write is what settles it.
async function untilReady(card) {
    await whenSignal(() => card.ready, (r) => r === true);
    return card.name;
}
// #endregion cookbook:r8.2

// #region cookbook:r8.3
// The payoff. A settlement that arrives AFTER disposeReactive is a stale write.
// Instead of silently landing on a dead instance, the poisoned slot throws a
// ReactiveDisposedError naming Class.key -- the outcome you WANT: a late async
// write becomes LOUD, not a phantom mutation. Catch it and treat it as success.
function applyName(card, name) {
    try {
        card.name = name;               // poisoned after dispose -> throws
        return { applied: true, error: null };
    } catch (e) {
        if (e instanceof ReactiveDisposedError) {
            return { applied: false, error: e.className + "." + e.key };
        }
        throw e;
    }
}
// #endregion cookbook:r8.3

// --- exercise (harness) -------------------------------------------------------

// A controllable "fetch" so the companion is deterministic.
let releaseFetch;
function fetchProfile(_id) {
    return new Promise((res) => { releaseFetch = () => res({ name: "Grace" }); });
}

const state = loadProfile(7);
assert(state().status === "pending", "fromPromise did not start pending");

const card = new ProfileCardVM();
const readyPromise = untilReady(card);
card.ready = true;
const readyName = await readyPromise;
assert(readyName === "(loading)", "whenSignal resolved before the value was set");

// Now dispose, THEN let the fetch settle late. The write is refused, loudly.
disposeReactive(card);
releaseFetch();
await new Promise((r) => setTimeout(r, 0));
assert(state().status === "resolved" && state().data.name === "Grace", "fromPromise did not settle");

const outcome = applyName(card, state().data.name);
assert(outcome.applied === false, "a post-dispose write was allowed to land silently");
assert(outcome.error === "ProfileCard.name", "wrong poison target: " + outcome.error);

process.stdout.write(
    "cookbook r8 async-boundary | settled=" + state().status +
    " late-write-refused=" + outcome.error + " | ok\n",
);
