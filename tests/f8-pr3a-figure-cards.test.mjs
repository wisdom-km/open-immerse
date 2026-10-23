import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFigureLabel } from "../lib/figure-label.js";
import { placeholderCopy } from "../lib/formula-settings.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

test("parseFigureLabel reads figure and table numbers from the caption start", () => {
  assert.deepEqual(parseFigureLabel("Figure 2: The Transformer."), { kind: "figure", num: "2" });
  assert.deepEqual(parseFigureLabel("Fig. 3. Attention heads."), { kind: "figure", num: "3" });
  assert.deepEqual(parseFigureLabel("Fig.3"), { kind: "figure", num: "3" });
  assert.deepEqual(parseFigureLabel("Table 1: Win rates."), { kind: "table", num: "1" });
  assert.deepEqual(parseFigureLabel("图 4"), { kind: "figure", num: "4" });
  assert.deepEqual(parseFigureLabel("表 2：结果"), { kind: "table", num: "2" });
  assert.deepEqual(parseFigureLabel("Figure 2a: detail."), { kind: "figure", num: "2a" });
  assert.deepEqual(parseFigureLabel("  TABLE 1 "), { kind: "table", num: "1" });
  assert.equal(parseFigureLabel("This figure shows the model."), null);
  assert.equal(parseFigureLabel("See Figure 2 later."), null);
  assert.equal(parseFigureLabel(""), null);
  assert.equal(parseFigureLabel(null), null);
});

test("placeholderCopy formula output stays the two-field object", () => {
  const cases = [
    [{ page: 4, eqLabel: "(3)" }, { inline: false }, {
      visible: ["点击查看原公式", "看原公式", "原公式"],
      aria: "公式 (3) · 原文第 4 页 · 点击查看原公式"
    }],
    [{ page: 4, eqLabel: "3" }, {}, {
      visible: ["点击查看原公式", "看原公式", "原公式"],
      aria: "公式 (3) · 原文第 4 页 · 点击查看原公式"
    }],
    [{ page: 4 }, {}, {
      visible: ["点击查看原公式", "看原公式", "原公式"],
      aria: "公式 · 原文第 4 页 · 点击查看原公式"
    }],
    [{ page: 4 }, { inline: true }, {
      visible: ["点击查看原公式", "看原公式", "原公式"],
      aria: "行内公式 · 原文第 4 页 · 点击查看原公式"
    }],
    [{ page: null, eqLabel: "(3)" }, {}, {
      visible: ["点击查看原公式", "看原公式", "原公式"],
      aria: "公式 (3) · 点击查看原公式"
    }],
    [{ page: null }, { inline: true }, {
      visible: ["点击查看原公式", "看原公式", "原公式"],
      aria: "行内公式 · 点击查看原公式"
    }]
  ];
  for (const [block, options, expected] of cases) {
    const copy = placeholderCopy(block, options);
    assert.deepEqual(copy, expected);
    assert.deepEqual(Object.keys(copy), ["visible", "aria"]);
  }
});

test("placeholderCopy figure and table lines, including a missing number", () => {
  assert.deepEqual(placeholderCopy({ page: 5, figureLabel: "3" }, { kind: "figure" }), {
    visible: ["点击查看原图", "看原图", "原图"],
    aria: "图 3 · 原文第 5 页 · 点击查看原图",
    second: ["图 3 · 原文第 5 页", "图 3 · 第 5 页", ""]
  });
  assert.deepEqual(placeholderCopy({ page: 3, figureLabel: "1" }, { kind: "figure" }).visible, ["点击查看原图", "看原图", "原图"]);
  assert.equal(placeholderCopy({ page: 3, figureLabel: "1" }, { kind: "figure" }).aria, "图 1 · 原文第 3 页 · 点击查看原图");
  assert.deepEqual(placeholderCopy({ page: 5 }, { kind: "figure" }).second, ["原文第 5 页", "第 5 页", ""]);
  assert.equal(placeholderCopy({ page: 5 }, { kind: "figure" }).aria, "图 · 原文第 5 页 · 点击查看原图");
  assert.deepEqual(placeholderCopy({ page: 5, figureLabel: "1" }, { kind: "table" }), {
    visible: ["点击查看原表", "看原表", "原表"],
    aria: "表 1 · 原文第 5 页 · 点击查看原表",
    second: ["表 1 · 原文第 5 页", "表 1 · 第 5 页", ""]
  });
  assert.deepEqual(placeholderCopy({ page: 6 }, { kind: "table" }).second, ["原文第 6 页", "第 6 页", ""]);
  assert.equal(placeholderCopy({ page: 6 }, { kind: "table" }).aria, "表 · 原文第 6 页 · 点击查看原表");
  assert.equal(placeholderCopy({ page: 6, figureLabel: "2a" }, { kind: "table" }).visible[2], "原表");
});

test("figure card tokens, container query, and reader colors only", () => {
  const css = read("pdf/viewer.css");
  const tokens = read("pdf/reader-tokens.css");
  assert.match(tokens, /--oi-reader-fig-card-h:\s*64px/);
  assert.match(tokens, /--oi-reader-fig-card-min-w:\s*160px/);
  assert.match(css, /height:\s*var\(--oi-reader-fig-card-h/);
  assert.match(css, /min-width:\s*min\(100%,\s*var\(--oi-reader-fig-card-min-w/);
  assert.match(css, /@container oi-fig \(width < 200px\)/);
  assert.match(css, /@container oi-fig \(width < 128px\)/);
  assert.match(css, /\.oi-figure-placeholder:active\s*\{[^}]*background:\s*var\(--oi-reader-track\)/);
  assert.match(css, /\.oi-figure-placeholder:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-focus\)/);
  const card = css.slice(css.indexOf(".oi-figure-placeholder-row"), css.indexOf(".pane-translate .readout.is-mirror"));
  assert.match(card, /\.oi-figure-placeholder-row > \.oi-formula-reserve/);
  assert.match(card, /\.oi-figure-placeholder-row:not\(\.oi-pdf-figure > \*\)\s*\{[^}]*margin:\s*12px auto 6px/);
  assert.equal(card.includes("--oi-warn"), false);
  assert.equal(card.includes("--oi-primary"), false);
  assert.equal(card.includes("--oi-line"), false);
  assert.equal(/body\.oi-settings/.test(card), false);
});

test("figure cards derive figureLabel on the render copy and leave formula placeholders on the formula copy", () => {
  const viewer = read("pdf/viewer.js");
  assert.match(viewer, /import \{ parseFigureLabel \} from "\.\.\/lib\/figure-label\.js"/);
  assert.match(viewer, /shown\.figureLabel = figureLabel/);
  assert.match(viewer, /className = "oi-figure-placeholder oi-pdf-asset-fallback"/);
  assert.match(viewer, /reserve\.dataset\.oiReserve = "f8"/);
  assert.match(viewer, /placeholderCopy\(shown, \{ inline, kind: "formula" \}\)/);
  assert.match(viewer, /function jumpAssetFallback\(notice\)/);
  assert.match(viewer, /presentSourceForJump\(notice\)/);
  assert.match(viewer, /function visualCropNotice\(block, page, caption = null\)/);
  assert.match(viewer, /parseFigureLabel\(captionSourceText\(caption\)\)/);
  assert.match(viewer, /parsed\.kind === copyKind/);
  assert.doesNotMatch(viewer, /noticeCaption/);
  const orphan = viewer.slice(viewer.indexOf("function orphanVisualNotice"), viewer.indexOf("function jumpAssetFallback"));
  assert.match(orphan, /createDocumentFragment\(\)/);
  assert.match(orphan, /parseFigureLabel\(captionSourceText\(block\)\)/);
  assert.match(orphan, /const table = parsed\?\.kind === "table"/);
  assert.match(orphan, /visualCropNotice\(\{ label: table \? "table" : "figure" \}, page, block\)/);
  assert.doesNotMatch(orphan, /figurePlaceholder/);
  assert.doesNotMatch(viewer.slice(viewer.indexOf("function visualCropNotice"), viewer.indexOf("function orphanVisualNotice")), /placeholderEnabled|tier3/);
  const end = viewer.lastIndexOf("init();");
  assert.equal(viewer.slice(end + "init();".length).trim(), "");
  const library = read("lib/pdf-library.js").split("\n");
  assert.equal(library[13], 'import { diagLog } from "./diag-log.js";');
  assert.equal(library[14], 'import { libraryLoadedAt, libraryReviveAllowed, libraryWritesStopped } from "./library-writes.js";');
});

function contrast(hexA, hexB) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex) => {
    const n = hex.replace("#", "");
    const r = lin(parseInt(n.slice(0, 2), 16) / 255);
    const g = lin(parseInt(n.slice(2, 4), 16) / 255);
    const b = lin(parseInt(n.slice(4, 6), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hi = Math.max(lum(hexA), lum(hexB));
  const lo = Math.min(lum(hexA), lum(hexB));
  return (hi + 0.05) / (lo + 0.05);
}

test("figure card muted text on well is at least 4.5:1 in five reader themes", () => {
  const css = read("pdf/reader-tokens.css");
  const pick = (name) => {
    const match = css.match(new RegExp(`--oi-reader-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(match, name);
    return match[1];
  };
  for (const theme of ["warm", "white", "sepia", "green"]) {
    const muted = pick(`${theme}-muted`);
    const well = pick(`${theme}-well`);
    const ratio = contrast(muted, well);
    assert.ok(ratio >= 4.5, `${theme} ${muted} on ${well} = ${ratio}`);
  }
  const dark = css.slice(css.indexOf('[data-reader-theme="dark"]'));
  const darkHex = (name) => {
    const match = dark.match(new RegExp(`--oi-reader-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(match, name);
    return match[1];
  };
  const ratio = contrast(darkHex("muted"), darkHex("well"));
  assert.ok(ratio >= 4.5, `dark ${darkHex("muted")} on ${darkHex("well")} = ${ratio}`);
});
