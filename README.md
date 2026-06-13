# knomosis-site

Dependency-minimized static website for the [Knomosis](https://github.com/hatter6822/Knomosis)
project, inspired by the vanilla-JS architecture used on the seLe4n site. No
frameworks, no build step, no runtime dependencies — just HTML, CSS, and
vanilla JavaScript.

## Pages

- `index.html` — project overview and links into the maps.
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
modules, `/` to focus search, `Esc` to close), reset, and a light/dark theme
toggle. Module and declaration nodes link to their source on GitHub. Panning
and zooming use native scrolling.

## Theme

The site uses a **neumorphic** ("soft UI") theme in both light and dark modes:
surfaces share the background colour and are shaped by paired soft shadows
(light top-left, dark bottom-right) rather than borders, over a flat, uniform
background. The palette is built from five pastel anchors — `#8ECC81`,
`#81CC9A`, `#81CCC0`, `#C081CC`, `#CC818E` — used as **decorative** fills,
borders and accents only; **text always uses darkened variants** so every
text/background pair clears WCAG AA (verified by tests). All theme values live
in CSS custom properties (`assets/css/style.css`); the flow chart reads its
lane and node-shadow colours from those variables so it stays in sync when the
theme changes.

Because the depth is shadow-based, the theme also restores real borders under
`forced-colors`/High-Contrast mode and in print, and the per-node shadow filter
is dropped automatically on dense hub graphs (60+ neighbours) to keep rendering
cheap.

Deep links are supported, e.g. `map.html?codebase=rust` or
`map.html?codebase=lean&module=LegalKernel` or
`map.html?codebase=solidity&decl=KnomosisDisputeVerifier.fileDispute`.

## Codemap data

The viewer reads JSON codemaps bundled from the Knomosis repository:

- `data/codemaps/lean.json`
- `data/codemaps/rust.json`
- `data/codemaps/solidity.json`

Each codemap contains `modules[]`, where every module has `declarations[]`
(`kind`, `name`, `line`, `called[]`). Cross-module links and the declaration
call graph are derived at load time by resolving each declaration's `called`
list against a global declaration index — nothing is hand-drawn. Because
resolution is by declaration name, a name shared across modules resolves to its
first occurrence; the derived graph remains consistent (this is the only
approximation in the model).

## Assets

- `assets/css/style.css`, `assets/css/map.css` — styling.
- `assets/js/theme-init.js` — applies the saved/system theme before first paint
  (avoids a flash of the wrong theme).
- `assets/js/header-nav.js` — navigation behaviour and in-page scrolling.
- `assets/js/ui-controls.js` — the light/dark theme toggle.
- `assets/js/map.js` — the codemap navigator (the only non-trivial script).

## Local development

Serve the project with any static file server, for example:

```bash
npm run serve        # python3 -m http.server 8080
# or
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Tests

The pure, DOM-free logic of `map.js` (graph building, the adaptive kind
grouping, search, colour maths, URL/deep-link resolution, and input
sanitisation) is unit-tested with the built-in Node test runner — **no test
dependencies are installed**:

```bash
npm test             # node --test
```

`map.js` only boots in a browser (it checks for `window`/`document`) and exposes
its internals via `module.exports` under Node, so the tests run no DOM code. The
suite also validates that the bundled codemaps are internally consistent
(summary counts, edge symmetry, and declaration call-graph invariants), and
`test/theme.test.js` parses the real theme variables from `style.css` and
asserts every text / link / lane colour clears WCAG AA against both the page
background and the raised node surface, in both themes — so a future palette
change cannot silently regress accessibility.
