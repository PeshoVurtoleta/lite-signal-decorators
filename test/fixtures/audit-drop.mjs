// test/fixtures/audit-drop.mjs -- child-process fixture for the auditReactive
// finalization catch (13-labels-audit.test.mjs, PD-24).
//
// Spawned as `node --expose-gc audit-drop.mjs <mode>`:
//   drop     -- audit ON; construct a per-scope-registry instance, drop it
//               WITHOUT disposeReactive, force gc + a settle loop. The parent
//               asserts the audit console.error line (class + shape) appears.
//   disposed -- audit ON; construct then disposeReactive, then drop. The parent
//               asserts NO audit line names this instance.
//   off      -- audit OFF; construct + drop without dispose. No Finalization
//               Registry exists, so the parent asserts silence.
//
// The instance lives on its OWN registry so instance + graph are collectable
// together (D-8c reach note). All audit output goes to stderr via console.error.
//
// ASCII-only.

import * as pkg from "../../SignalDecorators.js";
import { createRegistry } from "@zakkster/lite-signal";

const mode = process.argv[2] || "drop";

if (mode !== "off") pkg.auditReactive(true);

// A per-scope registry: dropping the instance drops the whole graph with it.
function makeAndDrop() {
    const reg = createRegistry({ maxNodes: 64 });
    const Dropped = pkg.defineReactive(class Dropped {}, {
        signals: { x: 1 },
        deriveds: { dbl: (self) => self.x * 2 },
        effects: { eff: (self) => { void self.x; } },
        host: { registry: reg },
    });
    let vm = new Dropped();
    if (mode === "disposed") pkg.disposeReactive(vm);
    // Drop every strong reference: the instance, the class, and the registry
    // all go out of scope when this frame returns.
    vm = null;
}

makeAndDrop();

// Force finalization: repeated gc with settle ticks so the FinalizationRegistry
// callback has room to run before the process exits.
for (let i = 0; i < 30; i++) {
    globalThis.gc?.();
    await new Promise((r) => setTimeout(r, 15));
}

console.error("AUDIT_FIXTURE_DONE " + mode);
