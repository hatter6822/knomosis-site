/**
 * Knomosis Adaptive Codebase Navigator
 *
 * Renders an interactive flow chart for each language codemap (Lean, Rust,
 * Solidity) directly from the bundled JSON codemaps.  The same canonical graph
 * is used for every codebase:
 *
 *   • Module flow  — the selected module in the center, the modules it depends
 *     on (its declarations call into them) on the left, and the modules that
 *     depend on it (they call into it) on the right.
 *   • Declaration flow — drilling into a single declaration shows what it calls
 *     (outgoing) and what calls it (incoming), with node borders coloured by
 *     declaration kind and dashed edges marking cross-module references.
 *   • Interior menu — every declaration in the selected module grouped into
 *     adaptive, language-aware kind columns (Types, Functions, Theorems, …).
 *
 * Cross-module links and the declaration call graph are derived from each
 * declaration's `called` list resolved against a global declaration index.
 * Pure vanilla JS, no dependencies; panning/zooming uses native scroll.
 */
(function () {
  "use strict";

  /* ── Configuration ─────────────────────────────────────────── */
  var MAP_SOURCES = {
    lean:     { path: "data/codemaps/lean.json",     label: "Lean" },
    rust:     { path: "data/codemaps/rust.json",     label: "Rust" },
    solidity: { path: "data/codemaps/solidity.json", label: "Solidity" }
  };
  var DEFAULT_CODEBASE = "lean";
  var DEFAULT_REPO_URL = "https://github.com/hatter6822/Knomosis";
  var DEFAULT_REF = "main";
  var NEIGHBOR_LIMIT = 10;

  /* Edge / lane colours — shared with the legend and lane labels. */
  var COLOR_SELECTED = "#7c9cff";
  var COLOR_DEPENDS  = "#35c98f"; /* modules the selected one depends on */
  var COLOR_USED_BY  = "#ffad42"; /* modules that depend on the selected one */
  var COLOR_CALLS    = "#82f0b0"; /* outgoing declaration calls */
  var COLOR_NEUTRAL  = "#8fa3bf";

  /* Adaptive declaration-kind grouping that spans all three languages.
     Any kind not listed here falls into a dynamically created "Other" group. */
  var KIND_GROUPS = [
    { key: "types",     label: "Types",                kinds: ["structure", "inductive", "class", "struct", "enum", "type", "trait", "contract", "interface", "library", "abstract_contract"] },
    { key: "functions", label: "Functions",            kinds: ["def", "abbrev", "fn", "function", "constructor", "receive", "modifier", "opaque"] },
    { key: "theorems",  label: "Theorems",             kinds: ["theorem"] },
    { key: "impls",     label: "Instances & Impls",    kinds: ["instance", "impl"] },
    { key: "modules",   label: "Namespaces & Modules", kinds: ["namespace", "mod"] },
    { key: "values",    label: "Constants",            kinds: ["const", "static"] },
    { key: "events",    label: "Events & Errors",      kinds: ["event", "error"] }
  ];
  var KIND_TO_GROUP = (function () {
    var map = Object.create(null);
    for (var i = 0; i < KIND_GROUPS.length; i++) {
      var group = KIND_GROUPS[i];
      for (var j = 0; j < group.kinds.length; j++) map[group.kinds[j]] = group.key;
    }
    return map;
  })();

  var KIND_COLOR_MAP = {
    structure: "#72d5ff", inductive: "#8ecbff", class: "#6ae3d8",
    struct: "#72d5ff", enum: "#8ecbff", type: "#6ae3d8", trait: "#5ab8ff",
    contract: "#72d5ff", interface: "#6ae3d8", library: "#5ab8ff", abstract_contract: "#8ecbff",
    def: "#82f0b0", abbrev: "#8be4cb", fn: "#82f0b0", function: "#82f0b0",
    constructor: "#6ee0a0", receive: "#8be4cb", modifier: "#9ce5b0", opaque: "#9ec5ff",
    theorem: "#ffd782",
    instance: "#d0b7ff", impl: "#c8a5ff",
    namespace: "#ff84b6", mod: "#ff9bc7",
    const: "#f7b0ff", static: "#f0a0e0",
    event: "#ffb38a", error: "#ff9fb0"
  };
  var KIND_ALL_VALUE = "__all__";

  /* ── State ─────────────────────────────────────────────────── */
  var state = {
    codebase: DEFAULT_CODEBASE,
    repoUrl: DEFAULT_REPO_URL,
    ref: DEFAULT_REF,
    schemaVersion: "",
    summary: {},
    sourceDigest: "",
    moduleMap: Object.create(null),          /* name -> repo path */
    moduleMeta: Object.create(null),         /* name -> { declarationCount, symbols } */
    moduleNames: [],
    declarationIndex: Object.create(null),   /* name -> { module, kind, line } */
    declarationGraph: Object.create(null),   /* name -> { module, calls: [] } */
    declarationReverseGraph: Object.create(null), /* name -> [callers] */
    importsFrom: Object.create(null),        /* name -> [modules it depends on] */
    importsTo: Object.create(null),          /* name -> [modules that depend on it] */
    degreeMap: Object.create(null),
    stats: null,

    selectedModule: null,
    flowContext: "module",
    selectedDeclaration: "",
    selectedDeclarationModule: "",
    declarationLanesExpanded: false,
    flowShowAll: false,
    neighborLimit: NEIGHBOR_LIMIT,
    flowScrollTarget: "",

    interiorMenuModule: "",
    interiorMenuQuery: "",
    interiorMenuSelections: Object.create(null),

    searchActiveOption: -1,
    searchVisibleOptions: []
  };

  var renderScheduled = false;

  /* ── DOM cache ─────────────────────────────────────────────── */
  var DOM = {};
  function cacheDomElements() {
    DOM.select = document.getElementById("map-select");
    DOM.status = document.getElementById("map-status");
    DOM.results = document.getElementById("module-results");
    DOM.stats = document.getElementById("map-stats");
    DOM.search = document.getElementById("module-search");
    DOM.searchOptions = document.getElementById("module-search-options");
    DOM.searchFeedback = document.getElementById("module-search-feedback");
    DOM.searchLabel = document.querySelector('label[for="module-search"]');
    DOM.reset = document.getElementById("reset-view");
    DOM.interiorMenu = document.getElementById("flow-node-interior-menu");
    DOM.flowWrap = document.getElementById("flowchart-wrap");
  }

  /* ── Small utilities ───────────────────────────────────────── */
  function setStatus(text, isError) {
    if (!DOM.status) return;
    DOM.status.textContent = text;
    DOM.status.classList.toggle("error", Boolean(isError));
  }

  function setSearchFeedback(message, isError) {
    if (!DOM.searchFeedback) return;
    DOM.searchFeedback.textContent = message || "";
    DOM.searchFeedback.classList.toggle("error", Boolean(isError));
  }

  function updateModuleResults(count) {
    if (!DOM.results) return;
    DOM.results.textContent = count === 1 ? "1 module shown" : count + " modules shown";
  }

  function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    window.requestAnimationFrame(function () {
      renderScheduled = false;
      renderAll();
    });
  }

  function prefersCompactViewport() {
    return Boolean(window.matchMedia && window.matchMedia("(max-width: 900px)").matches);
  }

  function parseHexColor(hex) {
    var h = String(hex || "").replace(/^#/, "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return isNaN(n) ? { r: 143, g: 163, b: 191 } : { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function blendHexColor(a, b, t) {
    var ca = parseHexColor(a);
    var cb = parseHexColor(b);
    var r = Math.round(ca.r + (cb.r - ca.r) * t);
    var g = Math.round(ca.g + (cb.g - ca.g) * t);
    var bl = Math.round(ca.b + (cb.b - ca.b) * t);
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + bl).toString(16).slice(1);
  }

  /* ── Kind helpers ──────────────────────────────────────────── */
  function kindColor(kind) {
    return KIND_COLOR_MAP[String(kind || "")] || COLOR_NEUTRAL;
  }

  function kindLabel(kind) {
    return String(kind || "")
      .split(/[_\s]+/)
      .map(function (part) { return part ? part.charAt(0).toUpperCase() + part.slice(1) : ""; })
      .join(" ");
  }

  function applyKindColor(node, kind, includeBackground) {
    if (!node) return;
    var color = kindColor(kind);
    node.dataset.kind = String(kind || "");
    node.style.setProperty("--interior-kind-color", color);
    if (includeBackground) {
      node.style.backgroundColor = "color-mix(in oklab, " + color + " 18%, var(--surface) 82%)";
    }
  }

  /* ── Build the graph from raw codemap JSON ─────────────────── */
  function buildGraph(raw) {
    var modules = Array.isArray(raw.modules) ? raw.modules : [];
    var moduleMap = Object.create(null);
    var moduleMeta = Object.create(null);
    var declarationIndex = Object.create(null);
    var moduleNames = [];
    var kindCounts = Object.create(null);
    var declarationCount = 0;

    /* Pass 1 — index every declaration and bucket by kind per module. */
    modules.forEach(function (item) {
      var name = item.module || item.path || "unknown";
      var declarations = Array.isArray(item.declarations) ? item.declarations : [];
      var byKind = Object.create(null);

      declarations.forEach(function (decl) {
        if (!decl || typeof decl.name !== "string" || !decl.name) return;
        var kind = String(decl.kind || "decl");
        var line = Number(decl.line) || 0;
        if (!byKind[kind]) byKind[kind] = [];
        byKind[kind].push({ name: decl.name, line: line });
        kindCounts[kind] = (kindCounts[kind] || 0) + 1;
        declarationCount += 1;
        if (!declarationIndex[decl.name]) {
          declarationIndex[decl.name] = { module: name, kind: kind, line: line };
        }
      });

      moduleMap[name] = item.path || "";
      moduleMeta[name] = {
        declarationCount: Number(item.declaration_count) || declarations.length,
        symbols: { byKind: byKind }
      };
      moduleNames.push(name);
    });

    /* Pass 2 — resolve `called` references into module + declaration edges. */
    var importsFrom = Object.create(null);
    var importsTo = Object.create(null);
    var declarationGraph = Object.create(null);
    var declarationReverseGraph = Object.create(null);
    var crossModuleLinks = 0;
    var callRefs = 0;

    function addModuleEdge(from, to) {
      if (!importsFrom[from]) importsFrom[from] = Object.create(null);
      if (!importsTo[to]) importsTo[to] = Object.create(null);
      if (!importsFrom[from][to]) { importsFrom[from][to] = true; crossModuleLinks += 1; }
      importsTo[to][from] = true;
    }

    function addDeclCall(callerName, callerModule, calleeName) {
      var entry = declarationGraph[callerName];
      if (!entry) {
        entry = declarationGraph[callerName] = { module: callerModule, calls: [], _seen: Object.create(null) };
      }
      if (!entry._seen[calleeName]) {
        entry._seen[calleeName] = true;
        entry.calls.push(calleeName);
        callRefs += 1;
      }
      var reverse = declarationReverseGraph[calleeName];
      if (!reverse) reverse = declarationReverseGraph[calleeName] = { list: [], _seen: Object.create(null) };
      if (!reverse._seen[callerName]) {
        reverse._seen[callerName] = true;
        reverse.list.push(callerName);
      }
    }

    modules.forEach(function (item) {
      var sourceName = item.module || item.path || "unknown";
      var declarations = Array.isArray(item.declarations) ? item.declarations : [];
      declarations.forEach(function (decl) {
        if (!decl || typeof decl.name !== "string" || !decl.name) return;
        var called = Array.isArray(decl.called) ? decl.called : [];
        called.forEach(function (callee) {
          var target = declarationIndex[callee];
          if (!target) return;
          addDeclCall(decl.name, sourceName, callee);
          if (target.module !== sourceName) addModuleEdge(sourceName, target.module);
        });
      });
    });

    function keysOf(obj) { return obj ? Object.keys(obj) : []; }
    var importsFromArr = Object.create(null);
    var importsToArr = Object.create(null);
    moduleNames.forEach(function (name) {
      importsFromArr[name] = keysOf(importsFrom[name]);
      importsToArr[name] = keysOf(importsTo[name]);
    });

    /* Flatten the dedup helpers into plain arrays. */
    var cleanDeclGraph = Object.create(null);
    Object.keys(declarationGraph).forEach(function (key) {
      cleanDeclGraph[key] = { module: declarationGraph[key].module, calls: declarationGraph[key].calls };
    });
    var cleanReverse = Object.create(null);
    Object.keys(declarationReverseGraph).forEach(function (key) {
      cleanReverse[key] = declarationReverseGraph[key].list;
    });

    return {
      repoUrl: (raw.repository && raw.repository.url) || DEFAULT_REPO_URL,
      schemaVersion: raw.schema_version || "",
      summary: raw.summary || {},
      sourceDigest: (raw.source_sync && raw.source_sync.source_digest) || "",
      moduleMap: moduleMap,
      moduleMeta: moduleMeta,
      moduleNames: moduleNames,
      declarationIndex: declarationIndex,
      declarationGraph: cleanDeclGraph,
      declarationReverseGraph: cleanReverse,
      importsFrom: importsFromArr,
      importsTo: importsToArr,
      stats: {
        moduleCount: (raw.summary && raw.summary.module_count) || moduleNames.length,
        declarationCount: (raw.summary && raw.summary.declaration_count) || declarationCount,
        crossModuleLinks: crossModuleLinks,
        callRefs: callRefs,
        kindCounts: kindCounts
      }
    };
  }

  /* ── Derived helpers ───────────────────────────────────────── */
  function moduleDegree(name) {
    if (state.degreeMap[name]) return state.degreeMap[name];
    var incoming = (state.importsTo[name] || []).length;
    var outgoing = (state.importsFrom[name] || []).length;
    var decls = state.moduleMeta[name] ? state.moduleMeta[name].declarationCount : 0;
    var degree = {
      incoming: incoming,
      outgoing: outgoing,
      decls: decls,
      score: incoming * 2 + outgoing + Math.min(decls, 40) * 0.1
    };
    state.degreeMap[name] = degree;
    return degree;
  }

  function sortByScoreThenName(a, b) {
    return moduleDegree(b).score - moduleDegree(a).score || a.localeCompare(b);
  }

  function sortedModuleList() {
    return state.moduleNames.slice().sort(sortByScoreThenName);
  }

  function declarationCalls(declName) {
    var entry = state.declarationGraph[declName];
    return entry && Array.isArray(entry.calls) ? entry.calls.slice() : [];
  }

  function declarationCalledBy(declName) {
    var reverse = state.declarationReverseGraph[declName];
    return Array.isArray(reverse) ? reverse.slice() : [];
  }

  function declarationModuleOf(declName) {
    var indexed = state.declarationIndex[declName];
    return indexed ? indexed.module : "";
  }

  function declarationKindOf(declName) {
    var indexed = state.declarationIndex[declName];
    return indexed ? indexed.kind : "";
  }

  function declarationLineOf(declName) {
    var indexed = state.declarationIndex[declName];
    return indexed ? (indexed.line || 0) : 0;
  }

  function encodePath(path) {
    return String(path || "").split("/").map(encodeURIComponent).join("/");
  }

  function moduleSourceLink(name) {
    if (!name || !state.moduleMap[name]) return null;
    var path = state.moduleMap[name];
    if (!path) return null;
    return {
      href: state.repoUrl + "/blob/" + encodeURIComponent(state.ref) + "/" + encodePath(path),
      label: path,
      title: "Open " + name + " source on GitHub"
    };
  }

  function declarationSourceHref(declName) {
    var moduleName = declarationModuleOf(declName);
    if (!moduleName || !state.moduleMap[moduleName]) return "";
    var line = declarationLineOf(declName);
    return state.repoUrl + "/blob/" + encodeURIComponent(state.ref) + "/" + encodePath(state.moduleMap[moduleName]) + (line > 0 ? "#L" + line : "");
  }

  /* Source link for an interior declaration shown under a specific module —
     anchored to that module's file and the declaration's own line. */
  function interiorItemHref(moduleName, line) {
    if (!moduleName || !state.moduleMap[moduleName]) return "";
    return state.repoUrl + "/blob/" + encodeURIComponent(state.ref) + "/" + encodePath(state.moduleMap[moduleName]) + (line > 0 ? "#L" + line : "");
  }

  function isDeclNavigable(name) {
    return Boolean(state.declarationGraph[name]) || Boolean(state.declarationReverseGraph[name]);
  }

  /* ── Interior declaration model ────────────────────────────── */
  function interiorForModule(name) {
    var meta = state.moduleMeta[name];
    var byKind = (meta && meta.symbols && meta.symbols.byKind) || Object.create(null);
    var kindsPresent = Object.keys(byKind);
    var total = 0;
    for (var i = 0; i < kindsPresent.length; i++) total += byKind[kindsPresent[i]].length;
    return { byKind: byKind, kindsPresent: kindsPresent, total: total };
  }

  /* Build the adaptive set of kind groups present in a given module. */
  function interiorGroups(interior) {
    var groups = [];
    var claimed = Object.create(null);
    for (var i = 0; i < KIND_GROUPS.length; i++) {
      var def = KIND_GROUPS[i];
      var present = [];
      var count = 0;
      for (var j = 0; j < def.kinds.length; j++) {
        var kind = def.kinds[j];
        var items = interior.byKind[kind];
        if (items && items.length) {
          present.push(kind);
          count += items.length;
          claimed[kind] = true;
        }
      }
      if (present.length) groups.push({ key: def.key, label: def.label, kinds: present, count: count });
    }
    /* Any present-but-unmapped kinds fall into an adaptive "Other" column. */
    var otherKinds = [];
    var otherCount = 0;
    for (var k = 0; k < interior.kindsPresent.length; k++) {
      var pk = interior.kindsPresent[k];
      if (!claimed[pk]) { otherKinds.push(pk); otherCount += interior.byKind[pk].length; }
    }
    if (otherKinds.length) groups.push({ key: "other", label: "Other", kinds: otherKinds, count: otherCount });
    return groups;
  }

  function interiorItemsForSelection(interior, groupKinds, selectedKind, query) {
    var q = String(query || "").trim().toLowerCase();

    function byNameThenLine(a, b) {
      var byName = String(a.name).localeCompare(String(b.name), undefined, { sensitivity: "base" });
      if (byName !== 0) return byName;
      return (a.line || 0) - (b.line || 0);
    }
    function filterByQuery(list) {
      if (!q) return list;
      return list.filter(function (entry) { return entry.name.toLowerCase().indexOf(q) !== -1; });
    }

    var aggregated = [];
    var kinds = selectedKind === KIND_ALL_VALUE ? groupKinds : [selectedKind];
    for (var i = 0; i < kinds.length; i++) {
      var items = interior.byKind[kinds[i]] || [];
      for (var j = 0; j < items.length; j++) {
        aggregated.push({ name: items[j].name, line: items[j].line, __kind: kinds[i] });
      }
    }
    aggregated.sort(byNameThenLine);
    return filterByQuery(aggregated);
  }

  /* ── Selection ─────────────────────────────────────────────── */
  function selectModule(name, preserveScroll) {
    if (!name || !state.moduleMap[name]) return;
    if (state.selectedModule === name && state.flowContext === "module") {
      renderFlowNodeInteriorMenu(name);
      return;
    }
    state.selectedModule = name;
    state.flowContext = "module";
    state.selectedDeclaration = "";
    state.selectedDeclarationModule = "";
    state.declarationLanesExpanded = false;
    state.flowShowAll = false;
    state.flowScrollTarget = preserveScroll ? "" : name;
    syncUrlState();
    scheduleRender();
  }

  function selectDeclaration(declName, moduleName) {
    var mod = moduleName || declarationModuleOf(declName);
    if (!mod || !state.moduleMap[mod]) return;
    state.flowContext = "declaration";
    state.selectedDeclaration = declName;
    state.selectedDeclarationModule = mod;
    state.declarationLanesExpanded = false;
    if (state.selectedModule !== mod) {
      state.selectedModule = mod;
    }
    state.flowScrollTarget = declName;
    if (DOM.search && document.activeElement !== DOM.search) {
      DOM.search.value = mod + "." + declName;
    }
    syncUrlState();
    scheduleRender();
  }

  function returnToModuleContext() {
    state.flowContext = "module";
    state.selectedDeclaration = "";
    state.selectedDeclarationModule = "";
    state.declarationLanesExpanded = false;
    state.flowScrollTarget = state.selectedModule || "";
    syncUrlState();
    scheduleRender();
  }

  function setExpandedFlowMode() { state.flowShowAll = true; scheduleRender(); }
  function setCompactFlowMode() { state.flowShowAll = false; scheduleRender(); }
  function expandDeclarationLanes() { state.declarationLanesExpanded = true; scheduleRender(); }
  function compactDeclarationLanes() { state.declarationLanesExpanded = false; scheduleRender(); }

  /* ── Interior menu ─────────────────────────────────────────── */
  var interiorRepaintFns = [];

  function renderFlowNodeInteriorMenu(selected) {
    var menu = DOM.interiorMenu;
    if (!menu) return;

    if (!selected) {
      menu.innerHTML = "";
      interiorRepaintFns = [];
      menu.textContent = "Select a module to inspect interior declarations.";
      state.interiorMenuModule = "";
      return;
    }

    /* Only rebuild the whole menu when the module changes; otherwise repaint
       lists in place so the filter input keeps focus while typing.  This
       function is the sole owner of interiorMenuModule / interiorRepaintFns —
       callers must not pre-set them, or the change detection misfires. */
    var moduleChanged = state.interiorMenuModule !== selected;
    if (!moduleChanged && interiorRepaintFns.length) {
      for (var r = 0; r < interiorRepaintFns.length; r++) interiorRepaintFns[r]();
      return;
    }

    state.interiorMenuModule = selected;
    if (moduleChanged) {
      state.interiorMenuQuery = "";
      state.interiorMenuSelections = Object.create(null);
    }
    menu.innerHTML = "";
    interiorRepaintFns = [];

    var interior = interiorForModule(selected);
    var groups = interiorGroups(interior);
    if (!groups.length) {
      menu.textContent = "No declarations detected for " + selected + ".";
      return;
    }

    var controls = document.createElement("div");
    controls.className = "interior-menu-controls";
    var queryLabel = document.createElement("label");
    queryLabel.className = "sr-only";
    queryLabel.setAttribute("for", "interior-symbol-filter");
    queryLabel.textContent = "Filter interior declarations";
    var queryInput = document.createElement("input");
    queryInput.id = "interior-symbol-filter";
    queryInput.className = "interior-menu-search";
    queryInput.type = "search";
    queryInput.placeholder = "Filter declarations across all kinds…";
    queryInput.autocomplete = "off";
    queryInput.spellcheck = false;
    queryInput.value = state.interiorMenuQuery || "";
    queryInput.addEventListener("input", function () {
      state.interiorMenuQuery = this.value || "";
      for (var i = 0; i < interiorRepaintFns.length; i++) interiorRepaintFns[i]();
    });
    controls.appendChild(queryLabel);
    controls.appendChild(queryInput);
    menu.appendChild(controls);

    var grid = document.createElement("div");
    grid.className = "interior-menu-grid";

    groups.forEach(function (group) {
      var column = document.createElement("section");
      column.className = "interior-menu-column";

      var top = document.createElement("div");
      top.className = "interior-menu-column-top";
      var heading = document.createElement("h4");
      heading.textContent = group.label;
      top.appendChild(heading);

      var select = document.createElement("select");
      select.className = "interior-kind-select";
      select.setAttribute("aria-label", "Filter " + group.label + " by kind");
      var allOption = document.createElement("option");
      allOption.value = KIND_ALL_VALUE;
      allOption.textContent = "All (" + group.count + ")";
      select.appendChild(allOption);
      group.kinds.forEach(function (kind) {
        var option = document.createElement("option");
        option.value = kind;
        option.textContent = kindLabel(kind) + " (" + interior.byKind[kind].length + ")";
        applyKindColor(option, kind, true);
        select.appendChild(option);
      });
      if (state.interiorMenuSelections[group.key]) select.value = state.interiorMenuSelections[group.key];

      function tintSelect() {
        var active = select.value !== KIND_ALL_VALUE ? select.value : "";
        applyKindColor(select, active, false);
      }
      tintSelect();
      top.appendChild(select);
      column.appendChild(top);

      var list = document.createElement("ul");
      list.className = "interior-menu-items";
      column.appendChild(list);

      function repaint() {
        list.innerHTML = "";
        var activeKind = select.value;
        var items = interiorItemsForSelection(interior, group.kinds, activeKind, state.interiorMenuQuery);
        if (!items.length) {
          var note = document.createElement("li");
          note.className = "interior-menu-item";
          note.style.opacity = "0.7";
          note.textContent = state.interiorMenuQuery ? "No matches in this group." : "No declarations.";
          list.appendChild(note);
          return;
        }
        var frag = document.createDocumentFragment();
        items.forEach(function (item) {
          var li = document.createElement("li");
          li.className = "interior-menu-item";
          li.dataset.kindLabel = kindLabel(item.__kind || activeKind);
          applyKindColor(li, item.__kind || activeKind, false);
          if (state.flowContext === "declaration" && item.name === state.selectedDeclaration) {
            li.classList.add("interior-menu-item-active");
          }
          if (isDeclNavigable(item.name)) {
            li.classList.add("interior-menu-item-navigable");
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "interior-menu-item-btn";
            btn.textContent = item.name;
            btn.title = "View declaration call graph for " + item.name;
            btn.addEventListener("click", function () { selectDeclaration(item.name, selected); });
            li.appendChild(btn);
          } else {
            var href = interiorItemHref(selected, item.line);
            if (href) {
              var link = document.createElement("a");
              link.href = href;
              link.target = "_blank";
              link.rel = "noopener noreferrer";
              link.textContent = item.name;
              link.title = item.line > 0 ? "Open declaration at line " + item.line : "Open declaration source";
              li.appendChild(link);
            } else {
              var span = document.createElement("span");
              span.textContent = item.name;
              li.appendChild(span);
            }
          }
          frag.appendChild(li);
        });
        list.appendChild(frag);
      }

      select.addEventListener("change", function () {
        state.interiorMenuSelections[group.key] = select.value;
        tintSelect();
        repaint();
      });

      interiorRepaintFns.push(repaint);
      repaint();
      grid.appendChild(column);
    });

    menu.appendChild(grid);
  }

  /* ── SVG flow primitives ───────────────────────────────────── */
  var SVG_NS = "http://www.w3.org/2000/svg";
  function createSvgNode(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var key in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, key)) node.setAttribute(key, attrs[key]);
    }
    return node;
  }

  var LABEL_WRAP_CACHE = new Map();
  function wrapLabelLines(text, width, minChars) {
    if (!text) return [];
    var cacheKey = text + " " + width + " " + minChars;
    if (LABEL_WRAP_CACHE.has(cacheKey)) return LABEL_WRAP_CACHE.get(cacheKey).slice();

    var charWidth = prefersCompactViewport() ? 7.0 : 6.4;
    var maxChars = Math.max(minChars || 10, Math.floor((width || 180) / charWidth));
    var tokens = String(text).split(/([._\/\-]|::)/);
    var lines = [];
    var current = "";

    function pushTokenInChunks(token) {
      if (!token) return;
      if (token.length <= maxChars) { lines.push(token); return; }
      var start = 0;
      while (start < token.length) { lines.push(token.slice(start, start + maxChars)); start += maxChars; }
    }

    for (var i = 0; i < tokens.length; i++) {
      var token = tokens[i];
      if (!token) continue;
      if (token.length > maxChars && !current.length) { pushTokenInChunks(token); continue; }
      var next = current + token;
      if (next.length <= maxChars || !current.length) {
        current = next;
      } else {
        lines.push(current);
        if (token.length > maxChars) { pushTokenInChunks(token); current = ""; }
        else current = token.trim() ? token : "";
      }
    }
    if (current.length) lines.push(current);

    if (LABEL_WRAP_CACHE.size > 1500) LABEL_WRAP_CACHE.clear();
    LABEL_WRAP_CACHE.set(cacheKey, lines.slice());
    return lines;
  }

  function nodeContentHeight(name, subtitle, width, compactHint, metaLinkLabel) {
    var textAreaWidth = width - 20;
    var titleLines = wrapLabelLines(name, textAreaWidth, compactHint ? 14 : 12);
    var subtitleLines = subtitle ? wrapLabelLines(subtitle, textAreaWidth, 14) : [];
    var maxSubtitleLines = compactHint ? 2 : 3;
    if (subtitleLines.length > maxSubtitleLines) subtitleLines = subtitleLines.slice(0, maxSubtitleLines);
    var linkLines = metaLinkLabel ? wrapLabelLines(metaLinkLabel, textAreaWidth, 14) : [];
    var topPad = compactHint ? 8 : 11;
    var bottomPad = 9;
    var gap = (subtitleLines.length || linkLines.length) ? 6 : 0;
    var linkGap = (subtitleLines.length && linkLines.length) ? 3 : 0;
    var textHeight = titleLines.length * 14 + subtitleLines.length * 12 + gap + linkLines.length * 12 + linkGap;
    var minHeight = compactHint ? 36 : 46;
    return Math.max(minHeight, topPad + textHeight + bottomPad);
  }

  function drawFlowEdge(layer, from, to, color, dashed, variant) {
    var opts = variant || {};
    if (from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h) return;
    var path = createSvgNode("path", {});
    var fromCenterX = from.x + from.w / 2, fromCenterY = from.y + from.h / 2;
    var toCenterX = to.x + to.w / 2, toCenterY = to.y + to.h / 2;
    var dx = toCenterX - fromCenterX, dy = toCenterY - fromCenterY;
    var startX = fromCenterX, startY = fromCenterY, endX = toCenterX, endY = toCenterY;
    var forceVertical = Boolean(opts.vertical);
    var horizontalBias = forceVertical ? false : Math.abs(dx) >= Math.abs(dy);
    var endInset = 4;
    if (horizontalBias) {
      startX = dx >= 0 ? from.x + from.w : from.x;
      endX = dx >= 0 ? to.x + endInset : to.x + to.w - endInset;
    } else {
      startY = dy >= 0 ? from.y + from.h : from.y;
      endY = dy >= 0 ? to.y + endInset : to.y + to.h - endInset;
    }
    var distFactor = Math.sqrt(dx * dx + dy * dy);
    var offsetRatio = horizontalBias ? 0.35 : 0.30;
    var minOffset = distFactor < 80 ? Math.max(20, distFactor * 0.4) : 40;
    var controlOffset = Math.max(minOffset, Math.min(160, distFactor * offsetRatio));
    var spread = Math.max(0, Number(opts.spread) || 0);
    var rank = Math.max(0, Number(opts.rank) || 0);
    var total = Math.max(1, Number(opts.total) || 1);
    var normalizedRank = total > 1 ? (rank / (total - 1)) * 2 - 1 : 0;
    var bend = spread * normalizedRank;
    var c1x = startX, c1y = startY, c2x = endX, c2y = endY;
    if (horizontalBias) {
      c1x = startX + (dx >= 0 ? controlOffset : -controlOffset);
      c2x = endX - (dx >= 0 ? controlOffset : -controlOffset);
      c1y += bend; c2y += bend;
    } else {
      c1y = startY + (dy >= 0 ? controlOffset : -controlOffset);
      c2y = endY - (dy >= 0 ? controlOffset : -controlOffset);
      c1x += bend; c2x += bend;
    }
    path.setAttribute("d", "M " + startX + " " + startY + " C " + c1x + " " + c1y + ", " + c2x + " " + c2y + ", " + endX + " " + endY);
    path.setAttribute("class", "flow-line" + (dashed ? " proof-link" : ""));
    path.setAttribute("stroke", color);
    path.style.color = color;
    path.setAttribute("marker-end", "url(#flow-arrow)");
    layer.appendChild(path);
  }

  function createFlowSvg(flowWidth, flowHeight, ariaLabel) {
    var svg = createSvgNode("svg", {
      "class": "flowchart-svg", width: flowWidth, height: flowHeight,
      viewBox: "0 0 " + flowWidth + " " + flowHeight,
      role: "group", "aria-roledescription": "flowchart", "aria-label": ariaLabel
    });
    var defs = createSvgNode("defs", {});
    var marker = createSvgNode("marker", {
      id: "flow-arrow", viewBox: "0 0 10 10", refX: "9", refY: "5",
      markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse"
    });
    marker.appendChild(createSvgNode("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "currentColor" }));
    defs.appendChild(marker);
    svg.appendChild(defs);

    var edgeLayer = createSvgNode("g", { "class": "flow-edge-layer", "aria-hidden": "true" });
    var nodeLayer = createSvgNode("g", { "class": "flow-node-layer" });
    var labelLayer = createSvgNode("g", { "class": "flow-label-layer" });

    return {
      svg: svg, edgeLayer: edgeLayer, nodeLayer: nodeLayer, labelLayer: labelLayer,
      flush: function () { svg.appendChild(edgeLayer); svg.appendChild(nodeLayer); svg.appendChild(labelLayer); }
    };
  }

  function createFlowLegend(items, ariaLabel) {
    var legend = document.createElement("div");
    legend.className = "flowchart-legend flowchart-legend-corner";
    legend.setAttribute("role", "list");
    legend.setAttribute("aria-label", ariaLabel);
    items.forEach(function (item) {
      if (item.separator) {
        var sep = document.createElement("span");
        sep.className = "legend-separator";
        sep.setAttribute("role", "separator");
        sep.setAttribute("aria-hidden", "true");
        legend.appendChild(sep);
        return;
      }
      var chip = document.createElement("span");
      chip.className = "legend-item legend-edge";
      chip.setAttribute("role", "listitem");
      var swatch = document.createElement("span");
      swatch.className = "legend-swatch";
      swatch.setAttribute("aria-hidden", "true");
      swatch.style.backgroundColor = item.color;
      chip.appendChild(swatch);
      chip.appendChild(document.createTextNode(item.label));
      legend.appendChild(chip);
    });
    return legend;
  }

  function flowLaneLabel(labelLayer, text, x, y, color) {
    var label = createSvgNode("text", { x: x, y: y, fill: color, "font-size": "12", "class": "flow-lane-label" });
    label.textContent = text;
    labelLayer.appendChild(label);
  }

  function applyFlowScrollTarget(wrap, targetName, centerX, centerY, centerW, centerH) {
    if (state.flowScrollTarget !== targetName) return false;
    var targetScrollLeft = Math.max(0, centerX + centerW / 2 - wrap.clientWidth / 2);
    var targetScrollTop = Math.max(0, centerY + centerH / 2 - wrap.clientHeight / 2);
    var maxScrollLeft = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    var maxScrollTop = Math.max(0, wrap.scrollHeight - wrap.clientHeight);
    wrap.style.scrollBehavior = "auto";
    wrap.scrollLeft = Math.min(maxScrollLeft, targetScrollLeft);
    wrap.scrollTop = Math.min(maxScrollTop, targetScrollTop);
    wrap.style.removeProperty("scroll-behavior");
    state.flowScrollTarget = "";
    return true;
  }

  var flowClipIdCounter = 0;
  function buildFlowNodeGroup(nodeLayer, className, focusable, ariaLabel, name, x, y, w, h, color, subtitle, tooltip, onActivate, metaLink) {
    var group = createSvgNode("g", { "class": className, tabindex: focusable ? "0" : "-1", role: onActivate ? "button" : "img", "aria-label": ariaLabel });
    if (focusable) group.setAttribute("focusable", "true");

    var clipId = "fc" + (++flowClipIdCounter);
    var clipPath = createSvgNode("clipPath", { id: clipId });
    clipPath.appendChild(createSvgNode("rect", { x: x, y: y, width: w, height: h, rx: 10, ry: 10 }));
    group.appendChild(clipPath);

    var rect = createSvgNode("rect", { x: x, y: y, width: w, height: h, fill: "var(--flow-node-bg)", stroke: color });
    var full = createSvgNode("title", {});
    full.textContent = tooltip || name;

    var textOffsetX = 10;
    var compactNode = h < 46;
    var textAreaWidth = w - 20;
    var titleBaseY = compactNode ? 17 : 20;
    var title = createSvgNode("text", { x: x + textOffsetX, y: y + titleBaseY });
    var titleLines = wrapLabelLines(name, textAreaWidth, compactNode ? 14 : 12);
    for (var ll = 0; ll < titleLines.length; ll++) {
      var tspan = createSvgNode("tspan", { x: x + textOffsetX, dy: ll === 0 ? "0" : "14" });
      tspan.textContent = titleLines[ll];
      title.appendChild(tspan);
    }

    group.appendChild(full);
    group.appendChild(rect);

    var contentGroup = createSvgNode("g", { "clip-path": "url(#" + clipId + ")" });
    contentGroup.appendChild(title);

    if ((subtitle || (metaLink && metaLink.label)) && h >= 34) {
      var subtitleLines = wrapLabelLines(subtitle, textAreaWidth, 14);
      var maxSubtitleLines = compactNode ? 2 : 3;
      var subtitleTruncated = subtitleLines.length > maxSubtitleLines;
      if (subtitleTruncated) subtitleLines = subtitleLines.slice(0, maxSubtitleLines);
      var subtitleStartY = y + titleBaseY + (Math.max(1, titleLines.length) - 1) * 14 + 14;
      var meta = createSvgNode("text", { x: x + textOffsetX, y: subtitleStartY, "class": "flow-meta" });
      for (var mm = 0; mm < subtitleLines.length; mm++) {
        var metaSpan = createSvgNode("tspan", { x: x + textOffsetX, dy: mm === 0 ? "0" : "12" });
        var lineText = subtitleLines[mm];
        if (subtitleTruncated && mm === subtitleLines.length - 1) lineText += "…";
        metaSpan.textContent = lineText;
        meta.appendChild(metaSpan);
      }
      if (metaLink && metaLink.href && metaLink.label) {
        var link = createSvgNode("a", { href: metaLink.href, target: "_blank", rel: "noopener noreferrer", "aria-label": metaLink.title || ("Open source for " + name) });
        var linkLines = wrapLabelLines(metaLink.label, textAreaWidth, 14);
        for (var li = 0; li < linkLines.length; li++) {
          var linkSpan = createSvgNode("tspan", { x: x + textOffsetX, dy: (li === 0 && subtitleLines.length) ? "12" : (li === 0 ? "0" : "12"), "class": "flow-meta-link" });
          linkSpan.textContent = linkLines[li];
          link.appendChild(linkSpan);
        }
        meta.appendChild(link);
      }
      contentGroup.appendChild(meta);
    }

    group.appendChild(contentGroup);

    if (onActivate) {
      group.addEventListener("click", function () { onActivate(); });
      group.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onActivate(); }
      });
    }

    nodeLayer.appendChild(group);
    return { name: name, x: x, y: y, w: w, h: h };
  }

  function computeFlowLayout() {
    var wrap = DOM.flowWrap;
    var wrapWidth = Math.max(0, ((wrap && wrap.clientWidth) || 0) - 8);
    var flowWidth = Math.max(minimumFlowWidth(), wrapWidth || 0);
    var compact = prefersCompactViewport();
    var framePad = compact ? Math.max(14, Math.round(flowWidth * 0.018)) : 34;
    var laneGap = compact ? Math.max(12, Math.round(flowWidth * 0.016)) : 24;
    var centerRatio = compact ? 0.30 : 0.28;
    var minCenter = compact ? 220 : 300;
    var centerWidth = Math.min(380, Math.max(minCenter, Math.floor(flowWidth * centerRatio)));
    var availableSideWidth = Math.floor((flowWidth - framePad * 2 - centerWidth - laneGap * 2) / 2);
    var sideWidth = Math.min(360, Math.max(compact ? 200 : 240, availableSideWidth));
    var leftX = framePad;
    var centerX = leftX + sideWidth + laneGap;
    var rightX = centerX + centerWidth + laneGap;
    return {
      flowWidth: flowWidth, framePad: framePad, laneGap: laneGap,
      centerWidth: centerWidth, sideWidth: sideWidth,
      leftX: leftX, centerX: centerX, rightX: rightX,
      laneYStart: compact ? 52 : 62, laneGapY: compact ? 8 : 10
    };
  }

  var cachedMinFlowWidth = 0;
  var cachedMinFlowWidthTs = 0;
  function minimumFlowWidth() {
    var now = Date.now();
    if (cachedMinFlowWidth > 0 && now - cachedMinFlowWidthTs < 200) return cachedMinFlowWidth;
    var width = window.innerWidth || 1200;
    var result;
    if (width <= 420) result = Math.max(720, Math.round(width * 2.25));
    else if (width <= 640) result = Math.max(820, Math.round(width * 2.1));
    else if (width <= 900) result = Math.max(920, Math.round(width * 1.4));
    else result = 1180;
    cachedMinFlowWidth = result;
    cachedMinFlowWidthTs = now;
    return result;
  }

  /* ── Module flow chart ─────────────────────────────────────── */
  function moduleFlowLegendItems() {
    return [
      { label: "Selected module", color: COLOR_SELECTED },
      { label: "Depends on (outgoing)", color: COLOR_DEPENDS },
      { label: "Used by (incoming)", color: COLOR_USED_BY }
    ];
  }

  function renderFlowchart() {
    var wrap = DOM.flowWrap;
    if (!wrap) return;
    var shouldPreserveScroll = !prefersCompactViewport() && !state.flowScrollTarget;
    var previousScrollLeft = shouldPreserveScroll ? wrap.scrollLeft : 0;
    var previousScrollTop = shouldPreserveScroll ? wrap.scrollTop : 0;
    wrap.innerHTML = "";
    flowClipIdCounter = 0;

    var selected = state.selectedModule;
    if (!selected) {
      renderFlowNodeInteriorMenu("");
      wrap.textContent = "Select a module to render its dependency flow.";
      return;
    }

    var allImports = (state.importsFrom[selected] || []).slice().sort(sortByScoreThenName);
    var allImporters = (state.importsTo[selected] || []).slice().sort(sortByScoreThenName);
    var budget = state.flowShowAll ? Infinity : state.neighborLimit;
    var imports = allImports.slice(0, budget);
    var importers = allImporters.slice(0, budget);

    function moduleSummary(name) {
      var degree = moduleDegree(name);
      var parts = [degree.decls + " decl"];
      parts.push("←" + degree.incoming + " →" + degree.outgoing);
      return parts.join(" · ");
    }
    function nodeTooltip(name, roleLabel) {
      var degree = moduleDegree(name);
      var path = state.moduleMap[name] || "";
      return roleLabel + "\n" + name + (path ? "\npath: " + path : "") +
        "\ndeclarations: " + degree.decls + " | depends on: " + degree.outgoing + " | used by: " + degree.incoming;
    }

    var layout = computeFlowLayout();
    var flowWidth = layout.flowWidth, framePad = layout.framePad;
    var centerWidth = layout.centerWidth, sideWidth = layout.sideWidth;
    var leftX = layout.leftX, centerX = layout.centerX, rightX = layout.rightX;
    var laneYStart = layout.laneYStart, laneGapY = layout.laneGapY;

    function stackedLayout(names, width) {
      var nodes = [];
      var cursor = laneYStart;
      for (var i = 0; i < names.length; i++) {
        var subtitle = moduleSummary(names[i]);
        var srcLink = moduleSourceLink(names[i]);
        var height = nodeContentHeight(names[i], subtitle, width, false, srcLink ? srcLink.label : "");
        nodes.push({ name: names[i], y: cursor, h: height, subtitle: subtitle, sourceLink: srcLink });
        cursor += height + laneGapY;
      }
      return { nodes: nodes, bottom: names.length ? (cursor - laneGapY) : laneYStart + 44 };
    }

    var importLayout = stackedLayout(imports, sideWidth);
    var importerLayout = stackedLayout(importers, sideWidth);
    var laneBottom = Math.max(importLayout.bottom, importerLayout.bottom);

    var centerSourceLink = moduleSourceLink(selected);
    var centerHeight = nodeContentHeight(selected, moduleSummary(selected), centerWidth, false, centerSourceLink ? centerSourceLink.label : "") + 14;
    var laneContentHeight = laneBottom - laneYStart;
    var idealCenterY = laneYStart + Math.floor((laneContentHeight - centerHeight) / 2);
    var hasLeft = importLayout.nodes.length > 0;
    var hasRight = importerLayout.nodes.length > 0;
    var minCenterY, maxCenterY;
    if (!hasLeft && !hasRight) {
      minCenterY = laneYStart; maxCenterY = laneYStart + 40;
    } else if (hasLeft !== hasRight) {
      var populatedHeight = (hasLeft ? importLayout.bottom : importerLayout.bottom) - laneYStart;
      minCenterY = laneYStart + Math.min(10, Math.floor(populatedHeight * 0.1));
      maxCenterY = Math.max(minCenterY, laneYStart + Math.floor(populatedHeight * 0.45));
    } else {
      minCenterY = laneYStart + Math.min(20, Math.floor(laneContentHeight * 0.15));
      maxCenterY = Math.max(minCenterY, laneYStart + Math.floor(laneContentHeight * 0.5));
    }
    var centerY = Math.max(minCenterY, Math.min(maxCenterY, idealCenterY));
    var centerBottom = centerY + centerHeight;

    var minFlowHeight = prefersCompactViewport() ? 420 : 560;
    var flowHeight = Math.max(minFlowHeight, Math.max(laneBottom, centerBottom) + 40);

    wrap.appendChild(createFlowLegend(moduleFlowLegendItems(), "Module flow chart legend"));

    var ariaLabel = "Flow chart for " + selected + ": depends on " + allImports.length + " module" + (allImports.length === 1 ? "" : "s") + ", used by " + allImporters.length + " module" + (allImporters.length === 1 ? "" : "s");
    var flowSvg = createFlowSvg(flowWidth, flowHeight, ariaLabel);
    var edgeLayer = flowSvg.edgeLayer, nodeLayer = flowSvg.nodeLayer, labelLayer = flowSvg.labelLayer;

    function createNode(name, x, y, w, h, color, subtitle, tooltip, active, isStatic, onActivate, metaLink) {
      var className = "flow-node" + (active ? " active" : "") + (isStatic ? " static" : "");
      if (onActivate) className += " action";
      var interactive = !isStatic || Boolean(onActivate);
      var ariaLbl = interactive ? (onActivate ? name : "Select module " + name) : name;
      var activator = interactive ? (onActivate || function () { selectModule(name, false); }) : null;
      return buildFlowNodeGroup(nodeLayer, className, interactive, ariaLbl, name, x, y, w, h, color, subtitle, tooltip, activator, metaLink || null);
    }

    if (hasLeft) flowLaneLabel(labelLayer, "Depends on", leftX, 30, COLOR_DEPENDS);
    if (hasLeft || hasRight) flowLaneLabel(labelLayer, "Selected module", centerX, centerY - 12, COLOR_SELECTED);
    if (hasRight) flowLaneLabel(labelLayer, "Used by", rightX, 30, COLOR_USED_BY);

    var center = createNode(selected, centerX, centerY, centerWidth, centerHeight, COLOR_SELECTED, moduleSummary(selected), nodeTooltip(selected, "Selected module"), true, false, null, centerSourceLink);

    var importNodes = [];
    importLayout.nodes.forEach(function (item) {
      importNodes.push(createNode(item.name, leftX, item.y, sideWidth, item.h, COLOR_DEPENDS, item.subtitle, nodeTooltip(item.name, "Dependency"), false, false, null, item.sourceLink));
    });
    var importerNodes = [];
    importerLayout.nodes.forEach(function (item) {
      importerNodes.push(createNode(item.name, rightX, item.y, sideWidth, item.h, COLOR_USED_BY, item.subtitle, nodeTooltip(item.name, "Dependent module"), false, false, null, item.sourceLink));
    });

    if (allImports.length > imports.length) {
      createNode("+" + (allImports.length - imports.length) + " more", leftX, importLayout.bottom + laneGapY, sideWidth, 36, COLOR_DEPENDS, "show all dependencies", "Show all dependencies", false, true, setExpandedFlowMode);
    } else if (state.flowShowAll && allImports.length > state.neighborLimit) {
      createNode("Show fewer", leftX, importLayout.bottom + laneGapY, sideWidth, 36, COLOR_DEPENDS, "collapse dependencies", "Collapse dependencies", false, true, setCompactFlowMode);
    }
    if (allImporters.length > importers.length) {
      createNode("+" + (allImporters.length - importers.length) + " more", rightX, importerLayout.bottom + laneGapY, sideWidth, 36, COLOR_USED_BY, "show all dependents", "Show all dependents", false, true, setExpandedFlowMode);
    } else if (state.flowShowAll && allImporters.length > state.neighborLimit) {
      createNode("Show fewer", rightX, importerLayout.bottom + laneGapY, sideWidth, 36, COLOR_USED_BY, "collapse dependents", "Collapse dependents", false, true, setCompactFlowMode);
    }

    var importSpread = Math.min(64, Math.max(14, Math.round(14 + Math.sqrt(Math.max(1, importNodes.length)) * 6)));
    var importerSpread = Math.min(64, Math.max(14, Math.round(14 + Math.sqrt(Math.max(1, importerNodes.length)) * 6)));
    for (var k = 0; k < importNodes.length; k++) {
      drawFlowEdge(edgeLayer, importNodes[k], center, COLOR_DEPENDS, false, { rank: k, total: importNodes.length, spread: importSpread });
    }
    for (var m = 0; m < importerNodes.length; m++) {
      drawFlowEdge(edgeLayer, center, importerNodes[m], COLOR_USED_BY, false, { rank: m, total: importerNodes.length, spread: importerSpread });
    }

    if (!hasLeft && !hasRight) {
      var hint = createSvgNode("text", { x: centerX, y: centerBottom + 28, fill: COLOR_NEUTRAL, "font-size": "12", "class": "flow-lane-label" });
      hint.textContent = "No cross-module call relationships detected for this module.";
      labelLayer.appendChild(hint);
    }

    flowSvg.flush();
    wrap.appendChild(flowSvg.svg);

    renderFlowNodeInteriorMenu(selected);

    if (!applyFlowScrollTarget(wrap, selected, center.x, center.y, center.w, center.h)) {
      wrap.style.scrollBehavior = "auto";
      wrap.scrollLeft = previousScrollLeft;
      wrap.scrollTop = previousScrollTop;
      wrap.style.removeProperty("scroll-behavior");
    }
  }

  /* ── Declaration flow chart ────────────────────────────────── */
  function declarationFlowLegendItems() {
    return [
      { label: "Selected declaration", color: COLOR_SELECTED },
      { label: "Calls (outgoing)", color: COLOR_CALLS },
      { label: "Called by (incoming)", color: COLOR_USED_BY },
      { separator: true },
      { label: "Border = declaration kind", color: COLOR_NEUTRAL },
      { label: "Dashed = cross-module", color: COLOR_NEUTRAL }
    ];
  }

  function renderDeclarationFlowchart() {
    var wrap = DOM.flowWrap;
    if (!wrap) return;
    var shouldPreserveScroll = !prefersCompactViewport() && !state.flowScrollTarget;
    var previousScrollLeft = shouldPreserveScroll ? wrap.scrollLeft : 0;
    var previousScrollTop = shouldPreserveScroll ? wrap.scrollTop : 0;
    wrap.innerHTML = "";
    flowClipIdCounter = 0;

    var declName = state.selectedDeclaration;
    var moduleName = state.selectedDeclarationModule;
    if (!declName || !moduleName) { returnToModuleContext(); return; }

    var calls = declarationCalls(declName);
    var calledBy = declarationCalledBy(declName);

    var breadcrumb = document.createElement("nav");
    breadcrumb.className = "declaration-context-breadcrumb";
    breadcrumb.setAttribute("aria-label", "Declaration breadcrumb");
    var moduleLabel = document.createElement("button");
    moduleLabel.className = "btn btn-secondary declaration-breadcrumb-module";
    moduleLabel.type = "button";
    moduleLabel.textContent = moduleName;
    moduleLabel.title = "Return to module context for " + moduleName;
    moduleLabel.addEventListener("click", returnToModuleContext);
    breadcrumb.appendChild(moduleLabel);
    var separator = document.createElement("span");
    separator.className = "breadcrumb-separator";
    separator.setAttribute("aria-hidden", "true");
    separator.textContent = " › ";
    breadcrumb.appendChild(separator);
    var declLabel = document.createElement("span");
    declLabel.className = "breadcrumb-current";
    declLabel.textContent = declName;
    breadcrumb.appendChild(declLabel);
    wrap.appendChild(breadcrumb);

    var layout = computeFlowLayout();
    var flowWidth = layout.flowWidth;
    var centerWidth = layout.centerWidth, sideWidth = layout.sideWidth;
    var leftX = layout.leftX, centerX = layout.centerX, rightX = layout.rightX;
    var laneYStart = layout.laneYStart, laneGapY = layout.laneGapY;

    function declSummary(name) {
      var kind = declarationKindOf(name);
      var mod = declarationModuleOf(name);
      var line = declarationLineOf(name);
      var parts = [];
      if (kind) parts.push(kindLabel(kind));
      if (mod) parts.push((mod !== moduleName ? "→ " : "in ") + mod);
      if (line > 0) parts.push("L" + line);
      var outgoing = declarationCalls(name).length;
      var incoming = declarationCalledBy(name).length;
      if (outgoing > 0 || incoming > 0) parts.push("←" + incoming + " →" + outgoing);
      return parts.join(" · ") || "declaration";
    }
    function declMetaLink(name) {
      var line = declarationLineOf(name);
      if (!(line > 0)) return null;
      var href = declarationSourceHref(name);
      if (!href) return null;
      return { href: href, label: "L" + line, title: "Open declaration source at line " + line };
    }
    function declTooltip(name, roleLabel) {
      var kind = declarationKindOf(name);
      var mod = declarationModuleOf(name);
      var line = declarationLineOf(name);
      return roleLabel + "\n" + name + (kind ? "\nkind: " + kind : "") + (mod ? "\nmodule: " + mod : "") + (line > 0 ? "\nline: " + line : "") + "\ncalls: " + (declarationCalls(name).length || "none");
    }
    function declNodeColor(name) {
      var kind = declarationKindOf(name);
      if (!kind) return COLOR_NEUTRAL;
      var raw = kindColor(kind);
      var declMod = declarationModuleOf(name);
      if (declMod && declMod !== moduleName) return blendHexColor(raw, COLOR_NEUTRAL, 0.45);
      return raw;
    }
    function sortByModuleRelevance(arr) {
      return arr.slice().sort(function (a, b) {
        var sameA = declarationModuleOf(a) === moduleName ? 0 : 1;
        var sameB = declarationModuleOf(b) === moduleName ? 0 : 1;
        if (sameA !== sameB) return sameA - sameB;
        return a.toLowerCase().localeCompare(b.toLowerCase());
      });
    }

    var COLLAPSE_THRESHOLD = 12, VISIBLE_LIMIT = 10;
    var sortedCalls = calls.length > COLLAPSE_THRESHOLD ? sortByModuleRelevance(calls) : calls;
    var sortedCallers = calledBy.length > COLLAPSE_THRESHOLD ? sortByModuleRelevance(calledBy) : calledBy;
    var visibleCalls = sortedCalls, collapsedCallCount = 0;
    var visibleCallers = sortedCallers, collapsedCallerCount = 0;
    if (!state.declarationLanesExpanded) {
      if (sortedCalls.length > COLLAPSE_THRESHOLD) { visibleCalls = sortedCalls.slice(0, VISIBLE_LIMIT); collapsedCallCount = sortedCalls.length - VISIBLE_LIMIT; }
      if (sortedCallers.length > COLLAPSE_THRESHOLD) { visibleCallers = sortedCallers.slice(0, VISIBLE_LIMIT); collapsedCallerCount = sortedCallers.length - VISIBLE_LIMIT; }
    }
    var canCompactCalls = state.declarationLanesExpanded && sortedCalls.length > COLLAPSE_THRESHOLD;
    var canCompactCallers = state.declarationLanesExpanded && sortedCallers.length > COLLAPSE_THRESHOLD;

    function buildLane(visible, collapsedCount, canCompact) {
      var lane = [];
      var cursor = laneYStart;
      visible.forEach(function (name) {
        var metaLink = declMetaLink(name);
        var h = nodeContentHeight(name, declSummary(name), sideWidth, true, metaLink ? metaLink.label : "");
        lane.push({ name: name, y: cursor, h: h, metaLink: metaLink });
        cursor += h + laneGapY;
      });
      if (collapsedCount > 0) {
        var label = "+" + collapsedCount + " more";
        var ch = nodeContentHeight(label, "expand to show all", sideWidth, true, "");
        lane.push({ name: label, y: cursor, h: ch, expandable: true });
        cursor += ch + laneGapY;
      }
      if (canCompact) {
        var clabel = "Show fewer";
        var cch = nodeContentHeight(clabel, "collapse list", sideWidth, true, "");
        lane.push({ name: clabel, y: cursor, h: cch, compactControl: true });
        cursor += cch + laneGapY;
      }
      return { lane: lane, bottom: lane.length ? cursor - laneGapY : laneYStart + 44 };
    }

    var callLane = buildLane(visibleCalls, collapsedCallCount, canCompactCalls);
    var callerLane = buildLane(visibleCallers, collapsedCallerCount, canCompactCallers);

    var centerMetaLink = declMetaLink(declName);
    var centerHeight = nodeContentHeight(declName, declSummary(declName), centerWidth, false, centerMetaLink ? centerMetaLink.label : "") + 14;
    var laneContentHeight = Math.max(callLane.bottom, callerLane.bottom) - laneYStart;
    var idealCenterY = laneYStart + Math.floor((laneContentHeight - centerHeight) / 2);
    var minCenterY = Math.max(laneYStart + 20, Math.min(170, laneYStart + Math.floor(laneContentHeight * 0.25)));
    var centerY = Math.max(minCenterY, idealCenterY);
    var minFlowHeight = prefersCompactViewport() ? 420 : 560;
    var flowHeight = Math.max(minFlowHeight, Math.max(callLane.bottom, callerLane.bottom, centerY + centerHeight) + 60);

    wrap.appendChild(createFlowLegend(declarationFlowLegendItems(), "Declaration flow chart legend"));

    var flowSvg = createFlowSvg(flowWidth, flowHeight, "Declaration flow chart for " + declName + ", calls " + calls.length + ", called by " + calledBy.length);
    var edgeLayer = flowSvg.edgeLayer, nodeLayer = flowSvg.nodeLayer, labelLayer = flowSvg.labelLayer;

    function createDeclNode(name, x, y, w, h, color, subtitle, tooltip, active, onActivate, metaLink) {
      var className = "flow-node" + (active ? " active" : "");
      if (onActivate) className += " action";
      var declMod = declarationModuleOf(name);
      if (declMod && declMod !== moduleName) className += " cross-module";
      var interactive = Boolean(onActivate);
      var ariaLbl = interactive ? "Select declaration " + name : name;
      return buildFlowNodeGroup(nodeLayer, className, interactive || active, ariaLbl, name, x, y, w, h, color, subtitle, tooltip, onActivate || null, metaLink || null);
    }

    var hasCallees = calls.length > 0, hasCallers = calledBy.length > 0;
    if (hasCallees) flowLaneLabel(labelLayer, "Calls (outgoing)", leftX, 30, COLOR_CALLS);
    flowLaneLabel(labelLayer, "Selected declaration", centerX, centerY - 12, COLOR_SELECTED);
    if (hasCallers) flowLaneLabel(labelLayer, "Called by (incoming)", rightX, 30, COLOR_USED_BY);

    if (!hasCallees && !hasCallers) {
      var emptyHint = createSvgNode("text", { x: centerX, y: centerY + centerHeight + 28, fill: COLOR_NEUTRAL, "font-size": "12", "class": "flow-lane-label" });
      var k = declarationKindOf(declName);
      emptyHint.textContent = k ? "This " + k + " has no detected call relationships." : "No call relationships detected for this declaration.";
      labelLayer.appendChild(emptyHint);
      var returnHint = createSvgNode("text", { x: centerX, y: centerY + centerHeight + 46, fill: COLOR_NEUTRAL, "font-size": "11", "class": "flow-lane-label" });
      returnHint.textContent = "Use the breadcrumb above to return to module context.";
      labelLayer.appendChild(returnHint);
    }

    var center = createDeclNode(declName, centerX, centerY, centerWidth, centerHeight, COLOR_SELECTED, declSummary(declName), declTooltip(declName, "Selected declaration"), true, null, centerMetaLink);

    var callNodes = [];
    callLane.lane.forEach(function (item) {
      if (item.expandable) {
        callNodes.push({ node: createDeclNode(item.name, leftX, item.y, sideWidth, item.h, COLOR_CALLS, "expand to show all", "Expand all called declarations", false, expandDeclarationLanes, null), edge: true, dashed: true });
      } else if (item.compactControl) {
        callNodes.push({ node: createDeclNode(item.name, leftX, item.y, sideWidth, item.h, COLOR_CALLS, "collapse list", "Return to compact view", false, compactDeclarationLanes, null), edge: false });
      } else {
        var navigable = isDeclNavigable(item.name);
        callNodes.push({ node: createDeclNode(item.name, leftX, item.y, sideWidth, item.h, declNodeColor(item.name), declSummary(item.name), declTooltip(item.name, "Called declaration"), false, navigable ? function () { selectDeclaration(item.name); } : null, item.metaLink || null), edge: true, dashed: false });
      }
    });

    var callerNodes = [];
    callerLane.lane.forEach(function (item) {
      if (item.expandable) {
        callerNodes.push({ node: createDeclNode(item.name, rightX, item.y, sideWidth, item.h, COLOR_USED_BY, "expand to show all", "Expand all caller declarations", false, expandDeclarationLanes, null), edge: true, dashed: true });
      } else if (item.compactControl) {
        callerNodes.push({ node: createDeclNode(item.name, rightX, item.y, sideWidth, item.h, COLOR_USED_BY, "collapse list", "Return to compact view", false, compactDeclarationLanes, null), edge: false });
      } else {
        var nav = isDeclNavigable(item.name);
        callerNodes.push({ node: createDeclNode(item.name, rightX, item.y, sideWidth, item.h, declNodeColor(item.name), declSummary(item.name), declTooltip(item.name, "Caller declaration"), false, nav ? function () { selectDeclaration(item.name); } : null, item.metaLink || null), edge: true, dashed: false });
      }
    });

    var callEdgeTotal = callNodes.filter(function (n) { return n.edge; }).length;
    var callerEdgeTotal = callerNodes.filter(function (n) { return n.edge; }).length;
    var callSpread = Math.min(64, Math.max(14, Math.round(14 + Math.sqrt(Math.max(1, callEdgeTotal)) * 6)));
    var callerSpread = Math.min(64, Math.max(14, Math.round(14 + Math.sqrt(Math.max(1, callerEdgeTotal)) * 6)));
    var idx = 0;
    callNodes.forEach(function (n) {
      if (!n.edge) return;
      drawFlowEdge(edgeLayer, center, n.node, COLOR_CALLS, n.dashed, { rank: idx, total: callEdgeTotal, spread: callSpread });
      idx++;
    });
    idx = 0;
    callerNodes.forEach(function (n) {
      if (!n.edge) return;
      drawFlowEdge(edgeLayer, n.node, center, COLOR_USED_BY, n.dashed, { rank: idx, total: callerEdgeTotal, spread: callerSpread });
      idx++;
    });

    flowSvg.flush();
    wrap.appendChild(flowSvg.svg);

    renderFlowNodeInteriorMenu(moduleName);

    if (!applyFlowScrollTarget(wrap, declName, center.x, center.y, center.w, center.h)) {
      wrap.style.scrollBehavior = "auto";
      wrap.scrollLeft = previousScrollLeft;
      wrap.scrollTop = previousScrollTop;
      wrap.style.removeProperty("scroll-behavior");
    }
  }

  /* ── Stats ─────────────────────────────────────────────────── */
  function renderStats() {
    if (!DOM.stats || !state.stats) return;
    var s = state.stats;
    var cards = [
      { title: "Modules", value: s.moduleCount },
      { title: "Declarations", value: s.declarationCount },
      { title: "Cross-module links", value: s.crossModuleLinks },
      { title: "Call references", value: s.callRefs }
    ];
    /* Append the three most common declaration kinds for this codebase. */
    var kinds = Object.keys(s.kindCounts).map(function (k) { return { kind: k, count: s.kindCounts[k] }; });
    kinds.sort(function (a, b) { return b.count - a.count; });
    for (var i = 0; i < Math.min(3, kinds.length); i++) {
      cards.push({ title: kindLabel(kinds[i].kind), value: kinds[i].count });
    }

    DOM.stats.innerHTML = "";
    var frag = document.createDocumentFragment();
    cards.forEach(function (card) {
      var div = document.createElement("div");
      div.className = "stat-card";
      var title = document.createElement("span");
      title.className = "stat-title";
      title.textContent = card.title;
      var strong = document.createElement("strong");
      strong.textContent = formatNumber(card.value);
      div.appendChild(title);
      div.appendChild(strong);
      frag.appendChild(div);
    });
    DOM.stats.appendChild(frag);
  }

  function formatNumber(value) {
    var n = Number(value) || 0;
    return n.toLocaleString("en-US");
  }

  /* ── Search ────────────────────────────────────────────────── */
  function moduleSearchMatches(query, limit) {
    var q = query.toLowerCase();
    var matches = [];
    var list = sortedModuleList();
    for (var i = 0; i < list.length && matches.length < limit; i++) {
      if (list[i].toLowerCase().indexOf(q) !== -1) matches.push({ type: "module", module: list[i] });
    }
    return matches;
  }

  function declarationSearchMatches(query, limit) {
    var raw = query.toLowerCase();
    var suffix = raw.indexOf(".") !== -1 ? raw.slice(raw.lastIndexOf(".") + 1) : raw;
    if (!suffix) return [];
    var matches = [];
    var names = Object.keys(state.declarationIndex);
    for (var i = 0; i < names.length && matches.length < limit; i++) {
      if (names[i].toLowerCase().indexOf(suffix) !== -1) {
        var idx = state.declarationIndex[names[i]];
        matches.push({ type: "decl", decl: names[i], module: idx.module, kind: idx.kind });
      }
    }
    return matches;
  }

  function closeSearchOptions() {
    if (!DOM.searchOptions) return;
    DOM.searchOptions.hidden = true;
    DOM.searchOptions.innerHTML = "";
    if (DOM.search) DOM.search.setAttribute("aria-expanded", "false");
    state.searchVisibleOptions = [];
    state.searchActiveOption = -1;
  }

  function openSearchOptions(matches) {
    if (!DOM.searchOptions) return;
    DOM.searchOptions.innerHTML = "";
    if (!matches.length) { closeSearchOptions(); return; }
    var frag = document.createDocumentFragment();
    matches.forEach(function (match, index) {
      var li = document.createElement("li");
      li.className = "module-search-option";
      li.setAttribute("role", "option");
      li.id = "module-search-option-" + index;
      if (match.type === "module") {
        li.textContent = match.module;
      } else {
        li.classList.add("module-search-option-decl");
        li.textContent = match.decl + "  —  " + kindLabel(match.kind) + " in " + match.module;
      }
      li.addEventListener("mousedown", function (event) {
        event.preventDefault();
        chooseSearchMatch(match);
      });
      frag.appendChild(li);
    });
    DOM.searchOptions.appendChild(frag);
    DOM.searchOptions.hidden = false;
    if (DOM.search) DOM.search.setAttribute("aria-expanded", "true");
    state.searchVisibleOptions = matches;
    state.searchActiveOption = -1;
  }

  function setActiveSearchOption(index) {
    var options = DOM.searchOptions ? DOM.searchOptions.querySelectorAll(".module-search-option") : [];
    for (var i = 0; i < options.length; i++) {
      var isActive = i === index;
      options[i].setAttribute("aria-selected", isActive ? "true" : "false");
      if (isActive) {
        options[i].scrollIntoView({ block: "nearest" });
        if (DOM.search) DOM.search.setAttribute("aria-activedescendant", options[i].id);
      }
    }
    state.searchActiveOption = index;
    if (index < 0 && DOM.search) DOM.search.removeAttribute("aria-activedescendant");
  }

  function chooseSearchMatch(match) {
    closeSearchOptions();
    if (match.type === "module") {
      selectModule(match.module, false);
      if (DOM.search) DOM.search.value = match.module;
    } else {
      selectDeclaration(match.decl, match.module);
    }
  }

  function refreshSearchSuggestions() {
    if (!DOM.search) return;
    var value = DOM.search.value.trim();
    if (!value) { closeSearchOptions(); setSearchFeedback(""); return; }
    var moduleMatches = moduleSearchMatches(value, 6);
    var declMatches = declarationSearchMatches(value, 8);
    var matches = moduleMatches.concat(declMatches).slice(0, 12);
    if (!matches.length) {
      closeSearchOptions();
      setSearchFeedback("No modules or declarations match “" + value + "”", true);
      return;
    }
    setSearchFeedback(moduleMatches.length + " module" + (moduleMatches.length === 1 ? "" : "s") + ", " + declMatches.length + " declaration" + (declMatches.length === 1 ? "" : "s"));
    openSearchOptions(matches);
  }

  function commitSearchValue() {
    if (!DOM.search) return;
    var value = DOM.search.value.trim();
    if (!value) return;
    if (state.searchActiveOption >= 0 && state.searchVisibleOptions[state.searchActiveOption]) {
      chooseSearchMatch(state.searchVisibleOptions[state.searchActiveOption]);
      return;
    }
    /* Exact module match wins; otherwise fall back to the first suggestion. */
    if (state.moduleMap[value]) { chooseSearchMatch({ type: "module", module: value }); return; }
    var matches = moduleSearchMatches(value, 1).concat(declarationSearchMatches(value, 1));
    if (matches.length) chooseSearchMatch(matches[0]);
    else setSearchFeedback("No modules or declarations match “" + value + "”", true);
  }

  /* ── URL state ─────────────────────────────────────────────── */
  function readUrlState() {
    var params = new URLSearchParams(window.location.search);
    var codebase = params.get("codebase");
    if (codebase && MAP_SOURCES[codebase]) state.codebase = codebase;
    return {
      module: params.get("module") || "",
      decl: params.get("decl") || ""
    };
  }

  function syncUrlState() {
    if (!window.history || !window.history.replaceState) return;
    var params = new URLSearchParams();
    params.set("codebase", state.codebase);
    if (state.flowContext === "declaration" && state.selectedDeclaration) {
      params.set("decl", state.selectedDeclarationModule + "." + state.selectedDeclaration);
    } else if (state.selectedModule) {
      params.set("module", state.selectedModule);
    }
    var newUrl = window.location.pathname + "?" + params.toString();
    try { window.history.replaceState(null, "", newUrl); } catch (e) {}
  }

  /* ── Render orchestration ──────────────────────────────────── */
  function renderAll() {
    var list = sortedModuleList();
    updateModuleResults(list.length);
    if (list.length && (!state.selectedModule || !state.moduleMap[state.selectedModule])) {
      state.selectedModule = list[0];
    }
    if (DOM.search && document.activeElement !== DOM.search) {
      if (state.flowContext === "declaration" && state.selectedDeclaration) {
        DOM.search.value = state.selectedDeclarationModule + "." + state.selectedDeclaration;
      } else if (state.selectedModule) {
        DOM.search.value = state.selectedModule;
      }
    }
    if (state.flowContext === "declaration" && state.selectedDeclaration) {
      if (DOM.flowWrap) DOM.flowWrap.setAttribute("aria-label", "Declaration call graph for " + state.selectedDeclaration);
      renderDeclarationFlowchart();
    } else {
      if (DOM.flowWrap) DOM.flowWrap.setAttribute("aria-label", "Dependency and call flow chart");
      renderFlowchart();
    }
  }

  /* ── Data loading ──────────────────────────────────────────── */
  function applyGraph(built) {
    state.repoUrl = built.repoUrl;
    state.schemaVersion = built.schemaVersion;
    state.summary = built.summary;
    state.sourceDigest = built.sourceDigest;
    state.moduleMap = built.moduleMap;
    state.moduleMeta = built.moduleMeta;
    state.moduleNames = built.moduleNames;
    state.declarationIndex = built.declarationIndex;
    state.declarationGraph = built.declarationGraph;
    state.declarationReverseGraph = built.declarationReverseGraph;
    state.importsFrom = built.importsFrom;
    state.importsTo = built.importsTo;
    state.degreeMap = Object.create(null);
    state.stats = built.stats;
  }

  function loadCodemap(kind, requested) {
    var source = MAP_SOURCES[kind] || MAP_SOURCES[DEFAULT_CODEBASE];
    state.codebase = MAP_SOURCES[kind] ? kind : DEFAULT_CODEBASE;
    if (DOM.select) DOM.select.value = state.codebase;
    setStatus("Loading " + source.label + " codemap…", false);
    closeSearchOptions();
    setSearchFeedback("");

    return fetch(source.path, { cache: "no-store" }).then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    }).then(function (raw) {
      applyGraph(buildGraph(raw));

      /* Reset selection for the new codebase, honouring any requested deep link. */
      state.flowContext = "module";
      state.selectedDeclaration = "";
      state.selectedDeclarationModule = "";
      state.declarationLanesExpanded = false;
      state.flowShowAll = false;
      state.interiorMenuModule = "";
      state.interiorMenuQuery = "";

      var list = sortedModuleList();
      var landing = list.length ? list[0] : null;
      if (requested && requested.decl) {
        var declOnly = requested.decl.indexOf(".") !== -1 ? requested.decl.slice(requested.decl.lastIndexOf(".") + 1) : requested.decl;
        if (state.declarationIndex[declOnly]) {
          state.selectedModule = declarationModuleOf(declOnly);
          state.flowContext = "declaration";
          state.selectedDeclaration = declOnly;
          state.selectedDeclarationModule = state.selectedModule;
        }
      }
      if (state.flowContext === "module") {
        if (requested && requested.module && state.moduleMap[requested.module]) landing = requested.module;
        state.selectedModule = landing;
      }
      state.flowScrollTarget = state.selectedDeclaration || state.selectedModule || "";

      renderStats();
      var digest = state.sourceDigest ? " · digest " + state.sourceDigest.slice(0, 8) : "";
      setStatus("Loaded " + source.label + " codemap · schema " + (state.schemaVersion || "?") + digest, false);
      syncUrlState();
      scheduleRender();
    }).catch(function (error) {
      setStatus("Failed loading " + source.label + " codemap: " + (error && error.message ? error.message : "unknown error"), true);
      if (DOM.flowWrap) DOM.flowWrap.textContent = "";
      if (DOM.stats) DOM.stats.innerHTML = "";
      renderFlowNodeInteriorMenu("");
    });
  }

  /* ── Setup ─────────────────────────────────────────────────── */
  function isTypingTarget(target) {
    return Boolean(target && target.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  }

  function setupControls() {
    if (DOM.select) {
      DOM.select.addEventListener("change", function () { loadCodemap(DOM.select.value, null); });
    }
    if (DOM.reset) {
      DOM.reset.addEventListener("click", function () {
        if (state.flowContext === "declaration") returnToModuleContext();
        state.flowShowAll = false;
        state.flowScrollTarget = state.selectedModule || "";
        if (DOM.search) DOM.search.value = state.selectedModule || "";
        closeSearchOptions();
        setSearchFeedback("");
        scheduleRender();
      });
    }
    if (DOM.search) {
      DOM.search.addEventListener("input", refreshSearchSuggestions);
      DOM.search.addEventListener("focus", refreshSearchSuggestions);
      DOM.search.addEventListener("blur", function () { window.setTimeout(closeSearchOptions, 120); });
      DOM.search.addEventListener("keydown", function (event) {
        var count = state.searchVisibleOptions.length;
        if (event.key === "ArrowDown" && count) {
          event.preventDefault();
          setActiveSearchOption((state.searchActiveOption + 1) % count);
        } else if (event.key === "ArrowUp" && count) {
          event.preventDefault();
          setActiveSearchOption((state.searchActiveOption - 1 + count) % count);
        } else if (event.key === "Enter") {
          event.preventDefault();
          commitSearchValue();
        } else if (event.key === "Escape") {
          closeSearchOptions();
        }
      });
    }
  }

  function setupKeyboardNavigation() {
    document.addEventListener("keydown", function (event) {
      if (event.isComposing) return;
      var key = (event.key || "").toLowerCase();
      if (key === "/" && !isTypingTarget(event.target)) {
        if (DOM.search) { event.preventDefault(); DOM.search.focus(); DOM.search.select(); }
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (key !== "j" && key !== "k") return;
      var list = sortedModuleList();
      if (!list.length) return;
      var currentIndex = Math.max(0, list.indexOf(state.selectedModule));
      var nextIndex = key === "j" ? Math.min(list.length - 1, currentIndex + 1) : Math.max(0, currentIndex - 1);
      selectModule(list[nextIndex], false);
      event.preventDefault();
    });
  }

  function setupResize() {
    var resizeTimer = null;
    window.addEventListener("resize", function () {
      cachedMinFlowWidth = 0;
      cachedMinFlowWidthTs = 0;
      LABEL_WRAP_CACHE.clear();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () { resizeTimer = null; scheduleRender(); }, 150);
    }, { passive: true });
  }

  /* ── Boot ──────────────────────────────────────────────────── */
  function boot() {
    cacheDomElements();
    var requested = readUrlState();
    setupControls();
    setupKeyboardNavigation();
    setupResize();
    loadCodemap(state.codebase, requested);
  }

  boot();
})();
