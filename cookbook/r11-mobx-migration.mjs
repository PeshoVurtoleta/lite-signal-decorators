// cookbook/r11-mobx-migration.mjs -- node --expose-gc cookbook/r11-mobx-migration.mjs
//
// Recipe 11 (Pro): a MobX store, migrated. Stamp 2026-08-30. One worked
// end-to-end migration -- an observable array plus a deep observable -- landing
// on the composition stack, layer by layer, with the cost stated per layer.
// Each layer shows the MobX original as a comment (before) and the migrated
// form (after). Snippets live in `#region cookbook:r11.k` spans; harness (the
// asserts + summary line) is OUTSIDE them.
//
// NOT gated: a mixed migration whose reactive layers are proven zero-GC
// elsewhere (r4 rev+length, r5 rev-stamped boundary) and whose document-shaped
// escape hatch (lite-store) is NOT zero-GC by r6's published reason.
//
// ASCII-only. Exits 0 with one summary line; non-zero on any violated assertion.

import { effect } from "@zakkster/lite-signal";

function fail(msg) {
    process.stderr.write("cookbook r11 FAIL: " + msg + "\n");
    process.exit(1);
}
function assert(cond, msg) { if (!cond) fail(msg); }

// #region cookbook:r11.1
import { defineReactive, disposeReactive, costOf } from "@zakkster/lite-signal-decorators";

// LAYER A -- the observable array.
//
//   // MobX (before):
//   //   class TodoStore { @observable todos = []; }
//   //   store.todos.push(t)  // every element is individually observable
//
// After: a PLAIN array plus one rev signal and one length signal. The array
// elements are never reactive nodes -- 1 todo and 1000 todos cost the same two
// signals. A mutator bumps the stamp; readers depend on the stamp, not on any
// element. COST: 2 nodes, flat in element count (r4).
class TodoStore {
    constructor() {
        this.todos = [];                       // plain data, not a reactive member
        this.filter = { text: "", done: null };
    }
}
// #endregion cookbook:r11.1

// #region cookbook:r11.2
// LAYER B -- the deep observable.
//
//   // MobX (before):
//   //   @observable filter = { text: "", done: null };
//   //   store.filter.done = true  // deep-tracked, a proxy per node
//
// After: a rev-stamped boundary. The subtree (`filter`) stays plain data; ONE
// rev signal at its root is the reactive edge. A multi-field edit is one commit,
// so watchers see a single edge, not one per field. COST: 1 node for the whole
// subtree, regardless of depth (r5). For an OPEN-ENDED, document-shaped subtree
// you would reach for lite-store's store()/snapshot() instead -- that path is
// NOT zero-GC (r6); a fixed-shape filter does not need it.
const Store = defineReactive(TodoStore, {
    signals: { todosRev: 0, todosLen: 0, filterRev: 0 },
    deriveds: {
        // LAYER C -- @computed becomes @derived: lazy, one recompute per commit,
        // never a scan per frame. It depends on BOTH stamps, so any committed
        // mutation on either side invalidates it exactly once. COST: 1 node.
        visibleCount: (vm) => {
            void vm.todosRev; void vm.filterRev;   // track the boundaries, not the data
            const f = vm.filter;
            let n = 0;
            for (let i = 0; i < vm.todos.length; i++) {
                const t = vm.todos[i];
                if ((f.done === null || t.done === f.done) && t.text.indexOf(f.text) !== -1) n++;
            }
            return n;
        },
    },
    effects: {},
});
// #endregion cookbook:r11.2

// #region cookbook:r11.3
// LAYER C (cont.) -- @action becomes a mutation that bumps the stamp at the
// mutation site. In MobX an @action batched writes; here the commit IS the
// stamp bump, so the multi-write stays one reactive edge. COST: 0 extra nodes.
//
//   // MobX (before):
//   //   @action addTodo(t) { this.todos.push(t); }
//   //   @action setFilter(p) { Object.assign(this.filter, p); }
function addTodo(store, todo) {
    store.todos.push(todo);                    // plain push
    store.todosLen = store.todos.length;
    store.todosRev++;                          // one commit -> one edge
}
function setFilter(store, patch) {
    Object.assign(store.filter, patch);        // deep mutation on plain data
    store.filterRev++;                         // rev-stamped commit -> one edge
}
// #endregion cookbook:r11.3

// --- run the migrated store and assert its behavior --------------------------

const store = new Store();

// Cost is fixed by shape: 3 signals + 1 derived + 1 anchor = 5 nodes, flat in
// todo count (this is the whole point of the array migration).
assert(costOf(Store).nodes === 5, "migrated store cost drifted: " + costOf(Store).nodes);

let fires = 0;
let visible = -1;
const stop = effect(() => { visible = store.visibleCount; fires++; });
assert(fires === 1 && visible === 0, "initial: fires=" + fires + " visible=" + visible);

addTodo(store, { text: "a", done: false });     // matches (filter open) -> 1
addTodo(store, { text: "b", done: true });       // -> 2
addTodo(store, { text: "c", done: false });      // -> 3
assert(visible === 3, "after 3 adds visible=" + visible);
assert(store.todosLen === 3, "todosLen=" + store.todosLen);

setFilter(store, { done: true });                // only "b" -> 1 (value change -> fires)
assert(visible === 1, "after done-filter visible=" + visible);

setFilter(store, { text: "c", done: null });     // only "c" -> 1 (no value change)
assert(visible === 1, "after text-filter visible=" + visible);

// One initial + three value-changing adds + one value-changing filter = 5. The
// last setFilter did not change the value, so the computed's Object.is guard
// suppressed the re-run: watchers fire on VALUE change, not on every commit.
assert(fires === 5, "expected 5 fires, got " + fires);

stop();
disposeReactive(store);

process.stdout.write(
    "cookbook r11 mobx-migration | nodes=" + costOf(Store).nodes +
    " todos=3 visible=" + visible + " fires=" + fires + " | ok\n",
);
