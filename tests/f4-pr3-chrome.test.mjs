// Real Chrome paths for the library migration.
// A same-tab reopen must adopt the translations this tab already saved.
// A 2s IndexedDB open must not POST page 1, and translation must not sit
// out the 10s open deadline.
// A connection left open at v1 blocks the upgrade. Translation still has
// to arrive from the migration GET inside 2s.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { translatableBlocks } from "../lib/pdf-blocks.js";
import { currentLayoutVersion } from "../lib/pdf-layout-client.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { e2eLibrarySceneResetSource, storedLibraryPagesSource } from "./helpers/library-observe.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

installOwnedTmpGuard(["oi-pr3-chrome-", "com.google.Chrome.", ".com.google.Chrome."]);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const samplePath = join(root, "tests/fixtures/sample-m1.pdf");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function serveRepo(extra) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (extra) {
      const handled = extra(url, res);
      if (handled) return;
    }
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = resolve(root, rel);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      if (!statSync(file).isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(readFileSync(file));
    } catch {
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolveServer) => {
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
}

function launchChrome(userDataDir, scratchDir) {
  const child = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check"
  ], {
    detached: true,
    env: { ...process.env, TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  child.stderr.on("data", () => {});
  child.stdio[3].on("error", () => {});
  child.stdio[4].on("error", () => {});
  return child;
}

class PipeCdp {
  constructor(writeStream, readStream) {
    this.writeStream = writeStream;
    this.readStream = readStream;
    this.buf = Buffer.alloc(0);
    this.next = 1;
    this.pending = new Map();
    readStream.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.drain();
    });
  }

  drain() {
    while (this.buf.length) {
      const end = this.buf.indexOf(0);
      if (end < 0) return;
      const text = this.buf.subarray(0, end).toString("utf8");
      this.buf = this.buf.subarray(end + 1);
      if (!text) continue;
      const message = JSON.parse(text);
      if (message.id && this.pending.has(message.id)) {
        const { done, reject, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else done(message.result);
      }
    }
  }

  dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const body = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

async function withChrome(t, source, run) {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-pr3-chrome-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const handle = { child: null, cdp: null };
  t.after(async () => {
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source }, sessionId);
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 30000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`${label} timed out. last=${last}`);
  };
  return { origin, cdp, sessionId, evaluate, waitFor };
}

function holdV1OpenSource() {
  return `
  const oiRealOpen = indexedDB.open.bind(indexedDB);
  window.__oiHold = { ready: false, versionchange: false, sawBlocked: false, db: null, version: 0, shownAt: 0 };
  const oiHoldReq = oiRealOpen("oi-annotations", 1);
  oiHoldReq.onupgradeneeded = () => {
    const db = oiHoldReq.result;
    if (!db.objectStoreNames.contains("notes")) {
      const notes = db.createObjectStore("notes", { keyPath: "id" });
      notes.createIndex("byDoc", "docHash", { unique: false });
      notes.createIndex("byDocPage", ["docHash", "page"], { unique: false });
      notes.createIndex("byUpdated", "updatedAt", { unique: false });
    }
    if (!db.objectStoreNames.contains("docs")) db.createObjectStore("docs", { keyPath: "docHash" });
    if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta", { keyPath: "key" });
  };
  oiHoldReq.onsuccess = () => {
    const db = oiHoldReq.result;
    db.onversionchange = () => { window.__oiHold.versionchange = true; };
    window.__oiHold.db = db;
    window.__oiHold.ready = true;
    window.__oiHold.version = db.version;
  };
  const oiWatch = setInterval(() => {
    const text = document.getElementById("readerFlow")?.innerText || "";
    if (!text.includes("慢开已译")) return;
    window.__oiHold.shownAt = Date.now();
    clearInterval(oiWatch);
  }, 20);
  indexedDB.open = function(name, version) {
    window.__oiSlow.opens += 1;
    if (!window.__oiSlow.openAt) window.__oiSlow.openAt = Date.now();
    if (!(name === "oi-annotations" && typeof version === "number" && version > 1)) {
      return version == null ? oiRealOpen(name) : oiRealOpen(name, version);
    }
    const real = oiRealOpen(name, version);
    const stub = {};
    const hook = (field, fn) => {
      real[field] = (event) => {
        if (field === "onblocked") window.__oiHold.sawBlocked = true;
        try {
          if (field === "onsuccess" || field === "onupgradeneeded") stub.result = real.result;
          if (field === "onerror") stub.error = real.error;
        } catch { /* result throws until success */ }
        if (typeof fn === "function") fn.call(real, event);
      };
    };
    for (const field of ["onsuccess", "onerror", "onblocked", "onupgradeneeded"]) {
      let stored = null;
      Object.defineProperty(stub, field, {
        configurable: true,
        enumerable: true,
        get() { return stored; },
        set(fn) {
          stored = fn;
          hook(field, fn);
        }
      });
    }
    for (const field of ["result", "error"]) {
      Object.defineProperty(stub, field, {
        configurable: true,
        enumerable: true,
        get() { try { return real[field]; } catch { return undefined; } },
        set() {}
      });
    }
    real.addEventListener("blocked", () => { window.__oiHold.sawBlocked = true; });
    return stub;
  };`;
}

function chromeStub({ mode, slowOpenMs = 0, library = null, holdV1 = false }) {
  const libraryJson = JSON.stringify(library);
  return `(() => {
  const params = new URLSearchParams(location.search);
  if (!(params.get("oiAuto") || "")) return;
  ${e2eLibrarySceneResetSource()}
  const settings = {
    provider: "mymemory",
    providers: { mymemory: { email: "" } },
    pdfAutoTranslate: true,
    targetLang: "zh-CN",
    pdfLayout: { mode: ${JSON.stringify(mode)}, localBaseUrl: "http://127.0.0.1:8765" },
    batchSize: 8
  };
  window.__oiAuto = { messages: [], layouts: [] };
  window.__oiSlow = { opens: 0, openAt: 0, doneAt: 0 };
  const libraryBody = ${libraryJson};
  ${holdV1 ? holdV1OpenSource() : ""}
  ${!holdV1 && slowOpenMs > 0 ? `
  const oiDelayOpen = indexedDB.open.bind(indexedDB);
  indexedDB.open = function(name, version) {
    window.__oiSlow.opens += 1;
    if (!window.__oiSlow.openAt) window.__oiSlow.openAt = Date.now();
    const stub = { result: null, error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
    setTimeout(() => {
      let req;
      try {
        req = version == null ? oiDelayOpen(name) : oiDelayOpen(name, version);
      } catch (error) {
        stub.error = error;
        if (typeof stub.onerror === "function") stub.onerror({ target: stub });
        return;
      }
      for (const field of ["onsuccess", "onerror", "onblocked", "onupgradeneeded"]) {
        req[field] = (event) => {
          stub.result = req.result;
          stub.error = req.error;
          if (field === "onsuccess") window.__oiSlow.doneAt = Date.now();
          if (typeof stub[field] === "function") stub[field](event);
        };
      }
    }, ${slowOpenMs});
    return stub;
  };` : ""}
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/v1/layout")) {
      let body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch { body = {}; }
      window.__oiAuto.layouts.push(Number(body.page) || 0);
      return new Response(JSON.stringify({ layoutDetails: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/v1/library/")) {
      if (!libraryBody) return new Response("null", { status: 404, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(libraryBody), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("127.0.0.1:8765")) return new Response("ok", { status: 200 });
    return origFetch(input, init);
  };
  globalThis.chrome = {
    runtime: {
      id: "oi-e2e",
      getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
      sendMessage(message) {
        const type = message && message.type;
        if (type === "OI_GET_SETTINGS") return Promise.resolve({ settings });
        if (type === "OI_PDF_STRUCTURE") return Promise.resolve({ ok: false });
        if (type === "OI_ENSURE_GLMOCR") return Promise.resolve({ ok: true });
        if (type === "OI_TRANSLATE_BATCH") {
          const items = Array.isArray(message.items) ? message.items : [];
          const texts = Array.isArray(message.texts) ? message.texts : [];
          window.__oiAuto.messages.push({
            bypassCache: message.bypassCache === true,
            n: texts.length,
            head: String(texts[0] || "")
          });
          const translations = items.length
            ? items.map((item) => ({ bid: item.bid || "", translation: "同页已译:" + String(item.text || "") }))
            : texts.map((text) => "同页已译:" + String(text || ""));
          return Promise.resolve({ ok: true, translations });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get() { return Promise.resolve({}); },
        set() { return Promise.resolve(); }
      }
    }
  };
})();`;
}

const SNAPSHOT = `(() => JSON.stringify({
  text: document.getElementById("readerFlow")?.innerText || "",
  status: document.getElementById("status")?.textContent || "",
  doc: document.querySelector("#docStatus .doc-text")?.textContent || "",
  messages: (window.__oiAuto && window.__oiAuto.messages || []).length,
  bypass: (window.__oiAuto && window.__oiAuto.messages || []).filter((item) => item.bypassCache).length,
  layouts: (window.__oiAuto && window.__oiAuto.layouts) || [],
  openAt: window.__oiSlow && window.__oiSlow.openAt || 0,
  doneAt: window.__oiSlow && window.__oiSlow.doneAt || 0,
  now: Date.now()
}))()`;

async function sampleLibrary(version) {
  const bytes = readFileSync(samplePath);
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  const pages = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = stampLayoutBids(number, textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      }));
      const blocks = (built.blocks || []).map((block) => {
        const next = { ...block };
        delete next.mode;
        delete next.engine;
        delete next.source;
        return next;
      });
      const pairs = translatableBlocks(blocks).map((block) => ({
        id: block.id,
        ...(block.sourceId ? { sourceId: block.sourceId } : {}),
        ...(block.bid ? { bid: block.bid } : {}),
        text: block.text,
        sourceText: block.sourceText || block.text,
        translation: `慢开已译${block.bid || block.id}`,
        targetLang: "zh-CN",
        provider: "mymemory"
      }));
      pages.push({
        page: number,
        pairs,
        layoutVersion: version,
        layout: {
          protocol: "blocks-1",
          layoutVersion: version,
          textSource: "text-layer",
          blocks
        }
      });
    }
  } finally {
    await doc.destroy();
  }
  assert.ok(pages.some((page) => page.pairs.length > 0), "sample-m1 has no translatable block");
  return { title: "sample-m1", pageCount: pages.length, pages };
}

test("reopening the same PDF in the same tab adopts the saved translation", { timeout: 180000 }, async (t) => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const adopt = viewer.slice(viewer.indexOf("async function adoptDoc"), viewer.indexOf("function shortTitle"));
  const saved = viewer.slice(viewer.indexOf("async function savedTranslationFor"), viewer.indexOf("function savedPageStatus"));
  assert.match(adopt, /librarySourceSent\.clear\(\)/);
  assert.match(saved, /librarySourceSent\.has\(hash\)/);
  assert.doesNotMatch(saved, /librarySourceSent\.clear\(\)/);

  const session = await withChrome(t, chromeStub({ mode: "text-layer", library: null }), async () => {});
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  await session.cdp.send("Page.navigate", {
    url: `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=reopen`
  }, session.sessionId);
  await session.waitFor(`(() => {
    const text = document.getElementById("readerFlow")?.innerText || "";
    if (!text.includes("同页已译:")) return "";
    return "shown";
  })()`, "first open shows the translation", 90000);
  const stored = JSON.parse(await session.evaluate(`(async () => {
    ${storedLibraryPagesSource()}
    const pages = await oiStoredLibraryPages();
    return JSON.stringify(pages.map((page) => ({
      page: page.page,
      n: (page.pairs || []).length,
      head: String((page.pairs || [])[0]?.translation || "")
    })));
  })()`));
  assert.ok(stored.some((page) => String(page.head).includes("同页已译:")), JSON.stringify(stored));
  const before = JSON.parse(await session.evaluate(SNAPSHOT));
  assert.ok(before.messages > 0, "the first open pays for the translation");
  await session.evaluate(`(async () => {
    const src = new URLSearchParams(location.search).get("src");
    const res = await fetch(src);
    const file = new File([await res.blob()], "sample-m1.pdf", { type: "application/pdf" });
    const input = document.getElementById("file");
    const list = new DataTransfer();
    list.items.add(file);
    const status = document.getElementById("status");
    window.__oiAdopted = false;
    const obs = new MutationObserver(() => {
      if ((status.textContent || "").includes("原页已打开")) window.__oiAdopted = true;
    });
    obs.observe(status, { childList: true, characterData: true, subtree: true });
    input.files = list.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  await session.waitFor(`(() => {
    if (!window.__oiAdopted) return "";
    const text = document.getElementById("readerFlow")?.innerText || "";
    if (!text.includes("同页已译:")) return "";
    if ((window.__oiAuto.messages || []).length !== ${before.messages}) return "";
    return "adopted";
  })()`, "same-tab reopen adopts the saved translation", 30000);
  await sleep(2500);
  const after = JSON.parse(await session.evaluate(SNAPSHOT));
  assert.equal(after.messages, before.messages, `reopen paid again ${JSON.stringify(after)}`);
  assert.ok(after.text.includes("同页已译:"));
  assert.equal(after.layouts.includes(1), false);
});

test("a 2s slow open sends no page-1 layout POST and does not hold translation for 10s", { timeout: 180000 }, async (t) => {
  const version = await currentLayoutVersion();
  const library = await sampleLibrary(version);
  const session = await withChrome(t, chromeStub({
    mode: "local-ocr",
    slowOpenMs: 2000,
    library
  }), async () => {});
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  const started = Date.now();
  await session.cdp.send("Page.navigate", {
    url: `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=slow-open`
  }, session.sessionId);
  const shown = JSON.parse(await session.waitFor(`(() => {
    const text = document.getElementById("readerFlow")?.innerText || "";
    if (!text.includes("慢开已译")) return "";
    const openAt = window.__oiSlow && window.__oiSlow.openAt || 0;
    if (!openAt) return "";
    return JSON.stringify({
      elapsed: Date.now() - openAt,
      layouts: window.__oiAuto.layouts.slice(),
      messages: window.__oiAuto.messages.length,
      doneAt: window.__oiSlow.doneAt || 0
    });
  })()`, "slow open shows the migrated translation", 20000));
  assert.ok(shown.elapsed < 9000, `translation waited ${shown.elapsed}ms`);
  assert.equal(shown.layouts.includes(1), false, `page 1 POSTed ${JSON.stringify(shown.layouts)}`);
  assert.equal(shown.messages, 0, "the migrated page was translated again");
  await session.waitFor(`(() => ((window.__oiSlow && window.__oiSlow.doneAt) ? "open" : ""))()`, "slow open finishes", 15000);
  await sleep(400);
  const after = JSON.parse(await session.evaluate(SNAPSHOT));
  assert.ok(after.text.includes("慢开已译"));
  assert.equal(after.layouts.includes(1), false, `late open POSTed page 1 ${JSON.stringify(after.layouts)}`);
  assert.equal(after.messages, 0);
  assert.ok(after.doneAt - after.openAt >= 1800, `open was not slow (${after.doneAt - after.openAt}ms)`);
  assert.ok(Date.now() - started < 20000, `the page sat for ${Date.now() - started}ms`);
});

test("a held v1 connection does not hold the first translation for the blocked-open deadline", { timeout: 180000 }, async (t) => {
  const version = await currentLayoutVersion();
  const library = await sampleLibrary(version);
  const session = await withChrome(t, chromeStub({
    mode: "local-ocr",
    library,
    holdV1: true
  }), async () => {});
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  const started = Date.now();
  await session.cdp.send("Page.navigate", {
    url: `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=held-v1`
  }, session.sessionId);
  const shown = JSON.parse(await session.waitFor(`(() => {
    const hold = window.__oiHold;
    const openAt = window.__oiSlow && window.__oiSlow.openAt || 0;
    if (!hold || !hold.shownAt || !hold.versionchange || !openAt) return "";
    let alive = false;
    try {
      const names = Array.from(hold.db.objectStoreNames || []);
      if (names.length) hold.db.transaction(names, "readonly");
      alive = hold.db.version === 1;
    } catch { alive = false; }
    if (!alive) return "";
    return JSON.stringify({
      elapsed: hold.shownAt - openAt,
      layouts: window.__oiAuto.layouts.slice(),
      messages: window.__oiAuto.messages.length,
      version: hold.db.version,
      sawBlocked: hold.sawBlocked === true
    });
  })()`, "held v1 connection shows the migrated translation", 20000));
  assert.ok(shown.elapsed < 2000, `translation waited ${shown.elapsed}ms behind the blocked upgrade`);
  assert.equal(shown.layouts.includes(1), false, `page 1 POSTed ${JSON.stringify(shown.layouts)}`);
  assert.equal(shown.messages, 0, "the migrated page was translated again");
  assert.equal(shown.version, 1);
  await sleep(500);
  const after = JSON.parse(await session.evaluate(`(() => {
    const hold = window.__oiHold;
    let alive = false;
    try {
      const names = Array.from(hold.db.objectStoreNames || []);
      if (names.length) hold.db.transaction(names, "readonly");
      alive = hold.versionchange === true && hold.db.version === 1;
    } catch { alive = false; }
    return JSON.stringify({
      alive,
      text: document.getElementById("readerFlow")?.innerText || "",
      messages: window.__oiAuto.messages.length,
      layouts: window.__oiAuto.layouts.slice()
    });
  })()`));
  assert.equal(after.alive, true);
  assert.ok(after.text.includes("慢开已译"));
  assert.equal(after.messages, 0);
  assert.equal(after.layouts.includes(1), false, `late block POSTed page 1 ${JSON.stringify(after.layouts)}`);
  assert.ok(Date.now() - started < 20000, `the page sat for ${Date.now() - started}ms`);
});

test("Stop during a page-2 re-zone sends no layout POST, and retranslate of that page zones once", { timeout: 180000 }, async (t) => {
  const version = await currentLayoutVersion();
  const library = await sampleLibrary(version);
  const pageTwo = library.pages.find((page) => page.page === 2);
  assert.ok(pageTwo, "sample-m1 has no page 2");
  pageTwo.layoutVersion = version;
  pageTwo.layout.layoutVersion = version;
  pageTwo.layout.fallback = { source: "text-layer", reason: "http-502" };
  const session = await withChrome(t, chromeStub({ mode: "local-ocr", library }), async () => {});
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  await session.cdp.send("Page.navigate", {
    url: `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=stop-zone`
  }, session.sessionId);
  const clicked = JSON.parse(await session.evaluate(`(async () => {
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const button = document.getElementById("stopTranslate");
      if (button && !button.hidden && !button.disabled) {
        const layouts = (window.__oiAuto && window.__oiAuto.layouts || []).slice();
        button.click();
        return JSON.stringify({ waited: Date.now() - started, layouts });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return JSON.stringify({ error: "stop button did not appear", layouts: (window.__oiAuto && window.__oiAuto.layouts) || [] });
  })()`));
  assert.equal(clicked.error || "", "");
  assert.equal(clicked.layouts.includes(2), false, `page 2 POSTed before Stop ${JSON.stringify(clicked)}`);
  await sleep(3000);
  const held = JSON.parse(await session.evaluate(SNAPSHOT));
  assert.deepEqual(held.layouts.filter((page) => page === 2), [], `Stop still POSTed page 2 ${JSON.stringify(held.layouts)}`);
  const stored = JSON.parse(await session.evaluate(`(async () => {
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const store = sharedLibraryStore();
    const papers = await store.listPapers();
    const rows = [];
    for (const paper of papers || []) {
      const layouts = typeof store.listLayouts === "function" ? await store.listLayouts(paper.docHash) : [];
      for (const row of layouts || []) {
        if (Number(row.page) !== 2) continue;
        rows.push({
          mode: String(row.mode || ""),
          reason: String(row.layout && row.layout.fallback && row.layout.fallback.reason || "")
        });
      }
    }
    return JSON.stringify(rows);
  })()`));
  assert.ok(stored.some((row) => row.reason === "http-502"), `page 2 lost its fallback ${JSON.stringify(stored)}`);
  assert.equal(stored.some((row) => row.mode === "local-ocr" && row.reason !== "http-502"), false, `Stop wrote a local-ocr row ${JSON.stringify(stored)}`);
  const capsule = await session.evaluate(`(async () => {
    const started = Date.now();
    let block = null;
    while (Date.now() - started < 8000) {
      block = document.querySelector('#readerFlow .rf-block[data-src-page="2"]');
      if (block) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!block) return "";
    const before = (window.__oiAuto.layouts || []).slice();
    document.getElementById("sourceNext")?.click();
    const pane = document.getElementById("translateScroll");
    const box = block.getBoundingClientRect();
    const paneBox = pane.getBoundingClientRect();
    pane.scrollTop += box.top - (paneBox.top + paneBox.height * 0.3);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return JSON.stringify({
      capsule: document.getElementById("pageCapsule")?.dataset.srcPage || "",
      layouts: before
    });
  })()`);
  const moved = JSON.parse(capsule || "null");
  assert.equal(moved.capsule, "2", `page 2 is not the current page ${capsule}`);
  assert.equal(moved.layouts.includes(2), false, `opening page 2 POSTed ${JSON.stringify(moved.layouts)}`);
  const afterMove = JSON.parse(await session.evaluate(SNAPSHOT));
  assert.deepEqual(afterMove.layouts.filter((page) => page === 2), [], `page turn POSTed page 2 ${JSON.stringify(afterMove.layouts)}`);
  const zoned = JSON.parse(await session.evaluate(`(async () => {
    const button = document.getElementById("retranslatePage");
    if (!button || button.disabled) return JSON.stringify({ error: "retranslate disabled" });
    button.click();
    const started = Date.now();
    while (Date.now() - started < 15000) {
      const layouts = (window.__oiAuto.layouts || []).filter((page) => page === 2);
      if (layouts.length) return JSON.stringify({ layouts: window.__oiAuto.layouts.slice() });
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return JSON.stringify({ layouts: (window.__oiAuto.layouts || []).slice(), error: "no post" });
  })()`));
  assert.deepEqual(zoned.layouts.filter((page) => page === 2), [2], `retranslate zoned ${JSON.stringify(zoned)}`);
  await sleep(1500);
  const settled = JSON.parse(await session.evaluate(SNAPSHOT));
  assert.deepEqual(settled.layouts.filter((page) => page === 2), [2], `retranslate zoned more than once ${JSON.stringify(settled.layouts)}`);
});
