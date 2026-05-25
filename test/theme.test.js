"use strict";

/*
 * Accessibility guard for the neumorphic theme.
 *
 * Reads the real CSS custom properties from style.css (not the docs) for both
 * the dark (:root) and light ([data-theme="light"]) themes and asserts every
 * text / link / lane colour clears WCAG contrast against its background. This
 * fails loudly if the palette is ever changed below AA.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const css = fs.readFileSync(path.join(__dirname, "..", "assets", "css", "style.css"), "utf8");

/* Extract a flat `{ ... }` rule body for a selector (the variable blocks have
   no nested braces, so a non-greedy match to the first close brace is exact). */
function ruleBody(selectorRegex) {
  const re = new RegExp(selectorRegex + "\\s*\\{([^}]*)\\}");
  const m = css.match(re);
  assert.ok(m, "could not find rule for " + selectorRegex);
  return m[1];
}

function parseVars(body) {
  const vars = Object.create(null);
  const re = /--([\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body)) !== null) vars[m[1]] = m[2].trim();
  return vars;
}

function hex(vars, name) {
  const v = vars[name];
  assert.ok(v, "missing --" + name);
  assert.match(v, /^#[0-9a-fA-F]{3,6}$/, "--" + name + " is not a plain hex colour: " + v);
  return v;
}

function lin(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum(h) {
  let s = h.replace("#", "");
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function contrast(a, b) {
  const la = lum(a), lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const dark = parseVars(ruleBody(":root"));
const light = parseVars(ruleBody('\\[data-theme="light"\\]'));

/* Text / link / lane colours that carry small (<18px) text must clear AA 4.5:1. */
const TEXT_AA = ["text", "text-muted", "text-bright", "heading", "accent",
  "flow-selected", "flow-depends", "flow-usedby", "flow-calls", "flow-neutral"];
/* Semantic accents used mostly for large/bold or UI elements: AA-large 3:1. */
const LARGE_AA = ["green", "red", "purple", "yellow"];

for (const [themeName, vars] of [["dark", dark], ["light", light]]) {
  test(`${themeName} theme — small-text colours clear WCAG AA (4.5:1)`, () => {
    const bg = hex(vars, "bg");
    for (const name of TEXT_AA) {
      const ratio = contrast(hex(vars, name), bg);
      assert.ok(ratio >= 4.5, `--${name} (${vars[name]}) on --bg (${bg}) = ${ratio.toFixed(2)}, needs >= 4.5`);
    }
  });

  test(`${themeName} theme — semantic accents clear AA-large (3:1)`, () => {
    const bg = hex(vars, "bg");
    for (const name of LARGE_AA) {
      const ratio = contrast(hex(vars, name), bg);
      assert.ok(ratio >= 3.0, `--${name} (${vars[name]}) on --bg (${bg}) = ${ratio.toFixed(2)}, needs >= 3.0`);
    }
  });

  test(`${themeName} theme — on-accent text is readable on the accent fill`, () => {
    const ratio = contrast(hex(vars, "on-accent"), hex(vars, "accent"));
    assert.ok(ratio >= 4.5, `--on-accent on --accent = ${ratio.toFixed(2)}, needs >= 4.5`);
  });

  /* Flow-chart nodes (and any raised panel) paint text on --surface-2, which
     is lighter than --bg, so text must clear AA there too — this guards the
     node title (--text), subtitle (--text-muted) and source link (--accent). */
  test(`${themeName} theme — text clears AA on the raised node surface (--surface-2)`, () => {
    const s2 = hex(vars, "surface-2");
    for (const name of ["text", "text-muted", "accent"]) {
      const ratio = contrast(hex(vars, name), s2);
      assert.ok(ratio >= 4.5, `--${name} (${vars[name]}) on --surface-2 (${s2}) = ${ratio.toFixed(2)}, needs >= 4.5`);
    }
  });
}
