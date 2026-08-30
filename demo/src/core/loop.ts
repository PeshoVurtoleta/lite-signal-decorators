// demo/src/core/loop.ts -- Plane A: the FLEET, enforced capacity. DOM-FREE.
//
// This module has ZERO DOM references (no document/window/getElementById). The
// identical code runs in the browser and headless in node under
// lite-gc-profiler (PD-31: the core loop is an engine-shaped module, so any
// behavior the node lane cannot reach is a design smell, not an excuse).
//
// Two-plane law (PD-30): every decorated Entity VM lives on the fleet's CUSTOM
// registry, sized EXACTLY by capacityFor. Plane B (telemetry.ts) owns its own
// default-registry signals; no telemetry watcher ever reads a Plane A member.
//
// The pool is the SHIPPED helper (S11): createFleet sizes a registry from the
// sizing twin's cost, binds the decorated Entity to it, and EAGER-prefills N_MAX
// parked members (PD-75: acquire never constructs). This module used to hand-roll
// that pool -- the helper is the extracted spec, so spawn/kill/storm are now
// fleet.acquire/release and the demo keeps only its live-checkout list.
//
// The sizing twin (EntityShape) exists because a decorated class binds its
// registry at decoration time, so the fleet's Entity cannot ALSO be the class
// capacityFor probes to size that registry -- it does not exist until createFleet
// builds it. A defineReactive twin of identical shape sizes the inventory;
// assertShapeAgrees() fails closed if a live Entity ever diverges from it.
//
// ASCII-only. Comparisons use -> <= x in prose. No Unicode.

import {
    reactive,
    derived,
    reactiveEffect,
    reactiveHost,
    defineReactive,
    costOf,
    costOfInstance,
    createFleet,
} from "../../../SignalDecorators.js";
import type { ReactiveCost } from "../../../SignalDecorators.js";

// --- fleet geometry -----------------------------------------------------------

// N_MAX: the enforced ceiling. 4096 == 2^12 -- a power of two comfortably above
// the gc-lane's standing fleet (N=2000) and the storm lane (N=512), and low
// enough that the UI can actually spill past it to surface the fleet's named
// FleetExhaustedError (shown, never swallowed). At P=4 D=2 E=1 that is 8
// nodes/VM -> the fleet provisions exactly 8 x 4096 == 32768 pool nodes, eagerly.
export const N_MAX = 4096;

// Module-level liveness witness. The effect body bumps it WITHOUT closing over
// any instance (it reads `this.speed` and touches only this module-scoped let).
let effectFireCount = 0;

/** Total @reactiveEffect fires since process start -- Plane B reads this as a
 *  scalar; it never forms a graph edge into Plane A. */
export function effectFires(): number {
    return effectFireCount;
}

// The measurement twin: identical shape, on the DEFAULT registry, used ONLY to
// size the fleet's inventory (createFleet -> capacityFor takes the twin+count).
// deriveds are FIXED-shape (each reads the same members every time regardless of
// value), so capacityFor provisions exactly. Never instantiated by the fleet.
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

// Per-VM node cost, straight from the twin's measured cost -- the exact floor a
// single Entity must occupy on the fleet's registry.
const NODES_PER_VM = costOf(EntityShape).nodes;

/** Shape of one live fleet member -- the type the fleet hands out. */
export interface Entity {
    x: number;
    y: number;
    vx: number;
    vy: number;
    readonly speed: number;
    readonly load: number;
}

// --- the fleet ----------------------------------------------------------------
//
// createFleet sizes a registry from [[EntityShape, N_MAX]], hands it to bind()
// so the caller binds its decorated class to it (PD-76: the helper never wraps
// or redefines the class), then EAGER-constructs and parks N_MAX members. The
// decorator wiring is IDENTICAL to the old hand-rolled class: real Stage-3
// decorators (experimentalDecorators: false), FIXED-shape (speed always reads
// vx+vy, load always reads x+y, the effect always tracks speed).
export const fleet = createFleet<Entity>([[EntityShape, N_MAX]], (registry) => {
    @reactiveHost({ registry })
    class EntityHost {
        @reactive accessor x = 0;
        @reactive accessor y = 0;
        @reactive accessor vx = 0;
        @reactive accessor vy = 0;

        @derived get speed() { return Math.abs(this.vx) + Math.abs(this.vy); }
        @derived get load() { return this.x + this.y; }

        // Auto-effect: fires once at wire, re-fires whenever speed's deps move.
        @reactiveEffect tick() { effectFireCount++; void this.speed; }
    }
    return EntityHost;
});

/** The bound fleet VM constructor (== fleet.Class). */
export const Entity = fleet.Class;

/** The Plane A registry the fleet owns (== fleet.registry). */
export const world = fleet.registry;

// Shape-drift wall -- a LIVE measurement: acquire one real member, FORCE each
// derived once so the instance reports the constructed CEILING (costOfInstance
// is parity-with-costOf once every lazy derived has been read), measure its true
// per-VM cost with costOfInstance, and prove nodes equal the twin's costOf
// number. If the decorated class and the twin ever diverge, capacityFor would
// under- or over-provision the registry; fail closed here. Cold boot path only.
function assertShapeAgrees(): void {
    const probe = fleet.acquire();
    void probe.speed;                       // force the deriveds -> ceiling numbers
    void probe.load;
    const live = costOfInstance(probe);
    fleet.release(probe);
    if (live.nodes !== NODES_PER_VM) {
        throw new Error(
            "loop.ts shape drift: a live Entity measures " + live.nodes +
            " nodes but the measurement twin sized " + NODES_PER_VM +
            " -- capacityFor provisioned the fleet for the wrong shape.",
        );
    }
}
assertShapeAgrees();

// --- the live checkout list ---------------------------------------------------
//
// The fleet owns construction, parking, the free-list, and capacity. The demo
// owns only this dense stack of currently-acquired members: spawn pushes an
// acquired VM, kill/storm pop and release in LIFO order. step/readPositions
// iterate [0, count) with direct indexing -- no per-frame allocation, no
// dependence on the fleet's internal slot ordering. `count` mirrors fleet.size().
const live: Array<Entity | null> = new Array(N_MAX).fill(null);
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

/** Live population (== fleet.size()). */
export function population(): number { return fleet.size(); }

/** Per-VM pool-node cost (P+D+E+1). */
export function nodesPerVm(): number { return NODES_PER_VM; }

/** The Plane A registry stats snapshot (activeNodes/activeLinks/poolGrowths/
 *  ledger). Read-only; reading stats forms no graph edge. */
export function worldStats() { return fleet.stats(); }

/**
 * costOfInstance of the first live fleet member -- the LIVE measured cost of one
 * real Entity right now (not the twin's ceiling). A live member's `load` derived
 * is never read, so its links read BELOW the forced ceiling: the documented
 * live-vs-probe delta, surfaced in the HUD. COLD: the frozen result allocates
 * one object per call, so the HUD must call this on its tick cadence only, NEVER
 * per frame. Returns null when the fleet is empty.
 */
export function firstMemberCost(): Readonly<ReactiveCost> | null {
    if (count === 0) return null;
    return costOfInstance(live[0] as Entity);
}

/**
 * Spawn `n` entities: acquire a parked member per unit and jitter its position.
 * Acquiring past N_MAX lets the fleet's named FleetExhaustedError propagate to
 * the caller (shown, never swallowed) -- acquire never constructs, so a failed
 * acquire leaks nothing. Returns the new population.
 */
export function spawn(n: number): number {
    for (let i = 0; i < n; i++) {
        const e = fleet.acquire();         // throws FleetExhaustedError at the ceiling
        e.x = rng() * 1000;
        e.y = rng() * 1000;
        e.vx = rng() * 2 - 1;
        e.vy = rng() * 2 - 1;
        live[count] = e;
        count = count + 1;
    }
    return count;
}

/**
 * Kill the top `n` live entities: release each back to the pool (nodes returned,
 * member parked). Returns the new population. Killing more than are live simply
 * drains to empty.
 */
export function kill(n: number): number {
    let k = n > count ? count : n;
    for (let i = 0; i < k; i++) {
        count = count - 1;
        fleet.release(live[count] as Entity);
        live[count] = null;
    }
    return count;
}

/**
 * Park storm: mass release of the entire live fleet in one pass, returning every
 * member's nodes to the pool (parked, not disposed -- the fleet only disposes at
 * teardown). Mirrors the hand-rolled storm's measured intent -- population drops
 * to 0 and activeNodes returns to the parked baseline. Allocation-free; the node
 * lane can gate it. Returns 0.
 */
export function parkStorm(): number {
    for (let i = 0; i < count; i++) {
        fleet.release(live[i] as Entity);
        live[i] = null;
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
        const e = live[i]!;
        out[j] = e.x;
        out[j + 1] = e.y;
        j = j + 2;
    }
    return count;
}

/**
 * Advance the fleet one tick. Writes each live entity's velocity (a soft,
 * frame-rate-normalized spring toward the field center) and integrates
 * position, bouncing at the [0,1000] walls.
 * Every vx/vy write re-fires that VM's owned effect, so effectFires advances as a
 * real liveness witness. Zero allocation: only scalar reads/writes and a numeric
 * accumulator. Returns a numeric sink (accumulated speed) to defeat DCE.
 */
export function step(dt: number): number {
    let sink = 0;
    const s = dt * 60;                  // frame-rate normalization: 1 at 60 fps
    for (let i = 0; i < count; i++) {
        const e = live[i]!;
        // soft spring toward the field center (500, 500); the per-tick vx/vy
        // writes keep speed's deps live so the effect fires. Sign law:
        // (0.05 - x * 0.0001) pulls TOWARD 500 -- the inverted form repels
        // every entity into its quadrant's corner.
        let nvx = e.vx + (0.05 - e.x * 0.0001) * s;
        let nvy = e.vy + (0.05 - e.y * 0.0001) * s;
        if (nvx > 2) nvx = 2; else if (nvx < -2) nvx = -2;
        if (nvy > 2) nvy = 2; else if (nvy < -2) nvy = -2;
        e.vx = nvx;
        e.vy = nvy;
        let nx = e.x + nvx * s;
        let ny = e.y + nvy * s;
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
