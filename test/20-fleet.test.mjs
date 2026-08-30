// test/20-fleet.test.mjs -- the createFleet contract (PLAN-S11 T3, decisions
// 0013 (d) + 0015, PD-75/PD-76/PD-77): the full Fleet API surface, both emit
// lanes (buildless via defineReactive as primary + the decorator lane via a
// registry-bound mock-emitter class where a bind-callback fits), the six
// fail-closed laws each asserted by named error + message content, initials
// pass-through, atomic construction, and the internal error-class surface pin
// (the fleet errors are named + instanceof Error but NOT module exports; only
// createFleet joined the surface).
//
// A fleet needs a class BOUND to its own registry, so the decorator/buildless
// classes here are constructed through `reactiveHost({ registry })` /
// `host: { registry }` inside the bind callback -- the committed compiled
// fixtures are fixed to the default registry and cannot rebind, so they do not
// fit the bind lane. ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { stats, createRegistry } from "@zakkster/lite-signal";

import * as pkg from "../SignalDecorators.js";
import { buildClass } from "./shared/mock-emitter.mjs";

const {
    reactive, derived, reactiveEffect, reactiveHost, defineReactive,
    createFleet, costOfInstance, ReactiveDisposedError,
} = pkg;

// The demo-like Entity shape: P=4 signals, D=2 deriveds, E=1 effect, L=0 locals
// -> P+L+D+E+1 = 8 nodes per member (release frees exactly 8; A3/impl-smoke).
const P = 4, L = 0, D = 2, E = 1;
const NODES_PER_MEMBER = P + L + D + E + 1;   // 8

// --- lane builders ------------------------------------------------------------

function entMembers() {
    return [
        { kind: "accessor", key: "x", decorator: reactive, value: () => 0 },
        { kind: "accessor", key: "y", decorator: reactive, value: () => 0 },
        { kind: "accessor", key: "vx", decorator: reactive, value: () => 0 },
        { kind: "accessor", key: "vy", decorator: reactive, value: () => 0 },
        { kind: "getter", key: "speed", decorator: derived, body: function () { return this.vx + this.vy; } },
        { kind: "getter", key: "mag", decorator: derived, body: function () { return this.x + this.y; } },
        { kind: "method", key: "onMove", decorator: reactiveEffect, body: function () { void this.mag; } },
    ];
}

// Decorator lane: a mock-emitter class bound to `reg` -- the exact code path a
// transpiled @reactiveHost({ registry }) class drives.
function makeDecoratorFleet(counts, opts) {
    const scratch = createRegistry({ maxNodes: 256 });
    const Probe = buildClass({
        name: "Ent",
        classDecorator: reactiveHost({ registry: scratch }),
        members: entMembers(),
    });
    let boundReg = null;
    const inventory = counts.map((c) => [Probe, c]);
    const fleet = createFleet(inventory, (reg) => {
        boundReg = reg;
        return buildClass({
            name: "Ent",
            classDecorator: reactiveHost({ registry: reg }),
            members: entMembers(),
        });
    }, opts);
    return { fleet, boundReg: () => boundReg };
}

function entSpec(reg) {
    return {
        signals: { x: 0, y: 0, vx: 0, vy: 0 },
        deriveds: { speed: (s) => s.vx + s.vy, mag: (s) => s.x + s.y },
        effects: { onMove: (s) => { void s.mag; } },
        host: { registry: reg },
    };
}

// Buildless lane (PRIMARY): defineReactive with a registry-bound host spec.
function makeBuildlessFleet(counts, opts) {
    const scratch = createRegistry({ maxNodes: 256 });
    const Probe = defineReactive(class Ent {}, entSpec(scratch));
    let boundReg = null;
    const inventory = counts.map((c) => [Probe, c]);
    const fleet = createFleet(inventory, (reg) => {
        boundReg = reg;
        return defineReactive(class Ent {}, entSpec(reg));
    }, opts);
    return { fleet, boundReg: () => boundReg };
}

const LANES = [
    { label: "buildless", make: makeBuildlessFleet },
    { label: "decorator", make: makeDecoratorFleet },
];

function conserved() {
    const s = stats();
    return s.totalAllocations - s.totalDisposals === s.activeNodes;
}

// =============================================================================
// Construction + prefill
// =============================================================================

for (const lane of LANES) {
    test(lane.label + ": capacity honored (single-entry inventory count)", () => {
        const { fleet } = lane.make([3]);
        assert.equal(fleet.capacity, 3, "capacity is the inventory count");
        fleet.dispose();
        assert.ok(conserved(), "default-registry ledger balanced after dispose");
    });

    test(lane.label + ": capacity is the SUM of inventory counts", () => {
        const { fleet } = lane.make([2, 3]);
        assert.equal(fleet.capacity, 5, "capacity is sum(counts) = 2 + 3");
        fleet.dispose();
    });

    test(lane.label + ": bind receives the fleet's own registry; members live on it", () => {
        const { fleet, boundReg } = lane.make([4]);
        assert.equal(fleet.registry, boundReg(), "bind's registry IS fleet.registry");
        // Post-prefill: all parked -> zero live nodes on the fleet registry.
        assert.equal(fleet.registry.stats().activeNodes, 0, "post-prefill activeNodes 0");
        const vm = fleet.acquire();
        assert.equal(
            fleet.registry.stats().activeNodes, NODES_PER_MEMBER,
            "one acquired member puts exactly P+L+D+E+1 nodes on THE FLEET registry",
        );
        // costOfInstance walks the member's own graph -> proves it is a real,
        // wired instance on this registry.
        const cost = costOfInstance(vm);
        assert.equal(cost.nodes, NODES_PER_MEMBER, "costOfInstance sees the member's 8 nodes");
        fleet.release(vm);
        fleet.dispose();
    });

    test(lane.label + ": eager prefill parks N members; at(i) is parked, touch throws parked-flavor", () => {
        const N = 5;
        const { fleet } = lane.make([N]);
        assert.equal(fleet.size(), 0, "no live members right after construction");
        assert.equal(fleet.registry.stats().activeNodes, 0, "activeNodes 0 post-prefill");
        for (let i = 0; i < N; i++) {
            const vm = fleet.at(i);
            assert.ok(vm, "at(" + i + ") returns the prebuilt parked member");
            assert.throws(
                () => vm.x,
                (e) => e instanceof ReactiveDisposedError && /parked/.test(e.message),
                "a parked member's touch throws the parked-flavor ReactiveDisposedError",
            );
        }
        fleet.dispose();
    });
}

// =============================================================================
// acquire / release semantics
// =============================================================================

for (const lane of LANES) {
    test(lane.label + ": acquire returns a LIVE member; bare acquire resets to field-initials", () => {
        const { fleet } = lane.make([2]);
        const vm = fleet.acquire();
        assert.equal(vm.x, 0, "bare acquire resets x to its field-initial 0");
        assert.equal(vm.mag, 0, "derived recomputes over reset values");
        assert.equal(fleet.size(), 1, "size tracks the live count");
        fleet.release(vm);
        fleet.dispose();
    });

    test(lane.label + ": acquire(initials) passes through to reinitReactive", () => {
        const { fleet } = lane.make([2]);
        const vm = fleet.acquire({ x: 5, y: 7 });
        assert.equal(vm.x, 5, "initials.x applied");
        assert.equal(vm.y, 7, "initials.y applied");
        assert.equal(vm.mag, 12, "derived sees the initials");
        fleet.release(vm);
        fleet.dispose();
    });

    test(lane.label + ": PD-58 -- values reset on re-acquire", () => {
        const { fleet } = lane.make([1]);
        const a = fleet.acquire({ x: 99 });
        assert.equal(a.x, 99);
        fleet.release(a);
        // Same slot reacquired (capacity 1): a bare acquire must reset, not
        // carry the stale 99.
        const b = fleet.acquire();
        assert.equal(b, a, "capacity-1 fleet hands back the same slot member");
        assert.equal(b.x, 0, "re-acquire resets x to the field-initial (PD-58)");
        fleet.release(b);
        fleet.dispose();
    });

    test(lane.label + ": release parks (node delta exactly -(P+L+D+E+1)); size + capacity", () => {
        const { fleet } = lane.make([3]);
        const vm = fleet.acquire();
        const before = fleet.registry.stats().activeNodes;
        assert.equal(before, NODES_PER_MEMBER, "one live member = 8 nodes");
        const ret = fleet.release(vm);
        assert.equal(ret, vm, "release returns the member");
        const after = fleet.registry.stats().activeNodes;
        assert.equal(before - after, NODES_PER_MEMBER, "release frees exactly 8 nodes");
        assert.equal(after, 0, "the parked slot holds zero nodes");
        assert.equal(fleet.size(), 0, "size back to 0");
        assert.equal(fleet.capacity, 3, "capacity is constant");
        fleet.dispose();
    });

    test(lane.label + ": stats() passes the fleet registry ledger through", () => {
        const { fleet } = lane.make([2]);
        const vm = fleet.acquire();
        const s = fleet.stats();
        assert.equal(s.activeNodes, fleet.registry.stats().activeNodes, "stats() is the registry ledger");
        assert.equal(s.activeNodes, NODES_PER_MEMBER);
        fleet.release(vm);
        fleet.dispose();
    });
}

// =============================================================================
// Throwing-acquire SIZE INVARIANT (the pop-after-fallible-call ordering) +
// the out-of-band-disposed WEDGE (impl choice (a): a named refusal, never a
// silent capacity erosion). The fixed fleetAcquire peeks free[freeTop-1], runs
// the fallible reinitReactive FIRST, and decrements freeTop only on success.
// =============================================================================

for (const lane of LANES) {
    test(lane.label + ": a throwing acquire leaves size() UNCHANGED and the slot re-acquirable", () => {
        const { fleet } = lane.make([3]);
        assert.equal(fleet.size(), 0, "no live members yet");
        // Bad initials: reinitReactive throws its named refusal BEFORE the pop
        // commits (a plain Error -- the reinit-initials family carries no class).
        assert.throws(
            () => fleet.acquire({ typoKey: 1 }),
            (e) => e instanceof Error && /initials carries key/.test(e.message) &&
                /not a @reactive signal or @localTo member/.test(e.message),
        );
        // The invariant the reviewer's regression pins: the fallible acquire moved
        // nothing -- freeTop is untouched, so size() is still 0 and the slot is
        // fully acquirable.
        assert.equal(fleet.size(), 0, "size() UNCHANGED after the throwing acquire");
        const vm = fleet.acquire({ x: 5 });
        assert.equal(vm.x, 5, "the same slot re-acquires cleanly with good initials");
        assert.equal(fleet.size(), 1, "live count is exactly +1 -- no stranded slot");
        // A bare follow-up acquire from a fresh fleet also proves the +1 with no
        // initials at all.
        const vm2 = fleet.acquire();
        assert.equal(fleet.size(), 2, "a second good acquire brings the live count to exactly 2");
        fleet.release(vm);
        fleet.release(vm2);
        fleet.dispose();
    });

    test(lane.label + ": out-of-band dispose (choice a) -- the dead slot WEDGES with a named throw; ledger balanced", () => {
        const { fleet } = lane.make([3]);
        // at(capacity-1) is the free-list HEAD (first to pop). Dispose it OUT OF
        // BAND, bypassing the fleet -- a parked member disposed directly.
        const victim = fleet.at(2);
        pkg.disposeReactive(victim);
        // A parked member holds zero nodes, so the out-of-band dispose leaves the
        // fleet registry balanced at 0.
        const rs0 = fleet.registry.stats();
        assert.equal(rs0.activeNodes, 0, "the disposed parked slot still holds zero nodes");
        assert.equal(rs0.totalAllocations - rs0.totalDisposals, rs0.activeNodes, "ledger balanced after the out-of-band dispose");
        // Every acquire now rethrows reinit's named "disposed (terminal)" refusal
        // (NOT the parked flavor) and WEDGES at the head -- capacity is refused
        // loudly, never silently eroded.
        for (let n = 0; n < 3; n++) {
            assert.throws(
                () => fleet.acquire(),
                (e) => e instanceof Error && /disposed \(terminal\)/.test(e.message) && !/parked/.test(e.message),
                "acquire #" + n + " rethrows the disposed-slot refusal (wedge)",
            );
        }
        assert.equal(fleet.size(), 0, "no member ever went live -- the wedge committed nothing");
        const rs1 = fleet.registry.stats();
        assert.equal(rs1.totalAllocations - rs1.totalDisposals, rs1.activeNodes, "ledger still balanced after the wedge storm");
        fleet.dispose();
        assert.ok(conserved(), "default-registry ledger balanced after teardown");
    });
}

// =============================================================================
// The SIX fail-closed laws (named error + message content)
// =============================================================================

for (const lane of LANES) {
    test(lane.label + ": LAW exhausted -- acquire at capacity throws FleetExhaustedError; size unchanged", () => {
        const N = 3;
        const { fleet } = lane.make([N]);
        const live = [];
        for (let i = 0; i < N; i++) live.push(fleet.acquire());
        assert.equal(fleet.size(), N);
        assert.throws(
            () => fleet.acquire(),
            (e) => e instanceof Error && e.name === "FleetExhaustedError" && /exhausted/.test(e.message),
        );
        assert.equal(fleet.size(), N, "size unchanged after the exhausted throw");
        for (const vm of live) fleet.release(vm);
        fleet.dispose();
    });

    test(lane.label + ": LAW double-release throws FleetDoubleReleaseError", () => {
        const { fleet } = lane.make([2]);
        const vm = fleet.acquire();
        fleet.release(vm);
        assert.throws(
            () => fleet.release(vm),
            (e) => e instanceof Error && e.name === "FleetDoubleReleaseError" && /double release/.test(e.message),
        );
        fleet.dispose();
    });

    test(lane.label + ": LAW foreign vm -- other fleet's member, plain object, null all throw FleetForeignMemberError", () => {
        const { fleet } = lane.make([2]);
        const { fleet: other } = lane.make([2]);
        const alien = other.acquire();
        assert.throws(
            () => fleet.release(alien),
            (e) => e instanceof Error && e.name === "FleetForeignMemberError" && /not acquired from this fleet/.test(e.message),
            "a member from ANOTHER fleet is foreign",
        );
        assert.throws(
            () => fleet.release({}),
            (e) => e instanceof Error && e.name === "FleetForeignMemberError",
            "a plain object is foreign",
        );
        assert.throws(
            () => fleet.release(null),
            (e) => e instanceof Error && e.name === "FleetForeignMemberError",
            "null is not zero -- foreign, fail closed",
        );
        other.release(alien);
        other.dispose();
        fleet.dispose();
    });

    test(lane.label + ": LAW out-of-bounds at(i) throws RangeError", () => {
        const { fleet } = lane.make([2]);
        assert.throws(
            () => fleet.at(2),
            (e) => e instanceof RangeError && /out of bounds/.test(e.message),
            "at(capacity) is out of bounds",
        );
        assert.throws(
            () => fleet.at(-1),
            (e) => e instanceof RangeError,
            "at(-1) folds to unsigned out of bounds",
        );
        fleet.dispose();
    });

    test(lane.label + ": LAW post-dispose acquire/release/at all throw FleetDisposedError", () => {
        const { fleet } = lane.make([2]);
        const vm = fleet.acquire();
        fleet.dispose();
        assert.throws(
            () => fleet.acquire(),
            (e) => e instanceof Error && e.name === "FleetDisposedError" && /was disposed/.test(e.message),
        );
        assert.throws(
            () => fleet.release(vm),
            (e) => e instanceof Error && e.name === "FleetDisposedError",
        );
        assert.throws(
            () => fleet.at(0),
            (e) => e instanceof Error && e.name === "FleetDisposedError",
        );
        assert.throws(
            () => fleet.size(),
            (e) => e instanceof Error && e.name === "FleetDisposedError",
        );
        assert.throws(
            () => fleet.stats(),
            (e) => e instanceof Error && e.name === "FleetDisposedError",
        );
    });

    test(lane.label + ": LAW dispose idempotency -- a second dispose() is a silent no-op", () => {
        const { fleet } = lane.make([2]);
        fleet.dispose();
        assert.equal(fleet.dispose(), undefined, "the second dispose() returns undefined and does not throw");
    });
}

// =============================================================================
// dispose(): live AND parked members land DISPOSED; registry torn down
// =============================================================================

for (const lane of LANES) {
    test(lane.label + ": dispose disposes live AND parked members; registry activeNodes 0", () => {
        const N = 4;
        const { fleet } = lane.make([N]);
        const live = fleet.acquire();      // slot goes live
        const parked = fleet.at(1);        // a still-parked slot
        assert.equal(live.x, 0, "the live member is usable before dispose");
        fleet.dispose();
        // The live member: disposed-flavor (NOT parked).
        assert.throws(
            () => live.x,
            (e) => e instanceof ReactiveDisposedError && !/parked/.test(e.message),
            "the live member lands DISPOSED after fleet.dispose()",
        );
        // The parked member: also lands DISPOSED (park -> dispose is terminal).
        assert.throws(
            () => parked.x,
            (e) => e instanceof ReactiveDisposedError && !/parked/.test(e.message),
            "a parked member lands DISPOSED (not left parked) after fleet.dispose()",
        );
        assert.equal(fleet.registry.stats().activeNodes, 0, "registry torn down: activeNodes 0");
        assert.ok(conserved(), "default-registry ledger balanced");
    });
}

// =============================================================================
// Atomic construction: a throwing bind and a non-constructor bind leak nothing
// =============================================================================

test("atomic: a bind that THROWS surfaces the throw and leaks nothing", () => {
    const scratch = createRegistry({ maxNodes: 256 });
    const Probe = defineReactive(class Ent {}, entSpec(scratch));
    const base = stats().activeNodes;
    const boom = new Error("bind failed");
    assert.throws(
        () => createFleet([[Probe, 3]], () => { throw boom; }),
        (e) => e === boom,
        "the bind's own throw propagates unchanged",
    );
    assert.equal(stats().activeNodes, base, "default-registry activeNodes unchanged");
    assert.ok(conserved(), "ledger balanced -- nothing half-built survived");
});

test("atomic: built>0 -- a ctor that throws on the THIRD construction disposes the two already-built members and destroys the fleet registry", () => {
    const scratch = createRegistry({ maxNodes: 256 });
    const Probe = defineReactive(class Ent {}, entSpec(scratch));
    const base = stats().activeNodes;
    let ctorCount = 0;
    let fleetReg = null;
    // The bind returns a decorated class whose plain-field initializer throws on
    // the 3rd `new` -- so createFleet's eager prefill builds members 0 and 1,
    // then the 3rd construction throws mid-loop (built === 2).
    assert.throws(
        () => createFleet([[Probe, 5]], (reg) => {
            fleetReg = reg;
            return buildClass({
                name: "Ent",
                classDecorator: reactiveHost({ registry: reg }),
                members: [
                    ...entMembers(),
                    {
                        kind: "field",
                        key: "boom",
                        value: () => { ctorCount++; if (ctorCount === 3) throw new Error("third ctor boom"); return 0; },
                    },
                ],
            });
        }),
        (e) => e instanceof Error && /third ctor boom/.test(e.message),
        "the ctor's own throw propagates out of createFleet",
    );
    assert.equal(ctorCount, 3, "prefill reached the 3rd construction before failing (built was 2)");
    // The fleet-owned registry is torn down: its two built members were disposed
    // and the partial 3rd unwound, so activeNodes is 0 (probe stats where
    // reachable -- destroy() leaves the ledger readable and at zero).
    assert.equal(fleetReg.stats().activeNodes, 0, "the fleet registry holds zero live nodes -- nothing half-built survived");
    // The default registry never moved; global ledger balanced.
    assert.equal(stats().activeNodes, base, "default-registry activeNodes unchanged");
    assert.ok(conserved(), "global ledger balanced after the rejected construction");
});

test("atomic: a bind returning a non-constructor throws TypeError and leaks nothing", () => {
    const scratch = createRegistry({ maxNodes: 256 });
    const Probe = defineReactive(class Ent {}, entSpec(scratch));
    const base = stats().activeNodes;
    assert.throws(
        () => createFleet([[Probe, 3]], () => ({ not: "a constructor" })),
        (e) => e instanceof TypeError && /must return the bound class/.test(e.message),
    );
    assert.equal(stats().activeNodes, base, "default-registry activeNodes unchanged");
    assert.ok(conserved(), "ledger balanced after the rejected construction");
});

test("bind must be a function -- fail closed with a TypeError", () => {
    const scratch = createRegistry({ maxNodes: 256 });
    const Probe = defineReactive(class Ent {}, entSpec(scratch));
    assert.throws(
        () => createFleet([[Probe, 1]], null),
        (e) => e instanceof TypeError && /bind must be a function/.test(e.message),
    );
});

// =============================================================================
// Error-class surface pin: the fleet errors are named + instanceof Error, but
// NOT module exports (internal); only createFleet joined the surface (22 -> 23).
// =============================================================================

test("error-class surface: fleet errors are named + instanceof Error", () => {
    const { fleet } = makeBuildlessFleet([1]);
    // exhausted
    fleet.acquire();
    let caught = null;
    try { fleet.acquire(); } catch (e) { caught = e; }
    assert.ok(caught instanceof Error, "FleetExhaustedError is a real Error");
    assert.equal(caught.name, "FleetExhaustedError", "stable .name string");
    fleet.dispose();
});

test("error-class surface: the module exports EXACTLY 23 names; the fleet errors are NOT among them", () => {
    const names = Object.keys(pkg);
    assert.equal(names.length, 23, "createFleet is the 23rd export: " + names.sort().join(","));
    assert.ok(names.includes("createFleet"), "createFleet joined the surface");
    for (const internal of [
        "FleetExhaustedError", "FleetForeignMemberError",
        "FleetDoubleReleaseError", "FleetDisposedError",
    ]) {
        assert.ok(!names.includes(internal), internal + " must stay internal (not a module export)");
    }
});
