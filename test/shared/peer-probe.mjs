// test/shared/peer-probe.mjs -- forward-compat FEATURE DETECTION for the
// @zakkster/lite-signal peer (PLAN-S4 PD-25, Workstream K).
//
// This module NEVER parses a version. It answers exactly one question per
// surface: does the imported peer expose it, right now, by structure? Every
// forward torture scenario (scope-adoption, using-dispose) and every future
// test gates its RUN/SKIP on these probes, so a scenario that skips can only
// mean the export is genuinely absent -- not that a version string was misread.
//
// Discovered peer surfaces (probed empirically against the published dist-tags
// on 2026-08-26):
//   - createScope(fn)  -- ADDED in 1.6.0-beta-1. The disposable-owner
//     counterpart to createRoot: runs fn(dispose) in a detached, untracked
//     scope, adopts the computeds/effects created inside, and hands back one
//     cascade-disposer. Bare signals are NOT adopted (mirrors our decorator
//     box model). Probed as `has("createScope")`.
//   - [Symbol.dispose] stamp on engine handles -- ADDED in 1.9.0-preview.6.
//     signalBox / computedBox / effect / createRegistry / createScope each
//     carry a `[Symbol.dispose]()` method so a TC39 `using` binding tears the
//     handle down at block exit; idempotent. Probed STRUCTURALLY on a live
//     signalBox handle (`hasDisposeProtocol()`), never on the module surface,
//     because the stamp lives on the handle, not on an export.
//
// ASCII-only. Zero dependencies beyond the peer.

import * as signal from "@zakkster/lite-signal";

/**
 * True iff the peer exports `name` as a callable. Namespace access (not a named
 * import) so a MISSING export reads as `undefined` instead of a link-time
 * SyntaxError -- the whole point of feature detection is that the absent case
 * must not crash the loader.
 * @param {string} name
 * @returns {boolean}
 */
export function has(name) {
    return typeof signal[name] === "function";
}

/**
 * True iff the engine stamps the TC39 disposable protocol on its handles
 * (1.9.0+). Detected on a live `signalBox` handle -- the stamp lives on the
 * handle, not on any export -- then the probe box is torn down so detection
 * leaves the default registry exactly as it found it. Fails closed: any throw
 * while constructing the probe box reports the surface ABSENT.
 * @returns {boolean}
 */
export function hasDisposeProtocol() {
    let box = null;
    try {
        box = signal.signalBox(0);
    } catch (_) {
        return false;
    }
    const ok = box != null && typeof box[Symbol.dispose] === "function";
    try { signal.dispose(box); } catch (_) { /* best-effort teardown */ }
    return ok;
}

/**
 * A one-shot snapshot of every forward surface a scenario cares about, by
 * structure only. Handy for a scenario header line documenting what it probed.
 * @returns {{ createScope:boolean, createRoot:boolean, getOwner:boolean,
 *             runWithOwner:boolean, flush:boolean, disposeProtocol:boolean }}
 */
export function probeSurface() {
    return {
        createScope: has("createScope"),
        createRoot: has("createRoot"),
        getOwner: has("getOwner"),
        runWithOwner: has("runWithOwner"),
        flush: has("flush"),
        disposeProtocol: hasDisposeProtocol(),
    };
}
