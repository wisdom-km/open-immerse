import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createMemoryStore } from "../lib/formula-cache.js";
import { clearFormulaDoc, registerFormulaCleaner } from "../lib/formula-cache-client.js";
import {
  LIBRARY_COPY,
  consumeLibrarySort,
  deleteWillCopy,
  libraryDeleteAllowed,
  libraryNoHitCopy,
  libraryPanelPhase,
  libraryProgressCopy,
  libraryRelativeTime,
  libraryRowTitle,
  librarySearchHit,
  librarySizeCopy,
  librarySourceIsLocalFile,
  libraryToastDeleted,
  sortLibraryRows
} from "../lib/library-copy.js";
import { createLibrarySession } from "../lib/library-session.js";
import { createLibraryStore } from "../lib/library-store.js";
import {
  bindLibraryWriteMarks,
  libraryWritesStopped,
  resetLibraryWriteStops
} from "../lib/library-writes.js";
import { saveLibraryPage } from "../lib/pdf-library.js";
import { reuseSettledLibraryFailures } from "../lib/pdf-viewer.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { createMemoryLibraryFactory } from "../lib/platform/memory-backend.js";
import { mountDataPanel } from "../options/data-panel.js";
import { mountLibraryUi } from "../pdf/library-panel.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let storeSerial = 0;
function memoryStore(extra = {}) {
  storeSerial += 1;
  const dbName = extra.dbName || `f8-pr2-${storeSerial}`;
  const kv = createMemoryKv();
  const library = createMemoryLibraryFactory();
  const store = createLibraryStore({
    platform: { target: "memory", kv, library },
    persist: false,
    deviceId: "f8-pr2",
    now: () => 40,
    dbName,
    ...extra
  });
  return { store, library, kv, dbName };
}

function sessionStore(extra = {}) {
  const built = memoryStore(extra);
  const notes = {
    async put() { return { note: { docHash: "n" } }; },
    async list() { return []; },
    async refreshDoc() {}
  };
  const session = createLibrarySession({
    channel: false,
    notes,
    senderId: extra.senderId || "tab-a",
    storeOptions: {
      platform: { target: "memory", kv: built.kv, library: built.library },
      persist: false,
      deviceId: "f8-pr2",
      now: () => 40,
      dbName: built.dbName
    }
  });
  return { ...built, session, notes, store: session.store };
}

const WITH_COPY = "会删除：译文 2 页、版面缓存和 Open Immerse 保存的 PDF 副本。再打开要重新翻译（会再次调用翻译服务）。";
const WITH_COPY_LOCAL = `${WITH_COPY}下次打开要重新选一次 PDF 文件。`;
const NO_COPY = "会删除：译文 2 页和版面缓存。再打开要重新翻译（会再次调用翻译服务）。";
const KEEP = "不会删除：你电脑上的 PDF 文件。";
const URL_CHANGED = "网址上的 PDF 已经换了版本，和这篇的译文对不上。";
const REPICK = "本机没有这篇的 PDF 副本，需要重新选一次文件。";
const FILE_MISMATCH = "选的文件和这篇不是同一份 PDF。";

test("删除确认按有没有副本、来源是不是本地文件，显示三种写法", () => {
  assert.equal(deleteWillCopy({ pages: 2, hasSource: true, localFile: false }), WITH_COPY);
  assert.equal(deleteWillCopy({ pages: 2, hasSource: true, localFile: true }), WITH_COPY_LOCAL);
  assert.equal(deleteWillCopy({ pages: 2, hasSource: false, localFile: true }), NO_COPY);
  assert.equal(deleteWillCopy({ pages: 2.9, hasSource: false }), NO_COPY);
  assert.equal(LIBRARY_COPY.keepFile, KEEP);
  assert.equal(LIBRARY_COPY.urlChanged, URL_CHANGED);
  assert.equal(LIBRARY_COPY.repick, REPICK);
  assert.equal(LIBRARY_COPY.fileMismatch, FILE_MISMATCH);
  assert.equal(librarySourceIsLocalFile({ sourceUrl: "https://example.com/a.pdf" }), false);
  assert.equal(librarySourceIsLocalFile({ sourceUrl: "" }), true);
  assert.equal(librarySourceIsLocalFile({}), true);
});

test("文献库文案：题名、进度、时间、搜索和深链只生效一次", () => {
  assert.deepEqual(libraryRowTitle({ title: "PDF 阅读 · Attention", fileName: "a.pdf", docHash: "abcdef1234567890" }), {
    title: "Attention",
    unnamed: false
  });
  assert.equal(libraryRowTitle({ title: "", fileName: "paper.pdf" }).title, "paper.pdf");
  assert.equal(libraryRowTitle({ docHash: "abcdef1234567890" }).title, "未命名 PDF · abcdef12");
  assert.equal(libraryProgressCopy(3, 3), "全文已译");
  assert.equal(libraryProgressCopy(1, 4), "1/4 页");
  const now = Date.UTC(2026, 9, 19, 12);
  assert.equal(libraryRelativeTime(now, now), "今天");
  assert.equal(libraryRelativeTime(now - 86400000, now), "昨天");
  assert.equal(libraryRelativeTime(Date.UTC(2026, 0, 3, 12), now), "1月3日");
  assert.equal(libraryRelativeTime(Date.UTC(2025, 11, 2, 12), now), "2025-12-02");
  assert.equal(librarySizeCopy(2 * 1024 * 1024).startsWith("约 "), true);
  assert.equal(librarySearchHit({ title: "Attention Is All You Need", fileName: "attn.pdf" }, "NEED"), true);
  assert.equal(librarySearchHit({ title: "Attention", fileName: "attn.pdf" }, "zzz"), false);
  assert.equal(libraryNoHitCopy("zzz"), "没有找到「zzz」");
  assert.equal(libraryToastDeleted("Attention"), "已删除《Attention》");
  assert.equal(libraryDeleteAllowed("abc", "abc"), false);
  assert.equal(libraryDeleteAllowed("abc", "def"), true);
  assert.equal(libraryPanelPhase({ loading: true, count: 3 }), "blank");
  assert.equal(libraryPanelPhase({ blocked: true }), "blocked");
  assert.equal(libraryPanelPhase({ count: 0 }), "empty");
  const sized = sortLibraryRows([
    { docHash: "a", bytes: 1, lastOpenedAt: 9 },
    { docHash: "b", bytes: 50, lastOpenedAt: 1 }
  ], "size");
  assert.deepEqual(sized.map((row) => row.docHash), ["b", "a"]);
  const once = consumeLibrarySort("#library?sort=size", false);
  assert.deepEqual(once, { sort: "size", consumed: true });
  assert.deepEqual(consumeLibrarySort("#library?sort=size", true), { sort: "", consumed: true });
});

test("网址变了的第二行是 12px muted，不是 warn", () => {
  const css = readFileSync(join(root, "pdf/library-panel.css"), "utf8");
  assert.match(css, /\.oi-lib-muted[\s\S]*font-size:\s*12px/);
  assert.match(css, /\.oi-lib-muted[\s\S]*color:\s*var\(--oi-reader-muted\)/);
  assert.match(css, /\.oi-lib-warn[\s\S]*color:\s*var\(--oi-reader-warn\)/);
  assert.doesNotMatch(css, /#[0-9A-Fa-f]{3,8}/);
  const panel = readFileSync(join(root, "pdf/library-panel.js"), "utf8");
  assert.match(panel, /repick\.changed \? h\(doc, "p", \{ class: "oi-lib-muted", text: LIBRARY_COPY\.urlChanged \}/);
  assert.match(panel, /repick\.warn \? h\(doc, "p", \{ class: "oi-lib-warn", text: LIBRARY_COPY\.fileMismatch \}/);
});

function contrast(hexA, hexB) {
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = (hex) => {
    const n = hex.replace("#", "");
    const r = lin(parseInt(n.slice(0, 2), 16) / 255);
    const g = lin(parseInt(n.slice(2, 4), 16) / 255);
    const b = lin(parseInt(n.slice(4, 6), 16) / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const hi = Math.max(lum(hexA), lum(hexB));
  const lo = Math.min(lum(hexA), lum(hexB));
  return (hi + 0.05) / (lo + 0.05);
}

test("文献库文字在五种阅读主题上对比度至少 4.5:1", () => {
  const css = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
  const pick = (name) => {
    const match = css.match(new RegExp(`--oi-reader-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(match, name);
    return match[1];
  };
  const themes = ["warm", "white", "sepia", "green"];
  for (const theme of themes) {
    const paper = pick(`${theme}-paper`);
    const surface = pick(`${theme}-surface`);
    const ink = pick(`${theme}-ink`);
    const ink2 = pick(`${theme}-ink-2`);
    const muted = pick(`${theme}-muted`);
    for (const [fg, bg] of [[ink, paper], [ink, surface], [ink2, paper], [muted, paper], [muted, surface], [pick("warn"), paper]]) {
      assert.ok(contrast(fg, bg) >= 4.5, `${theme} ${fg} on ${bg} = ${contrast(fg, bg)}`);
    }
  }
  const dark = css.slice(css.indexOf('[data-reader-theme="dark"]'));
  const darkHex = (name) => {
    const match = dark.match(new RegExp(`--oi-reader-${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(match, name);
    return match[1];
  };
  const paper = darkHex("paper");
  for (const fg of [darkHex("ink"), darkHex("ink-2"), darkHex("muted"), darkHex("warn")]) {
    assert.ok(contrast(fg, paper) >= 4.5, `dark ${fg} on ${paper}`);
  }
});

test("usage() 无变化只扫一次，脏文档只重算那一篇，并计入 sourceSize", async () => {
  const { store } = memoryStore();
  await store.touchPaper("aaa", { title: "甲", pageCount: 1, opened: true, sourceSize: 1000 });
  await store.touchPaper("bbb", { title: "乙", pageCount: 1, opened: true, sourceSize: 2000 });
  const first = await store.usage();
  assert.equal(store.usageFullScans, 1);
  assert.ok(first.byDoc.get("aaa") >= 1000);
  assert.ok(first.byDoc.get("bbb") >= 2000);
  const second = await store.usage();
  assert.equal(store.usageFullScans, 1);
  assert.equal(store.usageDocReads, 0);
  assert.equal(second.byDoc.get("aaa"), first.byDoc.get("aaa"));
  await store.touchPaper("aaa", { sourceSize: 8000 });
  const third = await store.usage();
  assert.equal(store.usageFullScans, 1, "去掉缓存后第二次 usage 会再全量扫描");
  assert.equal(store.usageDocReads, 1, "去掉按篇失效后脏文档不会单独重算");
  assert.ok(third.byDoc.get("aaa") > first.byDoc.get("aaa"));
  assert.equal(third.byDoc.get("bbb"), first.byDoc.get("bbb"));
  first.byDoc.set("aaa", 1);
  const fourth = await store.usage();
  assert.equal(fourth.byDoc.get("aaa"), third.byDoc.get("aaa"));
});

test("删除论文清掉该篇公式缓存，别的论文还在", async () => {
  const formula = createMemoryStore();
  const stop = registerFormulaCleaner((hash) => formula.clearDoc(hash));
  try {
    const { store } = sessionStore();
    await formula.putTier("x-key", { tier: "multimodal", docHash: "doc-x", key: "x-key", decidedAt: 1 });
    await formula.putTier("y-key", { tier: "ocr", docHash: "doc-y", key: "y-key", decidedAt: 1 });
    await store.touchPaper("doc-x", { title: "X", pageCount: 1, opened: true });
    await store.touchPaper("doc-y", { title: "Y", pageCount: 1, opened: true });
    const report = await store.deletePaperData("doc-x", { formula: true });
    assert.equal(report.formula, true);
    assert.equal(await formula.getTier("x-key"), null);
    assert.ok(await formula.getTier("y-key"));
  } finally {
    stop();
  }
});

test("正在阅读的论文删不掉", async () => {
  const { store } = memoryStore();
  await store.touchPaper("open-hash", { title: "正在读", pageCount: 1, opened: true });
  const report = await store.deletePaperData("open-hash", { readingHash: "open-hash", formula: true });
  assert.equal(report.refused, "reading");
  const paper = await store.getPaper("open-hash");
  assert.equal(paper.deletedAt || 0, 0);
  assert.equal(libraryDeleteAllowed("open-hash", "open-hash"), false);
});

test("别的标签删掉之后，这一标签晚到的页写不能把论文救回来", async () => {
  resetLibraryWriteStops();
  const sourceSent = new Set(["gone"]);
  const originalStored = new Set(["gone"]);
  let dropped = "";
  bindLibraryWriteMarks({
    sourceSent,
    originalStored,
    dropDoc(hash) { dropped = hash; }
  });
  const { store, session } = sessionStore();
  await store.touchPaper("gone", { title: "要删", pageCount: 2, opened: true, sourceSize: 12 });
  await store.putPage("gone", 1, { pairs: [{ text: "Hello", translation: "你好", targetLang: "zh-CN" }] });
  const tombBefore = await store.deletePaperData("gone");
  assert.ok(tombBefore.pages >= 1);
  assert.equal(libraryWritesStopped("gone"), true);
  assert.equal(sourceSent.has("gone"), false);
  assert.equal(originalStored.has("gone"), false);
  assert.equal(dropped, "gone");
  const tomb = await store.getPaper("gone");
  assert.ok(tomb.deletedAt);
  const late = await saveLibraryPage({
    hash: "gone",
    title: "晚到的一页",
    pageCount: 2,
    page: 2,
    pairs: [{ translation: "不该回来" }]
  }, { store });
  assert.equal(late.source, "absent");
  const still = await store.getPaper("gone");
  assert.equal(still.deletedAt, tomb.deletedAt);
  assert.equal(still.createdAt, tomb.createdAt);
  assert.equal((await store.getPages("gone")).length, 0);
  assert.equal(await store.getSource("gone"), null);

  await store.touchPaper("remote", { title: "远程", pageCount: 1, opened: true });
  resetLibraryWriteStops();
  sourceSent.add("remote");
  const other = createLibrarySession({
    channel: false,
    notes: session.notes,
    senderId: "tab-b",
    store
  });
  const accepted = await other.accept({
    senderId: "tab-a",
    seq: 1,
    collection: "papers",
    docHash: "remote",
    deleted: true
  });
  assert.equal(accepted, true);
  assert.equal(libraryWritesStopped("remote"), true);
  assert.equal(sourceSent.has("remote"), false);
  const remoteTomb = await store.getPaper("remote");
  await store.deletePaperData("remote");
  const lateRemote = await saveLibraryPage({
    hash: "remote",
    title: "远程晚到",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "也不该回来" }]
  }, { store });
  assert.equal(lateRemote.source, "absent");
  const remoteStill = await store.getPaper("remote");
  assert.equal(remoteStill.deletedAt, remoteTomb.deletedAt || remoteStill.deletedAt);
  assert.ok(remoteStill.deletedAt);
  resetLibraryWriteStops();
});

test("失败行只复用同一目标语言里已经落定的文献译文", () => {
  const rows = [
    { original: "A second sentence stays failed until the retry.", translation: "", failed: true, role: "paragraph" },
    { original: "Kept sentence.", translation: "留下", failed: false, role: "paragraph" }
  ];
  const wrong = reuseSettledLibraryFailures(rows, [{
    text: "A second sentence stays failed until the retry.",
    translation: "Wrong language",
    targetLang: "en"
  }], "zh-CN");
  assert.equal(wrong, rows);
  const reused = reuseSettledLibraryFailures(rows, [{
    text: "A second sentence stays failed until the retry.",
    translation: "第二句已经在库里译好了。",
    targetLang: "zh-CN"
  }], "zh-CN");
  assert.notEqual(reused, rows);
  assert.equal(reused[0].failed, false);
  assert.equal(reused[0].translation, "第二句已经在库里译好了。");
  assert.equal(reused[1], rows[1]);
});

function fakeTimers() {
  let now = 0;
  let id = 1;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const handle = id++;
      timeouts.set(handle, { fn, at: now + (Number(ms) || 0) });
      return handle;
    },
    clearTimeout(handle) { timeouts.delete(handle); },
    setInterval(fn, ms) {
      const handle = id++;
      intervals.set(handle, { fn, ms: Number(ms) || 0, at: now + (Number(ms) || 0) });
      return handle;
    },
    clearInterval(handle) { intervals.delete(handle); },
    advance(ms) {
      now += ms;
      for (const [handle, item] of [...timeouts]) {
        if (item.at <= now) {
          timeouts.delete(handle);
          item.fn();
        }
      }
      for (const item of intervals.values()) {
        if (item.at <= now) {
          item.at = now + item.ms;
          item.fn();
        }
      }
    }
  };
}

async function flush() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

function panelDom() {
  const parsed = parseHTML("<!doctype html><button id='libraryButton'>文献库</button><div id='sideSlot'></div>");
  return parsed;
}

function paperRow(partial) {
  return {
    docHash: "hash-a",
    title: "Attention",
    fileName: "attention.pdf",
    pageCount: 2,
    lastOpenedAt: Date.UTC(2026, 9, 19, 8),
    sourceSize: 0,
    sourceUrl: "",
    ...partial
  };
}

test("文献库面板：空、有数据、确认文案三种、网址变了、选错文件、存储中断", async () => {
  const { document, window } = panelDom();
  const timers = fakeTimers();
  const papers = [
    paperRow({ docHash: "none", title: "没有副本", sourceSize: 0, sourceUrl: "" }),
    paperRow({ docHash: "url", title: "网上的", sourceSize: 2048, sourceUrl: "https://example.com/a.pdf" }),
    paperRow({ docHash: "local", title: "本地的", sourceSize: 4096, sourceUrl: "" })
  ];
  const pages = {
    none: [{ page: 1, pairs: [{ translation: "一" }] }, { page: 2, pairs: [{ translation: "二" }] }],
    url: [{ page: 1, pairs: [{ translation: "一" }] }, { page: 2, pairs: [{ translation: "二" }] }],
    local: [{ page: 1, pairs: [{ translation: "一" }] }, { page: 2, pairs: [{ translation: "二" }] }]
  };
  const notes = { local: [{ id: "n1" }] };
  let opened = [];
  const store = {
    async listPapers() { return papers.filter((row) => !row.deletedAt); },
    async getPages(hash) { return pages[hash] || []; },
    async usage() {
      return { byDoc: new Map(papers.filter((row) => !row.deletedAt).map((row) => [row.docHash, row.sourceSize || 10])) };
    },
    async getPaper(hash) { return papers.find((row) => row.docHash === hash) || null; },
    async getSource() { return null; },
    async deletePaperData(hash, options) {
      const row = papers.find((item) => item.docHash === hash);
      if (options?.readingHash === hash) return { refused: "reading" };
      if (row) row.deletedAt = 1;
      return { notes: options?.notes === true, formula: options?.formula === true };
    }
  };
  let releaseDelay = null;
  const ui = mountLibraryUi({
    slot: document.getElementById("sideSlot"),
    timers,
    now: () => Date.UTC(2026, 9, 19, 12),
    width: () => 1200,
    searchMs: 150,
    pollMs: 5000,
    store: async () => store,
    listNotes: async (hash) => notes[hash] || [],
    openHash: async () => "",
    openBytes: async (bytes, title) => { opened.push(title); },
    fetch: async () => new Uint8Array([9, 9, 9]),
    delay: () => {
      if (releaseDelay) return;
      return new Promise((done) => { releaseDelay = done; });
    },
    toast() {}
  });
  ui.open();
  await flush();
  assert.equal(ui.root.textContent.includes("还没有论文"), false);
  assert.equal(ui.root.querySelector(".oi-lib-blank") != null, true);
  releaseDelay();
  await flush();
  const text = () => ui.root.textContent;
  const confirmText = () => ui.root.querySelector(".oi-lib-confirm")?.textContent || "";
  assert.match(text(), /没有副本/);
  assert.match(text(), /全文已译/);
  assert.match(text(), /今天/);
  assert.match(text(), /约 /);

  ui.root.querySelector('[data-lib-row="none"] .oi-lib-trash').click();
  await flush();
  assert.equal(confirmText(), `${NO_COPY}${KEEP}取消删除`);
  ui.root.querySelector(".oi-lib-cancel").click();

  ui.root.querySelector('[data-lib-row="url"] .oi-lib-trash').click();
  await flush();
  assert.equal(confirmText(), `${WITH_COPY}${KEEP}取消删除`);
  assert.equal(confirmText().includes("下次打开要重新选一次 PDF 文件。"), false);
  ui.root.querySelector(".oi-lib-cancel").click();

  ui.root.querySelector('[data-lib-row="local"] .oi-lib-trash').click();
  await flush();
  assert.equal(confirmText(), `${WITH_COPY_LOCAL}${KEEP}同时删除笔记取消删除`);
  assert.notEqual(ui.root.querySelector("[data-lib-notes]").checked, true);
  const notesCalls = [];
  const originalDelete = store.deletePaperData.bind(store);
  store.deletePaperData = async (hash, options) => {
    notesCalls.push(options?.notes === true);
    return originalDelete(hash, options);
  };
  ui.root.querySelector(".oi-lib-do-delete").click();
  await flush();
  assert.deepEqual(notesCalls, [false]);
  assert.equal(ui.root.querySelector('[data-lib-row="local"]'), null);

  ui.root.querySelector('[data-lib-row="url"] .oi-lib-open').click();
  await flush();
  const hint = ui.root.querySelector(".oi-lib-repick");
  assert.equal(hint.querySelector("p").textContent, REPICK);
  assert.equal(hint.querySelector(".oi-lib-muted").textContent, URL_CHANGED);
  assert.equal(hint.querySelector(".oi-lib-warn"), null);
  assert.equal(hint.querySelector(".oi-lib-pick").textContent, "选择文件…");
  const mutedStyle = readFileSync(join(root, "pdf/library-panel.css"), "utf8");
  assert.match(mutedStyle, /\.oi-lib-meta,\s*\n\.oi-lib-muted,\s*\n\.oi-lib-foot \{[\s\S]*font-size:\s*12px/);

  const file = new window.File([new Uint8Array([1, 2, 3, 4])], "wrong.pdf", { type: "application/pdf" });
  const input = hint.querySelector("input[type=file]");
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new window.Event("change"));
  await flush();
  const again = ui.root.querySelector(".oi-lib-repick");
  assert.equal(again.querySelector(".oi-lib-warn").textContent, FILE_MISMATCH);
  assert.equal(again.querySelector(".oi-lib-pick").textContent, "换一个…");
  assert.equal(opened.length, 0);

  ui.close();
  let blocked = true;
  const blockedUi = mountLibraryUi({
    slot: document.getElementById("sideSlot"),
    timers,
    width: () => 1200,
    pollMs: 5000,
    store: async () => {
      if (blocked) {
        const error = new Error("blocked");
        error.name = "BlockedError";
        throw error;
      }
      return {
        async listPapers() { return [paperRow({ docHash: "back", title: "回来了", pageCount: 1 })]; },
        async getPages() { return []; },
        async usage() { return { byDoc: new Map([["back", 10]]) }; },
        async getSource() { return null; }
      };
    },
    listNotes: async () => [],
    openHash: async () => ""
  });
  blockedUi.open();
  await flush();
  assert.match(blockedUi.root.textContent, /暂时连不上本机存储/);
  assert.equal(blockedUi.root.textContent.includes("还没有论文"), false);
  blocked = false;
  timers.advance(5000);
  await flush();
  assert.match(blockedUi.root.textContent, /回来了/);
});

test("搜索防抖、深链排序只吃一次、正在阅读不能删、窄屏返回", async () => {
  const { document, window } = panelDom();
  const timers = fakeTimers();
  const papers = Array.from({ length: 8 }, (_, index) => paperRow({
    docHash: `p${index}`,
    title: index === 3 ? "Unique Needle" : `Paper ${index}`,
    fileName: `p${index}.pdf`,
    pageCount: 1,
    sourceSize: (8 - index) * 1000,
    lastOpenedAt: index
  }));
  const store = {
    async listPapers() { return papers; },
    async getPages() { return [{ page: 1, pairs: [{ translation: "译" }] }]; },
    async usage() { return { byDoc: new Map(papers.map((row) => [row.docHash, row.sourceSize])) }; },
    async getSource() { return null; }
  };
  let hash = "#library?sort=size";
  const ui = mountLibraryUi({
    slot: document.getElementById("sideSlot"),
    timers,
    width: () => 860,
    hash: () => hash,
    searchMs: 150,
    store: async () => store,
    listNotes: async () => [],
    openHash: async () => "p0"
  });
  ui.open();
  await flush();
  const names = () => [...ui.root.querySelectorAll(".oi-lib-name")].map((node) => node.textContent);
  assert.deepEqual(names()[0], "Paper 0");
  assert.equal(ui.root.classList.contains("is-sheet"), true);
  assert.equal(ui.root.querySelector(".oi-lib-back").hidden, false);
  const trash = ui.root.querySelector('[data-lib-row="p0"] .oi-lib-trash');
  assert.equal(trash.disabled, true);
  assert.equal(trash.getAttribute("title"), LIBRARY_COPY.readingReason);
  hash = "#library";
  ui.close();
  ui.open();
  await flush();
  assert.equal(names()[0], "Paper 0");
  const input = ui.root.querySelector("input[type=search]");
  assert.ok(input);
  input.value = "zzzz";
  input.dispatchEvent(new window.Event("input"));
  await flush();
  assert.equal(ui.root.textContent.includes("没有找到"), false);
  timers.advance(150);
  await flush();
  assert.match(ui.root.textContent, /没有找到「zzzz」/);
  ui.root.querySelector(".oi-lib-miss button").click();
  await flush();
  assert.equal(names().length, 8);
});

test("设置页「按篇查看」指向按大小排序的文献库", async () => {
  const parsed = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
  const previous = globalThis.document;
  globalThis.document = parsed.document;
  const built = memoryStore();
  let panel = null;
  try {
    panel = mountDataPanel(parsed.document.getElementById("root"), {
      store: built.store,
      usage: async () => ({ usage: 10, quota: 100, persisted: true }),
      window: parsed.window
    });
    await panel.reload();
    const link = parsed.document.querySelector("a.oi-data-browse");
    assert.equal(link?.textContent, "按篇查看 →");
    assert.equal(link?.getAttribute("href"), "../pdf/viewer.html#library?sort=size");
    await panel.closeAll();
  } finally {
    panel?.destroy();
    globalThis.document = previous;
  }
});

test("clearFormulaDoc 会走到已注册的清理函数", async () => {
  const seen = [];
  const stop = registerFormulaCleaner((hash) => { seen.push(hash); });
  try {
    await clearFormulaDoc("doc-z");
    assert.deepEqual(seen, ["doc-z"]);
  } finally {
    stop();
  }
});
