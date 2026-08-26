// test/torture/using-dispose.mjs -- node --expose-gc test/torture/using-dispose.mjs
//
// FORWARD-COMPAT scenario, floor 1.9.0 (PLAN-S4 PD-25, Workstream K).
//
// Probed peer surface: the native TC39 disposable protocol on ENGINE handles --
// a `[Symbol.dispose]()` method stamped on signalBox / computedBox / effect /
// createRegistry / createScope handles so a `using` binding tears the handle
// down at block exit. Detected STRUCTURALLY via ../shared/peer-probe.mjs
// (`hasDisposeProtocol()` on a live signalBox handle), never by version and
// never on the module surface -- the stamp lives on the handle. ADDED in
// @zakkster/lite-signal 1.9.0-preview.6 (stamped at five creation sites);
// disposal is idempotent.
//
// When the surface is ABSENT (peer < 1.9.0, e.g. the installed 1.5.0) the
// scenario SKIPS with exit 77 -- legitimate below the floor. run.mjs's
// floor-escalation law turns a 77 into a FAIL if the installed peer is AT or
// ABOVE 1.9.0, so a dropped stamp can never masquerade as a skip.
//
// When the surface is PRESENT the scenario PINS:
//   (1) OUR decorator lifecycle holds verbatim under the disposable engine -- a
//       decorated instance cascades EXACTLY P+D+E+1, double-dispose is
//       idempotent, a post-dispose touch poisons (ReactiveDisposedError), F-0;
//   (2) native `using` over engine handles (signalBox + effect) tears them down
//       at block exit and a redundant [Symbol.dispose] (explicit dispose then
//       two Symbol.dispose calls) moves nothing -- conservation exact;
//   (3) a `using`-managed engine effect observing a decorated instance's box
//       shares one graph with our disposeReactive: block exit disposes the
//       engine effect while the decorated instance stays live, then
//       disposeReactive cascades it, stays idempotent on a second call, and
//       still poisons -- F-0, zero interference between the two disposal paths.
//
// TORTURE_BREAK=using-dispose SABOTAGES THE PROBE: it claims the surface is
// present even when it is not. On the installed 1.5.0 that forces the body to
// run against handles that carry no [Symbol.dispose], so the protocol assertion
// fails and the scenario exits non-zero -- exactly what --controls demands,
// making the control meaningful even with 1.5.0 installed.
//
// ASCII-only.

import * as signal from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { makeClasses } from "../shared/mock-emitter.mjs";
import * as probe from "../shared/peer-probe.mjs";
import {
    RUN, check, breakActive, conservationBaseline, assertConserved, settle, pass,
} from "./helpers/harness.mjs";

const NAME = "using-dispose";

// --- feature gate -------------------------------------------------------------

let present = probe.hasDisposeProtocol();
// BREAK: lie that the surface is present so a below-floor engine runs the body
// and dies loudly when the protocol assertion below finds no [Symbol.dispose]
// on its handles (the --controls self-test).
if (breakActive(NAME)) present = true;

if (!present) {
    process.stdout.write(
        "torture: SKIP -- " + NAME + " (engine [Symbol.dispose] absent; needs peer >= 1.9.0)\n",
    );
    process.exit(77);
}

// Confirm the stamp is truly callable before leaning on `using`. Under the
// break-lie on a pre-1.9.0 engine this fails (the stamp is undefined) and the
// scenario exits non-zero -- the control's whole point.
{
    const probeBox = signal.signalBox(0);
    check(
        typeof probeBox[Symbol.dispose] === "function",
        () => "engine handle lacks [Symbol.dispose] -- the probed surface is absent",
    );
    probeBox[Symbol.dispose]();
}

const { Counter } = makeClasses(pkg);
// Counter: P=3 signals + D=2 deriveds + E=1 effect + 1 anchor => P+D+E+1 = 7.
const PD1 = 7;

// --- warmup: size the pool above every block's concurrent peak ----------------

{
    const warm = [];
    for (let i = 0; i < 4; i++) warm.push(new Counter());
    {
        using b = signal.signalBox(0);
        using s = signal.effect(() => { b.get(); });
    }
    for (let i = 0; i < warm.length; i++) pkg.disposeReactive(warm[i]);
}

// --- (1) OUR cascade + poison hold verbatim under the 1.9.0 engine ------------

RUN.op = 0;
{
    const base = conservationBaseline();
    const c = new Counter();
    const d0 = signal.stats().totalDisposals;
    const moved = pkg.disposeReactive(c);
    check(moved === true, () => "cascade: first disposeReactive returned " + moved);
    check(
        signal.stats().totalDisposals - d0 === PD1,
        () => "cascade: disposed " + (signal.stats().totalDisposals - d0) + " nodes, expected P+D+E+1=" + PD1,
    );
    check(pkg.disposeReactive(c) === false, () => "cascade: double dispose was not idempotent");

    let poisoned = false;
    try { void c.count; } catch (e) { poisoned = e instanceof pkg.ReactiveDisposedError; }
    check(poisoned, () => "cascade: post-dispose read did not throw ReactiveDisposedError");

    assertConserved(base, "using-dispose decorated cascade teardown");
}

// --- (2) native `using` over engine handles + idempotency ---------------------

RUN.op = 1;
{
    const base = conservationBaseline();
    {
        using box = signal.signalBox(5);
        check(box.get() === 5, () => "using: box.get()=" + box.get());
        using stop = signal.effect(() => { box.get(); });
        void stop;
    }
    // Block exit ran both [Symbol.dispose] hooks (reverse order) -> back to F-0.
    assertConserved(base, "using-dispose native-using teardown");

    // Redundant disposal moves nothing: explicit dispose, then two Symbol.dispose.
    const b2 = signal.signalBox(1);
    signal.dispose(b2);
    const d = signal.stats().totalDisposals;
    b2[Symbol.dispose]();
    b2[Symbol.dispose]();
    check(
        signal.stats().totalDisposals === d,
        () => "using: redundant [Symbol.dispose] moved totalDisposals by " + (signal.stats().totalDisposals - d),
    );
    assertConserved(base, "using-dispose idempotency teardown");
}

// --- (3) using-managed engine handle sharing a graph with disposeReactive -----

RUN.op = 2;
{
    const base = conservationBaseline();
    const vm = new Counter();
    {
        // A `using`-scoped engine effect observes the decorated instance's box.
        using stop = signal.effect(() => { pkg.boxOf(vm, "count").get(); });
        void stop;
        vm.count = 1;
        check(vm.double === 2, () => "interop: derived stale under a using-observed instance, double=" + vm.double);
    }
    // The using-scoped engine effect is gone; the decorated instance still lives.
    check(
        pkg.rootOf(vm).kind === "effect",
        () => "interop: using-block disposal cascaded the decorated instance",
    );
    const moved = pkg.disposeReactive(vm);
    check(moved === true, () => "interop: disposeReactive returned " + moved);
    check(pkg.disposeReactive(vm) === false, () => "interop: double disposeReactive not idempotent");

    let poisoned = false;
    try { void vm.count; } catch (e) { poisoned = e instanceof pkg.ReactiveDisposedError; }
    check(poisoned, () => "interop: post-dispose read did not poison");

    assertConserved(base, "using-dispose interop teardown");
}

// --- final quiesce ------------------------------------------------------------

await settle();
RUN.op = -1;
pass(NAME);
