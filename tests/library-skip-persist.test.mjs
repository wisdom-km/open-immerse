import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { countPageOutcomes } from "../lib/library-record.js";
import { libraryProgressCopy } from "../lib/library-copy.js";
import { mergeStoredPagePairs, saveLibraryPage } from "../lib/pdf-library.js";
import { createLibraryStore } from "../lib/library-store.js";
import { createIdbLibraryFactory } from "../lib/platform/idb-backend.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { docStatusView, persistedSkipRunState } from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function storeFor(name) {
  const factory = createIdbLibraryFactory();
  return createLibraryStore({
    platform: { target: "memory", kv: createMemoryKv(), library: factory },
    deviceId: name,
    now: () => Date.UTC(2026, 9, 27, 8),
    persist: false,
    dbName: `oi-${name}-library`,
    mergePairs: (existing, incoming, blocks, lang, page) => mergeStoredPagePairs(existing, incoming, blocks, lang, page)
  });
}

test("empty and skipped pages persist so the library count matches the toolbar", async () => {
  assert.equal(persistedSkipRunState({ reason: "empty", state: "empty" }), "empty");
  assert.equal(persistedSkipRunState({ reason: "skip-only", state: "skipped" }), "skipped");
  assert.equal(persistedSkipRunState({ reason: "cached", state: "skipped" }), "skipped");
  assert.equal(persistedSkipRunState({ reason: "cached", state: "held" }), "held");
  assert.equal(persistedSkipRunState({ reason: "cached", state: "done" }), "");
  assert.equal(persistedSkipRunState({ reason: "empty", state: "empty", blocking: "failed" }), "");
  assert.equal(persistedSkipRunState({ reason: "cached", state: "skipped", blocking: "partial" }), "");
  assert.equal(persistedSkipRunState({ reason: "unavailable", state: "failed" }), "");

  const store = storeFor("skip-full");
  const hash = "b".repeat(64);
  const pageCount = 15;
  for (let page = 1; page <= pageCount; page += 1) {
    const bibliography = page === 11 || page === 12;
    const reason = page === 11 ? "empty" : "skip-only";
    const state = page === 11 ? "empty" : "skipped";
    const runState = bibliography ? persistedSkipRunState({ reason, state }) : "done";
    await saveLibraryPage({
      hash,
      pageCount,
      page,
      title: page === 1 ? "Attention" : undefined,
      fileName: "attention.pdf",
      pairs: bibliography ? [] : [{ text: `Page ${page} source`, translation: "译文", bid: `p${page}`, targetLang: "zh-CN" }],
      targetLang: "zh-CN",
      ...(bibliography ? { skipped: runState === "skipped" } : {}),
      runState
    }, { store });
  }
  const stored = await store.getPages(hash);
  const outcome = countPageOutcomes(stored);
  assert.equal(stored.length, pageCount);
  assert.equal(outcome.translated, pageCount);
  assert.equal(outcome.incomplete, 0);
  assert.equal(libraryProgressCopy(outcome.translated, pageCount), "全文已译");
  assert.equal(docStatusView({ n: pageCount, t: pageCount, needsRetry: 0, phase: "idle" }).text, "全文已译");

  const listed = await store.listPapers();
  assert.equal(listed[0].pagesTranslated, pageCount);
  assert.equal(listed[0].pagesIncomplete, 0);

  await saveLibraryPage({
    hash,
    pageCount,
    page: 4,
    pairs: [{ text: "Page 4 source", translation: "译文", bid: "p4", targetLang: "zh-CN" }],
    targetLang: "zh-CN",
    runState: "failed"
  }, { store });
  const failed = countPageOutcomes(await store.getPages(hash));
  assert.equal(failed.translated, pageCount - 1);
  assert.equal(failed.incomplete, 1);
  assert.notEqual(libraryProgressCopy(failed.translated, pageCount, { incomplete: failed.incomplete }), "全文已译");
  assert.notEqual(docStatusView({ n: failed.translated, t: pageCount, needsRetry: 1, phase: "idle" }).text, "全文已译");

  await saveLibraryPage({
    hash,
    pageCount,
    page: 5,
    pairs: [{ text: "Page 5 source", translation: "半页", bid: "p5", targetLang: "zh-CN" }],
    targetLang: "zh-CN",
    runState: "partial"
  }, { store });
  const partial = countPageOutcomes(await store.getPages(hash));
  assert.equal(partial.translated, pageCount - 2);
  assert.equal(partial.incomplete, 2);
  assert.notEqual(libraryProgressCopy(partial.translated, pageCount, { incomplete: partial.incomplete }), "全文已译");
});

test("the viewer stores empty and cached skips instead of only updating memory", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const skip = viewer.slice(viewer.indexOf("onPageSkip({ page, reason })"), viewer.indexOf("onPageStart({ page, total: pageTotal })"));
  assert.match(skip, /noteCountedSkip\(page, "cached"/);
  assert.match(skip, /noteCountedSkip\(page, "skip-only", "skipped"/);
  assert.match(skip, /noteCountedSkip\(page, "empty", "skipped"/);
  assert.match(skip, /noteCountedSkip\(page, "empty", settled\.state/);
  const helper = viewer.slice(viewer.indexOf("const noteCountedSkip"), viewer.indexOf("const sentSource = new Map()"));
  assert.match(helper, /persistedSkipRunState/);
  assert.match(helper, /rememberTranslation\(page, \[\], \{ runState \}/);
  const remember = viewer.slice(viewer.indexOf("function rememberTranslation"), viewer.indexOf("function persistPageRun"));
  assert.match(remember, /failed\|partial\|done\|empty\|skipped\|held/);
  assert.match(remember, /blocking && forced && forced !== "failed" && forced !== "partial"/);
});
