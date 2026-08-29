// demo/src/core/loop.ts -- Plane A: the FLEET, enforced capacity. DOM-FREE.
//
// This module has ZERO DOM references (no document/window/getElementById). The
// identical code runs in the browser and headless in node under
// lite-gc-profiler (PD-31: the core loop is an engine-shaped module, so any
// behavior the node lane cannot reach is a design smell, not an excuse).
//
// Two-plane law (PD-30): every decorated Entity VM lives on `world`, a CUSTOM
// registry sized EXACTLY by capacityFor. Plane B (telemetry.ts) owns its own
// default-registry signals; no telemetry watcher ever reads a Plane A member.
//
// Bootstrap note (the capacityFor cycle): a decorated class binds its registry
// at decoration time, so the fleet class cannot also be the class capacityFor
// probes to SIZE that registry -- the registry would not exist yet. Resolved the
// package's own probe-then-host idiom (test/14 QA-B1, line 101: an unbound twin's
// cost sizes a registry that then hosts the bound class; Cluster E, line 209,
// asserts decorator/twin cost parity): a defineReactive measurement twin
// `EntityShape` of identical shape is probed on the default registry to size
// `world`; the decorated `Entity` is then bound to `world`. A boot shape-drift
// assertion (assertShapeAgrees) fails closed if the two ever diverge, so the
// twin can never silently misreport the fleet's real per-instance cost.
//
// ASCII-only. Comparisons use -> <= x in prose. No Unicode.

import {
    reactive,
    derived,
    reactiveEffect,
    reactiveHost,
    defineReactive,
    disposeReactive,
    capacityFor,
    costOf,
} from "../../../SignalDecorators.js";
import { createRegistry } from "@zakkster/lite-signal";

// --- fleet geometry -----------------------------------------------------------

// N_MAX: the enforced ceiling. 4096 == 2^12 -- a power of two comfortably above
// the gc-lane's standing fleet (N=2000) and the storm lane (N=512), and low
// enough that the UI can actually spill past it to surface the engine's named
// CapacityError (shown, never swallowed). At P=4 D=2 E=1 that is 8 nodes/VM ->
// world provisions exactly 8 x 4096 == 32768 pool nodes, eagerly.
export const N_MAX = 4096;

// --- Entity shape, single source of the field list ----------------------------
//
// The measurement twin and the decorated fleet class share this field list by
// construction: both declare x/y/vx/vy signals, speed/load deriveds, and one
// effect. assertShapeAgrees() below proves the decorated class matches the
// twin's measured cost at boot.

// Module-level liveness witness. The effect body bumps it WITHOUT closing over
// any instance (it reads `this.speed` and touches only this module-scoped let).
let effectFireCount = 0;

/** Total @reactiveEffect fires since process start -- Plane B reads this as a
 *  scalar; it never forms a graph edge into Plane A. */
export function effectFires(): number {
    return effectFireCount;
}

// The measurement twin: identical shape, on the DEFAULT registry, used ONLY to
// size `world`. Constructed once by capacityFor's costOf probe, then never
// instantiated again. deriveds are FIXED-shape (each reads the same members
// every time regardless of value), so capacityFor provisions exactly.
const EntityShape = defineReactive(class EntityShape {}, {
    signals: { x: 0, y: 0, vx: 0, vy: 0 },
    deriveds: {
        speed: (self: any) => Math.abs(self.vx) + Math.abs(self.vy),
        load: (self: any) => self.x + self.y,
    },
    effects: {
        tick: (self: any) => { effectFireCount++; void self.speed; },
    },
});

// Size the enforced registry from the twin. capacityFor emits
// { maxNodes, maxLinks, prealloc: "eager", onCapacityExceeded: "throw" }.
const WORLD_CONFIG = capacityFor([[EntityShape, N_MAX]]);

// Plane A -- the FLEET registry. Enforced capacity; a spawn past N_MAX throws
// the engine's named CapacityError at node formation.
export const world = createRegistry(WORLD_CONFIG);

// Per-VM node cost, straight from the twin's measured cost -- the exact floor a
// single Entity must occupy on `world`.
const NODES_PER_VM = costOf(EntityShape).nodes;

// --- the decorated fleet VM ---------------------------------------------------
//
// Real Stage-3 decorators (experimentalDecorators: false), bound to `world`.
// FIXED-shape: speed always reads vx+vy, load always reads x+y, the effect
// always tracks speed. No branchy derived -> capacityFor provisions exactly.

@reactiveHost({ registry: world })
export class Entity {
    @reactive accessor x = 0;
    @reactive accessor y = 0;
    @reactive accessor vx = 0;
    @reactive accessor vy = 0;

    @derived get speed() { return Math.abs(this.vx) + Math.abs(this.vy); }
    @derived get load() { return this.x + this.y; }

    // Auto-effect: fires once at wire, re-fires whenever speed's deps move.
    @reactiveEffect tick() { effectFireCount++; void this.speed; }
}

// Shape-drift wall: construct one real Entity, measure its true node delta on
// `world`, and prove it equals the twin's measured per-VM cost. If the decorated
// class and the twin ever diverge, capacityFor would under- or over-provision
// `world`; fail closed here rather than let the fleet run mis-sized.
function assertShapeAgrees(): void {
    const before = world.stats().activeNodes;
    const probe = new Entity();
    const delta = world.stats().activeNodes - before;
    disposeReactive(probe);
    if (delta !== NODES_PER_VM) {
        throw new Error(
            "loop.ts shape drift: decorated Entity occupies " + delta +
            " nodes but the measurement twin sized " + NODES_PER_VM +
            " -- capacityFor provisioned world for the wrong shape.",
        );
    }
}
assertShapeAgrees();

// --- the live fleet -----------------------------------------------------------

// Fixed-length slot array, sized to the ceiling. `count` is the live population.
// null in a slot means empty. No per-step allocation touches this array.
const slots: Array<Entity | null> = new Array(N_MAX).fill(null);
let count = 0;

// Deterministic, allocation-free PRNG (xorshift32) for spawn jitter so both the
// browser and the node lanes get reproducible motion without Math.random.
let rngState = 0x9e3779b9 | 0;
function rng(): number {
    let x = rngState | 0;
    x ^= x << 13; x |= 0;
    x ^= x >>> 17;
    x ^= x << 5; x |= 0;
    rngState = x;
    return (x >>> 0) / 4294967296;
}

/** Live population. */
export function population(): number { return count; }

/** Per-VM pool-node cost (P+D+E+1). */
export function nodesPerVm(): number { return NODES_PER_VM; }

/** The Plane A registry stats snapshot (activeNodes/activeLinks/poolGrowths/
 *  ledger). Read-only; reading stats forms no graph edge. */
export function worldStats() { return world.stats(); }

/**
 * Spawn `n` entities into free slots. Spawning past N_MAX lets the engine's
 * CapacityError propagate to the caller (shown, never swallowed) -- construction
 * is atomic (D-2h), so a failed spawn leaks no nodes. Returns the new population.
 */
export function spawn(n: number): number {
    for (let i = 0; i < n; i++) {
        const e = new Entity();            // throws CapacityError at the ceiling
        e.x = rng() * 1000;
        e.y = rng() * 1000;
        e.vx = rng() * 2 - 1;
        e.vy = rng() * 2 - 1;
        slots[count] = e;
        count = count + 1;
    }
    return count;
}

/**
 * Kill the top `n` live entities via node-exact teardown. Returns the new
 * population. Disposing more than are live simply drains to empty.
 */
export function kill(n: number): number {
    let k = n > count ? count : n;
    for (let i = 0; i < k; i++) {
        count = count - 1;
        const e = slots[count];
        if (e !== null) disposeReactive(e);
        slots[count] = null;
    }
    return count;
}

/**
 * Dispose storm: mass teardown of the entire live fleet in one pass. Each Entity
 * also supports `using` (Symbol.dispose === disposeReactive), so a `using`-block
 * teardown is byte-identical to this loop; the loop form is used here for a
 * deterministic, allocation-free storm the node lane can gate. Returns 0.
 */
export function disposeStorm(): number {
    for (let i = 0; i < count; i++) {
        const e = slots[i];
        if (e !== null) disposeReactive(e);
        slots[i] = null;
    }
    count = 0;
    return 0;
}

/**
 * Copy the live entities' (x, y) into a caller-preallocated Float32Array (length
 * >= 2 x N_MAX). Reads are untracked (no active owner at loop scope), so this
 * forms no graph edge and allocates nothing. Returns the live count.
 */
export function readPositions(out: Float32Array): number {
    let j = 0;
    for (let i = 0; i < count; i++) {
        const e = slots[i]!;
        out[j] = e.x;
        out[j + 1] = e.y;
        j = j + 2;
    }
    return count;
}

/**
 * Advance the fleet one tick. Writes each live entity's velocity (a cheap
 * deterministic wobble) and integrates position, bouncing at the [0,1000] walls.
 * Every vx/vy write re-fires that VM's owned effect, so effectFires advances as a
 * real liveness witness. Zero allocation: only scalar reads/writes and a numeric
 * accumulator. Returns a numeric sink (accumulated speed) to defeat DCE.
 */
export function step(dt: number): number {
    let sink = 0;
    for (let i = 0; i < count; i++) {
        const e = slots[i]!;
        // wobble velocity a hair -- keeps speed's deps live so the effect fires
        let nvx = e.vx + (e.x * 0.0001 - 0.05);
        let nvy = e.vy + (e.y * 0.0001 - 0.05);
        if (nvx > 2) nvx = 2; else if (nvx < -2) nvx = -2;
        if (nvy > 2) nvy = 2; else if (nvy < -2) nvy = -2;
        e.vx = nvx;
        e.vy = nvy;
        let nx = e.x + nvx * dt * 60;
        let ny = e.y + nvy * dt * 60;
        if (nx < 0) { nx = 0; e.vx = -nvx; }
        else if (nx > 1000) { nx = 1000; e.vx = -nvx; }
        if (ny < 0) { ny = 0; e.vy = -nvy; }
        else if (ny > 1000) { ny = 1000; e.vy = -nvy; }
        e.x = nx;
        e.y = ny;
        sink = sink + e.speed;
    }
    return sink;
}
