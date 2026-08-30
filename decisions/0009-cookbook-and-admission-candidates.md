# 0009 -- the repo-only cookbook and the four admission candidates

Status: ACCEPTED (cookbook session, 2026-08-30). Records PD-34..PD-40 of
PLAN-COOKBOOK.md. Evidence: the cookbook lane and gate tails measured at closeout
(peer 1.5.0, Node 26.3.1) -- `npm test` 228 pass / 0 fail (was 214; the checker
`test/15-cookbook.test.mjs` adds 14 cases); `cookbook lane: 12/12 companions ok
in 1.8s`; `--controls`: `cookbook lane: 6/6 controls fail correctly in 4.6s`;
`npm pack --dry-run` exactly 7 files; the 16-export surface and the three 1.0.0
version sites unchanged; `SignalDecorators.js` and `SignalDecorators.d.ts` diff
empty against the 1.0.0 tree.

## Context

`COOKBOOK.md` collects twelve composition recipes over the frozen 16-export
surface (0008 closed the surface at 16; 1.0.0 froze it under semver). The whole
session is cold-path: no hot body changes, no version is minted, no export is
added. The binding question set -- where the document lives, how it is delivered,
how its code is proven, and what absences it makes visible -- is recorded here.
The blueprint is `LiteGcProfiler/COOKBOOK.md` (2056 lines) with
`27-parity.test.mjs`; this record notes the one place this package deliberately
diverges from it.

## Decisions

### PD-34 -- COOKBOOK.md is GitHub-only; no version is minted.

**[OWNER OVERRIDE, 2026-08-30 -- amends the planner's original choice (b); the
original options, numbers, and the planner's reasoning are preserved verbatim
below, rejection-history style, so the override is a decision on the record and
not an erasure.]**

OPTIONS: (a) ship it in `files[]` like the blueprint, bump 1.0.1; (b) ship it,
bump 1.1.0; (c) repo-only, no bump, deviate from the blueprint.

NUMBERS (planner, unchanged): (c) costs nothing but makes the cookbook invisible
from `node_modules` -- the exact failure `27-parity.test.mjs:111-123` exists to
prevent, and a cookbook nobody reading the installed package can find is a
cookbook that does not exist. Between (a) and (b): the tarball manifest is
user-observable; a consumer diffing 1.0.0 against the next version sees a file
appear. The planner chose (b).

CHOICE: **(c) repo-only, by OWNER decision**, overriding the planner's (b). The
owner's reasoning: consumers download a FOCUSED bundle -- the tarball stays the
lean 7-file runtime surface -- and cookbook readers visit GitHub anyway. The
planner's discoverability objection is answered with POINTERS instead of cargo:
`README.md` and `llms.txt` -- both shipped -- name the cookbook and link its
ABSOLUTE GitHub URL
(`https://github.com/PeshoVurtoleta/lite-signal-decorators/blob/main/COOKBOOK.md`),
so every installed copy advertises it without carrying it.

CONSEQUENCES: `files[]` stays 6 and `npm pack` stays 7 files (the bare count
check is still upgraded to a NAMED-SET assertion, pure hardening, no number
moved -- CB-A6); no version bump -- the three version sites stay `1.0.0` and
`SignalDecorators.js`/`.d.ts` take zero diff; the CHANGELOG records the cookbook
under `[Unreleased]`, to fold into the owner's next release entry. The
shipped-doc link law becomes: RELATIVE `.md` links in shipped docs resolve within
`files[]`; the cookbook is referenced from shipped docs by absolute GitHub URL
ONLY (checked by `test/15-cookbook.test.mjs`). Delivery vehicle is `git`
(owner-gated), not `npm`.

### PD-35 -- one file, COOKBOOK.md, at the package root.

OPTIONS: (a) a single file (blueprint); (b) a `cookbook/` directory of markdown
pages.

CHOICE: **(a).** A directory would put N markdown files in the shipped-link check
and break the one property that makes the blueprint usable -- a single Ctrl-F
surface. 2056 lines is not a problem; the blueprint proves it. The `## Contents`
section is the navigation.

CONSEQUENCES: one file at the repo root; `files[]` unchanged (PD-34 as amended).
Note the naming split: the document is `COOKBOOK.md`; the runnable corpus lives
in a `cookbook/` directory (PD-37) -- these are distinct.

### PD-36 -- the drift mechanism is EXTRACTION with the companion as source of truth.

OPTIONS: (a) a parity test in 27-parity's style (names/versions agree); (b)
generate the whole cookbook from the companions (emit-matrix style); (c)
extraction: companions are canonical, markdown blocks byte-compared against
delimited companion regions.

NUMBERS: (a) checks nothing about whether a recipe RUNS -- the blueprint's own
gap (`27-parity.test.mjs` is name parity only). (b) would force the prose through
a generator, destroying the tone the blueprint's value rests on. (c) keeps the
prose hand-written and the code mechanically true.

CHOICE: **(c).** Each companion `cookbook/rNN-slug.mjs` wraps every published
snippet in `// #region cookbook:rNN.k` .. `// #endregion cookbook:rNN.k`. Each
fenced block in `COOKBOOK.md` is preceded by `<!-- COOKBOOK:rNN.k -->` (or, for a
non-runnable illustration, `<!-- COOKBOOK:pointer <pkg> -->`).
`test/15-cookbook.test.mjs` extracts both sides and byte-compares after one common
dedent -- the house marker+extract+byte-compare pattern of
`test/04-fixture-freshness.test.mjs:63-77`, but BOTH directions with coverage
checked both ways.

CONSEQUENCES: bidirectional drift is loud -- editing prose is free; editing code
in the markdown fails until the companion agrees, and vice versa. No orphan
regions, no untagged `js` block inside a `## Recipe` section. Ground truth at
closeout: 39 regions / 39 doc tags / 3 pointers / 12 companions.

### PD-37 -- companions live in cookbook/, never shipped, with a per-recipe --expose-gc mini-gate.

OPTIONS: (a) `test/cookbook/`; (b) `cookbook/` at root.

CHOICE: **(b).** `test/` is the torture+suite namespace and its `*.test.mjs`
glob; a second corpus there muddies both. `cookbook/` sits beside `demo/`,
`bench/`, `spikes/` -- the established "real code, never shipped" tier. The
CHECKER stays at `test/15-cookbook.test.mjs` so `npm test` picks it up; the RUNNER
is `cookbook/run.mjs` behind `npm run cookbook`, executing every companion under
`node --expose-gc`. `cookbook/manifest.json` carries, per recipe,
`{ id, title, tier, companion, gc: "gated" | "none", reason, cites }`;
`gc: "none"` REQUIRES a non-empty `reason` or the runner FAILS (honesty enforced,
not requested).

Gated (6): r1, r2, r4, r5, r9, r10. Not gated, reason published IN the recipe
(6): r0 (`costOf` is a cold double-probe that throws rather than guess), r3
(`capacityFor` is cold sizing), r6 (the lite-store boundary is NOT zero-GC --
lazy per-key signal allocation on first tracked read, `snapshot()` deep-copies),
r7 (labels/`rootOf` walks are cold and opt-in), r8 (lite-await allocates a
Promise per call by design -- a lifecycle boundary, not a frame path), r11 (a
mixed worked migration that states the cost per layer).

CONSEQUENCES: `test/gate.mjs` gains a BLOCKING `cookbook` step between
`bench:selftest` and `pack` -- the chain becomes 8 blocking + 1 non-blocking.
Every gated recipe carries a `COOKBOOK_BREAK=<id>` sabotage control (a gate that
cannot fail is not a gate): 6/6 controls fail correctly.

### PD-38 -- twelve recipes (0..11) this session; six named for the follow-up.

OPTIONS: (a) match the blueprint's 26 in one pass; (b) 12 with the spine built to
grow; (c) 6, minimal.

NUMBERS: the blueprint's 26 accumulated across many versions. Twelve recipes, six
GC-gated with sabotage controls, plus a checker, a runner, a manifest, three
diagrams and a gate step is one honest pipeline session. (c) cannot cover the
MobX-parity matrix the whole exercise exists to serve.

CHOICE: **(b) twelve.** Tiers: Start here (0), Basics (1-3), Working (4-8), Pro
(9-11). Numbering leaves room; sub-variants take the blueprint's `4b` form rather
than renumbering. DEFERRED, named now so the cut is a decision and not an
omission: the lite-signal-dom `keyed()` list recipe (needs a DOM lane and carries
the OPEN peer question), a lite-project optimistic-overlay recipe, the framework
tail (Vue/React/Angular interop), an off-thread arena recipe
(`SparseSet.detach`/`rebind` worker round-trip), a lite-devtools graph-walk recipe
layered on r7, and a `cookbook doctor` CLI-shaped script.

### PD-39 -- three new devDeps; everything else is a POINTER block.

OPTIONS: (a) devDep all six composition partners; (b) zero devDeps, every
cross-package block illustrative; (c) devDep the three that carry the heaviest
recipes and run headless.

NUMBERS: six devDeps for a docs artifact is a real cost on a package whose pitch
is zero runtime deps and a thin dev tree. Zero devDeps makes Recipes 6 and 9 --
the two the owner's research actually asked for -- unrunnable.

CHOICE: **(c) exactly three: `@zakkster/lite-store` 1.2.0, `@zakkster/lite-arena`
1.9.0, `@zakkster/lite-await` 1.1.1** (pinned). lite-arena is zero-dependency;
lite-await peers only on lite-signal, already installed; lite-store's peer status
was OPEN and CB-T1 resolved it before it was added. lite-bvh (drags a `lite-aabb`
peer) and lite-signal-dom (needs a DOM) stay POINTER-only. A POINTER block is
fenced `js`, preceded by `<!-- COOKBOOK:pointer <pkg> -->`, EXCLUDED from the
executable lane, and carries an italic note naming the package and why it is not
installed here. It is NOT exempt from truth: every symbol it cites appears in
`cookbook/citations.json` -- a vendored `pkg -> version -> [symbols]` allowlist
with a stamp line per package (source path + version + probe date), so the test
never reads outside the package directory.

CONSEQUENCES: r9's spatial-index step runs against a plain uniform-grid stand-in
in the companion, with the lite-bvh calls shown as a POINTER block and the
reassign-the-returned-id contract stated in prose. Recipe 4 cites
lite-signal-dom `keyed()` as a POINTER with the OPEN peer caveat spelled out.

### PD-40 -- ZERO new exports; four admission candidates recorded, none admitted.

The 16-export surface gains nothing from this work. Writing the recipes made four
absences visible; each is RECORDED under the S6-T5 / ROADMAP admission bar (a
symbol is admitted only with a real, named consumer), never added. See "Admission
candidates" below. A recipe that "needs" a new decorator is a recipe that is
wrong, not a surface that is short: no `@iterable`, no observable arrays, no deep
proxy decorator.

## The deliberate blueprint deviation (recorded)

The blueprint SHIPS its cookbook: `LiteGcProfiler/COOKBOOK.md` is listed in
`files[]` and `27-parity.test.mjs:115` asserts it plus `README.md` /
`INCONCLUSIVE.md` are all shipped and that no shipped doc links to an unshipped
one. This package does the opposite under PD-34-as-amended: `COOKBOOK.md` is NOT
in `files[]`; it is delivered GitHub-only and pointed to from the shipped
`README.md` and `llms.txt` by ABSOLUTE GitHub URL. Why the deviation is correct
here: the owner's product decision is a lean, focused runtime tarball (the 7-file
surface), and this package's drift mechanism (PD-36 extraction) is strictly
stronger than the blueprint's name-parity check -- it proves every published
block RUNS -- so the discoverability the blueprint buys by shipping the file is
bought here by shipped absolute-URL pointers plus a link law that FORBIDS a
relative shipped-doc link to the unshipped file. The blueprint's own guard (no
shipped doc links to an unshipped doc) is honored in spirit: the only references
are absolute URLs, checked by `test/15-cookbook.test.mjs`.

## Delivery vehicle

`git` -- an owner-gated commit/push to GitHub. No npm publish is required by this
work and the published package is untouched. Every git operation awaits the
owner's explicit go; nothing is pushed, tagged, or published by the pipeline.

## Admission candidates (PD-40; none admitted -- the surface stays 16)

The admission bar (BRIEF S6-T5 / ROADMAP rule): a new export is admitted ONLY
with a real, named consumer. A recipe is not a consumer -- it is the evidence
that composition already serves the need (design law 4: an iterator need is
served as a recipe, not a decorator). Each candidate below records the recipe
that exposed the absence and how that recipe serves the need in composition
instead. NONE is admitted.

1. **`bump(vm, key)`** -- Recipes 4 and 5 write `this.rev++` (or
   `this.length = ...`) by hand at the mutation site. Exposed by: the
   rev+length reactive-collection pattern (r4) and the rev-stamped deep-subtree
   boundary (r5). Served instead: the mutator method bumps its own rev signal in
   one line; the reader watches the commit counter, not the tree. No named
   consumer -> NOT admitted.

2. **`forEachReactive(vm, fn)`** -- Recipe 7 composes `rootOf(vm)` +
   `registry.forEachOwned` + `labelOf` in six lines. Exposed by: walking and
   serializing a VM (r7) -- this is the iterator-decorator need, and it stays a
   recipe by design law 4. Served instead: the six-line composition over the
   existing `rootOf`/`forEachOwned`/`labelOf` surface. No named consumer ->
   NOT admitted. (If r7 is ever cut under the plan's cut-line 3, this candidate
   still stands recorded here so the justification is not lost.)
   ADMITTED 2026-08-30 (v1.3.0) under decisions/0013 -- `snapshotOf` ships as the named in-package consumer that admits `forEachReactive` under this ORIGINAL bar; the recorded absence above stands as the pre-admission history.

3. **`snapshotOf(vm)`** -- Recipe 7 hand-rolls a flat data snapshot on the data
   side (beside the reactive-side walk). Exposed by: r7. Served instead: a flat
   hand-written snapshot walk, stated cold and allocating in the recipe's own
   words (mirrors MobX `toJS`, which also allocates). No named consumer ->
   NOT admitted.
   ADMITTED 2026-08-30 (v1.3.0) under decisions/0013 -- `snapshotOf` ships as the named MobX-`toJS`-parity consumer (candidate 3 rides criterion (c)) and is itself the consumer that admits candidate 2; the recorded absence above stands as the pre-admission history.

4. **`costOfInstance(vm)`** -- `costOf` constructs its probe with NO constructor
   arguments (0008 D-8a; `llms.txt:142-143`), so a class whose real cost depends
   on constructor-time shape needs a measurement-twin shape class. Exposed by:
   the two-plane fleet (r9), which uses a measurement-twin to size Plane A. The
   demo already pays this cost. Served instead: the recipe builds the twin shape
   and calls `costOf` on it. No named consumer -> NOT admitted.
   ADMITTED 2026-08-30 (v1.4.0) under decisions/0013 criterion (b) -- the demo's shape-drift wall + HUD are the named consumers; the EntityShape twin's remaining job is capacityFor sizing only.

A FIFTH candidate -- fleet helpers (a sized-registry + eager-prealloc + throw
convenience over `capacityFor` + `createRegistry`) -- is anticipated by PLAN-S6
under the SAME bar. It is named here so its future consideration is on the record;
it is not admitted by this session and creates no obligation.

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
