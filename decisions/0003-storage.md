# 0003 -- accessor storage layout (kill-criterion 1)

Status: ACCEPTED (S0), rewritten 2026-08-26 on cold-process-aggregated numbers
after QA + reviewer rejected the original single-process verdict as
non-reproducible. Evidence: `spikes/storage-bench.mjs` (K=10 cold child
processes, inner median-of-5; run `node --expose-gc spikes/storage-bench.mjs`,
exits 0). Rig: Node v26.3.1, arm64, 12x Apple M4 Pro, lite-signal 1.5.0.

## Context

The accessor get/set bodies are the package's hot path. The DRAFT stored boxes
in a per-instance string-keyed dictionary (`this[SIGNALS][key]`), megamorphic
and IC-hostile (D-03). Kill-criterion 1 (ROADMAP sec.0): if the decorated read
cannot stay within ~2.0x of a raw `signalBox.get()` median, the package still
ships but the README leads with that number.

## Methodology correction (why this record was rewritten)

The first cut measured median-of-5 INNER in a SINGLE process and recorded a
one-off S-B result (1.711x, "clears with margin"). QA (9 runs) and reviewer
(8 runs) proved that non-reproducible: process-to-process variance (the RAW
baseline alone swings ~4.0-4.8 ns/op between launches) dwarfs the ~0.4 ns gap
between layouts. The bench now spawns K=10 cold child processes and computes
every ratio from aggregated min-of-medians / median-of-medians with the spread
reported. The anti-DCE sink (verified sound by the reviewer: real globalThis
Float64Array, masked index, checksum vs a precomputed expected sum that drifts
on any elided write) is unchanged.

## The honest baseline (the key finding)

The original comparison was against a MODULE-CONST signalBox -- a floor no one
writes in a class. The real-world alternative to a decorated accessor is a
hand-written instance field `this.bx.get()` (RAW-FIELD). Measured aggregated:

| layout | read x RAW (module-const) | read x RAW-FIELD (instance field) | fleet-10k | allocBytes/op | maxMajor |
|--------|---------------------------|-----------------------------------|-----------|---------------|----------|
| RAW (module-const) | 1.000x | 0.464x | 5.22 | 0.149 | 0 |
| RAW-FIELD (instance field) | 2.13x | 1.000x | 6.57 | 0.101 | 0 |
| S-A symbol | 2.12x | 0.997x | 7.81 | 0.096 | 0 |
| S-B backing | 2.13x | 1.00x | 8.25 | 0.066 | 0 |
| S-C dict | 2.19x | 1.03x | 9.93 | 0.027 | 0 |

**RAW-FIELD is itself 2.13x the module-const.** So the ~2.1x every instance
layout shows vs module-const is the `signalBox` INSTANCE-INDIRECTION cost that
ANY per-instance reactive property pays -- decorated or hand-written -- NOT a
decorator/storage tax. Against the honest instance-field baseline the decorated
accessor is ~1.0x.

Noise-floor alloc gate: a known-zero-alloc control body measures 0.589 B/op; every
layout has `gc.major === 0` and allocBytes/op <= floor -> allocation-free within
measurement resolution. No bare "=== 0" is claimed (measureOps has no clean
per-op field; ~0.25-0.6 B/op is sampling noise).

## Decision

**S-A symbol slot.** Accessor `init` creates the box under a unique per-property
`Symbol` on the instance and the get/set are `this[SLOT].get()` /
`this[SLOT].set(v)`.

The choice is NOT made on read ns: S-A and S-B are statistically TIED (the
aggregated winner swapped between S-A and S-B across independent K=10 runs --
coder run S-A 11.07, integrator confirmation run S-B 11.28; the gap is ~1%,
inside the spread). It is made on three non-noise criteria:

1. **Consistency with the validated poison/dispose mechanism.** 0002's
   poison-on-dispose is `instance[SLOT] = POISON` -- direct symbol-slot
   assignment, already proven (post-dispose get/set throw, 0-byte swap,
   unbranched read). S-B would require poisoning THROUGH the emitter's private
   backing accessor (`target.set.call(this, POISON)`), which is unvalidated and
   emitter-dependent.
2. **Emitter-independence.** S-A stores the box in a slot WE own; the emitter's
   generated private backing field is unused. S-B rides on the emitter's
   private-field codegen, which L5 (0001) already showed differs between TS and
   Babel. S-A is robust to that drift by construction.
3. **Fleet behaviour.** S-A's fleet-10k read (7.81) beat S-B's (8.25) and both
   beat S-C (9.93). S-A does not degrade at scale.

## Kill-criterion 1 verdict

**CLEARED WITH MARGIN.** Judged against the honest instance-field baseline (the
real-world alternative in a class), the decorated accessor read tax is ~1.01x
median, worst-case ~1.08x cold-vs-cold -- essentially zero overhead over a
hand-written `this.box.get()`. The ~2.1x vs module-const is the signalBox
indirection every reactive property pays and is reported as informational, not
hidden. The package does NOT enter the "lead with the bad number or don't ship"
branch; AD-6 honesty tiering still publishes all three numbers.

## Notes

- **Fleet megamorphism (reproduced every run):** S-C dict is the ONLY layout
  whose 10k-fleet read worsens relative to its single-instance read (9.93 is
  materially worse than S-A 7.81 / S-B 8.25) -- cross-instance IC-shape
  degradation, a hazard only a class-shaped benchmark exposes, and the measured
  justification for rejecting the DRAFT's dict. Seeds the S3 FLEET-READ scenario.
- Writes are ~2.5-3x module-const across instance layouts (box `.set`
  propagation dominates the slot lookup); inherent to a reactive box, reported.

## Consequences

- S1 accessor get/set bodies are `this[SLOT].get()` / `this[SLOT].set(v)` (S-A),
  reviewer-diffed byte-for-byte against this winner. This is already what 0002's
  poison spike used, so storage, poison, and dispose share ONE symbol-slot
  mechanism.
- README leads with the honest number: "a decorated reactive property costs
  ~1.0x a hand-written instance-field signal read; both are ~2x a module-level
  signal because that is the cost of per-instance storage, paid either way."
- S3 bench FLEET-READ includes an S-C-style dict as a losing reference to
  reproduce the megamorphism result in public.

## Evidence

`spikes/storage-bench.mjs` (K=10 cold-process aggregation, both baselines, noise
floor, fleet column). Verdict CLEARED WITH MARGIN reproduced on an independent
integrator run; the S-A/S-B ns tie (winner swap) is itself the evidence the
choice must rest on the non-noise criteria above.
