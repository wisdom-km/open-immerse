import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";
import { OCR_PAGE_HINT, visualAlt } from "../lib/pdf-blocks.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { showsBlockReadout } from "../lib/pdf-viewer.js";
import {
  LAYOUT_EMPTY_KEY_STATUS,
  LAYOUT_FALLBACK_STATUS,
  fetchCloudEnvelope,
  fetchLocalEnvelope,
  layoutCacheKey,
  cacheableLayout,
  resolveLayoutMode,
  shouldFetchCloud
} from "../lib/pdf-layout-client.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sample = JSON.parse(readFileSync(join(root, "tests/fixtures/pdf-blocks/glm-cloud-sample.json"), "utf8"));
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");

function viewport() {
  return {
    width: 612,
    height: 792,
    convertToViewportRectangle(rect) {
      const [x1, y1, x2, y2] = rect;
      return [x1, 792 - y2, x2, 792 - y1];
    }
  };
}

test("formula content n is dropped, image becomes figure, table has no html", () => {
  const page = vendorLayoutToBlocks(sample, { viewport: viewport(), page: 1 });
  const formula = page.blocks.find((block) => block.label === "formula");
  assert.ok(formula);
  assert.equal(formula.content, undefined);
  assert.equal(formula.latex, undefined);
  assert.equal(JSON.stringify(formula).includes('"n"'), false);
  assert.equal(visualAlt(formula.label), "公式");
  assert.notEqual(visualAlt(formula.label), "n");
  const figure = page.blocks.find((block) => block.label === "figure");
  assert.ok(figure);
  assert.equal(page.blocks.some((block) => block.label === "image"), false);
  const table = page.blocks.find((block) => block.label === "table");
  assert.ok(table);
  assert.equal(table.html, undefined);
  assert.equal(table.content, undefined);
  assert.equal(JSON.stringify(table).includes("<table>"), false);
});

test("trusted text uses items inside the bbox and ignores vendor content", () => {
  const page = vendorLayoutToBlocks(sample, {
    viewport: viewport(),
    page: 1,
    items: [
      { str: "The real sentence.", x: 80, y: 620, width: 180, height: 12 }
    ]
  });
  const text = page.blocks.find((block) => block.label === "text" || block.label === "title");
  assert.ok(text);
  assert.match(text.text, /The real sentence/);
  assert.equal(text.text.includes("vendor sentence"), false);
  assert.equal(text.vendorText, undefined);
  assert.equal(text.content, undefined);
});

test("garbled items take vendorText and formula letters stay off the block", () => {
  const clean = "Attention";
  const garbled = `${clean}${"\uFFFD".repeat(clean.length)}`;
  const page = vendorLayoutToBlocks(sample, {
    viewport: viewport(),
    page: 1,
    items: [{ str: garbled, x: 80, y: 620, width: 180, height: 12 }]
  });
  assert.equal(page.textSource, "ocr");
  const text = page.blocks.find((block) => block.text === "vendor sentence that must be ignored");
  assert.ok(text);
  assert.equal(text.vendorText, undefined);
  const formula = page.blocks.find((block) => block.label === "formula");
  assert.ok(formula);
  assert.equal(formula.content, undefined);
  assert.equal(formula.latex, undefined);
  assert.equal(JSON.stringify(formula).includes('"n"'), false);
});

test("empty text layer without an envelope has no blocks", () => {
  const page = textLayerToBlocks({ items: [], viewport: viewport(), page: 1 });
  assert.equal(page.textSource, "ocr");
  assert.deepEqual(page.blocks, []);
  assert.equal(OCR_PAGE_HINT.length > 0, true);
  assert.equal(showsBlockReadout({ kind: "blocks", textSource: "ocr", blocks: [] }), true);
  assert.equal(showsBlockReadout({ kind: "blocks", textSource: "text-layer", blocks: [] }), false);
});

test("local and cloud envelopes share vendorLayoutToBlocks", () => {
  const local = vendorLayoutToBlocks({ ...sample, layout_details: sample.layoutDetails, layoutDetails: undefined }, { viewport: viewport() });
  const cloud = vendorLayoutToBlocks(sample, { viewport: viewport() });
  assert.equal(local.blocks.find((block) => block.label === "formula").content, undefined);
  assert.equal(cloud.blocks.find((block) => block.label === "figure")?.label, "figure");
});

test("empty mode tries local-ocr, and cloud with no key does not fetch", async () => {
  assert.equal(resolveLayoutMode(null, ""), "local-ocr");
  assert.equal(resolveLayoutMode({ mode: "text-layer" }, ""), "text-layer");
  assert.equal(resolveLayoutMode({ mode: "cloud-ocr" }, "text-layer"), "text-layer");
  assert.equal(shouldFetchCloud({ cloudApiKey: "" }), false);
  assert.equal(shouldFetchCloud({ cloudApiKey: "secret" }), true);
  let called = 0;
  await assert.rejects(
    () => fetchCloudEnvelope({ apiKey: "", fetchImpl: async () => { called += 1; return { ok: true, json: async () => ({}) }; } }),
    /cloud api key missing/
  );
  assert.equal(called, 0);
  const localBody = [];
  const envelope = await fetchLocalEnvelope({
    baseUrl: "http://127.0.0.1:8765",
    page: 2,
    imageBase64: "abc",
    pixelWidth: 10,
    pixelHeight: 20,
    fetchImpl: async (url, init) => {
      localBody.push({ url, body: JSON.parse(init.body) });
      return { ok: true, json: async () => sample };
    }
  });
  assert.equal(localBody[0].url, "http://127.0.0.1:8765/v1/layout");
  assert.equal(localBody[0].body.page, 2);
  assert.equal(envelope.vendor, "glm-ocr");
  const stored = cacheableLayout({
    protocol: "blocks-1",
    page: 1,
    textSource: "text-layer",
    blocks: [{ id: "f", label: "formula", imageUrl: "data:image/png;base64,aa", content: "n" }]
  });
  assert.equal(stored.blocks[0].imageUrl, undefined);
  assert.equal(stored.blocks[0].content, undefined);
  assert.match(layoutCacheKey({ hash: "abc", page: 1, mode: "local-ocr" }), /abc:1:local-ocr:blocks-1/);
});

test("viewer falls back to the text layer and crops both modes with one function", () => {
  assert.match(viewerSrc, /fetchLocalEnvelope/);
  assert.match(viewerSrc, /fetchCloudEnvelope/);
  assert.match(viewerSrc, /vendorLayoutToBlocks/);
  assert.match(viewerSrc, /LAYOUT_FALLBACK_STATUS/);
  assert.match(viewerSrc, /LAYOUT_EMPTY_KEY_STATUS/);
  assert.match(viewerSrc, /layoutNotice = LAYOUT_EMPTY_KEY_STATUS/);
  assert.match(viewerSrc, /layoutNotice = LAYOUT_FALLBACK_STATUS/);
  assert.match(viewerSrc, /if \(layoutNotice\) setStatus\(layoutNotice\)/);
  assert.equal(LAYOUT_FALLBACK_STATUS, "划区服务不可用，已使用文字层");
  assert.equal(LAYOUT_EMPTY_KEY_STATUS, "云端密钥为空，已使用文字层");
  assert.match(viewerSrc, /cropBlockImage/);
  assert.match(viewerSrc, /showsBlockReadout/);
  assert.match(viewerSrc, /OCR_PAGE_HINT/);
  assert.match(viewerSrc, /pdfEngineMode\(\) !== "legacy"/);
  assert.doesNotMatch(viewerSrc, /buildMirrorLayout/);
  assert.doesNotMatch(viewerSrc, /appendMirrorPage/);
});
