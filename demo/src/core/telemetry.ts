// demo/src/core/telemetry.ts -- Plane B: TELEMETRY, default registry. DOM-FREE.
//
// THE WALL (PD-30, PD-29): no watcher source thunk in this file may read any
// Plane A member (an Entity accessor, world.stats(), anything from loop.ts's
// fleet). Every source below reads ONLY a demo-owned signalBox declared in THIS
// file, all on lite-signal's DEFAULT registry -- same-registry with the
// lite-watch-ex effects they drive, provably safe. The frame loop WRITES scalars
// into these boxes (a value push, never a graph edge to the custom fleet
// registry). This is enforced, not just asserted: createTelemetry({ dev }) with
// dev true snapshots world.stats() before and after registering all five
// watchers and throws if activeNodes or activeLinks moved by even one -- proving
// no watcher ever formed an edge into Plane A. (See S5b-A4.)
//
// lite-watch-ex's promise-returning when-helper is banned from demo/ by law
// (it allocates a Promise per call); the S5b-A4 grep proves its absence.
//
// Callbacks are INJECTED (PD-30): the UI injects DOM writers; the node lanes
// inject allocation-free numeric sinks. This file knows nothing about either.
//
// ASCII-only.

import { signalBox } from "@zakkster/lite-signal";
import {
    watchUntil,
    pausableWatch,
    watchChanged,
    watchMany,
    watchPrevious,
} from "@zakkster/lite-watch-ex";
import { N_MAX } from "./loop.js";

// The capacity-alert threshold: 90% of the enforced ceiling.
const CAPACITY_ALERT = Math.floor(0.9 * N_MAX);

/** A minimal signal box surface (the subset the demo uses). */
export interface Box {
    get(): number;
    set(v: number): void;
    peek(): number;
}

/** The scalar sinks the host injects. Each is called by exactly one watcher.
 *  A host that omits one gets a fail-closed no-op default (kept explicit so a
 *  forgotten wire is visible, not silent). */
export interface TelemetrySinks {
    /** watchUntil: population first crossed 0.9 x N_MAX (one-shot, self-disposes). */
    onCapacityAlert?: (population: number) => void;
    /** pausableWatch: a frameMs sample, suppressed while paused, one catch-up on resume. */
    onFrameSample?: (frameMs: number) => void;
    /** watchChanged: population actually moved -- change-gated panel value. */
    onPopulationChanged?: (population: number, previous: number) => void;
    /** watchMany: fps + frameMs + population in one reused-buffer callback. */
    onDashboard?: (fps: number, frameMs: number, population: number) => void;
    /** watchPrevious: churn-rate delta vs the previous sample (depth 1). */
    onChurnDelta?: (current: number, previous: number) => void;
}

export interface TelemetryOptions {
    dev?: boolean;
    /** Injected so the wall assertion can read Plane A stats WITHOUT this module
     *  importing the fleet's mutable surface -- a read, never an edge. */
    worldStats?: () => { activeNodes: number; activeLinks: number };
}

export interface Telemetry {
    /** Plane B raw signals -- the frame loop pushes scalars into these. */
    readonly fps: Box;
    readonly frameMs: Box;
    readonly populationBox: Box;
    readonly effectFiresBox: Box;
    readonly churnRate: Box;
    readonly pausedBox: Box;
    /** Drive the pausableWatch from the demo's pause button. */
    pause(): void;
    resume(): void;
    /** Tear down all five watchers. */
    disposeAll(): void;
}

const NOOP1 = (_a: number): void => {};
const NOOP2 = (_a: number, _b: number): void => {};
const NOOP3 = (_a: number, _b: number, _c: number): void => {};

/**
 * Build Plane B: six default-registry signal boxes plus the five lite-watch-ex
 * watchers of PD-30, wiring each watcher's callback to an injected sink. All
 * watcher sources are thunks over the local boxes only (THE WALL).
 */
export function createTelemetry(sinks: TelemetrySinks, opts: TelemetryOptions = {}): Telemetry {
    const onCapacityAlert = sinks.onCapacityAlert || NOOP1;
    const onFrameSample = sinks.onFrameSample || NOOP1;
    const onPopulationChanged = sinks.onPopulationChanged || NOOP2;
    const onDashboard = sinks.onDashboard || NOOP3;
    const onChurnDelta = sinks.onChurnDelta || NOOP2;

    // --- Plane B raw signals (default registry) ---
    const fps = signalBox(0) as unknown as Box;
    const frameMs = signalBox(0) as unknown as Box;
    const populationBox = signalBox(0) as unknown as Box;
    const effectFiresBox = signalBox(0) as unknown as Box;
    const churnRate = signalBox(0) as unknown as Box;
    const pausedBox = signalBox(0) as unknown as Box;

    // Wall proof: snapshot Plane A BEFORE any watcher exists.
    const ws = opts.worldStats;
    const beforeNodes = ws ? ws().activeNodes : 0;
    const beforeLinks = ws ? ws().activeLinks : 0;

    // --- the five watchers (all sources read ONLY local boxes) ---

    // 1. watchUntil -- one-shot capacity-threshold alert; self-disposes on fire.
    const stopCapacity = watchUntil(
        () => populationBox.get(),
        (p: number) => p >= CAPACITY_ALERT,
        (p: number) => onCapacityAlert(p),
    );

    // 2. pausableWatch -- frameMs telemetry, pausable from the demo's pause
    //    button; fireOnResume gives one catch-up sample on resume.
    const framePausable = pausableWatch(
        () => frameMs.get(),
        (ms: number) => onFrameSample(ms),
        { fireOnResume: true },
    );

    // 3. watchChanged -- change-gated: fires only when population actually moved.
    const stopPopChanged = watchChanged(
        () => populationBox.get(),
        (n: number, o: number | undefined) => n !== o,
        (n: number, o: number | undefined) => onPopulationChanged(n, o === undefined ? 0 : o),
    );

    // 4. watchMany -- fps + frameMs + population in one callback, buffers reused
    //    (copy left false: the callback reads the buffer, never retains it).
    const stopDashboard = watchMany(
        [() => fps.get(), () => frameMs.get(), () => populationBox.get()],
        (values: number[]) => onDashboard(values[0], values[1], values[2]),
        { copy: false },
    );

    // 5. watchPrevious -- churn-rate delta vs the previous value (depth 1).
    const stopChurn = watchPrevious(
        () => churnRate.get(),
        (current: number, history: Array<number | undefined>) => {
            const prev = history[0];
            onChurnDelta(current, prev === undefined ? 0 : prev);
        },
        { depth: 1 },
    );

    // Wall proof: registering all five watchers must not have touched Plane A.
    if (opts.dev && ws) {
        const afterNodes = ws().activeNodes;
        const afterLinks = ws().activeLinks;
        if (afterNodes !== beforeNodes || afterLinks !== beforeLinks) {
            throw new Error(
                "telemetry.ts THE WALL breached: registering Plane B watchers moved " +
                "Plane A stats (nodes " + beforeNodes + "->" + afterNodes +
                ", links " + beforeLinks + "->" + afterLinks +
                ") -- a watcher source reached into the fleet registry.",
            );
        }
    }

    let disposed = false;
    return {
        fps,
        frameMs,
        populationBox,
        effectFiresBox,
        churnRate,
        pausedBox,
        pause(): void { framePausable.pause(); pausedBox.set(1); },
        resume(): void { framePausable.resume(); pausedBox.set(0); },
        disposeAll(): void {
            if (disposed) return;
            disposed = true;
            stopCapacity();
            framePausable.stop();
            stopPopChanged();
            stopDashboard();
            stopChurn();
        },
    };
}
