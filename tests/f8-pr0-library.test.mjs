/**
 * F8-PR0 文献库数据修补。不联网。
 *
 * 不变量（每一步都查）：
 * 1. pagesTranslated 等于非空译文或 skipped 的页数，两个标签交错也一样。
 * 2. 写页不改 lastOpenedAt。lastOpenedAt 只在打开时变，包括没翻译过的 PDF。
 * 3. 打开没翻译过的 PDF 就建库记录，并保存原 PDF。墓碑不复活。
 * 4. 原 PDF 以 Blob 进 sources；默认导出不含原文。
 * 5. 删除后列表里没有这篇，pages 为空，sources 里没有 blob。墓碑仍在（F4 同步）。
 * 6. 打开顺序：本机 blob → 注入的 sourceUrl / arXiv 重下并校验 hash → 重新选文件。默认不调用 fetch。
 * 7. 旧记录缺 sourceUrl / sourceSize / fileName 时照常读写；带「PDF 阅读 · 」前缀的题名用 cleanTitle 显示。
 */
import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  LIBRARY_SOURCE_MAX_BYTES,
  cleanTitle,
  countTranslated,
  httpSourceUrl,
  sha256HexOf
} from "../lib/library-record.js";
import {
  ANNOTATIONS_SCHEMA,
  LIBRARY_FORMAT,
  LIBRARY_SCHEMA,
  createLibraryStore
} from "../lib/library-store.js";
import {
  fetchLibraryDocument,
  flushPendingPages,
  libraryDocumentFromRecords,
  markLibraryOpened,
  openLibraryPdf,
  resolveLibraryOpen,
  saveLibraryPage,
  saveLibrarySource
} from "../lib/pdf-library.js";
import { createIdbLibraryFactory } from "../lib/platform/idb-backend.js";
import { createMemoryKv } from "../lib/platform/kv.js";
import { createMemoryLibraryFactory } from "../lib/platform/memory-backend.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let fetchCalls = 0;
globalThis.fetch = () => {
  fetchCalls += 1;
  const error = new Error("f8-pr0 must not send a network request");
  error.code = "live-fetch-blocked";
  throw error;
};

let storeSerial = 0;
function memoryStore(extra = {}) {
  storeSerial += 1;
  const dbName = extra.dbName || `f8-pr0-${storeSerial}`;
  const kv = createMemoryKv();
  const library = createMemoryLibraryFactory();
  const store = createLibraryStore({
    platform: { target: "memory", kv, library },
    persist: false,
    deviceId: "f8",
    now: () => 40,
    dbName,
    ...extra
  });
  return { store, library, kv, dbName };
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

test("cleanTitle strips the viewer prefix and leaves other titles", () => {
  assert.equal(cleanTitle("PDF 阅读 · attention.pdf"), "attention.pdf");
  assert.equal(cleanTitle("PDF 阅读 · PDF 阅读 · 二次"), "二次");
  assert.equal(cleanTitle("  PDF 阅读 ·  前后空白  "), "前后空白");
  assert.equal(cleanTitle("attention.pdf"), "attention.pdf");
  assert.equal(cleanTitle(""), "");
  assert.equal(LIBRARY_SOURCE_MAX_BYTES, 100 * 1024 * 1024);
});

test("titles drop the prefix, fileName is kept, and old rows display through cleanTitle", async () => {
  const { store, library, dbName } = memoryStore();
  const saved = await saveLibraryPage({
    hash: "g1",
    title: "PDF 阅读 · attention.pdf",
    fileName: "attention.pdf",
    pageCount: 2,
    page: 1,
    pairs: [{ text: "Hello", translation: "你好" }]
  }, { store });
  assert.equal(saved.source, "absent");
  const paper = await store.getPaper("g1");
  assert.equal(paper.title, "attention.pdf");
  assert.equal(paper.fileName, "attention.pdf");
  assert.equal(paper.pagesTranslated, 1);
  assert.equal((await store.listPapers())[0].title, "attention.pdf");

  const backend = await library.open(dbName, ANNOTATIONS_SCHEMA);
  await backend.put("papers", {
    docHash: "old",
    schema: LIBRARY_SCHEMA,
    title: "PDF 阅读 · legacy.pdf",
    pageCount: 3,
    pagesTranslated: 9,
    lastOpenedAt: 50,
    createdAt: 50,
    updatedAt: 50,
    rev: 1,
    deviceId: "old"
  });
  await backend.put("pages", {
    docHash: "old",
    page: 1,
    schema: LIBRARY_SCHEMA,
    pairs: [{ text: "a", translation: "已译" }],
    rev: 1,
    updatedAt: 50,
    deviceId: "old"
  });
  const raw = await store.getPaper("old");
  assert.equal(raw.title, "PDF 阅读 · legacy.pdf");
  assert.equal(raw.fileName, undefined);
  assert.equal(raw.sourceUrl, undefined);
  assert.equal(raw.sourceSize, undefined);
  assert.equal(cleanTitle(raw.title), "legacy.pdf");
  assert.equal((await store.listPapers()).find((item) => item.docHash === "old").title, "legacy.pdf");
  assert.equal(Number((await store.listPapers()).find((item) => item.docHash === "old").sourceSize) || 0, 0);

  await store.putPage("old", 2, { pairs: [{ text: "b", translation: "乙" }] });
  const recounted = await store.getPaper("old");
  assert.equal(recounted.pagesTranslated, 2);
  assert.equal(recounted.lastOpenedAt, 50);
  assert.equal(recounted.title, "PDF 阅读 · legacy.pdf");
  await store.touchPaper("old", { pageCount: 3 });
  const migrated = await store.getPaper("old");
  assert.equal(migrated.title, "legacy.pdf");
  assert.equal(migrated.lastOpenedAt, 50);
  assert.equal(migrated.fileName, undefined);
  assert.equal(migrated.sourceUrl, undefined);
});

test("page writes do not move lastOpenedAt, and opening an untranslated PDF creates a paper", async () => {
  const { store } = memoryStore({ now: () => Date.now() });
  let clock = 100;
  store.now = () => ++clock;
  const createdMissing = await store.markOpened("missing", { title: "未译.pdf", fileName: "未译.pdf" });
  assert.ok(createdMissing && !createdMissing.deletedAt);
  assert.equal(createdMissing.pagesTranslated, 0);
  assert.equal(createdMissing.title, "未译.pdf");
  assert.ok(createdMissing.lastOpenedAt > 0);
  assert.equal(await store.getSource("missing"), null);
  assert.equal((await store.listPapers()).some((item) => item.docHash === "missing"), true);

  await saveLibraryPage({
    hash: "g3",
    title: "第一页",
    pageCount: 2,
    page: 1,
    pairs: [{ text: "a", translation: "甲" }]
  }, { store });
  const created = await store.getPaper("g3");
  assert.ok(created.lastOpenedAt > 0);
  const opened = created.lastOpenedAt;
  await saveLibraryPage({
    hash: "g3",
    title: "第一页",
    pageCount: 2,
    page: 2,
    pairs: [{ text: "b", translation: "乙" }]
  }, { store });
  const written = await store.getPaper("g3");
  assert.equal(written.lastOpenedAt, opened);
  assert.equal(written.pagesTranslated, 2);
  const marked = await store.markOpened("g3");
  assert.ok(marked.lastOpenedAt > opened);
  assert.equal(marked.pagesTranslated, 2);
  assert.equal((await store.getPaper("g3")).lastOpenedAt, marked.lastOpenedAt);

  await store.deletePaperData("g3");
  const tomb = await store.getPaper("g3");
  assert.equal(await store.markOpened("g3"), null);
  assert.equal((await store.getPaper("g3")).deletedAt, tomb.deletedAt);
  assert.equal((await store.getPaper("g3")).lastOpenedAt, tomb.lastOpenedAt);
});

test("skipped and blank pages recount inside putPage, including a second tab", async () => {
  const library = createMemoryLibraryFactory();
  const kv = createMemoryKv();
  let clock = 10;
  const now = () => ++clock;
  const make = (id) => createLibraryStore({
    platform: { target: "memory", kv, library },
    persist: false,
    deviceId: id,
    now,
    dbName: "f8-tabs"
  });
  const a = make("a");
  const b = make("b");
  await a.touchPaper("doc", { title: "交错", pageCount: 3, origin: "native", opened: true });
  const opened = (await a.getPaper("doc")).lastOpenedAt;
  await a.putPage("doc", 1, { pairs: [{ translation: "  " }] });
  assert.equal((await a.getPaper("doc")).pagesTranslated, 0);
  await b.putPage("doc", 2, { pairs: [], skipped: true });
  await a.putPage("doc", 3, { pairs: [{ translation: "有字" }] });
  await b.putPage("doc", 1, { pairs: [{ translation: "" }] });
  const paper = await a.getPaper("doc");
  const pages = await b.getPages("doc");
  assert.equal(paper.pagesTranslated, countTranslated(pages));
  assert.equal(paper.pagesTranslated, 2);
  assert.equal(paper.lastOpenedAt, opened);
});

test("saveLibrarySource stores a Blob once, refuses oversized files, and survives source quota", async () => {
  const { store } = memoryStore();
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const tooBig = await saveLibraryPage({
    hash: "big",
    title: "大",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "仍在" }],
    source: new Blob([bytes], { type: "application/pdf" })
  }, { store, maxBytes: 4 });
  assert.equal(tooBig.source, "too-large");
  assert.equal(await store.getSource("big"), null);
  assert.equal((await store.getPaper("big")).pagesTranslated, 1);
  assert.equal((await store.getPaper("big")).sourceSize, undefined);

  let puts = 0;
  const original = store.putSource.bind(store);
  store.putSource = async (...args) => {
    puts += 1;
    return original(...args);
  };
  const first = await saveLibraryPage({
    hash: "pdf",
    title: "原文",
    fileName: "a.pdf",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "甲" }],
    source: new Blob([bytes], { type: "application/pdf" })
  }, { store });
  assert.equal(first.source, "saved");
  assert.equal(puts, 1);
  const blob = await store.getSource("pdf");
  assert.equal(blob instanceof Blob, true);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal((await store.getPaper("pdf")).sourceSize, bytes.byteLength);
  const again = await saveLibrarySource("pdf", bytes, { store });
  assert.equal(again.status, "exists");
  assert.equal(puts, 1);

  store.putSource = async () => {
    const error = new Error("quota");
    error.name = "QuotaExceededError";
    throw error;
  };
  const quota = await saveLibraryPage({
    hash: "quota",
    title: "配额",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "页还在" }],
    source: new Blob([bytes])
  }, { store });
  assert.equal(quota.source, "quota");
  assert.equal(await store.getSource("quota"), null);
  assert.equal((await store.getPage("quota", 1)).pairs[0].translation, "页还在");
});

test("a source failure keeps the page, and a recount abort keeps the previous page", async () => {
  const before = memoryStore();
  let armed = true;
  const originalPut = before.store.putSource.bind(before.store);
  before.store.putSource = async (...args) => {
    if (armed) throw new Error("before putSource");
    return originalPut(...args);
  };
  const bytes = new Uint8Array([9, 9, 9]);
  const failed = await saveLibraryPage({
    hash: "before",
    title: "前",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "甲" }],
    source: new Blob([bytes])
  }, { store: before.store });
  assert.equal(failed.source, "error");
  assert.equal((await before.store.getPage("before", 1)).pairs[0].translation, "甲");
  assert.equal(await before.store.getSource("before"), null);
  const opened = (await before.store.getPaper("before")).lastOpenedAt;
  armed = false;
  await saveLibraryPage({
    hash: "before",
    title: "前",
    pageCount: 1,
    page: 2,
    pairs: [{ translation: "乙" }],
    source: new Blob([bytes])
  }, { store: before.store });
  assert.equal((await before.store.getPaper("before")).pagesTranslated, 2);
  assert.equal((await before.store.getPaper("before")).lastOpenedAt, opened);
  assert.equal((await before.store.getSource("before")).size, 3);

  const mid = memoryStore({ dbName: "f8-mid-source" });
  const originalTouch = mid.store.touchPaper.bind(mid.store);
  let touches = 0;
  mid.store.touchPaper = async (...args) => {
    touches += 1;
    if (touches === 1) throw new Error("before any write");
    return originalTouch(...args);
  };
  await assert.rejects(() => saveLibraryPage({
    hash: "between",
    title: "中",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "乙" }],
    source: new Blob([bytes])
  }, { store: mid.store }));
  assert.equal(await mid.store.getPaper("between"), null);
  assert.equal(await mid.store.getSource("between"), null);
  await saveLibraryPage({
    hash: "between",
    title: "中",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "乙" }],
    source: new Blob([bytes])
  }, { store: mid.store });
  assert.equal((await mid.store.getPaper("between")).sourceSize, 3);
  assert.equal((await mid.store.getPage("between", 1)).pairs[0].translation, "乙");

  const library = createMemoryLibraryFactory();
  const backend = await library.open("f8-recount", ANNOTATIONS_SCHEMA);
  const blobs = await library.blobs("f8-recount", ANNOTATIONS_SCHEMA);
  const store = createLibraryStore({
    backend,
    blobs,
    platform: { target: "memory", kv: createMemoryKv(), library },
    persist: false,
    now: () => 7,
    dbName: "f8-recount"
  });
  await store.touchPaper("m", { title: "中断", pageCount: 1, origin: "native", opened: true });
  const beforePage = await store.getPaper("m");
  let boom = true;
  const originalTx = backend.tx.bind(backend);
  backend.tx = (names, mode, fn) => {
    if (boom && [].concat(names).includes("pages")) {
      return originalTx(names, mode, (work) => fn({
        get: (...args) => work.get(...args),
        getAll: (...args) => work.getAll(...args),
        delete: (...args) => work.delete(...args),
        put(collection, record) {
          if (collection === "papers") {
            const error = new Error("recount");
            error.name = "UnknownError";
            throw error;
          }
          return work.put(collection, record);
        }
      }));
    }
    return originalTx(names, mode, fn);
  };
  await assert.rejects(() => store.putPage("m", 1, { pairs: [{ translation: "甲" }] }));
  boom = false;
  assert.equal(await store.getPage("m", 1), null);
  assert.equal((await store.getPaper("m")).pagesTranslated, beforePage.pagesTranslated);
  assert.equal((await store.getPaper("m")).lastOpenedAt, beforePage.lastOpenedAt);
  assert.equal((await store.getPaper("m")).rev, beforePage.rev);
  await store.putPage("m", 1, { pairs: [{ translation: "甲" }] });
  assert.equal((await store.getPaper("m")).pagesTranslated, 1);
});

test("a blocked source write is queued, and a failed blob delete can be retried", async () => {
  const { store } = memoryStore({ dbName: "f8-block" });
  let blocked = true;
  const original = store.putSource.bind(store);
  store.putSource = async (...args) => {
    if (blocked) {
      const error = new Error("blocked");
      error.name = "BlockedError";
      throw error;
    }
    return original(...args);
  };
  const bytes = new Uint8Array([4, 5]);
  const blockedSave = await saveLibraryPage({
    hash: "blk",
    title: "阻",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "甲" }],
    source: new Blob([bytes])
  }, { store });
  assert.equal(blockedSave.source, "blocked");
  assert.equal((await store.getPage("blk", 1)).pairs[0].translation, "甲");
  assert.equal(await store.getSource("blk"), null);
  blocked = false;
  assert.equal(await flushPendingPages({ store }), 1);
  assert.equal((await store.getPage("blk", 1)).pairs[0].translation, "甲");
  assert.equal((await store.getSource("blk")).size, 2);

  const library = createMemoryLibraryFactory();
  const backend = await library.open("f8-del", ANNOTATIONS_SCHEMA);
  const blobs = await library.blobs("f8-del", ANNOTATIONS_SCHEMA);
  const deleteBlob = blobs.delete.bind(blobs);
  let failDelete = true;
  blobs.delete = async (key) => {
    if (failDelete) {
      failDelete = false;
      throw new Error("blob delete failed");
    }
    return deleteBlob(key);
  };
  const hooked = createLibraryStore({
    backend,
    blobs,
    platform: { target: "memory", kv: createMemoryKv(), library },
    persist: false,
    now: () => 8,
    dbName: "f8-del"
  });
  await hooked.touchPaper("gone", { title: "删", pageCount: 1, origin: "native", opened: true });
  await hooked.putPage("gone", 1, { pairs: [{ translation: "甲" }] });
  await hooked.putSource("gone", new Blob([bytes]));
  await assert.rejects(() => hooked.deletePaperData("gone"), (error) => error.report && error.report.pages === 1);
  assert.equal((await hooked.listPapers()).some((item) => item.docHash === "gone"), false);
  assert.equal((await hooked.getPages("gone")).length, 0);
  assert.equal((await hooked.getSource("gone")).size, 2);
  const retried = await hooked.deletePaperData("gone");
  assert.equal(retried.sources, 1);
  assert.equal(await hooked.getSource("gone"), null);
  assert.equal((await hooked.getPaper("gone")).sourceSize, 0);

  await hooked.touchPaper("keep", { title: "留原文", pageCount: 1, origin: "native", opened: true });
  await hooked.putSource("keep", new Blob([bytes]));
  const kept = await hooked.deletePaperData("keep", { source: false });
  assert.equal(kept.sources, 0);
  assert.equal((await hooked.getSource("keep")).size, 2);
});

test("http(s) sourceUrl is stored, file and blob urls are not, and arXiv ids are filled from the url", async () => {
  const { store } = memoryStore({ dbName: "f8-url" });
  await saveLibraryPage({
    hash: "web",
    title: "1706.03762.pdf",
    sourceUrl: "https://arxiv.org/pdf/1706.03762v7",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "甲" }]
  }, { store });
  const paper = await store.getPaper("web");
  assert.equal(paper.sourceUrl, "https://arxiv.org/pdf/1706.03762v7");
  assert.equal(paper.arxiv.id, "1706.03762");
  assert.equal(paper.arxiv.version, "v7");
  assert.equal(paper.arxiv.key, "1706.03762v7");
  assert.equal(paper.fileName, undefined);

  await saveLibraryPage({
    hash: "local",
    title: "local.pdf",
    fileName: "local.pdf",
    sourceUrl: "file:///tmp/local.pdf",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "乙" }]
  }, { store });
  assert.equal((await store.getPaper("local")).sourceUrl, undefined);
  await saveLibraryPage({
    hash: "blobbed",
    title: "blob.pdf",
    sourceUrl: "blob:https://example.test/11111111-1111-1111-1111-111111111111",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "丙" }]
  }, { store });
  assert.equal((await store.getPaper("blobbed")).sourceUrl, undefined);

  await store.touchPaper("web", {
    sourceUrl: "https://arxiv.org/pdf/1234.5678",
    arxiv: { id: "1706.03762", version: "v7", key: "1706.03762v7" }
  });
  assert.equal((await store.getPaper("web")).arxiv.id, "1706.03762");

  const imported = await store.importBundle({
    format: LIBRARY_FORMAT,
    schema: LIBRARY_SCHEMA,
    papers: [{
      paper: {
        docHash: "file-import",
        title: "PDF 阅读 · imported.pdf",
        sourceUrl: "file:///tmp/imported.pdf",
        schema: LIBRARY_SCHEMA,
        rev: 1,
        updatedAt: 1,
        lastOpenedAt: 3
      },
      pages: []
    }]
  });
  assert.equal(imported.errors.length, 0);
  const row = await store.getPaper("file-import");
  assert.equal(row.title, "imported.pdf");
  assert.equal(row.sourceUrl, undefined);
  assert.equal(row.lastOpenedAt, 3);
});

test("opening prefers the local blob, then an injected download checked by hash, then a re-picked file", async () => {
  const before = fetchCalls;
  const { store } = memoryStore({ dbName: "f8-open" });
  const bytes = new Uint8Array([7, 8, 9, 10]);
  const hash = sha256HexOf(bytes);
  await saveLibraryPage({
    hash,
    title: "远程",
    sourceUrl: "https://example.test/paper.pdf",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "甲" }],
    source: new Blob([bytes], { type: "application/pdf" })
  }, { store });
  let downloads = 0;
  const local = await resolveLibraryOpen(hash, {
    store,
    fetch: async () => {
      downloads += 1;
      return { ok: true, arrayBuffer: async () => bytes.buffer };
    }
  });
  assert.equal(local.status, "local");
  assert.deepEqual(local.bytes, bytes);
  assert.equal(downloads, 0);

  await store.deletePaperData(hash);
  assert.equal((await resolveLibraryOpen(hash, { store })).status, "missing");
  assert.equal(await store.getSource(hash), null);

  const revived = await saveLibraryPage({
    hash: "pointer",
    title: "只有地址",
    sourceUrl: "https://arxiv.org/pdf/1706.03762",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "甲" }]
  }, { store });
  assert.equal(revived.source, "absent");
  const needs = await resolveLibraryOpen("pointer", { store });
  assert.equal(needs.status, "needs-network");
  assert.equal(needs.url, "https://arxiv.org/pdf/1706.03762");
  assert.equal(needs.arxivId, "1706.03762");
  assert.equal(fetchCalls, before);

  const body = new Uint8Array([3, 1, 4]);
  const good = sha256HexOf(body);
  await store.touchPaper(good, {
    title: "重下",
    pageCount: 1,
    origin: "native",
    opened: true,
    sourceUrl: "https://example.test/again.pdf"
  });
  const downloaded = await resolveLibraryOpen(good, {
    store,
    fetch: async (url) => {
      assert.equal(url, "https://example.test/again.pdf");
      return { ok: true, arrayBuffer: async () => body.slice().buffer };
    }
  });
  assert.equal(downloaded.status, "downloaded");
  assert.deepEqual(downloaded.bytes, body);

  const mismatch = await resolveLibraryOpen(good, {
    store,
    fetch: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer })
  });
  assert.equal(mismatch.status, "hash-mismatch");
  assert.equal(mismatch.via, "url");

  const file = await resolveLibraryOpen(good, { store, fileBytes: body });
  assert.equal(file.status, "file");
  const wrongFile = await resolveLibraryOpen(good, { store, fileBytes: new Uint8Array([1, 1]) });
  assert.equal(wrongFile.status, "hash-mismatch");
  assert.equal(wrongFile.via, "file");

  await store.touchPaper("nofile", { title: "无地址", pageCount: 1, origin: "native", opened: true });
  assert.equal((await resolveLibraryOpen("nofile", { store })).status, "needs-file");
  assert.equal((await resolveLibraryOpen("absent", { store })).status, "missing");
  const openedAbsent = await markLibraryOpened("absent", { store });
  assert.ok(openedAbsent && !openedAbsent.deletedAt);
  assert.equal(openedAbsent.pagesTranslated, 0);
  assert.equal((await store.getPages("absent")).length, 0);
  assert.equal(fetchCalls, before);
});

test("the original PDF stays out of the default export", async () => {
  const before = fetchCalls;
  const { store } = memoryStore({ dbName: "f8-export" });
  const bytes = new Uint8Array([80, 68, 70, 45, 70, 56]);
  await saveLibraryPage({
    hash: "exp",
    title: "导出",
    sourceUrl: "file:///tmp/secret.pdf",
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "甲" }],
    source: new Blob([bytes], { type: "application/pdf" })
  }, { store });
  const plain = await store.exportLibrary({ exportedAt: 1, appVersion: "0.0.0" });
  assert.equal(plain.papers[0].source, undefined);
  assert.equal(JSON.stringify(plain).includes("PDF-F8"), false);
  assert.equal(plain.papers[0].paper.sourceUrl, undefined);
  assert.equal(plain.papers[0].paper.sourceSize, bytes.byteLength);
  const withSource = await store.exportLibrary({
    exportedAt: 1,
    appVersion: "0.0.0",
    include: { sources: true, notes: false }
  });
  assert.equal(typeof withSource.papers[0].source.base64, "string");
  assert.equal(fetchCalls, before);
});

test("the viewer saves a Blob and a clean title, and the data panel reads sourceSize", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const saved = viewer.slice(viewer.indexOf("function rememberTranslation"), viewer.indexOf("function rememberSkipHole"));
  assert.match(saved, /libraryPayloadFields/);
  assert.doesNotMatch(saved, /sourceBase64/);
  assert.doesNotMatch(saved, /btoa\(/);
  const blobFn = viewer.slice(viewer.indexOf("function librarySourceBlob"), viewer.indexOf("function rememberLibraryOriginal"));
  assert.match(blobFn, /new Blob\(\[bytes\], \{ type: "application\/pdf" \}\)/);
  assert.match(blobFn, /libraryOriginalStored\.has\(hash\)/);
  assert.doesNotMatch(blobFn, /librarySourceSent/);
  assert.match(viewer, /librarySourceSent\.has\(hash\)/);
  assert.match(viewer, /librarySourceSent\.clear\(\)/);
  const adoptHead = viewer.slice(viewer.indexOf("async function adoptDoc"), viewer.indexOf("async function adoptDoc") + 800);
  assert.match(adoptHead, /librarySourceSent\.clear\(\)/);
  const adoptTail = viewer.slice(viewer.indexOf("syncZoomChip();"), viewer.indexOf("function shortTitle"));
  assert.match(adoptTail, /scheduleOpenedPdf\(docId\)/);
  assert.doesNotMatch(adoptTail, /await storeOpenedPdf/);
  const opened = viewer.slice(viewer.indexOf("function storeOpenedPdf"), viewer.indexOf("function scheduleOpenedPdf"));
  assert.doesNotMatch(opened, /librarySourceSent/);
  assert.doesNotMatch(opened, /rememberLibrarySourceAttempt/);
  assert.match(viewer, /openLibraryPdf\(/);
  const ensure = viewer.slice(viewer.indexOf("function ensureLibraryDocument"), viewer.indexOf("function savedTranslationForNav"));
  assert.doesNotMatch(ensure, /librarySourceSent\.add/);
  assert.doesNotMatch(ensure, /sourcePath/);
  const remember = viewer.slice(viewer.indexOf("function rememberLibrarySourceAttempt"), viewer.indexOf("function storeOpenedPdf"));
  assert.match(remember, /status !== "saved" && status !== "exists"/);
  assert.equal(viewer.includes("unlimitedStorage"), false);
  assert.equal(readFileSync(join(root, "manifest.json"), "utf8").includes("unlimitedStorage"), false);

  const panel = readFileSync(join(root, "options/data-panel.js"), "utf8");
  const loadSizes = panel.slice(panel.indexOf("async function loadSizes"), panel.indexOf("function estimateNow"));
  assert.match(loadSizes, /paper\.sourceSize/);
  assert.doesNotMatch(loadSizes, /getSource/);
});

test("two IndexedDB tabs recount together and leave lastOpenedAt alone", async () => {
  const factory = createIdbLibraryFactory();
  for (let seed = 1; seed <= 40; seed += 1) {
    const name = `f8-conc-${seed}`;
    const make = (id) => createLibraryStore({
      platform: { target: "idb", kv: createMemoryKv(), library: factory },
      persist: false,
      deviceId: id,
      now: () => 80 + seed,
      dbName: name
    });
    const a = make("a");
    const b = make("b");
    const hash = `c${seed}`;
    await a.touchPaper(hash, { title: "并发", pageCount: 2, origin: "native", opened: true });
    const opened = (await a.getPaper(hash)).lastOpenedAt;
    await Promise.all([
      a.putPage(hash, 1, { pairs: [{ translation: "甲" }] }),
      b.putPage(hash, 2, { pairs: [], skipped: true })
    ]);
    const paper = await b.getPaper(hash);
    const pages = await a.getPages(hash);
    assert.equal(paper.pagesTranslated, 2, `concurrent seed ${seed}`);
    assert.equal(paper.pagesTranslated, countTranslated(pages), `concurrent seed ${seed} recount`);
    assert.equal(paper.lastOpenedAt, opened, `concurrent seed ${seed} lastOpenedAt`);
    await factory.close(name);
  }
});

test("opening an untranslated PDF stores the paper and the original PDF", async () => {
  const { store } = memoryStore({ dbName: "f8-open-untranslated" });
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hash = sha256HexOf(bytes);
  const opened = await openLibraryPdf({
    hash,
    title: "PDF 阅读 · fresh.pdf",
    fileName: "fresh.pdf",
    sourceUrl: "https://user:pass@example.test/fresh.pdf?x=1#p=2",
    pageCount: 4,
    source: new Blob([bytes], { type: "application/pdf" })
  }, { store });
  assert.equal(opened.source, "saved");
  const paper = await store.getPaper(hash);
  assert.equal(paper.title, "fresh.pdf");
  assert.equal(paper.fileName, "fresh.pdf");
  assert.equal(paper.pageCount, 4);
  assert.equal(paper.pagesTranslated, 0);
  assert.ok(paper.lastOpenedAt > 0);
  assert.equal(paper.sourceUrl, "https://example.test/fresh.pdf?x=1");
  assert.equal((await store.getPages(hash)).length, 0);
  assert.deepEqual(new Uint8Array(await (await store.getSource(hash)).arrayBuffer()), bytes);
  const again = await openLibraryPdf({
    hash,
    source: new Blob([bytes], { type: "application/pdf" })
  }, { store });
  assert.equal(again.source, "exists");
  assert.equal((await store.getPaper(hash)).pagesTranslated, 0);
});

test("an old paper without a blob stores the original on open, and quota retries on the next open", async () => {
  const { store } = memoryStore({ dbName: "f8-backfill" });
  const bytes = new Uint8Array([8, 8, 8, 8]);
  const hash = sha256HexOf(bytes);
  await store.touchPaper(hash, { title: "134.pdf", pageCount: 2, origin: "native", opened: true });
  const existing = await store.getPaper(hash);
  assert.equal(libraryDocumentFromRecords(existing, [], [], "local").sourcePath, "idb");
  assert.equal(await store.getSource(hash), null);

  let quota = true;
  const original = store.putSource.bind(store);
  store.putSource = async (...args) => {
    if (quota) {
      const error = new Error("quota");
      error.name = "QuotaExceededError";
      throw error;
    }
    return original(...args);
  };
  const first = await openLibraryPdf({
    hash,
    title: "134.pdf",
    pageCount: 2,
    source: new Blob([bytes], { type: "application/pdf" })
  }, { store });
  assert.equal(first.source, "quota");
  assert.equal(first.paper?.docHash, hash);
  assert.equal(await store.getSource(hash), null);

  quota = false;
  const second = await openLibraryPdf({
    hash,
    title: "134.pdf",
    pageCount: 2,
    source: new Blob([bytes], { type: "application/pdf" })
  }, { store });
  assert.equal(second.source, "saved");
  assert.deepEqual(new Uint8Array(await (await store.getSource(hash)).arrayBuffer()), bytes);
  assert.equal((await store.getPaper(hash)).sourceSize, bytes.byteLength);
});

test("sourceUrl drops userinfo and fragment in the row, the list, the change log, and the export", async () => {
  const { store, library, dbName } = memoryStore({ dbName: "f8-url-secret" });
  const dirty = "https://user:secret@arxiv.org/pdf/1706.03762v7?x=1#page=2";
  const clean = "https://arxiv.org/pdf/1706.03762v7?x=1";
  await saveLibraryPage({
    hash: "cred",
    title: "带凭证",
    sourceUrl: dirty,
    pageCount: 1,
    page: 1,
    pairs: [{ translation: "甲" }]
  }, { store });
  assert.equal((await store.getPaper("cred")).sourceUrl, clean);

  const backend = await library.open(dbName, ANNOTATIONS_SCHEMA);
  await backend.put("papers", {
    docHash: "raw-url",
    schema: LIBRARY_SCHEMA,
    title: "旧地址",
    pageCount: 1,
    pagesTranslated: 0,
    lastOpenedAt: 4,
    createdAt: 4,
    updatedAt: 4,
    rev: 1,
    deviceId: "old",
    sourceUrl: dirty
  });
  await backend.put("changes", {
    collection: "papers",
    docHash: "raw-url",
    key: "raw-url",
    rev: 1,
    op: "put",
    at: 4,
    deviceId: "old",
    record: { docHash: "raw-url", sourceUrl: dirty }
  });
  const listed = await store.listPapers();
  assert.equal(listed.find((item) => item.docHash === "cred").sourceUrl, clean);
  assert.equal(listed.find((item) => item.docHash === "raw-url").sourceUrl, clean);
  assert.equal((await store.getPaper("raw-url")).sourceUrl, clean);
  assert.equal((await store.getPaper("raw-url")).lastOpenedAt, 4);
  const log = JSON.stringify(await store.changes(0));
  assert.equal(log.includes("user:secret"), false);
  assert.equal(log.includes("#page=2"), false);
  assert.equal(log.includes("?x=1"), true);
  const exported = await store.exportLibrary({ exportedAt: 1, appVersion: "0.0.0" });
  const body = JSON.stringify(exported);
  assert.equal(body.includes("user:secret"), false);
  assert.equal(body.includes("#page=2"), false);
  assert.equal(exported.papers.find((item) => item.paper.docHash === "raw-url").paper.sourceUrl, clean);
  assert.equal(exported.papers.find((item) => item.paper.docHash === "cred").paper.sourceUrl, clean);
});

test("sourceUrl drops userinfo, fragment, and sensitive query keys, and keeps an ordinary query", async () => {
  const cases = [
    {
      name: "userinfo",
      dirty: "https://user:secret@cdn.example/paper.pdf?x=1",
      clean: "https://cdn.example/paper.pdf?x=1",
      gone: ["user:secret"]
    },
    {
      name: "fragment",
      dirty: "https://cdn.example/paper.pdf?x=1#page=4",
      clean: "https://cdn.example/paper.pdf?x=1",
      gone: ["#page=4", "page=4"]
    },
    {
      name: "sensitive-query",
      dirty: "https://cdn.example/paper.pdf?x=1&token=sekret&sig=abc&X-Amz-Credential=AKIA&X-Amz-Signature=deadbeef",
      clean: "https://cdn.example/paper.pdf?x=1",
      gone: ["sekret", "sig=abc", "X-Amz-Credential", "X-Amz-Signature", "deadbeef", "AKIA"]
    },
    {
      name: "ordinary-query",
      dirty: "https://cdn.example/paper.pdf?x=1&lang=zh",
      clean: "https://cdn.example/paper.pdf?x=1&lang=zh",
      gone: []
    }
  ];
  for (const item of cases) {
    assert.equal(httpSourceUrl(item.dirty), item.clean, item.name);
  }
  const { store } = memoryStore({ dbName: "f8-url-query" });
  for (const item of cases) {
    await saveLibraryPage({
      hash: item.name,
      title: item.name,
      sourceUrl: item.dirty,
      pageCount: 1,
      page: 1,
      pairs: [{ translation: "甲" }]
    }, { store });
    assert.equal((await store.getPaper(item.name)).sourceUrl, item.clean, `${item.name} stored`);
  }
  const exported = await store.exportLibrary({ exportedAt: 1, appVersion: "0.0.0" });
  const body = JSON.stringify(exported);
  for (const item of cases) {
    const row = exported.papers.find((entry) => entry.paper.docHash === item.name);
    assert.equal(row.paper.sourceUrl, item.clean, `${item.name} export`);
    for (const secret of item.gone) assert.equal(body.includes(secret), false, `${item.name} export leaked`);
  }
  const listed = await store.listPapers();
  assert.equal(listed.find((paper) => paper.docHash === "ordinary-query").sourceUrl, "https://cdn.example/paper.pdf?x=1&lang=zh");
  const log = JSON.stringify(await store.changes(0));
  assert.equal(log.includes("sekret"), false);
  assert.equal(log.includes("user:secret"), false);
  assert.equal(log.includes("X-Amz-Signature"), false);
  assert.equal(log.includes("lang=zh"), true);
});

test("file and blob source URLs are stripped from the default export", async () => {
  const { store, library, dbName } = memoryStore({ dbName: "f8-export-local-url" });
  const backend = await library.open(dbName, ANNOTATIONS_SCHEMA);
  // The one-shot sweep runs first. These rows are inserted after the flag,
  // so only the export itself can strip them. Deleting that strip fails here.
  await store.touchPaper("arm", { title: "占位", pageCount: 1, origin: "native", opened: true });
  await store.listPapers();
  await backend.put("papers", {
    docHash: "file-row",
    schema: LIBRARY_SCHEMA,
    title: "本地",
    pageCount: 1,
    pagesTranslated: 0,
    lastOpenedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    rev: 1,
    deviceId: "old",
    sourceUrl: "file:///tmp/secret.pdf"
  });
  await backend.put("papers", {
    docHash: "blob-row",
    schema: LIBRARY_SCHEMA,
    title: "内存",
    pageCount: 1,
    pagesTranslated: 0,
    lastOpenedAt: 2,
    createdAt: 2,
    updatedAt: 2,
    rev: 1,
    deviceId: "old",
    sourceUrl: "blob:https://example.test/11111111-1111-1111-1111-111111111111"
  });
  const exported = await store.exportLibrary({ exportedAt: 1, appVersion: "0.0.0" });
  const body = JSON.stringify(exported);
  assert.equal(exported.papers.find((item) => item.paper.docHash === "file-row").paper.sourceUrl, undefined);
  assert.equal(exported.papers.find((item) => item.paper.docHash === "blob-row").paper.sourceUrl, undefined);
  assert.equal(body.includes("file:"), false);
  assert.equal(body.includes("blob:"), false);
  assert.equal((await store.getPaper("file-row")).sourceUrl, "file:///tmp/secret.pdf");
  assert.equal(String((await store.getPaper("blob-row")).sourceUrl).startsWith("blob:"), true);
});

test("an open that lands before migration keeps the legacy readout", async () => {
  const { store } = memoryStore({ dbName: "f8-open-then-migrate", now: () => 40 });
  const opened = await store.markOpened("readout-first", {
    title: "先打开",
    pageCount: 0,
    origin: "native"
  });
  assert.equal(opened.origin, "native");
  assert.equal(opened.readout, undefined);
  const openedAt = opened.lastOpenedAt;
  let gets = 0;
  const fetchLegacy = async () => {
    gets += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        title: "旧库",
        fileName: "old.pdf",
        pageCount: 0,
        readout: "旧导读",
        pages: []
      })
    };
  };
  const doc = await fetchLibraryDocument("readout-first", { store, fetch: fetchLegacy, sleep: () => {} });
  assert.equal(gets, 1);
  const paper = await store.getPaper("readout-first");
  assert.equal(paper.readout, "旧导读");
  assert.equal(paper.origin, "local-service");
  assert.equal(paper.fileName, "old.pdf");
  assert.equal(paper.title, "先打开");
  assert.equal(paper.lastOpenedAt, openedAt);
  assert.equal((await store.migrationStatus()).doneDocs.includes("readout-first"), true);
  assert.equal(doc.readout, "旧导读");
  const again = await fetchLibraryDocument("readout-first", {
    store,
    fetch: async () => {
      gets += 1;
      throw new Error("8765 was fetched again");
    },
    sleep: () => {}
  });
  assert.equal(gets, 1);
  assert.equal(again.readout, "旧导读");
});

test("putSource writes no blob when the paper was deleted in the same window", async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { store } = memoryStore({ dbName: "f8-orphan-seq" });
  await store.touchPaper("gone", { title: "删", pageCount: 1, origin: "native", opened: true });
  await store.putPage("gone", 1, { pairs: [{ translation: "甲" }] });
  await store.deletePaperData("gone");
  assert.equal(await store.putSource("gone", new Blob([bytes])), false);
  assert.equal(await store.getSource("gone"), null);

  await store.touchPaper("live", { title: "留", pageCount: 1, origin: "native", opened: true });
  assert.equal(await store.putSource("live", new Blob([bytes])), bytes.byteLength);
  assert.equal((await store.getSource("live")).size, bytes.byteLength);
  assert.equal((await store.getPaper("live")).sourceSize, bytes.byteLength);

  const factory = createIdbLibraryFactory();
  for (let round = 0; round < 20; round += 1) {
    const name = `f8-orphan-${round}`;
    const make = (id) => createLibraryStore({
      platform: { target: "idb", kv: createMemoryKv(), library: factory },
      persist: false,
      deviceId: id,
      now: () => 90 + round,
      dbName: name
    });
    const left = make("left");
    const right = make("right");
    await left.touchPaper("p", { title: "交错", pageCount: 1, origin: "native", opened: true });
    await left.putPage("p", 1, { pairs: [{ translation: "甲" }] });
    await Promise.all([
      left.deletePaperData("p"),
      right.putSource("p", new Blob([bytes], { type: "application/pdf" }))
    ]);
    const paper = await left.getPaper("p");
    const blob = await right.getSource("p");
    assert.ok(paper?.deletedAt, `round ${round} tombstone`);
    assert.equal(blob, null, `round ${round} orphan`);
    await factory.close(name);
  }
});

function stalePaper(docHash, extra = {}) {
  return {
    docHash,
    schema: LIBRARY_SCHEMA,
    title: "PDF 阅读 · stale.pdf",
    pageCount: 2,
    pagesTranslated: 0,
    lastOpenedAt: 3,
    createdAt: 3,
    updatedAt: 3,
    rev: 1,
    deviceId: "old",
    ...extra
  };
}

test("the first list or open recounts pagesTranslated that was left at 0", async () => {
  const listed = memoryStore({ dbName: "f8-recount-list" });
  const listedBackend = await listed.library.open(listed.dbName, ANNOTATIONS_SCHEMA);
  await listedBackend.put("papers", stalePaper("stale"));
  await listedBackend.put("papers", stalePaper("other", { lastOpenedAt: 4, rev: 2 }));
  await listedBackend.put("pages", {
    docHash: "stale",
    page: 1,
    schema: LIBRARY_SCHEMA,
    pairs: [{ translation: "有" }],
    rev: 1,
    updatedAt: 1,
    deviceId: "old"
  });
  await listedBackend.put("pages", {
    docHash: "other",
    page: 2,
    schema: LIBRARY_SCHEMA,
    pairs: [],
    skipped: true,
    rev: 1,
    updatedAt: 1,
    deviceId: "old"
  });
  const rows = await listed.store.listPapers();
  assert.equal(rows.find((item) => item.docHash === "stale").pagesTranslated, 1);
  assert.equal(rows.find((item) => item.docHash === "other").pagesTranslated, 1);
  const stale = await listed.store.getPaper("stale");
  assert.equal(stale.pagesTranslated, 1);
  assert.equal(stale.lastOpenedAt, 3);
  assert.equal(stale.title, "PDF 阅读 · stale.pdf");
  const rev = stale.rev;
  await listed.store.listPapers();
  assert.equal((await listed.store.getPaper("stale")).rev, rev);
  assert.equal((await listed.store.getPaper("other")).rev, 3);

  const opened = memoryStore({ dbName: "f8-recount-open" });
  const openedBackend = await opened.library.open(opened.dbName, ANNOTATIONS_SCHEMA);
  await openedBackend.put("papers", stalePaper("left"));
  await openedBackend.put("pages", {
    docHash: "left",
    page: 1,
    schema: LIBRARY_SCHEMA,
    pairs: [{ translation: "乙" }],
    rev: 1,
    updatedAt: 1,
    deviceId: "old"
  });
  const marked = await opened.store.markOpened("fresh");
  assert.equal(marked.pagesTranslated, 0);
  const left = await opened.store.getPaper("left");
  assert.equal(left.pagesTranslated, 1);
  assert.equal(left.lastOpenedAt, 3);
  const leftRev = left.rev;
  await opened.store.markOpened("fresh");
  assert.equal((await opened.store.getPaper("left")).rev, leftRev);
  assert.equal((await opened.store.getPaper("left")).pagesTranslated, 1);
});

test("500 seeds of open, write, skip, delete, and reopen across two tabs", async () => {
  const pool = ["open", "write", "skip", "delete", "reopen"];
  for (let seed = 1; seed <= 500; seed += 1) {
    try {
      const library = createMemoryLibraryFactory();
      const kv = createMemoryKv();
      let clock = 1000 + seed;
      const now = () => ++clock;
      const make = (id) => createLibraryStore({
        platform: { target: "memory", kv, library },
        persist: false,
        deviceId: id,
        now,
        dbName: "f8-seed"
      });
      const tabs = [make("tab-a"), make("tab-b")];
      const hash = `h${seed.toString(16).padStart(4, "0")}`;
      const bytes = new Uint8Array([seed & 255, (seed >> 8) & 255, 3, 4, 5]);
      const rng = mulberry32(seed);
      const script = ["open", "write", "skip", "write", "delete", "reopen", "write", "open"];
      while (script.length < 16) script.push(pool[Math.floor(rng() * pool.length)]);
      let pageSerial = 1;
      let named = false;
      let sourceLive = false;
      for (let step = 0; step < script.length; step += 1) {
        const tab = tabs[Math.floor(rng() * tabs.length)];
        const op = script[step];
        const before = await tabs[0].getPaper(hash);
        const liveBefore = Boolean(before && !before.deletedAt);
        const openedBefore = before?.lastOpenedAt;
        if (op === "open" || op === "reopen") {
          const marked = await tab.markOpened(hash);
          if (before?.deletedAt) assert.equal(marked, null);
          else if (!before) {
            assert.ok(marked && !marked.deletedAt);
            assert.equal(marked.pagesTranslated, 0);
            assert.ok(marked.lastOpenedAt > 0);
          } else {
            assert.ok(marked.lastOpenedAt > openedBefore);
          }
        } else if (op === "delete") {
          await tab.deletePaperData(hash);
          sourceLive = false;
        } else {
          named = true;
          sourceLive = true;
          const page = (pageSerial % 3) + 1;
          pageSerial += 1;
          const skipped = op === "skip";
          const blank = !skipped && step % 5 === 0;
          await saveLibraryPage({
            hash,
            title: `PDF 阅读 · paper-${seed}.pdf`,
            fileName: `paper-${seed}.pdf`,
            pageCount: 3,
            page,
            pairs: skipped || blank ? [] : [{ text: "a", translation: "译" }],
            ...(skipped ? { skipped: true } : {}),
            source: new Blob([bytes], { type: "application/pdf" })
          }, { store: tab });
        }
        const paper = await tabs[0].getPaper(hash);
        const pages = await tabs[1].getPages(hash);
        const live = Boolean(paper && !paper.deletedAt);
        if (op === "write" || op === "skip") {
          assert.ok(paper && !paper.deletedAt);
          if (liveBefore || before?.deletedAt) assert.equal(paper.lastOpenedAt, openedBefore);
          else assert.ok(paper.lastOpenedAt > 0);
        } else if (!liveBefore) {
          if (!before) {
            if (op === "open" || op === "reopen") {
              assert.ok(paper && !paper.deletedAt);
              assert.equal(paper.pagesTranslated, 0);
            } else {
              assert.equal(paper, null);
            }
          } else {
            assert.ok(paper.deletedAt);
            assert.equal(paper.lastOpenedAt, openedBefore);
          }
        } else if (op === "delete") {
          assert.equal(live, false);
        } else {
          assert.notEqual(paper.lastOpenedAt, openedBefore);
        }
        if (live) {
          assert.equal(paper.pagesTranslated, countTranslated(pages));
          if (named) {
            assert.equal(paper.title, `paper-${seed}.pdf`);
            assert.equal(paper.fileName, `paper-${seed}.pdf`);
          }
          const blob = await tabs[0].getSource(hash);
          if (sourceLive) {
            assert.equal(blob instanceof Blob, true);
            assert.equal(blob.size, bytes.byteLength);
            assert.equal(paper.sourceSize, bytes.byteLength);
            assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
          } else {
            assert.equal(blob, null);
          }
        } else {
          assert.equal(pages.length, 0);
          assert.equal(await tabs[0].getSource(hash), null);
          assert.equal((await tabs[0].listPapers()).some((item) => item.docHash === hash), false);
          if (paper) {
            assert.equal(paper.pagesTranslated, 0);
            assert.equal(paper.sourceSize || 0, 0);
          }
        }
        assert.equal(fetchCalls, 0);
      }
    } catch (error) {
      error.message = `seed ${seed}: ${error.message}`;
      throw error;
    }
  }
});
