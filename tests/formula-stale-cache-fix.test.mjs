import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CHAIN_VERSION } from "../lib/formula-contract.js";
import { normalizeArxivPrefs } from "../lib/formula-arxiv-session.js";
import {
  FORMULA_PIPELINE_VERSION,
  PDF_LAYOUT_MODE_MIGRATED,
  PDF_LAYOUT_RESET_COPY,
  STALE_FORMULA_COPY,
  UNKNOWN_FORMULA_PIPELINE,
  applyFormulaVerdict,
  formulaCacheVerdict,
  migrateEngineOverride,
  migrateLocalOcrToMultimodal,
  migrateStoredPdfLayout,
  PDF_LAYOUT_MM_NOTICE,
  oldFormulaPipeline,
  recomputedFormulaSettlement,
  reopenFormulaStale,
  stampFormulaPairs,
  stampReopenFormulaPage
} from "../lib/formula-pipeline.js";
import { diagStateForPage } from "../lib/diag-log.js";
import { cacheableLayout, layoutCacheKey, resolveLayoutMode } from "../lib/pdf-layout-client.js";
import { parseLayoutCacheKey } from "../lib/pdf-layout-cache.js";
import { mergeStoredPagePairs, pairsFromResults, selectPageLayout } from "../lib/pdf-library.js";
import { PDF_COPY, canRetranslateRequestedPage, docStatusView, libraryPageRunState, translatedPageTotal } from "../lib/pdf-viewer.js";

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
  assert.equal(pairsFromResults([{ original: "Attention", translation: "注意力" }])[0].formulaPipeline, UNKNOWN_FORMULA_PIPELINE);
  assert.equal(
    pairsFromResults([{ original: "Attention", translation: "注意力" }], { formulaPipeline: "fp-1" })[0].formulaPipeline,
    "fp-1"
  );
  const stored = cacheableLayout({
    page: 4,
    blocks: [{ id: "a", label: "text", text: "Hi", latex: "x", formulaTier: "ocr" }]
  });
  assert.equal(stored.formulaPipeline, UNKNOWN_FORMULA_PIPELINE);
  assert.equal(cacheableLayout({
    page: 4,
    blocks: [{ id: "a", label: "text", text: "Hi" }],
    formulaPipeline: "fp-1"
  }).formulaPipeline, "fp-1");
  assert.equal(stored.blocks[0].latex, undefined);
  assert.equal(stored.blocks[0].formulaTier, undefined);
});

test("an unstamped library page is not marked done before the text layer is compared", () => {
  assert.equal(formulaCacheVerdict({ pairs: settled, layout: { blocks: [{ label: "text", text: "Attention", sourceText: "Attention" }] } }), "unchecked");
  assert.equal(applyFormulaVerdict("done", "unchecked"), "formula-check");
  assert.equal(applyFormulaVerdict("partial", "unchecked"), "partial");
  assert.equal(libraryPageRunState({ pairs: settled, formulaVerdict: "unchecked" }), "formula-check");
  assert.equal(libraryPageRunState({ pairs: settled }), "done");
  const blocks = [{ label: "text", text: "Attention", sourceText: "Attention" }];
  assert.equal(libraryPageRunState({
    pairs: settled,
    blocks,
    formulaVerdict: "unchecked",
    targetLang: "zh-CN"
  }), "formula-check");
  const hole = [{ text: "Only one sentence.", sourceText: "Only one sentence.", translation: "只有一句", targetLang: "zh-CN" }];
  const live = [
    { label: "text", text: "Only one sentence.", sourceText: "Only one sentence." },
    { label: "text", text: "Another live sentence.", sourceText: "Another live sentence." }
  ];
  assert.equal(libraryPageRunState({
    pairs: hole,
    blocks: live,
    formulaVerdict: "unchecked",
    targetLang: "zh-CN"
  }), "partial");
});

test("a pending formula check still counts toward the open total", () => {
  const totals = translatedPageTotal([
    { state: "formula-check" },
    { state: "stale-formula" },
    { state: "skipped" },
    { state: "done" }
  ]);
  assert.equal(totals.n, 4);
  assert.equal(totals.formulaPending, 2);
  assert.equal(totals.needsRetry, 0);
  assert.equal(docStatusView({
    n: totals.n,
    t: 4,
    formulaPending: totals.formulaPending,
    phase: "opening"
  }).text, "已译 4 / 4 页");
  assert.notEqual(docStatusView({ n: 4, t: 4, formulaPending: 2, phase: "idle" }).text, "全文已译");
  assert.equal(docStatusView({ n: 4, t: 4, phase: "idle" }).text, "全文已译");
  const oldPairs = stampFormulaPairs(settled, "fp-0");
  assert.equal(oldFormulaPipeline({ pairs: oldPairs, layout: { formulaPipeline: "fp-0" } }), true);
  assert.equal(oldFormulaPipeline({ pairs: stampFormulaPairs(settled), layout: { formulaPipeline: "fp-1" } }), false);
  assert.equal(oldFormulaPipeline({ pairs: [{ translation: "注意力" }], layout: { formulaPipeline: "unknown" } }), false);
  assert.match(viewer, /if \(oldFormulaPipeline\(\{ pairs, layout \}\)\) return "stale"/);
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

test("a stamp without a fresh text layer does not clear the old-page mark", () => {
  const fresh = [{ label: "text", text: "Attention", sourceText: "Attention" }];
  const stamped = stampFormulaPairs(settled);
  assert.equal(formulaCacheVerdict({
    pairs: stamped,
    layout: { blocks: fresh, formulaPipeline: "fp-1" }
  }), "unchecked");
  assert.equal(applyFormulaVerdict("done", "unchecked"), "formula-check");
  const legacy = cacheableLayout({ page: 4, blocks: fresh });
  const legacyPairs = pairsFromResults([{ original: "Attention", translation: "注意力" }]);
  assert.equal(legacy.formulaPipeline, UNKNOWN_FORMULA_PIPELINE);
  assert.equal(legacyPairs[0].formulaPipeline, UNKNOWN_FORMULA_PIPELINE);
  assert.equal(formulaCacheVerdict({ pairs: legacyPairs, layout: legacy }), "unchecked");
  assert.equal(formulaCacheVerdict({
    pairs: stamped,
    layout: { blocks: fresh, formulaPipeline: "fp-1" },
    freshBlocks: fresh
  }), "current");
  const split = {
    blocks: [
      { label: "text", text: "scaling factor of", sourceText: "scaling factor of" },
      { label: "formula", text: "1/√d_k", sourceText: "1/√d_k" }
    ],
    formulaPipeline: "fp-1"
  };
  assert.equal(formulaCacheVerdict({
    pairs: stamped,
    layout: split,
    freshBlocks: fresh
  }), "stale");
});

test("saved local-ocr without a cloud key or an explicit choice resets once", () => {
  const reset = migrateStoredPdfLayout({ pdfLayout: { mode: "local-ocr", cloudApiKey: "" } });
  assert.equal(reset.reset, true);
  assert.equal(reset.changed, true);
  assert.equal(reset.settings.pdfLayout.mode, "");
  assert.equal(reset.settings.pdfLayoutResetNotice, true);
  assert.equal(reset.settings.pdfLayoutModeMigrated, PDF_LAYOUT_MODE_MIGRATED);
  const again = migrateStoredPdfLayout({
    ...reset.settings,
    pdfLayout: { ...reset.settings.pdfLayout, mode: "local-ocr", explicit: true }
  });
  assert.equal(again.changed, false);
  assert.equal(again.settings.pdfLayout.mode, "local-ocr");
  const explicit = migrateStoredPdfLayout({ pdfLayout: { mode: "local-ocr", explicit: true } });
  assert.equal(explicit.reset, false);
  assert.equal(explicit.settings.pdfLayout.mode, "local-ocr");
  assert.equal(explicit.settings.pdfLayoutResetNotice, undefined);
  const cloud = migrateStoredPdfLayout({ pdfLayout: { mode: "local-ocr", cloudApiKey: "cloud-key" } });
  assert.equal(cloud.reset, false);
  assert.equal(cloud.settings.pdfLayout.mode, "local-ocr");
  const text = migrateStoredPdfLayout({ pdfLayout: { mode: "" } });
  assert.equal(text.reset, false);
  assert.equal(text.settings.pdfLayout.mode, "");
  assert.equal(text.settings.pdfLayoutResetNotice, undefined);
  assert.equal(PDF_LAYOUT_RESET_COPY, "已改回默认的多模态重建，可在此重新选择本机 OCR");
  const optionsHtml = readFileSync(join(root, "options/options.html"), "utf8");
  const modeRow = optionsHtml.slice(optionsHtml.indexOf('id="pdfLayoutMode"') - 400, optionsHtml.indexOf('id="pdfLayoutMode"'));
  assert.match(modeRow, /id="pdfLayoutResetNote"/);
  assert.match(optionsHtml, new RegExp(PDF_LAYOUT_RESET_COPY));
  const optionsJs = readFileSync(join(root, "options/options.js"), "utf8");
  assert.match(optionsJs, /paintPdfLayoutResetNote/);
  assert.match(optionsJs, /pdfLayoutResetNotice: false/);
  assert.match(optionsJs, /mode === "local-ocr" \|\| previous\.explicit === true/);
});

test("saved local-ocr moves to the multimodal default once", () => {
  const first = migrateLocalOcrToMultimodal({
    pdfLayout: { mode: "local-ocr", explicit: true, cloudApiKey: "kept" }
  });
  assert.equal(first.reset, true);
  assert.equal(first.changed, true);
  assert.equal(first.settings.pdfLayout.mode, "");
  assert.equal(first.settings.pdfLayout.cloudApiKey, "kept");
  assert.equal(first.settings.pdfLayoutMmNotice, true);
  assert.equal(first.settings.pdfLayoutMmMigrated, "mp-1");
  assert.equal(PDF_LAYOUT_MM_NOTICE, "版面识别已切到多模态，可在设置改回本机 OCR");
  const cloud = migrateLocalOcrToMultimodal({ pdfLayout: { mode: "cloud-ocr" } });
  assert.equal(cloud.reset, false);
  assert.equal(cloud.settings.pdfLayout.mode, "cloud-ocr");
  const text = migrateLocalOcrToMultimodal({ pdfLayout: { mode: "text-layer" } });
  assert.equal(text.reset, false);
  assert.equal(text.settings.pdfLayout.mode, "text-layer");
  const again = migrateLocalOcrToMultimodal({
    ...first.settings,
    pdfLayoutMmNotice: false,
    pdfLayout: { ...first.settings.pdfLayout, mode: "local-ocr", explicit: true }
  });
  assert.equal(again.changed, false);
  assert.equal(again.reset, false);
  assert.equal(again.settings.pdfLayout.mode, "local-ocr");
  const optionsHtml = readFileSync(join(root, "options/options.html"), "utf8");
  const optionsJs = readFileSync(join(root, "options/options.js"), "utf8");
  const viewerJs = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(optionsHtml, /id="pdfLayoutMmNote"/);
  assert.match(optionsHtml, /id="pdfLayoutMmRevert"/);
  assert.match(optionsHtml, /aria-label="关闭提示"/);
  assert.equal(optionsHtml.includes('value="mm-page"'), false);
  assert.match(optionsJs, /paintPdfLayoutMmNote/);
  assert.match(optionsJs, /pdfLayoutMmNotice: false/);
  assert.match(optionsJs, /select\.value = "local-ocr"/);
  assert.equal(viewerJs.includes(PDF_LAYOUT_MM_NOTICE), false);
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
  assert.equal(resolveLayoutMode(null, ""), "mm-page");
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
  const force = viewer.slice(viewer.indexOf("async function forceRetranslateCurrentPage"), viewer.indexOf("async function forceRetranslateCurrentPage") + 1600);
  const pending = force.indexOf("forceRetranslatePending = false");
  const ingest = force.indexOf("ingestTextLayerLayout(page, () => false)");
  const source = force.indexOf("const sourceLayout = getPageLayout(page)");
  assert.ok(pending >= 0 && pending < ingest && ingest < source);
  assert.match(force, /formulaState === "stale-formula" \|\| formulaState === "formula-check"/);
  const slot = viewer.slice(viewer.indexOf('if (spec.kind === "stale-formula")'), viewer.indexOf("if (spec.chip?.retry)"));
  assert.match(slot, /forceRetranslateCurrentPage\(page\)/);
  const originals = viewer.slice(viewer.indexOf("getPageOriginals: async (page) => {"), viewer.indexOf("pageSkipReason:"));
  const resegment = originals.indexOf("ingestTextLayerLayout(page,");
  const send = originals.indexOf("originalsForPage");
  assert.ok(resegment >= 0 && resegment < send);
  assert.match(originals, /prior === "stale-formula" \|\| prior === "formula-check"/);
  assert.match(originals, /if \(!laid\?\.blocks\?\.length\) return \[\]/);
  const rush = originals.indexOf("const rush = page === rushArmed");
  const rushGate = originals.indexOf("forceAll === true || rush");
  assert.ok(rush >= 0 && rush < rushGate && rushGate < resegment && resegment < send);
  const prep = viewer.slice(viewer.indexOf("const prepareLibraryPage"), viewer.indexOf("let translatedDoc = await translateDocumentPages"));
  assert.match(prep, /state === "stale-formula" \|\| oldFormulaPipeline/);
  assert.match(prep, /return "retry"/);
  assert.match(prep, /state === "formula-check"/);
  const skip = viewer.slice(viewer.indexOf("onPageSkip({ page, reason })"), viewer.indexOf("onPageStart({ page, total: pageTotal })"));
  assert.match(skip, /prior\?\.state === "stale-formula"/);
});

test("a rushed old-formula page is recut before it is translated", () => {
  const originals = viewer.slice(viewer.indexOf("getPageOriginals: async (page) => {"), viewer.indexOf("pageSkipReason:"));
  const rush = originals.indexOf("const rush = page === rushArmed");
  const gate = originals.indexOf('if (options?.forceAll === true || rush || prior === "stale-formula" || oldCut)');
  const prior = originals.indexOf('prior === "stale-formula" || prior === "formula-check"');
  const ingest = originals.indexOf("ingestTextLayerLayout(page,");
  const hold = originals.indexOf("if (!laid?.blocks?.length) return []");
  const send = originals.indexOf("await originalsForPage");
  assert.ok(rush >= 0 && rush < gate && gate < prior && prior < ingest && ingest < hold && hold < send);
  assert.match(originals, /force: options\?\.forceAll === true \|\| rush/);
});

test("a finished single-page recompute stamps fp-1 and drops the old-formula label", () => {
  const layout = { formulaPipeline: "fp-0", blocks: [{ label: "text", sourceText: "Attention" }] };
  const pairs = stampFormulaPairs(
    [{ text: "Attention", sourceText: "Attention", translation: "注意力" }],
    "fp-0"
  );
  assert.equal(oldFormulaPipeline({ pairs, layout }), true);
  const settled = recomputedFormulaSettlement({ layout, pairs, state: "stale-formula" });
  assert.equal(settled.layout.formulaPipeline, FORMULA_PIPELINE_VERSION);
  assert.equal(settled.pairs[0].formulaPipeline, FORMULA_PIPELINE_VERSION);
  assert.equal(settled.state, "done");
  assert.equal(oldFormulaPipeline({ pairs: settled.pairs, layout: settled.layout }), false);
  assert.equal(recomputedFormulaSettlement({ layout, pairs, state: "partial" }).state, "partial");
  const success = viewer.slice(
    viewer.indexOf('if (outcome !== "success")'),
    viewer.indexOf("PDF_COPY.retranslateDone")
  );
  const settleAt = success.indexOf("recomputedFormulaSettlement");
  const stampAt = success.indexOf("formulaClassifyGen += 1");
  const stateAt = success.indexOf("state: settled.state");
  assert.ok(settleAt >= 0 && settleAt < stampAt && stampAt < stateAt);
  assert.match(success, /liveLayout\.formulaPipeline = FORMULA_PIPELINE_VERSION/);
  assert.match(success, /commitRecomputedFormulaPage\(targetPage, liveLayout, pairs\)/);
});

test("reopen after a single-page recompute does not see fp-0 on any mode or pair", () => {
  const pairs = [
    { bid: "a", text: "Attention", sourceText: "Attention", translation: "注意力", formulaPipeline: "fp-0" },
    { bid: "b", text: "Other", sourceText: "Other", translation: "其他", formulaPipeline: "fp-0" }
  ];
  const blocks = pairs.map((pair) => ({ bid: pair.bid, label: "text", sourceText: pair.text, text: pair.text }));
  const layouts = [
    { page: 5, mode: "text-layer", protocol: "blocks-1", layout: { formulaPipeline: "fp-1", mode: "text-layer", protocol: "blocks-1", blocks } },
    { page: 5, mode: "unknown", protocol: "blocks-1", layout: { formulaPipeline: "fp-0", mode: "unknown", protocol: "blocks-1", blocks } }
  ];
  assert.equal(reopenFormulaStale({ pairs, layouts }), true);
  const kept = mergeStoredPagePairs(pairs, [
    { ...pairs[0], translation: "注意力机制", formulaPipeline: FORMULA_PIPELINE_VERSION }
  ], blocks, "zh-CN");
  assert.equal(kept.find((pair) => pair.bid === "b").formulaPipeline, "fp-0");
  const merged = mergeStoredPagePairs(pairs, [
    { ...pairs[0], translation: "注意力机制", formulaPipeline: FORMULA_PIPELINE_VERSION }
  ], blocks, "zh-CN", { stampFormulaPipeline: FORMULA_PIPELINE_VERSION });
  assert.ok(merged.every((pair) => pair.formulaPipeline === FORMULA_PIPELINE_VERSION));
  const stamped = stampReopenFormulaPage({ pairs: merged, layouts });
  assert.equal(reopenFormulaStale(stamped), false);
  for (const engine of ["text-layer", "local-ocr", "unknown"]) {
    const selected = selectPageLayout(stamped.layouts, 5, engine);
    assert.equal(selected.formulaPipeline, FORMULA_PIPELINE_VERSION);
    assert.equal(oldFormulaPipeline({ pairs: stamped.pairs, layout: selected }), false);
  }
  assert.match(viewer, /stampFormulaPipeline: FORMULA_PIPELINE_VERSION/);
  assert.match(viewer, /row\.layout = \{ \.\.\.row\.layout, formulaPipeline: FORMULA_PIPELINE_VERSION \}/);
});

test("an explicit page is retranslated only when that page can, and an old formula mark still can", () => {
  assert.equal(canRetranslateRequestedPage({ state: "queued", translatableCount: 0, originals: 0 }), false);
  assert.equal(canRetranslateRequestedPage({ state: "empty", translatableCount: 0, originals: 0 }), false);
  assert.equal(canRetranslateRequestedPage({ state: "skipped", translatableCount: 0, originals: 0 }), false);
  assert.equal(canRetranslateRequestedPage({ state: "done", translatableCount: 0, originals: 0 }), false);
  assert.equal(canRetranslateRequestedPage({ state: "queued", translatableCount: 2, originals: 0 }), true);
  assert.equal(canRetranslateRequestedPage({ state: "stale-formula", translatableCount: 0, originals: 0 }), true);
  assert.equal(canRetranslateRequestedPage({ state: "formula-check", translatableCount: 0, originals: 0 }), true);
  const force = viewer.slice(viewer.indexOf("async function forceRetranslateCurrentPage"), viewer.indexOf("async function forceRetranslateCurrentPage") + 1800);
  assert.match(force, /canRetranslate: retranslateOpenFor\(page\)/);
  assert.equal(force.includes("explicit ||"), false);
  const open = viewer.slice(viewer.indexOf("function retranslateOpenFor"), viewer.indexOf("function retranslatePageOpen"));
  assert.match(open, /canRetranslateRequestedPage\(/);
});
