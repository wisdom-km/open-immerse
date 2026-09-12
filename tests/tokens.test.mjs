import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = readFileSync(join(root, "ui/tokens.css"), "utf8");
const pages = ["popup/popup.css", "options/options.css", "learning/learning.css", "documents/documents.css"];

test("shared tokens define V2 brand colors and Dual Line mark", () => {
  assert.match(tokens, /--oi-bg:\s*#0b0d12/);
  assert.match(tokens, /--oi-bg-elevated:\s*#10131a/);
  assert.match(tokens, /--oi-accent:\s*#4d7cff/);
  assert.match(tokens, /--oi-shadow-1:/);
  assert.match(tokens, /--oi-fab-slot:\s*72px/);
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
