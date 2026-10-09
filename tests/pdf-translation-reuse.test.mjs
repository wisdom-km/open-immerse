// Opening a source-v3 layout must reuse source-v2 translations whose normalized
// source text is unchanged. Only blocks whose source actually changed are requested.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { applyBlockTranslations, translatableBlocks } from "../lib/pdf-blocks.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { applySavedPairs, mergeLibraryPairs, pairsFromResults, pairsVerifiedForLibrary, sourceReuseHash } from "../lib/pdf-library.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  applyDraftTranslations,
  createPageCache,
  createTranslateSession,
  docStatusView,
  libraryPageRunState,
  translateDocumentPages,
  translatePageBlocks,
  translatedPageTotal,
  mergeTranslationRows,
  translationsByBid,
  unitsNeedingTranslation
} from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const SETTINGS = { targetLang: "zh-CN", provider: "mymemory" };
const SOURCE_V2 = "797df2f";
const MAIN_V2 = "d06b9fb5ec653524fcaf7bfc4126b275441ca0ab";
const TIP_V3 = "6bfa659";
const WATCH = new Set(["b1-p20-t1ho201s", "b1-p20-t0kcfxuw", "b1-p27-t1dwp43s"]);

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

function translationFor(text) {
  return `旧译${sourceReuseHash(text)}`;
}

function unitsFor(blocks) {
  return translatableBlocks(blocks).map((block) => ({
    id: block.id,
    sourceId: block.sourceId,
    ...(block.bid ? { bid: block.bid } : {}),
    text: block.text,
    sourceText: block.sourceText || block.text,
    original: block.text,
    role: block.label,
    label: block.label
  }));
}

function pairFrom(block, translation) {
  return {
    id: block.id,
    sourceId: block.sourceId,
    ...(block.bid ? { bid: block.bid } : {}),
    text: block.text,
    sourceText: block.sourceText || block.text,
    translation,
    targetLang: SETTINGS.targetLang,
    provider: SETTINGS.provider
  };
}

function pairsFor(blocks) {
  return translatableBlocks(blocks).map((block) => pairFrom(block, translationFor(block.text)));
}

/** An earlier write of the source itself, same bid and sourceId as the real translation. */
function echoedFirst(blocks) {
  const echoes = [];
  for (const block of translatableBlocks(blocks)) {
    if (!WATCH.has(block.bid)) continue;
    echoes.push(pairFrom(block, block.text));
  }
  return [...echoes, ...pairsFor(blocks)];
}

function historicalLayer(commit) {
  const dir = mkdtempSync(join(tmpdir(), "oi-source-v2-"));
  for (const file of readdirSync(join(root, "lib"))) {
    if (!file.endsWith(".js")) continue;
    writeFileSync(join(dir, file), readFileSync(join(root, "lib", file)));
  }
  writeFileSync(
    join(dir, "pdf-text-layer.js"),
    execFileSync("git", ["show", `${commit}:lib/pdf-text-layer.js`], { cwd: root })
  );
  return import(join(dir, "pdf-text-layer.js"));
}

async function loadLayouts(layer) {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(dpoPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pages = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const input = {
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      };
      pages.push({
        page: number,
        next: stampLayoutBids(number, textLayerToBlocks(input)),
        previous: stampLayoutBids(number, layer(input))
      });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

test("a conflicting source hash is not attached to either block", () => {
  const unit = {
    id: "new",
    sourceId: "p9-snew",
    bid: "b1-p9-t010gv1t",
    text: "The experiment compares several policies.",
    sourceText: "The experiment compares several policies."
  };
  const restored = applySavedPairs([unit], [
    { sourceId: "p9-sa", text: unit.text, sourceText: unit.sourceText, translation: "甲", targetLang: "zh-CN", provider: "mymemory" },
    { sourceId: "p9-sb", text: unit.text, sourceText: unit.sourceText, translation: "乙", targetLang: "zh-CN", provider: "mymemory" }
  ], SETTINGS);
  assert.equal(restored[0].translation, "");
  assert.equal(restored[0].bid, unit.bid);
  assert.equal(restored[0].translationStatus, undefined);
});

test("an unchanged source sentence is reused when only formula placeholders moved", () => {
  const unit = {
    id: "live",
    sourceId: "p4-s3",
    bid: "b1-p4-t1ejbcw1",
    text: "Scaled Dot-Product Attention ⟦f1⟧",
    sourceText: "Scaled Dot-Product Attention softmax(QK^T)"
  };
  const restored = applySavedPairs([unit], [{
    sourceId: "p4-s3",
    bid: "b1-p4-told",
    text: "Scaled Dot-Product Attention softmax(QK^T)",
    sourceText: unit.sourceText,
    translation: "缩放点积注意力",
    targetLang: "zh-CN",
    provider: "mymemory"
  }], SETTINGS);
  assert.equal(restored[0].translation, "缩放点积注意力");
  assert.equal(restored[0].bid, unit.bid);
  assert.equal(restored[0].sourceId, unit.sourceId);
});

test("a saved translation for another provider is not reused", () => {
  const unit = { id: "a", sourceId: "p1-s1", text: "Attention is all you need", sourceText: "Attention is all you need" };
  const restored = applySavedPairs([unit], [{
    sourceId: "p1-old",
    text: unit.text,
    sourceText: unit.sourceText,
    translation: "注意力就是你所需要的一切",
    targetLang: "zh-CN",
    provider: "openai"
  }], SETTINGS);
  assert.equal(restored[0].translation, "");
  const same = applySavedPairs([unit], [{
    sourceId: "p1-old",
    bid: "b1-p1-toldone",
    text: unit.text,
    sourceText: unit.sourceText,
    translation: "注意力就是你所需要的一切",
    targetLang: "zh-CN",
    provider: "mymemory"
  }], SETTINGS);
  assert.equal(same[0].translation, "注意力就是你所需要的一切");
  assert.equal(same[0].bid, undefined);
  assert.equal(same[0].sourceId, unit.sourceId);
});

test("a successful retry clears the failed flag on the reused row", () => {
  const prior = [
    { id: "a", text: "kept", translation: "保留", role: "paragraph" },
    { id: "b", text: "retry", translation: "", failed: true, role: "paragraph" }
  ];
  const merged = mergeTranslationRows(prior, [
    { id: "b", text: "retry", translation: "重译", role: "paragraph" }
  ]);
  assert.equal(merged.find((row) => row.id === "a").translation, "保留");
  const retried = merged.find((row) => row.id === "b");
  assert.equal(retried.translation, "重译");
  assert.equal(retried.failed, undefined);
});

test("source reuse hash is 128-bit and an echo does not hide a later translation", () => {
  const hash = sourceReuseHash("def dpo_loss(pi_logps, ref_logps)");
  assert.equal(hash.length, 32);
  assert.equal(sourceReuseHash(""), "");
  assert.notEqual(hash, sourceReuseHash("return losses, rewards"));
  const text = "def dpo_loss(pi_logps, ref_logps, yw_idxs, yl_idxs, beta): preferred indices in [0, B-1]";
  const unit = { id: "code", bid: "b1-p20-t1ho201s", sourceId: "p20-s1", text, sourceText: text };
  const restored = applySavedPairs([unit], [
    { ...unit, translation: text },
    { ...unit, translation: "DPO 损失函数" }
  ], SETTINGS);
  assert.equal(restored[0].translation, "DPO 损失函数");
  assert.equal(unitsNeedingTranslation(restored, SETTINGS.targetLang).length, 0);
  const heading = "D.3 Human study details";
  const head = { id: "h", bid: "b1-p27-t1dwp43s", sourceId: "p27-s1", text: heading, sourceText: heading };
  const headed = applySavedPairs([head], [
    { ...head, translation: heading },
    { ...head, translation: "D.3 人类研究细节" }
  ], SETTINGS);
  assert.equal(headed[0].translation, "D.3 人类研究细节");
  assert.equal(unitsNeedingTranslation(headed, SETTINGS.targetLang).length, 0);
});

test("a legacy translation with no engine is reused only for its target language", () => {
  const unit = {
    id: "a",
    sourceId: "p1-s1",
    text: "Attention is all you need",
    sourceText: "Attention is all you need"
  };
  const legacy = { text: unit.text, sourceText: unit.sourceText, translation: "注意力就是你所需要的一切" };
  assert.equal(applySavedPairs([unit], [legacy], SETTINGS)[0].translation, legacy.translation);
  assert.equal(applySavedPairs([unit], [legacy], { targetLang: "en", provider: "mymemory" })[0].translation, "");
  const recorded = { ...legacy, targetLang: "zh-CN" };
  assert.equal(applySavedPairs([unit], [recorded], SETTINGS)[0].translation, legacy.translation);
});

test("a colliding bid does not keep the first write", () => {
  const text = "return losses, rewards";
  const unit = { id: "live", bid: "b1-p20-t0kcfxuw", sourceId: "p20-s", text, sourceText: text };
  const echoed = applySavedPairs([unit], [
    { ...unit, translation: text },
    { ...unit, translation: "返回损失和奖励" }
  ], SETTINGS);
  assert.equal(echoed[0].translation, "返回损失和奖励");
  const other = {
    bid: unit.bid,
    sourceId: unit.sourceId,
    text: "A different sentence about the same identifier.",
    sourceText: "A different sentence about the same identifier.",
    translation: "另一句",
    targetLang: "zh-CN",
    provider: "mymemory"
  };
  const right = {
    bid: unit.bid,
    sourceId: "p20-s-new",
    text,
    sourceText: text,
    translation: "返回损失和奖励",
    targetLang: "zh-CN",
    provider: "mymemory"
  };
  const restored = applySavedPairs([unit], [other, right], SETTINGS);
  assert.equal(restored[0].translation, "返回损失和奖励");
  assert.notEqual(restored[0].translationStatus, "source-uncertain");
});

test("a partial page applies translations by bid, never by page order", async () => {
  const blocks = [
    { id: "p9-b1", bid: "b1-p9-t0a1v38l", label: "text", text: "Body paragraph that was already translated.", sourceText: "Body paragraph that was already translated." },
    { id: "p9-b2", bid: "b1-p9-t6section", label: "heading", text: "6.3 Generalization", sourceText: "6.3 Generalization" },
    { id: "p9-b3", bid: "b1-p9-tother", label: "text", text: "Another settled paragraph.", sourceText: "Another settled paragraph." }
  ];
  const kept = "正文旧译";
  const other = "另一段旧译";
  const prior = blocks.map((block, index) => ({
    ...block,
    original: block.text,
    role: block.label,
    translation: index === 1 ? "" : (index === 0 ? kept : other)
  }));
  const heading = "6.3 泛化到新的输入分布";
  const shuffled = [
    { bid: "b1-p9-tnot-on-this-page", translation: "不该贴到任何块" },
    { bid: "b1-p9-t6section", translation: heading }
  ];
  const sent = [];
  const cache = createPageCache();
  cache.set(1, 9, prior);
  const session = createTranslateSession();
  const out = await translatePageBlocks([prior[1]], {
    session,
    send: async (message) => {
      sent.push(message);
      session.inflight = { requestId: message.requestId, slice: message.texts, sliceStart: 0, items: message.items };
      const draft = applyDraftTranslations(session, {
        phase: "draft",
        requestId: message.requestId,
        translations: shuffled
      }, prior);
      assert.equal(draft[0].translation, kept);
      assert.equal(draft[2].translation, other);
      assert.equal(draft[1].translation, heading);
      return { ok: true, translations: shuffled };
    }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].items[0].bid, "b1-p9-t6section");
  assert.equal(out.results[0].bid, "b1-p9-t6section");
  assert.equal(out.results[0].translation, heading);
  const merged = mergeTranslationRows(prior, out.results);
  assert.equal(merged[0].translation, kept);
  assert.equal(merged[1].translation, heading);
  assert.equal(merged[2].translation, other);
  const painted = applyBlockTranslations(blocks, merged);
  assert.equal(painted[0].translation, kept);
  assert.equal(painted[1].translation, heading);
  assert.equal(painted.find((block) => block.bid === "b1-p9-t0a1v38l").translation, kept);
  const unordered = applyBlockTranslations(blocks, [{ translation: heading }]);
  assert.equal(unordered[0].translation, undefined);
  assert.equal(unordered[1].translation, undefined);
  const bound = translationsByBid({ translations: shuffled }, sent[0].items);
  assert.equal(bound.get("b1-p9-t6section"), heading);
  assert.equal(bound.has("b1-p9-tnot-on-this-page"), false);
  cache.set(1, 9, merged);
  const again = mergeTranslationRows(cache.get(1, 9), [
    { bid: "b1-p9-t6section", text: blocks[1].text, sourceText: blocks[1].sourceText, translation: "另一句不该覆盖", role: "heading" }
  ]);
  assert.equal(again[1].translation, heading);
  const verified = pairsVerifiedForLibrary(merged, blocks, SETTINGS);
  const stored = mergeLibraryPairs([
    { bid: "b1-p9-t0a1v38l", text: blocks[0].text, sourceText: blocks[0].sourceText, translation: kept, targetLang: "zh-CN" }
  ], verified, blocks);
  assert.equal(stored.find((pair) => pair.bid === "b1-p9-t0a1v38l").translation, kept);
  assert.equal(stored.find((pair) => pair.bid === "b1-p9-t6section").translation, heading);
  assert.equal(stored.some((pair) => pair.translation === "不该贴到任何块"), false);
});

test("opening a document seeds progress before the layout ingest", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const whole = viewer.slice(viewer.indexOf("async function adoptLibraryPages"), viewer.indexOf("function demoteUnpaintedDonePages"));
  const seedAt = whole.indexOf("seedLibraryProgress(");
  const awaitAt = whole.indexOf("await ingestPageLayout");
  assert.ok(seedAt >= 0 && awaitAt > seedAt, "library progress is counted before a page waits on layout");
  assert.match(viewer, /replaceLibraryPagePairs\(libraryDoc, page, pairs\)/);
});

test("source-v2 translations reopen on source-v3 without resending unchanged blocks", { timeout: 240000 }, async () => {
  assert.equal(readFileSync(dpoPath).byteLength > 0, true);
  const prLayer = (await historicalLayer(SOURCE_V2)).textLayerToBlocks;
  const mainLayer = (await historicalLayer(MAIN_V2)).textLayerToBlocks;
  const tipLayer = (await historicalLayer(TIP_V3)).textLayerToBlocks;
  const opened = {};
  for (const [name, layer] of [["source-v2", prLayer], ["main-v2", mainLayer], ["tip-v3", tipLayer]]) {
    const pages = await loadLayouts(layer);
    const cache = createPageCache();
    const states = [];
    const pendingByPage = new Map();
    const seeded = [];
    const seedStarted = performance.now();
    for (const entry of pages) {
      const stored = translatableBlocks(entry.previous.blocks);
      seeded.push({
        state: libraryPageRunState({
          pairs: pairsFor(entry.previous.blocks),
          targetLang: SETTINGS.targetLang,
          provider: SETTINGS.provider,
          skipped: !stored.length
        })
      });
    }
    const seedMs = performance.now() - seedStarted;
    const seededTotals = translatedPageTotal(seeded);
    assert.equal(seededTotals.n, pages.length, `${name} shows ${pages.length}/${pages.length} before layout`);
    assert.ok(seedMs < 100, `${name} reached ${pages.length}/${pages.length} in ${seedMs}ms`);
    for (const entry of pages) {
      const units = unitsFor(entry.next.blocks);
      const pairs = echoedFirst(entry.previous.blocks);
      const filled = applySavedPairs(units, pairs, SETTINGS);
      const state = libraryPageRunState({
        pairs,
        blocks: entry.next.blocks,
        targetLang: SETTINGS.targetLang,
        provider: SETTINGS.provider,
        empty: !translatableBlocks(entry.next.blocks).length
      });
      states.push({ state, page: entry.page });
      cache.set(1, entry.page, filled);
      pendingByPage.set(entry.page, unitsNeedingTranslation(filled, SETTINGS.targetLang));
      for (const unit of filled) {
        const live = units.find((item) => item.id === unit.id);
        assert.equal(unit.bid, live.bid, `${name} p${entry.page} keeps the live bid`);
        if (unit.translation) assert.equal(unit.translation, translationFor(unit.text));
        if (WATCH.has(unit.bid)) {
          assert.equal(unit.translation, translationFor(unit.text), `${name} ${unit.bid} keeps its translation`);
          assert.equal(unitsNeedingTranslation([unit], SETTINGS.targetLang).length, 0, unit.bid);
        }
      }
    }
    const totals = translatedPageTotal(states);
    const progress = docStatusView({ n: seededTotals.n, t: pages.length, needsRetry: 0, phase: "running" });
    assert.equal(totals.n, pages.length, `${name} progress stays ${pages.length}/${pages.length}`);
    assert.equal(seededTotals.needsRetry, 0, `${name} library count is not a retry`);
    assert.match(progress.text, new RegExp(`${pages.length} / ${pages.length}`));
    const unchanged = cache.get(1, 2).find((unit) => unit.translation);
    assert.equal(unchanged.translation, translationFor(unchanged.text));
    const sent = [];
    await translateDocumentPages({
      cache,
      docId: 1,
      numPages: pages.length,
      targetLang: SETTINGS.targetLang,
      batchSize: 8,
      getPageOriginals: async (page) => pendingByPage.get(page) || [],
      send: async (message) => {
        sent.push(message);
        return { ok: true, translations: message.texts.map(() => "新译一块") };
      }
    });
    const requested = sent.reduce((count, message) => count + message.texts.length, 0);
    const changed = [...pendingByPage.values()].reduce((count, units) => count + units.length, 0);
    assert.equal(requested, changed, `${name} requests only changed blocks`);
    assert.equal(requested < 16, true, `${name} sends ${requested}, far below 16`);
    assert.equal(sent.every((message) => message.type === "OI_TRANSLATE_BATCH"), true);
    const kept = cache.get(1, 2).find((unit) => unit.id === unchanged.id);
    assert.equal(kept.translation, unchanged.translation);
    const partialPage = states.find((row) => row.state === "partial");
    if (requested > 0) {
      assert.ok(partialPage, `${name} has a page with a changed block`);
      const mixed = cache.get(1, partialPage.page);
      assert.equal(mixed.some((unit) => String(unit.translation || "").startsWith("旧译")), true);
      assert.equal(mixed.some((unit) => unit.translation === "新译一块"), true);
    } else {
      assert.equal(partialPage, undefined, `${name} is already complete`);
    }
    let second = 0;
    for (const entry of pages) {
      const written = pairsFromResults(cache.get(1, entry.page), SETTINGS);
      const echoes = echoedFirst(entry.previous.blocks).filter((pair) => pair.translation === pair.text);
      const again = applySavedPairs(unitsFor(entry.next.blocks), [...echoes, ...written], SETTINGS);
      second += unitsNeedingTranslation(again, SETTINGS.targetLang).length;
      for (const unit of again) {
        if (!WATCH.has(unit.bid)) continue;
        assert.equal(unit.translation, translationFor(unit.text), `${name} second open ${unit.bid}`);
      }
    }
    assert.equal(second, 0, `${name} second open sends 0 requests`);
    opened[name] = {
      requested,
      seedMs,
      second,
      pages: states.filter((row) => row.state === "partial").map((row) => row.page)
    };
  }
  assert.equal(opened["source-v2"].requested, 2);
  assert.deepEqual(opened["source-v2"].pages, [24, 26]);
  assert.equal(opened["main-v2"].requested, 6);
  assert.deepEqual(opened["main-v2"].pages, [9, 10, 24, 26]);
  assert.equal(opened["tip-v3"].requested, 0);
  assert.deepEqual(opened["tip-v3"].pages, []);
  assert.equal(opened["source-v2"].second, 0);
  assert.equal(opened["main-v2"].second, 0);
  assert.equal(opened["tip-v3"].second, 0);
});
