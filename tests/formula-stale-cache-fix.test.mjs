import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CHAIN_VERSION } from "../lib/formula-contract.js";
import { normalizeArxivPrefs } from "../lib/formula-arxiv-session.js";
import {
  FORMULA_PIPELINE_VERSION,
  STALE_FORMULA_COPY,
  applyFormulaVerdict,
  formulaCacheVerdict,
  migrateEngineOverride,
  stampFormulaPairs
} from "../lib/formula-pipeline.js";
import { diagStateForPage } from "../lib/diag-log.js";
import { cacheableLayout, layoutCacheKey, resolveLayoutMode } from "../lib/pdf-layout-client.js";
import { parseLayoutCacheKey } from "../lib/pdf-layout-cache.js";
import { pairsFromResults } from "../lib/pdf-library.js";
import { PDF_COPY, libraryPageRunState } from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");

const settled = [{ text: "Attention", sourceText: "Attention", translation: "注意力", role: "paragraph" }];

test("fp-1 is on the layout key and each translation; chainVersion stays f3-1", () => {
  assert.equal(FORMULA_PIPELINE_VERSION, "fp-1");
  assert.equal(CHAIN_VERSION, "f3-1");
  assert.equal(
    layoutCacheKey({ hash: "abc", page: 4, mode: "text-layer" }),
    "oi-pdf-layout:abc:4:text-layer:blocks-1:source-v3:fp-1"
  );
  const legacy = parseLayoutCacheKey("oi-pdf-layout:abc:4:text-layer:blocks-1:source-v3");
  assert.equal(legacy.pipeline, "");
  assert.equal(legacy.docHash, "abc");
  assert.equal(parseLayoutCacheKey(layoutCacheKey({ hash: "abc", page: 4, mode: "text-layer" })).pipeline, "fp-1");
  assert.equal(parseLayoutCacheKey("oi-pdf-layout:abc:4:text-layer:blocks-1:source-v2"), null);
  assert.equal(pairsFromResults([{ original: "Attention", translation: "注意力" }])[0].formulaPipeline, "fp-1");
  const stored = cacheableLayout({
    page: 4,
    blocks: [{ id: "a", label: "text", text: "Hi", latex: "x", formulaTier: "ocr" }]
  });
  assert.equal(stored.formulaPipeline, "fp-1");
  assert.equal(stored.blocks[0].latex, undefined);
  assert.equal(stored.blocks[0].formulaTier, undefined);
});

test("an unstamped library page is not marked done before the text layer is compared", () => {
  assert.equal(formulaCacheVerdict({ pairs: settled, layout: { blocks: [{ label: "text", text: "Attention", sourceText: "Attention" }] } }), "unchecked");
  assert.equal(applyFormulaVerdict("done", "unchecked"), "formula-check");
  assert.equal(applyFormulaVerdict("partial", "unchecked"), "formula-check");
  assert.equal(libraryPageRunState({ pairs: settled, formulaVerdict: "unchecked" }), "formula-check");
  assert.equal(libraryPageRunState({ pairs: settled }), "done");
  const blocks = [{ label: "text", text: "Attention", sourceText: "Attention" }];
  assert.equal(libraryPageRunState({
    pairs: settled,
    blocks,
    formulaVerdict: "unchecked",
    targetLang: "zh-CN"
  }), "formula-check");
});

test("only a block mismatch is stale; a matching page can be stamped", () => {
  const fresh = [{ label: "text", text: "scaling factor of 1/√d_k", sourceText: "scaling factor of 1/√d_k" }];
  const split = {
    blocks: [
      { label: "text", text: "scaling factor of", sourceText: "scaling factor of" },
      { label: "formula", text: "1/√d_k", sourceText: "1/√d_k" },
      { label: "text", text: "weights", sourceText: "weights" }
    ]
  };
  assert.equal(formulaCacheVerdict({ pairs: settled, layout: split, freshBlocks: fresh }), "stale");
  assert.equal(applyFormulaVerdict("done", "stale"), "stale-formula");
  assert.equal(applyFormulaVerdict("skipped", "stale"), "skipped");
  assert.equal(applyFormulaVerdict("empty", "stale"), "empty");
  assert.equal(formulaCacheVerdict({
    pairs: stampFormulaPairs(settled),
    layout: { blocks: fresh, formulaPipeline: "fp-1" },
    freshBlocks: fresh
  }), "current");
  assert.equal(formulaCacheVerdict({ pairs: settled, layout: { blocks: fresh }, freshBlocks: fresh }), "compatible");
  assert.equal(applyFormulaVerdict("done", "compatible"), "done");
  assert.equal(formulaCacheVerdict({
    pairs: stampFormulaPairs(settled, "fp-0"),
    layout: { blocks: fresh, formulaPipeline: "fp-0" },
    freshBlocks: fresh,
    pipeline: "fp-1"
  }), "compatible");
});

test("pairs compared without a stored layout ignore inline formula crops", () => {
  const pairs = [{
    text: "scale the dot products by 1/√d_k",
    sourceText: "scale the dot products by 1/√d_k",
    translation: "按比例缩放"
  }];
  const fresh = [
    { label: "text", sourceText: "scale the dot products by 1/√d_k" },
    { label: "formula", sourceText: "√1dk", display: false, inlineOf: "host" }
  ];
  assert.equal(formulaCacheVerdict({ pairs, freshBlocks: fresh }), "compatible");
  const changed = [{ label: "text", sourceText: "scale the dot products by something else" }];
  assert.equal(formulaCacheVerdict({ pairs, freshBlocks: changed }), "stale");
});

test("a leftover engine override is dropped; settings local-ocr and arXiv opt-in stay", () => {
  assert.deepEqual(migrateEngineOverride({ override: "local-ocr", explicit: false }), {
    override: "",
    migrated: true,
    reason: "leftover"
  });
  assert.equal(migrateEngineOverride({ override: "local-ocr", explicit: true }).override, "local-ocr");
  assert.equal(migrateEngineOverride({ override: "", explicit: false }).migrated, false);
  assert.equal(resolveLayoutMode({ mode: "local-ocr" }, ""), "local-ocr");
  assert.equal(resolveLayoutMode(null, ""), "text-layer");
  assert.equal(normalizeArxivPrefs(null).auto, false);
  assert.equal(normalizeArxivPrefs({ auto: true }).auto, true);
});

test("diagnostics tell a cached page from a fresh translation", () => {
  assert.equal(STALE_FORMULA_COPY, "这页译文来自旧的公式识别");
  assert.equal(PDF_COPY.staleFormula, STALE_FORMULA_COPY);
  assert.equal(diagStateForPage("done", { fromCache: true }), "cached");
  assert.equal(diagStateForPage("partial", { fromCache: true }), "cached");
  assert.equal(diagStateForPage("done"), "translated");
  assert.equal(diagStateForPage("stale-formula"), "stale-formula");
  assert.equal(diagStateForPage("formula-check"), "formula-check");
  assert.equal(diagStateForPage("cleared"), "cleared");
  const seed = viewer.slice(viewer.indexOf("function seedLibraryProgress"), viewer.indexOf("async function seedLegacySkipPages"));
  assert.match(seed, /formulaVerdict: formulaVerdictFor/);
  assert.match(seed, /formulaStatePatch/);
  const force = viewer.slice(viewer.indexOf("async function forceRetranslateCurrentPage"), viewer.indexOf("async function forceRetranslateCurrentPage") + 1200);
  const pending = force.indexOf("forceRetranslatePending = false");
  const ingest = force.indexOf("ingestTextLayerLayout(capsulePage()");
  const source = force.indexOf("const sourceLayout = getPageLayout(capsulePage())");
  assert.ok(pending >= 0 && pending < ingest && ingest < source);
  const prep = viewer.slice(viewer.indexOf("const prepareLibraryPage"), viewer.indexOf("let translatedDoc = await translateDocumentPages"));
  assert.match(prep, /state === "stale-formula"/);
  assert.match(prep, /state === "formula-check"/);
  const skip = viewer.slice(viewer.indexOf("onPageSkip({ page, reason })"), viewer.indexOf("onPageStart({ page, total: pageTotal })"));
  assert.match(skip, /prior\?\.state === "stale-formula"/);
});
