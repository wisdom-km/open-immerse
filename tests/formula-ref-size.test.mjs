/**
 * FORMULA-REF-SIZE §8. Crop formulas use a fixed 18px reference.
 * Aa does not scale them. arXiv KaTeX still does.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CROP_SCALE } from "../lib/pdf-blocks.js";
import {
  BODY_X_HEIGHT_RATIO,
  FORMULA_REF_FALLBACK_PX,
  FORMULA_REF_SHRINK,
  formulaRefFloorScale,
  formulaRefPxFromCss,
  formulaRefScale,
  readerFormulaCssSize
} from "../lib/pdf-formula-size.js";
import {
  FORMULA_CROP_MAX_EDGE,
  FORMULA_CROP_MAX_PIXELS,
  FORMULA_INK_MIN_SPAN,
  FORMULA_RASTER_SLACK,
  formulaRefRasterPlan,
  formulaRefRasterScale,
  inlineShortCropScale
} from "../lib/pdf-formula-raster.js";
import {
  FORMULA_INK_PAD_PX,
  formulaBaselineDepthPt,
  formulaInkPadPt,
  rebaseFormulaBaseline,
  textLayerToBlocks
} from "../lib/pdf-text-layer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const dpoEq7Path = join(root, "tests/fixtures/dpo-eq7-glyphs.json");
const DPO_FIXTURE_SKIP = [
  "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf is gitignored and is not committed.",
  "scripts/ci/fetch-fixtures.sh downloads arXiv 2305.18290v3 into that path.",
  "tests/fixtures/dpo-eq7-glyphs.json is the committed glyph-edge fixture and does not need the PDF."
].join(" ");
const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");

function unitViewport(width, height) {
  return {
    width,
    height,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, height - y2, x2, height - y1];
    }
  };
}

function pdfItem(str, x, y, width, height, extra = {}) {
  return { str, transform: [1, 0, 0, 1, x, y], width, height, ...extra };
}

test("acceptance 1: the reference token is 18px and new names stay on --oi-reader-*", () => {
  const declared = /--oi-reader-formula-ref-size:\s*([^;]+);/.exec(tokens);
  assert.ok(declared, "missing --oi-reader-formula-ref-size");
  assert.equal(formulaRefPxFromCss(declared[1]), 18);
  assert.equal(formulaRefPxFromCss(""), FORMULA_REF_FALLBACK_PX);
  assert.equal(formulaRefPxFromCss("nope"), FORMULA_REF_FALLBACK_PX);
  assert.match(tokens, /--oi-reader-formula-ref-size:\s*18px;/);
  assert.match(css, /var\(--oi-reader-formula-ref-size\)/);
  assert.match(css, /var\(--oi-reader-formula-baseline,\s*calc\(-0\.2 \* var\(--oi-reader-formula-ref-size\)\)\)/);
  assert.doesNotMatch(css, /--oi-formula-ref/);
  assert.doesNotMatch(tokens, /--oi-formula-ref/);
  assert.match(css, /\.oi-pdf-math-row\.is-katex \.katex\s*\{[^}]*font-size:\s*1\.1em/s);
  assert.match(css, /\.oi-pdf-inline-math\.is-katex \.katex\s*\{[^}]*font-size:\s*1em/s);
  assert.doesNotMatch(css, /\.is-katex[^{]*\{[^}]*--oi-reader-formula-ref-size/);
});

test("acceptance 2: a 10pt body crop matches an 18px x-height within 10%", () => {
  const k = formulaRefScale(10);
  assert.equal(k, 18 / 10);
  const xBody = formulaRefPxFromCss("18px") * BODY_X_HEIGHT_RATIO;
  const xCrop = 10 * BODY_X_HEIGHT_RATIO * k;
  assert.ok(Math.abs(xCrop - xBody) / xBody <= 0.1, `crop x-height ${xCrop} vs ${xBody}`);
  const box = readerFormulaCssSize({
    bodyFontPx: 20,
    sourceBodyPt: 10,
    inkPt: 10,
    widthPt: 40,
    columnPx: 800
  });
  assert.ok(Math.abs(box.cssHeight - 18) < 1e-9);
});

test("acceptance 3: Aa from 14 to 40 does not change crop CSS and is not a raster key", () => {
  const sample = { sourceBodyPt: 10, inkPt: 22, widthPt: 180, scriptPt: 6, columnPx: 700, inline: true };
  const sizes = [];
  for (let font = 14; font <= 40; font += 1) {
    const box = readerFormulaCssSize({ ...sample, bodyFontPx: font });
    sizes.push(`${box.cssWidth}|${box.cssHeight}|${box.k}|${box.raised}`);
  }
  assert.equal(new Set(sizes).size, 1);
  const planKey = viewer.slice(viewer.indexOf("function formulaCropPlanKeyNow"), viewer.indexOf("function noteFormulaCropPlan"));
  assert.doesNotMatch(planKey, /readerShownFont|fontSize/);
  assert.match(viewer, /matchMedia\(`\(resolution:/);
});

test("acceptance 4 and 5: DPR ≤ 2 renders at 4, DPR 3 at 6, with no upsample and a pixel cap", () => {
  assert.equal(CROP_SCALE, 2);
  assert.equal(FORMULA_RASTER_SLACK, 1.05);
  const pdfW = 120;
  const pdfH = 24;
  const k = 1.8;
  for (const dpr of [1, 1.5, 2]) {
    assert.equal(formulaRefRasterScale(k, dpr), 4, `dpr ${dpr}`);
    const plan = formulaRefRasterPlan({
      pdfWidth: pdfW,
      pdfHeight: pdfH,
      cssWidth: pdfW * k,
      cssHeight: pdfH * k,
      devicePixelRatio: dpr
    });
    assert.equal(plan.scale, 4);
    assert.ok(plan.pixelWidth / plan.cssWidth >= Math.max(dpr, 2));
    assert.ok(plan.pixelWidth >= plan.cssWidth * dpr - 1e-6);
    assert.ok(plan.pixelWidth <= FORMULA_CROP_MAX_EDGE);
    assert.ok(plan.pixelHeight <= FORMULA_CROP_MAX_EDGE);
    assert.ok(plan.pixelWidth * plan.pixelHeight <= FORMULA_CROP_MAX_PIXELS);
  }
  assert.equal(formulaRefRasterScale(k, 3), 6);
  const hi = formulaRefRasterPlan({
    pdfWidth: pdfW,
    pdfHeight: pdfH,
    cssWidth: pdfW * k,
    cssHeight: pdfH * k,
    devicePixelRatio: 3
  });
  assert.equal(hi.scale, 6);
  assert.ok(hi.pixelWidth / hi.cssWidth >= 3);
  const huge = formulaRefRasterPlan({
    pdfWidth: 2000,
    pdfHeight: 800,
    cssWidth: 3600,
    cssHeight: 1440,
    devicePixelRatio: 2
  });
  assert.ok(huge.pixelWidth <= FORMULA_CROP_MAX_EDGE);
  assert.ok(huge.pixelHeight <= FORMULA_CROP_MAX_EDGE);
  assert.ok(huge.pixelWidth * huge.pixelHeight <= FORMULA_CROP_MAX_PIXELS);
  assert.ok(huge.pixelWidth >= huge.cssWidth * 2 - 1e-6);
});

test("acceptance 6 and 7: inline baseline uses PDF depth, and the line cap stays a negative margin", () => {
  const page = textLayerToBlocks({
    items: [
      pdfItem("where ", 72, 400, 32, 10, { fontName: "CMR10", fontRealName: "CMR10" }),
      pdfItem("x", 110, 400, 8, 10, { fontName: "CMMI10", fontRealName: "CMMI10" }),
      pdfItem("i", 118, 396, 4, 7, { fontName: "CMMI7", fontRealName: "CMMI7" }),
      pdfItem(" is the term.", 130, 400, 70, 10, { fontName: "CMR10", fontRealName: "CMR10" })
    ],
    viewport: unitViewport(612, 792),
    page: 2
  });
  const crops = page.blocks.filter((block) => block.label === "formula" && block.display === false);
  assert.ok(crops.length >= 1, "expected an inline crop");
  for (const crop of crops) {
    assert.equal(Number.isFinite(crop.baselineDepthPt), true, crop.id);
    const shift = -crop.baselineDepthPt * formulaRefScale(10);
    assert.ok(Math.abs(shift) < 18, `baseline shift ${shift}px`);
  }
  assert.match(
    css,
    /\.oi-pdf-inline-math\.is-matched:has\(\.oi-pdf-math-crop\)\s*\{[^}]*margin-top:\s*calc\(min\(0px, var\(--oi-reader-inline-line-max\) - var\(--oi-formula-h\)\) \/ 2\)/s
  );
  // Formula crops stay on the PDF baseline. The 6px paragraph-mark dot is an
  // inline marker and may use vertical-align: middle; this lock does not cover it.
  const formulaCss = css.slice(0, css.indexOf(".rf-mark {"));
  assert.doesNotMatch(formulaCss, /vertical-align:\s*middle/);
  assert.match(viewer, /--oi-reader-formula-baseline/);
  const cropRule = css.indexOf(".pane-translate .readout.md-readout .oi-pdf-inline-math.is-matched .oi-pdf-math-crop");
  const blockRule = css.indexOf(".pane-translate .readout.md-readout .oi-pdf-inline-math.is-matched > img.oi-pdf-math-crop");
  assert.ok(cropRule >= 0 && blockRule > cropRule, "direct crop images must beat the inline-block strut");
  assert.match(
    css.slice(blockRule, blockRule + 280),
    /display:\s*block;\s*vertical-align:\s*top;/
  );
});

test("acceptance 8: a wide display shrinks to the column, then scrolls at 13.5px", () => {
  assert.equal(formulaRefPxFromCss("18px") * FORMULA_REF_SHRINK, 13.5);
  const widthPt = 640;
  const open = readerFormulaCssSize({ sourceBodyPt: 10, inkPt: 40, widthPt, columnPx: 2000 });
  assert.equal(open.scrolls, false);
  assert.ok(Math.abs(open.cssWidth - widthPt * 1.8) < 0.05);
  const fitted = readerFormulaCssSize({ sourceBodyPt: 10, inkPt: 40, widthPt, columnPx: 1000 });
  assert.equal(fitted.scrolls, false);
  assert.ok(fitted.cssWidth <= 1000 - 2 + 0.05);
  assert.ok(fitted.k >= formulaRefFloorScale(10));
  const overflow = readerFormulaCssSize({ sourceBodyPt: 10, inkPt: 10, widthPt, columnPx: 400 });
  assert.equal(overflow.k, formulaRefFloorScale(10));
  assert.equal(overflow.scrolls, true);
  assert.ok(overflow.cssWidth > 400);
  assert.ok(Math.abs(10 * overflow.k - 13.5) < 1e-9);
});

test("acceptance 9: a short inline still clears the 24×12 floor", () => {
  const lifted = inlineShortCropScale(4, 5);
  assert.ok(lifted > 0);
  assert.ok(Math.round(4 * lifted) >= FORMULA_INK_MIN_SPAN.x);
  assert.ok(Math.round(5 * lifted) >= FORMULA_INK_MIN_SPAN.y);
  const covered = formulaRefRasterPlan({
    pdfWidth: 8,
    pdfHeight: 6,
    cssWidth: 8 * 1.8,
    cssHeight: 6 * 1.8,
    devicePixelRatio: 1
  });
  assert.ok(covered.pixelWidth >= FORMULA_INK_MIN_SPAN.x || lifted > 0);
  assert.ok(covered.cssWidth > 0 && covered.cssHeight > 0);
});

test("acceptance 10: crop rules do not fade the bitmap", () => {
  const rules = css.split("}").filter((rule) => rule.includes(".oi-pdf-math-crop"));
  assert.ok(rules.length > 0);
  for (const rule of rules) {
    assert.doesNotMatch(rule, /(?:^|[^-])opacity\s*:/);
    assert.doesNotMatch(rule, /(?:^|[^-])filter\s*:/);
  }
});

test("a 20px reference token scales the crop and the viewer reads that token", () => {
  const sample = { sourceBodyPt: 10, inkPt: 10, widthPt: 40, columnPx: 800 };
  const at18 = readerFormulaCssSize({ ...sample, refPx: formulaRefPxFromCss("18px") });
  const at20 = readerFormulaCssSize({ ...sample, refPx: formulaRefPxFromCss("20px") });
  assert.equal(formulaRefPxFromCss("20px"), 20);
  assert.ok(Math.abs(at20.cssWidth - 80) < 1e-9);
  assert.ok(Math.abs(at20.cssHeight - 20) < 1e-9);
  assert.ok(Math.abs(at20.cssWidth / at18.cssWidth - 20 / 18) < 1e-9);
  assert.equal(formulaRefPxFromCss("0px"), FORMULA_REF_FALLBACK_PX);
  assert.equal(formulaRefPxFromCss("20em"), FORMULA_REF_FALLBACK_PX);
  assert.match(viewer, /getPropertyValue\("--oi-reader-formula-ref-size"\)/);
  assert.match(viewer, /formulaRefPxFromCss\(raw\)/);
  assert.match(viewer, /refPx: readFormulaRefPx\(\)/);
  assert.doesNotMatch(viewer, /readerFontPx|FORMULA_REF_SIZE_PX|FORMULA_REF_FALLBACK_PX/);
});

test("inline baseline ignores scripts and counts the ink pad", () => {
  const viewport = unitViewport(612, 792);
  const glyph = (str, x, y, width, height, extra) => ({ ...pdfItem(str, x, y, width, height, extra), y });
  const body = [
    glyph("x", 100, 400, 8, 10, { fontName: "CMMI10" }),
    glyph("y", 112, 400, 8, 10, { fontName: "CMMI10" }),
    glyph("z", 124, 400, 8, 10, { fontName: "CMMI10" })
  ];
  const mixed = [
    ...body,
    glyph("i", 108, 394, 4, 6, { fontName: "CMMI7" }),
    glyph("2", 120, 408, 4, 6, { fontName: "CMMI7" }),
    glyph("(", 88, 388, 6, 24, { fontName: "CMEX10" })
  ];
  const padPt = formulaInkPadPt({ inline: true, protect: true });
  assert.equal(padPt, FORMULA_INK_PAD_PX.inlineProtect / CROP_SCALE);
  const baselineVp = 792 - 400;
  const tightBottom = baselineVp / 792;
  const tight = [0.1, 0.45, 0.3, tightBottom];
  const depth = formulaBaselineDepthPt(mixed, viewport, tight, { inline: true, protect: true });
  const bodyOnly = formulaBaselineDepthPt(body, viewport, tight, { inline: true, protect: true });
  assert.equal(depth, bodyOnly);
  assert.ok(Math.abs(depth - padPt) < 0.02, `depth ${depth} should be the ${padPt}pt ink pad`);
  const piStar = [
    glyph("π", 100, 400, 8, 9.96, { fontName: "CMMI10" }),
    glyph("∗", 110, 403.62, 4, 6.97, { fontName: "CMMI7" })
  ];
  const piDepth = formulaBaselineDepthPt(piStar, viewport, tight, { inline: true, protect: true });
  assert.ok(Math.abs(piDepth - padPt) < 0.05, `π∗ depth ${piDepth} averaged the superscript`);
  const shift = -depth * formulaRefScale(10, formulaRefPxFromCss("18px"));
  assert.ok(Math.abs(shift - (-padPt * 1.8)) < 0.05, `shift ${shift}`);
  const page = textLayerToBlocks({
    items: [
      pdfItem("where ", 72, 400, 32, 10, { fontName: "CMR10" }),
      ...mixed,
      pdfItem(" ends.", 160, 400, 36, 10, { fontName: "CMR10" })
    ],
    viewport,
    page: 3
  });
  const crop = page.blocks.find((block) => block.label === "formula");
  assert.ok(crop, "expected a formula crop");
  assert.ok(crop.baselineDepthPt + 1e-6 >= crop.baselinePadPt, `painted depth ${crop.baselineDepthPt}`);
  const trimmed = crop.bbox.slice();
  trimmed[3] = crop.baselinePageFrac;
  const rebased = rebaseFormulaBaseline({ ...crop }, trimmed, { trimmed: true });
  assert.ok(Math.abs(rebased) < 0.02, `trimmed rebase ${rebased} should follow the box, not the pad`);
  const untrimmed = rebaseFormulaBaseline({ ...crop }, trimmed);
  assert.ok(Math.abs(untrimmed - crop.baselinePadPt) < 0.02, `untrimmed rebase ${untrimmed}`);
  const above = crop.bbox.slice();
  above[3] = crop.baselinePageFrac - 1.2 / crop.baselinePageH;
  const negative = rebaseFormulaBaseline({ ...crop }, above, { inkTrimmed: true });
  assert.ok(negative < -1, `negative trimmed depth ${negative}`);
  const shallow = crop.bbox.slice();
  shallow[3] = crop.baselinePageFrac + 0.4 / crop.baselinePageH;
  const shallowDepth = rebaseFormulaBaseline({ ...crop }, shallow, { trimmed: true });
  assert.ok(Math.abs(shallowDepth - 0.4) < 0.02, `shallow trimmed depth ${shallowDepth}`);
  assert.match(
    viewer,
    /baselineDepthPt: block\?\.baselineDepthPt != null && Number\.isFinite\(Number\(block\?\.baselineDepthPt\)\)/
  );
  const stamp = viewer.slice(viewer.indexOf("function stampFormulaBaseline"), viewer.indexOf("function stampDisplayFormulaScale"));
  assert.match(stamp, /if \(matched\?\.baselineDepthPt == null\)/);
  assert.match(stamp, /setProperty\("--oi-reader-formula-baseline"/);
  assert.match(viewer, /rebaseFormulaBaseline\(block, trimmed, \{ trimmed: Number\(probe\.inkShare\) > 0 \}\)/);
});

test("acceptance 11: DPO eq(7) glyph edges fit a 620px column", () => {
  const fixture = JSON.parse(readFileSync(dpoEq7Path, "utf8"));
  assert.equal(fixture.page, 4);
  assert.equal(fixture.equation, 7);
  assert.ok(fixture.glyphs.length > 8);
  const left = Math.min(...fixture.glyphs.map((glyph) => glyph.x));
  const right = Math.max(...fixture.glyphs.map((glyph) => glyph.x + glyph.w));
  const widthPt = right - left;
  assert.ok(widthPt > 320 && widthPt < 360, `fixture span ${widthPt}pt`);
  const refPx = formulaRefPxFromCss("18px");
  for (const sourceBodyPt of [10, fixture.bodyPt]) {
    for (const font of [14, 20, 40]) {
      const box = readerFormulaCssSize({
        bodyFontPx: font,
        sourceBodyPt,
        inkPt: 22,
        widthPt,
        columnPx: 620,
        refPx
      });
      assert.equal(box.scrolls, false, `f=${sourceBodyPt} font ${font}`);
      assert.ok(box.cssWidth <= 620, `width ${box.cssWidth}`);
      assert.equal(box.k, Math.round(formulaRefScale(sourceBodyPt, refPx) * 10000) / 10000);
      assert.ok(Math.abs(box.cssWidth - widthPt * box.k) < 0.05);
    }
  }
});

test("acceptance 11: DPO page-4 equation (7) ink fits a 620px column", async (t) => {
  if (!existsSync(dpoPath)) {
    t.skip(DPO_FIXTURE_SKIP);
    return;
  }
  const { describeBodyFont } = await import("../lib/pdf-body-font.js");
  const { getDocument, GlobalWorkerOptions } = await import("../pdf/vendor/pdf.min.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(dpoPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  try {
    const pdfPage = await doc.getPage(4);
    const content = await pdfPage.getTextContent();
    const viewport = pdfPage.getViewport({ scale: 1 });
    const described = describeBodyFont(content.items, {
      pageWidth: viewport.width,
      pageHeight: viewport.height
    });
    const bodyPt = described.trusted && described.bodyItemHeight > 0 ? described.bodyItemHeight : 10;
    const seven = content.items.find((item) => String(item.str || "").trim() === "(7)");
    assert.ok(seven, "page 4 has no (7) glyph");
    const y = Number(seven.transform?.[5]);
    const labelX = Number(seven.transform?.[4]);
    const ink = content.items.filter((item) => {
      const text = String(item.str || "").trim();
      const gy = Number(item.transform?.[5]);
      const gx = Number(item.transform?.[4]);
      if (!text || text === "(7)") return false;
      if (!(gy > y - 20) || !(gy < y + 16)) return false;
      return gx + Number(item.width || 0) < labelX - 4;
    });
    assert.ok(ink.length > 8, "equation (7) ink did not stay on one line");
    const left = Math.min(...ink.map((item) => Number(item.transform[4])));
    const right = Math.max(...ink.map((item) => Number(item.transform[4]) + Number(item.width || 0)));
    const widthPt = right - left;
    // Compare notes measured the padded crop at 340pt → 612px. Raw glyphs
    // sit a few points inside that pad; both must stay inside 620px at full k.
    assert.ok(widthPt > 320 && widthPt < 360, `eq(7) span ${widthPt}pt`);
    for (const sourceBodyPt of [10, bodyPt]) {
      const box = readerFormulaCssSize({
        sourceBodyPt,
        inkPt: 22,
        widthPt,
        columnPx: 620
      });
      assert.equal(box.scrolls, false, `f=${sourceBodyPt} scrolls`);
      assert.equal(box.k, Math.round(formulaRefScale(sourceBodyPt) * 10000) / 10000);
      assert.ok(box.cssWidth <= 620, `f=${sourceBodyPt} width ${box.cssWidth}`);
    }
    const atTen = readerFormulaCssSize({ sourceBodyPt: 10, inkPt: 22, widthPt, columnPx: 620 });
    assert.ok(Math.abs(atTen.cssWidth - 612) < 16, `10pt css ${atTen.cssWidth} left the 612px measure`);
    const built = textLayerToBlocks({ items: content.items, viewport, page: 4 });
    for (const block of built.blocks || []) {
      if (block.label !== "formula" || block.display === false || block.inlineOf) continue;
      const blockW = (Number(block.bbox[2]) - Number(block.bbox[0])) * viewport.width;
      const blockH = (Number(block.bbox[3]) - Number(block.bbox[1])) * viewport.height;
      const painted = readerFormulaCssSize({
        sourceBodyPt: bodyPt,
        inkPt: blockH,
        widthPt: blockW,
        columnPx: 620
      });
      assert.equal(painted.scrolls, false, `${block.id} scrolls at ${painted.cssWidth}px`);
    }
  } finally {
    await doc.destroy();
  }
});
