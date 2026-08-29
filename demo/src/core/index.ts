// demo/src/core/index.ts -- DOM-free core barrel. This is the node-target build
// entry (PD-31): the identical Plane A loop + Plane B telemetry that runs in the
// browser is bundled from here for the headless gc/storm/wall lanes.
//
// ASCII-only.

export {
    N_MAX,
    Entity,
    world,
    spawn,
    kill,
    step,
    disposeStorm,
    population,
    nodesPerVm,
    worldStats,
    effectFires,
    readPositions,
} from "./loop.js";

export { createTelemetry } from "./telemetry.js";
export type { Telemetry, TelemetrySinks, TelemetryOptions, Box } from "./telemetry.js";

// Re-exported for the headless retention lane so it can construct + tear down
// tracked instances directly (lite-leak needs the instance handles that spawn()
// keeps internal).
export { disposeReactive } from "../../../SignalDecorators.js";
