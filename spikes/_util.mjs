// spikes/_util.mjs -- shared, dependency-free helpers for the S0 runtime spikes.
// ASCII-only. No package source is imported here.
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Seeded xorshift32. Returns a function producing uint32 -> [0,1) via >>> 0.
export function xorshift32(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return function next() {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s >>> 0;
  };
}

// Median of a numeric array (does not mutate the input).
export function median(nums) {
  const a = nums.slice().sort((x, y) => x - y);
  const n = a.length;
  if (n === 0) return NaN;
  const mid = n >> 1;
  return (n & 1) ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

export function min(nums) {
  let m = Infinity;
  for (let i = 0; i < nums.length; i++) if (nums[i] < m) m = nums[i];
  return m;
}

// Provenance stamp. Reads process, os, and the installed peer version.
export function stamp() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  let liteSignal = 'unknown';
  try {
    const p = path.join(here, '..', 'node_modules', '@zakkster', 'lite-signal', 'package.json');
    liteSignal = JSON.parse(fs.readFileSync(p, 'utf8')).version;
  } catch { /* leave unknown */ }
  const cpus = os.cpus();
  return {
    node: process.version,
    arch: process.arch,
    cpus: cpus.length + 'x ' + (cpus[0] ? cpus[0].model : 'unknown'),
    date: new Date().toISOString().slice(0, 10),
    liteSignal,
  };
}

export function stampLine(s) {
  return 'PROVENANCE node=' + s.node + ' arch=' + s.arch + ' cpus=' + s.cpus +
    ' date=' + s.date + ' lite-signal=' + s.liteSignal;
}

// ASCII box table. rows[0] is the header row. All cells stringified.
export function table(rows) {
  const cells = rows.map((r) => r.map((c) => String(c)));
  const cols = cells[0].length;
  const width = new Array(cols).fill(0);
  for (const r of cells) for (let i = 0; i < cols; i++) if (r[i].length > width[i]) width[i] = r[i].length;
  const pad = (s, w) => s + ' '.repeat(w - s.length);
  const bar = '+' + width.map((w) => '-'.repeat(w + 2)).join('+') + '+';
  const out = [bar];
  for (let ri = 0; ri < cells.length; ri++) {
    const r = cells[ri];
    out.push('| ' + r.map((c, i) => pad(c, width[i])).join(' | ') + ' |');
    if (ri === 0) out.push(bar);
  }
  out.push(bar);
  return out.join('\n');
}

// Snapshot the conservation-relevant subset of stats() (F-0).
export function snap(stats) {
  const s = stats();
  return {
    activeNodes: s.activeNodes,
    activeLinks: s.activeLinks,
    totalAllocations: s.totalAllocations,
    totalDisposals: s.totalDisposals,
    poolGrowths: s.poolGrowths,
  };
}
