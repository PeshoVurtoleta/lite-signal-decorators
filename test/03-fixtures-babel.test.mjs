// test/03-fixtures-babel.test.mjs -- the behavior suite over the Babel `2023-11`
// emit (S1-A1 path 3), plus the named rejection of the legacy and static Babel
// emits. Identical body to 02, different compiler -- cross-validating that both
// standard emitters drive the package the same way. Run `npm run fixtures` if
// these imports fail to resolve. ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as classes from "./fixtures/babel-out/fixture.src.js";
import { behaviorSuite } from "./shared/behavior-suite.mjs";

test("behavior suite over the Babel 2023-11 emit", (t) => {
    behaviorSuite(t, classes, "babel");
});

test("Babel legacy emit import rejects with the named legacy error", async () => {
    await assert.rejects(
        () => import("./fixtures/babel-legacy-out/legacy.src.js"),
        (e) => e instanceof TypeError && /legacy decorator call/.test(e.message),
    );
});

test("Babel static-accessor emit import rejects with the named static error", async () => {
    await assert.rejects(
        () => import("./fixtures/babel-out/static.src.js"),
        (e) => e instanceof TypeError && /cannot decorate the static member/.test(e.message),
    );
});
