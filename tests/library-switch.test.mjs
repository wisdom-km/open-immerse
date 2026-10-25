/**
 * Switch-while-translating.
 *
 * Repro on cb9425a, before this change (simulated old control flow, not a live
 * PDF worker). adoptDoc awaited pdfDoc.destroy() before abortTranslateSession,
 * and openRow returned "busy" while openingHash was set:
 *
 *   openRow(B) entered
 *   → adoptDoc(B) destroy BEFORE abort
 *   → destroy waiting for in-flight getPage/translate
 *   → openRow(C) swallowed, openingHash=B
 *   → second click result busy
 *   → user still stuck pdfBusy=true destroyed=false
 *   → translation worker finished
 *   → destroy resolved
 *   → abort too late
 *   → openRow(B) opened and openingHash cleared
 *
 * The fix aborts and stops before destroy, races destroy at 1500ms, and lets
 * the last click win with a generation token. openingHash is gone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";
import { mountLibraryUi } from "../pdf/library-panel.js";
import {
  LIBRARY_AUTO_PAUSED_KEY,
  clearLibraryAutoPaused,
  libraryResumePlan,
  readLibraryAutoPaused,
  settleLibraryAutoPause,
  writeLibraryAutoPaused
} from "../lib/library-auto-pause.js";
import { firstUnfinishedPage, waitAtMost } from "../lib/library-layout.js";
import { LIBRARY_COPY } from "../lib/library-copy.js";
import {
  abortTranslateSession,
  createTranslateSession,
  translateDocumentPages,
  translatePageBlocks
} from "../lib/pdf-viewer.js";
import { createTranslateAbortRegistry } from "../lib/translate-abort.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const read = (rel) => readFileSync(resolve(root, rel), "utf8");

function memoryArea() {
  const bag = {};
  return {
    async get(key) {
      return { [key]: bag[key] };
    },
    async set(patch) {
      Object.assign(bag, patch);
    }
  };
}

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
    }
  };
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function panelDom() {
  const parsed = parseHTML("<!doctype html><button id='libraryButton'>文献库</button><div id='sideSlot'></div>");
  let active = parsed.document.body;
  const proto = parsed.window.HTMLElement?.prototype;
  if (proto) {
    const orig = proto.focus;
    proto.focus = function focusShim() {
      active = this;
      if (typeof orig === "function") orig.call(this);
    };
  }
  Object.defineProperty(parsed.document, "activeElement", {
    configurable: true,
    get() { return active; }
  });
  return parsed;
}

function paper(partial) {
  return {
    docHash: "a",
    title: "Attention",
    fileName: "attention.pdf",
    pageCount: 4,
    lastOpenedAt: Date.UTC(2026, 9, 26, 2, 1),
    sourceSize: 9.18 * 1024 * 1024,
    sourceUrl: "",
    ...partial
  };
}

function blobOf(bytes) {
  return {
    size: bytes.byteLength,
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    }
  };
}

test("library.autoPaused stays in session and out of sync and export", async () => {
  const session = memoryArea();
  const sync = memoryArea();
  const storage = { session, sync };
  const written = await writeLibraryAutoPaused(storage, "doc-a", {
    resumePage: 3,
    phase: "auto-paused",
    at: 50
  });
  assert.equal(written.phase, "auto-paused");
  assert.equal(written.resumePage, 3);
  assert.equal(written.mode, "document");
  assert.equal(written.anchorPage, 1);
  const map = await readLibraryAutoPaused(storage);
  assert.equal(map["doc-a"].docHash, "doc-a");
  assert.equal((await sync.get(LIBRARY_AUTO_PAUSED_KEY))[LIBRARY_AUTO_PAUSED_KEY], undefined);
  assert.equal(await clearLibraryAutoPaused(storage, "doc-a"), true);
  assert.deepEqual(await readLibraryAutoPaused(storage), {});
  await assert.rejects(() => writeLibraryAutoPaused({ sync }, "doc-a", { resumePage: 1 }));
  assert.equal((await sync.get(LIBRARY_AUTO_PAUSED_KEY))[LIBRARY_AUTO_PAUSED_KEY], undefined);
  assert.doesNotMatch(read("lib/library-store.js"), /library\.autoPaused/);
  assert.equal(firstUnfinishedPage([{ page: 1, done: true }, { page: 2, done: false }], 4), 2);
});

test("destroy wait resolves timeout at 1500ms and does not cancel the destroy", async () => {
  let timer = null;
  const clocks = {
    setTimeout(fn, ms) {
      timer = { fn, ms };
      return 1;
    },
    clearTimeout() { timer = null; }
  };
  let destroyed = false;
  const hanging = new Promise((resolve) => {
    clocks.finish = () => {
      destroyed = true;
      resolve();
    };
  });
  const pending = waitAtMost(hanging, 1500, clocks);
  assert.equal(timer.ms, 1500);
  timer.fn();
  assert.equal(await pending, "timeout");
  assert.equal(destroyed, false);
  clocks.finish();
  assert.equal(destroyed, true);
});

test("abort stops the viewer batch and the service-worker fetch signal", async () => {
  const session = createTranslateSession();
  const seen = [];
  let release = null;
  const pending = translatePageBlocks([{ bid: "b1", original: "Hello" }], {
    session,
    batchSize: 1,
    send: () => new Promise((resolve) => { release = resolve; }),
    onAbortRequest: (id) => seen.push(id)
  });
  await Promise.resolve();
  abortTranslateSession(session);
  const out = await pending;
  assert.equal(out.aborted, true);
  assert.equal(out.results[0].translation, "");
  assert.equal(seen.length, 1);
  release?.({ ok: true, translations: ["你好"] });

  const registry = createTranslateAbortRegistry();
  const controller = registry.begin("req-1");
  registry.abort("req-1");
  assert.equal(controller.signal.aborted, true);
  assert.equal(registry.has("req-1"), false);
  const all = registry.begin("req-2");
  registry.abort("");
  assert.equal(all.signal.aborted, true);

  const worker = read("background/service-worker.js");
  assert.match(worker, /case "OI_TRANSLATE_ABORT"/);
  assert.match(worker, /translateAbortRegistry\.abort\(message\.requestId \|\| ""\)/);
  assert.match(worker, /signal: controller\.signal/);
  assert.match(read("lib/providers.js"), /async function postJson\(url, body, headers = \{\}, signal\)/);
  assert.match(read("lib/providers.js"), /signal: ctx\.signal/);
});

test("viewer aborts before destroy, last click wins, and silent pause writes no status", () => {
  const viewer = read("pdf/viewer.js");
  assert.equal(viewer.includes("openingHash"), false);
  const adopt = viewer.slice(viewer.indexOf("async function adoptDoc"), viewer.indexOf("function shortTitle"));
  const abortAt = adopt.indexOf("abortTranslateSession(session)");
  const destroyAt = adopt.indexOf("previous.destroy()");
  assert.ok(abortAt > 0 && destroyAt > abortAt);
  assert.match(adopt, /waitAtMost\([\s\S]*LIBRARY_SWITCH_FALLBACK_MS\)/);
  assert.match(adopt, /abortInflightLayouts\(\)/);
  const head = viewer.slice(viewer.indexOf("async function adoptDoc"), viewer.indexOf("async function adoptDoc") + 800);
  assert.match(head, /librarySourceSent\.clear\(\)/);
  assert.match(head, /abortBackgroundFills\(\)/);
  const prep = viewer.slice(viewer.indexOf("async function prepareLibrarySwitch"), viewer.indexOf("async function applyLibraryResume"));
  assert.match(prep, /stopTranslateWork\(\{ silent: true \}\)/);
  assert.match(prep, /autoPauseNoted === current/);
  assert.doesNotMatch(prep, /setStatus\(/);
  assert.doesNotMatch(prep, /PDF_COPY\.stopped/);
  const stop = viewer.slice(viewer.indexOf("function stopTranslateWork"), viewer.indexOf("function libraryResumePage"));
  assert.match(stop, /if \(!silent\) \{\s*setStatus\(PDF_COPY\.stopped\);\s*renderArticle\(\);\s*updateTranslateControls\(\);/);
  assert.match(stop, /userPausedDocs\.add\(hash\)/);
  assert.match(stop, /clearLibraryAutoPaused/);
  assert.match(viewer, /if \(libraryResumePending\)/);
  assert.match(viewer, /if \(resume === "manual"\) docPhase = "stopped"/);
  assert.match(viewer, /onAbortRequest: translateAbortRequest/);
});

test("LIB-06/16/18/20/26/31 panel fills its rows, pauses without a prompt, and the last click wins", async () => {
  const { document } = panelDom();
  const timers = fakeTimers();
  const bytes = new Uint8Array([4, 5, 6, 7]);
  const papers = [
    paper({ docHash: "a", title: "A", pageCount: 4 }),
    paper({ docHash: "b", title: "B 很短", pageCount: 4 }),
    paper({ docHash: "c", title: "C".repeat(80), pageCount: 4 })
  ];
  const pages = {
    a: [{ page: 1, pairs: [{ translation: "一" }] }],
    b: [],
    c: []
  };
  const prepared = [];
  const opened = [];
  const releases = [];
  let column = 400;
  const ui = mountLibraryUi({
    slot: document.getElementById("sideSlot"),
    timers,
    now: () => Date.UTC(2026, 9, 26, 2, 1),
    width: () => 1440,
    columnWidth: () => column,
    skeletonMs: 300,
    clickDedupeMs: 300,
    store: async () => ({
      async listPapers() { return papers; },
      async getPages(hash) { return pages[hash] || []; },
      async usage() { return { byDoc: new Map(papers.map((row) => [row.docHash, row.sourceSize])) }; },
      async getSource() { return blobOf(bytes); },
      async getPaper(hash) { return papers.find((row) => row.docHash === hash) || null; }
    }),
    listNotes: async () => [],
    openHash: async () => "a",
    prepareSwitch: async (spec) => { prepared.push(spec.hash); },
    openBytes: (_bytes, _title, meta) => {
      opened.push(meta.hash);
      return new Promise((done) => {
        releases.push(() => done(meta.stale() ? false : true));
      });
    },
    toast: () => { throw new Error("no toast"); }
  });
  ui.open();
  await flush();
  assert.equal(ui.root.querySelector(".oi-lib-skeleton"), null);
  assert.equal(ui.root.querySelector(".oi-lib-storage")?.textContent, LIBRARY_COPY.storageLink);

  ui.setAutoPaused({
    b: { docHash: "b", resumePage: 2, phase: "auto-paused", at: 1 }
  });
  await flush();
  const paused = ui.root.querySelector('[data-lib-row="b"] .oi-lib-meta');
  assert.match(paused.textContent, /已暂停 · 0%/);
  assert.equal(paused.getAttribute("title"), paused.textContent);
  assert.equal(ui.root.querySelector('[data-lib-row="b"] button.oi-lib-paused'), null);
  assert.match(ui.root.querySelector('[data-lib-row="a"]').textContent, /正在阅读/);
  assert.doesNotMatch(ui.root.querySelector('[data-lib-row="a"] .oi-lib-meta').textContent, /已暂停/);

  const body = ui.root.querySelector(".oi-lib-body");
  body.scrollTop = 48;
  column = 320;
  ui.syncWidth();
  assert.equal(body.scrollTop, 48);
  assert.equal(ui.root.classList.contains("is-compact"), true);
  assert.equal(ui.root.querySelector(".oi-lib-open-pdf")?.getAttribute("aria-label"), LIBRARY_COPY.openPdf);
  for (const row of ui.root.querySelectorAll(".oi-lib-row")) {
    assert.equal(row.style.width || "", "");
  }
  assert.match(read("pdf/library-panel.css"), /\.oi-lib-row\s*\{[^}]*width:\s*100%/s);

  const current = ui.root.querySelector('[data-lib-row="a"] .oi-lib-open');
  current.click();
  await flush();
  assert.equal(ui.isOpen(), false);
  assert.deepEqual(prepared, []);
  assert.deepEqual(opened, []);

  ui.open();
  await flush();
  ui.root.querySelector('[data-lib-row="b"] .oi-lib-open').click();
  ui.root.querySelector('[data-lib-row="b"] .oi-lib-open').click();
  await flush();
  assert.deepEqual(prepared, ["b"]);
  assert.deepEqual(opened, ["b"]);
  ui.root.querySelector('[data-lib-row="c"] .oi-lib-open').click();
  await flush();
  assert.deepEqual(prepared, ["b", "c"]);
  assert.deepEqual(opened, ["b", "c"]);
  assert.equal(ui.root.querySelector('[data-lib-row="c"]')?.getAttribute("aria-busy"), "true");
  assert.equal(ui.root.querySelector('[data-lib-row="c"] .oi-lib-open')?.getAttribute("aria-disabled"), null);
  for (const done of releases) done();
  await flush();
  assert.equal(ui.isOpen(), false);
});

test("LIB-18 blank stays while a slow load is under 300ms, and blocked keeps the storage link", async () => {
  const { document } = panelDom();
  const timers = fakeTimers();
  let release = null;
  const ui = mountLibraryUi({
    slot: document.getElementById("sideSlot"),
    timers,
    width: () => 1024,
    columnWidth: () => 360,
    store: async () => {
      await new Promise((done) => { release = done; });
      return {
        async listPapers() { throw Object.assign(new Error("blocked"), { type: "blocked" }); },
        async getPages() { return []; },
        async usage() { return { byDoc: new Map() }; }
      };
    },
    listNotes: async () => [],
    openHash: async () => "",
    openBytes: async () => true
  });
  ui.open();
  await flush();
  assert.equal(ui.root.querySelector(".oi-lib-blank") != null, true);
  assert.equal(ui.root.querySelector(".oi-lib-skeleton"), null);
  timers.advance(300);
  assert.equal(ui.root.querySelectorAll(".oi-lib-skel-row").length, 3);
  release();
  await flush();
  assert.equal(ui.root.querySelector(".oi-lib-foot")?.hidden, false);
  assert.equal(ui.root.querySelector(".oi-lib-storage")?.textContent, "存储与备份 →");
  assert.match(ui.root.textContent, /重试/);
});

test("Enter after a settled open still opens the focused row inside the click dedupe window", async () => {
  const { document, window } = panelDom();
  const papers = [
    paper({ docHash: "hash-1", title: "第一篇", sourceSize: 0, lastOpenedAt: 3 }),
    paper({ docHash: "hash-2", title: "第二篇", sourceSize: 0, lastOpenedAt: 2 }),
    paper({ docHash: "hash-3", title: "第三篇", sourceSize: 0, lastOpenedAt: 1 })
  ];
  const ui = mountLibraryUi({
    slot: document.getElementById("sideSlot"),
    now: () => 1000,
    width: () => 1200,
    store: async () => ({
      async listPapers() { return papers; },
      async getPages() { return []; },
      async usage() { return { byDoc: new Map() }; },
      async getSource() { return null; },
      async getPaper(hash) { return papers.find((row) => row.docHash === hash) || null; }
    }),
    listNotes: async () => [],
    openHash: async () => "",
    openBytes: async () => true
  });
  ui.open();
  await flush();
  const press = (hash, key) => {
    const button = ui.root.querySelector(`[data-lib-row="${hash}"] .oi-lib-open`);
    button.focus();
    const event = new window.Event("keydown", { bubbles: true });
    event.key = key;
    button.dispatchEvent(event);
  };
  press("hash-3", "Enter");
  await flush();
  assert.equal(ui.root.querySelector(".oi-lib-repick")?.closest("[data-lib-row]")?.getAttribute("data-lib-row"), "hash-3");
  ui.root.querySelector(".oi-lib-repick")?.remove();
  press("hash-3", "Enter");
  await flush();
  assert.equal(ui.root.querySelector(".oi-lib-repick")?.closest("[data-lib-row]")?.getAttribute("data-lib-row"), "hash-3");
});

test("resume keeps the mode, starts at resumePage, and does not resend translated pages", async () => {
  const cases = [
    {
      mode: "document",
      resumePage: 3,
      translated: [4],
      pageCount: 5,
      start: 3,
      send: [3, 5]
    },
    {
      mode: "from-page",
      resumePage: 4,
      anchorPage: 3,
      translated: [3, 5],
      pageCount: 6,
      start: 4,
      send: [4, 6]
    }
  ];
  for (const item of cases) {
    const plan = libraryResumePlan({
      mode: item.mode,
      resumePage: item.resumePage,
      anchorPage: item.anchorPage
    }, {
      pageCount: item.pageCount,
      translatedPages: item.translated
    });
    assert.equal(plan.mode, item.mode);
    assert.equal(plan.startPage, item.start);
    assert.deepEqual(plan.sendPages, item.send);

    const requested = [];
    const sent = [];
    const rows = new Map(item.translated.map((page) => [
      page,
      [{ original: "Hello", translation: "你好", role: "paragraph" }]
    ]));
    const result = await translateDocumentPages({
      session: createTranslateSession(),
      cache: {
        get(_id, page) { return rows.get(page) || null; },
        set(_id, page, value) { rows.set(page, value); }
      },
      docId: "doc",
      numPages: item.pageCount,
      startPage: plan.startPage,
      batchSize: 4,
      targetLang: "zh-CN",
      getPageOriginals: async (page) => {
        requested.push(page);
        return [{ bid: `b${page}`, original: "Source" }];
      },
      send: async (message) => {
        sent.push((message.items || []).map((row) => row.bid));
        return {
          ok: true,
          translations: (message.items || []).map((row) => ({ bid: row.bid, translation: "译文" }))
        };
      }
    });
    assert.deepEqual(requested, item.send);
    assert.equal(sent.length, item.send.length);
    for (const page of item.translated) assert.equal(requested.includes(page), false);
    assert.equal(result.pages.some((entry) => entry.page < plan.startPage), false);
  }

  const viewer = read("pdf/viewer.js");
  const auto = viewer.slice(
    viewer.indexOf("async function maybeAutoTranslateDocument"),
    viewer.indexOf("async function startTranslate")
  );
  const branch = auto.slice(0, auto.indexOf("if (!pdfDoc || docPhase"));
  assert.match(branch, /mode: plan\.mode/);
  assert.match(branch, /startPage: plan\.startPage/);
  assert.match(branch, /anchorPage: plan\.anchorPage/);
  assert.doesNotMatch(branch, /startTranslate\(\)/);
  assert.match(auto, /await startTranslate\(\)/);
  const start = viewer.slice(
    viewer.indexOf("async function startTranslate"),
    viewer.indexOf("async function resolveBatchSize")
  );
  assert.match(start, /options\.mode === "from-page"/);
  assert.match(start, /translateWholeDocument\(\{ startPage, mode: libraryTranslateRun\.mode \}\)/);
  assert.match(viewer, /libraryResumePending = libraryResumePlan\(/);
  assert.match(viewer, /\$\("translatePage"\)\.addEventListener\("click", \(\) => startTranslate\(\)\)/);
  const pages = read("lib/pdf-viewer.js");
  const loop = pages.slice(
    pages.indexOf("export async function translateDocumentPages"),
    pages.indexOf("export function extractPageItems")
  );
  assert.match(loop, /for \(let page = startPage; page <= numPages; page\+\+\)/);
});

test("a hung library.autoPaused write times out at 1500ms and the switch still continues", async () => {
  const timers = fakeTimers();
  let writes = 0;
  const area = {
    async get() { return {}; },
    set() {
      writes += 1;
      return new Promise(() => {});
    }
  };
  let status = "";
  const pending = settleLibraryAutoPause(area, "doc-a", {
    resumePage: 4,
    mode: "from-page",
    anchorPage: 3
  }, 1500, timers).then((result) => {
    status = result.status;
    return result;
  });
  await flush();
  assert.equal(writes, 1);
  timers.advance(1499);
  await flush();
  assert.equal(status, "");
  timers.advance(1);
  const result = await pending;
  assert.equal(result.status, "timeout");
  assert.equal(result.record, null);

  const stored = await settleLibraryAutoPause(memoryArea(), "doc-b", {
    resumePage: 4,
    mode: "from-page",
    anchorPage: 3,
    at: 8
  });
  assert.equal(stored.status, "done");
  assert.equal(stored.record.mode, "from-page");
  assert.equal(stored.record.anchorPage, 3);
  assert.equal(stored.record.resumePage, 4);
  const failed = await settleLibraryAutoPause({ sync: memoryArea() }, "doc-c", { resumePage: 2 });
  assert.equal(failed.status, "failed");

  const prep = read("pdf/viewer.js").slice(
    read("pdf/viewer.js").indexOf("async function prepareLibrarySwitch"),
    read("pdf/viewer.js").indexOf("async function applyLibraryResume")
  );
  assert.match(prep, /settleLibraryAutoPause\(/);
  assert.match(prep, /LIBRARY_SWITCH_FALLBACK_MS/);
  assert.match(prep, /stopTranslateWork\(\{ silent: true \}\)/);
  assert.match(read("lib/library-auto-pause.js"), /waitAtMost\(writing, ms, timers\)/);
});
