# S0 spike plan (coder-ready)

Authoritative working spec for stage S0 of `@zakkster/lite-signal-decorators`.
Every API named here was verified against the installed `@zakkster/lite-signal@1.5.0`
on Node 26.3.1 (2026-08-26). The coder writes the eight spike artifacts and the
six decision-record skeletons exactly as specified; where a probe is subtle,
pseudocode is given. No package source (`SignalDecorators.js`) is written in S0.

## Verified ground truth (do not re-derive; build on it)

- **Node 26.3.1.** Native decorators DO NOT parse (`new Function("class C{@d accessor x=1}")`
  throws SyntaxError). So both emitters are required and both are confirmed working
  from inside the package dir:
  - TS: `npx tsc --target es2022 --module es2022 --experimentalDecorators false
    --moduleResolution bundler`.
  - Babel: `@babel/core` `transformFileSync` with presets
    `[['@babel/preset-typescript',{onlyRemoveTypeImports:true,allowDeclareFields:true}]]`
    and plugins `[['@babel/plugin-proposal-decorators',{version:'2023-11'}]]`.
  - Both produce identical member-decorator apply order for `accessor x; get d; m()`:
    `[["acc","accessor","x"],["get","getter","d"],["m","method","m"]]`.
- **`Symbol.dispose` is native** (typeof === "symbol"); **`Symbol.metadata` is `undefined`.**
  => the per-class plan store MUST default to a module `WeakMap<constructor, plan>`.
  `Symbol.metadata` is an OPTIONAL fast path, feature-detected, never assumed.
- **`createRoot(fn)`** (Signal.js:1645): nulls currentOwner + currentObserver + tracking,
  runs `fn`, restores in `finally`, returns `fn`'s value. It hands back NO disposer.
- **Owner = computed/effect node only** (signals are never owners). `getOwner()` returns
  `describeNode(currentOwner)` or `undefined`. `runWithOwner(handle, fn)` sets
  currentOwner to the node iff it carries FLAG_COMPUTED|FLAG_EFFECT, nulls
  observer+tracking, runs fn, restores.
- **R-A anchor pattern (confirmed viable)**:
  ```
  let anchor;
  createRoot(() => { effect(() => { anchor = getOwner(); }); });   // detached anchor effect
  runWithOwner(anchor, () => { /* create computedBox/effect children -> owned by anchor */ });
  dispose(anchorHandle);   // cascades to owned children
  ```
  Detached-by-default (DV-1) falls out because `createRoot` detaches the anchor from
  any enclosing computation. The spike must confirm the cascade empirically.
- **`stats()` returns 13 keys**: `signals, computeds, effects, activeLinks, pooledLinks,
  linkPoolCapacity, nodePoolCapacity, nodePoolPopulation, linkPoolPopulation,
  activeNodes, totalAllocations, totalDisposals, poolGrowths`.
- **SignalBox** = `{get,set,peek,update,subscribe}` on a shared prototype (own-keys empty).
  **ComputedBox** = `{get,peek,subscribe}` on a shared prototype. Monomorphic method ICs
  by construction -> accessor hot path `this[SLOT].get()` is one monomorphic proto call.
- **`dispose(api)`** accepts a signal/computed/effect handle; universal; idempotent;
  cross-registry calls are silent no-ops.

## FINDING F-0 (correction to BRIEF1, feeds decision 0002) -- the conservation signal

`nodePoolPopulation`/`linkPoolPopulation` are the counts of ReactiveNode/Link objects
PHYSICALLY CONSTRUCTED (`nodePool.length`). With the default eager prealloc they start
at the pool capacity (observed: 1024 nodes / 4096 links) and only ever GROW (via
`poolGrowths`); they never shrink on dispose because the pool reuses slots. Therefore
"pools return to their floor" as written in BRIEF1 sec.1/S1-A3 is the WRONG signal.
The correct zero-GC / conservation invariants are:

1. `activeNodes` returns to its pre-test baseline after teardown (live nodes freed).
2. `poolGrowths === 0` across the whole run after warmup (the workload fit the pool =>
   no runtime allocation of new slots => the zero-GC claim).
3. `totalAllocations - totalDisposals === activeNodes` holds in any quiescent moment
   (per the d.ts contract).

Every spike and (later) every torture scenario that asserts conservation uses THESE
three, not `nodePoolPopulation`. The coder must propagate this into the torture
harness helper in S1; here in S0 the ownership and poison spikes assert (1)+(2)+(3).
Record F-0 verbatim in `decisions/0002` and cross-link from `decisions/0000`.

---

## A. The eight spike artifacts

Common conventions:
- Each file is standalone: `node --expose-gc spikes/<f>.mjs`, exits 0 on success,
  non-zero on a failed assertion, and prints ONE evidence table (fixed column
  headers named below) plus a final `SPIKE <name>: PASS|FAIL` line.
- ASCII-only. Seeded xorshift32 where randomness is used; print the seed.
- A tiny shared helper `spikes/_util.mjs` provides: `xorshift32(seed)`,
  `median(nums)`, `stamp()` (returns `{node, arch, cpus, date, liteSignal}` reading
  `process`, `os`, and the installed peer version), and `table(rows)` (pads columns,
  ASCII box). Keep it dependency-free.

### A1. `spikes/emit/fixture.src.ts` (feeds probe.mjs, decision 0001)

One class family that exercises L1..L8 in a single compile. It imports nothing from
the package (the package has no source in S0); it imports a set of INSTRUMENTED
decorator functions from a sibling `spikes/emit/instrument.ts` that push
`[phase, kind, name, extra]` tuples into a module-level `LOG` array and expose it on
`globalThis.__EMIT_LOG`. Shape:

```ts
// instrument.ts (compiled alongside)
export const LOG: any[] = [];
export function mark(tag: string) {
  // returns a decorator usable on accessor | getter | method | class
  return function (value: any, ctx: any) {
    LOG.push(["apply", ctx.kind, String(ctx.name), tag]);           // L1/L7 order
    if (ctx.kind === "accessor") {
      return {
        init(v: any) { LOG.push(["init", "accessor", String(ctx.name), tag]); return v; }, // L2
        get() { return value.get.call(this); },
        set(x: any) { value.set.call(this, x); },
      };
    }
    if (ctx.addInitializer) ctx.addInitializer(function (this: any) {
      LOG.push(["addInit", ctx.kind, String(ctx.name), tag]);       // L3 (the D-01 trap)
    });
    if (ctx.metadata) LOG.push(["meta-present", ctx.kind, String(ctx.name), tag]); // L5
    return value;
  };
}
export function legacyShapeProbe(...args: any[]) {                   // L6 detector data
  globalThis.__LEGACY_ARGS = args.map(a => typeof a);
  return args[0];
}
```

The fixture class family:

```ts
import { mark } from "./instrument";
@mark("C-class")
class Base {
  @mark("A-x") accessor x = 1;                 // L2 init at field time
  @mark("A-y") accessor y = this.x + 1;        // L2 declaration-order: reads x's box (must exist)
  @mark("G-d") get d() { return this.x * 2; }  // getter
  @mark("M-m") m() { return this.x; }          // method: addInitializer fires early (L3)
  field = (globalThis.__FIELD_LOG ||= []).push(["field-init", "y-visible", this.y]); // L3 witness
  static @mark("S-s") accessor s = 0;          // static: separate lane (L8 note; not the throw test)
}
class Derived extends Base {                   // L4 new.target inside Base ctor
  @mark("D-x2") accessor x2 = 10;
}
class Plain extends Base {}                    // undecorated subclass (most-derived-rule input)
const sym = Symbol("k");
class Symbolic { @mark("SYM") accessor [sym] = 5; }  // symbol-named member
```

Notes for the coder:
- `y = this.x + 1` in a field initializer WITNESSES L2 (accessor init ran in
  declaration order so `x`'s box exists when `y` initializes) and, combined with the
  `field` initializer that reads `this.y`, WITNESSES L3 (the method `addInitializer`
  for `m` must appear in LOG BEFORE any field-init entry).
- Static accessor is included to observe emit behaviour but the STATIC-REJECTION
  runtime throw is a package-code concern (S1), not an S0 emit law. Keep it in the
  fixture only to record how each emitter orders static vs instance init.
- Do NOT rely on `Derived`/`Symbolic` doing anything at runtime beyond constructing
  once so their decorators apply.

### A2. `spikes/emit/regen.mjs` (feeds probe.mjs; also the S1 fixture pipeline seed)

- Compiles `fixture.src.ts` + `instrument.ts` twice:
  - TS -> `spikes/emit/ts-out/*.js` (spawn `tsc` via `node:child_process` with the
    flags in Ground Truth; `experimentalDecorators:false`).
  - Babel -> `spikes/emit/babel-out/*.mjs` (in-process `@babel/core`, config in
    Ground Truth). Run from inside the package dir so bare specifiers resolve.
- Writes `spikes/emit/hashes.json` = `{ ts: {file: sha256}, babel: {...} }`.
- Prints a table `emitter | files | totalBytes | ok`.
- Idempotent: safe to re-run; overwrites outputs. This is the ancestor of the S1
  `test/fixtures/regen.mjs`.

### A3. `spikes/emit/probe.mjs` (closes decision 0001; laws L1..L8)

- For each emitter: clear `globalThis.__EMIT_LOG` / `__FIELD_LOG` / `__LEGACY_ARGS`,
  dynamic-import that emitter's `fixture.js`, snapshot the logs, and evaluate each law
  (table in section B). Prints `law | fixture-construct | observed | expected | verdict`
  for BOTH emitters, then `SPIKE emit: PASS` iff every law's verdict is PASS on both
  (or is explicitly recorded as an accepted divergence -> that flips to a
  kill-criterion-3 note and the spike still exits non-zero unless the divergence is in
  the allowed set, which for S0 is empty: any L-law disagreement between emitters is a
  FAIL the coder surfaces, not silences).

### A4. `spikes/ownership.mjs` (closes decision 0002; Q1..Q5, R-A vs R-B, DV-1) -- detail in section D.

### A5. `spikes/storage-bench.mjs` (closes decision 0003; kill-criterion 1) -- detail in section C.

### A6. `spikes/manual-call.mjs` (closes decision 0004; D-04)

Question: when `@reactiveEffect`'s replacement method is called MANUALLY from inside a
foreign tracking scope, do its reads leak as the caller's dependencies, and what does
wrapping the manual path in `untrack` cost?

Design:
- Build a hand-wired stand-in for a decorated method: a function `body(self)` that
  reads two signalBoxes. Two variants of the exposed method: `raw = function(){ return
  body(this); }` and `wrapped = function(){ return untrack(() => body(this)); }`.
- LEAK exhibit: create an outer `effect(() => { instance.method(); sink++; })`. After
  it runs once, mutate one of the boxes `body` read. Count outer-effect re-runs.
  - `raw`: outer effect re-runs on the mutation (LEAK: caller adopted the reads).
  - `wrapped`: zero re-runs (reads untracked). Print both counts.
- COST: `measureOps` over N calls of `raw` vs `wrapped` OUTSIDE any tracking scope;
  report ns/op median and bytes/op (expect wrapped adds one closure-free `untrack`
  frame; `untrack` in 1.5.0 is a try/finally, allocation-free).
- Table: `variant | outer-reruns | ns/op | bytesPerOp`. Decision rule: choose `wrapped`
  unless it shows measurable bytes/op (> 0) or a >15% ns/op regression on the raw
  no-tracking path; record the chosen policy and numbers in 0004.

### A7. `spikes/poison.mjs` (feeds decision 0002; P3 poison-on-dispose, D-05)

Question: can a per-class prebuilt frozen poison handle make post-dispose reads/writes
throw at ZERO steady-state hot-path cost, with an allocation-free dispose swap?

Design:
- Prototype the layout for P=16 accessor slots on one class shape (symbol slots, S-A
  layout as the reference; the storage winner from A5 is applied in S1, not here).
- `install(instance)`: create 16 signalBoxes, write each into its slot.
- `POISON` per class: a single frozen object `{get(){throw new ReactiveDisposedError...},
  set(){throw...}}` built ONCE at "decoration" time (here: once per run), shared by all
  slots and all instances of the class. `disposeReactive(instance)`: for each slot,
  `dispose(instance[slot])` then `instance[slot] = POISON`. No per-call allocation
  (no new closures, no arrays) -- verify with `measureOps` on the dispose loop:
  bytes/op must be 0.
- Hot-path proof: the live read path is `instance[slot].get()`. Show it is
  byte-identical whether or not poison support exists, i.e. the read site has NO
  branch for disposed-ness (the throw comes from the swapped handle, not a guard).
  Demonstrate by `measureOps` on the live get path with maxMajor 0 and comparing the
  function `.toString()` of the live getter with and without the poison mechanism
  compiled in (they are the same source).
- Post-dispose: assert every slot get AND set throws `ReactiveDisposedError` whose
  message names the class + property.
- Conservation: after install+dispose of 1000 instances, assert F-0 invariants
  (activeNodes back to baseline, poolGrowths 0).
- Table: `phase | activeNodes | poolGrowths | bytesPerOp | throws?`.

### A8. `spikes/buildless.mjs` (closes decision 0005)

Question: can `defineReactive(Class, spec)` drive the SAME register/replace/wire
functions the decorator entries use, with zero duplicated wiring logic?

Design:
- Write the wiring as three standalone functions the spike defines locally (a
  throwaway model of the S1 shared core): `registerSignal(plan, key, opts)`,
  `installAccessors(proto, plan)`, `wireInstance(instance, plan)` (does the R-A anchor +
  runWithOwner children + returns the anchor handle).
- Path 1 (decorator model): call the register fns from mock decorator contexts
  (mirrors S1's protocol test path -- no transpiler needed).
- Path 2 (buildless): `defineReactive(Class, {signals:['a','b'], deriveds:{sum:self=>self.a+self.b}, effects:[...]})`
  calls the IDENTICAL three functions.
- Assert both paths produce instances with identical behaviour: same values, same
  effect fire counts, same `stats()` deltas, same dispose conservation.
- Prove the sharing structurally: both paths reference the same function objects
  (assert `registerSignal` is `===` across the two code paths -- they are the same
  module binding). Table: `path | valuesMatch | fireCountsMatch | statsDeltaMatch |
  sameFnIdentity`.

---

## B. The eight emit laws (probe.mjs)

| Law | Fixture construct | Observable (in `__EMIT_LOG`/`__FIELD_LOG`) | Expected |
|-----|-------------------|--------------------------------------------|----------|
| L1 member-decorator apply order = source order; class applies last | Base with `x, y, d, m` then `@mark("C-class")` | sequence of `["apply", kind, name]` entries | x, y, d, m in source order; `C-class` apply appears AFTER all member applies |
| L2 accessor `init` runs at field-def time, in declaration order | `x`, `y=this.x+1` | `["init","accessor","x"]` before `["init","accessor","y"]`; construction did not throw | x-init before y-init; `y === 2` |
| L3 method/getter `addInitializer` runs BEFORE field initializers (the D-01 trap) | `m()` + `field=...push(...)` | first `["addInit","method","m"]` index < first `["field-init",...]` index | addInit precedes field-init on BOTH emitters |
| L4 `new.target` inside base ctor = most-derived ctor | `new Derived()` | a ctor-probe (add `constructor(){ (globalThis.__NT ||= []).push(new.target?.name) }` to Base) | `__NT` last entry === "Derived" |
| L5 `Symbol.metadata` presence + inheritance | `ctx.metadata` reads in `mark` | `["meta-present",...]` count per emitter; whether `Derived[Symbol.metadata]` prototype-inherits Base's | record actual per emitter (Node 26 host `Symbol.metadata` is undefined, but emitters may polyfill a context.metadata object) |
| L6 legacy-vs-standard call shape | a separate 2-line module compiled with `experimentalDecorators:true` calling `legacyShapeProbe` on a property | `globalThis.__LEGACY_ARGS` typeof tuple | standard: `(value,{kind,name,...})`; legacy: `(target, key, descriptor)` -> the detection predicate is "2nd arg has a `.kind` string" |
| L7 factory decorators receive args before application | `@mark("A-x")` (mark is a factory) | apply entries carry the `tag` passed to the factory | tags present and correct on each apply |
| L8 replacement-class identity after class decorator | `@mark("C-class")` returns value unchanged; add a variant `@replaceClass` that returns a subclass | `instanceof`, `.name` of an instance | with identity-return: `new Base() instanceof Base` true; with replacement: documented behaviour recorded |

L6 needs a SECOND tiny fixture compiled with `experimentalDecorators:true` (TS) to
capture the legacy signature -- the detection predicate that S1's package uses to
throw on legacy emit. Babel legacy mode (`version:'legacy'`) is the Babel counterpart;
compile one of each and record both shapes.

---

## C. storage-bench.mjs (kill-criterion 1)

Goal: pick the accessor slot layout on measured read/write cost vs the raw
`signalBox.get()` baseline, and record whether the winner clears the 2.0x line.

Layouts (all four share one hand-written class shape with P=4 reactive props;
NO decorator syntax -- model each layout by hand so the measurement is about STORAGE,
not emit):
- **S-A symbol slot**: one `const SLOT_x = Symbol("x")` per prop; box stored as
  `this[SLOT_x]`; getter `return this[SLOT_x].get()`.
- **S-B accessor backing slot**: emulate the standard-decorator accessor by storing the
  box in a per-prop private field via a closure-captured WeakMap-free own property with
  a fixed string key created at class-def time (`this.#x` can't be modeled without
  real private fields; use a fixed non-enumerable own data property whose key is a
  module-unique string constant, set in the constructor -- this matches what the
  accessor `init` return + generated get/set compile to). Getter `return this.__b_x.get()`.
- **S-C dict control**: `this[SIGNALS]["x"].get()` where `SIGNALS=Symbol()` holds a
  plain object dictionary. This is the DRAFT layout, benchmarked to record why it loses.
- **RAW baseline**: a bare module-level `const bx = signalBox(0)`; `bx.get()` /
  `bx.set(v)` with no instance indirection at all. This is the number the 2.0x line is
  measured against.

Harness (mirror `LiteSignal/bench/torture/README.md`):
- Anti-DCE sink: `const SINK = new Float64Array(4096)` on `globalThis`; write
  `SINK[i & 4095] = value` inside every measured body; after each timed loop sum the
  sink and assert it equals a precomputed expected sum for the fixed drive sequence;
  a drift tags the run invalid (`sink=x`) and fails the spike.
- WARMUP: 2 passes building the graph + driving 20_000 before timing.
- Drive: one `drive(i)` per layout; READ scenario drives `sink = obj.getProp(i & 3)`;
  WRITE scenario drives `obj.setProp(i & 3, i)`. Same sequence for all four.
- TIMING: median of 5 inner runs of 100_000 drives; report median ns/op and min.
- FLEET variant: allocate 10_000 instances once (outside timing); READ drives
  `instances[i % 10000].getProp(i & 3)` to stress cross-instance IC shape (a class-only
  hazard: do per-instance shapes stay monomorphic at fleet scale?).
- Also run each layout body under `measureOps` to confirm bytes/op === 0 and
  `maxMajor:0` (a layout that allocates on read is disqualified regardless of ns).
- Provenance stamp on the printed table (node/arch/cpu/date/liteSignal version).

Tables:
- `layout | read ns/op (1) | read ns/op (10k) | write ns/op | bytes/op | maxMajor | sink`
- `layout | read x raw | verdict(<=2.0x?)`

Decision rule (write into 0003): pick the layout with the lowest read ns/op that also
has bytes/op 0 and maxMajor 0. If its read median > 2.0x the RAW baseline median,
kill-criterion 1 fires NOW: 0003 records the number and the positioning consequence
(README leads with the tax) -- do not soften. If S-C wins on speed it still loses on
the megamorphic-at-fleet hazard; report the 10k column that exposes it.

---

## D. ownership.mjs (R-A vs R-B, DV-1, Q1..Q5)

Read helpers: snapshot `stats()` into `{activeNodes, poolGrowths, totalAllocations,
totalDisposals, activeLinks}` before/after each probe.

- **Q1 -- is signalBox creation adopted by an enclosing computation?**
  ```
  let inside;
  const outer = effect(() => { inside = signalBox(0); });   // create a box inside an effect body
  // mutate nothing; dispose the OUTER effect:
  dispose(outer);
  // now read inside.peek() and check stats: was `inside`'s node freed by the cascade?
  ```
  Observable: `activeNodes` delta after `dispose(outer)` -- if it drops by 2 (the effect
  + the box) the box was adopted; if by 1 (only the effect) the box is NOT owned.
  Print the verdict. CONSEQUENCE: if adopted, the `@reactive` accessor `init` must wrap
  `signalBox(...)` in `createRoot(() => signalBox(...))` (or `runWithOwner(undefined,...)`)
  to force a rooted, non-adopted box. If not adopted, bare creation is safe. Record the
  answer; it directly sets wiring step 2 in decision 0001/0002.

- **Q2 -- does `dispose(anchor)` cascade owned computeds/effects exactly once,
  idempotently?**
  Build the R-A anchor; under `runWithOwner(anchor, ...)` create D computedBoxes and E
  effects (give each effect an onCleanup that increments a per-instance counter). Record
  `activeNodes` before/after `dispose(anchorHandle)`; assert it returns to the
  pre-anchor baseline (anchor + D + E all freed) and each effect's cleanup ran exactly
  once. Call `dispose(anchorHandle)` again; assert zero further cleanup calls and zero
  stats change (idempotent). This is the R-A viability gate.

- **Q3 -- per-instance cost grid, R-A vs R-B.**
  For `(P,D,E)` in `(0,0,0),(1,0,0),(8,4,2),(16,8,4)`:
  - R-A build: anchor effect + P signalBoxes (created outside the anchor, per Q1's
    verdict) + D computedBoxes and E effects created under `runWithOwner(anchor)`.
  - R-B build: no anchor; P signalBoxes + D computedBoxes (via `createRoot`) + E effects
    (via `createRoot`), handles stored in a flat array; dispose walks the array.
  Record `activeNodes` delta (the true per-instance node cost) and `activeLinks` delta
  for each. Table: `P,D,E | R-A nodes | R-A links | R-B nodes | R-B links`. R-A costs
  exactly +1 node (the anchor) over R-B; the decision weighs that one node against R-B's
  loss of a single-handle cascade + `rootOf` degrading to enumeration.

- **Q4 -- the DV-1 hazard exhibit.**
  ADOPT model: build a VM's children WITHOUT the createRoot detachment, inside a live
  parent effect; store nothing that pins them. Re-run the parent effect (mutate its dep).
  Show the children were cascade-disposed by the parent's re-run (the VM's effects stop
  firing / `activeNodes` dropped) -- the hazard. DETACH model (R-A with createRoot):
  same scenario; show the VM survives the parent re-run untouched. Print both outcomes
  as the evidence that detached-by-default is correct. This is the runnable exhibit
  decision 0002 (DV-1) cites.

- **Q5 -- does `dispose()` return box nodes to the pool?**
  Create 1000 signalBoxes + 1000 computedBoxes, snapshot stats, dispose all, snapshot
  again: assert `activeNodes` returns to baseline, `totalDisposals - totalAllocations`
  reconciles, `poolGrowths === 0`. This is the pooled-teardown proof underpinning P2/D-08.

Final table + `SPIKE ownership: PASS` iff Q2 idempotent-cascade holds, Q4 detach model
survives, Q5 conservation holds. Record R-A vs R-B recommendation with the Q3 grid.

---

## E. Decision-record skeletons (`decisions/0000..0005`)

Each file: `# NNNN -- title`, then `Status`, `Context`, `Options` (with the spike's
evidence table pasted), `Decision`, `Consequences`, `Evidence` (spike filename +
how to re-run). The coder writes the skeletons with the tables filled from the actual
spike runs (not placeholders).

- **0000-field-survey.md** -- graduate `research/field-survey-2026-08-25.md` verbatim +
  any re-verification; the positioning facts + the F-0 finding cross-link.
- **0001-wiring-site.md** -- AD-1 single wiring site; the L1..L8 table from probe.mjs;
  the most-derived rule (from L4 + the Plain/Derived fixture); the legacy-emit
  detection predicate (from L6). Decision: member decorators only register+replace;
  no member addInitializer creates nodes.
- **0002-ownership-and-lifecycle.md** -- Q1..Q5 tables; R-A vs R-B choice with the Q3
  grid; DV-1 verdict (detached-by-default) with the Q4 exhibit; F-0 conservation
  correction; the poison layout + dispose order from poison.mjs; the exact dispose
  sequence the S1 class plan will follow.
- **0003-storage.md** -- the two storage tables; the winner; the 2.0x verdict
  (kill-criterion 1) stated as a number; the fleet megamorphism note.
- **0004-effects.md** -- manual-call policy (wrapped vs raw) + numbers; scheduler
  pass-through shape (`effect(fn,{scheduler})` confirmed in the d.ts).
- **0005-buildless.md** -- the buildless parity table; the shared-function-identity
  proof; the `defineReactive` spec shape.

Also write/update `spikes/SPIKES.md`: a one-screen summary mapping each kill criterion
(sec.0 of ROADMAP) to its measured baseline, and a PASS/FAIL per spike.

---

## F. DONE-WHEN (maps S0-A1..A5)

- **S0-A1** every spike runs via `node --expose-gc spikes/<f>.mjs`, exits 0, prints its
  table. (Proof: `npm run spikes` exits 0.)
- **S0-A2** L1..L8 hold identically on both emitters, or a divergence is recorded in
  0001 with the fail-closed consequence. (Proof: probe.mjs table, both emitters PASS.)
- **S0-A3** Q1..Q5 each answered with a reproducible exhibit; nothing left "assumed".
  (Proof: ownership.mjs table + 0002.)
- **S0-A4** storage winner read within 2.0x of raw `signalBox.get()`, or the
  kill-criterion-1 consequence recorded in 0003 now. (Proof: storage-bench.mjs verdict
  table.)
- **S0-A5** decisions 0000..0005 exist, each stating OPTIONS / NUMBERS / CHOICE /
  CONSEQUENCES; none defers its choice. (Proof: file review.)

DONE WHEN: `spikes/SPIKES.md` maps every kill criterion to a measured baseline and the
S1 design is fully determined by recorded numbers.
