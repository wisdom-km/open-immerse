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

test("release keeps free left/top and does not snap to a corner", () => {
  const FAB = loadFab();
  assert.equal(FAB.SNAP_BOTTOM_PX, 20);
  assert.deepEqual([...FAB.ALLOWED_CORNERS], ["bottom-left", "bottom-right"]);
  const fromRight = FAB.cornerToPos({
    corner: "bottom-right",
    width: 120,
    height: 52,
    viewportWidth: 800,
    viewportHeight: 600,
    inset: 20
  });
  assert.equal(fromRight.left, 660);
  assert.equal(fromRight.top, 528);
  const fromLeft = FAB.cornerToPos({
    corner: "bottom-left",
    width: 120,
    height: 52,
    viewportWidth: 800,
    viewportHeight: 600,
    inset: 20
  });
  assert.equal(fromLeft.left, 20);
  assert.equal(fromLeft.top, 528);
  const parkedPos = FAB.normalizePos({ left: 120, top: 240 });
  assert.equal(parkedPos.left, 120);
  assert.equal(parkedPos.top, 240);
  assert.equal(FAB.normalizePos({ left: "x", top: 1 }), null);
  assert.equal(FAB.normalizePos(null), null);
  const finish = toolbar.slice(toolbar.indexOf("const finish ="), toolbar.indexOf("bar.addEventListener(\"pointerdown\""));
  assert.match(finish, /applyFreePos/);
  assert.doesNotMatch(finish, /snapCorner/);
  assert.doesNotMatch(finish, /applyCorner/);
  assert.doesNotMatch(finish, /style\.left = ""/);
  assert.doesNotMatch(toolbar, /bindCornerSnap/);
  const parked = css.slice(css.indexOf(".oi-fab {"), css.indexOf(".oi-fab[data-corner"));
  assert.match(parked, /bottom:\s*20px/);
  assert.match(css, /oi-fab-free/);
  assert.doesNotMatch(css, /data-corner="top-/);
  assert.doesNotMatch(toolbar, /top-left|top-right/);
});

test("toast and selection card follow the actual FAB box", () => {
  const FAB = loadFab();
  assert.equal(FAB.toastSlotFromBox({ top: 500, height: 52, viewportHeight: 600, gap: 12 }), 112);
  const above = FAB.toastPlacementFromBox({ top: 500, height: 52, viewportHeight: 600, gap: 12 });
  assert.equal(above.slot, 112);
  assert.equal(above.top, "auto");
  const below = FAB.toastPlacementFromBox({ top: 20, height: 52, viewportHeight: 600, gap: 12 });
  assert.equal(below.slot, "auto");
  assert.equal(below.top, "84px");
  const leftAlign = FAB.toastAlignFromBox({ left: 40, width: 120, viewportWidth: 800 });
  assert.equal(leftAlign.side, "left");
  assert.equal(leftAlign.left, "40px");
  assert.equal(leftAlign.right, "auto");
  const rightAlign = FAB.toastAlignFromBox({ left: 660, width: 120, viewportWidth: 800 });
  assert.equal(rightAlign.side, "right");
  assert.equal(rightAlign.left, "auto");
  assert.equal(rightAlign.right, "20px");
  assert.match(toolbar, /toastPlacementFromBox/);
  assert.match(toolbar, /toastAlignFromBox/);
  assert.match(toolbar, /--oi-fab-slot/);
  assert.match(toolbar, /--oi-fab-toast-left/);
  assert.match(css, /\.oi-toast[\s\S]*bottom:\s*var\(--oi-fab-slot/);
  assert.match(css, /\.oi-selection-card[\s\S]*bottom:\s*var\(--oi-fab-slot/);
  assert.match(css, /--oi-fab-toast-left/);
  assert.match(css, /--oi-fab-toast-right/);
});

test("toolbar follows the pointer, parks in place, persists, and suppresses the click", () => {
  assert.match(toolbar, /bindFabDrag/);
  assert.match(toolbar, /exceedsDragThreshold/);
  assert.match(toolbar, /clampDragPosition/);
  assert.match(toolbar, /DRAG_THRESHOLD_PX/);
  assert.match(toolbar, /style\.left/);
  assert.match(toolbar, /style\.top/);
  assert.match(toolbar, /oi-fab-dragging/);
  assert.match(toolbar, /oi-fab-free/);
  assert.match(toolbar, /dataset\.oiDragged/);
  assert.match(toolbar, /applyFreePos/);
  assert.match(toolbar, /persistPos/);
  assert.match(toolbar, /fabPos/);
  assert.match(toolbar, /POS_STORAGE_KEY/);
  assert.match(toolbar, /syncFabSlot/);
  assert.match(toolbar, /readPos\(settings\)/);
  assert.match(toolbar, /cornerToPos/);
  assert.doesNotMatch(toolbar, /bindCornerSnap/);
  assert.doesNotMatch(toolbar, /SNAP_PX/);
  const finish = toolbar.slice(toolbar.indexOf("const finish ="), toolbar.indexOf("bar.addEventListener(\"pointerdown\""));
  assert.doesNotMatch(finish, /snapCorner\(/);
});

test("FAB-ELEGANCE §8: free park, persist, migrate, toast after release, resize clamp", () => {
  const FAB = loadFab();
  assert.equal(FAB.SLOT_INSET, 20);
  assert.equal(FAB.POS_STORAGE_KEY, "oi-fab-pos");
  const finish = toolbar.slice(toolbar.indexOf("const finish ="), toolbar.indexOf("bar.addEventListener(\"pointerdown\""));
  assert.match(finish, /applyFreePos\(bar, \{ left: rect\.left, top: rect\.top \}\)/);
  assert.match(finish, /syncFabSlot\(bar\)/);
  assert.doesNotMatch(finish, /snapCorner\(/);
  assert.doesNotMatch(finish, /applyCorner\(/);
  assert.match(toolbar, /persistPos/);
  assert.match(toolbar, /fabPos: payload/);
  assert.match(toolbar, /POS_STORAGE_KEY/);
  assert.match(toolbar, /cornerToPos/);
  assert.match(toolbar, /if \(savedPos\)/);
  assert.match(toolbar, /addEventListener\("resize"/);
  const resize = toolbar.slice(toolbar.indexOf("addEventListener(\"resize\""), toolbar.indexOf("oi-running"));
  assert.match(resize, /applyFreePos/);
  assert.match(resize, /clampDragPosition|oi-fab-free/);
  assert.match(toolbar, /function persistPos[\s\S]*localStorage\.removeItem\(FAB\.STORAGE_KEY\)/);
});

test("drag CSS does not steal 翻译/原文 pointer cursor until grabbing", () => {
  const buttons = css.slice(css.indexOf(".oi-fab > button {"), css.indexOf(".oi-fab > button[data-act=\"toggle\"]"));
  assert.match(buttons, /cursor:\s*pointer/);
  assert.match(css, /\.oi-fab-dragging > button \{\s*cursor:\s*grabbing/);
  assert.match(css, /touch-action:\s*none/);
});
