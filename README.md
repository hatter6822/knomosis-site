# knomosis-site

Dependency-minimized static website for the Knomosis project, inspired by the vanilla-JS architecture used on the seLe4n site.

## Pages

- `index.html`: project overview and navigation
- `map.html`: codemap viewer for Lean, Rust, and Solidity maps

## Codemap data

Codemap JSON files are vendored from the Knomosis repository under:

- `data/codemaps/lean.json`
- `data/codemaps/rust.json`
- `data/codemaps/solidity.json`

## Local development

Serve the project with any static file server, for example:

```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.
