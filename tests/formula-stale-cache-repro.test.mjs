/**
 * Characterization of the Attention stale-cache bug on main @ bbd9f9f.
 * Documents the missing formula-pipeline identity. Does not change product code.
 * See docs/formula-stale-cache-rca.md.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { detectArxivId } from "../lib/arxiv-id.js";
import { diagStateForPage } from "../lib/diag-log.js";
import { createFormulaCache, isDurableFormulaResult } from "../lib/formula-cache.js";
import { CHAIN_VERSION, tierCacheKey } from "../lib/formula-contract.js";
import { normalizeArxivPrefs, keptSourceId } from "../lib/formula-arxiv-session.js";
import { FORMULA_SWITCH_KEYS, formulaChainFlags } from "../lib/formula-settings.js";
import { arxivTier } from "../lib/formula-tiers/arxiv.js";
import { cropTier } from "../lib/formula-tiers/crop.js";
import { multimodalTier } from "../lib/formula-tiers/multimodal.js";
import { ocrTier } from "../lib/formula-tiers/ocr.js";
import { placeholderTier } from "../lib/formula-tiers/placeholder.js";
import { selfTier } from "../lib/formula-tiers/self.js";
import { vectorTier } from "../lib/formula-tiers/vector.js";
import { blockRenderPieces } from "../lib/pdf-blocks.js";
import { cacheableLayout, layoutCacheKey, resolveLayoutMode } from "../lib/pdf-layout-client.js";
import { buildSavedPairIndex, selectSavedHit, sourceReuseHash } from "../lib/pdf-library.js";
import { PDF_COPY } from "../lib/pdf-viewer.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const ATTENTION_SHA = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

function layoutAlgorithmFiles() {
  const source = readFileSync(join(root, "lib/pdf-layout-client.js"), "utf8");
  const match = source.match(/const LAYOUT_ALGORITHM_FILES = \[([\s\S]*?)\];/);
  assert.ok(match, "LAYOUT_ALGORITHM_FILES must stay a local list");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function memoryStore() {
  const tiers = new Map();
  const decisions = new Map();
  return {
    tiers,
    decisions,
    async getTier(key) { return tiers.get(key) ?? null; },
    async commitTier(key, record) {
      tiers.set(key, record);
      return true;
    },
    async getDecision(key) { return decisions.get(key) ?? null; },
    async putDecision(key, record) {
      decisions.set(key, record);
      return true;
    }
  };
}

test("layout and translation reuse keys omit the formula pipeline", () => {
  const key = layoutCacheKey({ hash: ATTENTION_SHA.slice(0, 12), page: 4, mode: "local-ocr" });
  assert.equal(
    key,
    `oi-pdf-layout:${ATTENTION_SHA.slice(0, 12)}:4:local-ocr:blocks-1:source-v3`
  );
  for (const absent of ["f3-1", "mm-6", "align-1", "formula-pipeline", "kimi-k3"]) {
    assert.equal(key.includes(absent), false, absent);
  }
  assert.deepEqual(layoutAlgorithmFiles(), [
    "pdf-text-layer.js",
    "pdf-layout-adapter.js",
    "pdf-blocks.js",
    "pdf-mirror.js"
  ]);
  assert.equal(sourceReuseHash.length, 1);
  const sentence = "We scale the dot products by 1/√d_k.";
  assert.equal(sourceReuseHash(sentence), sourceReuseHash(sentence));
  assert.equal(CHAIN_VERSION, "f3-1");
  const tierKey = tierCacheKey({
    unitKey: "p4-b9",
    tier: "multimodal",
    version: multimodalTier.version,
    model: "kimi-k3",
    cropHash: "abc"
  });
  assert.equal(tierKey.includes(CHAIN_VERSION), false);
  assert.equal(tierKey.includes("formula-pipeline"), false);
});

test("a saved pair is reused when the source sentence matches, even if placeholders and pipeline differ", () => {
  const sourceText = "While for large values of d_k, the dot products grow large in magnitude, pushing the softmax function into regions where it has extremely small gradients. To counteract this effect, we scale the dot products by 1/√d_k.";
  const index = buildSavedPairIndex([{
    sourceId: "p4-s-scale",
    sourceText,
    text: sourceText,
    translation: "为抵消这一点，我们将点积除以 1/√d_k。",
    targetLang: "zh-CN",
    provider: "openai",
    formulaPipeline: "crop-era"
  }], { targetLang: "zh-CN", provider: "openai" });
  const selected = selectSavedHit({
    sourceId: "p4-s-scale",
    sourceText,
    text: "To counteract this effect, we scale the dot products by ⟦f2⟧."
  }, index);
  assert.equal(selected.uncertain, false);
  assert.equal(selected.hit.translation, "为抵消这一点，我们将点积除以 1/√d_k。");
  assert.equal(selected.hit.formulaPipeline, "crop-era");
});

test("persisted layouts drop formula identity, and the decision cache ignores crop and arxiv", async () => {
  const stored = cacheableLayout({
    page: 4,
    mode: "local-ocr",
    blocks: [{
      id: "p4-b9",
      label: "formula",
      sourceText: "1/√d_k",
      formulaTier: "arxiv",
      latex: "1/\\sqrt{d_k}",
      latexSource: "arxiv-src",
      verified: true,
      imageUrl: "data:image/png;base64,abc",
      sourceUnitId: "eq-1"
    }]
  });
  const block = stored.blocks[0];
  for (const field of ["formulaTier", "latex", "latexSource", "verified", "imageUrl", "sourceUnitId"]) {
    assert.equal(field in block, false, field);
  }
  assert.equal(isDurableFormulaResult({ tier: "crop", status: "ok", render: "image" }), false);
  assert.equal(isDurableFormulaResult({
    tier: "arxiv", status: "ok", render: "katex", latex: "1/\\sqrt{d_k}"
  }), false);
  assert.equal(isDurableFormulaResult({ tier: "self", status: "ok", render: "unicode" }), false);
  assert.equal(isDurableFormulaResult({ tier: "vector", status: "skip", reason: "not-implemented" }), false);
  assert.equal(isDurableFormulaResult({ tier: "placeholder", status: "ok", render: "placeholder" }), false);

  const store = memoryStore();
  const cache = createFormulaCache(store);
  const unit = { id: "p4-b9", page: 4, bbox: [0.1, 0.2, 0.3, 0.25] };
  const remembered = await cache.rememberDecision(unit, {
    chosen: { tier: "crop", status: "ok", render: "image" },
    chainVersion: CHAIN_VERSION
  }, { model: "kimi-k3" });
  assert.equal(remembered, false);
  assert.equal(store.decisions.size, 0);

  const stale = createFormulaCache({
    async getTier() {
      return { chainVersion: "older-than-f3", result: { tier: "multimodal", latex: "stale" } };
    },
    async commitTier() { return true; },
    async getDecision() { return null; },
    async putDecision() { return true; }
  });
  assert.equal(await stale.readTier("p4"), null);

  const sameGeneration = createFormulaCache({
    async getTier() {
      return { chainVersion: "f3-1", result: { tier: "multimodal", latex: "old-mm" } };
    },
    async commitTier() { return true; },
    async getDecision() { return null; },
    async putDecision() { return true; }
  });
  assert.equal((await sameGeneration.readTier("p4")).latex, "old-mm");
});

test("local-ocr is an explicit layout engine, and arXiv source stays opt-in", () => {
  assert.equal(resolveLayoutMode({ mode: "" }), "text-layer");
  assert.equal(resolveLayoutMode({}), "text-layer");
  assert.equal(resolveLayoutMode({ mode: "local-ocr" }), "local-ocr");
  assert.equal(resolveLayoutMode({ mode: "text-layer" }, "local-ocr"), "local-ocr");

  const stamp = detectArxivId({
    url: "Attention_Is_All_You_Need.pdf",
    page1Items: [{ str: "arXiv:1706.03762v7  [cs.CL]  12 Jun 2017", x: 36, y: 740 }],
    page: { width: 612, height: 792 }
  });
  assert.equal(stamp.id, "1706.03762");
  assert.equal(stamp.version, "v7");
  assert.equal(stamp.source, "stamp");
  assert.equal(detectArxivId({ url: "Attention_Is_All_You_Need.pdf" }), null);
  assert.equal(detectArxivId({
    page1Items: [{ str: "arXiv:1607.06450", x: 72, y: 200 }],
    page: { width: 612, height: 792 }
  }), null);
  assert.equal(detectArxivId({ url: "https://arxiv.org/pdf/1706.03762v7.pdf" }).source, "url");

  const prefs = normalizeArxivPrefs(null);
  assert.equal(prefs.auto, false);
  assert.deepEqual(prefs.on, []);
  assert.equal(keptSourceId(prefs, "1706.03762"), false);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(viewer, /arxivPrefs\.auto === true \|\| keptSourceId\(arxivPrefs, found\.id\)/);
  assert.match(viewer, /arxivPhase = "offer"/);

  const configured = formulaChainFlags({
    [FORMULA_SWITCH_KEYS.tier2]: false,
    multimodal: { provider: "kimi", apiKey: "sk-test", model: "kimi-k3" }
  });
  assert.equal(configured.multimodalConfigured, true);
  assert.equal(configured.multimodalEnabled, false);
  assert.equal(configured.arxivEnabled, false);
  assert.equal(arxivTier.available({ flags: configured }), false);
  assert.equal(multimodalTier.available({ flags: configured }), false);
  const enabled = formulaChainFlags({
    [FORMULA_SWITCH_KEYS.tier2]: true,
    multimodal: { provider: "kimi", apiKey: "sk-test", model: "kimi-k3" }
  }, { arxivEnabled: true });
  assert.equal(enabled.multimodalEnabled, true);
  assert.equal(arxivTier.available({ flags: enabled }), true);
  assert.deepEqual(
    [arxivTier.version, multimodalTier.version, ocrTier.version, selfTier.version, vectorTier.version, cropTier.version, placeholderTier.version],
    ["align-1", "mm-6", "stub-0", "plaintext-1", "skip-0", "raster-1", "decision-1"]
  );
});

test("a library hit is logged as translated, and the status line does not say the result is old", () => {
  assert.equal(diagStateForPage("done"), "translated");
  assert.equal(diagStateForPage("partial"), "translated");
  assert.equal(diagStateForPage("skipped"), "translated");
  assert.equal(diagStateForPage("empty"), "translated");
  assert.equal(diagStateForPage("held"), "translated");
  assert.equal(diagStateForPage("layout"), "translating");
  assert.equal(diagStateForPage("running"), "translating");
  assert.equal(PDF_COPY.done, "本页已翻译。");
  const viewer = readFileSync(join(root, "lib/pdf-viewer.js"), "utf8");
  assert.doesNotMatch(viewer, /旧结果|旧的公式/);
  assert.equal(readFileSync(join(root, "pdf/viewer.js"), "utf8").includes("inlinePromotesToDisplay"), false);
});

test("current main text layer keeps Attention page 4 sentences intact", {
  skip: !existsSync(fixture) && "local Attention PDF fixture is absent"
}, async () => {
  const bytes = readFileSync(fixture);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ATTENTION_SHA);
  const doc = await getDocument({
    data: new Uint8Array(bytes), verbosity: 0, isOffscreenCanvasSupported: false
  }).promise;
  const pdfPage = await doc.getPage(4);
  const content = await pdfPage.getTextContent();
  const viewport = pdfPage.getViewport({ scale: 1 });
  const ops = await pdfPage.getOperatorList();
  const page = textLayerToBlocks({
    items: content.items,
    viewport,
    images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
    page: 4
  });
  const blocks = page.blocks;
  const one = (pred, name) => {
    const found = blocks.filter(pred);
    assert.equal(found.length, 1, `${name}: ${found.map((block) => block.id).join(",")}`);
    return found[0];
  };

  const scaled = one((block) => block.sourceText?.includes("divide each by √d_k"), "sqrt sentence");
  assert.match(scaled.sourceText, /weights on the values\./);
  assert.equal(scaled.placeholders?.length || 0, 0);
  assert.equal(scaled.label === "formula", false);

  const factor = one((block) => block.sourceText?.includes("scaling factor of 1/√d_k"), "scaling factor host");
  assert.equal(factor.placeholders.length, 1);
  assert.match(factor.text, /⟦f\d+⟧/);
  const factorCrop = blocks.find((block) => block.id === factor.placeholders[0].blockId);
  assert.equal(factorCrop.display, false);
  assert.equal(factorCrop.inlineOf, factor.id);
  assert.equal(factorCrop.sourceText, "√1dk");

  const counteract = one((block) => block.sourceText?.includes("scale the dot products by 1/√d_k"), "counteract host");
  assert.match(counteract.sourceText, /extremely small gradients/);
  const counteractCrop = blocks.find((block) => block.id === counteract.placeholders[0].blockId);
  assert.equal(counteractCrop.display, false);
  assert.equal(counteractCrop.inlineOf, counteract.id);
  assert.equal(counteractCrop.sourceText, "√1dk");

  const footnote = one((block) => /q · k = .*q_ik_i/.test(block.sourceText || ""), "footnote host");
  assert.match(footnote.text, /⟦f\d+⟧/);
  const footnoteCrop = blocks.find((block) => block.id === footnote.placeholders[0].blockId);
  assert.equal(footnoteCrop.display, false);
  assert.equal(footnoteCrop.inlineOf, footnote.id);
  assert.match(footnoteCrop.sourceText, /Pdi=1k qiki/);

  const equation = one((block) => block.label === "formula" && /softmax/.test(block.sourceText || "") && !block.inlineOf, "equation 1");
  assert.equal(equation.display === false, false);
  assert.match(equation.sourceText, /QK√dkT/);

  for (const host of [factor, counteract, footnote]) {
    const pieces = blockRenderPieces(host, blocks);
    const types = pieces.map((piece) => piece.type);
    assert.equal(types[0], "text");
    assert.ok(types.includes("image"), host.id);
    assert.equal(types.at(-1), "text");
    const joined = pieces.map((piece) => piece.type === "image" ? "⟦IMG⟧" : piece.text).join("");
    assert.match(joined, /⟦IMG⟧/);
    assert.doesNotMatch(joined, /^⟦IMG⟧/);
  }
  assert.equal(blocks.filter((block) => block.label !== "formula" && block.sourceText === "1/√d_k").length, 0);
  assert.equal(blocks.filter((block) => block.label !== "formula" && block.sourceText === "√d_k").length, 0);
});
