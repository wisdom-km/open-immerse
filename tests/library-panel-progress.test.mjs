import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { countPageOutcomes } from "../lib/library-record.js";
import { libraryProgressCopy } from "../lib/library-copy.js";
import { mergeStoredPagePairs, saveLibraryPage } from "../lib/pdf-library.js";
import { createLibraryStore } from "../lib/library-store.js";
import { createIdbLibraryFactory } from "../lib/platform/idb-backend.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { mountLibraryUi } from "../pdf/library-panel.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function panelDom() {
  return parseHTML("<!doctype html><button id='libraryButton'>文献库</button><div id='sideSlot'></div>");
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("library panel load passes incomplete pages into the row progress", async () => {
  const pages = [
    { page: 1, runState: "done", pairs: [{ translation: "甲" }] },
    { page: 2, runState: "partial", pairs: [{ translation: "乙" }] },
    { page: 3, runState: "failed" }
  ];
  const outcome = countPageOutcomes(pages);
  assert.equal(outcome.translated, 1);
  assert.equal(outcome.incomplete, 2);
  assert.equal(libraryProgressCopy(outcome.translated, 3, { incomplete: outcome.incomplete }), "已译 1/3 · 有页没译完");

  const { document } = panelDom();
  const papers = [
    {
      docHash: "mixed",
      title: "没译完",
      fileName: "mixed.pdf",
      pageCount: 3,
      lastOpenedAt: Date.UTC(2026, 9, 19, 8),
      sourceSize: 1200,
      sourceUrl: ""
    },
    {
      docHash: "full",
      title: "译完了",
      fileName: "full.pdf",
      pageCount: 1,
      lastOpenedAt: Date.UTC(2026, 9, 19, 7),
      sourceSize: 800,
      sourceUrl: ""
    }
  ];
  const stored = {
    mixed: pages,
    full: [{ page: 1, runState: "done", pairs: [{ translation: "全文" }] }]
  };
  const ui = mountLibraryUi({
    slot: document.getElementById("sideSlot"),
    skeletonMs: 60_000,
    now: () => Date.UTC(2026, 9, 19, 12),
    store: async () => ({
      async listPapers() { return papers; },
      async getPages(hash) { return stored[hash] || []; },
      async usage() { return { byDoc: new Map(papers.map((row) => [row.docHash, row.sourceSize])) }; }
    }),
    listNotes: async () => [],
    openHash: async () => ""
  });
  ui.open();
  await flush();
  const mixed = ui.root.querySelector('[data-lib-row="mixed"] .oi-lib-meta').textContent;
  const full = ui.root.querySelector('[data-lib-row="full"] .oi-lib-meta').textContent;
  assert.match(mixed, /已译 1\/3 · 有页没译完/);
  assert.equal(mixed.includes("全文已译"), false);
  assert.match(full, /全文已译/);
  assert.equal(full.includes("有页没译完"), false);
});

test("a failed page written through the library store reloads as 有页没译完", async () => {
  const factory = createIdbLibraryFactory();
  const store = createLibraryStore({
    platform: { target: "memory", kv: createMemoryKv(), library: factory },
    deviceId: "rt11",
    now: () => Date.UTC(2026, 9, 26, 12),
    persist: false,
    dbName: "oi-rt11-library",
    mergePairs: (existing, incoming, blocks, lang, page) => mergeStoredPagePairs(existing, incoming, blocks, lang, page)
  });
  const hash = "a".repeat(64);
  const pair = (text, translation) => ({ text, translation, bid: text.slice(0, 12), targetLang: "zh-CN" });
  await saveLibraryPage({
    hash,
    pageCount: 2,
    page: 1,
    title: "Attention",
    fileName: "attention.pdf",
    pairs: [pair("Hello page", "你好")],
    targetLang: "zh-CN",
    runState: "done"
  }, { store });
  await saveLibraryPage({
    hash,
    pageCount: 2,
    page: 2,
    pairs: [pair("World page", "世界")],
    targetLang: "zh-CN",
    runState: "done"
  }, { store });
  const before = await store.getPages(hash);
  assert.equal(countPageOutcomes(before).translated, 2);
  assert.equal(countPageOutcomes(before).incomplete, 0);

  // The retranslate kept the old pair and did not produce a new verified one.
  // The viewer still has to store runState failed, or the legacy pair counts as done.
  await saveLibraryPage({
    hash,
    pageCount: 2,
    page: 2,
    pairs: [pair("World page", "世界")],
    targetLang: "zh-CN",
    runState: "failed"
  }, { store });
  const pages = await store.getPages(hash);
  const failed = pages.find((row) => row.page === 2);
  assert.equal(failed.runState, "failed");
  assert.equal(failed.pairs.some((item) => item.translation === "世界"), true);
  assert.equal(countPageOutcomes(pages).translated, 1);
  assert.equal(countPageOutcomes(pages).incomplete, 1);
  const listed = await store.listPapers();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].pagesTranslated, 1);
  assert.equal(listed[0].pagesIncomplete, 1);

  const { document } = panelDom();
  const ui = mountLibraryUi({
    slot: document.getElementById("sideSlot"),
    skeletonMs: 60_000,
    now: () => Date.UTC(2026, 9, 26, 12),
    store: async () => store,
    listNotes: async () => [],
    openHash: async () => ""
  });
  ui.open();
  let meta = "";
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    meta = ui.root.querySelector(`[data-lib-row="${hash}"] .oi-lib-meta`)?.textContent || "";
    if (meta) break;
  }
  assert.ok(meta, ui.root.textContent || "");
  assert.match(meta, /已译 1\/2 · 有页没译完/);
  assert.equal(meta.includes("全文已译"), false);

  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const done = viewer.slice(viewer.indexOf("onPageDone({ page, results }) {"), viewer.indexOf("onPageError({ page, results }) {"));
  const failedPage = viewer.slice(viewer.indexOf("onPageError({ page, results }) {"), viewer.indexOf("const prepareLibraryPage"));
  assert.equal(done.includes('if (state !== "failed")'), false);
  assert.match(done, /persistPageRun\(page, merged, state\)/);
  assert.match(failedPage, /persistPageRun\(page, merged, state\)/);
  assert.match(viewer, /runState: forced \|\| pageRunState/);
});
