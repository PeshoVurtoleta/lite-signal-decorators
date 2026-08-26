// bench/lib/guards.mjs -- validity guards. Any failure => INVALID RUN + nonzero exit.
//
// ORIGIN: ported from ../../LiteSignal/bench/lib/guards.mjs (bench protocol v3).
// Semantics preserved. A guard is only worth having if it BLOCKS: every check
// contributes to a single verdict and the harness sets process.exitCode on
// failure. Only this header comment is new.
//
// Guard families:
//   1. deadSink        -- an effect/drive never wrote in the timed loop.
//   2. checksum        -- the anti-DCE sink sum must match the scenario's
//                         analytic expected value (per-lane, engine-independent).
//   3. expected        -- hard {sum, count} vectors for a shape.
// Plus an AGGREGATOR guard: refuse to merge files whose stamps are inconsistent.

export function makeVerdict() {
    return { failures: [], ok: true };
}

function fail(v, msg) {
    v.failures.push(msg);
    v.ok = false;
}

// --- per-row checks --------------------------------------------------------------

export function checkDeadSink(v, label, sinkValue) {
    if (!(sinkValue !== 0)) fail(v, "DEAD SINK: " + label + " finished with sink=0 (drive never wrote; timing measures nothing)");
}

// The core anti-DCE contract: the summed sink after a run MUST equal the
// scenario's analytic expected value. A "faster" adapter that writes less is
// caught here on the first run.
export function checkChecksum(v, label, got, expected) {
    if (got !== expected) {
        fail(v, "CHECKSUM MISMATCH: " + label + ": sink=" + got + " expected=" + expected + " (adapter did unequal work; DCE or a skipped write)");
    }
}

export function checkExpected(v, scenario, framework, got, expected) {
    if (expected == null) return;
    if (expected.sum != null && got.sum !== expected.sum) {
        fail(v, "EXPECTED SUM: " + scenario + " " + framework + ": sum=" + got.sum + " expected=" + expected.sum);
    }
    if (expected.count != null && got.count !== expected.count) {
        fail(v, "EXPECTED COUNT: " + scenario + " " + framework + ": count=" + got.count + " expected=" + expected.count);
    }
}

// --- emit the verdict + set exit code --------------------------------------------

export function reportVerdict(v) {
    if (v.ok) return true;
    const bar = "!".repeat(98);
    console.log("");
    console.log(bar);
    console.log("INVALID RUN -- " + v.failures.length + " guard failure(s). These numbers are NOT publishable.");
    for (const f of v.failures) console.log("    ! " + f);
    console.log("See bench/lib/guards.mjs. Do not publish.");
    console.log(bar);
    process.exitCode = 1;
    return false;
}

// --- aggregator-side stamp consistency -------------------------------------------

// files: [{ path, stamp }]. Returns { ok, reason, engineSha, protocol }.
export function assertStampsConsistent(files) {
    if (files.length === 0) return { ok: false, reason: "no rep files found" };
    const missing = files.filter((f) => !f.stamp);
    if (missing.length) {
        return { ok: false, reason: missing.length + " file(s) have no #STAMP line: " + missing.map((f) => f.path).join(", ") };
    }
    const engineShas = new Set(files.map((f) => f.stamp.engineSha256));
    if (engineShas.size > 1) {
        return { ok: false, reason: "mixed engine hashes across files (" + engineShas.size + " distinct) -- refusing to merge" };
    }
    const protocols = new Set(files.map((f) => f.stamp.protocol));
    if (protocols.size > 1) {
        return { ok: false, reason: "mixed protocols across files (" + [...protocols].join(", ") + ") -- cross-protocol merge is forbidden" };
    }
    if ([...protocols][0] === "shared-process-smoke") {
        return { ok: false, reason: "these files were captured under shared-process-smoke; that protocol is never publishable" };
    }
    const hosts = new Set(files.map((f) => f.stamp.cpu + "|" + f.stamp.node + "|" + f.stamp.arch));
    if (hosts.size > 1) {
        return { ok: false, reason: "mixed hosts across files (" + hosts.size + " distinct) -- cross-host comparison reintroduces contamination" };
    }
    return { ok: true, engineSha: [...engineShas][0], protocol: [...protocols][0], host: [...hosts][0] };
}

// Verify the claimed rep count matches files on disk.
export function assertRepCount(files, claimedReps, engineKey) {
    if (files.length !== claimedReps) {
        return { ok: false, reason: engineKey + ": claimed reps=" + claimedReps + " but " + files.length + " file(s) on disk" };
    }
    return { ok: true };
}
