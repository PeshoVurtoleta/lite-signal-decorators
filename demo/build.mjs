// demo/build.mjs -- esbuild driver for the fleet-playground demo.
//
//   node demo/build.mjs            build browser bundle + node core, rewrite hash
//   node demo/build.mjs --check    rebuild, compare against the committed
//                                  bundle.sha256, exit non-zero on mismatch
//
// Byte-reproducibility is an assertion (S5b-A3): esbuild is pinned to an EXACT
// version in package.json (no caret), so two builds of the same source yield a
// byte-identical demo/bundle.js and therefore an identical sha256. The browser
// bundle is self-contained (SignalDecorators.js + the lite-signal peer +
// lite-watch-ex all bundled in). The node core keeps the @zakkster peer packages
// EXTERNAL so the headless lanes share ONE lite-signal instance (a single
// default registry) with lite-leak / lite-gc-profiler -- the fleet's custom
// registry stats stay honest.
//
// lite-layout-profiler is a DEV instrument (demo-audit skill): it is never
// bundled -- the #profile dynamic import lives inline in fleet-playground.html
// and stays dormant unless the hash flag is set.
//
// ASCII-only.

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const BROWSER_ENTRY = join(HERE, "src", "ui", "app.ts");
const CORE_ENTRY = join(HERE, "src", "core", "index.ts");
const BUNDLE_OUT = join(HERE, "bundle.js");
const HASH_OUT = join(HERE, "bundle.sha256");
const CORE_OUT = join(HERE, "dist", "core.node.mjs");

// Stage-3 decorators: experimentalDecorators MUST be false; ES2022 gives the
// standard class-field semantics the accessor canon expects.
const TSCONFIG_RAW = {
    compilerOptions: {
        experimentalDecorators: false,
        useDefineForClassFields: true,
        target: "es2022",
    },
};

function sha256(buf) {
    return createHash("sha256").update(buf).digest("hex");
}

/** Build the self-contained browser bundle. Returns the output bytes (Buffer),
 *  written by the caller so --check can compare without writing. */
export async function buildBrowserBytes() {
    const result = await build({
        entryPoints: [BROWSER_ENTRY],
        bundle: true,
        format: "esm",
        platform: "browser",
        target: ["es2022"],
        tsconfigRaw: TSCONFIG_RAW,
        minify: true,
        legalComments: "none",
        // The layout profiler is a dev-only dynamic import (kept out of the
        // committed bundle); it lives inline in the HTML, not here, but list it
        // external as belt-and-suspenders so a stray import never bundles it.
        external: ["@zakkster/lite-layout-profiler"],
        write: false,
    });
    return Buffer.from(result.outputFiles[0].contents);
}

/** Build the DOM-free node core for the headless lanes. Idempotent -- both the
 *  build script and each proof lane call it, so a lane is self-sufficient. */
export async function buildNodeCore() {
    await mkdir(dirname(CORE_OUT), { recursive: true });
    await build({
        entryPoints: [CORE_ENTRY],
        bundle: true,
        format: "esm",
        platform: "node",
        target: ["node18"],
        tsconfigRaw: TSCONFIG_RAW,
        // Peer packages stay external -> one lite-signal singleton across the
        // lane, the core, and lite-leak / lite-gc-profiler.
        external: ["@zakkster/lite-signal", "@zakkster/lite-watch-ex"],
        outfile: CORE_OUT,
    });
    return CORE_OUT;
}

async function main() {
    const check = process.argv.includes("--check");
    const bytes = await buildBrowserBytes();
    const hash = sha256(bytes);
    await buildNodeCore();

    if (check) {
        let committedHash = "";
        try {
            committedHash = (await readFile(HASH_OUT, "utf8")).trim();
        } catch {
            process.stderr.write("demo:check FAIL -- bundle.sha256 missing; run demo:build\n");
            process.exit(1);
        }
        let committedBytes = null;
        try {
            committedBytes = await readFile(BUNDLE_OUT);
        } catch {
            process.stderr.write("demo:check FAIL -- bundle.js missing; run demo:build\n");
            process.exit(1);
        }
        const committedActual = sha256(committedBytes);
        if (hash !== committedHash || committedActual !== committedHash) {
            process.stderr.write(
                "demo:check FAIL -- bundle drift\n" +
                "  rebuilt sha256   = " + hash + "\n" +
                "  recorded sha256  = " + committedHash + "\n" +
                "  committed sha256 = " + committedActual + "\n",
            );
            process.exit(1);
        }
        process.stdout.write("demo:check OK -- bundle.js byte-identical, sha256 " + hash + "\n");
        return;
    }

    await writeFile(BUNDLE_OUT, bytes);
    await writeFile(HASH_OUT, hash + "\n");
    process.stdout.write(
        "demo:build OK -- bundle.js " + bytes.length + " bytes, sha256 " + hash + "\n" +
        "               core.node.mjs rebuilt (DOM-free lane target)\n",
    );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    main().catch((err) => {
        process.stderr.write("demo build error: " + (err && err.message ? err.message : String(err)) + "\n");
        process.exit(1);
    });
}
