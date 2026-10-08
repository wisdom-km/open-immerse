// PR-3b 选区工具条 SEL-01…SEL-23。放置与注册表是纯函数；接线用源码合同锁住。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JUMP_LOCK_MS, PAIR_ANCHOR, sourceAnchorScroll, sourceFollowScroll } from "../lib/pdf-pairing.js";
import { sourcePopPlace } from "../lib/pdf-source-mode.js";
import {
  SEL_ABOVE_CLEARANCE,
  SEL_BTN_H,
  SEL_BTN_HIT_COARSE,
  SEL_EDGE_INSET,
  SEL_FOLD_KEY,
  SEL_GAP,
  SEL_RADIUS,
  SEL_SCROLL_DISMISS,
  SEL_TOOLBAR_H,
  SEL_TOOLBAR_H_COARSE,
  blockWantsSrcFold,
  blocksMeetingSelection,
  createSrcFoldMemory,
  enabledSelActions,
  fitSelToolbar,
  jumpSourceLabel,
  mainSelActions,
  nextSelCollapse,
  overflowSelActions,
  placeSelToolbar,
  registerSelAction,
  resetSelActions,
  selAction,
  selActionList,
  selActionTarget,
  selScrollDismissed,
  selToolbarModel
} from "../lib/pdf-sel-toolbar.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");

const paired = {
  bids: ["b1", "b2"],
  pairIds: ["p3:a", "p3:b"],
  srcPage: 3,
  text: "奖励建模"
};

test("SEL-01 / SEL-18 toolbar model renders three live controls and keeps P2 actions out", () => {
  resetSelActions();
  const model = selToolbarModel(paired);
  assert.deepEqual(model.buttons.map((item) => item.label), ["看原文", "跳到原页 p.3", "⋯"]);
  assert.deepEqual(model.buttons.map((item) => item.id), ["see-source", "jump-source", "more"]);
  assert.equal(model.buttons.every((item) => item.disabled === false), true);
  assert.deepEqual(model.menu.map((item) => item.id), ["copy"]);
  assert.equal(model.menu[0].label, "复制");
  assert.equal(model.menu[0].keyshortcuts, "Meta+C");
  assert.equal(model.buttons[1].keyshortcuts, "p");
  assert.equal(model.buttons[0].keyshortcuts, "");
  assert.equal(model.buttons[2].ariaLabel, "更多");
  const ids = selActionList().map((action) => action.id);
  for (const id of ["note", "ask", "highlight", "edit-tr", "see-source", "jump-source", "copy"]) {
    assert.equal(ids.includes(id), true, id);
  }
  for (const id of ["note", "ask", "highlight", "edit-tr"]) {
    assert.equal(selAction(id).enabled(), false, id);
  }
  assert.deepEqual(mainSelActions().map((action) => action.id), ["see-source", "jump-source"]);
  assert.deepEqual(overflowSelActions().map((action) => action.id), ["copy"]);
  assert.equal(enabledSelActions().some((action) => action.id === "note"), false);
  assert.match(viewer, /selToolbarModel/);
  assert.match(viewer, /registerSelAction\(\{ id: "see-source"/);
  assert.match(viewer, /registerSelAction\(\{ id: "jump-source"/);
  assert.match(viewer, /registerSelAction\(\{ id: "copy"/);
  assert.match(viewer, /role", "toolbar"/);
  assert.match(viewer, /选区工具条/);
  const render = functionBody(viewer, "renderSelToolbar");
  assert.doesNotMatch(render, /笔记|提问|改译文|划线/);
});

test("SEL-02 / SEL-03 placement sits 8px above, flips below 44px, and clamps inside the content box", () => {
  assert.equal(SEL_GAP, 8);
  assert.equal(SEL_ABOVE_CLEARANCE, 44);
  assert.equal(SEL_EDGE_INSET, 10);
  const above = placeSelToolbar({
    anchor: { x: 80, y: 44, width: 120, height: 20 },
    toolbar: { width: 180, height: 36 },
    root: { width: 640, height: 800 }
  });
  assert.equal(above.placement, "above");
  assert.equal(above.top, 44 - 8 - 36);
  assert.equal(above.inlineStart, 80 + 60 - 90);
  const below = placeSelToolbar({
    anchor: { x: 80, y: 43, width: 120, height: 20 },
    toolbar: { width: 180, height: 36 },
    root: { width: 640, height: 800 }
  });
  assert.equal(below.placement, "below");
  assert.equal(below.top, 43 + 20 + 8);
  const clamped = placeSelToolbar({
    anchor: { x: 250, y: 80, width: 40, height: 16 },
    toolbar: { width: 200, height: 36 },
    root: { width: 300, height: 400 }
  });
  assert.equal(clamped.inlineStart, 300 - 200 - 10);
  assert.ok(clamped.inlineStart >= 10);
  assert.ok(clamped.inlineStart + 200 <= 300 - 10);
  const start = placeSelToolbar({
    anchor: { x: 0, y: 80, width: 10, height: 16 },
    toolbar: { width: 200, height: 36 },
    root: { width: 300, height: 400 }
  });
  assert.equal(start.inlineStart, 10);
  const tooWide = placeSelToolbar({
    anchor: { x: 40, y: 80, width: 10, height: 16 },
    toolbar: { width: 400, height: 36 },
    root: { width: 300, height: 400 }
  });
  assert.equal(tooWide.inlineStart, 10);
});

test("SEL-04 / SEL-05 toolbar chrome is fixed tooltip colors and grows on coarse pointers", () => {
  assert.equal(SEL_TOOLBAR_H, 36);
  assert.equal(SEL_BTN_H, 32);
  assert.equal(SEL_RADIUS, 8);
  assert.equal(SEL_TOOLBAR_H_COARSE, 48);
  assert.equal(SEL_BTN_HIT_COARSE, 44);
  assert.match(tokens, /--oi-reader-tooltip-bg:\s*#22201C/);
  assert.match(tokens, /--oi-reader-tooltip-fg:\s*#F7F3EA/);
  assert.equal(tokens.match(/--oi-reader-tooltip-bg:/g).length, 1);
  for (const theme of ["warm", "white", "sepia", "green"]) {
    const start = tokens.indexOf(`data-reader-theme="${theme}"`);
    const next = tokens.indexOf("data-reader-theme=", start + 20);
    const block = tokens.slice(start, next === -1 ? undefined : next);
    assert.equal(block.includes("tooltip"), false, theme);
  }
  assert.match(css, /\.oi-sel-toolbar\s*\{[^}]*height:\s*36px/);
  assert.match(css, /\.oi-sel-toolbar\s*\{[^}]*border-radius:\s*8px/);
  assert.match(css, /\.oi-sel-toolbar\s*\{[^}]*background:\s*var\(--oi-reader-tooltip-bg\)/);
  assert.match(css, /\.oi-sel-toolbar\s*\{[^}]*color:\s*var\(--oi-reader-tooltip-fg\)/);
  assert.match(css, /\.oi-sel-btn\s*\{[^}]*height:\s*32px/);
  assert.match(css, /\.oi-sel-btn\s*\{[^}]*min-height:\s*32px/);
  assert.match(css, /\.oi-sel-btn\s*\{[^}]*padding:\s*0 10px/);
  assert.match(css, /\.oi-sel-menu \[role="menuitem"\]\s*\{[^}]*height:\s*32px/);
  assert.match(css, /\.oi-sel-menu \[role="menuitem"\]\s*\{[^}]*min-height:\s*32px/);
  assert.match(css, /\.oi-src-strip-x\s*\{[^}]*width:\s*24px/);
  assert.match(css, /\.oi-src-strip-x\s*\{[^}]*height:\s*24px/);
  assert.match(css, /\.oi-src-strip-x\s*\{[^}]*min-height:\s*24px/);
  assert.match(css, /\.oi-sel-btn\s*\{[^}]*font:\s*400 13px\/1 var\(--oi-reader-ui-font\)/);
  assert.match(css, /\.oi-sel-btn:hover:not\(:disabled\)\s*\{[^}]*background:\s*#444444/);
  assert.match(css, /color-mix\(in srgb, var\(--oi-reader-tooltip-fg\) 38%, transparent\)/);
  assert.match(css, /@media \(pointer:\s*coarse\)\s*\{[^}]*\.oi-sel-toolbar\s*\{[^}]*height:\s*48px/);
  assert.match(css, /@media \(pointer:\s*coarse\)\s*\{[\s\S]*?\.oi-sel-btn\s*\{[^}]*height:\s*44px/);
  assert.match(css, /height:\s*max\(100%, 44px\)/);
});

test("SEL-06 copy is the only menu item and does not take over the system copy keys", () => {
  const copy = functionBody(viewer, "copySelectionText");
  assert.match(copy, /navigator\.clipboard\?\.writeText/);
  assert.match(copy, /execCommand\("copy"\)/);
  assert.match(copy, /closeSelToolbar\(\{ restore: false \}\)/);
  assert.match(copy, /已复制/);
  const menu = functionBody(viewer, "selMenuButton");
  assert.match(menu, /item\.label/);
  assert.match(menu, /⌘C/);
  assert.match(menu, /menuitem/);
  const onKey = viewer.slice(viewer.indexOf("function onKey"), viewer.indexOf("function eventTargetIsField"));
  assert.match(onKey, /if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.altKey\) return;/);
  assert.doesNotMatch(onKey, /preventDefault\(\)[\s\S]{0,80}copy|clipboard/);
});

test("SEL-07 / SEL-19 keyboard opens the toolbar, roves, and escape restores the selection", () => {
  const onKey = viewer.slice(viewer.indexOf("function onKey"), viewer.indexOf("function eventTargetIsField"));
  assert.match(onKey, /event\.key === "F10" && event\.shiftKey/);
  assert.match(onKey, /openSelToolbarFromSelection\(\{ focus: true \}\)/);
  const escMenu = onKey.indexOf("closeSelMenu()");
  const escBar = onKey.indexOf("closeSelToolbar({ restore: true, dismissPeek: true })");
  assert.ok(escMenu > 0 && escBar > escMenu);
  const gesture = functionBody(viewer, "onSelGestureEnd");
  assert.match(gesture, /event\.target\?\.closest\?\.\("\.oi-sel-toolbar, \.oi-sel-menu"\)/);
  assert.match(gesture, /document\.activeElement\?\.closest\?\.\("\.oi-sel-toolbar, \.oi-sel-menu"\)/);
  assert.match(gesture, /if \(inChrome\) return/);
  const show = functionBody(viewer, "showSelToolbar");
  assert.match(show, /!focus && !bar\.hidden && selCtx\?\.key === ctx\.key/);
  const rove = functionBody(viewer, "onSelToolbarRoving");
  assert.match(rove, /ArrowRight/);
  assert.match(rove, /ArrowLeft/);
  assert.match(rove, /stopPropagation/);
  const menuKey = functionBody(viewer, "onSelMenuKey");
  assert.match(menuKey, /ArrowDown/);
  assert.match(menuKey, /ArrowUp/);
  assert.match(menuKey, /closeSelMenu/);
  assert.match(css, /\.oi-sel-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-focus\)/);
  assert.match(css, /outline-offset:\s*2px/);
  assert.match(viewer, /setAttribute\("role", "toolbar"\)/);
  assert.match(viewer, /setAttribute\("role", "menu"\)/);
  assert.match(viewer, /aria-haspopup", "menu"/);
  assert.match(viewer, /aria-label", item\.ariaLabel/);
  assert.equal(selToolbarModel(paired).buttons.find((item) => item.id === "more").ariaLabel, "更多");
});

test("SEL-08 unpaired selection disables see-source and jump without dropping the buttons", () => {
  const model = selToolbarModel({ bids: ["bare"], pairIds: [""], srcPage: 2, text: "无配对" });
  assert.equal(model.buttons.find((item) => item.id === "see-source").disabled, true);
  assert.equal(model.buttons.find((item) => item.id === "jump-source").disabled, true);
  assert.equal(model.buttons.find((item) => item.id === "see-source").title, "这段没有配对");
  assert.equal(model.buttons.find((item) => item.id === "more").disabled, false);
  assert.equal(model.menu[0].disabled, false);
  assert.equal(selToolbarButtonUsesTitle(), true);
});

test("SEL-09 / SEL-10 / SEL-12 see-source peeks with a lock and an inline strip, and does not pop hidden source", () => {
  const see = functionBody(viewer, "seeSourceForSelection");
  assert.match(see, /scrollSourcePeek/);
  assert.match(see, /armJumpLock\(\)/);
  assert.match(see, /paintPairChrome\(\)/);
  assert.match(see, /translateScrollRoot\(\)/);
  assert.doesNotMatch(see, /applyFollow|presentSourceForJump|openSourcePop|setMiniCollapsed/);
  assert.match(see, /dataset\.view \|\| "zh"/);
  assert.match(see, /view === "bi"/);
  assert.match(see, /expandSrcFold/);
  assert.match(see, /insertInlineSource/);
  const peek = functionBody(viewer, "scrollSourcePeek");
  assert.match(peek, /sourceFollowScroll/);
  assert.doesNotMatch(peek, /sourceAnchorScroll|applyFollow/);
  assert.match(peek, /clientHeight > 1/);
  const strip = functionBody(viewer, "insertInlineSource");
  assert.match(strip, /oi-src-strip/);
  assert.match(strip, /原文 ·/);
  assert.match(strip, /已显示原文/);
  assert.match(strip, /aria-live", "polite"/);
  assert.match(strip, /关闭原文/);
  assert.match(strip, /dismissSeeSource/);
  assert.match(css, /\.oi-src-strip\s*\{[^}]*margin-top:\s*-8px/);
  assert.match(css, /\.oi-src-strip\s*\{[^}]*margin-bottom:\s*16px/);
  assert.match(css, /\.oi-src-strip\s*\{[^}]*border-inline-start:\s*2px solid var\(--oi-reader-pair\)/);
  assert.match(css, /\.oi-src-strip-k\s*\{[^}]*13px\/1\.6 var\(--oi-reader-ui-font\)/);
  assert.match(css, /\.oi-src-strip-text\s*\{[^}]*14px\/1\.6 var\(--oi-reader-latin\)/);
  assert.equal(JUMP_LOCK_MS >= 1400, true);
  const dismiss = functionBody(viewer, "dismissSeeSource");
  assert.match(dismiss, /oi-src-strip/);
  assert.match(dismiss, /is-see-source/);
  assert.match(dismiss, /peekPairId/);
  const show = functionBody(viewer, "showSelToolbar");
  assert.match(show, /seeSourceKey !== ctx\.key\) dismissSeeSource/);
});

test("SEL-11 compare view expands the source fold and o toggles it without Shift+O", () => {
  assert.equal(blockWantsSrcFold({ label: "text", sourceText: "Attention" }), true);
  assert.equal(blockWantsSrcFold({ label: "heading", sourceText: "Abstract" }), true);
  assert.equal(blockWantsSrcFold({ label: "formula", sourceText: "x" }), false);
  assert.equal(blockWantsSrcFold({ label: "figure", sourceText: "fig" }), false);
  assert.equal(blockWantsSrcFold({ label: "table", sourceText: "t" }), false);
  assert.equal(blockWantsSrcFold({ label: "text", sourceText: "  " }), false);
  const store = new Map();
  const memory = createSrcFoldMemory({
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value)
  });
  assert.equal(SEL_FOLD_KEY, "oi.rfSrcFold");
  assert.equal(memory.has("bid-a"), false);
  assert.equal(memory.toggle("bid-a"), true);
  assert.equal(memory.has("bid-a"), true);
  const again = createSrcFoldMemory({
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value)
  });
  assert.equal(again.has("bid-a"), true);
  again.collapse("bid-a");
  assert.equal(memory.has("bid-a"), false);
  memory.expand("bid-b");
  assert.equal(again.has("bid-b"), true);
  assert.match(viewer, /mountSrcFolds\(slot\)/);
  assert.match(viewer, /createSrcFoldMemory/);
  const mount = functionBody(viewer, "mountSrcFolds");
  assert.match(mount, /blockWantsSrcFold/);
  assert.match(mount, /rf-src-fold/);
  assert.match(mount, /:scope > \.rf-src/);
  const label = functionBody(viewer, "setSrcFoldOpen");
  assert.match(label, /▾ 原文 · 收起（o）/);
  assert.match(label, /▸ 原文/);
  assert.match(css, /\.workspace\[data-view="bi"\] \.rf-src-fold-toggle\s*\{[^}]*height:\s*24px/);
  assert.match(css, /\.workspace\[data-view="bi"\] \.rf-src-fold-toggle\s*\{[^}]*min-height:\s*24px/);
  assert.match(css, /\.workspace\[data-view="bi"\] \.rf-src-fold\[data-open="true"\] \.rf-src\s*\{[^}]*display:\s*block/);
  assert.match(css, /\.rf-src-fold-panel\.is-see-source\s*\{[^}]*background:\s*var\(--oi-reader-pair-bg\)/);
  assert.match(css, /\.workspace:not\(\[data-view="src"\]\) \.rf-src\s*\{[^}]*display:\s*none/);
  const onKey = viewer.slice(viewer.indexOf("function onKey"), viewer.indexOf("function eventTargetIsField"));
  assert.match(onKey, /!event\.shiftKey/);
  assert.match(onKey, /event\.key === "o"/);
  assert.match(onKey, /toggleFocusedSrcFold/);
  assert.equal(viewer.includes("Shift+O"), false);
  assert.doesNotMatch(onKey, /event\.key === "O"/);
});

test("SEL-13 / SEL-14 / SEL-15 jump forces the 30% anchor, restores follow, and reuses source presentation", () => {
  assert.equal(PAIR_ANCHOR, 0.3);
  const forced = sourceAnchorScroll({ rectTop: 500, clientHeight: 400, scrollHeight: 2000, anchor: PAIR_ANCHOR });
  assert.equal(forced, 500 - 0.3 * 400);
  assert.equal(sourceFollowScroll({
    rectTop: 100,
    rectBottom: 180,
    scrollTop: 40,
    clientHeight: 400,
    scrollHeight: 2000
  }), null);
  const jump = functionBody(viewer, "jumpTranslationToSource");
  assert.match(jump, /presentSourceForJump/);
  assert.match(jump, /scrollSourceToRect/);
  assert.match(jump, /applyFollow\(\{ type: "clickJump" \}\)/);
  assert.match(jump, /armJumpLock\(\)/);
  assert.match(jump, /paintPairChrome\(\)/);
  assert.match(jump, /#pages \.pair-box\.is-jump/);
  assert.match(jump, /dismissSeeSource\(\)/);
  const scroll = functionBody(viewer, "scrollSourceToRect");
  assert.match(scroll, /sourceAnchorScroll/);
  const present = functionBody(viewer, "presentSourceForJump");
  assert.match(present, /mode === "hidden"/);
  assert.match(present, /openSourcePop/);
  assert.match(present, /miniCollapsed/);
  assert.match(present, /setMiniCollapsed\(false\)/);
  const open = functionBody(viewer, "openSourcePop");
  assert.doesNotMatch(open, /sideSlotOpen/);
  assert.match(viewer, /placeSourcePop\(sourcePopPlace/);
  assert.equal(sourcePopPlace(899), "bottom");
  assert.equal(sourcePopPlace(900), "side");
  const paint = functionBody(viewer, "paintSourceHighlight");
  assert.match(paint, /is-jump/);
  assert.match(paint, /is-peek/);
  assert.match(css, /\.pair-box\.is-peek\s*\{[^}]*border:\s*var\(--oi-reader-pair-jump-w\)/);
  assert.match(css, /\.pair-box\.is-peek\s*\{[^}]*box-shadow:\s*none/);
  assert.match(css, /\.pair-box\.is-jump\s*\{[^}]*box-shadow:\s*0 0 0 var\(--oi-reader-pair-halo-width\)/);
});

test("SEL-16 p jumps the live selection and otherwise keeps the current-block jump", () => {
  const onKey = viewer.slice(viewer.indexOf("function onKey"), viewer.indexOf("function eventTargetIsField"));
  assert.match(onKey, /if \(!jumpSelectionIfLive\(\)\) jumpCurrentToSource\(\)/);
  const live = functionBody(viewer, "jumpSelectionIfLive");
  assert.match(live, /readSelContext\(\)/);
  assert.match(live, /jumpSourceForSelection\(ctx\)/);
  assert.match(live, /return true/);
  assert.match(live, /return false/);
  const jumpSel = functionBody(viewer, "jumpSourceForSelection");
  assert.match(jumpSel, /selStartBlock/);
  assert.match(jumpSel, /jumpTranslationToSource\(block\)/);
  assert.match(jumpSel, /followState === "off"/);
  assert.match(jumpSel, /applyFollow\(\{ type: "toggle" \}\)/);
  assert.match(jumpSel, /followState === "paused"/);
  assert.match(jumpSel, /applyFollow\(\{ type: "resume" \}\)/);
  assert.match(viewer, /function jumpCurrentToSource/);
});

test("SEL-17 swapped panes still use the shared jump and peek paths", () => {
  for (const name of ["seeSourceForSelection", "jumpSourceForSelection", "jumpTranslationToSource", "scrollSourcePeek"]) {
    assert.doesNotMatch(functionBody(viewer, name), /sourceSide/, name);
  }
  assert.match(viewer, /function toggleSourceSide/);
  assert.match(viewer, /reorderPanes/);
});

test("SEL-20 structure matches the selection toolbar mock: three actions, inline strip, dark chrome", () => {
  assert.match(css, /\.oi-sel-toolbar\s*\{/);
  assert.match(css, /\.oi-sel-btn\s*\{/);
  assert.match(css, /\.oi-sel-menu\s*\{[^}]*background:\s*var\(--oi-reader-tooltip-bg\)/);
  assert.match(css, /\.oi-src-strip\s*\{/);
  assert.match(css, /\.rf-src-fold\s*\{/);
  assert.match(viewer, /data-sel-action/);
  assert.equal(selToolbarModel(paired).buttons.length, 3);
});

test("SEL-21 scroll past 24px dismisses, and narrow bars collapse toward the more button", () => {
  assert.equal(SEL_SCROLL_DISMISS, 24);
  assert.equal(selScrollDismissed(0, 24), false);
  assert.equal(selScrollDismissed(0, 24.01), true);
  assert.equal(selScrollDismissed(80, 56), false);
  assert.equal(selScrollDismissed(80, 55), true);
  assert.match(functionBody(viewer, "noteSelToolbarScroll"), /selScrollDismissed/);
  assert.match(functionBody(viewer, "onTranslateScroll"), /noteSelToolbarScroll\(\)/);
  const main = [
    { id: "edit-tr" },
    { id: "note" },
    { id: "see-source" },
    { id: "jump-source" }
  ];
  const widths = { "edit-tr": 80, note: 70, "see-source": 80, "jump-source": 120 };
  const fitted = fitSelToolbar({
    main,
    overflow: [{ id: "copy" }],
    widths,
    available: 200,
    moreWidth: 36
  });
  assert.deepEqual(fitted.main.map((item) => item.id), ["see-source"]);
  assert.deepEqual(fitted.overflow.map((item) => item.id), ["copy", "edit-tr", "note", "jump-source"]);
  const roomy = fitSelToolbar({ main, overflow: [], widths, available: 1000, moreWidth: 36 });
  assert.equal(roomy.main.length, 4);
  assert.equal(nextSelCollapse(["see-source", "jump-source"]), "jump-source");
  assert.equal(nextSelCollapse(["see-source"]), "");
  const collapsed = selToolbarModel(paired, { collapsedIds: ["jump-source"] });
  assert.deepEqual(collapsed.buttons.map((item) => item.id), ["see-source", "more"]);
  assert.deepEqual(collapsed.menu.map((item) => item.id), ["jump-source", "copy"]);
  assert.match(functionBody(viewer, "showSelToolbar"), /nextSelCollapse/);
});

test("SEL-22 / SEL-23 jump label uses the start block page and cross-block hits stay in reading order", () => {
  assert.equal(jumpSourceLabel(1), "跳到原页 p.1");
  assert.equal(jumpSourceLabel(3), "跳到原页 p.3");
  assert.equal(jumpSourceLabel(0), "跳到原页");
  assert.deepEqual(selToolbarModel({ bids: ["a"], pairIds: ["p1"], srcPage: 1, text: "Attention" }).buttons[1].label, "跳到原页 p.1");
  const blocks = [
    { bid: "later", box: { x: 0, y: 40, width: 100, height: 20 } },
    { bid: "start", box: { x: 0, y: 0, width: 100, height: 20 } },
    { bid: "start", box: { x: 0, y: 0, width: 100, height: 20 } },
    { bid: "miss", box: { x: 0, y: 200, width: 40, height: 10 } },
    { bid: "", box: { x: 0, y: 0, width: 100, height: 20 } }
  ];
  const rects = [
    { x: 10, y: 4, width: 30, height: 8 },
    { x: 10, y: 44, width: 30, height: 8 }
  ];
  assert.deepEqual(blocksMeetingSelection(blocks, rects).map((block) => block.bid), ["later", "start"]);
  const target = selActionTarget({ bids: ["start", "later"], pairIds: ["p1:start", ""], srcPage: 1 });
  assert.equal(target.bid, "start");
  assert.equal(target.pairId, "p1:start");
  assert.equal(target.paired, true);
  assert.equal(target.srcPage, 1);
  const unpairedStart = selActionTarget({ bids: ["bare", "paired"], pairIds: ["", "p9"], srcPage: 4 });
  assert.equal(unpairedStart.paired, false);
  assert.equal(unpairedStart.bid, "bare");
  const see = functionBody(viewer, "selStartBlock");
  assert.match(see, /bids\?\.\[0\]/);
  assert.match(viewer, /blocksMeetingSelection/);
});

test("registerSelAction replaces a run without dropping the slot metadata", () => {
  resetSelActions();
  let ran = 0;
  registerSelAction({ id: "see-source", run: () => { ran += 1; } });
  const action = selAction("see-source");
  assert.equal(action.order, 30);
  assert.equal(action.slot, "main");
  assert.equal(action.enabled(), true);
  action.run();
  assert.equal(ran, 1);
  resetSelActions();
});

function selToolbarButtonUsesTitle() {
  return functionBody(viewer, "selToolbarButton").includes("这段没有配对");
}

function functionBody(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  let paren = 0;
  let body = -1;
  for (let i = source.indexOf("(", start); i < source.length; i += 1) {
    if (source[i] === "(") paren += 1;
    else if (source[i] === ")") {
      paren -= 1;
      if (paren === 0) {
        body = source.indexOf("{", i);
        break;
      }
    }
  }
  assert.ok(body > start, name);
  let depth = 0;
  for (let i = body; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(name);
}
