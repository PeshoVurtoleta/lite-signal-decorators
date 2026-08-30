// cookbook/r02-watch-from-outside.mjs -- node --expose-gc cookbook/r02-watch-from-outside.mjs
//
// Recipe 2 -- "Watching a VM member from outside."
// lite-watch-ex watches a plain THUNK source: `() => vm.hp`. That thunk reads
// the accessor, which subscribes on the DEFAULT registry -- exactly where
// lite-watch-ex binds its effect. So the rule is a wall you can feel:
//   * a watcher on a DEFAULT-registry instance fires on every change;
//   * a watcher on a CUSTOM-registry instance NEVER fires -- the watcher's
//     effect and the instance's box live in different registries (PD-29).
// And never hand a watcher a box handle: boxOf(vm, key) returns a non-callable
// ENGINE handle, not a source thunk.
//
// GATED (gc): in steady state a source change is pure propagation -- zero
// allocation per change (<= 0.589 B/op, the stamped noise floor). COOKBOOK_BREAK=r2
// allocates one throwaway object per op inside the measured loop; the gate fails.
// ASCII only.

const RID = "r2";
function assert(cond, msg) {
    if (!cond) {
        process.stderr.write("cookbook " + RID + " FAIL: " + msg + "\n");
        process.exit(1);
    }
}

// #region cookbook:r2.1
import { createRegistry } from "@zakkster/lite-signal";
import { watch } from "@zakkster/lite-watch-ex";
import { defineReactive, boxOf } from "@zakkster/lite-signal-decorators";

// A default-registry view-model. lite-watch-ex binds `effect` on the default
// registry at import, so this is the ONLY registry its watchers can observe.
const Player = defineReactive(class {}, {
    signals: { hp: 100, mp: 50 },
    deriveds: { alive: (self) => self.hp > 0 },
    effects: {},
});
const player = new Player();

// Watch a THUNK -- `() => player.hp` -- never boxOf(player, "hp"): that returns
// a non-callable engine handle, not a source a watcher can call.
let hits = 0;
const stop = watch(() => player.hp, (next, prev) => { hits += next - prev; });
// #endregion cookbook:r2.1

const box = boxOf(player, "hp");
assert(typeof box !== "function", "boxOf must return a non-callable engine handle");

player.hp = 90;
player.hp = 80;
assert(hits !== 0, "default-registry watcher never fired");

// #region cookbook:r2.2
// The PD-29 wall, made executable. A twin on its OWN registry advances, but a
// watcher pointed at it NEVER fires -- the watcher's effect is on the default
// registry, the instance's box is not. This is silent by nature; assert it.
const isolated = createRegistry({
    maxNodes: 64, maxLinks: 64, prealloc: "eager", onCapacityExceeded: "throw",
});
const Npc = defineReactive(class {}, {
    signals: { hp: 100 },
    deriveds: {},
    effects: {},
    host: { registry: isolated },
});
const npc = new Npc();

let defaultFires = 0;
let customFires = 0;
const stopDefault = watch(() => player.hp, () => { defaultFires++; });
const stopCustom = watch(() => npc.hp, () => { customFires++; });   // will NEVER fire
for (let k = 1; k <= 5; k++) { player.hp = 100 - k; npc.hp = 100 - k; }
// defaultFires === 5 ; customFires === 0 -- the wall.
// #endregion cookbook:r2.2

assert(defaultFires === 5, "default twin fired " + defaultFires + " times, expected 5");
assert(customFires === 0, "custom-registry watcher fired " + customFires + " times -- wall breached");
stopDefault();
stopCustom();

// ---- gc mini-gate: a steady-state source change is zero-alloc ----
await runGcGate(() => player.hp);
stop();

process.stdout.write(
    "cookbook r2 watch-from-outside | box-callable=false defaultFires=" + defaultFires +
    " customFires=" + customFires + " (PD-29 wall) | ok\n",
);

// -----------------------------------------------------------------------------
// gc mini-gate (measurement plumbing; kept OUT of the published regions)
// -----------------------------------------------------------------------------
async function runGcGate(sourceThunk) {
    const { GcProfiler, measureOps } = await import("@zakkster/lite-gc-profiler");
    const OPS = 1_000_000;
    const WARMUP = 100_000;
    const MAX_BYTES_PER_OP = 0.589;
    const MAX_PAUSE_MS = 4.0;
    const MINOR_HEADROOM = 128;
    const BREAK = process.env.COOKBOOK_BREAK === RID;

    // A live watcher observes the source across the whole measured window.
    let observed = 0;
    const stopWatch = watch(sourceThunk, (n) => { observed += n & 1; });
    const stepClean = (i) => { player.hp = i & 1023; return player.hp & 1; };
    const stepBreak = (i) => {
        const trash = new Array(1024);            // one throwaway object per op
        trash[0] = i;
        return trash[0] + stepClean(i);
    };
    const hot = BREAK ? stepBreak : stepClean;

    let sink = 0;
    function settleFast() { return new Promise((r) => setTimeout(() => Promise.resolve().then(r), 0)); }
    async function observe(fn) {
        for (let i = 0; i < WARMUP; i++) sink += fn(i) | 0;
        const gc = new GcProfiler().start();
        for (let i = 0; i < OPS; i++) {
            sink += fn(i) | 0;
            if ((i & 8191) === 0) gc.sampleHeap(performance.now(), process.memoryUsage().heapUsed);
        }
        await settleFast();
        const summary = gc.summary();
        gc.stop();
        return summary.gc;
    }

    const controlMinor = (await observe((i) => i & 7)).minor;
    const minorLimit = controlMinor + MINOR_HEADROOM;
    const g = await observe(hot);
    const m = measureOps(hot, { ops: OPS, warmup: WARMUP });
    const bpo = (m.bracketInverted || m.bytesPerOp == null) ? 0 : m.bytesPerOp;
    globalThis.__r2_sink = (globalThis.__r2_sink | 0) + (sink | 0) + (observed | 0);
    stopWatch();

    const fail = [];
    if (g.major !== 0) fail.push("major=" + g.major);
    if (g.maxMs > MAX_PAUSE_MS) fail.push("maxPauseMs=" + g.maxMs.toFixed(2));
    if (bpo > MAX_BYTES_PER_OP) fail.push("bytesPerOp=" + bpo.toFixed(4));
    if (g.minor > minorLimit) fail.push("minor=" + g.minor + ">" + minorLimit);
    if (fail.length) {
        process.stderr.write("cookbook " + RID + " gc-gate FAIL: " + fail.join(", ") + "\n");
        process.exit(1);
    }
    process.stdout.write(
        "cookbook r2 gc-gate | source-change bytes/op=" + bpo.toFixed(4) +
        " (<= " + MAX_BYTES_PER_OP + ") major=" + g.major + " minor=" + g.minor +
        " (limit " + minorLimit + ") maxMs=" + g.maxMs.toFixed(2) + " | ok\n",
    );
}
