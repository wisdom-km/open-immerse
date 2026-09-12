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

test("drag threshold is 6px to distinguish click vs drag", () => {
  const FAB = loadFab();
  assert.equal(FAB.DRAG_THRESHOLD_PX, 6);
  assert.equal(FAB.exceedsDragThreshold(0, 0), false);
  assert.equal(FAB.exceedsDragThreshold(5, 0), false);
  assert.equal(FAB.exceedsDragThreshold(6, 0), true);
  assert.equal(FAB.exceedsDragThreshold(-6, 0), true);
  assert.equal(FAB.exceedsDragThreshold(0, 6), true);
  assert.equal(FAB.exceedsDragThreshold(3, 4), false);
  assert.equal(FAB.exceedsDragThreshold(4, 5), true);
});

test("whole bar and collapsed chip are the drag surface", () => {
  const FAB = loadFab();
  assert.equal(FAB.isDragHandle("fold", { collapsed: false }), true);
  assert.equal(FAB.isDragHandle("toggle", { collapsed: false }), true);
  assert.equal(FAB.isDragHandle("restore", { collapsed: false }), true);
  assert.equal(FAB.isDragHandle("", { collapsed: false }), true);
  assert.equal(FAB.isDragHandle("toggle", { collapsed: true }), true);
  assert.match(toolbar, /function bindFabDrag\(bar\)/);
  assert.doesNotMatch(
    toolbar.slice(toolbar.indexOf("function bindFabDrag"), toolbar.indexOf("function followPointer")),
    /isLocked|collapseLocked/
  );
});

test("busy forbids collapse but still allows drag", () => {
  const FAB = loadFab();
  assert.equal(FAB.collapseLocked({ active: true, persistToast: false }), true);
  assert.equal(FAB.collapseLocked({ active: false, persistToast: true }), true);
  assert.equal(FAB.collapseLocked({ active: false, persistToast: false }), false);
  assert.match(toolbar, /function toggleFold[\s\S]*if \(isLocked\(\)\) return/);
  assert.match(toolbar, /aria-disabled/);
  assert.doesNotMatch(toolbar, /fold\.disabled/);
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

test("snap on release is bottom-left / bottom-right only at bottom:20", () => {
  const FAB = loadFab();
  assert.equal(FAB.SNAP_BOTTOM_PX, 20);
  assert.deepEqual([...FAB.ALLOWED_CORNERS], ["bottom-left", "bottom-right"]);
  assert.equal(FAB.isAllowedCorner("bottom-left"), true);
  assert.equal(FAB.isAllowedCorner("bottom-right"), true);
  assert.equal(FAB.isAllowedCorner("top-left"), false);
  assert.equal(FAB.isAllowedCorner("top-right"), false);
  assert.equal(FAB.normalizeCorner("top-left"), "bottom-right");
  assert.equal(FAB.normalizeCorner("top-right"), "bottom-right");
  assert.equal(FAB.snapCorner(100, 800), "bottom-left");
  assert.equal(FAB.snapCorner(399, 800), "bottom-left");
  assert.equal(FAB.snapCorner(400, 800), "bottom-right");
  assert.equal(FAB.snapCorner(700, 800), "bottom-right");
  const parked = css.slice(css.indexOf(".oi-fab {"), css.indexOf(".oi-fab[data-corner"));
  assert.match(parked, /bottom:\s*20px/);
  assert.doesNotMatch(css, /data-corner="top-/);
  assert.doesNotMatch(css, /data-oi-fab-corner="top-/);
  assert.doesNotMatch(toolbar, /top-left|top-right/);
});

test("toast and selection card follow corner plus --oi-fab-slot", () => {
  assert.match(toolbar, /dataset\.oiFabCorner/);
  assert.match(toolbar, /syncFabSlot/);
  assert.match(toolbar, /--oi-fab-slot/);
  assert.match(css, /\.oi-toast[\s\S]*bottom:\s*var\(--oi-fab-slot/);
  assert.match(css, /\.oi-selection-card[\s\S]*bottom:\s*var\(--oi-fab-slot/);
  assert.match(css, /html\[data-oi-fab-corner="bottom-left"\] \.oi-toast/);
  assert.match(css, /html\[data-oi-fab-corner="bottom-left"\] \.oi-selection-card/);
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
