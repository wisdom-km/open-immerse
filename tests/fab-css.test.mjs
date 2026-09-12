import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "content/content.css"), "utf8");
const js = readFileSync(join(root, "content/toolbar.js"), "utf8");
const fabBtn = css.slice(css.indexOf(".oi-fab > button"), css.indexOf(".oi-fab > button.on"));
const fabBar = css.slice(css.indexOf(".oi-fab {"), css.indexOf(".oi-fab > button"));

test("FAB buttons match Loom inline-flex 36×36 centering", () => {
  assert.match(fabBtn, /display:\s*inline-flex/);
  assert.match(fabBtn, /align-items:\s*center/);
  assert.match(fabBtn, /justify-content:\s*center/);
  assert.match(fabBtn, /height:\s*36px/);
  assert.match(fabBtn, /\[data-act="toggle"\][\s\S]*\[data-act="restore"\][\s\S]*padding:\s*0 12px/);
  assert.match(fabBtn, /\[data-act="fold"\][\s\S]*padding:\s*0/);
  assert.match(fabBtn, /\[data-act="fold"\][\s\S]*width:\s*36px/);
  assert.match(fabBtn, /font-size:\s*13px/);
  assert.match(fabBtn, /font-weight:\s*600/);
  assert.match(fabBtn, /line-height:\s*1/);
  assert.match(fabBtn, /PingFang SC/);
  assert.match(fabBtn, /Noto Sans SC/);
  assert.match(css, /\.oi-fab > button:hover/);
  assert.match(css, /\.oi-fab \{\s*[^}]*gap:\s*8px/);
});

test("FAB copy is two-char pills 翻译/原文, not 译/原/藏", () => {
  assert.match(js, />翻译</);
  assert.match(js, />原文</);
  assert.match(js, /停止/);
  assert.equal(js.includes(">译<"), false);
  assert.equal(js.includes(">原<"), false);
  assert.equal(js.includes(">藏<"), false);
});

test("FAB bar uses 20px inset, glass fill, and weak shadow-1", () => {
  assert.match(fabBar, /right:\s*20px/);
  assert.match(fabBar, /bottom:\s*20px/);
  assert.match(fabBar, /background:\s*color-mix\(in srgb,\s*var\(--oi-card\)\s*88%/);
  assert.match(fabBar, /box-shadow:\s*var\(--oi-shadow-1\)/);
});

test("toast shares slot above FAB", () => {
  assert.match(css, /\.oi-toast[\s\S]*bottom:\s*var\(--oi-fab-slot/);
  assert.match(css, /\.oi-selection-card[\s\S]*bottom:\s*var\(--oi-fab-slot/);
  assert.match(css, /--oi-fab-toast-left/);
  assert.match(css, /--oi-fab-toast-right/);
  assert.equal(/\.oi-toast[\s\S]*bottom:\s*88px/.test(css), false);
});

test("FAB drag handle uses grab / grabbing cursors", () => {
  assert.match(css, /\.oi-fab \{\s*[^}]*cursor:\s*grab/);
  assert.match(css, /\[data-act="fold"\][\s\S]*cursor:\s*grab/);
  assert.match(css, /\.oi-fab-dragging[\s\S]*cursor:\s*grabbing/);
  assert.match(js, /oi-fab-dragging/);
});

test("FAB action labels stay flex-centered", () => {
  assert.match(js, />翻译</);
  assert.match(js, />原文</);
  assert.match(js, /停止/);
  assert.match(fabBtn, /align-items:\s*center/);
  assert.match(fabBtn, /justify-content:\s*center/);
  assert.match(fabBtn, /\[data-act="toggle"\][\s\S]*padding:\s*0 12px/);
});
