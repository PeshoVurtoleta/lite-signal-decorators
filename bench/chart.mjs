// bench/chart.mjs -- render the CHURN scenario of bench/results.txt to an SVG.
//
// Dev-side only: plain Node, node: builtins, zero runtime deps. Never shipped
// (bench/ stays out of package files[]). Deterministic by contract: parsing the
// same results.txt twice produces byte-identical output. No Date.now, no
// Math.random -- the only timestamp printed is the one results.txt stamps for
// its own run. Fail closed: any parse the code cannot verify exactly aborts with
// a named error instead of emitting a guessed chart.
//
// MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results.txt');
const OUT = join(HERE, 'results-chart.svg');

class ChartParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChartParseError';
  }
}

function fail(msg) {
  throw new ChartParseError(msg);
}

// ---- parse ----------------------------------------------------------------

const raw = readFileSync(RESULTS, 'utf8');
const lines = raw.split('\n');

// The last machine #STAMP line is the run the chart describes.
let stamp = null;
for (let i = lines.length - 1; i >= 0; i--) {
  const line = lines[i];
  if (line.startsWith('#STAMP ')) {
    const json = line.slice('#STAMP '.length).trim();
    try {
      stamp = JSON.parse(json);
    } catch (e) {
      fail('results.txt: #STAMP line at ' + (i + 1) + ' is not valid JSON: ' + e.message);
    }
    break;
  }
}
if (!stamp) fail('results.txt: no #STAMP line found -- refusing to chart an unstamped file');

const moduleVersion =
  stamp.extra && stamp.extra.adapters && stamp.extra.adapters.lsd;
if (!moduleVersion) fail('results.txt: stamp is missing extra.adapters.lsd (module version)');
for (const key of ['date', 'node', 'arch', 'platform', 'cpu', 'reps']) {
  if (stamp[key] === undefined || stamp[key] === null) {
    fail('results.txt: stamp is missing "' + key + '"');
  }
}

// Locate the LAST `churn` scenario block (NOT `churn-reuse`).
let headerIdx = -1;
let shape = null;
let iters = null;
for (let i = lines.length - 1; i >= 0; i--) {
  const m = lines[i].match(/^churn\s+shape=(\{[^}]*\})\s+iters=(\d+)\s*$/);
  if (m) {
    headerIdx = i;
    shape = m[1];
    iters = m[2];
    break;
  }
}
if (headerIdx < 0) fail('results.txt: no `churn` scenario header found');

// Rows begin two lines after the header (header, divider, then rows) and end at
// the first blank line. Every churn row carries a median= field.
const rows = [];
for (let i = headerIdx + 2; i < lines.length; i++) {
  const line = lines[i];
  if (line.trim() === '') break;
  if (line.startsWith('-')) break;
  const nameM = line.match(/^(\S+)\s+median=/);
  if (!nameM) continue;
  const name = nameM[1];
  const opsM = line.match(/ops\/s=(\d+)K\b/);
  const heapM = line.match(/heapMed=\s*(-?[\d.]+)KB\b/);
  const retM = line.match(/retained=\s*(-?[\d.]+)KB\b/);
  if (!opsM) fail('results.txt: churn row "' + name + '" has no ops/s field');
  if (!heapM) fail('results.txt: churn row "' + name + '" has no heapMed field');
  if (!retM) fail('results.txt: churn row "' + name + '" has no retained field');
  rows.push({
    name,
    opsK: Number(opsM[1]),
    heapKB: Number(heapM[1]),
    retainedKB: Number(retM[1]),
  });
}
if (rows.length === 0) fail('results.txt: churn block parsed zero adapter rows');
for (const r of rows) {
  if (!Number.isFinite(r.opsK) || !Number.isFinite(r.heapKB) || !Number.isFinite(r.retainedKB)) {
    fail('results.txt: churn row "' + r.name + '" produced a non-finite number');
  }
}

// alien-class caveat, tightly paraphrased from results.txt's own churn-reuse
// unsupported note. Verify the source wording is actually present before quoting.
const CAVEAT_ANCHOR =
  'a hand-rolled class over alien-signals has no pooled instance lifecycle';
const hasAlien = rows.some((r) => r.name === 'alien-class');
if (hasAlien && raw.indexOf(CAVEAT_ANCHOR) < 0) {
  fail('results.txt: alien-class present but its caveat wording was not found -- refusing to invent a footnote');
}

// ---- render ---------------------------------------------------------------

const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

// Layout constants (all fixed -> byte-reproducible geometry).
const W = 720;
const PAD = 16;
const NAME_RIGHT = 150; // right edge of the adapter-name column
const BAR_X = 158; // left edge of every bar
const BAR_MAX = 396; // max bar length in px
const VALUE_X = BAR_X + BAR_MAX + 8; // left edge of value labels
const ROW_H = 26;
const BAR_H = 16;

const COL_BG = '#f6f8fa';
const COL_PANEL = '#ffffff';
const COL_TEXT = '#1f2328';
const COL_MUTED = '#57606a';
const COL_BAR = '#57606a'; // reference adapters
const COL_OURS = '#0969da'; // this package (lsd + lsd-define)
const COL_GRID = '#d0d7de';

const isOurs = (name) => name === 'lsd' || name === 'lsd-define';

const fmtInt = (n) => Math.round(n).toString();
// KB with no fractional noise once past ~1MB; keep one decimal below that.
const fmtKB = (kb) => (kb >= 1000 ? fmtInt(kb) : kb.toFixed(1));

function panel(title, unitLabel, valueOf, labelOf, colorOf, x, y, w) {
  const max = rows.reduce((mx, r) => Math.max(mx, valueOf(r)), 0);
  const denom = max > 0 ? max : 1;
  const parts = [];
  const innerH = 40 + rows.length * ROW_H;
  parts.push(
    '  <rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + innerH +
      '" rx="6" fill="' + COL_PANEL + '" stroke="' + COL_GRID + '"/>'
  );
  parts.push(
    '  <text x="' + (x + 12) + '" y="' + (y + 20) + '" font-size="13" font-weight="700" fill="' +
      COL_TEXT + '">' + esc(title) + '</text>'
  );
  parts.push(
    '  <text x="' + (x + w - 12) + '" y="' + (y + 20) + '" font-size="10" text-anchor="end" fill="' +
      COL_MUTED + '">' + esc(unitLabel) + '</text>'
  );
  let ry = y + 34;
  for (const r of rows) {
    const v = valueOf(r);
    const barW = Math.max(1, (v / denom) * BAR_MAX);
    const cy = ry + ROW_H / 2;
    const barY = cy - BAR_H / 2;
    parts.push(
      '  <text x="' + NAME_RIGHT + '" y="' + (cy + 4) + '" font-size="11" text-anchor="end" fill="' +
        COL_TEXT + '">' + esc(r.name) + '</text>'
    );
    parts.push(
      '  <rect x="' + BAR_X + '" y="' + barY.toFixed(1) + '" width="' + barW.toFixed(1) +
        '" height="' + BAR_H + '" rx="2" fill="' + colorOf(r) + '"/>'
    );
    parts.push(
      '  <text x="' + VALUE_X + '" y="' + (cy + 4) + '" font-size="11" fill="' + COL_TEXT +
        '">' + esc(labelOf(r)) + '</text>'
    );
    ry += ROW_H;
  }
  return { svg: parts.join('\n'), bottom: y + innerH };
}

const svgParts = [];

// Title + scenario line.
svgParts.push(
  '  <text x="' + PAD + '" y="28" font-size="16" font-weight="700" fill="' + COL_TEXT +
    '">CHURN -- construct + write + read + dispose, per adapter</text>'
);
svgParts.push(
  '  <text x="' + PAD + '" y="46" font-size="10" fill="' + COL_MUTED + '">shape=' +
    esc(shape) + '  iters=' + esc(iters) +
    '  -- higher ops/s is faster; lower heap is leaner. blue = this package.</text>'
);

// Panel (a): throughput.
const pa = panel(
  '(a) throughput -- ops/s per adapter',
  'thousands of ops/s (K)',
  (r) => r.opsK,
  (r) => fmtInt(r.opsK) + 'K',
  (r) => (isOurs(r.name) ? COL_OURS : COL_BAR),
  PAD,
  58,
  W - PAD * 2
);
svgParts.push(pa.svg);

// Panel (b): transient heap (heapMed) -- exactly what results.txt stamps.
const pb = panel(
  '(b) transient heap per timed run -- heapMed',
  'kilobytes (KB)',
  (r) => r.heapKB,
  (r) => fmtKB(r.heapKB) + ' KB',
  (r) => (isOurs(r.name) ? COL_OURS : COL_BAR),
  PAD,
  pa.bottom + 14,
  W - PAD * 2
);
svgParts.push(pb.svg);

// alien-class honesty footnote.
let footY = pb.bottom + 20;
if (hasAlien) {
  svgParts.push(
    '  <text x="' + PAD + '" y="' + footY + '" font-size="10" fill="' + COL_MUTED +
      '">* alien-class is the speed-of-light reference: a hand-rolled class over alien-signals with no</text>'
  );
  footY += 14;
  svgParts.push(
    '  <text x="' + PAD + '" y="' + footY + '" font-size="10" fill="' + COL_MUTED +
      '">  pooled instance lifecycle -- nodes are freed only by GC and effect stop() is terminal, so a</text>'
  );
  footY += 14;
  svgParts.push(
    '  <text x="' + PAD + '" y="' + footY + '" font-size="10" fill="' + COL_MUTED +
      '">  released instance cannot be re-acquired (results.txt, churn-reuse). It has no class/disposal layer.</text>'
  );
  footY += 14;
}

// Footer: the run's OWN stamp -- module version, date, rig. Never generation
// time. Two lines so the full stamp stays inside the 720px viewBox.
footY += 6;
const stampLine1 =
  'source: bench/results.txt (stamped run) -- module lsd ' + moduleVersion +
  ' -- ' + stamp.date;
const stampLine2 =
  'rig: ' + stamp.cpu + ' ' + stamp.platform + '/' + stamp.arch +
  ' node ' + stamp.node + ' -- median-of-5, reps=' + stamp.reps;
svgParts.push(
  '  <text x="' + PAD + '" y="' + footY + '" font-size="9" fill="' + COL_MUTED + '">' +
    esc(stampLine1) + '</text>'
);
footY += 12;
svgParts.push(
  '  <text x="' + PAD + '" y="' + footY + '" font-size="9" fill="' + COL_MUTED + '">' +
    esc(stampLine2) + '</text>'
);

const H = footY + 12;

const doc =
  '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H +
  '" viewBox="0 0 ' + W + ' ' + H +
  '" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" role="img" ' +
  'aria-label="Churn benchmark: ops per second and transient heap per adapter">\n' +
  '  <rect x="0" y="0" width="' + W + '" height="' + H + '" fill="' + COL_BG + '"/>\n' +
  svgParts.join('\n') +
  '\n</svg>\n';

writeFileSync(OUT, doc, 'utf8');
process.stdout.write('wrote ' + OUT + ' (' + doc.length + ' bytes, ' + rows.length + ' adapters)\n');
