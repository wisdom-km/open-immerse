// 原文区模式 SM-01…08（SPEC 修订 3.8）。不替换 #103 的译文|对照|原文。
// 笔记 / 问 AI / 文献库面板未上线：SM-06 走 [data-side-slot] 空钩子，不跳过测试。
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readReaderPrefs, SPLIT_TRANSLATE_MIN, SPLIT_TRANSLATE_MIN_MID, writeReaderPrefs } from "../lib/pdf-reader-flow.js";
import {
  MINI_WIDTH_DEFAULT,
  MINI_WIDTH_MAX,
  MINI_WIDTH_MIN,
  SIDE_SLOT_TOAST,
  SOURCE_MODE_NARROW_HINT,
  SOURCE_MODE_SIDE_MIN_WIDTH,
  SOURCE_POP_WIDTH,
  cycleSourceMode,
  defaultSourceMode,
  effectiveSourceMode,
  f6RegionIds,
  miniWidthFromPointer,
  normalizeMiniCollapsed,
  normalizeMiniWidth,
  normalizeSourceMode,
  sourceModeChoices,
  sourceModeMenuLabel,
  sourcePagingAllowed,
  sourcePopPlace
} from "../lib/pdf-source-mode.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const tokens = readFileSync(join(root, "ui/tokens.css"), "utf8");

test("SM-01 ≥1200 defaults to side and a choice is stored", () => {
  assert.equal(defaultSourceMode(1440), "side");
  assert.equal(defaultSourceMode(1200), "side");
  assert.deepEqual(sourceModeChoices(1440), ["side", "mini", "hidden"]);
  assert.equal(effectiveSourceMode({ width: 1440, stored: null }), "side");
  assert.equal(effectiveSourceMode({ width: 1600, stored: "mini" }), "mini");
  assert.equal(effectiveSourceMode({ width: 1600, stored: "hidden" }), "hidden");
  const store = {};
  writeReaderPrefs(store, { sourceMode: "mini", miniWidth: 400, miniCollapsed: true });
  assert.equal(store["reader.sourceMode"], "mini");
  assert.equal(store["reader.miniWidth"], "400");
  assert.equal(store["reader.miniCollapsed"], "1");
  assert.equal(readReaderPrefs(store).sourceMode, "mini");
  assert.equal(readReaderPrefs(store).miniWidth, 400);
  assert.equal(readReaderPrefs(store).miniCollapsed, true);
  assert.equal(normalizeSourceMode("split"), "side");
  assert.equal(normalizeSourceMode("float"), "mini");
  assert.equal(normalizeSourceMode("hide"), "hidden");
  assert.equal(normalizeSourceMode(""), null);
});

test("SM-02 900–945 opens as mini and backslash skips side", () => {
  assert.equal(SOURCE_MODE_SIDE_MIN_WIDTH, 946);
  assert.equal(defaultSourceMode(900), "mini");
  assert.equal(defaultSourceMode(945), "mini");
  assert.equal(effectiveSourceMode({ width: 920, stored: null }), "mini");
  assert.equal(effectiveSourceMode({ width: 920, stored: "side" }), "mini");
  assert.equal(effectiveSourceMode({ width: 920, stored: "hidden" }), "hidden");
  assert.deepEqual(sourceModeChoices(920), ["mini", "hidden"]);
  assert.deepEqual(cycleSourceMode({ width: 920, current: "mini" }), { mode: "hidden", blocked: false, toast: "" });
  assert.deepEqual(cycleSourceMode({ width: 920, current: "hidden" }), { mode: "mini", blocked: false, toast: "" });
  assert.equal(cycleSourceMode({ width: 920, current: "side" }).mode, "hidden");
  assert.equal(defaultSourceMode(946), "side");
  assert.deepEqual(sourceModeChoices(946), ["side", "mini", "hidden"]);
  assert.equal(cycleSourceMode({ width: 1200, current: "side" }).mode, "mini");
  assert.equal(cycleSourceMode({ width: 1200, current: "mini" }).mode, "hidden");
  assert.equal(cycleSourceMode({ width: 1200, current: "hidden" }).mode, "side");
});

test("SM-03 below 900 is hidden and backslash does nothing", () => {
  assert.equal(effectiveSourceMode({ width: 899, stored: "side" }), "hidden");
  assert.equal(effectiveSourceMode({ width: 600, stored: "mini" }), "hidden");
  assert.deepEqual(sourceModeChoices(899), []);
  assert.equal(cycleSourceMode({ width: 899, current: "side" }).blocked, true);
  assert.equal(cycleSourceMode({ width: 899, current: "side" }).mode, "hidden");
  assert.equal(cycleSourceMode({ width: 899, current: "side" }).toast, "");
  assert.equal(sourcePopPlace(899), "bottom");
  assert.equal(sourcePopPlace(900), "side");
  assert.equal(sourcePopPlace(1440), "side");
  assert.equal(SOURCE_POP_WIDTH, 420);
  const kept = { "reader.sourceMode": "side" };
  assert.equal(effectiveSourceMode({ width: 700, stored: readReaderPrefs(kept).sourceMode }), "hidden");
  assert.equal(kept["reader.sourceMode"], "side");
});

test("SM-04 hidden jumps open the popup; paging keys stop", () => {
  assert.equal(sourcePagingAllowed("hidden"), false);
  assert.equal(sourcePagingAllowed("side"), true);
  assert.equal(sourcePagingAllowed("mini"), true);
  const jump = viewer.slice(viewer.indexOf("function jumpTranslationToSource"), viewer.indexOf("function revealSourcePage"));
  assert.match(jump, /presentSourceForJump/);
  assert.match(jump, /paintPairChrome\(\)/);
  assert.match(jump, /#pages \.pair-box\.is-jump/);
  assert.match(jump, /syncSourcePopChrome\(page, false\)/);
  const formulaKey = viewer.slice(viewer.indexOf("function onFlowKey"), viewer.indexOf("function jumpTranslationToSource"));
  assert.match(formulaKey, /oi-pdf-inline-math/);
  assert.match(formulaKey, /jumpTranslationToSource/);
  const readout = viewer.slice(viewer.indexOf("function onReadoutBlockClick"), viewer.indexOf("function cssEscape"));
  assert.match(readout, /jumpTranslationToSource/);
  const capsule = viewer.slice(viewer.indexOf("function onPageCapsuleClick"), viewer.indexOf("function revealCapsulePage"));
  assert.match(capsule, /presentSourceForJump/);
  assert.match(viewer, /function jumpCurrentToSource/);
  assert.match(viewer, /function presentSourceForJump/);
  assert.match(viewer, /function openSourcePop/);
  const chrome = viewer.slice(viewer.indexOf("function syncSourcePopChrome"), viewer.indexOf("function toggleSourcePopFull"));
  assert.match(chrome, /原文第 \$\{n\} 页 · 已定位/);
  assert.match(chrome, /: `原文第 \$\{n\} 页`/);
  assert.match(viewer, /正在定位…/);
  assert.equal(viewer.includes("placeholderProduct"), false);
  assert.equal(viewer.includes("reader.figurePlaceholder"), false);
  assert.equal(html.includes("data-placeholder"), false);
  assert.match(html, /id="sourcePop"/);
  assert.match(html, /固定为小窗/);
  assert.match(html, /id="sourcePopClose"/);
  assert.match(viewer, /closeSourcePop\(true\)/);
  assert.match(css, /\.source-pop\[data-place="side"\]\s*\{[^}]*width:\s*420px/s);
  assert.match(css, /\.source-pop\[data-place="bottom"\]\s*\{[^}]*height:\s*64vh/s);
});

test("SM-05 mini width is 360 and drags between 300 and 480", () => {
  assert.equal(MINI_WIDTH_DEFAULT, 360);
  assert.equal(MINI_WIDTH_MIN, 300);
  assert.equal(MINI_WIDTH_MAX, 480);
  assert.equal(normalizeMiniWidth(null), 360);
  assert.equal(normalizeMiniWidth(""), 360);
  assert.equal(normalizeMiniWidth(200), 300);
  assert.equal(normalizeMiniWidth(500), 480);
  assert.equal(normalizeMiniWidth(420.4), 420);
  assert.equal(normalizeMiniCollapsed(null), false);
  assert.equal(normalizeMiniCollapsed("1"), true);
  assert.equal(miniWidthFromPointer({ clientX: 100, rect: { x: 0, width: 1440, end: 1440 }, side: "start" }), 300);
  assert.equal(miniWidthFromPointer({ clientX: 400, rect: { x: 0, width: 1440, end: 1440 }, side: "start" }), 400);
  assert.equal(miniWidthFromPointer({ clientX: 1000, rect: { x: 0, width: 1440, end: 1440 }, side: "end" }), 440);
  assert.match(css, /\.workspace\[data-source-mode="mini"\]\s*\{[^}]*--oi-mini-width:\s*360px/s);
  assert.match(css, /grid-template-columns:\s*var\(--oi-mini-width\)/);
  const layout = viewer.slice(viewer.indexOf("function applySourceLayout"), viewer.indexOf("function syncSourceModeControls"));
  assert.match(layout, /captureReaderAnchor/);
  assert.match(layout, /restoreReaderAnchor/);
  assert.match(layout, /layoutCapsule\(\{ keepAnchor: true \}\)/);
  assert.match(html, /id="sourceRail"/);
  assert.match(html, /id="sourceCollapse"/);
});

test("SM-06 side slot blocks backslash with the notes toast; absent slot does not", () => {
  const blocked = cycleSourceMode({ width: 1440, current: "side", sideSlotOpen: true });
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.mode, "side");
  assert.equal(blocked.toast, SIDE_SLOT_TOAST);
  assert.equal(SIDE_SLOT_TOAST, "请先关闭笔记 / 问 AI / 文献库面板");
  const open = cycleSourceMode({ width: 1440, current: "side", sideSlotOpen: false });
  assert.equal(open.blocked, false);
  assert.equal(open.mode, "mini");
  assert.match(html, /id="sideSlot"/);
  assert.match(html, /data-side-slot hidden/);
  assert.match(viewer, /\[data-side-slot\]/);
  assert.match(viewer, /#notesButton\[data-open='true'\]/);
  assert.match(viewer, /SIDE_SLOT_TOAST/);
  const panels = viewer.slice(viewer.indexOf("function bindViewChrome"), viewer.indexOf("function readerWidth"));
  assert.match(panels, /notesButton/);
  assert.match(panels, /showSoonToast/);
  const lib = readFileSync(join(root, "lib/pdf-source-mode.js"), "utf8");
  assert.match(lib, /请先关闭笔记 \/ 问 AI \/ 文献库面板/);
});

test("SM-07 backslash, paging, p, and F6 include the popup", () => {
  assert.match(viewer, /event\.key === "\\\\"/);
  assert.match(viewer, /jumpCurrentToSource/);
  assert.match(viewer, /sourcePagingAllowed\(currentSourceMode\(\)\)/);
  assert.match(viewer, /event\.key === "F6"/);
  assert.deepEqual(f6RegionIds({ mode: "side", side: "start" }), ["toolbar", "source", "translation"]);
  assert.deepEqual(f6RegionIds({ mode: "side", side: "end" }), ["toolbar", "translation", "source"]);
  assert.deepEqual(f6RegionIds({ mode: "hidden", popOpen: true, side: "start" }), ["toolbar", "translation", "popup"]);
  assert.deepEqual(
    f6RegionIds({ mode: "hidden", popOpen: true, sideSlotOpen: true }),
    ["toolbar", "translation", "popup", "sideSlot"]
  );
  assert.equal(sourceModeMenuLabel("side"), "原文：并排");
  assert.equal(sourceModeMenuLabel("mini"), "原文：小窗");
  assert.equal(SOURCE_MODE_NARROW_HINT, "窗口太窄，放宽到 900px 以上可用");
});

test("SM-08 keeps the view toggle, divider, and T_min", () => {
  assert.match(html, /data-tb-zones/);
  const center = html.slice(html.indexOf('data-zone="center"'), html.indexOf('data-zone="right"'));
  assert.match(center, /id="viewSeg"/);
  assert.match(center, /id="sourceModeSeg"/);
  assert.match(center, /id="sourceModeMenu"/);
  assert.match(center, /id="sourceModeNarrow"/);
  assert.match(center, /class="source-mode-kicker">原页</);
  assert.equal((html.match(/data-zone="/g) || []).length, 3);
  assert.match(html, /id="viewSeg"/);
  assert.match(html, /data-view="zh"/);
  assert.match(html, /data-view="bi"/);
  assert.match(html, /data-view="src"/);
  assert.match(html, /data-source-mode="side"/);
  assert.match(html, /data-source-mode="mini"/);
  assert.match(html, /data-source-mode="hidden"/);
  assert.equal(html.includes('data-source-mode="float"'), false);
  assert.equal(html.includes('data-source-mode="hide"'), false);
  assert.match(css, /\.workspace\[data-source-mode="hidden"\][\s\S]*grid-template-areas:\s*"translate"/);
  assert.match(css, /\.split-handle::before\s*\{[^}]*border:\s*0/s);
  assert.equal(SPLIT_TRANSLATE_MIN, 560);
  assert.equal(SPLIT_TRANSLATE_MIN_MID, 540);
  assert.match(tokens, /color-scheme:\s*dark/);
  assert.equal(viewer.includes("即将推出"), true);
  const soon = viewer.slice(viewer.indexOf("function bindViewChrome"), viewer.indexOf("function readerWidth"));
  assert.equal(soon.includes("sourceModeMenu"), false);
  assert.match(soon, /bindSourceModeChrome/);
});
