import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CLEAR_DOC_COPY,
  clearDocTranslationPlan,
  clearDocTranslationRecords,
  deleteLayoutCacheKeys,
  layoutCacheKeyPrefix,
  reduceClearDocConfirm
} from "../lib/doc-translation-cache.js";
import { createMemoryStore } from "../lib/formula-cache.js";
import { LIBRARY_COPY, libraryProgressCopy } from "../lib/library-copy.js";
import { createLibraryStore } from "../lib/library-store.js";
import { createNotesStore } from "../lib/notes-store.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { createMemoryLibraryFactory } from "../lib/platform/memory-backend.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const storeSrc = readFileSync(join(root, "lib/library-store.js"), "utf8");

function memoryLibrary() {
  return createLibraryStore({
    platform: { target: "memory", kv: createMemoryKv(), library: createMemoryLibraryFactory() },
    deviceId: "device-clear",
    now: () => 40
  });
}

function decision(docHash) {
  return {
    docHash,
    tier: "ocr",
    chainVersion: "f3-1",
    decision: { chosen: { tier: "ocr" } }
  };
}

test("CDC-01 the clear item is only the last retranslate menu row, in danger color", () => {
  const menu = html.slice(html.indexOf('id="retranslateMenu"'), html.indexOf('id="retranslateMenu"') + 1800);
  const doc = menu.indexOf('id="retranslateDocument"');
  const rule = menu.indexOf('class="retranslate-clear-rule"');
  const item = menu.indexOf('id="retranslateClearDoc"');
  assert.ok(doc >= 0 && doc < rule && rule < item);
  assert.match(menu, new RegExp(CLEAR_DOC_COPY.item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(menu, new RegExp(CLEAR_DOC_COPY.note));
  assert.match(menu, new RegExp(CLEAR_DOC_COPY.confirm));
  assert.match(menu, new RegExp(`>${CLEAR_DOC_COPY.cancel}<`));
  assert.match(menu, new RegExp(`>${CLEAR_DOC_COPY.confirmButton}<`));
  assert.match(menu, /id="retranslateClearCancel"[^>]*class="btn-secondary"/);
  const clearCss = css.slice(css.indexOf(".retranslate-clear-rule"));
  assert.match(clearCss, /\.retranslate-clear \.retranslate-item-label \{\s*color: var\(--oi-reader-danger, var\(--oi-reader-warn\)\);/);
  assert.match(clearCss, /\.retranslate-clear-go \{[^}]*background: var\(--oi-reader-danger, var\(--oi-reader-warn\)\);/s);
  assert.equal(clearCss.includes("--oi-settings"), false);
  assert.equal(readFileSync(join(root, "options/options.html"), "utf8").includes(CLEAR_DOC_COPY.item), false);
  assert.equal(readFileSync(join(root, "pdf/library-panel.js"), "utf8").includes(CLEAR_DOC_COPY.item), false);
});

test("CDC-02 confirm stays in the menu and cancel does not clear", () => {
  const opened = reduceClearDocConfirm({ confirming: false }, "open-item");
  assert.deepEqual(opened, { confirming: true, clear: false, close: false, focus: "cancel" });
  assert.deepEqual(reduceClearDocConfirm(opened, "cancel"), { confirming: false, clear: false, close: false, focus: "" });
  assert.deepEqual(reduceClearDocConfirm(opened, "escape"), { confirming: false, clear: false, close: true, focus: "" });
  assert.deepEqual(reduceClearDocConfirm(opened, "outside"), { confirming: false, clear: false, close: true, focus: "" });
  assert.equal(reduceClearDocConfirm({ confirming: false }, "confirm").clear, false);
  assert.deepEqual(reduceClearDocConfirm(opened, "confirm"), { confirming: false, clear: true, close: true, focus: "" });
  const bind = viewer.slice(viewer.indexOf("function bindClearDocTranslation"), viewer.indexOf("function viewerLayoutStorage"));
  assert.match(bind, /applyClearDocConfirm\("open-item"\)/);
  assert.match(bind, /retranslateClearCancel/);
  assert.match(bind, /if \(next\.clear\) void clearDocTranslationCache\(\)/);
  assert.match(viewer, /function closeRetranslateMenu[\s\S]{0,180}resetClearDocConfirm\(\)/);
});

test("CDC-03 clear drops this document's translations and leaves the rest", async () => {
  const store = memoryLibrary();
  const notes = createNotesStore({
    persist: false,
    deviceId: "device-clear",
    now: () => 1,
    createId: () => "note-a"
  });
  await notes.put({ docHash: "doc-a", kind: "note", page: 1, body: "笔记还在" });
  await store.touchPaper("doc-a", { title: "甲", pageCount: 2, origin: "native" });
  await store.touchPaper("doc-b", { title: "乙", pageCount: 1, origin: "native" });
  await store.putPage("doc-a", 1, { pairs: [{ text: "甲", translation: "A" }] });
  await store.putPage("doc-b", 1, { pairs: [{ text: "乙", translation: "B" }] });
  await store.putLayout({
    docHash: "doc-a",
    page: 1,
    mode: "text-layer",
    protocol: "blocks-1",
    layout: { blocks: [{ text: "甲" }] }
  });
  await store.putLayout({
    docHash: "doc-b",
    page: 1,
    mode: "text-layer",
    protocol: "blocks-1",
    layout: { blocks: [{ text: "乙" }] }
  });
  await store.putGroup({ docHash: "doc-a", groupId: "g1", startPage: 1 });
  await store.putGroup({ docHash: "doc-b", groupId: "g2", startPage: 1 });
  await store.putSource("doc-a", new Blob(["%PDF-a"], { type: "application/pdf" }));
  const sourceBefore = await store.getSource("doc-a");
  const formula = createMemoryStore();
  assert.equal(await formula.putDecision("a-ocr", decision("doc-a")), true);
  assert.equal(await formula.putDecision("b-ocr", decision("doc-b")), true);
  const settings = { apiKey: "secret-keep", pdfLayout: { mode: "local-ocr" } };
  const bag = {
    [`${layoutCacheKeyPrefix("doc-a")}1:text-layer:blocks-1:source-v3:fp-1`]: { page: 1 },
    [`${layoutCacheKeyPrefix("doc-b")}1:text-layer:blocks-1:source-v3:fp-1`]: { page: 1 },
    "oi-settings": settings
  };
  const report = await clearDocTranslationRecords("doc-a", {
    store,
    layoutStorage: {
      async get() {
        return { ...bag };
      },
      async remove(keys) {
        for (const key of keys) delete bag[key];
      }
    },
    clearFormula: (hash) => formula.clearDoc(hash),
    settings
  });
  assert.equal(report.paperKept, true);
  assert.equal(report.pages, 1);
  assert.equal(report.groups, 1);
  assert.equal(report.layouts, 1);
  assert.equal(report.formula, true);
  assert.equal(report.notes, "kept");
  assert.equal(report.settings, "kept");
  assert.equal(report.source, "kept");
  assert.equal((await store.getPages("doc-a")).length, 0);
  assert.equal((await store.getGroups("doc-a")).length, 0);
  assert.equal(await store.getLayout("doc-a", 1, "text-layer", "blocks-1"), null);
  assert.equal((await store.getPages("doc-b")).length, 1);
  assert.equal((await store.getGroups("doc-b")).length, 1);
  assert.ok(await store.getLayout("doc-b", 1, "text-layer", "blocks-1"));
  const paper = await store.getPaper("doc-a");
  assert.equal(paper.pagesTranslated, 0);
  assert.equal(paper.pagesIncomplete, 0);
  assert.equal(paper.deletedAt, undefined);
  assert.equal(paper.title, "甲");
  const sourceAfter = await store.getSource("doc-a");
  assert.equal(sourceAfter.size, sourceBefore.size);
  assert.equal((await notes.list("doc-a")).some((note) => note.body === "笔记还在"), true);
  assert.equal(bag[`${layoutCacheKeyPrefix("doc-a")}1:text-layer:blocks-1:source-v3:fp-1`], undefined);
  assert.ok(bag[`${layoutCacheKeyPrefix("doc-b")}1:text-layer:blocks-1:source-v3:fp-1`]);
  assert.equal(bag["oi-settings"].apiKey, "secret-keep");
  assert.equal(settings.pdfLayout.mode, "local-ocr");
  assert.equal(await formula.getDecision("a-ocr"), null);
  assert.ok(await formula.getDecision("b-ocr"));
  const method = storeSrc.slice(storeSrc.indexOf("async clearDocTranslations"), storeSrc.indexOf("async deletePaperData"));
  assert.match(method, /\["papers", "pages", "groups", "layouts", "changes"\]/);
  assert.equal(method.includes('"notes"'), false);
  assert.equal(method.includes('"sources"'), false);
  await assert.rejects(() => clearDocTranslationRecords("", { store }), /missing doc/);
  assert.deepEqual(await deleteLayoutCacheKeys({
    async get() {
      return bag;
    },
    async remove() {}
  }, "doc-b"), [`${layoutCacheKeyPrefix("doc-b")}1:text-layer:blocks-1:source-v3:fp-1`]);
});

test("CDC-04 a cleared document reads as untranslated and does not auto-translate", () => {
  assert.equal(CLEAR_DOC_COPY.libraryRow, "未翻译");
  assert.equal(CLEAR_DOC_COPY.toast, "已清空本文档译文");
  assert.equal(CLEAR_DOC_COPY.toastFail, "清空失败，请重试");
  assert.equal(CLEAR_DOC_COPY.toastMs, 3000);
  assert.equal(libraryProgressCopy(0, 12), "未翻译");
  assert.equal(libraryProgressCopy(0, 12, { incomplete: 0 }), "未翻译");
  assert.equal(libraryProgressCopy(0, 12, { translating: true }), "翻译中 0/12");
  assert.equal(libraryProgressCopy(12, 12), LIBRARY_COPY.full);
  assert.equal(libraryProgressCopy(0, 12, { incomplete: 1 }).includes("未翻译"), false);
  assert.deepEqual(clearDocTranslationPlan({ busy: false }), { stopFirst: false, autoTranslate: false });
  const clear = viewer.slice(viewer.indexOf("async function clearDocTranslationCache"), viewer.indexOf("function forgetViewerTranslations"));
  assert.match(clear, /showToast\(CLEAR_DOC_COPY\.toast, CLEAR_DOC_COPY\.toastMs\)/);
  assert.match(clear, /showToast\(CLEAR_DOC_COPY\.toastFail, CLEAR_DOC_COPY\.toastMs\)/);
  assert.match(clear, /if \(plan\.autoTranslate\) return/);
  assert.equal(clear.includes("startTranslate"), false);
  const forget = viewer.slice(viewer.indexOf("function forgetViewerTranslations"), viewer.indexOf("function openRetranslateFromKeys"));
  assert.match(forget, /formulaStatePatch\("cleared"/);
  assert.match(forget, /PDF_COPY\.translateHint/);
  assert.equal(forget.includes("startTranslate"), false);
  const paint = readFileSync(join(root, "lib/pdf-viewer.js"), "utf8");
  assert.match(paint, /state === "layout" \|\| state === "empty" \|\| state === "cleared"/);
});

test("CDC-05 a busy clear stops the in-flight job before deleting records", () => {
  assert.deepEqual(clearDocTranslationPlan({ busy: true }), { stopFirst: true, autoTranslate: false });
  const clear = viewer.slice(viewer.indexOf("async function clearDocTranslationCache"), viewer.indexOf("function forgetViewerTranslations"));
  const gen = clear.indexOf("restoreGen += 1");
  const stop = clear.indexOf("stopTranslateWork({ silent: true })");
  const records = clear.indexOf("clearDocTranslationRecords");
  const forget = clear.indexOf("forgetViewerTranslations()");
  assert.ok(gen >= 0 && gen < stop && stop < records && records < forget);
  assert.match(clear, /catch \{\s*showToast\(CLEAR_DOC_COPY\.toastFail/);
  const auto = viewer.slice(viewer.indexOf("async function maybeAutoTranslateDocument"), viewer.indexOf("async function startTranslate"));
  assert.match(auto, /autoTranslateTicket/);
  assert.match(viewer.slice(viewer.indexOf("async function startTranslate"), viewer.indexOf("async function resolveBatchSize")), /autoTicket/);
});

test("CDC-06 clearing the formula store makes the next read miss", async () => {
  const formula = createMemoryStore();
  await formula.putDecision("again", decision("doc-a"));
  await formula.putTier("again-tier", { docHash: "doc-a", tier: "multimodal", result: { tier: "multimodal", latex: "x" } });
  await clearDocTranslationRecords("doc-a", {
    clearFormula: (hash) => formula.clearDoc(hash)
  });
  assert.equal(await formula.getDecision("again"), null);
  assert.equal(await formula.getTier("again-tier"), null);
  await formula.putDecision("fresh", decision("doc-a"));
  assert.ok(await formula.getDecision("fresh"));
});
