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
  capsuleSamplePages,
  CAPSULE_PAD_X_MIN,
  defaultCapsuleContentBudget,
  reserveCapsuleContent,
  reserveDefaultCapsuleContent,
  stableCapsulePane,
  clearFadeScroll,
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
  splitAriaModel,
  splitLayout,
  splitTranslateMin,
  stepReaderFontSize,
  themePaperRgb,
  writeReaderPrefs
} from "../lib/pdf-reader-flow.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const globalTokens = readFileSync(join(root, "ui/tokens.css"), "utf8");

test("font steps run 14 through 40 and remember the chosen step", () => {
  assert.deepEqual([...READER_FONT_SIZES], [14, 15, 16, 17, 18, 19, 20, 22, 24, 26, 28, 32, 36, 40]);
  assert.equal(READER_FONT_DEFAULT, 16);
  assert.equal(normalizeReaderFontSize(undefined), 16);
  assert.equal(normalizeReaderFontSize("15"), 15);
  assert.equal(normalizeReaderFontSize(13), 14);
  assert.equal(normalizeReaderFontSize(19), 19);
  assert.equal(stepReaderFontSize(16, -1), 15);
  assert.equal(stepReaderFontSize(14, -1), 14);
  assert.equal(stepReaderFontSize(18, 1), 19);
  assert.equal(stepReaderFontSize(20, 1), 22);
  assert.equal(applyReaderFontAction(20, "decrease"), 19);
  assert.equal(applyReaderFontAction(14, "increase"), 15);
  assert.equal(applyReaderFontAction(20, "reset"), 16);
  const store = {};
  assert.deepEqual(writeReaderPrefs(store, { fontSize: 20, theme: "green", singleKey: true }), {
    fontSize: 20,
    theme: "green",
    singleKey: true,
    splitRatio: null,
    follow: true,
    sourceSide: "start",
    sourceMode: null,
    miniWidth: 360,
    miniCollapsed: false
  });
  assert.equal(store["reader.fontSize"], "20");
  assert.equal(store["reader.theme"], "green");
  assert.equal(store["reader.follow"], "1");
  assert.equal(store["reader.sourceSide"], "start");
  assert.equal(store["reader.sourceMode"], "");
  assert.equal(store["reader.miniWidth"], "360");
  assert.equal(store["reader.miniCollapsed"], "0");
  assert.deepEqual(readReaderPrefs(store), {
    fontSize: 20,
    theme: "green",
    singleKey: true,
    splitRatio: null,
    follow: true,
    sourceSide: "start",
    sourceMode: null,
    miniWidth: 360,
    miniCollapsed: false
  });
  store["reader.fontSize"] = "13";
  assert.equal(readReaderPrefs(store).fontSize, 14);
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
  assert.match(html, /id="viewSeg"/);
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

test("page markers are a capsule, in-flow breaks, and one queued range", () => {
  const pages = new Map([
    [1, { state: "done", hasLayout: true }],
    [2, { state: "running", hasLayout: true }],
    [3, { state: "queued", hasLayout: false }],
    [4, { state: "queued", hasLayout: false }],
    [5, { state: "queued", hasLayout: true }]
  ]);
  assert.deepEqual(planReaderFlow({ pageCount: 5, pages }), [
    { kind: "slot", page: 1, hidden: false, state: "done" },
    { kind: "break", page: 2, hidden: false, state: "running" },
    { kind: "slot", page: 2, hidden: false, state: "running" },
    { kind: "range", from: 3, to: 4, state: "queued" },
    { kind: "break", page: 3, hidden: true, state: "queued" },
    { kind: "slot", page: 3, hidden: true, state: "queued" },
    { kind: "break", page: 4, hidden: true, state: "queued" },
    { kind: "slot", page: 4, hidden: true, state: "queued" },
    { kind: "break", page: 5, hidden: false, state: "queued" },
    { kind: "slot", page: 5, hidden: false, state: "queued" }
  ]);
  const collapsed = planReaderFlow({
    pageCount: 3,
    pages: new Map([
      [1, { state: "queued", hasLayout: false }],
      [2, { state: "queued", hasLayout: false }],
      [3, { state: "queued", hasLayout: false }]
    ])
  });
  assert.equal(collapsed.filter((item) => item.kind === "range").length, 1);
  assert.equal(collapsed.some((item) => item.kind === "untranslated"), false);
  assert.equal(pageBreakLabel(4), "原文第 4 页");
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
  assert.match(css, /\.rf-q/);
  assert.match(css, /\.rf-ps/);
  assert.doesNotMatch(css, /\.rf-untranslated/);
  assert.match(viewer, /data-src-page|dataset\.srcPage/);
  assert.doesNotMatch(viewer, /翻译本页/);
  assert.doesNotMatch(viewer, /makeUntranslated|untranslatedLabel|rf-untranslated/);
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
  assert.match(html, /id="aaFontScale"[^>]*role="slider"/);
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
  assert.doesNotMatch(html, /⇄/);
  assert.match(html, /id="glossaryItem"[^>]*>术语/);
});

test("capsule yields before it covers glyphs", () => {
  const fullW = 91;
  const shortW = 67;
  const reserved = (place, visible) => visible - place.measure - place.capsuleW - place.gap - place.end;
  const wide = capsulePlacement({ paneW: 701, scrollbar: 15, pad: 40, fontPx: 16, fullW, shortW });
  assert.equal(wide.mode, "float");
  assert.equal(wide.label, "short");
  assert.equal(wide.measure, 576);
  assert.ok(Math.abs(wide.gap - 12) < 0.05);
  assert.equal(wide.padX, 7);
  assert.ok(wide.start >= 49 && wide.start <= 56, `wide start ${wide.start}`);
  assert.ok(wide.end >= 4);
  const one = capsulePlacement({
    paneW: 701, scrollbar: 15, pad: 40, fontPx: 16, fullW,
    shortW: 59.3, shortWMin: 53.3, padX: 11, padXMin: 8, maxPage: 9
  });
  assert.equal(one.mode, "float");
  assert.equal(one.measure, 576);
  assert.equal(one.padX, 11);
  assert.equal(one.capsuleW, 59.3);
  assert.ok(one.start >= 49 && one.start <= 56, `one-digit start ${one.start}`);
  assert.ok(Math.abs(one.gap - 12) < 0.05);
  assert.ok(one.end >= 4);
  assert.ok(Math.abs(reserved(one, 701) - one.start) < 0.05);
  for (const maxPage of [15, 27, 99]) {
    const two = capsulePlacement({
      paneW: 701, scrollbar: 15, pad: 40, fontPx: 16, fullW,
      shortW: 66, shortWMin: 60, padX: 11, padXMin: 8, maxPage
    });
    assert.equal(two.mode, "float");
    assert.equal(two.measure, 576, `two-digit measure at ${maxPage}`);
    assert.equal(two.padX, 8, `two-digit pad at ${maxPage}`);
    assert.equal(two.capsuleW, 60, `two-digit width at ${maxPage}`);
    assert.ok(two.start >= 49 && two.start <= 56, `two-digit start ${two.start}`);
    assert.ok(Math.abs(two.gap - 12) < 0.05);
    assert.ok(two.end >= 4);
    assert.ok(Math.abs(reserved(two, 701) - two.start) < 0.05);
  }
  for (const maxPage of [100, 256]) {
    const three = capsulePlacement({
      paneW: 701, scrollbar: 15, pad: 40, fontPx: 16, fullW: 110,
      shortW: 73, shortWMin: 67, padX: 11, padXMin: 8, maxPage
    });
    const atPad = 73 + (67 - 73) * ((11 - three.padX) / (11 - 8));
    assert.equal(three.mode, "float");
    assert.equal(three.measure, 576, `three-digit measure at ${maxPage}`);
    assert.ok(three.padX >= 8 && three.padX < 11, `three-digit pad ${three.padX}`);
    assert.ok(Math.abs(three.capsuleW - atPad) < 0.05, `three-digit width ${three.capsuleW}`);
    assert.ok(three.start >= 40, `three-digit start ${three.start}`);
    assert.ok(three.gap >= 12);
    assert.ok(three.end >= 4);
    assert.ok(Math.abs(reserved(three, 701) - three.start) < 0.05);
  }
  const mid = capsulePlacement({ paneW: 655, pad: 28, fontPx: 16, fullW, shortW });
  assert.equal(mid.mode, "float");
  assert.equal(mid.label, "short");
  assert.equal(Math.round(mid.measure), 536);
  assert.equal(mid.start, 28);
  assert.ok(mid.end >= 8);
  assert.ok(mid.gap >= 12);
  assert.equal(mid.padX, 11);
  assert.equal(mid.capsuleW, shortW);
  const large = capsulePlacement({ paneW: 701, scrollbar: 15, pad: 40, fontPx: 20, fullW, shortW });
  assert.equal(large.mode, "float");
  assert.equal(large.label, "short");
  assert.ok(large.measure >= 585 && large.measure <= 592);
  assert.ok(large.start >= 24);
  assert.ok(large.end >= 8);
  assert.ok(large.gap >= 12);
  assert.equal(large.padX, 11);
  assert.equal(large.capsuleW, shortW);
  const tight = capsulePlacement({ paneW: 655, scrollbar: 15, pad: 28, fontPx: 16, fullW, shortW });
  assert.equal(tight.mode, "float");
  assert.ok(tight.start >= 24);
  assert.ok(tight.end >= 8);
  assert.ok(tight.gap >= 12);
  assert.equal(Math.round(tight.measure), 536);
  assert.equal(tight.padX, 11);
  assert.equal(tight.capsuleW, shortW);
  const bar = capsulePlacement({ paneW: 496, pad: 28, fontPx: 16, fullW, shortW });
  assert.equal(bar.mode, "bar");
  assert.equal(bar.label, "full");
  assert.equal(bar.start, null);
  assert.equal(bar.capsuleW, fullW);
  const centered = capsulePlacement({ paneW: 1080, pad: 40, fontPx: 16, fullW, shortW });
  assert.equal(centered.mode, "float");
  assert.equal(centered.label, "full");
  assert.equal(centered.measure, 576);
  assert.equal(centered.start, null);
  assert.ok(centered.end >= 8);
  assert.equal(centered.padX, 11);
  assert.equal(centered.capsuleW, fullW);
  const stacked = capsulePlacement({ paneW: 800, pad: 20, fontPx: 16, fullW, shortW, forceBar: true });
  assert.equal(stacked.mode, "bar");
  assert.equal(stacked.label, "full");
  assert.equal(stacked.capsuleW, fullW);
  const capsuleRule = css.match(/\.rf-page-capsule\s*\{[^}]*\}/)[0];
  assert.match(capsuleRule, /width:\s*var\(--rf-capsule-w/);
  assert.match(capsuleRule, /min-width:\s*var\(--rf-capsule-w/);
  assert.match(capsuleRule, /max-width:\s*var\(--rf-capsule-w/);
  assert.match(capsuleRule, /justify-content:\s*center/);
  assert.match(capsuleRule, /white-space:\s*nowrap/);
  assert.doesNotMatch(capsuleRule, /max-content/);
  assert.match(tokens, /--oi-reader-capsule-pad-x:\s*11px/);
  assert.match(tokens, /--oi-reader-capsule-pad-x-min:\s*7px/);
  assert.match(tokens, /--oi-reader-capsule-end-min:\s*8px/);
  assert.match(tokens, /--oi-reader-capsule-end-floor:\s*4px/);
  assert.match(css, /max\(\s*var\(--oi-reader-capsule-end-floor\)/);
  assert.match(css, /\.rf-capsule-probe\s*\{[^}]*font-variant-numeric:\s*tabular-nums/s);
  assert.match(viewer, /--oi-reader-capsule-end-min/);
  const layout = viewer.slice(viewer.indexOf("function layoutCapsule"), viewer.indexOf("function updateReaderFade"));
  assert.match(layout, /pdfDoc\?\.numPages/);
  assert.match(layout, /setProperty\("--rf-capsule-w", `\$\{place\.capsuleW\}px`\)/);
  assert.match(layout, /setProperty\("--rf-capsule-pad-x", `\$\{place\.padX\}px`\)/);
  assert.doesNotMatch(layout, /data-src-page|libraryArticle|pageCache/);
  const paging = viewer.slice(viewer.indexOf("function updatePageCapsule"), viewer.indexOf("function onPageCapsuleClick"));
  assert.match(paging, /textContent = capsuleLabel\(page/);
  assert.doesNotMatch(paging, /--rf-capsule-w|max-content/);
});

test("capsule content covers every label, and pad drops to 7 only when 8 does not fit", () => {
  assert.equal(defaultCapsuleContentBudget({ visible: 701, pad: 8 }), 44);
  assert.equal(defaultCapsuleContentBudget({ visible: 701, pad: 7 }), 46);
  const placeFor = (content) => capsulePlacement({
    paneW: 701, scrollbar: 15, pad: 40, fontPx: 16, fullW: 91,
    shortW: content + 22,
    shortWMin: content + 2 * CAPSULE_PAD_X_MIN,
    padX: 11,
    padXMin: CAPSULE_PAD_X_MIN,
    maxPage: 27
  });
  const covers = (widths, content) => {
    for (const width of widths) assert.ok(width <= content + 1e-6, `${width} fits in ${content}`);
    const ceil = Math.ceil(Math.max(...widths) - 1e-9);
    assert.ok(content + 1e-6 >= ceil);
    assert.ok(content <= ceil + 1 + 1e-6);
  };
  const wideLabels = [31.2, 40.5, 44.6];
  const wideContent = reserveDefaultCapsuleContent(wideLabels, { visible: 701 });
  covers(wideLabels, wideContent);
  assert.ok(wideContent >= 45, `44.6 content ${wideContent}`);
  const widePlace = placeFor(wideContent);
  assert.equal(widePlace.padX, 7);
  assert.equal(widePlace.measure, 576);
  assert.ok(widePlace.start >= 49 && widePlace.start <= 56, `44.6 start ${widePlace.start}`);
  assert.ok(Math.abs(widePlace.gap - 12) < 0.05);
  assert.ok(widePlace.end >= 4);
  assert.ok(widePlace.capsuleW - 2 * widePlace.padX + 1e-6 >= wideContent);
  const fitLabels = [28.2, 43.688, 44];
  const fitContent = reserveDefaultCapsuleContent(fitLabels, { visible: 701 });
  covers(fitLabels, fitContent);
  const fitPlace = placeFor(fitContent);
  assert.equal(fitPlace.padX, 8, `≤44 pad ${fitPlace.padX}`);
  assert.equal(fitPlace.measure, 576);
  assert.ok(fitPlace.start >= 49 && fitPlace.start <= 56, `≤44 start ${fitPlace.start}`);
  assert.ok(Math.abs(fitPlace.gap - 12) < 0.05);
  assert.ok(fitPlace.end >= 4);
  const pastLabels = [44.6, 47.2];
  const pastContent = reserveDefaultCapsuleContent(pastLabels, { visible: 701 });
  covers(pastLabels, pastContent);
  const pastPlace = placeFor(pastContent);
  assert.ok(pastPlace.capsuleW - 2 * pastPlace.padX + 1e-6 >= Math.max(...pastLabels));
  assert.ok(pastPlace.start >= 24 && pastPlace.start < 49, `past start ${pastPlace.start}`);
  assert.equal(reserveCapsuleContent([43.688, 46], 44), 46);
  const samples = capsuleSamplePages(27);
  assert.equal(samples.length, 27);
  assert.equal(samples[0], 1);
  assert.equal(samples[26], 27);
  const digits = { 0: 5, 1: 5, 2: 5, 3: 5, 4: 9, 5: 5, 6: 5, 7: 5, 8: 10, 9: 6 };
  const wideDoc = capsuleSamplePages(417, digits);
  assert.ok(wideDoc.includes(417));
  assert.ok(wideDoc.includes(488));
  const capsuleRule = css.match(/\.rf-page-capsule\s*\{[^}]*\}/)[0];
  assert.match(capsuleRule, /white-space:\s*nowrap/);
  assert.match(css, /\.pane-translate-scroll\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(css, /@media \(max-width:\s*899px\)[\s\S]*\.pane-translate-scroll\s*\{[^}]*scrollbar-gutter:\s*auto/);
});

test("capsule start and padding ignore whether the scrollbar is painted", () => {
  const gutter = 15;
  const open = stableCapsulePane({ client: 716, scrollbar: 0, gutter });
  const translated = stableCapsulePane({ client: 701, scrollbar: 15, gutter });
  assert.deepEqual(open, translated);
  const stacked = stableCapsulePane({ client: 800, scrollbar: 0, gutter: 0 });
  assert.equal(stacked.paneW, 800);
  assert.equal(stacked.scrollbar, 0);
  for (const maxPage of [15, 27]) {
    const opts = {
      pad: 40, fontPx: 16, fullW: 91, shortW: 66, shortWMin: 60,
      padX: 11, padXMin: 8, maxPage
    };
    const bare = capsulePlacement({ ...open, ...opts });
    const barred = capsulePlacement({ ...translated, ...opts });
    assert.equal(bare.start, barred.start, `start at ${maxPage}`);
    assert.equal(bare.padX, barred.padX, `pad at ${maxPage}`);
    assert.ok(bare.start >= 49 && bare.start <= 56);
    assert.equal(bare.padX, 8);
  }
  const largeOpts = { pad: 40, fontPx: 20, fullW: 91, shortW: 67, padX: 11, padXMin: 8, maxPage: 27 };
  const largeBare = capsulePlacement({ ...open, ...largeOpts });
  const largeBar = capsulePlacement({ ...translated, ...largeOpts });
  assert.equal(largeBare.start, largeBar.start);
  assert.equal(largeBare.padX, largeBar.padX);
  assert.ok(largeBar.end >= 8);
  assert.ok(largeBar.start >= 24);
});

test("split keeps a ratio and the translation column stays at least 618px", () => {
  assert.equal(defaultSplitRatio(1440), 0.5);
  assert.equal(defaultSplitRatio(1100), 0.4);
  assert.equal(splitTranslateMin(1440), 618);
  assert.equal(splitTranslateMin(1100), 618);
  assert.equal(splitTranslateMin(946), 618);
  const wide = splitLayout({ width: 1440, ratio: 0.5 });
  assert.ok(wide.translate >= 618);
  assert.ok(Math.abs(wide.source - 716) < 1);
  const half = splitLayout({ width: 1244, ratio: 0.5 });
  assert.ok(Math.abs(half.translate - 618) < 0.2);
  assert.ok(Math.abs(half.source - half.translate) < 0.2);
  const halfClamp = splitLayout({ width: 1200, ratio: 0.5 });
  assert.ok(Math.abs(halfClamp.translate - 618) < 0.2);
  assert.ok(halfClamp.source >= 320);
  const mid = splitLayout({ width: 1100, ratio: 0.4 });
  assert.ok(mid.translate >= 618);
  const forty = splitLayout({ width: 1038, ratio: 0.4 });
  assert.ok(Math.abs(forty.translate - 618) < 0.2);
  assert.ok(Math.abs(forty.source - (1038 - 8) * 0.4) < 0.2);
  const fortyClamp = splitLayout({ width: 1037, ratio: 0.4 });
  assert.ok(Math.abs(fortyClamp.translate - 618) < 0.2);
  assert.ok(fortyClamp.source < (1037 - 8) * 0.4);
  const sideFloor = splitLayout({ width: 946, ratio: 0.4 });
  assert.ok(Math.abs(sideFloor.source - 320) < 0.2);
  assert.ok(Math.abs(sideFloor.translate - 618) < 0.2);
  const dragged = splitLayout({ width: 1100, ratio: 0.6 });
  assert.ok(Math.abs(dragged.translate - 618) < 0.2);
  assert.ok(dragged.source >= 320);
  const saved = {};
  writeReaderPrefs(saved, { splitRatio: wide.ratio });
  assert.equal(saved["reader.splitRatio"], String(wide.ratio));
  assert.equal(readReaderPrefs(saved).splitRatio, wide.ratio);
  const home = splitLayout({ width: 1440, ratio: 0 });
  assert.equal(home.source, 320);
  const end = splitLayout({ width: 1440, ratio: 1 });
  assert.ok(Math.abs(end.translate - 618) < 0.2);
  const endMid = splitLayout({ width: 1100, ratio: 1 });
  assert.ok(Math.abs(endMid.translate - 618) < 0.2);
  const stored = {};
  writeReaderPrefs(stored, { splitRatio: 0.55 });
  const restored = splitLayout({ width: 1440, ratio: readReaderPrefs(stored).splitRatio });
  assert.ok(Math.abs(restored.ratio - 0.55) < 0.001);
  const restoredNarrow = splitLayout({ width: 1100, ratio: readReaderPrefs(stored).splitRatio });
  assert.ok(Math.abs(restoredNarrow.translate - 618) < 0.2);
  assert.ok(restoredNarrow.source >= 320);
  const overWide = splitLayout({ width: 1440, ratio: 0.6 });
  assert.ok(Math.abs(overWide.translate - 618) < 0.2);
  assert.match(tokens, /--oi-reader-translate-min:\s*618px;/);
  assert.equal(tokens.includes("translate-min-mid"), false);
  assert.equal(tokens.includes("560px"), false);
  assert.equal(tokens.includes("540px"), false);
  assert.equal(css.includes("translate-min-mid"), false);
  assert.match(css, /\.workspace\[data-source-mode="mini"\]\s*\{[^}]*grid-template-columns:\s*var\(--oi-mini-width\)\s*var\(--oi-reader-split-w\)\s*minmax\(0,\s*1fr\)/s);
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
  assert.match(viewer, /splitKeyStep\(\{ key: event\.key/);
  assert.match(viewer, /step\.to === "min"\) next = 0/);
  assert.match(viewer, /step\.to === "max"\) next = 1/);
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
  const formulaRestored = render.indexOf("restoreFormulaScrolls(readerFlowEl(), formulaScrolls)");
  assert.ok(captured >= 0 && formulaRestored > captured);
  assert.equal(render.includes("replaceChildren"), false);
  assert.match(render, /captureFlowAnchor/);
  assert.match(render, /restoreFlowAnchor/);
  assert.equal((render.match(/restoreFormulaScrolls\(readerFlowEl\(\), formulaScrolls\)/g) || []).length, 1);
});

test("splitter aria and the drag bubble follow the clamped source share", () => {
  const wide = splitAriaModel({ width: 1440, ratio: 0.5 });
  assert.equal(wide.valuemin, 22.3);
  assert.equal(wide.valuemax, 56.8);
  assert.equal(wide.valuenow, 50);
  assert.equal(wide.valuetext, "原文栏 50%");
  assert.equal(wide.bubble, wide.valuetext);
  const mid = splitAriaModel({ width: 1100, ratio: 0.4 });
  assert.equal(mid.valuemin, 29.3);
  assert.equal(mid.valuemax, 43.4);
  assert.equal(mid.valuetext, `原文栏 ${mid.valuenow}%`);
  assert.match(html, /aria-controls="pdfPane"/);
  assert.match(html, /aria-valuemin="22.3"/);
  assert.match(html, /aria-valuemax="56.8"/);
  assert.match(html, /aria-valuetext="原文栏 50%"/);
  assert.match(html, /class="split-bubble"/);
  assert.doesNotMatch(html, /aria-valuemin="0"/);
  assert.doesNotMatch(html, /aria-valuemax="100"/);
  assert.match(viewer, /function writeSplitAria/);
  assert.match(viewer, /splitAriaModel/);
  assert.match(viewer, /aria-valuetext/);
  assert.match(css, /\.workspace\.is-splitting \.split-bubble\s*\{[^}]*visibility:\s*visible/s);
  assert.match(css, /\.split-bubble\s*\{[^}]*font:\s*500 12px\/1\.3 var\(--oi-reader-ui-font\)/s);
});

test("reader scrollbars are thin, transparent, and not an inherited scrollbar-color", () => {
  assert.match(tokens, /color-scheme:\s*light/);
  assert.match(tokens, /--oi-reader-split-grip-opacity:\s*0;/);
  assert.match(tokens, /--oi-reader-split-grip-w:\s*4px/);
  assert.match(tokens, /--oi-reader-split-grip-h:\s*28px/);
  assert.match(tokens, /--oi-reader-split-grip-radius:\s*2px/);
  assert.match(tokens, /--oi-reader-split-grip-delay:\s*120ms/);
  assert.match(tokens, /--oi-reader-split-grip-fade:\s*150ms/);
  assert.match(tokens, /--oi-reader-scrollbar-size:\s*10px/);
  assert.match(tokens, /--oi-reader-scrollbar-hide-delay:\s*1200ms/);
  assert.match(tokens, /--oi-reader-scrollbar-thumb:\s*color-mix\(in srgb, var\(--oi-reader-ink\) 32%, transparent\)/);
  assert.equal(tokens.includes("scrollbar-color"), false);
  assert.equal(globalTokens.includes("scrollbar-color"), false);
  assert.match(html, /id="pages"[^>]*class="pages oi-sb"/);
  assert.match(html, /id="aaPanel"[^>]*class="[^"]*\boi-sb\b/);
  assert.match(css, /#pages\s*\{[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(css, /@media not \(forced-colors:\s*active\)/);
  assert.match(css, /\.oi-sb::-webkit-scrollbar-track,\s*\.oi-sb::-webkit-scrollbar-corner\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.oi-sb\[data-scrolling\]::-webkit-scrollbar-thumb/);
  assert.match(viewer, /dataset\.scrolling/);
  assert.match(viewer, /scrollbarHideDelayMs/);
  assert.match(viewer, /bindAutoHideScrollbars/);
  const parts = css.split("scrollbar-color");
  assert.equal(parts.length, 3);
  let cursor = "";
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor += parts[i];
    const supportsAt = cursor.lastIndexOf("@supports not selector(::-webkit-scrollbar)");
    assert.ok(supportsAt >= 0);
    const between = cursor.slice(supportsAt);
    const open = (between.match(/\{/g) || []).length;
    const close = (between.match(/\}/g) || []).length;
    assert.ok(open > close, "scrollbar-color stays inside @supports");
    cursor += "scrollbar-color";
  }
  assert.match(css, /\.oi-pdf-math-scroll\s*\{[^}]*scrollbar-width:\s*none/s);
  assert.match(css, /\.split-handle::before\s*\{[^}]*border:\s*0/s);
  assert.match(css, /\.workspace\.is-splitting \.split-handle::before\s*\{[^}]*border:\s*0[^}]*var\(--oi-reader-split-line-drag\)/s);
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
  assert.match(tokens, /--oi-reader-line-height:\s*clamp\(1\.5,\s*calc\(1\.9 - 0\.025 \* \(var\(--oi-reader-fs-num\) - 16\)\),\s*1\.9\)/);
  assert.match(tokens, /--oi-reader-measure:\s*36em/);
  assert.match(tokens, /--oi-reader-h3-size:\s*calc\(1\.0625 \* var\(--oi-reader-font-size\)\)/);
  assert.match(tokens, /--oi-reader-paragraph-gap:\s*clamp\(0\.75em,\s*calc\(\(1\.125 - 0\.02 \* \(var\(--oi-reader-fs-num\) - 16\)\) \* 1em\),\s*1\.125em\)/);
  assert.match(tokens, /--oi-reader-font-sans:/);
  assert.match(tokens, /--oi-reader-pair-bg-solid:/);
  assert.match(tokens, /--oi-reader-pair-box-w:\s*1\.5px/);
  assert.match(tokens, /--oi-reader-pair-box-radius:\s*4px/);
  assert.match(tokens, /--oi-reader-pair-box-outset:\s*5px/);
  assert.match(tokens, /--oi-reader-pair-jump-w:\s*2px/);
  assert.match(tokens, /--oi-reader-pair-jump-radius:\s*5px/);
  assert.match(tokens, /--oi-reader-pair-jump-inline-outset:\s*2px/);
  assert.match(tokens, /--oi-reader-pair-jump-offset:\s*6px/);
  assert.match(tokens, /--oi-reader-source-head-h:\s*36px/);
  assert.match(tokens, /--oi-reader-source-head-size:\s*12px/);
  assert.match(tokens, /--oi-reader-follow-box:\s*14px/);
  assert.match(tokens, /--oi-reader-follow-radius:\s*4px/);
  assert.match(tokens, /--oi-reader-menu-min-w:\s*200px/);
  assert.match(tokens, /--oi-reader-menu-radius:\s*10px/);
  assert.match(tokens, /--oi-reader-menu-item-h:\s*32px/);
  assert.match(tokens, /--oi-reader-menu-item-pad-x:\s*12px/);
  assert.match(tokens, /--oi-reader-menu-key-size:\s*12px/);
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
