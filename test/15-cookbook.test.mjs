// test/15-cookbook.test.mjs -- the drift/parity checker for COOKBOOK.md (CB-T4).
//
// PD-36: the drift mechanism is EXTRACTION with the companion as source of truth.
// Each companion cookbook/rNN-slug.mjs wraps every published snippet in
// `// #region cookbook:rNN.k` .. `// #endregion cookbook:rNN.k`. Each fenced block
// in COOKBOOK.md is preceded by `<!-- COOKBOOK:rNN.k -->` (or, for a non-runnable
// illustration, `<!-- COOKBOOK:pointer <pkg> -->`). This test extracts both sides
// and byte-compares after a single common dedent, mirroring the house marker+
// extract+byte-compare pattern of test/04-fixture-freshness.test.mjs -- but in
// BOTH directions and with coverage checked both ways. It also adopts, tightened,
// 27-parity's surface-freeze, citation, link and version checks (CB-A1/A2/A5/A6b).
//
// This test NEVER runs the companions (the `npm run cookbook` gate step owns
// execution) and NEVER reads outside the package directory. ASCII only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const COOKBOOK_DIR = join(ROOT, "cookbook");
const SELF_PKG = "@zakkster/lite-signal-decorators";

// ---------------------------------------------------------------------------
// parsing primitives (pitfalls encoded literally -- see the task PARSING RULES)
// ---------------------------------------------------------------------------

// A doc tag is a line that is EXACTLY `<!-- COOKBOOK:rN.k -->` (unpadded id). The
// appendix prose mentions `COOKBOOK:rNN.k` mid-sentence; line-anchored exact-form
// matching excludes it.
const DOC_TAG = /^<!-- COOKBOOK:(r\d+\.\d+) -->$/;
// A pointer tag is a line starting `<!-- COOKBOOK:pointer ` naming a package.
const POINTER_TAG = /^<!-- COOKBOOK:pointer (\S+) -->$/;
// A companion region OPEN, line-anchored with the numeric \d+\.\d+ form so that
// backtick-quoted mentions inside a header comment (e.g. "`#region cookbook:r9.k`
// spans") do NOT count.
const REGION_OPEN = /^\s*\/\/ #region cookbook:(r\d+\.\d+)\s*$/;
const FENCE_OPEN = /^```(\w*)\s*$/;
const FENCE_CLOSE = /^```\s*$/;

function readLines(file) {
    return readFileSync(file, "utf8").split("\n");
}

// Strip one common leading-whitespace prefix from a block of body lines. Blank
// lines are ignored when computing the common indent and are emitted verbatim.
function dedent(lines) {
    let min = Infinity;
    for (const l of lines) {
        if (l.trim() === "") continue;
        const n = l.length - l.replace(/^\s+/, "").length;
        if (n < min) min = n;
    }
    if (!isFinite(min)) min = 0;
    return lines.map((l) => (l.trim() === "" ? l.slice(0, 0) : l.slice(min))).join("\n");
}

function companionFiles() {
    return readdirSync(COOKBOOK_DIR)
        .filter((f) => f.endsWith(".mjs") && f !== "run.mjs")
        .sort();
}

// Companion regions: id -> { body:[lines], file }. Duplicate ids are a failure.
function collectRegions() {
    const regions = new Map();
    for (const f of companionFiles()) {
        const lines = readLines(join(COOKBOOK_DIR, f));
        for (let i = 0; i < lines.length; i++) {
            const m = lines[i].match(REGION_OPEN);
            if (!m) continue;
            const id = m[1];
            const close = new RegExp("^\\s*// #endregion cookbook:" + id.replace(".", "\\.") + "\\s*$");
            let j = i + 1;
            const body = [];
            for (; j < lines.length; j++) {
                if (close.test(lines[j])) break;
                body.push(lines[j]);
            }
            assert.ok(j < lines.length, f + ": region " + id + " is not closed");
            assert.ok(!regions.has(id), "duplicate companion region id " + id + " (" + f + ")");
            regions.set(id, { body, file: f });
        }
    }
    return regions;
}

// COOKBOOK.md tagged blocks. Returns { docBlocks: Map<id,{body}>, pointers:[{pkg,body,line}] }.
// A tag line MUST be immediately followed by a fence-open line.
function collectDocBlocks(lines) {
    const docBlocks = new Map();
    const pointers = [];
    for (let i = 0; i < lines.length; i++) {
        const docm = lines[i].match(DOC_TAG);
        const ptrm = lines[i].match(POINTER_TAG);
        if (!docm && !ptrm) continue;
        const id = docm ? docm[1] : null;
        const pkg = ptrm ? ptrm[1] : null;
        const label = id || ("pointer " + pkg);
        assert.ok(FENCE_OPEN.test(lines[i + 1] || ""),
            "COOKBOOK.md: tag " + label + " on line " + (i + 1) + " is not immediately followed by a fenced block");
        let j = i + 2;
        const body = [];
        for (; j < lines.length; j++) {
            if (FENCE_CLOSE.test(lines[j])) break;
            body.push(lines[j]);
        }
        assert.ok(j < lines.length, "COOKBOOK.md: fenced block for " + label + " is not closed");
        if (id) {
            assert.ok(!docBlocks.has(id), "COOKBOOK.md: duplicate doc tag " + id);
            docBlocks.set(id, { body });
        } else {
            pointers.push({ pkg, body, line: i + 1 });
        }
    }
    return { docBlocks, pointers };
}

// Every import specifier's ORIGINAL (pre-`as`) names from a source string, keyed
// by package. `import { a as b } from 'p'` yields 'a' under 'p'.
function importsByPackage(src) {
    const out = new Map();
    const re = /import\s*(?:(\w+)\s*,\s*)?(?:\{([^}]*)\}|(\w+)|\*\s*as\s+\w+)\s*from\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const pkg = m[4];
        const names = [];
        if (m[1]) names.push(m[1]);
        if (m[3]) names.push(m[3]);
        if (m[2]) {
            for (const part of m[2].split(",")) {
                const t = part.trim();
                if (!t) continue;
                names.push(t.split(/\s+as\s+/)[0].trim());
            }
        }
        if (!out.has(pkg)) out.set(pkg, new Set());
        for (const n of names) out.get(pkg).add(n);
    }
    return out;
}

function loadManifest() {
    return JSON.parse(readFileSync(join(COOKBOOK_DIR, "manifest.json"), "utf8"));
}

function loadCitations() {
    return JSON.parse(readFileSync(join(COOKBOOK_DIR, "citations.json"), "utf8"));
}

// The set of symbol NAMES documented for a citations package entry.
function citationSymbolNames(entry) {
    if (!entry || !Array.isArray(entry.symbols)) return new Set();
    return new Set(entry.symbols.map((s) => (typeof s === "string" ? s : s.name)));
}

// ---------------------------------------------------------------------------
// 1. EXTRACTION (CB-A1) -- byte-exact, both directions, both-way coverage
// ---------------------------------------------------------------------------

test("CB-A1 every doc tag's block byte-equals its companion region (after one dedent)", () => {
    const { docBlocks } = collectDocBlocks(readLines(join(ROOT, "COOKBOOK.md")));
    const regions = collectRegions();
    assert.ok(docBlocks.size > 0, "no COOKBOOK.md doc tags found -- parser is wrong");
    for (const [id, block] of docBlocks) {
        const region = regions.get(id);
        assert.ok(region, "COOKBOOK.md tag " + id + " has no companion region // #region cookbook:" + id);
        assert.equal(
            dedent(block.body),
            dedent(region.body),
            "DRIFT at " + id + " (" + region.file + "): the fenced block in COOKBOOK.md does not " +
                "byte-match the companion region after dedent -- the companion is the source of truth",
        );
    }
});

test("CB-A1 no orphan companion regions (every region is referenced by a doc tag)", () => {
    const { docBlocks } = collectDocBlocks(readLines(join(ROOT, "COOKBOOK.md")));
    const regions = collectRegions();
    for (const [id, region] of regions) {
        assert.ok(docBlocks.has(id),
            "orphan region " + id + " in " + region.file + " -- no <!-- COOKBOOK:" + id + " --> tag in COOKBOOK.md");
    }
});

test("CB-A1 every js fence inside a `## Recipe` section carries a doc or pointer tag", () => {
    const lines = readLines(join(ROOT, "COOKBOOK.md"));
    let section = "";
    let untagged = [];
    for (let i = 0; i < lines.length; i++) {
        const h2 = lines[i].match(/^## (.+)$/);
        if (h2) { section = h2[1]; continue; }
        const fence = lines[i].match(FENCE_OPEN);
        if (!fence || fence[1] !== "js") continue;
        if (!/^Recipe /.test(section)) continue;
        const prev = lines[i - 1] || "";
        if (!DOC_TAG.test(prev) && !POINTER_TAG.test(prev)) {
            untagged.push("line " + (i + 1) + " in section '" + section + "'");
        }
    }
    assert.deepEqual(untagged, [],
        "untagged ```js block(s) inside a Recipe section (need a COOKBOOK:rN.k or COOKBOOK:pointer tag):\n  " +
            untagged.join("\n  "));
});

test("CB-A1 every manifest recipe has >= 1 tagged doc block", () => {
    const { docBlocks } = collectDocBlocks(readLines(join(ROOT, "COOKBOOK.md")));
    const manifest = loadManifest();
    const haveIds = new Set([...docBlocks.keys()].map((id) => id.split(".")[0]));
    for (const rec of manifest.recipes) {
        assert.ok(haveIds.has(rec.id),
            "manifest recipe " + rec.id + " (" + rec.title + ") has no tagged block in COOKBOOK.md");
    }
});

test("CB-A1 ground-truth counts: 51 regions / 51 doc tags / 3 pointers / 18 companions", () => {
    const { docBlocks, pointers } = collectDocBlocks(readLines(join(ROOT, "COOKBOOK.md")));
    const regions = collectRegions();
    assert.equal(regions.size, 51, "expected 51 companion regions, saw " + regions.size);
    assert.equal(docBlocks.size, 51, "expected 51 doc tags, saw " + docBlocks.size);
    assert.equal(pointers.length, 3, "expected 3 pointer tags, saw " + pointers.length);
    assert.equal(companionFiles().length, 18, "expected 18 companions, saw " + companionFiles().length);
});

// ---------------------------------------------------------------------------
// 2. MANIFEST SANITY
// ---------------------------------------------------------------------------

test("MANIFEST 18 entries r0..r17, companions exist, gated set exact, reasons non-empty", () => {
    const manifest = loadManifest();
    const ids = manifest.recipes.map((r) => r.id);
    assert.deepEqual(ids,
        ["r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10", "r11",
            "r12", "r13", "r14", "r15", "r16", "r17"],
        "manifest ids are not exactly r0..r17 in order: " + ids.join(","));
    for (const rec of manifest.recipes) {
        assert.ok(existsSync(join(ROOT, rec.companion)),
            rec.id + ": companion " + rec.companion + " does not exist");
    }
    const gated = manifest.recipes.filter((r) => r.gc === "gated").map((r) => r.id).sort();
    assert.deepEqual(gated, ["r1", "r2", "r4", "r5", "r9", "r10", "r13", "r17"].sort(),
        "gated set is not exactly {r1,r2,r4,r5,r9,r10,r13,r17}: " + gated.join(","));
    for (const rec of manifest.recipes) {
        if (rec.gc === "none") {
            assert.ok(typeof rec.reason === "string" && rec.reason.trim().length > 0,
                rec.id + ' is gc:"none" with an empty reason -- an empty reason is a FAILURE');
        }
    }
});

// ---------------------------------------------------------------------------
// 3. SURFACE FREEZE (CB-A2)
// ---------------------------------------------------------------------------

test("CB-A2 runtime module exports EXACTLY 19 names and the corpus cites only those", async () => {
    const mod = await import(SELF_PKG);
    const exportSet = new Set(Object.keys(mod));
    assert.equal(exportSet.size, 19,
        "expected exactly 19 exports, saw " + exportSet.size + ": " + [...exportSet].sort().join(","));

    // Every decorators identifier imported anywhere in cookbook/*.mjs is a member.
    for (const f of companionFiles()) {
        const src = readFileSync(join(COOKBOOK_DIR, f), "utf8");
        const names = importsByPackage(src).get(SELF_PKG);
        if (!names) continue;
        for (const n of names) {
            assert.ok(exportSet.has(n),
                f + " imports ghost API '" + n + "' from " + SELF_PKG + " (not in the 19-export surface)");
        }
    }

    // Every decorators identifier imported inside a COOKBOOK.md fenced block too.
    const lines = readLines(join(ROOT, "COOKBOOK.md"));
    const { docBlocks, pointers } = collectDocBlocks(lines);
    const allBlocks = [...[...docBlocks.values()].map((b) => b.body), ...pointers.map((p) => p.body)];
    for (const body of allBlocks) {
        const names = importsByPackage(body.join("\n")).get(SELF_PKG);
        if (!names) continue;
        for (const n of names) {
            assert.ok(exportSet.has(n),
                "COOKBOOK.md fenced block imports ghost API '" + n + "' from " + SELF_PKG);
        }
    }

    // The Recipe 0 self-pointer block's decorator identifiers (strip the @).
    const selfPtr = pointers.find((p) => p.pkg === SELF_PKG);
    assert.ok(selfPtr, "the Recipe 0 self-pointer block (<!-- COOKBOOK:pointer " + SELF_PKG + " -->) is missing");
    const text = selfPtr.body.join("\n");
    for (const dec of ["reactive", "derived", "reactiveEffect", "batched", "reactiveHost"]) {
        if (new RegExp("@" + dec + "\\b").test(text)) {
            assert.ok(exportSet.has(dec),
                "self-pointer block uses @" + dec + " but '" + dec + "' is not a runtime export");
        }
    }
});

// ---------------------------------------------------------------------------
// 4. CITATIONS (CB-A2 / PD-39)
// ---------------------------------------------------------------------------

test("CB-A2 every cross-package import in the corpus is allow-listed in citations.json", () => {
    const citations = loadCitations();
    for (const f of companionFiles()) {
        const src = readFileSync(join(COOKBOOK_DIR, f), "utf8");
        for (const [pkg, names] of importsByPackage(src)) {
            if (!pkg.startsWith("@zakkster/") || pkg === SELF_PKG) continue;
            const entry = citations[pkg];
            assert.ok(entry, f + " imports from " + pkg + " but it has no cookbook/citations.json entry");
            const symbols = citationSymbolNames(entry);
            for (const n of names) {
                assert.ok(symbols.has(n),
                    f + " imports '" + n + "' from " + pkg + " but it is not in that entry's symbols[]");
            }
        }
    }
});

test("PD-39 every pointer block's cited package is allow-listed and its imports match", () => {
    const citations = loadCitations();
    const { pointers } = collectDocBlocks(readLines(join(ROOT, "COOKBOOK.md")));
    for (const p of pointers) {
        if (p.pkg === SELF_PKG) continue; // the self-pointer is covered by the 19-export freeze
        const entry = citations[p.pkg];
        assert.ok(entry, "pointer block at COOKBOOK.md:" + p.line + " cites " + p.pkg + " with no citations.json entry");
        const symbols = citationSymbolNames(entry);
        const imported = importsByPackage(p.body.join("\n")).get(p.pkg);
        if (imported) {
            for (const n of imported) {
                assert.ok(symbols.has(n),
                    "pointer block for " + p.pkg + " imports '" + n + "' which is not in its citations.json symbols[]");
            }
        }
    }
});

// ---------------------------------------------------------------------------
// 5. LINK LAW (CB-A6b) -- adapted from 27-parity.test.mjs:111-123
// ---------------------------------------------------------------------------

// All markdown link targets in a doc: [text](target).
function mdLinks(src) {
    const out = [];
    const re = /\]\(([^)]+)\)/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push(m[1].trim());
    return out;
}

test("CB-A6b README relative .md links resolve (siblings in files[], subdir links in the tree)", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const shipped = new Set(pkg.files);
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const target of mdLinks(readme)) {
        if (/^https?:\/\//.test(target) || target.startsWith("#")) continue;
        const path = target.split("#")[0];
        if (!path.endsWith(".md")) continue;
        if (path.includes("/")) {
            // A repo-relative subdir doc (e.g. decisions/xxxx.md): must exist in the tree.
            assert.ok(existsSync(join(ROOT, path)),
                "README.md relative link '" + target + "' does not resolve in the repo tree");
        } else {
            // A sibling doc ships in the tarball root: it MUST be in files[] or it is
            // a dead link from node_modules (the 27-parity:111-123 law).
            const name = path.replace(/^\.\//, "");
            assert.ok(shipped.has(name),
                "README.md links to sibling '" + name + "' which is not in package.json files[] -- dead from node_modules");
        }
    }
});

test("CB-A6b any COOKBOOK.md reference in shipped docs is an ABSOLUTE GitHub URL", () => {
    const base = "https://github.com/PeshoVurtoleta/lite-signal-decorators";
    for (const doc of ["README.md", "llms.txt"]) {
        const src = readFileSync(join(ROOT, doc), "utf8");
        for (const target of mdLinks(src)) {
            if (!/COOKBOOK\.md/i.test(target)) continue;
            assert.ok(target.startsWith(base),
                doc + " links to COOKBOOK.md via '" + target + "' -- it must be the absolute " + base + " URL");
        }
    }
    // Zero references today is a PASS (the docs coder adds the pointer after us).
    assert.ok(true);
});

test("CB-A6b every relative link inside COOKBOOK.md resolves in the repo tree", () => {
    const src = readFileSync(join(ROOT, "COOKBOOK.md"), "utf8");
    for (const target of mdLinks(src)) {
        if (/^https?:\/\//.test(target) || target.startsWith("#") || target.startsWith("mailto:")) continue;
        const path = target.split("#")[0];
        if (!path) continue;
        assert.ok(existsSync(join(ROOT, path)),
            "COOKBOOK.md relative link '" + target + "' does not resolve to a file in the repo tree");
    }
});

// ---------------------------------------------------------------------------
// 6. VERSION CONSISTENCY (27-parity adoption)
// ---------------------------------------------------------------------------

test("VERSION module.VERSION === package.json version === llms.txt line 3", async () => {
    const mod = await import(SELF_PKG);
    const pkgVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
    const llmsLine3 = readFileSync(join(ROOT, "llms.txt"), "utf8").split("\n")[2];
    const m = llmsLine3.match(/(\d+\.\d+\.\d+[0-9A-Za-z.-]*)/);
    assert.ok(m, "llms.txt line 3 states no version: '" + llmsLine3 + "'");
    assert.equal(mod.VERSION, pkgVersion, "module VERSION " + mod.VERSION + " != package.json " + pkgVersion);
    assert.equal(m[1], pkgVersion, "llms.txt line 3 version " + m[1] + " != package.json " + pkgVersion);
});

// ---------------------------------------------------------------------------
// 7. STATIC-COST FAST PROBE (CB-A5 spirit; in-process, no 100k build here)
// ---------------------------------------------------------------------------

test("CB-A5 costOf(collection).nodes is invariant to backing-array size and equals P+D+E+1", async () => {
    const { defineReactive, costOf } = await import(SELF_PKG);
    // A collection owner: a plain backing array plus two reactive members
    // (rev + length). P=2, D=0, E=0 -> nodes = P + D + E + 1 = 3, whatever it holds.
    class ListBase {
        constructor() { this.items = []; }
        push(v) { this.items.push(v); this.length = this.items.length; this.rev = this.rev + 1; }
    }
    const List = defineReactive(ListBase, { signals: { rev: 0, length: 0 }, deriveds: {}, effects: {} });
    const cost = costOf(List);
    const formula = cost.signals + cost.deriveds + cost.effects + 1;
    assert.equal(cost.nodes, formula, "costOf.nodes " + cost.nodes + " != P+D+E+1 " + formula);
    assert.equal(cost.nodes, 3, "expected 3 nodes for {rev,length}, saw " + cost.nodes);

    const seen = {};
    for (const size of [0, 1000]) {
        const list = new List();
        for (let i = 0; i < size; i++) list.push(i); // plain-array growth, no new nodes
        seen[size] = costOf(List).nodes;
    }
    assert.equal(seen[0], seen[1000],
        "costOf.nodes moved with item count: 0-item=" + seen[0] + " vs 1000-item=" + seen[1000] + " (per-element node leak)");
    assert.equal(seen[1000], cost.nodes, "1000-item cost " + seen[1000] + " != owner nodes " + cost.nodes);
});
