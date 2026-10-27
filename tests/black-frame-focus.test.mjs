// BF-01…BF-10. Pane focus must not paint the UA black frame.
// Source locks only. QA runs the browser pass.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");
const viewerJs = read("pdf/viewer.js");
const notesJs = read("pdf/notes-panel.js");
const viewerCss = read("pdf/viewer.css");
const viewerHtml = read("pdf/viewer.html");
const notesCss = read("pdf/notes-panel.css");
const tokens = read("pdf/reader-tokens.css");
const pdfCss = [viewerCss, notesCss, tokens, read("pdf/ask-panel.css"), read("pdf/drawer-panel.css"), read("pdf/library-panel.css")].join("\n");

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(name);
}

function ruleBodies(css, selector) {
  const bodies = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  for (const hit of css.matchAll(re)) {
    const selectors = hit[1].split(",").map((part) => part.trim().replace(/\s+/g, " "));
    if (selectors.includes(selector)) bodies.push(hit[2]);
  }
  assert.ok(bodies.length > 0, `missing ${selector}`);
  return bodies;
}

function ruleHas(css, selector, pattern) {
  const bodies = ruleBodies(css, selector);
  assert.ok(bodies.some((body) => pattern.test(body)), `${selector} missing ${pattern}`);
}

function lin(channel) {
  const s = channel / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function contrast(hexA, hexB) {
  const lum = (hex) => {
    const n = Number.parseInt(hex.slice(1), 16);
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  };
  const hi = Math.max(lum(hexA), lum(hexB));
  const lo = Math.min(lum(hexA), lum(hexB));
  return (hi + 0.05) / (lo + 0.05);
}

function hexVar(css, name) {
  const match = css.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(match, name);
  return match[1].toUpperCase();
}

test("BF-01 mouse click on the translation pane does not keep a UA frame", () => {
  assert.match(viewerHtml, /id="readerFlow"[^>]*class="reader-flow"[^>]*tabindex="0"/);
  const down = functionBody(viewerJs, "onFlowPointerDown");
  assert.match(down, /\$\("readerFlow"\)\?\.focus\(\{\s*preventScroll:\s*true,\s*focusVisible:\s*false\s*\}\)/);
  assert.match(down, /button, a, input, textarea, select/);
  ruleHas(viewerCss, ".reader-flow:focus", /outline:\s*none/);
  const visible = ruleBodies(viewerCss, ".reader-flow:focus-visible").join("\n");
  assert.match(visible, /outline:\s*1px solid var\(--oi-reader-focus-pane-soft\)/);
  assert.doesNotMatch(visible, /outline:\s*auto|outline:\s*2px|#(?:[0-9A-Fa-f]{3,8})/);
});

test("BF-02 original pane click and scroll do not show a frame", () => {
  assert.match(viewerHtml, /id="pages"/);
  assert.equal(viewerHtml.includes('id="pages" tabindex'), false);
  assert.match(viewerJs, /if \(pages && pages\.tabIndex < 0\) pages\.tabIndex = -1/);
  assert.equal(/\$\("pages"\)\?\.focus\(/.test(viewerJs), false);
  ruleHas(viewerCss, "#pages:focus", /outline:\s*none/);
  const visible = ruleBodies(viewerCss, "#pages:focus-visible").join("\n");
  assert.match(visible, /outline:\s*1px solid var\(--oi-reader-focus-pane-soft\)/);
  assert.match(visible, /outline-offset:\s*-1px/);
});

test("BF-03 dragging a splitter does not focus the panes", () => {
  for (const name of ["startSplitDrag", "startNotesSplitDrag"]) {
    assert.match(functionBody(viewerJs, name), /event\.preventDefault\(\)/);
  }
  ruleHas(viewerCss, ".reader-flow:focus", /outline:\s*none/);
  ruleHas(viewerCss, "#pages:focus", /outline:\s*none/);
  ruleHas(notesCss, ".oi-notes-scroll:focus", /outline:\s*none/);
  ruleHas(notesCss, ".oi-notes:focus", /outline:\s*none/);
  assert.match(viewerCss, /\.split-handle:focus-visible::before\s*\{[^}]*var\(--oi-reader-split-line-drag\)/);
});

test("BF-04 keyboard focus on a pane is a 1px inset hairline", () => {
  for (const selector of [".reader-flow:focus-visible", "#pages:focus-visible", ".oi-notes-scroll:focus-visible", ".oi-notes:focus-visible"]) {
    const css = selector.startsWith(".oi-notes") ? notesCss : viewerCss;
    const body = ruleBodies(css, selector).find((item) => /outline:\s*1px/.test(item));
    assert.ok(body, selector);
    assert.match(body, /outline:\s*1px solid var\(--oi-reader-focus-pane-soft\)/);
    assert.match(body, /outline-offset:\s*-1px/);
    assert.doesNotMatch(body, /outline:\s*2px|var\(--oi-reader-focus\)|#[0-9A-Fa-f]{3,8}/);
  }
});

test("BF-05 controls keep the 2px reader focus ring", () => {
  const strong = /outline:\s*(?:var\(--oi-reader-focus-width\)|2px)\s+solid\s+var\(--oi-reader-focus\)/;
  assert.match(viewerCss, /\.toolbar button:focus-visible\s*\{[^}]*outline:\s*var\(--oi-reader-focus-width\) solid var\(--oi-reader-focus\)/);
  assert.match(viewerCss, /\.aa-font-hint-link:focus-visible\s*\{[^}]*outline:\s*var\(--oi-reader-focus-width\) solid var\(--oi-reader-focus\)/);
  assert.match(viewerCss, /\.workspace\[data-view="bi"\] \.rf-src-fold-toggle:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-focus\)/);
  assert.match(viewerCss, /\.split-handle:focus-visible::before\s*\{[^}]*var\(--oi-reader-split-line-drag\)/);
  assert.match(notesCss, /\.oi-notes :is\(button, a, input, textarea, select, \[role="menuitem"\], \[role="button"\]\):focus-visible\s*\{[^}]*outline:\s*var\(--oi-reader-focus-width\) solid var\(--oi-reader-focus\)/);
  assert.match(notesCss, /\.oi-note-card:focus-visible,\s*\.oi-notes-group-head:focus-visible\s*\{[^}]*outline:\s*var\(--oi-reader-focus-width\) solid var\(--oi-reader-focus\)/s);
  assert.match(notesCss, /\.oi-notes \.oi-note-body a:focus\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-link\)/);
  assert.match(notesCss, strong);
  assert.equal(/\.oi-notes\s+:focus-visible\s*\{/.test(notesCss), false);
});

test("BF-06 o and f shortcuts still depend on readerFlow focus", () => {
  const down = functionBody(viewerJs, "onFlowPointerDown");
  assert.match(down, /\$\("readerFlow"\)\?\.focus\(/);
  const keys = functionBody(viewerJs, "onKey");
  assert.match(keys, /event\.key === "o"[\s\S]*?document\.activeElement\?\.closest\?\.\("\.pane-translate"\)/);
  assert.match(keys, /event\.key === "f" \|\| event\.key === "F"/);
  assert.match(keys, /event\.target\?\.closest\?\.\("\.split-handle, \.oi-notes"\)\) return/);
});

test("BF-07 escape still returns focus, and that focus is not a UA frame", () => {
  const keys = functionBody(viewerJs, "onKey");
  assert.match(keys, /closeAaPanel\(\)/);
  assert.match(keys, /closeMoreMenu\(true\)/);
  assert.match(keys, /closeSourcePop\(true\)/);
  assert.match(keys, /notesUi\?\.consumeEscape\(\)/);
  assert.match(notesJs, /root\.querySelector\("\.oi-notes-more"\)\?\.focus\(\)/);
  ruleHas(viewerCss, ".reader-flow:focus", /outline:\s*none/);
  ruleHas(viewerCss, "#pages:focus", /outline:\s*none/);
});

test("BF-08 hairline tracks line-strong in all five themes", () => {
  const darkAt = tokens.indexOf('[data-reader-theme="dark"]');
  assert.ok(darkAt > 0);
  const light = tokens.slice(0, darkAt);
  const dark = tokens.slice(darkAt, tokens.indexOf('[data-reader-fs-band="m"]'));
  assert.match(light, /--oi-reader-focus-pane-soft:\s*var\(--oi-reader-line-strong\)/);
  assert.match(dark, /--oi-reader-focus-pane-soft:\s*var\(--oi-reader-line-strong\)/);
  assert.doesNotMatch(light.match(/--oi-reader-focus-pane-soft:\s*[^;]+/)[0], /#[0-9A-Fa-f]/);
  assert.doesNotMatch(dark.match(/--oi-reader-focus-pane-soft:\s*[^;]+/)[0], /#[0-9A-Fa-f]/);
  assert.match(tokens, /--oi-reader-focus-width:\s*2px/);
  assert.match(tokens, /--oi-reader-focus:\s*#2F55D4/);
  assert.match(dark, /--oi-reader-focus:\s*#8FA8FF/);
  const papers = {
    warm: [hexVar(tokens, "--oi-reader-warm-paper"), hexVar(tokens, "--oi-reader-warm-line-strong")],
    white: [hexVar(tokens, "--oi-reader-white-paper"), hexVar(tokens, "--oi-reader-white-line-strong")],
    sepia: [hexVar(tokens, "--oi-reader-sepia-paper"), hexVar(tokens, "--oi-reader-sepia-line-strong")],
    green: [hexVar(tokens, "--oi-reader-green-paper"), hexVar(tokens, "--oi-reader-green-line-strong")],
    dark: [hexVar(dark, "--oi-reader-paper"), hexVar(dark, "--oi-reader-line-strong")]
  };
  for (const theme of Object.keys(papers)) {
    const [paper, line] = papers[theme];
    const block = theme === "dark" ? dark : tokens.slice(tokens.indexOf(`[data-reader-theme="${theme}"]`), tokens.indexOf(`[data-reader-theme="${theme}"]`) + 700);
    if (theme !== "dark") {
      assert.match(block, new RegExp(`--oi-reader-line-strong:\\s*var\\(--oi-reader-${theme}-line-strong\\)`));
    }
    assert.ok(contrast(paper, line) >= 3, `${theme} ${contrast(paper, line)}`);
  }
  assert.match(viewerCss, /@media \(forced-colors: active\)[\s\S]*\.reader-flow:focus-visible,\s*#pages:focus-visible\s*\{[^}]*outline-color:\s*Highlight/);
  assert.match(notesCss, /@media \(forced-colors: active\)[\s\S]*\.oi-notes-scroll:focus-visible\s*\{[^}]*outline-color:\s*Highlight/);
});

test("BF-09 pane focus rules stay on reader tokens and are not global", () => {
  assert.equal(/\*\s*:focus/.test(pdfCss), false);
  assert.equal(/(^|[\s,{])\*:focus/.test(pdfCss), false);
  const added = [
    ...ruleBodies(viewerCss, ".reader-flow:focus"),
    ...ruleBodies(viewerCss, ".reader-flow:focus-visible"),
    ...ruleBodies(viewerCss, "#pages:focus"),
    ...ruleBodies(viewerCss, "#pages:focus-visible"),
    ...ruleBodies(notesCss, ".oi-notes:focus"),
    ...ruleBodies(notesCss, ".oi-notes:focus-visible"),
    ...ruleBodies(notesCss, ".oi-notes-scroll:focus"),
    ...ruleBodies(notesCss, ".oi-notes-scroll:focus-visible")
  ].join("\n");
  assert.doesNotMatch(added, /#[0-9A-Fa-f]{3,8}/);
  assert.match(added, /var\(--oi-reader-focus-pane-soft\)/);
  assert.match(added, /outline:\s*none/);
});

test("BF-10 the math-scroll nit and other focus rings stay put", () => {
  assert.match(viewerCss, /\.oi-pdf-math-scroll:focus-visible\s*\{\s*outline:\s*1px solid var\(--oi-paper-muted\);\s*outline-offset:\s*2px;\s*\}/);
  assert.match(viewerCss, /\.toolbar button:focus-visible\s*\{[^}]*outline-offset:\s*var\(--oi-reader-focus-offset\)/);
  assert.match(viewerCss, /\.oi-sel-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-focus\)/);
  assert.equal(viewerCss.includes("*:focus"), false);
  assert.equal(notesCss.includes("*:focus"), false);
});
