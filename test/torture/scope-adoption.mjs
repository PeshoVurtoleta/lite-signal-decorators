// test/torture/scope-adoption.mjs -- node --expose-gc test/torture/scope-adoption.mjs
//
// FORWARD-COMPAT scenario, floor 1.6.0 (PLAN-S4 PD-25, Workstream K).
//
// Probed peer surface: `createScope` (a top-level function export). Detected
// STRUCTURALLY via ../shared/peer-probe.mjs (`has("createScope")`), never by
// version. ADDED in @zakkster/lite-signal 1.6.0-beta-1: the disposable-owner
// counterpart to createRoot -- `createScope(fn)` runs `fn(dispose)` in a
// detached, untracked scope, ADOPTS the computeds/effects created inside, hands
// back one cascade-disposer, and does NOT adopt bare signals (the engine never
// owner-adopts a signal). That adoption model is the exact mirror of OUR
// decorator conservation: deriveds + effects + the anchor cascade together,
// signal boxes stay bare and are explicitly disposed.
//
// When the surface is ABSENT (peer < 1.6.0, e.g. the installed 1.5.0) the
// scenario SKIPS with exit 77 -- legitimate below the floor. run.mjs's
// floor-escalation law turns a 77 into a FAIL if the installed peer is AT or
// ABOVE 1.6.0, so a dropped export can never masquerade as a skip.
//
// When the surface is PRESENT the scenario PINS that OUR invariants hold
// verbatim under the new engine:
//   (1) a decorated instance still cascades EXACTLY P+D+E+1 on disposeReactive,
//       double-dispose stays idempotent, and a post-dispose touch still poisons
//       (ReactiveDisposedError); conservation is F-0 after teardown;
//   (2) createScope's own adoption contract holds and matches our box model --
//       the adopted computed + effect + scope-owner cascade on the disposer, the
//       BARE signal does not (exactly one node survives until hand-disposed);
//   (3) a decorated instance built INSIDE a createScope body is NOT adopted by
//       that scope (our wiring detaches via createRoot, R-A): the scope's
//       disposer tears down its adopted engine effect while the decorated
//       instance stays fully live, then disposeReactive reclaims it to F-0 --
//       the two ownership worlds share one graph with zero interference.
//
// TORTURE_BREAK=scope-adoption SABOTAGES THE PROBE: it claims the surface is
// present even when it is not. On the installed 1.5.0 that forces the scenario
// to run against a MISSING createScope, so the first call throws and the
// scenario exits non-zero -- which is exactly what --controls demands, making
// the control meaningful even with 1.5.0 installed.
//
// ASCII-only.

import * as signal from "@zakkster/lite-signal";
import * as pkg from "../../SignalDecorators.js";
import { makeClasses } from "../shared/mock-emitter.mjs";
import * as probe from "../shared/peer-probe.mjs";
import {
    RUN, check, breakActive, conservationBaseline, assertConserved, settle, pass,
} from "./helpers/harness.mjs";

const NAME = "scope-adoption";

// --- feature gate -------------------------------------------------------------

let present = probe.has("createScope");
// BREAK: lie that the surface is present so a below-floor engine runs the body
// and dies loudly on the first createScope call (the --controls self-test).
if (breakActive(NAME)) present = true;

if (!present) {
    process.stdout.write(
        "torture: SKIP -- " + NAME + " (createScope absent; needs peer >= 1.6.0)\n",
    );
    process.exit(77);
}

// Resolved through the namespace, never a named import: a missing export must
// read as `undefined` (and throw on call under the break-lie), not crash the
// module loader at link time.
const createScope = signal.createScope;

const { Counter } = makeClasses(pkg);
// Counter: P=3 signals + D=2 deriveds + E=1 effect + 1 anchor => P+D+E+1 = 7.
const PD1 = 7;

// --- warmup: size the pool above every block's concurrent peak ----------------
// so poolGrowths stays flat under the measured baselines below.

{
    const warm = [];
    for (let i = 0; i < 4; i++) warm.push(new Counter());
    const wd = createScope((dispose) => {
        signal.effect(() => {});
        signal.computedBox(() => 1);
        return dispose;
    });
    wd();
    for (let i = 0; i < warm.length; i++) pkg.disposeReactive(warm[i]);
}

// --- (1) OUR cascade + poison hold verbatim under the 1.6.0 engine ------------

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

    assertConserved(base, "scope-adoption decorated cascade teardown");
}

// --- (2) createScope adoption mirrors our bare-box model ----------------------

RUN.op = 1;
{
    const base = conservationBaseline();
    let bare = null;
    const disposer = createScope((dispose) => {
        bare = signal.signalBox(1);                 // NOT adopted (a signal)
        const comp = signal.computedBox(() => bare.get() + 1);   // adopted
        signal.effect(() => { comp.get(); });        // adopted
        return dispose;
    });
    // Adopted computed + effect + scope-owner cascade; the bare signal remains.
    disposer();
    check(
        signal.stats().activeNodes === base.activeNodes + 1,
        () => "scope: expected exactly the bare signal to survive, activeNodes delta=" +
            (signal.stats().activeNodes - base.activeNodes),
    );
    signal.dispose(bare);
    assertConserved(base, "scope-adoption bare-signal teardown");
}

// --- (3) a decorated instance is NOT adopted by an enclosing createScope ------
//
// Our wiring detaches via createRoot (R-A), so the scope adopts only the engine
// effect created directly in its body. The scope disposer must tear that effect
// down while the decorated instance stays fully live -- one graph, zero
// interference between the two ownership worlds.

RUN.op = 2;
{
    const base = conservationBaseline();
    let vm = null;
    const disposer = createScope((dispose) => {
        vm = new Counter();                          // detached: NOT adopted
        const box = pkg.boxOf(vm, "count");
        signal.effect(() => { box.get(); });          // adopted by the scope
        return dispose;
    });

    disposer();                                       // cascades ONLY the engine effect
    check(
        pkg.rootOf(vm).kind === "effect",
        () => "interop: scope disposal cascaded the decorated instance (anchor gone)",
    );
    vm.count = 3;                                     // still live -> derived recomputes
    check(vm.double === 6, () => "interop: decorated derived dead after scope disposal, double=" + vm.double);

    pkg.disposeReactive(vm);
    assertConserved(base, "scope-adoption interop teardown");
}

// --- final quiesce ------------------------------------------------------------

await settle();
RUN.op = -1;
pass(NAME);
