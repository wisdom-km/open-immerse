import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formulaReadabilityFloor, readerFormulaCssSize } from "../lib/pdf-formula-size.js";
import {
  READER_CAPSULE_SLOT_PX,
  READER_CPL_MIN,
  READER_FONT_DEFAULT,
  READER_FONT_SIZES,
  READER_FONT_TICKS,
  SPLIT_GAP,
  applyReaderFontAction,
  applyReaderFontSliderAction,
  effectiveReaderFontSize,
  readerAvailableMeasure,
  readerCaptionPx,
  readerCjkPerLine,
  readerEqnoPx,
  readerFontAnchorTop,
  readerFontBand,
  readerFontCapHint,
  readerFontRatio,
  readerFontSizeFromRatio,
  readerFontTracking,
  readerFontValueText,
  readerInlineCropEm,
  readerLayoutFontCap,
  readerLineHeight,
  readerParagraphGapEm,
  readerFontShortcut,
  splitLayout,
  syncReaderFontStorage
} from "../lib/pdf-reader-flow.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");

test("FS-01 slider stops are the 14 steps and only five ticks are labeled", () => {
  assert.deepEqual([...READER_FONT_SIZES], [14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 32, 36, 40]);
  assert.equal(READER_FONT_SIZES.length, 14);
  assert.deepEqual([...READER_FONT_TICKS], [16, 20, 24, 32, 40]);
  assert.equal(readerFontSizeFromRatio(0), 14);
  assert.equal(readerFontSizeFromRatio(1), 40);
  assert.equal(readerFontSizeFromRatio(readerFontRatio(16)), 16);
  assert.equal(readerFontSizeFromRatio(readerFontRatio(22)), 22);
  assert.equal(readerFontSizeFromRatio(0.5), READER_FONT_SIZES[Math.round(0.5 * 13)]);
  assert.match(html, /id="aaFontScale"[^>]*role="slider"/);
  assert.match(html, /aria-valuemin="14"/);
  assert.match(html, /aria-valuemax="40"/);
  assert.match(viewer, /READER_FONT_TICKS/);
  assert.doesNotMatch(html, /id="aaFontDown"/);
});

test("FS-02 and FS-05 the 16px default keeps line-height 1.9 and the size table", () => {
  assert.equal(READER_FONT_DEFAULT, 16);
  assert.equal(readerLineHeight(16), 1.9);
  assert.equal(Math.round(readerLineHeight(16) * 16 * 10) / 10, 30.4);
  const expected = { 16: 30.4, 20: 36, 24: 40.8, 28: 44.8, 32: 48, 40: 60 };
  for (const [size, px] of Object.entries(expected)) {
    const height = readerLineHeight(Number(size)) * Number(size);
    assert.ok(Math.abs(height - px) <= 0.5, `${size}px line box ${height}`);
  }
  assert.match(tokens, /--oi-reader-fs-num:\s*16/);
  assert.match(tokens, /--oi-reader-line-height:\s*clamp\(1\.5,/);
});

test("FS-03 stored sizes snap to a step and illegal values write back", () => {
  const kept = { "reader.fontSize": "32" };
  assert.equal(syncReaderFontStorage(kept), 32);
  assert.equal(kept["reader.fontSize"], "32");
  const legacy = { "reader.fontSize": "50" };
  assert.equal(syncReaderFontStorage(legacy), 40);
  assert.equal(legacy["reader.fontSize"], "40");
  const midway = { "reader.fontSize": "21" };
  assert.equal(syncReaderFontStorage(midway), 22);
  assert.equal(midway["reader.fontSize"], "22");
  const missing = {};
  assert.equal(syncReaderFontStorage(missing), 16);
  assert.equal(Object.hasOwn(missing, "reader.fontSize"), false);
  assert.equal(syncReaderFontStorage({ "reader.fontSize": "20" }), 20);
});

test("FS-04 slider keys and reader keys step without taking browser zoom", () => {
  assert.equal(applyReaderFontSliderAction(16, "max"), 40);
  assert.equal(applyReaderFontSliderAction(32, "min"), 14);
  assert.equal(applyReaderFontSliderAction(16, "tick-up"), 20);
  assert.equal(applyReaderFontSliderAction(20, "tick-down"), 16);
  assert.equal(applyReaderFontSliderAction(19, "tick-up"), 20);
  assert.equal(applyReaderFontSliderAction(26, "tick-up"), 32);
  assert.equal(applyReaderFontSliderAction(40, "tick-up"), 40);
  assert.equal(applyReaderFontSliderAction(14, "tick-down"), 14);
  assert.equal(applyReaderFontAction(20, "increase"), 22);
  assert.equal(applyReaderFontAction(40, "reset"), 16);
  assert.equal(readerFontShortcut({ key: "=", metaKey: true, inReader: true, singleKey: true }), "");
  assert.equal(readerFontShortcut({ key: "=", ctrlKey: true, inReader: true, singleKey: true }), "");
  const keys = viewer.slice(viewer.indexOf("function onAaFontScaleKey"), viewer.indexOf("let fontDragFrame"));
  assert.match(keys, /Home:\s*"min"/);
  assert.match(keys, /End:\s*"max"/);
  assert.match(keys, /PageUp:\s*"tick-up"/);
});

test("FS-06 a 36em measure holds about 35 CJK characters when the column is wide", () => {
  const hidden = readerAvailableMeasure({ windowWidth: 1440, columnPx: 1440 });
  assert.equal(hidden, 1315);
  for (const size of [16, 24, 32]) {
    const count = readerCjkPerLine(size, hidden);
    assert.ok(Math.abs(count - 35) <= 1, `${size}px counts ${count}`);
  }
});

test("FS-07 FS-08 FS-09 layout caps keep at least 20 CJK characters", () => {
  assert.equal(READER_CPL_MIN, 20);
  assert.equal(READER_CAPSULE_SLOT_PX, 85);
  assert.equal(splitLayout({ width: 1440, ratio: 0.5 }).translate, 716);
  assert.equal(splitLayout({ width: 1280, ratio: 0.5 }).translate, 636);
  assert.equal(splitLayout({ width: 1024, ratio: 0.5 }).translate, 618);
  const rows = [
    { windowWidth: 1440, columnPx: 716, wa: 591, cap: 28 },
    { windowWidth: 1280, columnPx: 636, wa: 511, cap: 24 },
    { windowWidth: 1024, columnPx: 618, wa: 477, cap: 22 },
    { windowWidth: 1440, columnPx: 1440 - 360 - SPLIT_GAP, wa: 947, cap: 40 },
    { windowWidth: 1280, columnPx: 1280 - 360 - SPLIT_GAP, wa: 787, cap: 36 },
    { windowWidth: 1280, columnPx: 1280 - 480 - SPLIT_GAP, wa: 667, cap: 32 },
    { windowWidth: 1440, columnPx: 1440, wa: 1315, cap: 40 },
    { windowWidth: 1280, columnPx: 1280, wa: 1155, cap: 40 },
    { windowWidth: 800, columnPx: 800, wa: 720, cap: 32 }
  ];
  for (const row of rows) {
    const wa = readerAvailableMeasure(row);
    assert.equal(wa, row.wa, `Wa at ${row.windowWidth}/${row.columnPx}`);
    assert.equal(readerLayoutFontCap(row), row.cap, `cap at ${row.windowWidth}/${row.columnPx}`);
    assert.ok(readerCjkPerLine(row.cap, wa) >= 20, `chars at cap ${row.cap}`);
  }
  assert.equal(effectiveReaderFontSize(32, 28), 28);
  assert.equal(effectiveReaderFontSize(28, readerLayoutFontCap({ windowWidth: 1280, columnPx: 636 })), 24);
  assert.equal(effectiveReaderFontSize(28, readerLayoutFontCap({ windowWidth: 1280, columnPx: 716 })), 28);
  assert.equal(effectiveReaderFontSize(36, readerLayoutFontCap({ windowWidth: 1280, columnPx: 1280 - 480 - SPLIT_GAP })), 32);
  assert.equal(effectiveReaderFontSize(36, readerLayoutFontCap({ windowWidth: 1280, columnPx: 1280 - 360 - SPLIT_GAP })), 36);
  assert.equal(readerLayoutFontCap({ windowWidth: 1440, columnPx: 1440 }), 40);
  const refresh = viewer.slice(viewer.indexOf("function refreshReaderFontCap"), viewer.indexOf("const CJK_CACHE_KEY"));
  assert.doesNotMatch(refresh, /commitSourceMode/);
});

test("FS-10 and FS-20 a cap hint keeps the setting and offers hide-source only beside the source", () => {
  const hint = readerFontCapHint({ cap: 28, setting: 32, mode: "side", hasBody: true });
  assert.equal(hint.text, "当前栏宽最大按 28px 显示，设定已保留。");
  assert.equal(hint.hideSource, true);
  assert.equal(hint.setting, 32);
  assert.equal(hint.valuetext, "设定 32 像素，当前显示 28 像素");
  assert.equal(readerFontValueText(24), "24 像素");
  assert.equal(readerFontCapHint({ cap: 40, setting: 32, mode: "hidden", hasBody: true }), null);
  assert.equal(readerFontCapHint({ cap: 28, setting: 32, mode: "mini", hasBody: false }), null);
  const narrow = readerFontCapHint({ cap: 14, setting: 32, mode: "side", hasBody: true });
  assert.equal(narrow.text, "栏太窄，建议隐藏原文或放宽窗口");
  assert.equal(narrow.hideSource, true);
  assert.equal(readerFontCapHint({ cap: 14, setting: 32, mode: "hidden", hasBody: true }).hideSource, false);
  assert.match(html, /id="aaFontHideSource"/);
  assert.match(html, /隐藏原文/);
  assert.match(viewer, /commitSourceMode\("hidden"\)/);
  const bind = viewer.slice(viewer.indexOf("function bindFontCapObserver"), viewer.indexOf("function onAaThemeKey"));
  assert.match(bind, /ResizeObserver/);
  assert.match(bind, /150/);
});

test("FS-11 chrome sizes stay on fixed tokens", () => {
  assert.match(tokens, /--oi-reader-topbar-h:\s*48px/);
  assert.match(tokens, /--oi-reader-topbar-btn-h:\s*30px/);
  assert.match(tokens, /--oi-reader-capsule-height:\s*26px/);
  assert.match(tokens, /--oi-reader-capsule-size:\s*12px/);
  assert.match(tokens, /--oi-reader-panel-width:\s*320px/);
  assert.match(tokens, /--oi-reader-ui-size:\s*13px/);
  assert.doesNotMatch(css, /\.aa-panel\s*\{[^}]*font-size:\s*var\(--oi-reader-font-size\)/);
  assert.doesNotMatch(css, /\.rf-page-capsule\s*\{[^}]*font-size:\s*var\(--oi-reader-font-size\)/);
});

test("FS-12 FS-13 paragraph gap, captions, and equation numbers follow the size", () => {
  assert.equal(readerParagraphGapEm(16), 1.125);
  assert.equal(readerParagraphGapEm(16) * 16, 18);
  const gap32 = readerParagraphGapEm(32);
  assert.ok(Math.abs(gap32 - 0.805) < 1e-9);
  assert.ok(Math.abs(gap32 * 32 - 25.76) <= 0.5);
  assert.equal(readerParagraphGapEm(40), 0.75);
  assert.equal(readerCaptionPx(16), 14);
  assert.equal(readerCaptionPx(32), 28);
  assert.equal(readerCaptionPx(14), 13);
  assert.equal(readerEqnoPx(16), 15);
  assert.equal(readerEqnoPx(32), 30);
  assert.equal(readerFontTracking(20), 0.02);
  assert.equal(readerFontTracking(28), 0.015);
  assert.equal(readerFontTracking(32), 0.01);
  assert.equal(readerFontBand(16), "s");
  assert.equal(readerFontBand(24), "m");
  assert.equal(readerFontBand(40), "l");
  assert.match(tokens, /--oi-reader-caption-font:\s*400 max\(13px, calc\(0\.875 \* var\(--oi-reader-font-size\)\)\)\/1\.6/);
  assert.match(tokens, /--oi-reader-caption-max:\s*min\(34em, 100%\)/);
  assert.match(tokens, /--oi-reader-eqno:\s*400 max\(15px, 0\.9375em\)\/1/);
  assert.match(tokens, /--oi-reader-min-measure:\s*min\(480px, 100%\)/);
  assert.match(tokens, /--oi-reader-author-name-size:\s*max\(13px, 0\.8125em\)/);
  assert.match(tokens, /--oi-reader-footnote-size:\s*max\(11px, 0\.6875em\)/);
  assert.match(css, /min-width:\s*var\(--oi-reader-min-measure\)/);
  assert.match(css, /max-width:\s*var\(--oi-reader-caption-max/);
});

test("FS-14 display formula width is the #114 width and does not gain a font scale", () => {
  const sample = { sourceBodyPt: 10, inkPt: 40, widthPt: 173, columnPx: 800 };
  const widths = READER_FONT_SIZES.map((font) => readerFormulaCssSize({ ...sample, bodyFontPx: font }).cssWidth);
  assert.equal(new Set(widths).size, 1);
  assert.ok(Math.abs(widths[0] - 173) < 0.05);
  const wide = { sourceBodyPt: 10, inkPt: 40, widthPt: 640, columnPx: 2000 };
  for (const font of [14, 28, 40]) {
    const box = readerFormulaCssSize({ ...wide, bodyFontPx: font });
    assert.equal(box.cssWidth, readerFormulaCssSize({ ...wide, bodyFontPx: 16 }).cssWidth);
  }
  assert.doesNotMatch(tokens, /--oi-reader-display-scale/);
  assert.doesNotMatch(css, /--oi-reader-display-scale/);
  assert.doesNotMatch(viewer, /--oi-reader-display-scale/);
  assert.match(viewer, /formulaReadabilityFloor\(readerShownFont\(\), bodyPt\)/);
  assert.doesNotMatch(viewer, /formulaReadabilityFloor\(readerPrefs\.fontSize/);
});

test("a setting of 32 capped at 20 uses the 20px formula floor", () => {
  const shown = effectiveReaderFontSize(32, 20);
  assert.equal(shown, 20);
  const bodyPt = 10;
  assert.equal(formulaReadabilityFloor(shown, bodyPt), formulaReadabilityFloor(20, bodyPt));
  assert.equal(formulaReadabilityFloor(20, bodyPt), 0.96);
  assert.equal(formulaReadabilityFloor(32, bodyPt), 1);
  const wide = { sourceBodyPt: bodyPt, inkPt: 40, widthPt: 640, columnPx: 400 };
  const capped = readerFormulaCssSize({ ...wide, bodyFontPx: shown });
  assert.equal(capped.k, readerFormulaCssSize({ ...wide, bodyFontPx: 20 }).k);
  assert.equal(capped.k, formulaReadabilityFloor(20, bodyPt));
  assert.equal(readerFormulaCssSize({ ...wide, bodyFontPx: 32 }).k, 1);
  const inline = { sourceBodyPt: bodyPt, inkPt: 50, widthPt: 40, columnPx: 800, inline: true };
  assert.equal(
    readerFormulaCssSize({ ...inline, bodyFontPx: shown }).raised,
    readerFormulaCssSize({ ...inline, bodyFontPx: 20 }).raised
  );
  assert.equal(readerFormulaCssSize({ ...inline, bodyFontPx: 20 }).raised, true);
  assert.equal(readerFormulaCssSize({ ...inline, bodyFontPx: 32 }).raised, false);
  assert.match(viewer, /readerFontPx: readerShownFont\(\)/);
  assert.match(viewer, /bodyFontPx: readerShownFont\(\)/);
  assert.match(viewer, /floor: readerFormulaFloor\(/);
  const refresh = viewer.slice(viewer.indexOf("function refreshReaderFontCap"), viewer.indexOf("const CJK_CACHE_KEY"));
  assert.match(refresh, /applyPaperMetrics\(\)/);
  const apply = viewer.slice(viewer.indexOf("function applyPaperMetrics"), viewer.indexOf("function bindPaperMetrics"));
  assert.match(apply, /refreshMatchedFormulas/);
  assert.match(apply, /refreshFallbackFormulaWidths/);
  const planKey = viewer.slice(viewer.indexOf("function formulaCropPlanKeyNow"), viewer.indexOf("function noteFormulaCropPlan"));
  assert.match(planKey, /readerShownFont\(\)/);
});

test("FS-15 and FS-16 inline crops and KaTeX stay on em", () => {
  assert.equal(readerInlineCropEm(16), 1.95);
  assert.equal(readerInlineCropEm(26), 1.95);
  assert.equal(readerInlineCropEm(28), 1.8);
  assert.equal(readerInlineCropEm(40), 1.8);
  assert.match(css, /height:\s*var\(--oi-pdf-inline-crop-em,\s*1\.95em\)/);
  assert.match(viewer, /--oi-pdf-inline-crop-em", "1\.8em"/);
  assert.doesNotMatch(css, /\.reader-flow[^{]*\.katex\s*\{[^}]*font-size:\s*\d+px/);
});

test("FS-17 a font change restores the same block ratio", () => {
  assert.equal(readerFontAnchorTop({ blockTop: 200, blockHeight: 80, ratio: 0.25 }), 220);
  assert.equal(readerFontAnchorTop({ blockTop: 10, blockHeight: 0, ratio: 0.5 }), 10.5);
  assert.match(viewer, /function captureFontAnchor/);
  assert.match(viewer, /restoreFontAnchor\(anchor\)/);
  const capture = viewer.slice(viewer.indexOf("function captureFontAnchor"), viewer.indexOf("function restoreFontAnchor"));
  assert.match(capture, /ratio/);
});
