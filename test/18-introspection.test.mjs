// test/18-introspection.test.mjs -- the S9 introspection/migration pair
// (PLAN-S9 T6-T9, decisions 0009/0013): forEachReactive(vm, fn, arg) and
// snapshotOf(vm), the two new cold exports, proven on THREE lanes exactly like
// test/17 -- the TS standard emit fixture, the Babel 2023-11 emit fixture, and
// the buildless defineReactive path.
//
// The reactive-walk contract (PD-59..PD-64):
//   - forEachReactive visits every VALUE-BEARING member in PLAN order (signals,
//     then @localTo locals, then deriveds; each declaration-ordered) invoking
//     fn(key, box, kind, arg) and returning the visit count. @reactiveEffect and
//     @batched members are EXCLUDED (PD-60). `box` IS boxOf(vm, key). `arg`
//     threads caller state closure-free. Symbol keys are included (A7).
//   - snapshotOf returns a plain {} of the same member set, values read through
//     the ACCESSOR vm[key] (PD-62), the whole pass under ONE untrack when a
//     scope is active (PD-63) -- so a snapshot inside an effect subscribes to
//     nothing. Shallow by design (PD-64). It allocates by design (cold path).
//
// Fail-closed (A6/PD-65): non-reactive -> throwNoPlan; unwired -> throwNotWired;
// parked/disposed -> ReactiveDisposedError with the right message flavor.
//
// Run `npm run fixtures` first if the compiled-fixture imports fail to resolve.
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { effect } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import * as tsClasses from "./fixtures/ts-out/fixture.src.js";
import * as babelClasses from "./fixtures/babel-out/fixture.src.js";

const {
    defineReactive, forEachReactive, snapshotOf, boxOf,
    releaseReactive, disposeReactive, ReactiveDisposedError,
} = pkg;

const ERR = "@zakkster/lite-signal-decorators: ";

// A collector that records the four scalar args of every visit without
// allocating a descriptor -- the documented hoisted-callback pattern.
function collect(out, key, box, kind, arg) {
    out.keys.push(key);
    out.boxes.push(box);
    out.kinds.push(kind);
    out.args.push(arg);
}

// =================================================================================
// EMIT LANES -- the committed `Counter` fixture, run identically over the TS
// standard emit and the Babel 2023-11 emit. Counter's reactive shape: signals
// `count`, `level`, and the SYMBOL member SYM (P=3); deriveds `double`, `band`
// (D=2); an @reactiveEffect `onCount` and a @batched `bump` (both EXCLUDED).
// The walk therefore visits exactly 5, in the order count, level, SYM, double,
// band, and the snapshot carries exactly one symbol key (SYM).
// =================================================================================

function emitLaneSuite(t, classes, label) {
    const { Counter, SYM } = classes;

    t.test(label + ": forEachReactive visits P+D value-bearing members in plan order, effects/batched excluded", () => {
        const c = new Counter();
        const out = { keys: [], boxes: [], kinds: [], args: [] };
        const n = forEachReactive(c, (k, b, kind, a) => collect(out, k, b, kind, a));

        assert.equal(n, 5, "3 signals + 2 deriveds; onCount (effect) and bump (batched) excluded");
        assert.equal(out.keys.length, 5, "the callback fired exactly once per visited member");
        assert.equal(out.keys[0], "count");
        assert.equal(out.keys[1], "level");
        assert.equal(out.keys[2], SYM, "the symbol signal member sits in plan order at index 2");
        assert.equal(out.keys[3], "double");
        assert.equal(out.keys[4], "band");
        assert.deepEqual(out.kinds, ["signal", "signal", "signal", "derived", "derived"]);
        assert.ok(out.keys.indexOf("onCount") === -1, "the @reactiveEffect member never appears");
        assert.ok(out.keys.indexOf("bump") === -1, "the @batched member never appears");
        disposeReactive(c);
    });

    t.test(label + ": the box handed to fn IS boxOf(vm, key) (identity)", () => {
        const c = new Counter();
        forEachReactive(c, (k, b) => {
            assert.equal(b, boxOf(c, k), "the walk box === boxOf for " + String(k));
        });
        disposeReactive(c);
    });

    t.test(label + ": the arg pass-through threads caller state closure-free", () => {
        const c = new Counter();
        const sentinel = { tag: "carry" };
        let sawSentinel = 0;
        const n = forEachReactive(c, (k, b, kind, a) => {
            if (a === sentinel) sawSentinel++;
        }, sentinel);
        assert.equal(sawSentinel, n, "every visit received the same arg by identity");
        disposeReactive(c);
    });

    t.test(label + ": A7 -- a symbol member appears in the walk AND the snapshot; getOwnPropertySymbols length 1", () => {
        const c = new Counter();
        const out = { keys: [], boxes: [], kinds: [], args: [] };
        forEachReactive(c, (k, b, kind, a) => collect(out, k, b, kind, a));
        assert.ok(out.keys.indexOf(SYM) !== -1, "the symbol member is visited by forEachReactive");

        const snap = snapshotOf(c);
        const syms = Object.getOwnPropertySymbols(snap);
        assert.equal(syms.length, 1, "exactly one symbol key survives into the snapshot");
        assert.equal(syms[0], SYM, "and it is SYM");
        assert.equal(snap[SYM], c[SYM], "the symbol value is the live accessor read");
        // string members: count, level, double, band == 4.
        assert.equal(Object.keys(snap).length, 4, "the four string-keyed members");
        disposeReactive(c);
    });
}

test("introspection over the TS standard emit", (t) => {
    emitLaneSuite(t, tsClasses, "ts");
});

test("introspection over the Babel 2023-11 emit", (t) => {
    emitLaneSuite(t, babelClasses, "babel");
});

// =================================================================================
// BUILDLESS LANE -- r7's CharacterVM shape, built as a defineReactive twin:
// signals name/hp/mp (P=3), a derived `alive` (D=1), an effect `regen` (E=1,
// EXCLUDED). This is the A2 shape and the T9 r7-parity shape.
// =================================================================================

function makeCharacterVM() {
    return defineReactive(class Character {}, {
        signals: { name: "Vega", hp: 100, mp: 30 },
        deriveds: { alive: (vm) => vm.hp > 0 },
        effects: { regen: (vm) => { void vm.mp; } },
    });
}

test("buildless A2: forEachReactive returns exactly 4 in order name,hp,mp,alive; regen excluded; kinds correct", () => {
    const CharacterVM = makeCharacterVM();
    const hero = new CharacterVM();
    void hero.alive;                     // force the lazy derived's links to form

    const out = { keys: [], boxes: [], kinds: [], args: [] };
    const n = forEachReactive(hero, (k, b, kind, a) => collect(out, k, b, kind, a));

    assert.equal(n, 4, "3 signals + 1 derived; the regen effect is excluded");
    assert.deepEqual(out.keys, ["name", "hp", "mp", "alive"], "signals first, in declaration order, then the derived");
    assert.deepEqual(out.kinds, ["signal", "signal", "signal", "derived"]);
    assert.ok(out.keys.indexOf("regen") === -1, "the effect never appears in the walk");
    disposeReactive(hero);
});

test("buildless contract: fn non-function throws a named TypeError (before any plan lookup)", () => {
    const CharacterVM = makeCharacterVM();
    const hero = new CharacterVM();
    for (const bad of [undefined, null, 42, "x", {}]) {
        assert.throws(
            () => forEachReactive(hero, bad),
            (e) => e instanceof TypeError &&
                e.message.startsWith(ERR) &&
                /forEachReactive/.test(e.message) &&
                /must be a function/.test(e.message),
            "fn=" + String(bad) + " must throw the named TypeError",
        );
    }
    disposeReactive(hero);
});

test("buildless contract: the walk box IS boxOf(vm, key) and count is the return value", () => {
    const CharacterVM = makeCharacterVM();
    const hero = new CharacterVM();
    void hero.alive;
    let visits = 0;
    const n = forEachReactive(hero, (k, b) => {
        visits++;
        assert.equal(b, boxOf(hero, k), "the walk box === boxOf for " + String(k));
    });
    assert.equal(n, visits, "the return value equals the number of callback invocations");
    disposeReactive(hero);
});

test("buildless T9 r7-parity: snapshotOf deep-equals r7's hand-rolled {name,hp,mp} PLUS the derived `alive`", () => {
    const CharacterVM = makeCharacterVM();
    const hero = new CharacterVM();
    void hero.alive;

    // r7's hand-rolled data snapshot (COOKBOOK r7.3): a flat walk of the signal
    // keys only -- no reactivity concern, you own the shape.
    const R7_SIGNAL_KEYS = ["name", "hp", "mp"];
    const handRolled = {};
    for (const key of R7_SIGNAL_KEYS) handRolled[key] = hero[key];
    assert.deepEqual(handRolled, { name: "Vega", hp: 100, mp: 30 });

    const snap = snapshotOf(hero);
    assert.deepEqual(
        { name: snap.name, hp: snap.hp, mp: snap.mp },
        handRolled,
        "snapshotOf reproduces r7's hand-rolled snapshot on the signal keys",
    );
    // The DOCUMENTED delta: snapshotOf also carries the derived `alive`.
    assert.equal(snap.alive, true, "the derived is included -- the documented delta over r7's hand-roll");
    assert.deepEqual(Object.keys(snap), ["name", "hp", "mp", "alive"], "exactly the four members, alive last");
    disposeReactive(hero);
});

// =================================================================================
// BUILDLESS LOCAL SHAPE -- a @localTo member so the walk exercises kind "local"
// and the snapshot's PD-62 accessor-read honesty can be asserted against the
// stale box read.
// =================================================================================

function makeLocalVM() {
    return defineReactive(class LocalVM {}, {
        signals: { s: 0, name: "n" },
        locals: { loc: { source: (self) => self.s, initial: 0 } },
        deriveds: { d: (vm) => vm.s + 1 },
    });
}

test("buildless contract: a @localTo member walks with kind \"local\" in plan position", () => {
    const LocalVM = makeLocalVM();
    const vm = new LocalVM();
    void vm.d;
    const out = { keys: [], boxes: [], kinds: [], args: [] };
    const n = forEachReactive(vm, (k, b, kind, a) => collect(out, k, b, kind, a));
    assert.equal(n, 4, "2 signals + 1 local + 1 derived");
    assert.deepEqual(out.keys, ["s", "name", "loc", "d"], "signals, then the local, then the derived");
    assert.deepEqual(out.kinds, ["signal", "signal", "local", "derived"]);
    disposeReactive(vm);
});

test("A9-extra (PD-62): after an upstream move over a stale override, snapshotOf shows the RESET, the box shows the STALE local", () => {
    const LocalVM = makeLocalVM();
    const vm = new LocalVM();
    vm.s = 5;                            // upstream A
    vm.loc = 999;                        // local override: box=999, seen=5
    assert.equal(vm.loc, 999, "the override reads back while the upstream is static");
    vm.s = 6;                            // move upstream: accessor resets, box still holds 999

    const snap = snapshotOf(vm);
    const box = boxOf(vm, "loc");
    // THE DELTA, asserted explicitly as the reason PD-62 reads the accessor:
    assert.equal(snap.loc, 6, "snapshotOf reads through the accessor -> the RESET value (upstream 6)");
    assert.equal(box.peek(), 999, "boxOf(vm, loc).peek() is the STALE local override (999) -- a box read would lie");
    assert.notEqual(snap.loc, box.peek(), "the accessor read and the box read DISAGREE -- exactly why snapshotOf must not use box.get");
    disposeReactive(vm);
});

// =================================================================================
// A6 / T7 -- the fail-closed matrix, both exports.
// =================================================================================

test("A6: non-reactive value throws the throwNoPlan message on both exports", () => {
    for (const bad of [{}, { constructor: Object }, Object.create(null)]) {
        assert.throws(
            () => forEachReactive(bad, () => {}),
            (e) => e instanceof Error && e.message.startsWith(ERR) &&
                /forEachReactive/.test(e.message) && /not a reactive instance/.test(e.message),
        );
        assert.throws(
            () => snapshotOf(bad),
            (e) => e instanceof Error && e.message.startsWith(ERR) &&
                /snapshotOf/.test(e.message) && /not a reactive instance/.test(e.message),
        );
    }
});

test("A6: an unwired instance (a forged { constructor } with a plan but no anchor) throws not-wired on both exports", () => {
    const CharacterVM = makeCharacterVM();
    const forged = { constructor: CharacterVM };
    assert.throws(
        () => forEachReactive(forged, () => {}),
        (e) => e instanceof Error && e.message.startsWith(ERR) &&
            /forEachReactive/.test(e.message) && /not wired/.test(e.message),
    );
    assert.throws(
        () => snapshotOf(forged),
        (e) => e instanceof Error && e.message.startsWith(ERR) &&
            /snapshotOf/.test(e.message) && /not wired/.test(e.message),
    );
});

test("A6: a PARKED instance throws ReactiveDisposedError with the parked message flavor on both exports", () => {
    const CharacterVM = makeCharacterVM();
    const a = new CharacterVM();
    assert.equal(releaseReactive(a), true);
    assert.throws(
        () => forEachReactive(a, () => {}),
        (e) => e instanceof ReactiveDisposedError && e.message.startsWith(ERR) && /parked/.test(e.message),
    );
    const b = new CharacterVM();
    assert.equal(releaseReactive(b), true);
    assert.throws(
        () => snapshotOf(b),
        (e) => e instanceof ReactiveDisposedError && e.message.startsWith(ERR) && /parked/.test(e.message),
    );
    disposeReactive(a);
    disposeReactive(b);
});

test("A6: a DISPOSED instance throws ReactiveDisposedError with the disposed message flavor on both exports", () => {
    const CharacterVM = makeCharacterVM();
    const a = new CharacterVM();
    assert.equal(disposeReactive(a), true);
    assert.throws(
        () => forEachReactive(a, () => {}),
        (e) => e instanceof ReactiveDisposedError && e.message.startsWith(ERR) &&
            /disposeReactive/.test(e.message) && !/parked/.test(e.message),
    );
    const b = new CharacterVM();
    assert.equal(disposeReactive(b), true);
    assert.throws(
        () => snapshotOf(b),
        (e) => e instanceof ReactiveDisposedError && e.message.startsWith(ERR) &&
            /disposeReactive/.test(e.message) && !/parked/.test(e.message),
    );
});

// =================================================================================
// A5 / T8 -- the untracked-read law. A snapshotOf inside an effect must not
// subscribe the effect to any member; the positive control proves the harness
// actually detects a subscription.
// =================================================================================

test("A5/T8 untracked-read law: an effect calling snapshotOf fires ONCE, then never re-fires as every member is written", () => {
    const LocalVM = makeLocalVM();
    const vm = new LocalVM();
    void vm.d;

    let fires = 0;
    let lastSnapKeys = 0;
    const stop = effect(() => {
        fires++;
        const snap = snapshotOf(vm);
        lastSnapKeys = Object.keys(snap).length;   // anti-DCE: force the read
    });
    assert.equal(fires, 1, "the effect fires exactly once on creation");
    assert.equal(lastSnapKeys, 4, "the snapshot has s, name, loc, d");

    // Write EVERY writable member once. s doubles as the local's upstream move.
    vm.s = 1;            // signal + upstream move for loc
    vm.name = "m";       // signal
    vm.loc = 7;          // the local write
    vm.s = 2;            // a second upstream move, to be sure

    assert.equal(fires, 1, "snapshotOf read under untrack -> the effect subscribed to NOTHING and never re-fired");
    stop();
    disposeReactive(vm);
});

test("A5/T8 positive control: an effect that reads vm.name DIRECTLY re-fires on a name write (the harness detects subscription)", () => {
    const LocalVM = makeLocalVM();
    const vm = new LocalVM();

    let fires = 0;
    let sink = "";
    const stop = effect(() => {
        fires++;
        sink = vm.name;                  // a direct, TRACKED accessor read
    });
    assert.equal(fires, 1, "fires once on creation");
    vm.name = "changed";
    assert.equal(fires, 2, "a direct read subscribes -> the write re-fires the effect");
    assert.ok(sink === "changed", "and the effect saw the new value");
    stop();
    disposeReactive(vm);
});
