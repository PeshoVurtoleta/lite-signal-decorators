// bench/frameworks.mjs -- single source of truth for the engine matrix.
//
// ORIGIN: modeled on ../../LiteSignal/bench/frameworks.mjs. benchmark.mjs derives
// its adapter list from ENGINE_KEYS here and asserts an adapter + a per-scenario
// builder exists for every declared key (PLAN-S3 PD-17): the two files cannot
// drift silently. `FW=` and `SCEN=` env filters read from these keys.
//
// key       = FW= filter token AND the ./adapters/<key>.mjs module name.
// label     = report column header.
// kind      = "ours" | "honesty" (baseline) | "ref" | "candidate".
// candidate = true means admission is gated by PD-16; a candidate that fails
//             admission is listed in ./adapters/_exclusions.mjs (owned by
//             Coder I) with its one-line blocker and is SKIPPED, not an error.

export const ENGINES = [
    { key: "lsd",             label: "lite-signal-decorators", kind: "ours" },
    { key: "lsd-define",      label: "lsd defineReactive",     kind: "ours" },
    { key: "lite-raw-boxes",  label: "lite-signal raw boxes",  kind: "honesty" },
    { key: "mobx",            label: "MobX 7",                 kind: "ref" },
    { key: "signal-utils",    label: "signal-utils/polyfill",  kind: "ref" },
    { key: "alien-class",     label: "alien-signals class",    kind: "ref" },
    { key: "classy-solid",    label: "classy-solid + solid",   kind: "candidate", candidate: true },
    { key: "reactively",      label: "@reactively/decorate",   kind: "candidate", candidate: true },
];

// Ordered list of all engine keys.
export const ENGINE_KEYS = ENGINES.map((e) => e.key);

// The seven scenario keys, in report order. Shapes are LAW (PLAN-S3 section 2);
// every adapter builds all seven or returns { unsupported } per scenario.
export const SCENARIO_KEYS = [
    "vm-write",
    "fleet-read",
    "fleet-tick",
    "cascade",
    "deep-vm",
    "churn",
    "retention",
];

export function engineByKey(key) {
    return ENGINES.find((e) => e.key === key) || null;
}
