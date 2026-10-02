import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READER_FONT_DEFAULT,
  READER_FONT_SIZES,
  READER_THEME_DEFAULT,
  READER_THEMES,
  applyReaderFontAction,
  capsuleLabel,
  contentPagesForScope,
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
    singleKey: true
  });
  assert.equal(store["reader.fontSize"], "20");
  assert.equal(store["reader.theme"], "green");
  assert.deepEqual(readReaderPrefs(store), { fontSize: 20, theme: "green", singleKey: true });
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
  assert.match(css, /\.reader-flow\s*\{[^}]*width:\s*min\(var\(--oi-reader-measure\)/s);
  assert.match(css, /\.reader-flow\s*\{[^}]*font-size:\s*var\(--oi-reader-font-size\)/s);
  assert.match(css, /\.reader-flow\s*\{[^}]*line-height:\s*var\(--oi-reader-line-height\)/s);
  assert.match(css, /\.reader-flow \.oi-pdf-p \+ \.oi-pdf-p\s*\{[^}]*margin-top:\s*var\(--oi-reader-paragraph-gap\)/s);
  assert.doesNotMatch(css, /\.paper-stack\s*\{[^}]*zoom:/s);
  assert.match(viewer, /renderPdfStructure/);
  assert.match(viewer, /className = "rf-page readout md-readout"/);
  assert.doesNotMatch(viewer, /className = "readout-paper"/);
  assert.doesNotMatch(viewer, /mapBodyFontPx/);
  assert.doesNotMatch(viewer, /function applyBodyFont/);
  assert.match(viewer, /matchedDisplayCssSize/);
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
  assert.equal(pageAtAnchor([
    { page: 3, top: 0, bottom: 200 },
    { page: 4, top: 240, bottom: 400 }
  ], 100), 3);
  assert.equal(pageAtAnchor([
    { page: 3, top: 0, bottom: 80 },
    { page: 5, top: 120, bottom: 200 }
  ], 100), 5);
  assert.match(html, /id="pageCapsule"/);
  assert.match(css, /\.rf-page-capsule\s*\{[^}]*position:\s*sticky/s);
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
});
