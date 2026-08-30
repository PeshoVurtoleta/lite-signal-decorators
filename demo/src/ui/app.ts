// demo/src/ui/app.ts -- the browser entry. Wires Plane A (fleet) + Plane B
// (telemetry watchers) to the DOM and runs the rAF loop. Every selector is
// $-cached at boot (dom.ts); the frame loop allocates nothing in our path
// (string building only inside the masked, ~7.5 Hz telemetry write); telemetry
// text is gated by (frame & 7) === 0; buttons use click for accessible
// activation. Colors are read from CSS custom properties once at boot and
// re-read on a theme toggle -- never per frame.
//
// ASCII-only.

import {
    N_MAX,
    spawn,
    kill,
    step,
    parkStorm,
    population,
    worldStats,
    firstMemberCost,
    effectFires,
    readPositions,
    createTelemetry,
} from "../core/index.js";
import type { Telemetry } from "../core/index.js";
import {
    $scene, $spark,
    $spawnRate, $killRate, $spawnVal, $killVal,
    $btnSpawn, $btnKill, $btnPause, $btnStorm, $btnTheme,
    $tAlert, $tPop, $tBudget, $tNodes, $tLinks, $tVmCost, $popBar, $popFill,
    $tFps, $tFrame, $tEffect, $tChurn,
} from "./dom.js";
import { Spark } from "./spark.js";

// --- boot-time constants ------------------------------------------------------

const WORLD_W = 1000;
const WORLD_H = 1000;
const BUDGET_MS = 16.7;                 // 60 fps frame budget for the sparkline
const TEXT_MASK = 7;                    // (frame & 7) === 0 -> ~7.5 Hz at 60 fps
const POS_BUF = new Float32Array(N_MAX * 2);   // preallocated readout buffer

// Colors, read once from the stylesheet (getPropertyValue is a layout read;
// done at boot and on theme change only).
const COL = { fleet: "", tel: "", good: "", grid: "", line: "", fill: "" };
function readColors(): void {
    const cs = getComputedStyle(document.documentElement);
    // --fleet-dot, not --fleet: the viewport is a dark screen in both themes,
    // so the dot color is theme-invariant (--fleet goes dark in light scheme).
    COL.fleet = cs.getPropertyValue("--fleet-dot").trim() || "#43b4e4";
    COL.tel = cs.getPropertyValue("--tel").trim() || "#ffb454";
    COL.good = cs.getPropertyValue("--good").trim() || "#4fd6a3";
    COL.grid = cs.getPropertyValue("--grid").trim() || "rgba(67,180,228,0.07)";
    COL.line = cs.getPropertyValue("--fleet").trim() || "#43b4e4";
    COL.fill = "rgba(67,180,228,0.18)";
}
readColors();

// --- canvas -------------------------------------------------------------------

const sctx = $scene.getContext("2d")!;
let viewW = $scene.width;
let viewH = $scene.height;
let dotPx = 3;                          // entity dot edge, kept at 3 CSS px

// Size the scene's backing store to its CSS box (x dpr, clamped at 2) and keep
// the dot edge at 3 CSS px regardless of dpr. Runs at boot AND on resize --
// without the boot call the canvas stays at its 960x600 attribute size until
// the first resize event, and a 2-backing-px dot shrinks to 1 CSS px at dpr 2.
// Reflow law: the layout READ (rect) completes before any canvas WRITE.
function fitScene(): void {
    const r = $scene.getBoundingClientRect();
    if (r.width < 2) return;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    $scene.width = Math.round(r.width * dpr);
    $scene.height = Math.round((r.width * 0.625) * dpr);
    viewW = $scene.width;
    viewH = $scene.height;
    dotPx = 3 * dpr;
    sctx.setTransform(1, 0, 0, 1, 0, 0);
}
fitScene();

const spark = new Spark($spark, BUDGET_MS);

// --- Plane B telemetry: inject DOM-writer sinks -------------------------------
//
// Each sink is the change-gated (or one-shot) DOM writer for exactly one
// watcher. String building happens here only -- and only when a watcher fires,
// which the frame loop restricts to the masked cadence.

let alertFired = false;

const telemetry: Telemetry = createTelemetry({
    // watchUntil -- one-shot capacity alert (self-disposes on fire).
    onCapacityAlert(pop: number): void {
        alertFired = true;
        $tAlert.textContent = "CAPACITY: population " + pop + " crossed 90% of N_MAX (" + N_MAX + ")";
        $tAlert.classList.add("fired");
    },
    // pausableWatch -- frame-time sample; frozen while paused, one catch-up on resume.
    onFrameSample(ms: number): void {
        $tFrame.textContent = ms.toFixed(2) + " ms";
    },
    // watchChanged -- population moved: update the count + budget bar.
    onPopulationChanged(pop: number): void {
        $tPop.textContent = "" + pop;
        const pct = (pop / N_MAX) * 100;
        $popFill.style.width = pct + "%";
        if (pop >= Math.floor(0.9 * N_MAX)) $popBar.classList.add("hot");
        else $popBar.classList.remove("hot");
    },
    // watchMany -- fps + frameMs + population in one reused-buffer callback.
    onDashboard(fps: number): void {
        $tFps.textContent = fps.toFixed(0);
    },
    // watchPrevious -- churn delta vs the previous sample.
    onChurnDelta(current: number): void {
        $tChurn.textContent = current.toFixed(0);
    },
}, { dev: true, worldStats });

// --- boot UI values from state (never hardcoded in HTML) ----------------------

$spawnVal.textContent = $spawnRate.value;
$killVal.textContent = $killRate.value;
$tBudget.textContent = "" + N_MAX;

// Seed a starter fleet so the viewport is alive on load.
spawn(256);

// --- controls -----------------------------------------------------------------

let paused = false;

$spawnRate.addEventListener("input", () => { $spawnVal.textContent = $spawnRate.value; });
$killRate.addEventListener("input", () => { $killVal.textContent = $killRate.value; });

$btnSpawn.addEventListener("click", () => {
    const n = parseInt($spawnRate.value, 10);
    try {
        spawn(n);
        $tAlert.classList.remove("err");
        if (!alertFired) $tAlert.textContent = "capacity alert armed (watchUntil, one-shot)";
    } catch (e) {
        // The engine's named CapacityError -- shown, never swallowed.
        const msg = e && (e as Error).name ? (e as Error).name + ": " + (e as Error).message : String(e);
        $tAlert.textContent = msg;
        $tAlert.classList.add("err");
    }
});

$btnKill.addEventListener("click", () => {
    kill(parseInt($killRate.value, 10));
});

$btnStorm.addEventListener("click", () => {
    parkStorm();
    $tAlert.classList.remove("err");
});

$btnPause.addEventListener("click", () => {
    paused = !paused;
    if (paused) { telemetry.pause(); $btnPause.textContent = "resume"; }
    else { telemetry.resume(); $btnPause.textContent = "pause"; }
});

$btnTheme.addEventListener("click", () => {
    const root = document.documentElement;
    const cur = root.getAttribute("data-theme");
    const next = cur === "light" ? "dark" : cur === "dark" ? "light"
        : (matchMedia("(prefers-color-scheme: dark)").matches ? "light" : "dark");
    root.setAttribute("data-theme", next);
    readColors();
});

addEventListener("resize", () => {
    fitScene();
    spark.resize();
});

// --- render (pure WRITE path; no layout reads) --------------------------------

function render(n: number): void {
    sctx.clearRect(0, 0, viewW, viewH);
    const sx = viewW / WORLD_W;
    const sy = viewH / WORLD_H;
    const half = dotPx * 0.5;           // center the dot so wall-riders stay on-screen
    sctx.fillStyle = COL.fleet;
    for (let i = 0; i < n; i++) {
        const x = POS_BUF[i * 2] * sx - half;
        const y = POS_BUF[i * 2 + 1] * sy - half;
        sctx.fillRect(x, y, dotPx, dotPx);
    }
}

// --- frame loop ---------------------------------------------------------------

let last = performance.now();
let emaMs = BUDGET_MS;
let frame = 0;
let churnBase = 0;
let lastChurnAt = last;

// churn witness: cumulative spawn+kill volume, sampled into a per-second rate.
let churnVolume = 0;

function loop(now: number): void {
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 1 / 20) dt = 1 / 20;              // clamp after a tab-away

    const t0 = performance.now();
    if (!paused) step(dt);
    const liveN = readPositions(POS_BUF);
    render(liveN);
    const t1 = performance.now();

    const frameMs = t1 - t0;
    emaMs = emaMs * 0.9 + frameMs * 0.1;
    spark.push(frameMs);
    spark.draw(COL.line, COL.fill, COL.grid);

    // masked telemetry write (~7.5 Hz): scalar pushes into Plane B fire the
    // watchers, whose injected sinks do the change-gated DOM text. String
    // building lives here and nowhere else in the loop.
    if ((frame & TEXT_MASK) === 0) {
        const fps = emaMs > 0 ? 1000 / emaMs : 0;
        const pop = population();
        // churn rate: population-change volume since the last sample, per second.
        const churnNow = churnVolume;
        const dtc = (now - lastChurnAt) / 1000;
        const churnPerSec = dtc > 0 ? (churnNow - churnBase) / dtc : 0;
        churnBase = churnNow;
        lastChurnAt = now;

        telemetry.fps.set(fps);
        telemetry.frameMs.set(emaMs);
        telemetry.populationBox.set(pop);
        telemetry.effectFiresBox.set(effectFires());
        telemetry.churnRate.set(churnPerSec);

        // direct Plane A stat readouts (value reads, no graph edge):
        const ws = worldStats();
        $tNodes.textContent = "" + ws.activeNodes;
        $tLinks.textContent = "" + ws.activeLinks;
        $tEffect.textContent = "" + telemetry.effectFiresBox.peek();

        // Live per-instance cost of one real fleet member (costOfInstance). It
        // allocates its frozen result, so it rides THIS masked ~7.5 Hz tick and
        // never the per-frame path. Live links sit below costOf's forced ceiling
        // (the unread `load` derived): the documented live-vs-probe delta.
        const vmCost = firstMemberCost();
        $tVmCost.textContent = vmCost === null ? "--" : vmCost.nodes + "n/" + vmCost.links + "l";
    }

    frame = (frame + 1) | 0;
    requestAnimationFrame(loop);
}

// track churn volume by wrapping the population-affecting buttons' effect: the
// simplest honest witness is the delta in population magnitude, sampled above.
// We approximate churn as cumulative |spawn|+|kill| by hooking the buttons.
$btnSpawn.addEventListener("click", () => { churnVolume += parseInt($spawnRate.value, 10) | 0; });
$btnKill.addEventListener("click", () => { churnVolume += parseInt($killRate.value, 10) | 0; });
$btnStorm.addEventListener("click", () => { churnVolume += population(); });

requestAnimationFrame(loop);
