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
  deleteVersionlessLayoutCacheKeys,
  layoutCacheKeyPrefix,
  reduceClearDocConfirm,
  versionlessLayoutCacheKeys
} from "../lib/doc-translation-cache.js";
import { createMemoryStore } from "../lib/formula-cache.js";
import { LIBRARY_COPY, libraryProgressCopy } from "../lib/library-copy.js";
import { readerToolbarChrome } from "../lib/pdf-pairing.js";
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
  const clearCss = css.slice(css.indexOf(".retranslate-clear-rule"), css.indexOf(".rf-stale-formula"));
  assert.match(clearCss, /\.retranslate-clear \.retranslate-item-label \{\s*color: var\(--oi-reader-danger\);/);
  assert.match(clearCss, /\.retranslate-clear-go \{[^}]*background: var\(--oi-reader-danger\);/s);
  assert.match(clearCss, /color: var\(--oi-reader-on-danger\);/);
  assert.equal(clearCss.includes("#fff"), false);
  assert.equal(clearCss.includes("--oi-reader-warn"), false);
  assert.match(clearCss, /border-radius: var\(--oi-reader-topbar-btn-radius\)/);
  assert.equal(clearCss.includes("--oi-settings"), false);
  assert.equal(readFileSync(join(root, "options/options.html"), "utf8").includes(CLEAR_DOC_COPY.item), false);
  assert.equal(readFileSync(join(root, "pdf/library-panel.js"), "utf8").includes(CLEAR_DOC_COPY.item), false);
});

test("CDC-01 medium and narrow translate menus keep the same clear row", () => {
  const menu = html.slice(html.indexOf('id="translateMenu"'), html.indexOf('id="retranslateSplit"'));
  const doc = menu.indexOf('id="translateMenuRetranslateDoc"');
  const rule = menu.indexOf('class="retranslate-clear-rule"');
  const item = menu.indexOf('id="translateClearDoc"');
  const confirm = menu.indexOf('id="translateClearConfirm"');
  assert.ok(doc >= 0 && doc < rule && rule < item && item < confirm);
  assert.match(menu, new RegExp(CLEAR_DOC_COPY.item.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(menu, new RegExp(CLEAR_DOC_COPY.note));
  assert.match(menu, new RegExp(CLEAR_DOC_COPY.confirm));
  assert.match(menu, /id="translateClearCancel"[^>]*class="btn-secondary"/);
  assert.match(menu, /id="translateClearGo"[^>]*class="retranslate-clear-go"/);
  for (const width of [1199, 1000, 899, 800]) {
    const chrome = readerToolbarChrome(width);
    assert.equal(chrome.retranslateOnBar, false, String(width));
    assert.equal(chrome.translateMenuOnBar, true, String(width));
  }
  assert.equal(readerToolbarChrome(1200).translateMenuOnBar, false);
  const slots = viewer.slice(viewer.indexOf("function clearDocSlots"), viewer.indexOf("function viewerLayoutStorage"));
  assert.match(slots, /translateClearDoc/);
  assert.match(slots, /translateClearCancel/);
  assert.match(slots, /translateClearGo/);
  assert.match(slots, /applyClearDocConfirm\("open-item"\)/);
  assert.match(viewer, /function closeTranslateMenu[\s\S]{0,180}resetClearDocConfirm\(\)/);
  const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
  const dark = tokens.slice(tokens.indexOf('[data-reader-theme="dark"]'));
  assert.match(tokens, /--oi-reader-danger:\s*#8E1B12/i);
  assert.match(tokens, /--oi-reader-on-danger:\s*#FFF8F6/i);
  assert.match(dark, /--oi-reader-danger:\s*#F6C7BE/i);
  assert.match(dark, /--oi-reader-on-danger:\s*#1C1D1F/i);
});

test("CDC-02 confirm stays in the menu and cancel does not clear", () => {
  const opened = reduceClearDocConfirm({ confirming: false }, "open-item");
  assert.deepEqual(opened, { confirming: true, clear: false, close: false, focus: "cancel" });
  assert.deepEqual(reduceClearDocConfirm(opened, "cancel"), { confirming: false, clear: false, close: false, focus: "" });
  assert.deepEqual(reduceClearDocConfirm(opened, "escape"), { confirming: false, clear: false, close: true, focus: "" });
  assert.deepEqual(reduceClearDocConfirm(opened, "outside"), { confirming: false, clear: false, close: true, focus: "" });
  assert.equal(reduceClearDocConfirm({ confirming: false }, "confirm").clear, false);
  assert.deepEqual(reduceClearDocConfirm(opened, "confirm"), { confirming: false, clear: true, close: true, focus: "" });
  const bind = viewer.slice(viewer.indexOf("function clearDocSlots"), viewer.indexOf("function viewerLayoutStorage"));
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
    [`${layoutCacheKeyPrefix("doc-a")}2:text-layer:blocks-1:source-v3`]: { page: 2 },
    [`${layoutCacheKeyPrefix("doc-b")}1:text-layer:blocks-1:source-v3:fp-1`]: { page: 1 },
    [`${layoutCacheKeyPrefix("doc-b")}2:text-layer:blocks-1:source-v3`]: { page: 2 },
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
  assert.equal(bag[`${layoutCacheKeyPrefix("doc-a")}2:text-layer:blocks-1:source-v3`], undefined);
  assert.ok(bag[`${layoutCacheKeyPrefix("doc-b")}1:text-layer:blocks-1:source-v3:fp-1`]);
  assert.ok(bag[`${layoutCacheKeyPrefix("doc-b")}2:text-layer:blocks-1:source-v3`]);
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
  }, "doc-b"), [
    `${layoutCacheKeyPrefix("doc-b")}1:text-layer:blocks-1:source-v3:fp-1`,
    `${layoutCacheKeyPrefix("doc-b")}2:text-layer:blocks-1:source-v3`
  ]);
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

test("a chrome failure after the library delete does not report the clear as failed", async () => {
  const store = memoryLibrary();
  await store.touchPaper("doc-a", { title: "甲", pageCount: 1, origin: "native" });
  await store.putPage("doc-a", 1, { pairs: [{ text: "甲", translation: "A" }] });
  const report = await clearDocTranslationRecords("doc-a", {
    store,
    layoutStorage: {
      async get() {
        throw new Error("chrome down");
      },
      async remove() {
        throw new Error("chrome down");
      }
    },
    clearFormula: async () => {
      throw new Error("formula down");
    }
  });
  assert.equal(report.libraryCleared, true);
  assert.equal(report.incomplete, true);
  assert.equal(report.pages, 1);
  assert.equal((await store.getPages("doc-a")).length, 0);
  await assert.rejects(() => clearDocTranslationRecords("doc-a", {
    store: {
      async clearDocTranslations() {
        throw new Error("idb down");
      }
    },
    layoutStorage: {
      async get() {
        return {};
      }
    }
  }), /idb down/);
  const versionless = "oi-pdf-layout:doc-c:1:text-layer:blocks-1:source-v3";
  const versioned = "oi-pdf-layout:doc-c:1:text-layer:blocks-1:source-v3:fp-1";
  const other = { [versionless]: { page: 1 }, [versioned]: { page: 1 }, "oi-settings": { ok: true } };
  assert.deepEqual(versionlessLayoutCacheKeys(other), [versionless]);
  const removed = await deleteVersionlessLayoutCacheKeys({
    async get() {
      return { ...other };
    },
    async remove(keys) {
      for (const key of keys) delete other[key];
    }
  });
  assert.deepEqual(removed, [versionless]);
  assert.ok(other[versioned]);
  assert.ok(other["oi-settings"]);
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
