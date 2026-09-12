import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SETTINGS } from "../lib/storage.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolbar = readFileSync(join(root, "content/toolbar.js"), "utf8");
const css = readFileSync(join(root, "content/content.css"), "utf8");
const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
const manifest = readFileSync(join(root, "manifest.json"), "utf8");
const content = readFileSync(join(root, "content/content.js"), "utf8");
const popup = readFileSync(join(root, "popup/popup.html"), "utf8");
const options = readFileSync(join(root, "options/options.html"), "utf8");

function loadFab() {
  const ctx = createContext({ globalThis: {} });
  runInContext(readFileSync(join(root, "lib/fab.js"), "utf8"), ctx);
  return ctx.globalThis.OIFab || ctx.OIFab;
}

test("FAB V1 IA is 翻译/原文 plus fold glyph, no 收藏 or more menu", () => {
  assert.match(toolbar, />翻译</);
  assert.match(toolbar, />原文</);
  assert.match(toolbar, /data-act="fold"/);
  assert.match(toolbar, />‹</);
  assert.equal(toolbar.includes(">收藏<"), false);
  assert.equal(toolbar.includes('data-act="save"'), false);
  assert.equal(toolbar.includes('data-act="more"'), false);
  assert.equal(toolbar.includes(">⋯<"), false);
  assert.equal(toolbar.includes("oi-fab-menu"), false);
  assert.equal(toolbar.includes("学习中心"), false);
  assert.equal(toolbar.includes("文档翻译"), false);
  assert.equal(toolbar.includes("本站自动翻译"), false);
  assert.equal(css.includes(".oi-fab-menu"), false);
});

test("glass pill uses translucent card, blur 12px, and thin border", () => {
  const bar = css.slice(css.indexOf(".oi-fab {"), css.indexOf(".oi-fab[data-corner"));
  assert.match(bar, /color-mix\(in srgb,\s*var\(--oi-card\)\s*88%/);
  assert.match(bar, /backdrop-filter:\s*blur\(12px\)/);
  assert.match(bar, /-webkit-backdrop-filter:\s*blur\(12px\)/);
  assert.match(bar, /border:\s*1px solid color-mix\(in srgb,\s*var\(--oi-line\)/);
});

test("collapse is locked while oi-active or persist toast", () => {
  const FAB = loadFab();
  assert.equal(FAB.collapseLocked({ active: true, persistToast: false }), true);
  assert.equal(FAB.collapseLocked({ active: false, persistToast: true }), true);
  assert.equal(FAB.collapseLocked({ active: false, persistToast: false }), false);
  assert.equal(FAB.persistToastShowing("翻译中"), true);
  assert.equal(FAB.persistToastShowing("润色中"), true);
  assert.equal(FAB.persistToastShowing("已收藏"), false);
  assert.match(toolbar, /oi-fab-locked/);
  assert.match(toolbar, /oi-active/);
  assert.match(toolbar, /persistToast/);
  assert.match(content, /oi-status/);
});

test("corner snap V1 is bottom-left / bottom-right only and persists", () => {
  const FAB = loadFab();
  assert.equal(FAB.CORNER_DEFAULT, "bottom-right");
  assert.equal(FAB.STORAGE_KEY, "oi-fab-corner");
  assert.equal(FAB.normalizeCorner("bottom-left"), "bottom-left");
  assert.equal(FAB.normalizeCorner("bottom-right"), "bottom-right");
  assert.equal(FAB.normalizeCorner("top-left"), "bottom-right");
  assert.equal(FAB.snapCorner(10, 800), "bottom-left");
  assert.equal(FAB.snapCorner(700, 800), "bottom-right");
  assert.equal(DEFAULT_SETTINGS.fabCorner, "bottom-right");
  assert.match(toolbar, /localStorage\.setItem\(FAB\.STORAGE_KEY/);
  assert.match(toolbar, /fabCorner/);
  assert.match(toolbar, /bottom-left/);
  assert.match(toolbar, /bottom-right/);
  assert.match(css, /\[data-corner="bottom-left"\]/);
  assert.equal(toolbar.includes("style.left"), false);
  assert.equal(toolbar.includes("style.top"), false);
  assert.equal(toolbar.includes("position:absolute"), false);
});

test("fold glyph is ‹ / ›, not a third business label", () => {
  const FAB = loadFab();
  assert.equal(FAB.foldGlyph("bottom-right", false), "‹");
  assert.equal(FAB.foldGlyph("bottom-right", true), "›");
  assert.equal(FAB.foldGlyph("bottom-left", false), "›");
  assert.equal(FAB.foldGlyph("bottom-left", true), "‹");
  assert.match(toolbar, /foldGlyph/);
  assert.doesNotMatch(toolbar, />收起</);
  assert.doesNotMatch(toolbar, />展开</);
});

test("toast slot is measured from FAB height", () => {
  const FAB = loadFab();
  assert.equal(FAB.slotPx(52), 84);
  assert.equal(FAB.slotPx(0), 72);
  assert.match(toolbar, /--oi-fab-slot/);
  assert.match(toolbar, /slotPx/);
  assert.match(css, /\.oi-toast[\s\S]*bottom:\s*var\(--oi-fab-slot/);
  assert.match(css, /html\[data-oi-fab-corner="bottom-left"\] \.oi-toast/);
});

test("context menus register only 收藏; translate-selection stays off the menu", () => {
  assert.match(sw, /title: "收藏"/);
  assert.match(sw, /id: "oi-save-selection"/);
  assert.doesNotMatch(sw, /oi-translate-selection/);
  assert.doesNotMatch(sw, /title: "翻译选中"/);
  assert.doesNotMatch(sw, /title: "翻译选中文本"/);
  assert.doesNotMatch(sw, /title: "收藏到学习中心"/);
  assert.match(content, /OI_SHOW_SELECTION/);
  assert.match(content, /showSelectionCard/);
});

test("favoriting stays off FAB: submenu + selection card + double-click still exist", () => {
  assert.match(sw, /oi-save-selection/);
  assert.match(content, /class="save">收藏</);
  assert.match(content, /dblclick/);
  assert.equal(toolbar.includes(">收藏<"), false);
});

test("learning / docs / auto-site stay in Popup and Options only", () => {
  assert.match(popup, /id="openLearning">学习中心</);
  assert.match(popup, /id="openDocs">文档</);
  assert.match(popup, />本站自动</);
  assert.match(options, /自动翻译站点/);
  assert.match(options, /学习中心/);
  assert.match(options, /文档翻译/);
  assert.equal(toolbar.includes("OI_OPEN_PAGE"), false);
  assert.equal(toolbar.includes("OI_TOGGLE_SITE_RULE"), false);
});

test("content scripts load fab helpers before toolbar, and restore uses 翻译", () => {
  assert.match(manifest, /"lib\/fab\.js"/);
  assert.match(manifest, /lib\/fab\.js", "content\/content\.js", "content\/toolbar\.js"/);
  assert.match(content, /fab\.textContent = "翻译"/);
  assert.equal(content.includes('fab.textContent = "译"'), false);
});

test("extension root has no underscore QA directories", () => {
  const names = readdirSync(root);
  assert.equal(
    names.some((name) => /^_qa/i.test(name) || /^_.*qa/i.test(name)),
    false
  );
});
