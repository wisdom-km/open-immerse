import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { countPageOutcomes } from "../lib/library-record.js";
import { libraryProgressCopy } from "../lib/library-copy.js";
import { mountLibraryUi } from "../pdf/library-panel.js";

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
