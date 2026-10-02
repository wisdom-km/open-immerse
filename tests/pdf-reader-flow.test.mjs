import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READER_FONT_DEFAULT,
  READER_FONT_SIZES,
  READER_THEME_DEFAULT,
  READER_THEMES,
  applyReaderFontAction,
  capsuleLabel,
  capsulePlacement,
  clearFadeScroll,
  contentPagesForScope,
  defaultSplitRatio,
  formulaScrollLeft,
  indexFormulaScrolls,
  needsFade,
  normalizeReaderFontSize,
  normalizeReaderTheme,
  pageAtAnchor,
  pageBreakLabel,
  planReaderFlow,
  precompositeMultiplyPixels,
  readReaderPrefs,
  readerFontShortcut,
  readerImageBlend,
  readerThemeAriaLabel,
  splitLayout,
  stepReaderFontSize,
  themePaperRgb,
  untranslatedLabel,
  writeReaderPrefs
} from "../lib/pdf-reader-flow.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const globalTokens = readFileSync(join(root, "ui/tokens.css"), "utf8");

test("font steps stay on 14/15/16/17/18/20 and remember the chosen step", () => {
  assert.deepEqual([...READER_FONT_SIZES], [14, 15, 16, 17, 18, 20]);
  assert.equal(READER_FONT_DEFAULT, 16);
  assert.equal(normalizeReaderFontSize(undefined), 16);
  assert.equal(normalizeReaderFontSize("15"), 15);
  assert.equal(normalizeReaderFontSize(13), 16);
  assert.equal(normalizeReaderFontSize(19), 16);
  assert.equal(stepReaderFontSize(16, -1), 15);
  assert.equal(stepReaderFontSize(14, -1), 14);
  assert.equal(stepReaderFontSize(18, 1), 20);
  assert.equal(stepReaderFontSize(20, 1), 20);
  assert.equal(applyReaderFontAction(20, "decrease"), 18);
  assert.equal(applyReaderFontAction(14, "increase"), 15);
  assert.equal(applyReaderFontAction(20, "reset"), 16);
  const store = {};
  assert.deepEqual(writeReaderPrefs(store, { fontSize: 20, theme: "green", singleKey: true }), {
    fontSize: 20,
    theme: "green",
    singleKey: true,
    splitRatio: null
  });
  assert.equal(store["reader.fontSize"], "20");
  assert.equal(store["reader.theme"], "green");
  assert.deepEqual(readReaderPrefs(store), { fontSize: 20, theme: "green", singleKey: true, splitRatio: null });
  store["reader.fontSize"] = "13";
  assert.equal(readReaderPrefs(store).fontSize, 16);
});

test("reader font keys ignore fields, editing, and modifier chords", () => {
  const base = { inReader: true, singleKey: true };
  assert.equal(readerFontShortcut({ ...base, key: "-" }), "decrease");
  assert.equal(readerFontShortcut({ ...base, key: "=" }), "increase");
  assert.equal(readerFontShortcut({ ...base, key: "+" }), "increase");
  assert.equal(readerFontShortcut({ ...base, key: "0" }), "reset");
  assert.equal(readerFontShortcut({ ...base, key: "-", metaKey: true }), "");
  assert.equal(readerFontShortcut({ ...base, key: "=", ctrlKey: true }), "");
  assert.equal(readerFontShortcut({ ...base, key: "0", altKey: true }), "");
  assert.equal(readerFontShortcut({ ...base, key: "-", inField: true }), "");
  assert.equal(readerFontShortcut({ ...base, key: "=", editing: true }), "");
  assert.equal(readerFontShortcut({ ...base, key: "-", inReader: false }), "");
  assert.equal(readerFontShortcut({ ...base, key: "-", singleKey: false }), "");
  assert.equal(readerFontShortcut({ ...base, key: "j" }), "");
});

test("theme switch normalizes to warm/white/sepia/green and remembers the choice", () => {
  assert.deepEqual([...READER_THEMES], ["warm", "white", "sepia", "green"]);
  assert.equal(READER_THEME_DEFAULT, "warm");
  assert.equal(normalizeReaderTheme(""), "warm");
  assert.equal(normalizeReaderTheme("sepia"), "sepia");
  assert.equal(normalizeReaderTheme("dark"), "warm");
  assert.equal(readerThemeAriaLabel("warm"), "暖纸（默认）");
  assert.equal(readerThemeAriaLabel("white"), "纯白");
  assert.equal(readerThemeAriaLabel("sepia"), "灰褐");
  assert.equal(readerThemeAriaLabel("green"), "淡灰绿");
  const store = { "reader.theme": "white", "reader.fontSize": "18" };
  assert.equal(readReaderPrefs(store).theme, "white");
  assert.equal(readReaderPrefs(store).fontSize, 18);
  assert.equal(readReaderPrefs({}).theme, "warm");
  assert.equal(readReaderPrefs({ "reader.singleKey": "0" }).singleKey, false);
});

test("reader tokens stay on the reader scope and do not edit tokens.css", () => {
  assert.match(tokens, /\.oi-reader\[data-reader-theme="warm"\]/);
  assert.match(tokens, /\.oi-reader\[data-reader-theme="white"\]/);
  assert.match(tokens, /\.oi-reader\[data-reader-theme="sepia"\]/);
  assert.match(tokens, /\.oi-reader\[data-reader-theme="green"\]/);
  for (const theme of ["warm", "white", "sepia", "green"]) {
    assert.match(tokens, new RegExp(`--oi-reader-${theme}-paper:`));
    assert.match(tokens, new RegExp(`--oi-reader-${theme}-ink:`));
    assert.match(tokens, new RegExp(`--oi-reader-paper:\\s*var\\(--oi-reader-${theme}-paper\\)`));
  }
  assert.match(tokens, /--oi-reader-font:/);
  assert.match(tokens, /--oi-reader-measure:/);
  assert.match(tokens, /--oi-reader-line-height:/);
  assert.match(tokens, /--oi-reader-panel-shadow:/);
  assert.doesNotMatch(globalTokens, /--oi-reader-paper/);
  assert.doesNotMatch(globalTokens, /data-reader-theme/);
  assert.match(html, /reader-tokens\.css/);
  assert.match(html, /href="\.\.\/ui\/tokens\.css"/);
});

test("continuous flow replaces the paper stack and keeps the title mount", () => {
  assert.match(html, /id="readerFlow"[^>]*class="reader-flow"/);
  assert.match(html, /class="oi-reader"[^>]*data-reader-theme="warm"/);
  assert.doesNotMatch(html, /id="paperStack"/);
  assert.doesNotMatch(html, /id="viewSeg"/);
  assert.doesNotMatch(html, /id="mirrorPages"/);
  assert.doesNotMatch(html, /class="readout-paper"/);
  assert.match(css, /\.reader-flow\s*\{[^}]*width:\s*var\(--rf-measure,\s*min\(var\(--oi-reader-measure\)/s);
  assert.match(css, /\.reader-flow\s*\{[^}]*font-size:\s*var\(--oi-reader-font-size\)/s);
  assert.match(css, /\.reader-flow\s*\{[^}]*line-height:\s*var\(--oi-reader-line-height\)/s);
  assert.match(css, /\.reader-flow \.oi-pdf-p \+ \.oi-pdf-p\s*\{[^}]*margin-top:\s*var\(--oi-reader-paragraph-gap\)/s);
  assert.doesNotMatch(css, /\.paper-stack\s*\{[^}]*zoom:/s);
  assert.match(viewer, /renderPdfStructure/);
  assert.match(viewer, /className = "rf-page readout md-readout"/);
  assert.doesNotMatch(viewer, /className = "readout-paper"/);
  assert.doesNotMatch(viewer, /mapBodyFontPx/);
  assert.doesNotMatch(viewer, /function applyBodyFont/);
  assert.match(viewer, /readerFormulaCssSize/);
});

test("page markers are a capsule, in-flow breaks, and untranslated rows", () => {
  const plan = planReaderFlow({ pageCount: 5, contentPages: [3, 5] });
  assert.deepEqual(plan, [
    { kind: "untranslated", page: 1 },
    { kind: "untranslated", page: 2 },
    { kind: "content", page: 3 },
    { kind: "untranslated", page: 4 },
    { kind: "break", page: 5 },
    { kind: "content", page: 5 }
  ]);
  assert.deepEqual(
    contentPagesForScope({ scope: "page", currentPage: 3, pagesWithContent: [1, 3, 4] }),
    [3]
  );
  assert.deepEqual(
    contentPagesForScope({ scope: "all", currentPage: 3, pagesWithContent: [1, 3] }),
    [1, 3]
  );
  assert.equal(pageBreakLabel(4), "原文第 4 页");
  assert.equal(untranslatedLabel(6), "原文第 6 页 · 未翻译");
  assert.equal(capsuleLabel(3), "原文第 3 页");
  assert.equal(capsuleLabel(3, { short: true }), "第 3 页");
  assert.equal(capsuleLabel(3, { short: true }) === capsuleLabel(3), false);
  assert.equal(pageAtAnchor([
    { page: 3, top: 0, bottom: 200 },
    { page: 4, top: 240, bottom: 400 }
  ], 100), 3);
  assert.equal(pageAtAnchor([
    { page: 3, top: 0, bottom: 80 },
    { page: 5, top: 120, bottom: 200 }
  ], 100), 5);
  assert.match(html, /id="pageCapsule"/);
  assert.match(css, /\.rf-capsule-bar\s*\{[^}]*position:\s*sticky/s);
  assert.match(css, /\.rf-pagebreak/);
  assert.match(css, /\.rf-untranslated/);
  assert.match(viewer, /data-src-page|dataset\.srcPage/);
  assert.match(viewer, /翻译本页/);
});

test("multiply is the default blend and forced-colors keeps the original pixels", () => {
  assert.equal(readerImageBlend({ supportsMultiply: true, forcedColors: false }), "multiply");
  assert.equal(readerImageBlend({ supportsMultiply: false, forcedColors: false }), "precomposite");
  assert.equal(readerImageBlend({ supportsMultiply: false, forcedColors: true }), "original");
  assert.equal(readerImageBlend({ supportsMultiply: true, forcedColors: true }), "original");
  const paper = themePaperRgb("#102040");
  assert.deepEqual(paper, [16, 32, 64]);
  assert.deepEqual(themePaperRgb("rgb(1, 2, 3)"), [1, 2, 3]);
  assert.equal(themePaperRgb("not-a-color"), null);
  const pixels = precompositeMultiplyPixels(
    Uint8ClampedArray.of(255, 255, 255, 255, 0, 0, 0, 255),
    paper
  );
  assert.deepEqual([...pixels.slice(0, 3)], paper);
  assert.deepEqual([...pixels.slice(4, 7)], [0, 0, 0]);
  assert.equal(pixels[3], 255);
  assert.match(css, /mix-blend-mode:\s*multiply/);
  assert.match(css, /@supports not \(mix-blend-mode:\s*multiply\)/);
  assert.match(css, /forced-colors:\s*active/);
  assert.match(viewer, /precompositeMultiplyPixels/);
});

test("Aa panel exposes font steps and background radios, and hides the tier-2 switch", () => {
  assert.match(html, /id="aaButton"/);
  assert.match(html, /id="aaPanel"/);
  assert.match(html, /id="aaFontScale"[^>]*role="radiogroup"/);
  assert.match(html, /id="aaThemes"[^>]*role="radiogroup"[^>]*aria-label="阅读背景"/);
  assert.match(html, /id="aaSingleKey"[^>]*role="switch"/);
  assert.match(viewer, /aria-label", readerThemeAriaLabel/);
  assert.doesNotMatch(html, /katexTier2|用看图模型补全公式/);
  assert.doesNotMatch(viewer, /reader\.katexTier2/);
  assert.match(css, /\.aa-panel\s*\{[^}]*width:\s*var\(--oi-reader-panel-width\)/s);
  assert.match(css, /\.aa-swatch\[data-theme="warm"\] \.aa-swatch-chip/);
  assert.match(css, /\.aa-swatch\[data-theme="green"\] \.aa-swatch-chip/);
  assert.match(html, /id="aaFontHint"[^>]*hidden/);
  assert.match(html, /装上思源宋体会自动换成宋体。重启浏览器后生效/);
  assert.match(html, /class="aa-font-hint-link"/);
  assert.doesNotMatch(html, /⇄|术语/);
});

test("capsule yields before it covers glyphs", () => {
  const fullW = 91;
  const shortW = 67;
  const wide = capsulePlacement({ paneW: 701, scrollbar: 15, pad: 40, fontPx: 16, fullW, shortW });
  assert.equal(wide.mode, "float");
  assert.equal(wide.label, "short");
  assert.equal(wide.measure, 576);
  assert.ok(wide.gap >= 12);
  assert.ok(wide.end >= 8);
  assert.ok(wide.start >= 24);
  const live = capsulePlacement({ paneW: 701, scrollbar: 15, pad: 40, fontPx: 16, fullW, shortW: 59.3 });
  assert.equal(live.mode, "float");
  assert.equal(live.measure, 576);
  assert.ok(live.start >= 49 && live.start <= 56);
  assert.ok(Math.abs(live.gap - 12) < 0.05);
  assert.ok(live.end >= 4);
  const mid = capsulePlacement({ paneW: 655, pad: 28, fontPx: 16, fullW, shortW });
  assert.equal(mid.mode, "float");
  assert.equal(mid.label, "short");
  assert.equal(Math.round(mid.measure), 536);
  assert.equal(mid.start, 28);
  assert.ok(mid.end >= 8);
  assert.ok(mid.gap >= 12);
  const large = capsulePlacement({ paneW: 701, scrollbar: 15, pad: 40, fontPx: 20, fullW, shortW });
  assert.equal(large.mode, "float");
  assert.equal(large.label, "short");
  assert.ok(large.measure >= 585 && large.measure <= 592);
  assert.ok(large.start >= 24);
  assert.ok(large.end >= 8);
  assert.ok(large.gap >= 12);
  const tight = capsulePlacement({ paneW: 655, scrollbar: 15, pad: 28, fontPx: 16, fullW, shortW });
  assert.equal(tight.mode, "float");
  assert.ok(tight.start >= 24);
  assert.ok(tight.end >= 8);
  assert.ok(tight.gap >= 12);
  assert.equal(Math.round(tight.measure), 536);
  const bar = capsulePlacement({ paneW: 496, pad: 28, fontPx: 16, fullW, shortW });
  assert.equal(bar.mode, "bar");
  assert.equal(bar.label, "full");
  assert.equal(bar.start, null);
  const centered = capsulePlacement({ paneW: 1080, pad: 40, fontPx: 16, fullW, shortW });
  assert.equal(centered.mode, "float");
  assert.equal(centered.label, "full");
  assert.equal(centered.measure, 576);
  assert.equal(centered.start, null);
  assert.ok(centered.end >= 8);
  const stacked = capsulePlacement({ paneW: 800, pad: 20, fontPx: 16, fullW, shortW, forceBar: true });
  assert.equal(stacked.mode, "bar");
  assert.equal(stacked.label, "full");
  assert.match(tokens, /--oi-reader-capsule-end-min:\s*8px/);
  assert.match(tokens, /--oi-reader-capsule-end-floor:\s*4px/);
  assert.match(css, /max\(\s*var\(--oi-reader-capsule-end-floor\)/);
  assert.match(css, /\.rf-capsule-probe\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.match(viewer, /--oi-reader-capsule-end-min/);
  assert.match(viewer, /capsuleLabel\(maxPage, \{ short: true \}\)/);
});

test("split keeps a ratio and the translation column stays at least 540px", () => {
  assert.equal(defaultSplitRatio(1440), 0.5);
  assert.equal(defaultSplitRatio(1100), 0.4);
  const wide = splitLayout({ width: 1440, ratio: 0.5 });
  assert.ok(wide.translate >= 540);
  assert.ok(Math.abs(wide.source - 716) < 1);
  const mid = splitLayout({ width: 1100, ratio: 0.4 });
  assert.ok(mid.translate >= 540);
  const dragged = splitLayout({ width: 1100, ratio: 0.6 });
  assert.ok(dragged.translate >= 540);
  assert.ok(dragged.source >= 320);
  const saved = {};
  writeReaderPrefs(saved, { splitRatio: wide.ratio });
  assert.equal(saved["reader.splitRatio"], String(wide.ratio));
  assert.equal(readReaderPrefs(saved).splitRatio, wide.ratio);
  const home = splitLayout({ width: 1440, ratio: 0 });
  assert.equal(home.source, 320);
  const end = splitLayout({ width: 1440, ratio: 1 });
  assert.ok(Math.abs(end.translate - 560) < 0.2);
  const endMid = splitLayout({ width: 1100, ratio: 1 });
  assert.ok(Math.abs(endMid.translate - 540) < 0.2);
  const stored = {};
  writeReaderPrefs(stored, { splitRatio: 0.6 });
  const restored = splitLayout({ width: 1440, ratio: readReaderPrefs(stored).splitRatio });
  assert.ok(Math.abs(restored.ratio - 0.6) < 0.001);
  const restoredNarrow = splitLayout({ width: 1100, ratio: readReaderPrefs(stored).splitRatio });
  assert.ok(restoredNarrow.translate >= 540);
  assert.ok(restoredNarrow.source >= 320);
  const initStart = viewer.indexOf("function init()");
  const init = viewer.slice(initStart, initStart + 2800);
  assert.ok(init.indexOf("bindSplitResize()") >= 0);
  assert.ok(init.indexOf("bindReaderChrome()") > init.indexOf("bindSplitResize()"));
  const bind = viewer.slice(viewer.indexOf("function bindSplitResize"), viewer.indexOf("function applyStoredSplitRatio"));
  assert.doesNotMatch(bind, /readerPrefs\.splitRatio/);
  const load = viewer.slice(viewer.indexOf("function loadReaderPrefs"), viewer.indexOf("function syncAaPanel"));
  assert.match(load, /applyStoredSplitRatio\(\)/);
  const paint = viewer.slice(viewer.indexOf("function paintSplitRatio"), viewer.indexOf("function persistSplitRatio"));
  assert.match(paint, /const safe = Number\.isFinite\(requested\) \? requested : defaultSplitRatio/);
  assert.match(paint, /ratio:\s*safe/);
  assert.match(viewer, /else if \(event\.key === "Home"\) next = 0/);
  assert.match(viewer, /else if \(event\.key === "End"\) next = 1/);
  assert.match(html, /class="split-handle"[^>]*tabindex="0"/);
  assert.match(html, /role="separator"[^>]*aria-valuenow="/);
  assert.match(viewer, /--oi-split-ratio/);
  assert.doesNotMatch(viewer, /gridTemplateColumns\s*=/);
  assert.match(css, /\.rf-page-capsule\s*\{[^}]*min-height:\s*var\(--oi-reader-capsule-height\)/s);
  assert.match(css, /\.aa-switch\s*\{[^}]*width:\s*var\(--oi-reader-aa-switch-w\)/s);
  assert.match(css, /\.aa-switch:checked/);
  assert.match(html, /class="aa-switch"[^>]*role="switch"/);
  assert.match(viewer, /rf-pagebreak-rule/);
  assert.match(css, /\.rf-pagebreak\s*\{[^}]*justify-content:\s*center/s);
  assert.equal((viewer.match(/className = "rf-pagebreak-rule"/g) || []).length, 2);
  const kept = indexFormulaScrolls([
    { page: "3", id: "eq4", left: 16 },
    { page: "3", id: "eq1", left: 0 }
  ]);
  assert.equal(formulaScrollLeft(kept, "3", "eq4"), 16);
  assert.equal(formulaScrollLeft(kept, "3", "eq1"), 0);
  const render = viewer.slice(viewer.indexOf("function renderArticle"), viewer.indexOf("function stampReaderPage"));
  const captured = render.indexOf("captureFormulaScrolls");
  const cleared = render.indexOf("stack.replaceChildren()");
  assert.ok(captured >= 0 && cleared > captured);
  assert.equal((render.match(/restoreFormulaScrolls\(readerFlowEl\(\), formulaScrolls\)/g) || []).length, 2);
});

test("fade shows only when more content sits below the fold", () => {
  assert.equal(needsFade(0, 400, 800), true);
  assert.equal(needsFade(400, 400, 800), false);
  assert.equal(needsFade(0, 400, 400), false);
  assert.equal(needsFade(10, 400, 411), false);
  const lifted = clearFadeScroll({
    wantTop: 500,
    paneHeight: 400,
    blockHeight: 80,
    blockTopInPane: 620
  });
  assert.ok(lifted <= 500);
  assert.equal(clearFadeScroll({
    wantTop: 100,
    paneHeight: 400,
    blockHeight: 40,
    blockTopInPane: 220
  }), 100);
});

test("approved reader tokens name the theme scopes and the latin subset", () => {
  assert.match(html, /class="oi-reader-app"/);
  assert.match(tokens, /\.oi-reader-app,\s*\.oi-reader\s*\{/);
  for (const theme of ["warm", "white", "sepia", "green"]) {
    assert.match(tokens, new RegExp(`\\.oi-reader-app\\[data-reader-theme="${theme}"\\]`));
    assert.match(tokens, new RegExp(`\\.oi-reader\\[data-reader-theme="${theme}"\\]`));
    for (const name of ["well", "track", "hover", "thumb"]) {
      assert.match(tokens, new RegExp(`--oi-reader-${theme}-${name}:`));
      assert.match(tokens, new RegExp(`--oi-reader-${name}:\\s*var\\(--oi-reader-${theme}-${name}\\)`));
    }
  }
  assert.match(tokens, /--oi-reader-line-height:\s*1\.9/);
  assert.match(tokens, /--oi-reader-measure:\s*36em/);
  assert.match(tokens, /--oi-reader-h3-size:\s*calc\(1\.0625 \* var\(--oi-reader-font-size\)\)/);
  assert.match(tokens, /--oi-reader-paragraph-gap:\s*calc\(1\.125 \* var\(--oi-reader-font-size\)\)/);
  assert.match(tokens, /--oi-reader-font-sans:/);
  assert.match(tokens, /--oi-reader-pair-bg-solid:/);
  assert.match(tokens, /font-family:\s*"OI Serif Latin"/);
  assert.doesNotMatch(tokens, /STSong/);
  assert.match(tokens, /\[data-reader-cjk="sans"\][\s\S]*--oi-reader-font:\s*var\(--oi-reader-font-sans\)/);
  const ranges = [...tokens.matchAll(/unicode-range:\s*([^;]+);/g)].map((hit) => hit[1]);
  const latin = ranges.filter((range) => range.includes("U+0000-00B6"));
  assert.equal(latin.length >= 4, true);
  assert.equal(new Set(latin).size, 1);
  for (const excluded of ["2014", "2018", "2019", "201C", "201D", "2026", "00B7"]) {
    assert.equal(latin[0].toUpperCase().includes(excluded), false);
  }
  const fonts = readdirSync(join(root, "pdf/fonts")).filter((name) => name.endsWith(".woff2"));
  assert.deepEqual(fonts.sort(), [
    "OISerifLatin-Bold.woff2",
    "OISerifLatin-Italic.woff2",
    "OISerifLatin-Regular.woff2",
    "OISerifLatin-Semibold.woff2"
  ]);
  const bytes = fonts.reduce((sum, name) => sum + statSync(join(root, "pdf/fonts", name)).size, 0);
  assert.ok(bytes <= 256000, `font bytes ${bytes}`);
  assert.match(readFileSync(join(root, "pdf/fonts/OFL.txt"), "utf8"), /SIL Open Font License/);
  assert.match(css, /\.reader-flow\s*\{[^}]*background:\s*var\(--oi-reader-paper\)/s);
  assert.match(css, /\.rf-page-capsule\s*\{[^}]*box-shadow:\s*var\(--oi-reader-capsule-shadow\)/s);
  assert.match(css, /\.rf-pagebreak-rule\s*\{[^}]*border-top:\s*var\(--oi-reader-break-rule\)/s);
  assert.match(viewer, /clearFadeScroll/);
  assert.match(viewer, /document\.body/);
});
