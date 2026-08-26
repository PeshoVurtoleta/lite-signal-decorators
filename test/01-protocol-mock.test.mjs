// test/01-protocol-mock.test.mjs -- the Stage-3 protocol contract exercised
// through hand-built standard-shaped contexts (no transpiler): every PD-8
// rejection row, the PD-2 orphan check, both PD-3 missing-host paths, the PD-6
// same-key redeclare throw, factory arg forms, and the full behavior suite over
// the mock-built class family (S1-A1 path 1).
//
// PENDING is module state: a @reactive/@derived application that is never hosted
// leaves a record in the buffer. `drainPending()` empties it (a throwaway host
// splices the whole buffer); we call it at the start of every test that hosts,
// so no test can be poisoned by a prior test's deliberate orphan.
//
// ASCII-only. node:test only.

import { test } from "node:test";
import assert from "node:assert/strict";

import * as pkg from "../SignalDecorators.js";
import {
    makeClasses,
    buildClass,
    makeAccessorContext,
    makeGetterContext,
    makeClassContext,
} from "./shared/mock-emitter.mjs";
import { behaviorSuite } from "./shared/behavior-suite.mjs";

const { reactive, derived, reactiveHost } = pkg;

// Empty the PENDING buffer: a throwaway host splices it whole, throwing an
// orphan error iff records lingered (swallowed here). Either way it is empty
// afterward.
function drainPending() {
    try {
        reactiveHost(class Drain {}, makeClassContext("Drain"));
    } catch (_) {
        // orphan records were present; the splice already emptied the buffer.
    }
}

// --- PD-8 rejection matrix ----------------------------------------------------

test("PD-8 legacy emit is rejected (2nd arg is a property key)", () => {
    assert.throws(
        () => reactive({}, "count"),
        (e) => e instanceof TypeError && /legacy decorator call/.test(e.message),
    );
    assert.throws(
        () => derived(function () {}, "d"),
        (e) => e instanceof TypeError && /legacy decorator call/.test(e.message),
    );
    // reactiveHost legacy shape: called with just the constructor.
    assert.throws(
        () => reactiveHost(class {}),
        (e) => e instanceof TypeError && /legacy decorator call/.test(e.message),
    );
});

test("PD-8 wrong kind is rejected with the fix hint", () => {
    assert.throws(
        () => reactive({ get() {}, set() {} }, makeGetterContext("x")),
        (e) => e instanceof TypeError && /kind "accessor"/.test(e.message) &&
            /accessor x/.test(e.message),
    );
    assert.throws(
        () => derived(function () {}, makeAccessorContext("y")),
        (e) => e instanceof TypeError && /kind "getter"/.test(e.message) &&
            /get y/.test(e.message),
    );
    assert.throws(
        () => reactiveHost(class {}, makeAccessorContext("z")),
        (e) => e instanceof TypeError && /kind "class"/.test(e.message),
    );
});

test("PD-8 static member is rejected", () => {
    assert.throws(
        () => reactive({ get() {}, set() {} }, makeAccessorContext("s", { static: true })),
        (e) => e instanceof TypeError && /cannot decorate the static member/.test(e.message),
    );
    assert.throws(
        () => derived(function () {}, makeGetterContext("s", { static: true })),
        (e) => e instanceof TypeError && /cannot decorate the static member/.test(e.message),
    );
});

test("PD-8 private member is rejected", () => {
    assert.throws(
        () => reactive({ get() {}, set() {} }, makeAccessorContext("p", { private: true })),
        (e) => e instanceof TypeError && /private \(#\) members are not supported/.test(e.message),
    );
});

test("PD-8 unknown option key -> did-you-mean nearest known key", () => {
    // `equal`/`eqals` are one edit from the known `equals`.
    assert.throws(
        () => reactive({ equal: () => true }),
        (e) => e instanceof TypeError && /did you mean `equals`/.test(e.message) &&
            /Known options: equals/.test(e.message),
    );
    assert.throws(
        () => derived({ eqals: () => true }),
        (e) => e instanceof TypeError && /did you mean `equals`/.test(e.message),
    );
});

test("PD-8 bad option type -> equals must be a function", () => {
    assert.throws(
        () => reactive({ equals: 3 }),
        (e) => e instanceof TypeError && /`equals` must be a function/.test(e.message),
    );
});

test("PD-8 double host is rejected", () => {
    drainPending();
    const Once = reactiveHost(class Solo {}, makeClassContext("Solo"));
    assert.throws(
        () => reactiveHost(Once, makeClassContext("Solo")),
        (e) => /already has a @reactiveHost wrapper/.test(e.message),
    );
});

test("PD-8 reactiveHost options are rejected (no options in 0.1.0)", () => {
    assert.throws(
        () => reactiveHost({ registry: {} }),
        (e) => e instanceof TypeError && /reactiveHost takes no options/.test(e.message),
    );
});

// --- Factory arg forms --------------------------------------------------------

test("factory arg forms: bare, (undefined), ({}) all yield a decorator", () => {
    // Bare application (>=2 args) is a decorator directly; factory (0-1 args)
    // returns a decorator. Each records into PENDING, so drain afterward.
    const bare = reactive({ get() {}, set() {} }, makeAccessorContext("f1"));
    assert.equal(typeof bare.get, "function");
    assert.equal(typeof bare.init, "function");

    const decU = reactive(undefined);
    assert.equal(typeof decU, "function");
    const rU = decU({ get() {}, set() {} }, makeAccessorContext("f2"));
    assert.equal(typeof rU.init, "function");

    const decE = reactive({});
    const rE = decE({ get() {}, set() {} }, makeAccessorContext("f3"));
    assert.equal(typeof rE.init, "function");

    // reactiveHost factory forms.
    assert.equal(typeof reactiveHost(), "function");
    assert.equal(typeof reactiveHost({}), "function");
    assert.equal(typeof reactiveHost(undefined), "function");

    drainPending();
});

// --- PD-2 orphan detection ----------------------------------------------------

test("PD-2 hosting after an un-hosted reactive member -> orphan throw", () => {
    drainPending();
    // Register a reactive member WITHOUT hosting its class: the record lingers.
    reactive({ get() {}, set() {} }, makeAccessorContext("orphaned"));
    assert.throws(
        () => reactiveHost(class Clean {}, makeClassContext("Clean")),
        (e) => /never installed on its prototype/.test(e.message) &&
            /orphaned/.test(e.message),
    );
    // The failed claim drained PENDING -- a subsequent clean host works.
    const Ok = reactiveHost(class Ok {}, makeClassContext("Ok"));
    assert.equal(typeof Ok, "function");
});

// --- PD-3 missing-host, both paths --------------------------------------------

test("PD-3 reactive accessor without a host throws at first construction", () => {
    drainPending();
    const NoHost = buildClass({
        name: "NoHostSignal",
        members: [
            { kind: "accessor", key: "x", decorator: reactive, value: () => 0 },
        ],
    });
    assert.throws(
        () => new NoHost(),
        (e) => /without a @reactiveHost/.test(e.message),
    );
    drainPending();
});

test("PD-3 derived getter without a host throws at first construction", () => {
    drainPending();
    const NoHost = buildClass({
        name: "NoHostDerived",
        members: [
            { kind: "getter", key: "d", decorator: derived, body: function () { return 1; } },
        ],
    });
    assert.throws(
        () => new NoHost(),
        (e) => /without a @reactiveHost/.test(e.message),
    );
    drainPending();
});

// --- PD-6 same-key redeclare across the chain ---------------------------------

test("PD-6 subclass redeclaring a base reactive key throws at claim", () => {
    drainPending();
    const B = buildClass({
        name: "B6",
        classDecorator: reactiveHost,
        members: [
            { kind: "accessor", key: "k", decorator: reactive, value: () => 1 },
        ],
    });
    assert.throws(
        () => buildClass({
            name: "D6",
            superClass: B,
            classDecorator: reactiveHost,
            members: [
                { kind: "accessor", key: "k", decorator: reactive, value: () => 2 },
            ],
        }),
        (e) => /declared twice across the prototype chain/.test(e.message),
    );
    drainPending();
});

// --- The behavior suite over the mock-built family (S1-A1 path 1) -------------

test("behavior suite over mock-built classes", (t) => {
    drainPending();
    const classes = makeClasses(pkg);
    behaviorSuite(t, classes, "mock");
});
