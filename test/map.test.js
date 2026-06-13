"use strict";

/*
 * Unit tests for the pure, DOM-free logic of the codemap navigator.
 *
 * map.js boots only in a browser (it checks for window/document) and exposes
 * its internals via module.exports under Node, so requiring it here runs no
 * DOM code.  Run with: `npm test`  (i.e. `node --test`).
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const map = require("../assets/js/map.js");
const CODEBASES = ["lean", "rust", "solidity"];

function loadCodemap(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "codemaps", name + ".json"), "utf8"));
}

/* ── sanitizeRepoUrl (security) ────────────────────────────────── */
test("sanitizeRepoUrl rejects non-http schemes", () => {
  assert.equal(map.sanitizeRepoUrl("javascript:alert(1)"), map.DEFAULT_REPO_URL);
  assert.equal(map.sanitizeRepoUrl("data:text/html,x"), map.DEFAULT_REPO_URL);
  assert.equal(map.sanitizeRepoUrl("vbscript:x"), map.DEFAULT_REPO_URL);
  assert.equal(map.sanitizeRepoUrl("/relative/path"), map.DEFAULT_REPO_URL);
  assert.equal(map.sanitizeRepoUrl(null), map.DEFAULT_REPO_URL);
  assert.equal(map.sanitizeRepoUrl(undefined), map.DEFAULT_REPO_URL);
  assert.equal(map.sanitizeRepoUrl({}), map.DEFAULT_REPO_URL);
});

test("sanitizeRepoUrl accepts http(s) and trims trailing slashes", () => {
  assert.equal(map.sanitizeRepoUrl("https://github.com/a/b"), "https://github.com/a/b");
  assert.equal(map.sanitizeRepoUrl("https://github.com/a/b/"), "https://github.com/a/b");
  assert.equal(map.sanitizeRepoUrl("http://example.com/x///"), "http://example.com/x");
  assert.equal(map.sanitizeRepoUrl("HTTPS://EXAMPLE.com/Y"), "HTTPS://EXAMPLE.com/Y");
});

/* ── kindLabel / kindColor ─────────────────────────────────────── */
test("kindLabel humanizes kinds", () => {
  assert.equal(map.kindLabel("abstract_contract"), "Abstract Contract");
  assert.equal(map.kindLabel("fn"), "Fn");
  assert.equal(map.kindLabel("theorem"), "Theorem");
  assert.equal(map.kindLabel(""), "");
  assert.equal(map.kindLabel(undefined), "");
});

test("kindColor maps known kinds and falls back for unknown", () => {
  assert.equal(map.kindColor("theorem"), "#c081cc");
  assert.equal(map.kindColor("def"), "#8ecc81");
  assert.equal(map.kindColor("constructor"), "#81cc9a", "real constructor kind keeps its colour");
  assert.equal(map.kindColor("totally-unknown-kind"), "#9aa8a0");
  assert.equal(map.kindColor("toString"), "#9aa8a0", "prototype key does not leak a colour");
  assert.equal(map.kindColor(""), "#9aa8a0");
});

/* ── colour maths ──────────────────────────────────────────────── */
test("parseHexColor parses 3- and 6-digit hex; invalid → neutral", () => {
  assert.deepEqual(map.parseHexColor("#ffffff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(map.parseHexColor("#000000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(map.parseHexColor("#fff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(map.parseHexColor("#82f0b0"), { r: 130, g: 240, b: 176 });
  assert.deepEqual(map.parseHexColor("nonsense"), { r: 143, g: 163, b: 191 });
});

test("blendHexColor is correct at endpoints and midpoint", () => {
  assert.equal(map.blendHexColor("#000000", "#ffffff", 0), "#000000");
  assert.equal(map.blendHexColor("#000000", "#ffffff", 1), "#ffffff");
  assert.equal(map.blendHexColor("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(map.blendHexColor("#102030", "#102030", 0.5), "#102030");
});

/* ── label wrapping ────────────────────────────────────────────── */
test("wrapLabelLines wraps on delimiters and chunks long tokens", () => {
  assert.deepEqual(map.wrapLabelLines("", 100, 10), []);
  const oneLine = map.wrapLabelLines("Short", 400, 10);
  assert.equal(oneLine.join(""), "Short");
  const dotted = map.wrapLabelLines("LegalKernel.Authority.SignedAction", 80, 12);
  assert.ok(dotted.length >= 2, "long dotted name should wrap to multiple lines");
  assert.equal(dotted.join(""), "LegalKernel.Authority.SignedAction");
  const huge = map.wrapLabelLines("x".repeat(50), 60, 10);
  assert.ok(huge.length > 1, "a token longer than maxChars is chunked");
  // maxChars = max(minChars, floor(width / charWidth)) = max(10, floor(60/6.4)) = 10
  const maxChars = Math.max(10, Math.floor(60 / 6.4));
  assert.ok(huge.every((l) => l.length <= maxChars), "each chunk respects max width");
  assert.equal(huge.join(""), "x".repeat(50), "chunking preserves content");
});

test("nodeContentHeight is at least the minimum and grows with content", () => {
  const bare = map.nodeContentHeight("Foo", "", 300, false, "");
  assert.ok(bare >= 46, "full node has min height 46");
  const compact = map.nodeContentHeight("Foo", "", 300, true, "");
  assert.ok(compact >= 36, "compact node has min height 36");
  const withSubtitle = map.nodeContentHeight("Foo", "12 decl · ←3 →4", 300, false, "path/to/file.rs");
  assert.ok(withSubtitle > bare, "subtitle + meta link increase height");
});

/* ── interiorGroups / interiorItemsForSelection (pure) ─────────── */
test("interiorGroups only surfaces non-empty groups and routes unknown kinds to Other", () => {
  const interior = {
    byKind: {
      def: [{ name: "a", line: 1 }, { name: "b", line: 2 }],
      theorem: [{ name: "t", line: 3 }],
      weird_kind: [{ name: "w", line: 4 }]
    },
    kindsPresent: ["def", "theorem", "weird_kind"],
    total: 4
  };
  const groups = map.interiorGroups(interior);
  const byKey = Object.fromEntries(groups.map((g) => [g.key, g]));
  assert.ok(byKey.functions, "functions group present (def)");
  assert.equal(byKey.functions.count, 2);
  assert.ok(byKey.theorems, "theorems group present");
  assert.equal(byKey.theorems.count, 1);
  assert.ok(byKey.other, "unmapped kind routed to Other");
  assert.deepEqual(byKey.other.kinds, ["weird_kind"]);
  assert.ok(!byKey.types, "empty Types group is omitted");
});

test("interiorItemsForSelection aggregates, filters and sorts", () => {
  const interior = {
    byKind: {
      def: [{ name: "zeta", line: 5 }, { name: "alpha", line: 2 }],
      abbrev: [{ name: "beta", line: 9 }]
    },
    kindsPresent: ["def", "abbrev"],
    total: 3
  };
  const all = map.interiorItemsForSelection(interior, ["def", "abbrev"], map.KIND_ALL_VALUE, "");
  assert.deepEqual(all.map((i) => i.name), ["alpha", "beta", "zeta"], "sorted by name across kinds");
  const onlyDef = map.interiorItemsForSelection(interior, ["def", "abbrev"], "def", "");
  assert.deepEqual(onlyDef.map((i) => i.name), ["alpha", "zeta"]);
  const filtered = map.interiorItemsForSelection(interior, ["def", "abbrev"], map.KIND_ALL_VALUE, "et");
  assert.deepEqual(filtered.map((i) => i.name).sort(), ["beta", "zeta"]);
});

/* ── buildGraph invariants across the real codemaps ────────────── */
for (const name of CODEBASES) {
  test(`buildGraph(${name}) — counts and structure`, () => {
    const raw = loadCodemap(name);
    const built = map.buildGraph(raw);

    assert.equal(built.moduleNames.length, raw.modules.length, "every module is indexed");
    assert.equal(built.stats.moduleCount, raw.summary.module_count, "module count matches summary");
    assert.equal(built.stats.declarationCount, raw.summary.declaration_count, "declaration count matches summary");
    assert.equal(built.repoUrl, "https://github.com/hatter6822/Knomosis", "repo url sanitized from data");
    assert.ok(Object.keys(built.declarationIndex).length > 0, "declarations are indexed");

    // kindCounts sum equals declarationCount
    const kindSum = Object.values(built.stats.kindCounts).reduce((a, b) => a + b, 0);
    assert.equal(kindSum, raw.summary.declaration_count, "kind counts sum to total declarations");
  });

  test(`buildGraph(${name}) — module edge symmetry & no self loops`, () => {
    const built = map.buildGraph(loadCodemap(name));
    let edgeCount = 0;
    for (const a of built.moduleNames) {
      const from = built.importsFrom[a] || [];
      edgeCount += from.length;
      assert.ok(from.indexOf(a) === -1, `${a} has no self dependency`);
      for (const b of from) {
        assert.ok((built.importsTo[b] || []).indexOf(a) !== -1, `importsTo[${b}] must include ${a}`);
      }
    }
    assert.equal(edgeCount, built.stats.crossModuleLinks, "crossModuleLinks equals total directed edges");
  });

  test(`buildGraph(${name}) — declaration call graph is consistent`, () => {
    const built = map.buildGraph(loadCodemap(name));
    let refCount = 0;
    for (const caller of Object.keys(built.declarationGraph)) {
      const entry = built.declarationGraph[caller];
      assert.ok(typeof entry.module === "string" && entry.module, `${caller} has an owning module`);
      const seen = new Set();
      for (const callee of entry.calls) {
        assert.ok(!seen.has(callee), "no duplicate callee in a declaration's calls");
        seen.add(callee);
        assert.ok(built.declarationIndex[callee], "every resolved callee exists in the index");
        assert.ok((built.declarationReverseGraph[callee] || []).indexOf(caller) !== -1, "reverse graph contains the caller");
        refCount++;
      }
    }
    assert.equal(refCount, built.stats.callRefs, "callRefs equals total resolved call edges");
  });
}

/* ── state-dependent helpers (require applyGraph) ──────────────── */


test("defaultModuleForCodebase selects the configured central module", () => {
  for (const name of CODEBASES) {
    const built = map.buildGraph(loadCodemap(name));
    map.applyGraph(built);
    assert.equal(map.defaultModuleForCodebase(name), map.CENTRAL_MODULES[name]);
  }
});

test("resetMapView returns each codebase to its default module", () => {
  for (const name of CODEBASES) {
    const built = map.buildGraph(loadCodemap(name));
    map.applyGraph(built);
    map.state.codebase = name;

    const defaultModule = map.defaultModuleForCodebase(name);
    const alternateModule = built.moduleNames.find((moduleName) => moduleName !== defaultModule);
    assert.ok(alternateModule, `${name} fixture has a non-default module to select first`);

    map.state.selectedModule = alternateModule;
    map.state.flowContext = "declaration";
    map.state.selectedDeclaration = Object.keys(built.declarationIndex)[0] || "placeholder";
    map.state.selectedDeclarationModule = alternateModule;
    map.state.declarationLanesExpanded = true;
    map.state.flowShowAll = true;
    map.state.flowScrollTarget = alternateModule;

    const landing = map.resetMapView();
    assert.equal(landing, map.CENTRAL_MODULES[name]);
    assert.equal(map.state.selectedModule, map.CENTRAL_MODULES[name]);
    assert.equal(map.state.flowContext, "module");
    assert.equal(map.state.selectedDeclaration, "");
    assert.equal(map.state.selectedDeclarationModule, "");
    assert.equal(map.state.declarationLanesExpanded, false);
    assert.equal(map.state.flowShowAll, false);
    assert.equal(map.state.flowScrollTarget, map.CENTRAL_MODULES[name]);
  }
});

test("applyGraph + moduleDegree / sortedModuleList", () => {
  const built = map.buildGraph(loadCodemap("rust"));
  map.applyGraph(built);

  const list = map.sortedModuleList();
  assert.equal(list.length, built.moduleNames.length);
  // sorted by descending degree score (non-increasing)
  for (let i = 1; i < list.length; i++) {
    const prev = map.moduleDegree(list[i - 1]).score;
    const cur = map.moduleDegree(list[i]).score;
    assert.ok(prev >= cur, "module list sorted by non-increasing score");
  }
  // degree matches edge arrays
  const sample = list[0];
  const deg = map.moduleDegree(sample);
  assert.equal(deg.incoming, (built.importsTo[sample] || []).length);
  assert.equal(deg.outgoing, (built.importsFrom[sample] || []).length);
});

test("applyGraph + search matchers", () => {
  const built = map.buildGraph(loadCodemap("solidity"));
  map.applyGraph(built);

  // a module substring search returns only modules containing the query
  const someModule = built.moduleNames[0];
  const frag = someModule.slice(0, 3).toLowerCase();
  const modMatches = map.moduleSearchMatches(frag, 20);
  assert.ok(modMatches.length >= 1);
  assert.ok(modMatches.every((m) => m.type === "module" && m.module.toLowerCase().indexOf(frag) !== -1));

  // declaration search resolves a known declaration and respects the limit
  const declName = Object.keys(built.declarationIndex)[0];
  const declMatches = map.declarationSearchMatches(declName.toLowerCase(), 5);
  assert.ok(declMatches.length >= 1 && declMatches.length <= 5);
  assert.ok(declMatches.every((d) => d.type === "decl" && d.module));

  // "Module.decl" form searches by the suffix after the last dot
  const suffixMatches = map.declarationSearchMatches("Nonexistent." + declName.toLowerCase(), 5);
  assert.ok(suffixMatches.some((d) => d.decl === declName));
});

test("resolveDeclRef prefers a valid module prefix, then the global index", () => {
  const built = map.buildGraph(loadCodemap("lean"));
  map.applyGraph(built);

  // find a declaration and its owning module from the index
  const declName = Object.keys(built.declarationIndex)[0];
  const owner = built.declarationIndex[declName].module;

  const byPrefix = map.resolveDeclRef(owner + "." + declName);
  assert.equal(byPrefix.module, owner);
  assert.equal(byPrefix.decl, declName);

  const bareName = map.resolveDeclRef(declName);
  assert.equal(bareName.decl, declName);
  assert.equal(bareName.module, owner);

  assert.equal(map.resolveDeclRef("definitely::not::a::decl::name::xyz"), null);
  assert.equal(map.resolveDeclRef(""), null);
});

test("interiorForModule reflects a real module's declarations", () => {
  const built = map.buildGraph(loadCodemap("solidity"));
  map.applyGraph(built);
  const moduleName = built.moduleNames.find((n) => built.moduleMeta[n].declarationCount > 0);
  const interior = map.interiorForModule(moduleName);
  let sum = 0;
  for (const k of interior.kindsPresent) sum += interior.byKind[k].length;
  assert.equal(sum, interior.total, "interior total equals sum of per-kind counts");
  assert.ok(interior.total > 0);
});

/* ── Name-collision handling: same-module call resolution (PR #2 review) ── */
test("buildGraph resolves a call to a locally-defined name as intra-module", () => {
  // B is indexed first, so a pure first-wins lookup of "bar" would point to B.
  const raw = { modules: [
    { module: "B", path: "b.rs", declarations: [{ kind: "fn", name: "bar", line: 1, called: [] }] },
    { module: "A", path: "a.rs", declarations: [
      { kind: "fn", name: "bar", line: 1, called: [] },
      { kind: "fn", name: "foo", line: 2, called: ["bar"] }
    ] }
  ] };
  const g = map.buildGraph(raw);
  assert.deepEqual(g.importsFrom["A"] || [], [], "A.foo -> local bar must not create a cross-module edge to B");
  assert.deepEqual(g.importsTo["B"] || [], [], "B is not depended on");
});

test("buildGraph still resolves a non-local call cross-module", () => {
  const raw = { modules: [
    { module: "B", path: "b.rs", declarations: [{ kind: "fn", name: "bar", line: 1, called: [] }] },
    { module: "C", path: "c.rs", declarations: [{ kind: "fn", name: "baz", line: 1, called: ["bar"] }] }
  ] };
  const g = map.buildGraph(raw);
  assert.deepEqual(g.importsFrom["C"], ["B"], "C.baz -> B.bar (bar not defined in C)");
  assert.deepEqual(g.importsTo["B"], ["C"]);
});

/* ── Duplicate module-name disambiguation (Solidity stem collisions) ── */
test("buildGraph disambiguates duplicate module names by path", () => {
  // The Solidity codemap names a module after its file's basename stem, so two
  // files sharing a basename in different directories both reduce to "AmmMath.t".
  // They must stay two distinct nodes, never collapse into one (which would drop
  // a file and corrupt the edge counter).
  const raw = { modules: [
    { module: "AmmMath.t", path: "solidity/test/AmmMath.t.sol", declarations: [
      { kind: "function", name: "testA", line: 1, called: ["shared"] },
      { kind: "function", name: "shared", line: 2, called: [] }
    ] },
    { module: "AmmMath.t", path: "solidity/test/CrossCheck/AmmMath.t.sol", declarations: [
      { kind: "function", name: "testB", line: 1, called: [] }
    ] }
  ] };
  const g = map.buildGraph(raw);
  assert.equal(g.moduleNames.length, 2, "both colliding modules are preserved");
  assert.equal(new Set(g.moduleNames).size, 2, "module names are unique after disambiguation");
  // Each disambiguated name maps back to its own distinct source path.
  const paths = g.moduleNames.map((n) => g.moduleMap[n]).sort();
  assert.deepEqual(paths, ["solidity/test/AmmMath.t.sol", "solidity/test/CrossCheck/AmmMath.t.sol"]);
  // testA -> shared is intra-module (both in the first file); it must NOT create
  // a cross-module edge to the second AmmMath.t, and the counter stays consistent.
  let edges = 0;
  for (const a of g.moduleNames) edges += (g.importsFrom[a] || []).length;
  assert.equal(edges, g.stats.crossModuleLinks, "edge counter stays consistent under collisions");
  assert.equal(edges, 0, "a self-contained local call adds no cross-module edge");
});

/* The real bundled codemaps must never contain a duplicate module name (the
   loader's disambiguation guarantees uniqueness; this pins it end-to-end). */
for (const name of CODEBASES) {
  test(`buildGraph(${name}) — module names are unique`, () => {
    const g = map.buildGraph(loadCodemap(name));
    assert.equal(new Set(g.moduleNames).size, g.moduleNames.length, "no duplicate module names");
  });
}

/* ── Unambiguous deep links for dotted names (PR #2 review) ── */
test("dotted declaration names resolve via module + bare decl", () => {
  const raw = { repository: { url: "https://github.com/x/y" }, modules: [
    { module: "Mod", path: "Mod.lean", declarations: [
      { kind: "def", name: "Action.compile", line: 5, called: [] },
      { kind: "def", name: "plain", line: 6, called: [] }
    ] }
  ] };
  map.applyGraph(map.buildGraph(raw));
  // Preferred path used by deep links: (module, bare decl) — exact even with dots.
  assert.equal(map.moduleHasDeclaration("Mod", "Action.compile"), true);
  assert.equal(map.moduleHasDeclaration("Mod", "missing"), false);
  // Legacy combined-ref fallback: the whole dotted name is tried as a decl name.
  assert.deepEqual(map.resolveDeclRef("Action.compile"), { module: "Mod", decl: "Action.compile" });
  assert.deepEqual(map.resolveDeclRef("Mod.plain"), { module: "Mod", decl: "plain" });
});
