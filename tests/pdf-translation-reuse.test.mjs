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
import { translatableBlocks } from "../lib/pdf-blocks.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { applySavedPairs, sourceReuseHash } from "../lib/pdf-library.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import {
  createPageCache,
  docStatusView,
  libraryPageRunState,
  translateDocumentPages,
  translatedPageTotal,
  mergeTranslationRows,
  unitsNeedingTranslation
} from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const SETTINGS = { targetLang: "zh-CN", provider: "mymemory" };
const SOURCE_V2 = "797df2f";
const MAIN_V2 = "d06b9fb5ec653524fcaf7bfc4126b275441ca0ab";

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

function pairsFor(blocks) {
  return translatableBlocks(blocks).map((block) => ({
    id: block.id,
    sourceId: block.sourceId,
    ...(block.bid ? { bid: block.bid } : {}),
    text: block.text,
    sourceText: block.sourceText || block.text,
    translation: translationFor(block.text),
    targetLang: SETTINGS.targetLang,
    provider: SETTINGS.provider
  }));
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

test("source-v2 translations reopen on source-v3 without resending unchanged blocks", { timeout: 180000 }, async () => {
  assert.equal(readFileSync(dpoPath).byteLength > 0, true);
  const prLayer = (await historicalLayer(SOURCE_V2)).textLayerToBlocks;
  const mainLayer = (await historicalLayer(MAIN_V2)).textLayerToBlocks;
  const opened = {};
  for (const [name, layer] of [["source-v2", prLayer], ["main-v2", mainLayer]]) {
    const pages = await loadLayouts(layer);
    const cache = createPageCache();
    const states = [];
    const pendingByPage = new Map();
    for (const entry of pages) {
      const units = unitsFor(entry.next.blocks);
      const pairs = pairsFor(entry.previous.blocks);
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
      }
    }
    const totals = translatedPageTotal(states);
    const progress = docStatusView({ n: totals.n, t: pages.length, needsRetry: totals.needsRetry, phase: "idle" });
    assert.equal(totals.n, pages.length, `${name} progress stays ${pages.length}/${pages.length}`);
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
    assert.ok(partialPage, `${name} has a page with a changed block`);
    const mixed = cache.get(1, partialPage.page);
    assert.equal(mixed.some((unit) => String(unit.translation || "").startsWith("旧译")), true);
    assert.equal(mixed.some((unit) => unit.translation === "新译一块"), true);
    opened[name] = { requested, pages: states.filter((row) => row.state === "partial").map((row) => row.page) };
  }
  assert.equal(opened["source-v2"].requested, 2);
  assert.deepEqual(opened["source-v2"].pages, [24, 26]);
  assert.equal(opened["main-v2"].requested, 6);
  assert.deepEqual(opened["main-v2"].pages, [9, 10, 24, 26]);
});
