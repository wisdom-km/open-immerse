import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import {
  abortTranslateSession,
  createTranslateSession,
  documentRetranslateEntry,
  docStatusView,
  liveWorkPhase,
  pageRetranslateEntry,
  rememberRushPage,
  retranslateMenuBox,
  retranslateSplitChrome,
  rushRetranslateLive,
  takeRushPage,
  translateDocumentPages,
  translatePageBlocks
} from "../lib/pdf-viewer.js";
import { readerToolbarChrome } from "../lib/pdf-pairing.js";
import { LIBRARY_COPY, libraryProgressCopy, libraryRowStatus } from "../lib/library-copy.js";
import { mountLibraryUi } from "../pdf/library-panel.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "pdf/viewer.html"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const panel = readFileSync(join(root, "pdf/library-panel.js"), "utf8");
const drawer = readFileSync(join(root, "pdf/drawer-panel.js"), "utf8");

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

test("RTA-01 caret stays the right segment of 重译本页 in idle, translating, and failed", () => {
  const splitAt = html.indexOf('id="retranslateSplit"');
  const pageAt = html.indexOf('id="retranslatePage"', splitAt);
  const caretAt = html.indexOf('id="retranslateMenuButton"', splitAt);
  const crossAt = html.indexOf('id="retranslateStop"', splitAt);
  const menuAt = html.indexOf('id="retranslateMenu"', splitAt);
  assert.ok(pageAt > splitAt && caretAt > pageAt && crossAt > caretAt && menuAt > crossAt);
  assert.ok(html.indexOf('id="stopTranslate"') < splitAt);
  assert.equal(html.slice(splitAt, menuAt).includes('id="stopTranslate"'), false);
  assert.match(css, /\.retranslate-split\s*\{[^}]*box-shadow:\s*inset 0 0 0 1px var\(--oi-reader-border\)/);
  assert.match(css, /\.retranslate-caret\s*\{[^}]*width:\s*24px/);
  assert.match(css, /border-left:\s*1px solid var\(--oi-reader-border\)/);
  assert.match(css, /\.toolbar #retranslateSplit \.retranslate-caret\s*\{[^}]*border-radius:\s*0 var\(--oi-reader-topbar-btn-radius\)/);
  assert.match(css, /\.toolbar\[data-band="wide"\] \[data-grp="translate"\] > \.more-wrap\s*\{[^}]*display:\s*none/);
  for (const label of ["idle", "failed"]) {
    const chrome = retranslateSplitChrome({ hasDoc: true, busy: false, scope: "", canRetranslatePage: true });
    assert.equal(chrome.caretHidden, false, label);
    assert.equal(chrome.caretDisabled, false, label);
    assert.equal(chrome.primaryStopHidden, true, label);
    assert.equal(chrome.stopRetranslateHidden, true, label);
  }
  const translating = retranslateSplitChrome({ hasDoc: true, busy: true, scope: "", canRetranslatePage: true });
  assert.equal(translating.caretHidden, false);
  assert.equal(translating.caretDisabled, false);
  assert.equal(translating.primaryStopHidden, false);
  assert.equal(translating.stopRetranslateHidden, true);
  const retranslating = retranslateSplitChrome({ hasDoc: true, busy: true, scope: "document", canRetranslatePage: true });
  assert.equal(retranslating.caretHidden, true);
  assert.equal(retranslating.stopRetranslateHidden, false);
  assert.equal(retranslating.primaryStopHidden, true);
});

test("RTA-02 menu sits 4px under the split, start-aligned, and flips when the right edge is short", () => {
  const moreAt = css.indexOf(".more-menu {");
  const anchorAt = css.indexOf(".retranslate-split > .retranslate-menu.more-menu {");
  assert.ok(anchorAt > moreAt);
  const anchor = css.slice(anchorAt, css.indexOf(".retranslate-split > .retranslate-menu.more-menu.is-align-end"));
  assert.match(anchor, /top:\s*calc\(100% \+ 4px\)/);
  assert.match(anchor, /inset-inline-start:\s*0/);
  assert.match(anchor, /inset-inline-end:\s*auto/);
  assert.match(anchor, /min-width:\s*100%/);
  assert.match(viewer, /function placeRetranslateMenu/);
  assert.match(viewer, /retranslateMenuBox\(/);
  const open = retranslateMenuBox({
    buttonLeft: 400,
    buttonRight: 520,
    buttonBottom: 48,
    buttonWidth: 120,
    menuWidth: 180,
    viewportWidth: 1000,
    gap: 4
  });
  assert.equal(open.top, 52);
  assert.equal(open.left, 400);
  assert.equal(open.align, "start");
  assert.ok(open.minWidth >= 120);
  assert.ok(open.maxWidth >= open.minWidth);
  const tight = retranslateMenuBox({
    buttonLeft: 700,
    buttonRight: 820,
    buttonBottom: 40,
    buttonWidth: 120,
    menuWidth: 200,
    viewportWidth: 840,
    gap: 4
  });
  assert.equal(tight.top, 44);
  assert.equal(tight.align, "end");
  assert.ok(Math.abs(tight.left + tight.maxWidth - 820) <= 1);
  assert.ok(tight.left >= 0);
  assert.ok(tight.left + tight.maxWidth <= 840);
  assert.ok(tight.minWidth >= 120);
  const clamped = retranslateMenuBox({
    buttonLeft: 10,
    buttonRight: 70,
    buttonBottom: 30,
    buttonWidth: 60,
    menuWidth: 500,
    viewportWidth: 200,
    gap: 4
  });
  assert.equal(clamped.align, "end");
  assert.ok(clamped.left >= 0);
  assert.ok(clamped.left + clamped.maxWidth <= 200);
});

test("RTA-03 both menu items stay enabled during translation, with the stop-then-restart note", () => {
  const translating = retranslateSplitChrome({ hasDoc: true, busy: true, scope: "", canRetranslatePage: true });
  assert.equal(translating.pageItemDisabled, false);
  assert.equal(translating.docItemDisabled, false);
  assert.equal(translating.docNote, "会先停止当前翻译，再从第 1 页重译");
  assert.match(html, /id="retranslateDocumentNote"[^>]*>从第 1 页起重新翻译所有页</);
  assert.match(viewer, /docNote\.textContent = chrome\.docNote/);
  assert.match(viewer, /pageItem\.disabled = chrome\.pageItemDisabled/);
  assert.match(viewer, /docItem\.disabled = chrome\.docItemDisabled/);
  const idle = retranslateSplitChrome({ hasDoc: true, busy: false, scope: "", canRetranslatePage: true });
  assert.equal(idle.docNote, "从第 1 页起重新翻译所有页");
  const running = retranslateSplitChrome({ hasDoc: true, busy: true, scope: "page", canRetranslatePage: true });
  assert.equal(running.pageItemDisabled, true);
  assert.equal(running.docItemDisabled, true);
});

test("RTA-04 重译全文 stops the in-flight request and restarts at page 1 without confirm", async () => {
  const plan = documentRetranslateEntry({ busy: true, retranslating: false });
  assert.equal(plan.action, "stop-then-start");
  assert.equal(plan.confirm, false);
  assert.equal(plan.startPage, 1);
  assert.equal(plan.forceAll, true);
  assert.equal(documentRetranslateEntry({ busy: false }).confirm, false);
  assert.equal(documentRetranslateEntry({ busy: true, retranslating: true }).action, "ignore");
  const docForce = viewer.slice(
    viewer.indexOf("async function forceRetranslateDocument"),
    viewer.indexOf("async function forceRetranslateCurrentPage")
  );
  assert.match(docForce, /documentRetranslateEntry\(/);
  assert.match(docForce, /stopTranslateWork\(\{ silent: true \}\)/);
  assert.match(docForce, /forceAll: true/);
  assert.match(docForce, /startPage: 1/);
  assert.equal(docForce.includes("confirm("), false);
  const session = createTranslateSession();
  session.running = true;
  let abortId = "";
  const pending = translatePageBlocks([{ bid: "a", original: "Hello there." }], {
    session,
    preserveSession: true,
    onAbortRequest: (id) => { abortId = String(id || ""); },
    send: () => new Promise(() => {})
  });
  abortTranslateSession(session);
  const stopped = await pending;
  assert.equal(stopped.aborted, true);
  assert.ok(abortId);
  assert.equal(session.running, false);
});

test("RTA-05 重译本页 cuts in without aborting the document walk", async () => {
  const rush = pageRetranslateEntry({ busy: true, page: 4, canRetranslate: true });
  assert.deepEqual(rush, { action: "rush", page: 4, abortDocument: false });
  assert.equal(pageRetranslateEntry({ busy: true, retranslating: true, page: 4, canRetranslate: true }).action, "ignore");
  assert.match(viewer, /rememberRushPage\(rushQueue, plan\.page, rushInflight\)/);
  assert.equal(viewer.includes("queuedRushPage"), false);
  assert.match(viewer, /pullRushPage\(\)/);
  const started = [];
  let queued = 0;
  let releasePage1 = null;
  const session = createTranslateSession();
  const job = translateDocumentPages({
    numPages: 4,
    session,
    preserveSession: true,
    pullRushPage: () => {
      const page = queued;
      queued = 0;
      return page;
    },
    getPageOriginals: async (page) => [{ bid: `p${page}`, original: "Hello there." }],
    onPageStart: ({ page }) => { started.push(page); },
    send: (msg) => {
      const bid = msg.items?.[0]?.bid || "";
      if (bid === "p1") {
        queued = 3;
        return new Promise((resolve) => {
          releasePage1 = () => {
            assert.equal(session.aborted, false);
            resolve({ ok: true, translations: [{ bid: "p1", translation: "你好。" }] });
          };
        });
      }
      return Promise.resolve({ ok: true, translations: [{ bid, translation: "你好。" }] });
    }
  });
  await flush();
  assert.deepEqual(started, [1]);
  assert.equal(session.aborted, false);
  assert.equal(typeof releasePage1, "function");
  releasePage1();
  const result = await job;
  assert.equal(result.aborted, false);
  assert.equal(started[0], 1);
  assert.equal(started[1], 3);
  assert.equal(started[2], 2);
  assert.ok(started.includes(4));
  assert.equal(result.pages[0].page, 1);
  assert.equal(result.pages[0].results[0].translation, "你好。");
});

test("RTA-06 library row names translation and retranslate, and only a real PDF fetch says 正在下载 PDF", async () => {
  assert.equal(LIBRARY_COPY.downloading, "正在下载 PDF…");
  assert.equal(libraryProgressCopy(2, 9, { translating: true }), "翻译中 2/9");
  assert.equal(libraryProgressCopy(2, 9, { retranslate: true }), "重译中 2/9");
  assert.equal(libraryRowStatus({ live: { phase: "translating", n: 2, t: 9 } }).progress, "翻译中 2/9");
  assert.equal(libraryRowStatus({ live: { phase: "translating", n: 2, t: 9 } }).download, "");
  assert.equal(libraryRowStatus({ live: { phase: "retranslate", n: 3, t: 9 } }).progress, "重译中 3/9");
  assert.equal(libraryRowStatus({ downloading: true, translated: 1, total: 4 }).download, "正在下载 PDF…");
  assert.equal(libraryRowStatus({ translated: 1, total: 4, paused: true }).download, "");
  assert.equal(viewer.includes("正在重新下载"), false);
  assert.equal(panel.includes("正在重新下载"), false);
  assert.equal(drawer.includes("正在重新下载"), false);
  assert.match(viewer, /setLiveProgress\(/);
  assert.match(panel, /downloading: downloadingHash === row\.docHash/);

  const parsed = parseHTML("<!doctype html><button id='libraryButton'>文献库</button><div id='sideSlot'></div>");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const local = {
    size: bytes.byteLength,
    async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
  };
  const paper = {
    docHash: "paper",
    title: "Attention",
    fileName: "attention.pdf",
    pageCount: 9,
    lastOpenedAt: Date.UTC(2026, 9, 26, 8),
    sourceSize: 4,
    sourceUrl: ""
  };
  let releaseOpen = null;
  const ui = mountLibraryUi({
    slot: parsed.document.getElementById("sideSlot"),
    skeletonMs: 60_000,
    now: () => Date.UTC(2026, 9, 26, 12),
    store: async () => ({
      async listPapers() { return [paper]; },
      async getPages() { return []; },
      async usage() { return { byDoc: new Map([["paper", 4]]) }; },
      async getSource() { return local; },
      async getPaper() { return paper; }
    }),
    listNotes: async () => [],
    openHash: async () => "",
    openBytes: () => new Promise((resolve) => { releaseOpen = resolve; })
  });
  ui.open();
  await flush();
  ui.root.querySelector('[data-lib-row="paper"] .oi-lib-open').click();
  await flush();
  ui.setLiveProgress({ hash: "paper", phase: "translating", n: 2, t: 9 });
  let text = ui.root.querySelector('[data-lib-row="paper"]').textContent;
  assert.match(text, /翻译中 2\/9/);
  assert.equal(text.includes("正在下载 PDF"), false);
  assert.equal(text.includes("正在重新下载"), false);
  ui.setLiveProgress({ hash: "paper", phase: "retranslate", n: 3, t: 9 });
  text = ui.root.querySelector('[data-lib-row="paper"]').textContent;
  assert.match(text, /重译中 3\/9/);
  assert.equal(text.includes("正在下载 PDF"), false);
  releaseOpen?.(true);
  await flush();
});

test("翻译中只有一个重译菜单入口", () => {
  for (const width of [1400, 1000, 800]) {
    const chrome = readerToolbarChrome(width);
    assert.equal(Number(chrome.retranslateOnBar) + Number(chrome.translateMenuOnBar), 1, String(width));
  }
  const wide = readerToolbarChrome(1400);
  assert.equal(wide.retranslateOnBar, true);
  assert.equal(wide.translateMenuOnBar, false);
  assert.match(css, /\.toolbar\[data-band="wide"\] \[data-grp="translate"\] > \.more-wrap\s*\{[^}]*display:\s*none/);
  assert.match(html, /data-grp="retranslate"[^>]*data-collapse="wide-only"/);
  const band = viewer.slice(viewer.indexOf("function applyToolbarBand"), viewer.indexOf("function translateMenuOpen"));
  assert.match(band, /translateMore\.hidden = !chrome\.translateMenuOnBar/);
  const translating = retranslateSplitChrome({ hasDoc: true, busy: true, scope: "", canRetranslatePage: true });
  assert.equal(translating.caretHidden, false);
  assert.equal(translating.primaryStopHidden, false);
  assert.equal(translating.stopRetranslateHidden, true);
});

test("插队重译时工具栏和文献库行是重译中", () => {
  assert.equal(rushRetranslateLive({ queued: 0, inflight: 0 }), false);
  assert.equal(rushRetranslateLive({ queued: 2, inflight: 0 }), true);
  assert.equal(rushRetranslateLive({ queued: 0, inflight: 4 }), true);
  assert.equal(liveWorkPhase({ scope: "", rush: false }), "translating");
  assert.equal(liveWorkPhase({ scope: "", rush: true }), "retranslate");
  assert.equal(liveWorkPhase({ scope: "document", rush: false }), "retranslate");
  assert.equal(docStatusView({ n: 14, t: 15, phase: "running", retranslate: true }).text, "重译中 · 14/15");
  assert.equal(docStatusView({ n: 14, t: 15, phase: "running", retranslate: false }).text, "翻译中 · 14/15");
  assert.equal(libraryProgressCopy(14, 15, { retranslate: true }), "重译中 14/15");
  assert.match(viewer, /liveWorkPhase\(\{/);
  assert.match(viewer, /retranslate: retranslateScope === "document" \|\| rushCutInLive\(\)/);
  assert.match(viewer, /syncRushStatusLine\(plan\.page, pdfDoc\?\.numPages \|\| 0\)/);
  const controls = viewer.slice(viewer.indexOf("function updateTranslateControls"), viewer.indexOf("function setStatus"));
  assert.match(controls, /const rush = rushCutInLive\(\)/);
  assert.match(controls, /labelScope = retranslateScope \|\| \(rush \? "page" : ""\)/);
});

test("插队页完成后整本走到该页不再请求", async () => {
  const sent = [];
  let queue = [2];
  const done = await translateDocumentPages({
    numPages: 3,
    bypassCache: true,
    skipCached: false,
    pullRushPage: () => {
      const taken = takeRushPage(queue);
      queue = taken.queue;
      return taken.page;
    },
    getPageOriginals: async (page) => [{ bid: `p${page}`, original: "Hello there." }],
    send: async (msg) => {
      const bid = msg.items?.[0]?.bid || "";
      sent.push(bid);
      return { ok: true, translations: [{ bid, translation: "你好。" }] };
    }
  });
  assert.equal(done.aborted, false);
  assert.deepEqual(sent, ["p2", "p1", "p3"]);

  const retried = [];
  let again = [2];
  let failRush = true;
  await translateDocumentPages({
    numPages: 3,
    bypassCache: true,
    skipCached: false,
    pullRushPage: () => {
      const taken = takeRushPage(again);
      again = taken.queue;
      return taken.page;
    },
    getPageOriginals: async (page) => [{ bid: `p${page}`, original: "Hello there." }],
    send: async (msg) => {
      const bid = msg.items?.[0]?.bid || "";
      retried.push(bid);
      if (bid === "p2" && failRush) {
        failRush = false;
        return { ok: false, error: "nope", translations: [] };
      }
      return { ok: true, translations: [{ bid, translation: "你好。" }] };
    }
  });
  assert.equal(retried.filter((bid) => bid === "p2").length, 2);
});

test("连点多页重译本页按顺序入队并去重", async () => {
  assert.deepEqual(rememberRushPage([4], 4, 0), [4]);
  assert.deepEqual(rememberRushPage([4], 2, 4), [4, 2]);
  assert.deepEqual(rememberRushPage([4, 2], 4, 0), [4, 2]);
  assert.deepEqual(rememberRushPage([], 3, 3), []);
  const started = [];
  let queue = [];
  let release = null;
  const session = createTranslateSession();
  const job = translateDocumentPages({
    numPages: 4,
    session,
    preserveSession: true,
    pullRushPage: () => {
      const taken = takeRushPage(queue);
      queue = taken.queue;
      return taken.page;
    },
    getPageOriginals: async (page) => [{ bid: `p${page}`, original: "Hello there." }],
    onPageStart: ({ page }) => { started.push(page); },
    send: (msg) => {
      const bid = msg.items?.[0]?.bid || "";
      if (bid === "p1") {
        queue = rememberRushPage(queue, 4, 0);
        queue = rememberRushPage(queue, 2, 0);
        queue = rememberRushPage(queue, 4, 0);
        queue = rememberRushPage(queue, 3, 0);
        return new Promise((resolve) => {
          release = () => resolve({ ok: true, translations: [{ bid, translation: "你好。" }] });
        });
      }
      return Promise.resolve({ ok: true, translations: [{ bid, translation: "你好。" }] });
    }
  });
  await flush();
  assert.equal(typeof release, "function");
  release();
  const result = await job;
  assert.equal(result.aborted, false);
  assert.deepEqual(started, [1, 4, 2, 3]);
});

test("停止后立即重译全文，旧循环靠 generation 退出并不再写入", async () => {
  let generation = 1;
  const writes = [];
  const cache = {
    get() { return null; },
    set(_doc, page, rows) {
      writes.push({ page, text: rows?.[0]?.translation || "" });
    }
  };
  const session = createTranslateSession();
  const started = [];
  let release = null;
  const oldJob = translateDocumentPages({
    numPages: 3,
    session,
    preserveSession: true,
    docId: 7,
    generation,
    readGeneration: () => generation,
    cache,
    getPageOriginals: async (page) => [{ bid: `p${page}`, original: "Hello there." }],
    onPageStart: ({ page }) => { started.push(page); },
    send: (msg) => new Promise((resolve) => {
      release = () => resolve({
        ok: true,
        translations: [{ bid: msg.items?.[0]?.bid || "", translation: "旧译文" }]
      });
    })
  });
  await flush();
  assert.deepEqual(started, [1]);
  generation += 1;
  const nextWrites = [];
  const next = translateDocumentPages({
    numPages: 2,
    session: createTranslateSession(),
    preserveSession: true,
    docId: 7,
    generation,
    readGeneration: () => generation,
    bypassCache: true,
    cache: {
      get() { return null; },
      set(_doc, page, rows) {
        nextWrites.push({ page, text: rows?.[0]?.translation || "" });
      }
    },
    getPageOriginals: async (page) => [{ bid: `n${page}`, original: "Hello there." }],
    send: async (msg) => ({
      ok: true,
      translations: [{ bid: msg.items?.[0]?.bid || "", translation: "新译文" }]
    })
  });
  release();
  const oldResult = await oldJob;
  const newResult = await next;
  assert.equal(oldResult.aborted, true);
  assert.deepEqual(started, [1]);
  assert.equal(writes.some((row) => row.text === "旧译文"), false);
  assert.equal(newResult.aborted, false);
  assert.ok(nextWrites.some((row) => row.text === "新译文"));
  const stop = viewer.slice(viewer.indexOf("function stopTranslateWork"), viewer.indexOf("function libraryResumePage"));
  assert.match(stop, /restoreGen \+= 1/);
  assert.match(viewer, /readGeneration:\s*\(\)\s*=>\s*restoreGen/);
});
