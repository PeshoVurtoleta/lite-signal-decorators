// bench/adapters/_exclusions.mjs -- engines probed for admission (PD-16) and
// REJECTED, each with the exact one-line blocker. Keys here get NO adapter file;
// the bench README surfaces these lines.
//
// Default export: { engineKey: "one-line reason" }.

export default {
    "reactively": "@reactively/decorate ships only legacy (experimentalDecorators) decorators -- signature (proto, key, descriptor) returning a descriptor -- which the standard-2023-11 bench emitter cannot drive, and the package exposes no documented non-decorator class API.",
    "classy-solid": "reactivity is dead in stock Node -- solid-js's default Node resolution is its non-reactive SSR build and classy-solid imports `solid-js` internally (no deep-import escape), so live class reactivity requires running the whole process under `--conditions=browser`, a non-stock-Node run condition (PD-16).",
};
