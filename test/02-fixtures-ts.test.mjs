// test/02-fixtures-ts.test.mjs -- the behavior suite over the TS standard emit
// (S1-A1 path 2), plus the named rejection of the legacy and static TS emits.
// The compiled fixture is imported as a namespace; it exports the same family
// shape { Counter, Base, Derived, Leaf, SYM, recompute, pkg } as the mock, so
// the SAME behaviorSuite body runs. Run `npm run fixtures` if these imports fail
// to resolve. ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as classes from "./fixtures/ts-out/fixture.src.js";
import { behaviorSuite } from "./shared/behavior-suite.mjs";

test("behavior suite over the TS standard emit", (t) => {
    behaviorSuite(t, classes, "ts");
});

test("TS legacy emit import rejects with the named legacy error", async () => {
    await assert.rejects(
        () => import("./fixtures/ts-legacy-out/legacy.src.js"),
        (e) => e instanceof TypeError && /legacy decorator call/.test(e.message),
    );
});

test("TS static-accessor emit import rejects with the named static error", async () => {
    await assert.rejects(
        () => import("./fixtures/ts-out/static.src.js"),
        (e) => e instanceof TypeError && /cannot decorate the static member/.test(e.message),
    );
});
