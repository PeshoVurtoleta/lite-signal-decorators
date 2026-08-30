// demo/src/ui/dom.ts -- every selector cached ONCE at boot in a $-prefixed
// const (demo-audit / lite-law: never look one up in a handler). This is the
// only file that reaches into the document; the core planes stay DOM-free.
//
// ASCII-only.

function byId<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (el === null) throw new Error("fleet-playground: missing #" + id);
    return el as T;
}

export const $scene = byId<HTMLCanvasElement>("scene");
export const $spark = byId<HTMLCanvasElement>("spark");

export const $spawnRate = byId<HTMLInputElement>("spawnRate");
export const $killRate = byId<HTMLInputElement>("killRate");
export const $spawnVal = byId<HTMLElement>("spawnVal");
export const $killVal = byId<HTMLElement>("killVal");

export const $btnSpawn = byId<HTMLButtonElement>("btnSpawn");
export const $btnKill = byId<HTMLButtonElement>("btnKill");
export const $btnPause = byId<HTMLButtonElement>("btnPause");
export const $btnStorm = byId<HTMLButtonElement>("btnStorm");
export const $btnTheme = byId<HTMLButtonElement>("btnTheme");

export const $tAlert = byId<HTMLElement>("tAlert");
export const $tPop = byId<HTMLElement>("tPop");
export const $tBudget = byId<HTMLElement>("tBudget");
export const $tNodes = byId<HTMLElement>("tNodes");
export const $tLinks = byId<HTMLElement>("tLinks");
export const $tVmCost = byId<HTMLElement>("tVmCost");
export const $popBar = byId<HTMLElement>("popBar");
export const $popFill = byId<HTMLElement>("popFill");

export const $tFps = byId<HTMLElement>("tFps");
export const $tFrame = byId<HTMLElement>("tFrame");
export const $tEffect = byId<HTMLElement>("tEffect");
export const $tChurn = byId<HTMLElement>("tChurn");
