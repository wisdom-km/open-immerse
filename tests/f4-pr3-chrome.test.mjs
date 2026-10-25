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
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
    if (url.pathname === "/oi-notes-probe.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end("<!doctype html><html><body></body></html>");
      return;
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

// Prefer the Chrome binary. The google-chrome wrapper injects a shared
// user-data-dir and --remote-debugging-port=9222, then a second cold start
// joins that instance and never reads the debugging pipe. The command
// timeout stays 20s; startup retries a short handshake instead of waiting longer.
function chromeExecutable() {
  const fromEnv = String(process.env.CHROME_BIN || process.env.CHROME_PATH || "").trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync("/opt/google/chrome/chrome")) return "/opt/google/chrome/chrome";
  return "google-chrome";
}

function launchChrome(userDataDir, scratchDir) {
  const env = { ...process.env, TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir };
  for (const key of ["http_proxy", "https_proxy", "all_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) {
    delete env[key];
  }
  const child = spawn(chromeExecutable(), [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check",
    "--no-proxy-server",
    "--proxy-bypass-list=*",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-breakpad",
    "--disable-hang-monitor",
    "--metrics-recording-only",
    "--password-store=basic",
    "--use-mock-keychain",
    "--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider"
  ], {
    detached: true,
    env,
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  const stderr = [];
  let stderrBytes = 0;
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk);
    stderrBytes += chunk.length;
    while (stderrBytes > 4096 && stderr.length > 1) stderrBytes -= stderr.shift().length;
  });
  child.stderrTail = () => Buffer.concat(stderr).toString("utf8").slice(-1500);
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
    this.events = [];
    this.eventWaiters = [];
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
        continue;
      }
      if (!message.method) continue;
      this.events.push(message);
      this.eventWaiters = this.eventWaiters.filter((waiter) => {
        if (!waiter.match(message)) return true;
        clearTimeout(waiter.timer);
        waiter.done(message);
        return false;
      });
    }
  }

  dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    for (const waiter of this.eventWaiters) clearTimeout(waiter.timer);
    this.pending.clear();
    this.eventWaiters = [];
  }

  waitFor(match, timeoutMs = 20000) {
    const existing = this.events.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.eventWaiters = this.eventWaiters.filter((waiter) => waiter.done !== done);
        reject(new Error("CDP event timed out"));
      }, timeoutMs);
      this.eventWaiters.push({ match, done, timer });
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const body = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

// A message written before Chrome reads the pipe is dropped by the client
// timer, then sent again. The per-command ceiling stays 20s.
async function waitForDebuggingPipe(cdp, child) {
  const deadline = Date.now() + 20000;
  let last = "chrome pipe was not ready";
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`chrome exited before the pipe was ready (${child.exitCode ?? child.signalCode}): ${child.stderrTail?.() || ""}`);
    }
    try {
      await cdp.send("Browser.getVersion", {}, undefined, 1000);
      return;
    } catch (error) {
      last = error?.message || String(error);
    }
  }
  throw new Error(`${last}; stderr=${child.stderrTail?.() || ""}`);
}

// Polling Runtime.evaluate before the document commits queues work ahead of
// the parser. Under a full suite that livelock reports a timeout on a page
// that never got to run. DOMContentLoaded is the commit point.
async function openPage(session, url) {
  const marker = new URL(url).pathname;
  let sawNavigation = false;
  const ready = session.cdp.waitFor((message) => {
    if (message.sessionId && message.sessionId !== session.sessionId) return false;
    if (message.method === "Page.frameNavigated") {
      const frame = message.params?.frame || {};
      if (!frame.parentId && String(frame.url || "").includes(marker)) sawNavigation = true;
      return false;
    }
    return sawNavigation && message.method === "Page.domContentEventFired";
  });
  await session.cdp.send("Page.navigate", { url }, session.sessionId);
  await ready;
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
  await waitForDebuggingPipe(cdp, handle.child);
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

function chromeStub({ mode, slowOpenMs = 0, library = null, holdV1 = false, layoutReply = "ok" }) {
  const libraryJson = JSON.stringify(library);
  return `(() => {
  const params = new URLSearchParams(location.search);
  if (!(params.get("oiAuto") || "")) return;
  ${e2eLibrarySceneResetSource()}
  const settings = {
    provider: "mymemory",
    providers: { mymemory: { email: "" } },
    pdfAutoTranslate: params.get("oiAutoTranslate") !== "0",
    targetLang: "zh-CN",
    pdfLayout: { mode: ${JSON.stringify(mode)}, localBaseUrl: "http://127.0.0.1:8765" },
    batchSize: 8
  };
  window.__oiAuto = { messages: [], layouts: [] };
  window.__oiHoldRasterMs = Number(params.get("oiHoldRaster") || 0);
  window.__oiSlow = { opens: 0, openAt: 0, doneAt: 0 };
  const libraryBody = ${libraryJson};
  ${holdV1 ? holdV1OpenSource() : ""}
  ${!holdV1 ? `
  const oiSlowMs = Number(params.get("oiSlowOpen") || "0") || ${Number(slowOpenMs) || 0};
  if (oiSlowMs > 0) {
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
    }, oiSlowMs);
    return stub;
  };
  }
` : ""}
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/v1/layout")) {
      let body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch { body = {}; }
      const page = Number(body.page) || 0;
      window.__oiAuto.layouts.push(page);
      window.__oiAuto.layoutAt = window.__oiAuto.layoutAt || [];
      window.__oiAuto.layoutAt.push({ page, at: Date.now() });
      window.__oiAuto.layoutFlights = window.__oiAuto.layoutFlights || [];
      const signal = init && init.signal;
      const flight = { page, aborted: Boolean(signal && signal.aborted) };
      if (signal && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", () => { flight.aborted = true; });
      }
      window.__oiAuto.layoutFlights.push(flight);
      window.__oiAuto.layoutStack = window.__oiAuto.layoutStack || [];
      window.__oiAuto.layoutStack.push(String(new Error("layout-post").stack || "").split("\\n").slice(0, 18).join("\\n"));
      const reply = ${JSON.stringify(layoutReply)};
      if (reply === "hang" && page === 2) {
        return new Promise((resolve, reject) => {
          const fail = () => reject(Object.assign(new Error("layout aborted"), { name: "AbortError", code: "aborted" }));
          if (signal && signal.aborted) return fail();
          if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", fail, { once: true });
        });
      }
      if (reply === "down") return Promise.reject(new TypeError("network down"));
      return new Response(JSON.stringify({ layoutDetails: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/v1/library/")) {
      const oiLegacyDelay = Number(params.get("oiLegacyDelay") || "0");
      window.__oiLegacy = window.__oiLegacy || { hits: 0, delay: 0, settled: false };
      window.__oiLegacy.hits += 1;
      window.__oiLegacy.delay = oiLegacyDelay;
      const oiLegacyResponse = () => {
        window.__oiLegacy.settled = true;
        if (!libraryBody || sessionStorage.getItem("oiNoLegacyLibrary") === "1") {
          return new Response("null", { status: 404, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(libraryBody), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      };
      if (!(oiLegacyDelay > 0)) return oiLegacyResponse();
      return new Promise((resolve) => setTimeout(() => resolve(oiLegacyResponse()), oiLegacyDelay));
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
        if (type === "OI_GET_SETTINGS") {
          const lag = Number(sessionStorage.getItem("oiSettingsLag") || "0");
          if (lag > 0) return new Promise((resolve) => setTimeout(() => resolve({ settings }), lag));
          return Promise.resolve({ settings });
        }
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
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=reopen`);
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

test("a new tab reuses stored pages when the 8765 404 and the library read are slow", { timeout: 180000 }, async (t) => {
  const session = await withChrome(t, chromeStub({ mode: "text-layer", library: null }), async () => {});
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=slow-legacy`);
  await session.waitFor(`(async () => {
    ${storedLibraryPagesSource()}
    const pages = await oiStoredLibraryPages();
    const stop = document.getElementById("stopTranslate");
    if (!pages.some((page) => String((page.pairs || [])[0]?.translation || "").includes("同页已译:"))) return "";
    if (pages.length < 2) return "";
    if (stop && stop.hidden !== true) return "";
    return "seeded";
  })()`, "first open stores more than one page", 90000);
  const seeded = JSON.parse(await session.evaluate(`(async () => {
    const req = indexedDB.open("oi-annotations");
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const kept = [];
    await new Promise((resolve, reject) => {
      const tx = db.transaction("pages", "readwrite");
      const store = tx.objectStore("pages");
      const cursor = store.openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const page = Number(row.value && row.value.page) || 0;
        if (page > 1) row.delete();
        else {
          for (const pair of row.value.pairs || []) {
            const text = String(pair.text || pair.sourceText || "").trim();
            if (text) kept.push(text);
          }
        }
        row.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return JSON.stringify(kept);
  })()`));
  assert.ok(seeded.length > 0, "page 1 has no stored source text");
  for (const delay of [1000, 3000]) {
    await session.evaluate(`(async () => {
      const req = indexedDB.open("oi-annotations");
      const db = await new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("pages", "readwrite");
        const store = tx.objectStore("pages");
        const cursor = store.openCursor();
        cursor.onerror = () => reject(cursor.error);
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          if ((Number(row.value && row.value.page) || 0) > 1) row.delete();
          row.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      return true;
    })()`);
    await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=slow-legacy&oiLegacyDelay=${delay}&oiSlowOpen=1000`);
    const shown = await session.waitFor(`(() => {
      const text = document.getElementById("readerFlow")?.innerText || "";
      if (!text.includes("同页已译:")) return "";
      const messages = (window.__oiAuto && window.__oiAuto.messages) || [];
      const paid = messages.some((item) => ${JSON.stringify(seeded)}.includes(String(item.head || "")));
      if (paid) return JSON.stringify({ delay: ${delay}, paid: messages });
      const slow = window.__oiSlow || {};
      const legacy = window.__oiLegacy || {};
      if (!(legacy.hits >= 1) || legacy.delay !== ${delay}) return "";
      if (!(slow.opens >= 1) || !(slow.doneAt - slow.openAt >= 800)) return "";
      return "reused";
    })()`, `delay ${delay} reuses the stored page`, 90000);
    assert.equal(shown, "reused", shown);
    await sleep(delay === 3000 ? 2500 : 1200);
    const after = JSON.parse(await session.evaluate(SNAPSHOT));
    const repaid = JSON.parse(await session.evaluate(`(() => JSON.stringify((window.__oiAuto && window.__oiAuto.messages) || []))()`));
    assert.equal(repaid.some((item) => seeded.includes(String(item.head || ""))), false, `delay ${delay} paid again ${JSON.stringify(repaid)}`);
    assert.ok(after.text.includes("同页已译:"), `delay ${delay} dropped the stored page`);
  }
});

test("manual translate before the library read finishes does not treat the open as a saved page", { timeout: 180000 }, async (t) => {
  const session = await withChrome(t, chromeStub({ mode: "text-layer", library: null }), async () => {});
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=manual-before-read`);
  await session.waitFor(`(async () => {
    ${storedLibraryPagesSource()}
    const pages = await oiStoredLibraryPages();
    const stop = document.getElementById("stopTranslate");
    if (!pages.some((page) => String((page.pairs || [])[0]?.translation || "").includes("同页已译:"))) return "";
    if (pages.length < 2) return "";
    if (stop && stop.hidden !== true) return "";
    return "seeded";
  })()`, "first open stores more than one page", 90000);
  const seeded = JSON.parse(await session.evaluate(`(async () => {
    const req = indexedDB.open("oi-annotations");
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const kept = [];
    await new Promise((resolve, reject) => {
      const tx = db.transaction("pages", "readwrite");
      const store = tx.objectStore("pages");
      const cursor = store.openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const page = Number(row.value && row.value.page) || 0;
        if (page > 1) row.delete();
        else {
          for (const pair of row.value.pairs || []) {
            const text = String(pair.text || pair.sourceText || "").trim();
            if (text) kept.push(text);
          }
        }
        row.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return JSON.stringify(kept);
  })()`));
  assert.ok(seeded.length > 0, "page 1 has no stored source text");
  const seedOpenedAt = Number(await session.evaluate(`(async () => {
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const papers = await sharedLibraryStore().listPapers();
    return papers && papers[0] ? papers[0].lastOpenedAt : 0;
  })()`)) || 0;
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=manual-before-read&oiAutoTranslate=0&oiLegacyDelay=3000`);
  const hash = await session.waitFor(`(async () => {
    const button = document.getElementById("translatePage");
    if (!button || button.disabled) return "";
    const text = document.getElementById("readerFlow")?.innerText || "";
    if (text.includes("同页已译:")) return "";
    const legacy = window.__oiLegacy || {};
    if (!(legacy.hits >= 1) || legacy.settled === true) return "";
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const papers = await sharedLibraryStore().listPapers();
    const paper = (papers || [])[0];
    if (!paper || !(Number(paper.lastOpenedAt) > ${seedOpenedAt})) return "";
    return paper.docHash || "";
  })()`, "open record landed before the legacy read finished", 20000);
  await sleep(200);
  const gate = JSON.parse(await session.evaluate(`(() => JSON.stringify({
    hasFn: typeof window.__oiLibrarySourceSentHas === "function",
    sent: typeof window.__oiLibrarySourceSentHas === "function" && window.__oiLibrarySourceSentHas(${JSON.stringify(hash)}),
    hits: window.__oiLegacy && window.__oiLegacy.hits || 0,
    settled: window.__oiLegacy && window.__oiLegacy.settled === true
  }))()`));
  assert.equal(gate.hasFn, true, "the open-set hook is missing");
  assert.equal(gate.sent, false, "open wrote the hash into librarySourceSent before the library read");
  assert.equal(gate.settled, false, "the legacy read already finished before manual translate");
  assert.ok(gate.hits >= 1, "8765 was not requested");
  await session.evaluate(`(() => { document.getElementById("translatePage").click(); return true; })()`);
  const shown = await session.waitFor(`(() => {
    const text = document.getElementById("readerFlow")?.innerText || "";
    if (!text.includes("同页已译:")) return "";
    const messages = (window.__oiAuto && window.__oiAuto.messages) || [];
    const paid = messages.some((item) => ${JSON.stringify(seeded)}.includes(String(item.head || "")));
    if (paid) return JSON.stringify({ paid: messages });
    return "reused";
  })()`, "manual translate reuses the stored page", 30000);
  assert.equal(shown, "reused", shown);
  const after = JSON.parse(await session.evaluate(`(() => JSON.stringify((window.__oiAuto && window.__oiAuto.messages) || []))()`));
  assert.equal(after.some((item) => seeded.includes(String(item.head || ""))), false, `stored page was paid ${JSON.stringify(after)}`);
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
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=slow-open`);
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
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=held-v1`);
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
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=stop-zone`);
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

test("notes reopen after versionchange waits for the library upgrade", { timeout: 120000 }, async (t) => {
  const session = await withChrome(t, `globalThis.chrome = {
    runtime: { id: "oi-e2e", getURL() { return location.href; }, sendMessage() { return Promise.resolve({ ok: true }); }, onMessage: { addListener() {} } },
    storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } }
  };`, async () => {});
  await openPage(session, `${session.origin}/oi-notes-probe.html`);
  await session.waitFor(`document.body ? "ready" : ""`, "probe document", 15000);
  const raw = await session.evaluate(`(async () => {
    const opens = [];
    const realOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = function(name, version) {
      const rec = {
        name: String(name || ""),
        version: version == null ? null : version,
        blocked: false,
        success: false,
        error: "",
        at: Date.now()
      };
      opens.push(rec);
      const request = version == null ? realOpen(name) : realOpen(name, version);
      request.addEventListener("blocked", () => { rec.blocked = true; });
      request.addEventListener("success", () => {
        rec.success = true;
        rec.successAt = Date.now();
        try { rec.doneVersion = request.result.version; } catch { rec.doneVersion = 0; }
      });
      request.addEventListener("error", () => {
        rec.error = request.error && request.error.name || "error";
      });
      return request;
    };
    const { createNotesStore } = await import("/lib/notes-store.js");
    const { createLibraryStore } = await import("/lib/library-store.js");
    const { createLibraryChip } = await import("/lib/library-chip.js");
    const host = document.createElement("div");
    host.id = "oiProbeChip";
    document.body.append(host);
    const chip = createLibraryChip({ host, pollMs: 60000, manualRetryMs: 60000 });
    const notes = createNotesStore({
      persist: false,
      deviceId: "probe-notes",
      createId: () => "n-probe"
    });
    await notes.put({ docHash: "doc-probe", kind: "note", page: 1, body: "升级前" });
    const holder = await new Promise((resolve, reject) => {
      const request = indexedDB.open("oi-annotations", 1);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          setTimeout(() => {
            try { db.close(); } catch { /* already closed */ }
          }, 200);
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error || new Error("holder open failed"));
    });
    const originalClose = IDBDatabase.prototype.close;
    let kicked = false;
    IDBDatabase.prototype.close = function closeForProbe() {
      const name = this.name;
      const version = this.version;
      const result = originalClose.call(this);
      if (!kicked && name === "oi-annotations" && version === 1) {
        kicked = true;
        queueMicrotask(() => {
          notes.put({ id: "n-probe", docHash: "doc-probe", kind: "note", page: 1, body: "升级后" }).then(() => {
            window.__oiReopen = "ok";
          }, (error) => {
            window.__oiReopen = String(error && (error.name || error.message) || "error");
          });
        });
      }
      return result;
    };
    const library = createLibraryStore({
      persist: false,
      deviceId: "probe-lib",
      blockedTimeoutMs: 1200
    });
    let upgrade = "pending";
    let upgradeError = "";
    try {
      await library.touchPaper("doc-probe", { title: "先存的", pageCount: 2, origin: "native" });
      upgrade = "done";
    } catch (error) {
      upgrade = "failed";
      upgradeError = String(error && (error.name || error.message) || "error");
      if (error && (error.name === "BlockedError" || error.type === "blocked")) chip.block(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const version = await new Promise((resolve) => {
      const request = realOpen("oi-annotations");
      request.onsuccess = () => {
        const db = request.result;
        const current = db.version;
        db.close();
        resolve(current);
      };
      request.onerror = () => resolve(0);
    });
    return JSON.stringify({
      upgrade,
      upgradeError,
      kicked,
      reopen: window.__oiReopen || "",
      version,
      chip: host.textContent || "",
      opens: opens.filter((row) => row.name === "oi-annotations")
    });
  })()`);
  const report = JSON.parse(raw);
  assert.equal(report.kicked, true, `versionchange did not close the notes connection ${JSON.stringify(report)}`);
  assert.equal(report.upgrade, "done", `library upgrade did not finish ${JSON.stringify(report)}`);
  assert.equal(report.version, 2, `database stayed at v1 ${JSON.stringify(report)}`);
  assert.equal(report.reopen, "ok", `notes write after versionchange failed ${JSON.stringify(report)}`);
  assert.equal(report.chip.includes("暂时存不了"), false, `chip stayed blocked ${JSON.stringify(report)}`);
  const v2 = report.opens.find((row) => row.version === 2);
  assert.ok(v2?.success, `v2 open did not succeed ${JSON.stringify(report.opens)}`);
  const duringUpgrade = (report.opens || []).filter((row) => row.at > v2.at && row.at < v2.successAt);
  assert.deepEqual(duringUpgrade, [], `notes reopened while the v2 upgrade was still running ${JSON.stringify(report.opens)}`);
});

async function pageTwoLayouts(session) {
  return JSON.parse(await session.evaluate(`(async () => {
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
          rev: String(row.layoutRev || row.layoutVersion || ""),
          reason: String(row.layout && row.layout.fallback && row.layout.fallback.reason || "")
        });
      }
    }
    return JSON.stringify(rows);
  })()`));
}

async function openStalePageTwo(t, layoutReply, scene) {
  const version = await currentLayoutVersion();
  const library = await sampleLibrary(version);
  const pageTwo = library.pages.find((page) => page.page === 2);
  assert.ok(pageTwo, "sample-m1 has no page 2");
  pageTwo.layoutVersion = version;
  pageTwo.layout.layoutVersion = version;
  pageTwo.layout.fallback = { source: "text-layer", reason: "http-502" };
  const session = await withChrome(t, chromeStub({ mode: "local-ocr", library, layoutReply }), async () => {});
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `localStorage.setItem('reader.follow','0');
      const pinPageOne = () => {
        if (document.getElementById('oiPinPageOne')) return;
        const style = document.createElement('style');
        style.id = 'oiPinPageOne';
        style.textContent = '#readerFlow > .rf-page[data-page="1"] .rf-block:first-child { min-height: 520px !important; }';
        (document.head || document.documentElement).appendChild(style);
      };
      document.addEventListener('DOMContentLoaded', pinPageOne);
      pinPageOne();`
  }, session.sessionId);
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=${scene}`);
  return session;
}

async function waitForPageTwoStop(session) {
  return JSON.parse(await session.evaluate(`(async () => {
    const started = Date.now();
    while (Date.now() - started < 12000) {
      const button = document.getElementById("stopTranslate");
      const layouts = ((window.__oiAuto && window.__oiAuto.layouts) || []).filter((page) => page === 2);
      const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
      const capsule = document.getElementById("pageCapsule")?.dataset.srcPage || "";
      if (layouts.length >= 1 && capsule === "1" && doc.includes("全文已译") && button && !button.hidden && !button.disabled) {
        return JSON.stringify({
          layouts: layouts.length,
          hidden: button.hidden === true,
          disabled: button.disabled === true,
          capsule,
          doc,
          flights: ((window.__oiAuto && window.__oiAuto.layoutFlights) || []).filter((row) => row.page === 2)
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const button = document.getElementById("stopTranslate");
    return JSON.stringify({
      error: "stop was not available while page 2 was posting",
      layouts: ((window.__oiAuto && window.__oiAuto.layouts) || []).slice(),
      hidden: !button || button.hidden === true,
      disabled: !button || button.disabled === true,
      capsule: document.getElementById("pageCapsule")?.dataset.srcPage || "",
      doc: document.querySelector("#docStatus .doc-text")?.textContent || "",
      flights: ((window.__oiAuto && window.__oiAuto.layoutFlights) || []).filter((row) => row.page === 2)
    });
  })()`));
}

test("Stop stays enabled while a background page-2 layout fetch is hung", { timeout: 180000 }, async (t) => {
  const session = await openStalePageTwo(t, "hang", "stop-background-hang");
  const ready = await waitForPageTwoStop(session);
  assert.equal(ready.error || "", "", JSON.stringify(ready));
  assert.equal(ready.hidden, false);
  assert.equal(ready.disabled, false);
  assert.equal(ready.layouts, 1, `page 2 posted before Stop was checked ${JSON.stringify(ready)}`);
  const clicked = JSON.parse(await session.evaluate(`(() => {
    const button = document.getElementById("stopTranslate");
    const before = ((window.__oiAuto && window.__oiAuto.layouts) || []).filter((page) => page === 2).length;
    button.click();
    const flights = ((window.__oiAuto && window.__oiAuto.layoutFlights) || []).filter((row) => row.page === 2);
    return JSON.stringify({
      before,
      aborted: flights.length > 0 && flights.every((row) => row.aborted === true),
      flights
    });
  })()`));
  assert.equal(clicked.aborted, true, `in-flight layout was not aborted ${JSON.stringify(clicked)}`);
  await sleep(1500);
  const after = JSON.parse(await session.evaluate(`(() => JSON.stringify({
    layouts: ((window.__oiAuto && window.__oiAuto.layouts) || []).filter((page) => page === 2).length
  }))()`));
  assert.equal(after.layouts, clicked.before, `Stop still POSTed page 2 ${JSON.stringify(after)}`);
  const stored = await pageTwoLayouts(session);
  assert.equal(stored.some((row) => row.mode === "local-ocr" && row.reason !== "http-502"), false, `Stop wrote a local-ocr row ${JSON.stringify(stored)}`);
});

test("auto-translate still writes the library paper before the first batch and the slow library read", { timeout: 180000 }, async (t) => {
  const session = await withChrome(t, chromeStub({ mode: "text-layer", library: null }), async () => {});
  await session.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const params = new URLSearchParams(location.search);
      if (params.get("oiScene") !== "open-record-now") return;
      const delay = Number(params.get("oiBatchDelay") || "0");
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = (message) => {
        if (delay > 0 && message && message.type === "OI_TRANSLATE_BATCH") {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              Promise.resolve(orig(message)).then(resolve, reject);
            }, delay);
          });
        }
        return orig(message);
      };
      const tick = async () => {
        if (window.__oiOpenSeen) return;
        try {
          const { sharedLibraryStore } = await import("/lib/library-session.js");
          const store = sharedLibraryStore();
          const papers = await store.listPapers();
          const paper = papers && papers[0];
          if (!paper || !paper.docHash) return;
          const pages = await store.getPages(paper.docHash);
          window.__oiOpenSeen = {
            docHash: paper.docHash,
            title: paper.title || "",
            fileName: paper.fileName || "",
            sourceUrl: paper.sourceUrl || "",
            lastOpenedAt: Number(paper.lastOpenedAt) || 0,
            pagesTranslated: Number(paper.pagesTranslated) || 0,
            pageRows: Array.isArray(pages) ? pages.length : 0,
            messages: (window.__oiAuto && window.__oiAuto.messages || []).length,
            legacySettled: window.__oiLegacy && window.__oiLegacy.settled === true,
            sent: typeof window.__oiLibrarySourceSentHas === "function" && window.__oiLibrarySourceSentHas(paper.docHash)
          };
        } catch (error) {
          window.__oiOpenSeenError = String(error && error.message || error);
        }
      };
      setInterval(() => { void tick(); }, 25);
    })();`
  }, session.sessionId);
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=open-record-now&oiBatchDelay=5000&oiLegacyDelay=8000`);
  const seen = JSON.parse(await session.waitFor(`(() => {
    if (window.__oiOpenSeen) return JSON.stringify(window.__oiOpenSeen);
    if (window.__oiOpenSeenError) return JSON.stringify({ error: window.__oiOpenSeenError });
    return "";
  })()`, "open writes a paper before translation", 8000));
  assert.equal(seen.error || "", "", JSON.stringify(seen));
  assert.equal(seen.title, "sample-m1.pdf");
  assert.equal(seen.fileName, "");
  assert.ok(String(seen.sourceUrl).includes("/tests/fixtures/sample-m1.pdf"), seen.sourceUrl);
  assert.equal(String(seen.sourceUrl).includes("?"), false, seen.sourceUrl);
  assert.ok(seen.lastOpenedAt > 0);
  assert.equal(seen.pagesTranslated, 0);
  assert.equal(seen.pageRows, 0, "open stored a page before the paper record");
  assert.equal(seen.messages, 0, "open waited for the first translate batch");
  assert.equal(seen.legacySettled, false, "open waited for the slow library read");
  assert.equal(seen.sent, false, "open wrote the hash into librarySourceSent");
});

test("a fresh library lookup after open still reuses the stored page", { timeout: 180000 }, async (t) => {
  const session = await withChrome(t, chromeStub({ mode: "text-layer", library: null }), async () => {});
  const src = `${session.origin}/tests/fixtures/sample-m1.pdf`;
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=r1-fresh-lookup`);
  await session.waitFor(`(async () => {
    ${storedLibraryPagesSource()}
    const pages = await oiStoredLibraryPages();
    const stop = document.getElementById("stopTranslate");
    if (!pages.some((page) => String((page.pairs || [])[0]?.translation || "").includes("同页已译:"))) return "";
    if (pages.length < 2) return "";
    if (stop && stop.hidden !== true) return "";
    return "seeded";
  })()`, "first open stores more than one page", 90000);
  const seeded = JSON.parse(await session.evaluate(`(async () => {
    const req = indexedDB.open("oi-annotations");
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const kept = [];
    await new Promise((resolve, reject) => {
      const tx = db.transaction("pages", "readwrite");
      const store = tx.objectStore("pages");
      const cursor = store.openCursor();
      cursor.onerror = () => reject(cursor.error);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        const page = Number(row.value && row.value.page) || 0;
        if (page > 1) row.delete();
        else {
          for (const pair of row.value.pairs || []) {
            const text = String(pair.text || pair.sourceText || "").trim();
            if (text) kept.push(text);
          }
        }
        row.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return JSON.stringify(kept);
  })()`));
  assert.ok(seeded.length > 0, "page 1 has no stored source text");
  const seedOpenedAt = Number(await session.evaluate(`(async () => {
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const papers = await sharedLibraryStore().listPapers();
    return papers && papers[0] ? papers[0].lastOpenedAt : 0;
  })()`)) || 0;
  await openPage(session, `${session.origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiAuto=1&oiScene=r1-fresh-lookup&oiAutoTranslate=0&oiLegacyDelay=8000`);
  const hash = await session.waitFor(`(async () => {
    const button = document.getElementById("translatePage");
    if (!button || button.disabled) return "";
    const text = document.getElementById("readerFlow")?.innerText || "";
    if (text.includes("同页已译:")) return "";
    const legacy = window.__oiLegacy || {};
    if (!(legacy.hits >= 1) || legacy.settled === true) return "";
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const papers = await sharedLibraryStore().listPapers();
    const paper = (papers || [])[0];
    if (!paper || !(Number(paper.lastOpenedAt) > ${seedOpenedAt})) return "";
    return paper.docHash || "";
  })()`, "open record landed before the legacy read finished", 20000);
  await sleep(800);
  await session.evaluate(`(() => {
    if (typeof window.__oiDropLibraryDoc === "function") window.__oiDropLibraryDoc();
    return true;
  })()`);
  const gate = JSON.parse(await session.evaluate(`(() => JSON.stringify({
    hasFn: typeof window.__oiLibrarySourceSentHas === "function",
    dropFn: typeof window.__oiDropLibraryDoc === "function",
    sent: typeof window.__oiLibrarySourceSentHas === "function" && window.__oiLibrarySourceSentHas(${JSON.stringify(hash)}),
    hits: window.__oiLegacy && window.__oiLegacy.hits || 0,
    settled: window.__oiLegacy && window.__oiLegacy.settled === true,
    messages: (window.__oiAuto && window.__oiAuto.messages || []).length
  }))()`));
  assert.equal(gate.hasFn, true, "the open-set hook is missing");
  assert.equal(gate.dropFn, true, "the library-doc hook is missing");
  assert.equal(gate.sent, false, "open wrote the hash into librarySourceSent before the library read");
  assert.equal(gate.settled, false, "the legacy read already finished before manual translate");
  assert.equal(gate.messages, 0, "auto-translate paid before the manual click");
  assert.ok(gate.hits >= 1, "8765 was not requested");
  await session.evaluate(`(() => { document.getElementById("translatePage").click(); return true; })()`);
  const shown = await session.waitFor(`(() => {
    const text = document.getElementById("readerFlow")?.innerText || "";
    if (!text.includes("同页已译:")) return "";
    const messages = (window.__oiAuto && window.__oiAuto.messages) || [];
    const paid = messages.some((item) => ${JSON.stringify(seeded)}.includes(String(item.head || "")));
    if (paid) return JSON.stringify({ paid: messages });
    return "reused";
  })()`, "manual translate reuses the stored page", 30000);
  assert.equal(shown, "reused", shown);
  const after = JSON.parse(await session.evaluate(`(() => JSON.stringify((window.__oiAuto && window.__oiAuto.messages) || []))()`));
  assert.equal(after.some((item) => seeded.includes(String(item.head || ""))), false, `stored page was paid ${JSON.stringify(after)}`);
});

test("Stop during a down background layout does not retry page 2", { timeout: 180000 }, async (t) => {
  const session = await openStalePageTwo(t, "down", "stop-background-down");
  const ready = await waitForPageTwoStop(session);
  assert.equal(ready.error || "", "", JSON.stringify(ready));
  assert.equal(ready.hidden, false);
  assert.equal(ready.disabled, false);
  const clicked = JSON.parse(await session.evaluate(`(() => {
    const button = document.getElementById("stopTranslate");
    const before = ((window.__oiAuto && window.__oiAuto.layouts) || []).filter((page) => page === 2).length;
    button.click();
    return JSON.stringify({ before });
  })()`));
  assert.ok(clicked.before >= 1, `page 2 had not posted ${JSON.stringify(clicked)}`);
  await sleep(2000);
  const after = JSON.parse(await session.evaluate(`(() => JSON.stringify({
    layouts: ((window.__oiAuto && window.__oiAuto.layouts) || []).filter((page) => page === 2).length
  }))()`));
  assert.equal(after.layouts, clicked.before, `Stop still retried page 2 ${JSON.stringify({ clicked, after })}`);
  const stored = await pageTwoLayouts(session);
  assert.equal(stored.some((row) => row.mode === "local-ocr" && row.reason !== "http-502"), false, `Stop wrote a local-ocr row ${JSON.stringify(stored)}`);
});

