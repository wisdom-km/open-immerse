import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolbar = readFileSync(join(root, "content/toolbar.js"), "utf8");
const css = readFileSync(join(root, "content/content.css"), "utf8");

function loadFab() {
  const ctx = createContext({ globalThis: {} });
  runInContext(readFileSync(join(root, "lib/fab.js"), "utf8"), ctx);
  return ctx.globalThis.OIFab || ctx.OIFab;
}

test("drag threshold is 4–6px and uses hypot", () => {
  const FAB = loadFab();
  assert.equal(FAB.DRAG_THRESHOLD_PX, 5);
  assert.equal(FAB.exceedsDragThreshold(0, 0), false);
  assert.equal(FAB.exceedsDragThreshold(4, 0), false);
  assert.equal(FAB.exceedsDragThreshold(5, 0), true);
  assert.equal(FAB.exceedsDragThreshold(-5, 0), true);
  assert.equal(FAB.exceedsDragThreshold(0, 5), true);
  assert.equal(FAB.exceedsDragThreshold(3, 3), false);
  assert.equal(FAB.exceedsDragThreshold(3, 4), true);
  assert.equal(FAB.exceedsDragThreshold(6, 0, 6), true);
  assert.equal(FAB.exceedsDragThreshold(5, 0, 6), false);
});

test("isDragHandle prefers fold / collapsed chip over 翻译/原文", () => {
  const FAB = loadFab();
  assert.equal(FAB.isDragHandle("fold", { collapsed: false }), true);
  assert.equal(FAB.isDragHandle("", { collapsed: false }), true);
  assert.equal(FAB.isDragHandle("toggle", { collapsed: false }), false);
  assert.equal(FAB.isDragHandle("restore", { collapsed: false }), false);
  assert.equal(FAB.isDragHandle("toggle", { collapsed: true }), true);
  assert.equal(FAB.isDragHandle("restore", { collapsed: true }), true);
});

test("clampDragPosition stays inside viewport insets", () => {
  const FAB = loadFab();
  const lo = FAB.clampDragPosition({
    left: -40,
    top: -10,
    width: 120,
    height: 52,
    viewportWidth: 800,
    viewportHeight: 600,
    inset: 20
  });
  assert.equal(lo.left, 20);
  assert.equal(lo.top, 20);

  const hi = FAB.clampDragPosition({
    left: 790,
    top: 590,
    width: 120,
    height: 52,
    viewportWidth: 800,
    viewportHeight: 600,
    inset: 20
  });
  assert.equal(hi.left, 660);
  assert.equal(hi.top, 528);

  const mid = FAB.clampDragPosition({
    left: 200,
    top: 300,
    width: 100,
    height: 40,
    viewportWidth: 800,
    viewportHeight: 600
  });
  assert.equal(mid.left, 200);
  assert.equal(mid.top, 300);
});

test("snapCorner on release still maps to bottom-left / bottom-right", () => {
  const FAB = loadFab();
  assert.equal(FAB.snapCorner(100, 800), "bottom-left");
  assert.equal(FAB.snapCorner(399, 800), "bottom-left");
  assert.equal(FAB.snapCorner(400, 800), "bottom-right");
  assert.equal(FAB.snapCorner(700, 800), "bottom-right");
});

test("toolbar follows the pointer then snaps and suppresses the click", () => {
  assert.match(toolbar, /bindFabDrag/);
  assert.match(toolbar, /exceedsDragThreshold/);
  assert.match(toolbar, /clampDragPosition/);
  assert.match(toolbar, /DRAG_THRESHOLD_PX/);
  assert.match(toolbar, /style\.left/);
  assert.match(toolbar, /style\.top/);
  assert.match(toolbar, /oi-fab-dragging/);
  assert.match(toolbar, /dataset\.oiDragged/);
  assert.match(toolbar, /snapCorner/);
  assert.match(toolbar, /syncFabSlot/);
  assert.match(toolbar, /applyCorner/);
  assert.doesNotMatch(toolbar, /bindCornerSnap/);
  assert.doesNotMatch(toolbar, /SNAP_PX/);
});

test("drag CSS does not steal 翻译/原文 pointer cursor until grabbing", () => {
  const buttons = css.slice(css.indexOf(".oi-fab > button {"), css.indexOf(".oi-fab > button[data-act=\"toggle\"]"));
  assert.match(buttons, /cursor:\s*pointer/);
  assert.match(css, /\.oi-fab-dragging > button \{\s*cursor:\s*grabbing/);
  assert.match(css, /touch-action:\s*none/);
});
