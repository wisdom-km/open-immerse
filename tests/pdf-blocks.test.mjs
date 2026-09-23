import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CROP_SCALE,
  LAYOUT_MODES,
  OCR_PAGE_HINT,
  PLACEHOLDER_RE,
  PROTOCOL,
  bboxToPercentRect,
  blockReadoutPlan,
  cropBlockImage,
  normalizeIncomingBlock,
  placeholderTokens,
  preparePageBlocks,
  rasterCropRect,
  textLayerTrust
} from "../lib/pdf-blocks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(readFileSync(join(root, "tests/fixtures/pdf-blocks/sample-page.json"), "utf8"));
const blocksSrc = readFileSync(join(root, "lib/pdf-blocks.js"), "utf8");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");

const figureBbox = [72 / 612, 312 / 792, 172 / 612, 392 / 792];

test("protocol constants name blocks-1, crop scale, and the three layout modes", () => {
  assert.equal(PROTOCOL, "blocks-1");
  assert.equal(CROP_SCALE, 2);
  assert.deepEqual(LAYOUT_MODES, ["text-layer", "local-ocr", "cloud-ocr"]);
  assert.match(blocksSrc, /text-layer.*划区不可用时的兜底/);
  assert.match(blocksSrc, /local-ocr.*测试期本机智谱 GLM-OCR/);
  assert.match(blocksSrc, /cloud-ocr.*上线 OCR API/);
  assert.equal(blocksSrc.includes("fetch("), false);
  assert.equal(OCR_PAGE_HINT, "本页文字层不可用，正文来自识别结果，可能有误差。公式、图、表仍是原页截图。");
});

test("normalizeIncomingBlock strips formula letters and markup", () => {
  const input = {
    id: "p3-b5",
    label: "formula",
    bbox: [0.2, 0.55, 0.8, 0.62],
    latex: "E = mc^2",
    content: "n",
    html: "<math>n</math>",
    md: "$n$",
    text: "n"
  };
  const out = normalizeIncomingBlock(input);
  assert.equal(Object.hasOwn(out, "latex"), false);
  assert.equal(Object.hasOwn(out, "content"), false);
  assert.equal(Object.hasOwn(out, "html"), false);
  assert.equal(Object.hasOwn(out, "md"), false);
  assert.equal(Object.hasOwn(out, "text"), false);
  assert.equal(out.label, "formula");
  assert.equal(input.latex, "E = mc^2");
  const page = preparePageBlocks(sample);
  const dirty = page.blocks.find((block) => block.id === "p3-b5");
  assert.equal(Object.hasOwn(dirty, "latex"), false);
  assert.equal(Object.hasOwn(dirty, "text"), false);
  assert.equal(page.blocks.some((block) => block.label === "text" && /attention function/.test(block.text)), true);
});

test("preparePageBlocks drops header and footer and keeps reading order", () => {
  const page = preparePageBlocks({
    protocol: PROTOCOL,
    page: 1,
    blocks: [
      { id: "h", label: "header", text: "arXiv" },
      { id: "a", label: "text", text: "First sentence." },
      { id: "f", label: "footer", text: "1" },
      { id: "b", label: "figure", bbox: [0, 0, 1, 1], latex: "nope" }
    ]
  });
  assert.deepEqual(page.blocks.map((block) => block.id), ["a", "b"]);
  assert.equal(Object.hasOwn(page.blocks[1], "latex"), false);
});

test("rasterCropRect matches the CTM sample within one pixel", () => {
  const rect = rasterCropRect(figureBbox, 1224, 1584);
  const expectW = (100 / 612) * 1224;
  const expectH = (80 / 792) * 1584;
  assert.ok(Math.abs(rect.sw - expectW) <= 1);
  assert.ok(Math.abs(rect.sh - expectH) <= 1);
  assert.equal(rect.sw, Math.max(1, Math.round(expectW)));
  assert.equal(rect.sh, Math.max(1, Math.round(expectH)));
  const percent = bboxToPercentRect(figureBbox);
  assert.ok(Math.abs(percent.width - (100 / 612) * 100) < 1e-9);
  assert.ok(Math.abs(percent.height - (80 / 792) * 100) < 1e-9);
});

test("sample figure bbox is the architecture CTM conversion", () => {
  const figure = sample.blocks.find((block) => block.label === "figure");
  assert.ok(figure);
  figure.bbox.forEach((value, index) => {
    assert.ok(Math.abs(value - figureBbox[index]) < 1e-12);
  });
  const prepared = preparePageBlocks({ ...sample, page: 1 });
  assert.equal(prepared.page, 1);
  assert.equal(prepared.blocks.find((block) => block.id === "p3-b2").inlineOf, undefined);
  assert.equal(prepared.blocks.find((block) => block.id === "p3-b3").inlineOf, "p3-b1");
});

test("textLayerTrust matches the three architecture boundaries", () => {
  assert.deepEqual(
    textLayerTrust([{ str: "The dominant sequence transduction models are based on attention." }]),
    { trusted: true, reason: "text-layer" }
  );
  assert.deepEqual(textLayerTrust([]), { trusted: false, reason: "empty" });
  const clean = "Attention";
  const garbled = `${clean}${"\uFFFD".repeat(clean.length)}`;
  assert.deepEqual(textLayerTrust([{ str: garbled }]), { trusted: false, reason: "garbled" });
});

test("placeholder regex finds ⟦fN⟧ tokens", () => {
  assert.equal(PLACEHOLDER_RE.source, "⟦f(\\d+)⟧");
  assert.deepEqual(placeholderTokens("see ⟦f1⟧ and ⟦f2⟧"), [
    { token: "⟦f1⟧", n: 1 },
    { token: "⟦f2⟧", n: 2 }
  ]);
});

test("tiny crops and OCR formula letters never become the image", () => {
  const tiny = cropBlockImage({ width: 80, height: 40 }, [0, 0, 0.2, 0.2]);
  assert.equal(tiny, "");
  const cleaned = normalizeIncomingBlock({ label: "formula", text: "n", latex: "n", content: "n", html: "n" });
  assert.equal(Object.hasOwn(cleaned, "text"), false);
  assert.equal(Object.hasOwn(cleaned, "latex"), false);
  assert.equal(Object.hasOwn(cleaned, "content"), false);
  const plan = blockReadoutPlan({ label: "formula", text: "n", latex: "n", imageUrl: "" });
  assert.equal(plan.alt, "公式");
  assert.equal(plan.src, "");
  assert.equal(plan.text, undefined);
  assert.doesNotMatch(String(plan.src), /viewer\.html|chrome-extension:/);
});

test("visual readout plan is an image and prose stays text", () => {
  const image = blockReadoutPlan({ label: "formula", imageUrl: "data:image/png;base64,aa" });
  assert.equal(image.image, true);
  assert.equal(image.tag, "figure");
  assert.equal(image.className, "oi-pdf-display-math");
  assert.equal(image.imageClass, "oi-pdf-math-crop");
  assert.equal(image.alt, "公式");
  assert.equal(image.src, "data:image/png;base64,aa");
  const inline = blockReadoutPlan({ label: "formula", display: false, inlineOf: "p1", imageUrl: "data:image/png;base64,aa" });
  assert.equal(inline.tag, "span");
  assert.equal(inline.className, "oi-pdf-inline-math");
  const figure = blockReadoutPlan({ label: "figure", imageUrl: "data:image/png;base64,bb" });
  assert.equal(figure.tag, "figure");
  assert.equal(figure.className, "oi-pdf-figure");
  assert.equal(figure.imageClass, "oi-pdf-asset-crop");
  const caption = blockReadoutPlan({ label: "caption", text: "Figure 1: The Transformer." });
  assert.equal(caption.tag, "figcaption");
  assert.equal(caption.className, "oi-pdf-caption");
  const prose = blockReadoutPlan({ label: "text", text: "Keep the sentence.", presentation: "byline" });
  assert.equal(prose.text, "Keep the sentence.");
  assert.equal(prose.role, "authors");
  assert.equal(prose.image, undefined);
});

test("fixture viewer crops through cropBlockImage and leaves the legacy formula call", () => {
  assert.match(viewerSrc, /oi-pdf-engine/);
  assert.match(viewerSrc, /cropBlockImage/);
  assert.match(viewerSrc, /scale: CROP_SCALE/);
  assert.doesNotMatch(viewerSrc, /cropCanvasToDataUrl/);
  assert.doesNotMatch(viewerSrc, /buildMirrorLayout/);
  assert.doesNotMatch(viewerSrc, /appendMirrorPage/);
  const fixture = viewerSrc.slice(
    viewerSrc.indexOf("function appendFixtureReadout"),
    viewerSrc.indexOf("function onReadoutBlockClick")
  );
  assert.doesNotMatch(fixture, /renderFormulaNode/);
  const legacy = viewerSrc.slice(
    viewerSrc.indexOf("function appendReadoutNode"),
    viewerSrc.indexOf("function renderFormulaNode")
  );
  assert.doesNotMatch(legacy, /renderFormulaNode\(/);
  assert.match(viewerSrc, /function renderFormulaNode/);
  assert.match(viewerSrc, /textLayerToBlocks/);
  assert.match(viewerSrc, /resolveLayoutMode/);
});
