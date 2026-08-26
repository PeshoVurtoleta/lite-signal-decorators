// test/shared/behavior-suite.mjs -- the single observable-behavior contract run
// identically over three build paths: the mock emitter (01), the TS emit (02),
// and the Babel emit (03). It asserts OBSERVABLES only -- values, recompute
// counts, stats() F-0 deltas, error names/substrings -- never internals.
//
// `classes` is the shape makeClasses(pkg) / the compiled fixture export:
//   { Counter, Base, Derived, Leaf, SYM, recompute, effectFires, pkg }
// where `pkg` is the package instance that built the classes (so boxOf/rootOf/
// disposeReactive share the same PLANS WeakMap), `recompute` is the counter
// object the derived bodies bump, and `effectFires` is the counter object the
// @reactiveEffect bodies bump.
//
// ASCII-only. node:test only.

import assert from "node:assert/strict";
import { stats } from "@zakkster/lite-signal";

// Snapshot the live node count -- F-0 conservation key (decisions/0002).
function active() {
    return stats().activeNodes;
}

/**
 * Run the full behavior contract as node:test subtests under `t`. `label`
 * distinguishes the build path in failure output.
 */
export function behaviorSuite(t, classes, label) {
    const { Counter, Base, Derived, Leaf, SYM, recompute, effectFires, pkg } = classes;
    const { boxOf, rootOf, disposeReactive, ReactiveDisposedError } = pkg;

    t.test(label + ": initial values + declaration-order field read (L2)", () => {
        const c = new Counter();
        assert.equal(c.count, 0);
        assert.equal(c.level, 0);
        assert.equal(c[SYM], "tag");
        // `late = this.count + 1` read count's live box during field init.
        assert.equal(c.late, 1);
        assert.equal(c.double, 0);
        disposeReactive(c);
    });

    t.test(label + ": construction allocates exactly P+D+E+1 nodes (anchor)", () => {
        // Counter: P=3 signals + D=2 deriveds + E=1 effect + 1 anchor = 7.
        const before = active();
        const c = new Counter();
        assert.equal(active() - before, 7, "Counter node delta");
        disposeReactive(c);
    });

    t.test(label + ": set/get round-trip through the signal box", () => {
        const c = new Counter();
        c.count = 41;
        assert.equal(c.count, 41);
        c[SYM] = "changed";
        assert.equal(c[SYM], "changed");
        disposeReactive(c);
    });

    t.test(label + ": derived recompute-on-write + laziness (memoized)", () => {
        const c = new Counter();
        const base = recompute.double;
        // First read computes once.
        assert.equal(c.double, 0);
        assert.equal(recompute.double - base, 1);
        // Re-read without a write: memoized, no recompute.
        assert.equal(c.double, 0);
        assert.equal(recompute.double - base, 1);
        // Write invalidates: next read recomputes exactly once.
        c.count = 5;
        assert.equal(c.double, 10);
        assert.equal(recompute.double - base, 2);
        assert.equal(c.double, 10);
        assert.equal(recompute.double - base, 2);
        disposeReactive(c);
    });

    t.test(label + ": custom equals suppresses propagation (recompute count)", () => {
        const c = new Counter();
        const base = recompute.band;
        // Prime the band derived (reads level).
        assert.equal(c.band, 0);
        assert.equal(recompute.band - base, 1);
        // A within-tolerance write (|0.3 - 0| < 0.5) is suppressed: band stays
        // clean, so re-reading does NOT recompute.
        c.level = 0.3;
        assert.equal(c.band, 0);
        assert.equal(recompute.band - base, 1);
        // A beyond-tolerance write propagates: band recomputes.
        c.level = 1;
        assert.equal(c.band, 1);
        assert.equal(recompute.band - base, 2);
        disposeReactive(c);
    });

    t.test(label + ": symbol-keyed member has a live box via boxOf", () => {
        const c = new Counter();
        const box = boxOf(c, SYM);
        assert.equal(box.peek(), "tag");
        c[SYM] = "next";
        assert.equal(box.peek(), "next");
        disposeReactive(c);
    });

    t.test(label + ": boxOf returns a live box; bogus key -> did-you-mean", () => {
        const c = new Counter();
        const box = boxOf(c, "count");
        assert.equal(typeof box.peek, "function");
        assert.equal(box.peek(), 0);
        assert.throws(
            () => boxOf(c, "cont"),
            (e) => /did you mean/.test(e.message) && /count/.test(e.message),
        );
        disposeReactive(c);
    });

    t.test(label + ": rootOf returns the anchor descriptor (kind effect)", () => {
        const c = new Counter();
        const root = rootOf(c);
        assert.equal(root.kind, "effect");
        disposeReactive(c);
    });

    t.test(label + ": Base/Derived wire once at the deepest host (L4)", () => {
        // Base alone: P=1 + D=1 + anchor = 3.
        let before = active();
        const b = new Base();
        assert.equal(active() - before, 3, "Base node delta");
        assert.equal(b.a, 1);
        assert.equal(b.da, 101);
        disposeReactive(b);

        // Derived (decorated, extends decorated Base): merged P=2 + D=2 +
        // E=1 effect + exactly ONE anchor = 6 -- it does NOT double for the chain.
        before = active();
        const d = new Derived();
        assert.equal(active() - before, 6, "Derived node delta (single anchor)");
        assert.equal(d.a, 1);
        assert.equal(d.b, 2);
        assert.equal(d.da, 101);
        assert.equal(d.db, 3);
        assert.ok(d instanceof Base, "Derived instanceof Base");
        disposeReactive(d);
    });

    t.test(label + ": undecorated subclass wires at the decorated ancestor", () => {
        const before = active();
        const leaf = new Leaf();
        // Leaf inherits Base's plan: P=1 + D=1 + anchor = 3.
        assert.equal(active() - before, 3, "Leaf node delta");
        assert.equal(leaf.a, 1);
        assert.equal(leaf.da, 101);
        assert.ok(leaf instanceof Base, "Leaf instanceof Base");
        // Inherited key reachable through boxOf.
        assert.equal(boxOf(leaf, "a").peek(), 1);
        disposeReactive(leaf);
    });

    t.test(label + ": wrapper name preserved + instanceof original", () => {
        assert.equal(Counter.name, "Counter");
        assert.equal(Base.name, "Base");
        assert.equal(Derived.name, "Derived");
        const c = new Counter();
        assert.ok(c instanceof Counter);
        disposeReactive(c);
    });

    t.test(label + ": @reactiveEffect fires exactly once at wire (per effect)", () => {
        // Counter's onCount fires once; Derived's onDb fires once -- each effect
        // runs exactly one synchronous first pass at leaf wiring, after every
        // field and every derived exists.
        let base = effectFires.counter;
        const c = new Counter();
        assert.equal(effectFires.counter - base, 1, "onCount wire-fire = 1");
        disposeReactive(c);

        base = effectFires.derived;
        const d = new Derived();
        assert.equal(effectFires.derived - base, 1, "onDb wire-fire = 1 (inheritance chain)");
        disposeReactive(d);
    });

    t.test(label + ": @reactiveEffect re-fires once per tracked mutation", () => {
        const base = effectFires.counter;
        const c = new Counter();
        assert.equal(effectFires.counter - base, 1, "wire fire");
        c.count = 5;
        assert.equal(effectFires.counter - base, 2, "one re-fire on the tracked write");
        c.count = 5; // equal under default Object.is: no propagation, no re-fire.
        assert.equal(effectFires.counter - base, 2, "no-op write does not re-fire");
        disposeReactive(c);
    });

    t.test(label + ": @batched coalesces its writes into one effect flush", () => {
        const c = new Counter();
        const base = effectFires.counter;   // already fired once at wire
        c.bump();                            // two writes inside one batch
        assert.equal(c.count, 2, "both writes landed");
        assert.equal(effectFires.counter - base, 1, "batched: one flush, not two");
        disposeReactive(c);
    });

    t.test(label + ": post-dispose writes through a captured box fire zero effects", () => {
        const c = new Counter();
        // Capture the live box BEFORE dispose so we still hold a write handle.
        const box = boxOf(c, "count");
        disposeReactive(c);
        const base = effectFires.counter;
        // The anchor cascade tore the effect down; a write through the captured
        // (now-dead) box cannot resurrect it. Guard the write: a disposed box's
        // slot may be recycled, so the set is best-effort -- the assertion is
        // that zero effect executions occur regardless.
        try { box.set(999); } catch (_) { /* disposed slot: irrelevant */ }
        assert.equal(effectFires.counter - base, 0, "zero effect executions after dispose");
    });

    t.test(label + ": Symbol.dispose disposes (using-style teardown)", () => {
        const before = active();
        const c = new Counter();
        assert.equal(typeof c[Symbol.dispose], "function");
        c[Symbol.dispose]();
        // Anchor + boxes reclaimed: back to baseline.
        assert.equal(active(), before);
        assert.throws(() => c.count, ReactiveDisposedError);
    });
}
