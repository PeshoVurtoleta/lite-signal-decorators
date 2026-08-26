# 0000 -- field survey (positioning facts)

Status: ACCEPTED (S0). Superseded only by a later dated re-verification.

## Context

The package's identity (ROADMAP.md sec. 0, five pillars) rests on claims about
what every competing reactive class-decorator library does and does not do. If
any of those claims is wrong, a pillar is not whitespace and the package has no
reason to exist. This record freezes the verified competitive facts as of
2026-08-25/26 so every later positioning statement (README, llms.txt,
Publications) cites a dated source rather than a memory.

## Decision

Adopt `research/field-survey-2026-08-25.md` verbatim as the positioning
evidence base. Its composite-gap finding stands: the field competes on
ergonomics and framework integration; nobody competes on lifecycle rigor
(P2/P3), memory determinism (P1/P4), or published class-shaped numbers (P5).
Every incumbent fails at least three of the five pillars; most fail all five.

## The load-bearing facts (summary; full record + citations in research/)

- **proposal-decorators is Stage 3, no native engine.** Re-verified on this
  machine: Node 26.3.1 does not parse `class C { @d accessor x = 1 }`
  (SyntaxError). TS 5 standard emit and Babel `plugin-proposal-decorators`
  `2023-11` are the only real-world emitters; both confirmed working here.
- **proposal-signals is Stage 1**; `signal-polyfill` unreleased since Jan 2025.
- **explicit resource management is native now** (Node 24+, all major
  browsers): `Symbol.dispose` is a live symbol on this Node
  (`typeof Symbol.dispose === "symbol"`). `Symbol.metadata` is `undefined` on
  Node 26 -- the per-class plan store defaults to a WeakMap, not metadata.
- **MobX 7.0.3**: Stage-3 `@observable accessor` (legacy users stuck on 6.x);
  per instance an ObservableObjectAdministration + values Map + keysAtom +
  one ObservableValue atom per property; `Symbol.dispose` only on reaction
  disposers, never on instances; per-property atoms reclaimed only by GC.
- **signal-utils 0.21.1**: `@signal` allocates one `Signal.State` per property
  per instance; NO disposal API; ~20 months stale; "not for production."
- **classy-solid / @reactively/decorate / Ember @tracked / Lit / Angular /
  Vue**: each allocates >= 1 object per property per instance; none is
  zero-GC-gated; none makes decorated INSTANCES disposable; none publishes a
  class-shaped benchmark. Lit's own docs list a signal-backed `@property()` as
  planned-but-missing.
- **No class-based reactivity benchmark exists anywhere** (js-reactivity-
  benchmark is entirely function-shaped).

## Cross-links

- FINDING F-0 (in `0002-ownership-and-lifecycle.md`): the correct conservation
  signal is `activeNodes` + `poolGrowths` + the alloc/disposal reconciliation,
  NOT `nodePoolPopulation` (which is a physically-constructed-slot ledger that
  only grows). This is what makes the P1 "zero-GC" claim measurable and honest.

## Evidence

- `research/field-survey-2026-08-25.md` (dense record, all citations, flagged
  uncertainties).
- Re-verification commands run 2026-08-26: native-decorator parse test;
  `typeof Symbol.dispose`/`Symbol.metadata`; TS + Babel emit smoke.
