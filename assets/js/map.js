(function () {
  "use strict";

  var MAP_PATHS = {
    lean: "data/codemaps/lean.json",
    rust: "data/codemaps/rust.json",
    solidity: "data/codemaps/solidity.json"
  };

  var state = {
    codemapKind: "lean",
    modules: [],
    links: [],
    moduleByName: Object.create(null),
    declarationToModule: Object.create(null),
    selectedModule: null,
    zoom: 1,
    panX: 0,
    panY: 0,
    dragging: false,
    lastPointerX: 0,
    lastPointerY: 0
  };

  var selectEl = document.getElementById("map-select");
  var statusEl = document.getElementById("map-status");
  var summaryEl = document.getElementById("map-summary");
  var searchEl = document.getElementById("module-search");
  var resetEl = document.getElementById("reset-view");
  var graphWrapEl = document.getElementById("flowchart-wrap");
  var detailEl = document.getElementById("module-detail");

  function setStatus(text, error) {
    statusEl.textContent = text;
    statusEl.style.color = error ? "#ff6b6b" : "";
  }

  function buildGraph(raw) {
    var modules = Array.isArray(raw.modules) ? raw.modules : [];
    var moduleByName = Object.create(null);
    var declarationToModule = Object.create(null);

    modules.forEach(function (item) {
      var name = item.module || item.path || "unknown";
      var declarations = Array.isArray(item.declarations) ? item.declarations : [];
      moduleByName[name] = {
        id: name,
        label: name,
        path: item.path || "",
        declarationCount: Number(item.declaration_count || declarations.length || 0),
        declarations: declarations,
        x: 0,
        y: 0
      };

      declarations.forEach(function (decl) {
        if (decl && typeof decl.name === "string" && decl.name) {
          if (!declarationToModule[decl.name]) {
            declarationToModule[decl.name] = name;
          }
        }
      });
    });

    var linkWeights = Object.create(null);
    modules.forEach(function (item) {
      var sourceName = item.module || item.path || "unknown";
      var declarations = Array.isArray(item.declarations) ? item.declarations : [];
      declarations.forEach(function (decl) {
        var called = Array.isArray(decl.called) ? decl.called : [];
        called.forEach(function (callee) {
          var targetName = declarationToModule[callee];
          if (targetName && targetName !== sourceName) {
            var key = sourceName + "=>" + targetName;
            linkWeights[key] = (linkWeights[key] || 0) + 1;
          }
        });
      });
    });

    var links = Object.keys(linkWeights).map(function (key) {
      var parts = key.split("=>");
      return { source: parts[0], target: parts[1], weight: linkWeights[key] };
    });

    return {
      modules: Object.keys(moduleByName).map(function (k) { return moduleByName[k]; }),
      links: links,
      moduleByName: moduleByName,
      declarationToModule: declarationToModule,
      summary: raw.summary || {},
      sourceSync: raw.source_sync || {}
    };
  }

  function layoutCircular(modules) {
    var total = modules.length;
    var cols = Math.ceil(Math.sqrt(total));
    var spacingX = 240;
    var spacingY = 140;
    modules.forEach(function (m, i) {
      var row = Math.floor(i / cols);
      var col = i % cols;
      m.x = col * spacingX;
      m.y = row * spacingY;
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function renderGraph() {
    var modules = state.modules;
    var links = state.links;
    var query = (searchEl.value || "").trim().toLowerCase();

    var visibleModules = modules.filter(function (mod) {
      if (!query) return true;
      return mod.label.toLowerCase().indexOf(query) !== -1;
    });

    var visibleSet = Object.create(null);
    visibleModules.forEach(function (m) { visibleSet[m.id] = true; });

    var svgParts = [];
    svgParts.push('<svg class="flowchart-svg" viewBox="-120 -120 3000 2200" role="img" aria-label="Knomosis module flowchart">');
    svgParts.push('<g transform="translate(' + state.panX + ' ' + state.panY + ') scale(' + state.zoom + ')">');

    links.forEach(function (link) {
      if (!visibleSet[link.source] || !visibleSet[link.target]) return;
      var source = state.moduleByName[link.source];
      var target = state.moduleByName[link.target];
      if (!source || !target) return;
      svgParts.push('<line class="map-edge" x1="' + source.x + '" y1="' + source.y + '" x2="' + target.x + '" y2="' + target.y + '" stroke-width="' + Math.min(5, 1 + link.weight) + '"></line>');
    });

    visibleModules.forEach(function (mod) {
      var selectedClass = state.selectedModule === mod.id ? " map-node-selected" : "";
      svgParts.push('<g class="map-node' + selectedClass + '" data-module="' + escapeHtml(mod.id) + '">');
      svgParts.push('<rect x="' + (mod.x - 96) + '" y="' + (mod.y - 30) + '" width="192" height="60" rx="12"></rect>');
      svgParts.push('<text x="' + mod.x + '" y="' + (mod.y - 4) + '" text-anchor="middle">' + escapeHtml(mod.label.split("/").slice(-1)[0]) + '</text>');
      svgParts.push('<text class="map-node-meta" x="' + mod.x + '" y="' + (mod.y + 15) + '" text-anchor="middle">decls: ' + mod.declarationCount + '</text>');
      svgParts.push('</g>');
    });

    svgParts.push("</g></svg>");
    graphWrapEl.innerHTML = svgParts.join("");

    graphWrapEl.querySelectorAll(".map-node").forEach(function (node) {
      node.addEventListener("click", function () {
        var moduleName = node.getAttribute("data-module");
        state.selectedModule = moduleName;
        renderDetails();
        renderGraph();
      });
    });

    summaryEl.textContent = [
      "Modules shown: " + visibleModules.length,
      "Total modules: " + modules.length,
      "Cross-module links: " + links.length,
      "Synced: " + (state.sourceSync.synced_at || "unknown")
    ].join(" · ");
  }

  function renderDetails() {
    if (!state.selectedModule || !state.moduleByName[state.selectedModule]) {
      detailEl.innerHTML = "<p>Select a module node to inspect declarations.</p>";
      return;
    }

    var module = state.moduleByName[state.selectedModule];
    var items = module.declarations.slice(0, 200).map(function (decl) {
      return "<li><strong>" + escapeHtml(decl.kind || "decl") + "</strong> " +
        escapeHtml(decl.name || "(anonymous)") +
        " <span class=\"decl-meta\">line " + escapeHtml(decl.line || "?") + "</span></li>";
    }).join("");

    detailEl.innerHTML = "<h3>" + escapeHtml(module.label) + "</h3>" +
      "<p><strong>Path:</strong> " + escapeHtml(module.path || "unknown") + "</p>" +
      "<p><strong>Declarations:</strong> " + module.declarationCount + "</p>" +
      "<ul class=\"decl-list\">" + items + "</ul>";
  }

  function installPanZoom() {
    graphWrapEl.addEventListener("wheel", function (event) {
      event.preventDefault();
      var factor = event.deltaY < 0 ? 1.08 : 0.92;
      state.zoom = Math.max(0.4, Math.min(2.5, state.zoom * factor));
      renderGraph();
    }, { passive: false });

    graphWrapEl.addEventListener("pointerdown", function (event) {
      state.dragging = true;
      state.lastPointerX = event.clientX;
      state.lastPointerY = event.clientY;
      graphWrapEl.setPointerCapture(event.pointerId);
    });

    graphWrapEl.addEventListener("pointermove", function (event) {
      if (!state.dragging) return;
      state.panX += (event.clientX - state.lastPointerX);
      state.panY += (event.clientY - state.lastPointerY);
      state.lastPointerX = event.clientX;
      state.lastPointerY = event.clientY;
      renderGraph();
    });

    graphWrapEl.addEventListener("pointerup", function () {
      state.dragging = false;
    });
  }

  function resetView() {
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    renderGraph();
  }

  async function loadCodemap(kind) {
    var url = MAP_PATHS[kind];
    setStatus("Loading " + kind + " codemap…", false);

    try {
      var response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        throw new Error("HTTP " + response.status);
      }

      var raw = await response.json();
      var built = buildGraph(raw);

      state.codemapKind = kind;
      state.modules = built.modules;
      state.links = built.links;
      state.moduleByName = built.moduleByName;
      state.declarationToModule = built.declarationToModule;
      state.selectedModule = null;
      state.sourceSync = built.sourceSync;

      layoutCircular(state.modules);
      resetView();
      renderDetails();
      setStatus("Loaded " + kind + " codemap.", false);
    } catch (error) {
      setStatus("Failed loading codemap: " + error.message, true);
      summaryEl.textContent = "";
      graphWrapEl.innerHTML = "";
      detailEl.innerHTML = "";
    }
  }

  selectEl.addEventListener("change", function () {
    loadCodemap(selectEl.value);
  });

  searchEl.addEventListener("input", function () {
    renderGraph();
  });

  resetEl.addEventListener("click", function () {
    resetView();
  });

  installPanZoom();
  loadCodemap(selectEl.value);
})();
