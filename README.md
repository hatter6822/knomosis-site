# knomosis-site

Dependency-minimized static website for the [Knomosis](https://github.com/hatter6822/Knomosis)
project, inspired by the vanilla-JS architecture used on the seLe4n site. No
frameworks, no build step — just HTML, CSS, and vanilla JavaScript.

## Pages

- `index.html` — project overview, animated background, and links into the maps.
- `map.html` — the **Adaptive Codebase Navigator**: an interactive flow chart
  viewer for the Lean, Rust, and Solidity codemaps.

## The map viewer

A single canonical flow graph is rendered for every codebase:

- **Module view** — the selected module sits in the center lane, the modules it
  depends on (its declarations call into them) are on the left, and the modules
  that depend on it are on the right. Edges are derived from the call graph.
- **Declaration view** — click any declaration to drill into its own call graph:
  what it calls (outgoing) and what calls it (incoming). Node borders are
  coloured by declaration kind and dashed edges mark cross-module references.
- **Interior menu** — every declaration in the selected module, grouped into
  language-adaptive kind columns (e.g. Types / Functions / Theorems for Lean,
  Types / Functions / Events & Errors for Solidity), each with a per-kind filter
  and a cross-cutting search box.

Other features: codebase selector, context search over modules and
`Module.declaration` names, keyboard navigation (`J`/`K` to move between
modules, `/` to focus search), reset, light/dark theme, and a pausable
animated background. Module and declaration nodes link to their source on
GitHub.

Deep links are supported, e.g. `map.html?codebase=rust` or
`map.html?codebase=lean&module=LegalKernel`.

## Codemap data

The viewer reads JSON codemaps bundled from the Knomosis repository:

- `data/codemaps/lean.json`
- `data/codemaps/rust.json`
- `data/codemaps/solidity.json`

Each codemap contains `modules[]`, where every module has `declarations[]`
(`kind`, `name`, `line`, `called[]`). Cross-module links and the declaration
call graph are derived at load time by resolving each declaration's `called`
list against a global declaration index — nothing is hand-drawn.

## Assets

- `assets/css/style.css`, `assets/css/map.css` — styling.
- `assets/js/theme-init.js` — applies the saved/system theme before paint.
- `assets/js/header-nav.js` — navigation behaviour.
- `assets/js/ui-controls.js` — theme and background-animation toggles.
- `assets/js/background-pattern.js` — WebGL animated background (degrades to a
  static gradient where WebGL or motion is unavailable).
- `assets/js/map.js` — the codemap navigator.

## Local development

Serve the project with any static file server, for example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.
