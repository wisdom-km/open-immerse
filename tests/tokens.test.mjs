import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = readFileSync(join(root, "ui/tokens.css"), "utf8");
const pages = [
  "popup/popup.css",
  "options/options.css",
  "learning/learning.css",
  "documents/documents.css",
  "pdf/viewer.css"
];

test("shared tokens define V2 brand colors and Dual Line mark", () => {
  assert.match(tokens, /--oi-bg:\s*#12151c/);
  assert.match(tokens, /--oi-bg-elevated:\s*#181c26/);
  assert.match(tokens, /--oi-panel:\s*#1e2430/);
  assert.match(tokens, /--oi-card:\s*#232a38/);
  assert.match(tokens, /--oi-input:\s*#171b24/);
  assert.match(tokens, /--oi-line:\s*rgba\(255,\s*255,\s*255,\s*0\.10\)/);
  assert.match(tokens, /--oi-line-strong:\s*rgba\(255,\s*255,\s*255,\s*0\.16\)/);
  assert.match(tokens, /--oi-text:\s*#f2f4f8/);
  assert.match(tokens, /--oi-text-muted:\s*#9aa3b5/);
  assert.match(tokens, /--oi-accent:\s*#6b8cff/);
  assert.match(tokens, /--oi-accent-hover:\s*#7d9bff/);
  assert.match(tokens, /--oi-accent-subtle:\s*color-mix\(in srgb, var\(--oi-accent\) 18%, transparent\)/);
  assert.match(tokens, /--oi-radius-panel:\s*14px/);
  assert.match(tokens, /--oi-radius-control:\s*10px/);
  assert.match(tokens, /--oi-shadow-1:/);
  assert.match(tokens, /--oi-fab-slot:\s*72px/);
  assert.match(tokens, /--oi-paper:\s*#ffffff/);
  assert.match(tokens, /\.mark span[^}]*background:\s*var\(--oi-text\)/);
  assert.equal(/\.mark span[^}]*--oi-accent/.test(tokens), false);
});

test("page stylesheets import tokens and do not redeclare hex tracks", () => {
  for (const rel of pages) {
    const css = readFileSync(join(root, rel), "utf8");
    assert.match(css, /@import\s+"\.\.\/ui\/tokens\.css"/, rel);
    assert.equal(/--oi-bg:\s*#/.test(css), false, rel);
    assert.equal(/--oi-accent:\s*#/.test(css), false, rel);
  }
});

test("content surfaces consume shared tokens instead of hardcodes", () => {
  const css = readFileSync(join(root, "content/content.css"), "utf8");
  const manifest = readFileSync(join(root, "manifest.json"), "utf8");
  assert.match(manifest, /ui\/tokens\.css/);
  assert.match(css, /\.oi-toast[\s\S]*background:\s*var\(--oi-card\)/);
  assert.match(css, /\.oi-fab \{\s*[^}]*background:\s*color-mix\(in srgb,\s*var\(--oi-card\)\s*88%/);
  assert.equal(/\.oi-toast[\s\S]*background:\s*#171a21/.test(css), false);
  assert.equal(/\.oi-fab > button\.on \{ background:\s*#4d7cff/.test(css), false);
});

test("popup and options consume radius, line, and shadow tokens", () => {
  const popup = readFileSync(join(root, "popup/popup.css"), "utf8");
  const options = readFileSync(join(root, "options/options.css"), "utf8");
  assert.match(popup, /background:\s*var\(--oi-bg-elevated\)/);
  assert.match(popup, /select\s*\{[^}]*background:\s*var\(--oi-input\)/s);
  assert.match(popup, /border-radius:\s*var\(--oi-radius-control\)/);
  assert.match(options, /background:\s*var\(--oi-bg\)/);
  assert.match(options, /section\s*\{[^}]*background:\s*var\(--oi-panel\)[^}]*box-shadow:\s*var\(--oi-shadow-1\)/s);
  assert.match(options, /border-radius:\s*var\(--oi-radius-panel\)/);
  assert.match(options, /border-radius:\s*var\(--oi-radius-control\)/);
});
