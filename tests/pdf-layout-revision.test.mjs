// A library page, or a source-v3 layout cache, used to be final even when it
// was built before figure recovery. A missing or old revision must recompute
// in the background, keep translations, and make the next open send nothing.
// The sidecar accepts one layout POST at a time. Translation can already read
// 27/27 while that queue is still walking stale pages, so a count taken then
// (9, then 16, then 23 on the same library) is how far the queue had drained.
// storedLayoutCurrent compares the saved revision to the source hash. It does
// not flap. After every page is written back with the current version, the
// next open selects no pages.
// Local gitignored fixture:
//   tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { translatableBlocks } from "../lib/pdf-blocks.js";
import { cacheableLayout, currentLayoutVersion, layoutCacheKey, storedLayoutCurrent } from "../lib/pdf-layout-client.js";
import { isSkipOnlyPage, sourceReuseHash } from "../lib/pdf-library.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

installOwnedTmpGuard(["oi-layout-rev-", "com.google.Chrome.", ".com.google.Chrome."]);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const OLD_LAYER = "d06b9fb5ec653524fcaf7bfc4126b275441ca0ab";
const SETTINGS = { targetLang: "zh-CN", provider: "mymemory" };
const LAYOUT_DELAY_MS = 30000;
const DONE_WITHIN_MS = 12000;
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

test("a layout revision matches only the current algorithm", async () => {
  const version = await currentLayoutVersion();
  assert.match(version, /^source-v3:[0-9a-f]{16}$/);
  assert.equal(await currentLayoutVersion(), version);
  const blocks = [{ id: "a", label: "text", text: "Hi" }];
  assert.equal(storedLayoutCurrent({ blocks }, version), null);
  assert.equal(storedLayoutCurrent({ blocks, layoutVersion: "source-v3:old" }, version), null);
  assert.equal(storedLayoutCurrent({ layout: { blocks }, layoutVersion: "source-v3:old" }, version), null);
  assert.equal(storedLayoutCurrent({ blocks: [], layoutVersion: version }, version), null);
  assert.equal(storedLayoutCurrent({ layout: { blocks, layoutVersion: version } }, version).blocks.length, 1);
  const stored = cacheableLayout({ page: 7, blocks, layoutVersion: version });
  assert.equal(stored.layoutVersion, version);
  assert.equal("layoutVersion" in cacheableLayout({ page: 7, blocks }), false);
});

test("同一份库的重算次数是串行队列进度，写回后再次打开为 0", async () => {
  const version = await currentLayoutVersion();
  assert.equal(await currentLayoutVersion(), version);
  const blocks = [{ id: "a", label: "text", text: "Hi" }];
  const pages = Array.from({ length: 27 }, (_, index) => {
    const page = index + 1;
    const layoutVersion = page === 23 ? "source-v3:old" : "";
    return {
      page,
      layout: { blocks, ...(layoutVersion ? { layoutVersion } : {}) },
      ...(layoutVersion ? { layoutVersion } : {})
    };
  });
  const stalePages = () => pages
    .filter((entry) => !storedLayoutCurrent(entry, version))
    .map((entry) => entry.page);
  const queue = stalePages();
  assert.equal(queue.length, 27);
  assert.deepEqual(queue.slice(0, 9).length, 9);
  assert.deepEqual(queue.slice(0, 16).length, 16);
  assert.deepEqual(queue.slice(0, 23).length, 23);
  assert.deepEqual(new Set(queue).size, queue.length);
  for (const page of queue.slice(0, 9)) {
    const entry = pages[page - 1];
    entry.layout = { blocks, layoutVersion: version };
    entry.layoutVersion = version;
  }
  assert.deepEqual(stalePages(), queue.slice(9));
  for (const entry of pages) {
    entry.layout = { blocks, layoutVersion: version };
    entry.layoutVersion = version;
  }
  assert.deepEqual(stalePages(), []);
  assert.equal(storedLayoutCurrent(pages[0], version).blocks.length, 1);
  assert.equal(storedLayoutCurrent({ ...pages[6], layoutVersion: version, layout: pages[6].layout }, version).blocks.length, 1);
});

function oldTextLayer() {
  const dir = mkdtempSync(join(tmpdir(), "oi-layout-rev-src-"));
  for (const file of readdirSync(join(root, "lib"))) {
    if (!file.endsWith(".js")) continue;
    writeFileSync(join(dir, file), readFileSync(join(root, "lib", file)));
  }
  writeFileSync(join(dir, "pdf-text-layer.js"), execFileSync("git", ["show", `${OLD_LAYER}:lib/pdf-text-layer.js`], { cwd: root }));
  return import(join(dir, "pdf-text-layer.js"));
}

async function loadOldPaper() {
  const layer = (await oldTextLayer()).textLayerToBlocks;
  const bytes = readFileSync(dpoPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const doc = await getDocument({ data: new Uint8Array(bytes), verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  const pages = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = stampLayoutBids(number, layer({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      }));
      pages.push({ page: number, blocks: built.blocks, layout: built });
    }
  } finally {
    await doc.destroy();
  }
  return { hash, pageCount: pages.length, pages };
}

function pairFrom(block) {
  return {
    id: block.id,
    sourceId: block.sourceId,
    ...(block.bid ? { bid: block.bid } : {}),
    text: block.text,
    sourceText: block.sourceText || block.text,
    translation: `旧译${sourceReuseHash(block.text)}`,
    targetLang: SETTINGS.targetLang,
    provider: SETTINGS.provider
  };
}

function staleLayout(entry, version) {
  const layout = cacheableLayout(entry.layout);
  if (version) layout.layoutVersion = version;
  return layout;
}

function libraryFor(paper) {
  return {
    pageCount: paper.pageCount,
    pages: paper.pages.map((entry) => {
      const skip = isSkipOnlyPage(entry.blocks);
      const layout = staleLayout(entry, entry.page === 23 ? "source-v3:old" : "");
      if (!layout.layoutVersion) delete layout.layoutVersion;
      return {
        page: entry.page,
        pairs: skip ? [] : translatableBlocks(entry.blocks).map(pairFrom),
        layout,
        ...(layout.layoutVersion ? { layoutVersion: layout.layoutVersion } : {})
      };
    })
  };
}

function cacheFor(paper) {
  const store = {};
  for (const entry of paper.pages) {
    const key = layoutCacheKey({ hash: paper.hash, page: entry.page, mode: "local-ocr" });
    store[key] = staleLayout(entry, entry.page === 23 ? "source-v3:old" : "");
    if (!store[key].layoutVersion) delete store[key].layoutVersion;
  }
  return store;
}

function counted(text, total) {
  const compact = String(text || "").replace(/\s/g, "");
  if (compact.includes("全文已译")) return total;
  const match = compact.match(/(\d+)\/(\d+)/);
  if (!match || Number(match[2]) !== total) return null;
  return Number(match[1]);
}

function visibleText(value) {
  return String(value || "")
    .replace(/⟦f\d+⟧/g, "")
    .replace(/（公式见左栏）/g, "")
    .replace(/（公式槽待对齐）\s*/g, "")
    .replace(/（引用待对齐）\s*/g, "")
    .replace(/\s+/g, "");
}

function assess(snapshot) {
  const returned = new Map();
  for (const message of snapshot.messages || []) {
    for (const item of message.returned || []) {
      if (item.bid) returned.set(item.bid, item.translation);
    }
  }
  const misses = [];
  const seen = new Set();
  for (const row of snapshot.shown || []) {
    if (!row.bid || seen.has(row.bid)) continue;
    seen.add(row.bid);
    const own = returned.get(row.bid);
    if (own) {
      if (visibleText(row.zh) !== visibleText(own)) misses.push({ bid: row.bid, where: "display", painted: row.zh, expected: own });
      continue;
    }
    if (/译:b1-/.test(row.zh) && !row.zh.includes(`译:${row.bid}`)) misses.push({ bid: row.bid, where: "display-foreign", painted: row.zh });
  }
  return misses;
}

function stubSource(cache, options = {}) {
  const delay = options.delay ?? LAYOUT_DELAY_MS;
  const fails = options.fails ?? 0;
  const gate = options.gate ?? 0;
  const noBoxes = JSON.stringify(options.noBoxes || []);
  const hang = options.hang ? "true" : "false";
  return `(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get("oiAuto") || "";
  if (!mode) return;
  const scene = params.get("oiScene") || "";
  if (sessionStorage.getItem("oiLayoutFails") == null) sessionStorage.setItem("oiLayoutFails", "${fails}");
  if (sessionStorage.getItem("oiLayoutGate") == null) sessionStorage.setItem("oiLayoutGate", "${gate}");
  const settings = {
    provider: "mymemory",
    providers: { mymemory: { email: "" } },
    pdfAutoTranslate: true,
    targetLang: "zh-CN",
    pdfLayout: { mode: "local-ocr", localBaseUrl: "http://127.0.0.1:8765" },
    batchSize: 8
  };
  const listeners = [];
  window.__oiAuto = { scene, batches: [], messages: [], saved: [], layouts: [], layoutAttempts: [], layoutOk: 0, aborted: [] };
  window.__oiLayoutDelay = ${delay};
  window.__oiLayoutStore = ${JSON.stringify(cache)};
  const storageKey = "oiSaved:" + scene;
  const origFetch = window.fetch.bind(window);
  function shuffle(list) {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = (i * 7 + 3) % (i + 1);
      const swap = copy[i];
      copy[i] = copy[j];
      copy[j] = swap;
    }
    return copy;
  }
  function fresh(item) {
    const text = String(item.text || "");
    const source = String(item.sourceText || text);
    const tokens = [...text.matchAll(/⟦f\\d+⟧/g)].map((match) => match[0]);
    return "译:" + item.bid + tokens.join("");
  }
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/v1/library/")) {
      if (init && String(init.method || "").toUpperCase() === "POST") {
        let body = {};
        try { body = JSON.parse(init.body || "{}"); } catch { body = {}; }
        const prev = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
        const page = Number(body.page) || 0;
        const pages = prev.filter((item) => Number(item.page) !== page);
        const layoutVersion = body.layoutVersion || (body.layout && body.layout.layoutVersion) || "";
        if (page) pages.push({
          page,
          pairs: body.pairs || [],
          skipped: body.skipped === true,
          layout: body.layout || null,
          layoutVersion
        });
        sessionStorage.setItem(storageKey, JSON.stringify(pages));
        window.__oiAuto.saved = pages;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      const fixture = await origFetch("/oi-fixture-library.json?scene=" + encodeURIComponent(scene)).then((res) => res.json());
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
      const pages = (fixture.pages || []).map((item) => ({ ...item, pairs: (item.pairs || []).slice(), layout: item.layout || null }));
      for (const item of saved) {
        const at = pages.findIndex((row) => Number(row.page) === Number(item.page));
        if (at >= 0) pages[at] = { ...pages[at], ...item };
        else pages.push(item);
      }
      window.__oiAuto.library = pages;
      return new Response(JSON.stringify({ pageCount: fixture.pageCount || pages.length, pages }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("/v1/layout")) {
      let body = {};
      try { body = JSON.parse((init && init.body) || "{}"); } catch { body = {}; }
      const page = Number(body.page) || 0;
      const signal = init && init.signal;
      const noBoxes = new Set(${noBoxes});
      if (noBoxes.has(page)) {
        window.__oiAuto.layouts.push(page);
        window.__oiAuto.layoutAttempts.push({ page, status: 502, at: Date.now(), body: "no-boxes" });
        return new Response("layout returned no boxes", { status: 502 });
      }
      if (${hang}) {
        window.__oiAuto.layouts.push(page);
        window.__oiAuto.layoutAttempts.push({ page, status: 0, at: Date.now() });
        await new Promise((resolve, reject) => {
          if (signal && signal.aborted) {
            window.__oiAuto.aborted.push(page);
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          const onAbort = () => {
            window.__oiAuto.aborted.push(page);
            reject(new DOMException("Aborted", "AbortError"));
          };
          if (signal) signal.addEventListener("abort", onAbort, { once: true });
        });
        return new Response(JSON.stringify({ layoutDetails: [] }), { status: 200 });
      }
      const left = Number(sessionStorage.getItem("oiLayoutFails") || "0");
      if (left > 0) {
        sessionStorage.setItem("oiLayoutFails", String(left - 1));
        window.__oiAuto.layouts.push(page);
        window.__oiAuto.layoutAttempts.push({ page, status: 502, at: Date.now() });
        return new Response("bad gateway", { status: 502 });
      }
      const gate = Number(sessionStorage.getItem("oiLayoutGate") || "0");
      if (gate && window.__oiAuto.layoutOk >= gate) {
        window.__oiAuto.layouts.push(page);
        window.__oiAuto.layoutAttempts.push({ page, status: 0, at: Date.now() });
        await new Promise((resolve, reject) => {
          if (signal && signal.aborted) {
            window.__oiAuto.aborted.push(page);
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          if (signal) {
            signal.addEventListener("abort", () => {
              window.__oiAuto.aborted.push(page);
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          }
        });
      }
      window.__oiAuto.layouts.push(page);
      const started = Date.now();
      while (true) {
        const budget = Number(window.__oiLayoutDelay);
        const want = Number.isFinite(budget) ? budget : ${delay};
        if (Date.now() - started >= want) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      window.__oiAuto.layoutOk += 1;
      window.__oiAuto.layoutAttempts.push({ page, status: 200, at: Date.now() });
      return new Response(JSON.stringify({ layoutDetails: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("127.0.0.1:8765")) return new Response("ok", { status: 200 });
    return origFetch(input, init);
  };
  globalThis.chrome = {
    runtime: {
      getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
      sendMessage(message) {
        const type = message && message.type;
        if (type === "OI_GET_SETTINGS") return Promise.resolve({ settings });
        if (type === "OI_PDF_STRUCTURE") return Promise.resolve({ ok: false });
        if (type === "OI_ENSURE_GLMOCR") return Promise.resolve({ ok: true });
        if (type === "OI_TRANSLATE_BATCH") {
          const items = Array.isArray(message.items) ? message.items : [];
          window.__oiAuto.batches.push(items.length || (message.texts || []).length);
          const rows = shuffle(items.filter((item) => item && item.bid).map((item) => ({
            bid: item.bid,
            translation: fresh(item)
          })));
          window.__oiAuto.messages.push({
            items: items.map((item) => ({ bid: item.bid || "", text: item.text || "" })),
            returned: rows
          });
          return Promise.resolve({ ok: true, translations: rows });
        }
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener(fn) { listeners.push(fn); } }
    },
    storage: {
      local: {
        get(key) {
          const keys = typeof key === "string" ? [key] : (Array.isArray(key) ? key : []);
          const out = {};
          for (const item of keys) {
            if (Object.prototype.hasOwnProperty.call(window.__oiLayoutStore, item)) out[item] = window.__oiLayoutStore[item];
          }
          return Promise.resolve(out);
        },
        set(obj) {
          Object.assign(window.__oiLayoutStore, obj || {});
          return Promise.resolve();
        }
      }
    }
  };
})();`;
}

function serveRepo(fixtures) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/oi-fixture-library.json") {
      const scene = url.searchParams.get("scene") || "";
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(fixtures.get(scene) || { pageCount: 0, pages: [] }));
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
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(404);
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
      }, 60000);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const READ = `(() => {
  const shown = [...document.querySelectorAll("[data-bid]")].map((el) => ({
    bid: el.dataset.bid || "",
    zh: [...el.children].filter((child) => child.classList.contains("rf-zh")).map((child) => child.textContent || "").join("").trim()
  })).filter((row) => row.bid && row.zh);
  const pages = [...document.querySelectorAll("#readerFlow .rf-page")].map((el) => ({
    page: Number(el.dataset.page) || 0,
    state: el.dataset.state || "",
    ps: el.querySelector(":scope > .rf-ps .rf-ps-text")?.textContent || "",
    blocks: el.querySelectorAll(":scope > .rf-block, :scope figure").length,
    src: [...el.querySelectorAll(":scope .rf-src")].map((node) => node.textContent || "").join(" ").replace(/\\s+/g, " ")
  }));
  const visuals = [...document.querySelectorAll("#readerFlow [data-label='figure'], #readerFlow [data-label='table']")].map((el) => ({
    page: Number(el.dataset.srcPage || el.dataset.page) || 0,
    label: el.dataset.label || ""
  }));
  return JSON.stringify({
    doc: document.querySelector("#docStatus .doc-text")?.textContent || "",
    shown,
    pages,
    visuals,
    caption7: document.querySelector("#readerFlow [data-src-page='7'][data-label='figure'] figcaption .rf-zh, #readerFlow figcaption[data-page='7'] .rf-zh")?.textContent || "",
    batches: (window.__oiAuto && window.__oiAuto.batches || []).length,
    messages: (window.__oiAuto && window.__oiAuto.messages) || [],
    library: (window.__oiAuto && window.__oiAuto.library) || [],
    saved: (window.__oiAuto && window.__oiAuto.saved) || [],
    layouts: (window.__oiAuto && window.__oiAuto.layouts) || [],
    layoutAttempts: (window.__oiAuto && window.__oiAuto.layoutAttempts) || [],
    aborted: (window.__oiAuto && window.__oiAuto.aborted) || [],
    paint: window.__oiPaint || []
  });
})()`;

test("旧库页数据在慢速划区下恢复图，二次打开不再请求", { timeout: 600000 }, async (t) => {
  assert.equal(readFileSync(dpoPath).byteLength > 0, true);
  const version = await currentLayoutVersion();
  const paper = await loadOldPaper();
  assert.equal(paper.pageCount, 27);
  const page7 = paper.pages.find((entry) => entry.page === 7);
  const page23 = paper.pages.find((entry) => entry.page === 23);
  assert.equal(page7.blocks.some((block) => block.label === "figure"), false);
  assert.equal(page23.blocks.some((block) => block.label === "figure" || block.label === "table"), false);
  for (const number of [12, 13, 14]) {
    const entry = paper.pages.find((item) => item.page === number);
    assert.equal(isSkipOnlyPage(entry.blocks), true);
    assert.equal(entry.blocks.length, 13);
  }
  const library = libraryFor(paper);
  assert.equal(library.pages.find((entry) => entry.page === 7).layout.layoutVersion, undefined);
  assert.equal(library.pages.find((entry) => entry.page === 23).layoutVersion, "source-v3:old");
  const fixtures = new Map([["dpo-stale", library]]);
  const server = await serveRepo(fixtures);
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-layout-rev-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(child.stdio[3], child.stdio[4]);
  t.after(async () => {
    try { cdp.dispose(); } finally {
      await cleanupChrome({ t, child, server, ownedDir, userDataDir });
    }
  });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: stubSource(cacheFor(paper)) });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const snapshot = async () => JSON.parse(await evaluate(READ));
  const samples = [];
  const watch = (shot) => {
    const n = counted(shot.doc, 27);
    if (n == null) return;
    const prev = samples.length ? samples[samples.length - 1] : n;
    samples.push(n);
    assert.ok(n >= prev, `progress dropped ${prev} -> ${n} (${shot.doc})`);
  };
  const open = async () => {
    const src = `${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`;
    const viewer = `${origin}/pdf/viewer.html?oiAuto=stale&oiScene=dpo-stale&src=${encodeURIComponent(src)}`;
    await send("Page.navigate", { url: viewer });
  };

  await open();
  const started = Date.now();
  let early = null;
  while (Date.now() - started < DONE_WITHIN_MS) {
    try { early = await snapshot(); } catch { await sleep(200); continue; }
    watch(early);
    const skips = [12, 13, 14].every((page) => {
      const row = early.pages.find((item) => item.page === page);
      return row && row.state === "skipped" && row.blocks >= 13 && row.ps === "参考文献 · 保留原文";
    });
    if (counted(early.doc, 27) === 27 && skips) break;
    await sleep(200);
  }
  const elapsed = Date.now() - started;
  assert.ok(early && counted(early.doc, 27) === 27, `progress ${early?.doc} at ${elapsed}ms`);
  assert.ok(elapsed < DONE_WITHIN_MS, `counted at ${elapsed}ms`);
  assert.equal(early.visuals.some((item) => item.page === 7 && item.label === "figure"), false);
  await evaluate("window.__oiLayoutDelay = 0");

  const focus = new Set([7, 23, 12, 13, 14]);
  let settled = null;
  const recoverBy = Date.now() + 180000;
  while (Date.now() < recoverBy) {
    try { settled = await snapshot(); } catch { await sleep(300); continue; }
    watch(settled);
    const calls = settled.layouts || [];
    const visualsReady = settled.visuals.some((item) => item.page === 7 && item.label === "figure")
      && settled.visuals.some((item) => item.page === 23 && item.label === "figure")
      && settled.visuals.some((item) => item.page === 23 && item.label === "table");
    const skipsReady = [12, 13, 14].every((page) => {
      const row = settled.pages.find((item) => item.page === page);
      return row && row.state === "skipped" && row.blocks >= 13;
    });
    if (visualsReady && skipsReady && [...focus].every((page) => calls.includes(page))) break;
    await sleep(300);
  }
  assert.ok(settled, "no snapshot after layout");
  const calls = settled.layouts || [];
  assert.ok([7, 23, 12, 13, 14].every((page) => calls.includes(page)), `layout calls ${JSON.stringify(calls)}`);
  const firstSkip = calls.findIndex((page) => page === 12 || page === 13 || page === 14);
  let lastOther = -1;
  calls.forEach((page, index) => {
    if (page !== 12 && page !== 13 && page !== 14) lastOther = index;
  });
  assert.ok(firstSkip > lastOther, `skip layouts ran ahead ${JSON.stringify(calls)}`);
  assert.equal(counted(settled.doc, 27), 27, settled.doc);
  assert.equal(settled.pages.find((item) => item.page === 7).src.includes("Reward"), false);
  assert.equal(settled.pages.find((item) => item.page === 7).src.includes("DPO (Ours)"), false);
  assert.match(settled.caption7, /^旧译/);
  assert.equal(assess(settled).length, 0, JSON.stringify(assess(settled).slice(0, 3)));
  const savedBy = Date.now() + 30000;
  let saved = settled.saved || [];
  while (Date.now() < savedBy) {
    const ready = [7, 23, 12, 13, 14].every((page) => saved.some((item) => item.page === page && item.layoutVersion === version));
    if (ready) break;
    await sleep(200);
    saved = (await snapshot()).saved || [];
  }
  for (const page of [7, 23, 12, 13, 14]) {
    const row = saved.find((item) => item.page === page);
    assert.equal(row?.layoutVersion, version, `page ${page} saved ${row?.layoutVersion}`);
  }

  const requests = settled.batches;
  await open();
  const againStarted = Date.now();
  let again = null;
  while (Date.now() - againStarted < DONE_WITHIN_MS) {
    try { again = await snapshot(); } catch { await sleep(200); continue; }
    watch(again);
    const visualsReady = again.visuals.some((item) => item.page === 7 && item.label === "figure")
      && again.visuals.some((item) => item.page === 23 && item.label === "figure")
      && again.visuals.some((item) => item.page === 23 && item.label === "table");
    const skipsReady = [12, 13, 14].every((page) => {
      const row = again.pages.find((item) => item.page === page);
      return row && row.state === "skipped" && row.blocks >= 13;
    });
    if (counted(again.doc, 27) === 27 && visualsReady && skipsReady) break;
    await sleep(200);
  }
  assert.equal(counted(again?.doc, 27), 27, again?.doc);
  assert.equal(again.layouts.length, 0, `reopen layouts ${JSON.stringify(again.layouts)}`);
  assert.equal(again.batches, 0, `reopen batches ${again.batches}`);
  assert.match(again.caption7, /^旧译/);
  t.diagnostic(JSON.stringify({
    elapsedMs: elapsed,
    reopenMs: Date.now() - againStarted,
    layoutRequests: calls.length,
    translationRequests: requests,
    reopenLayoutRequests: again.layouts.length,
    reopenTranslationRequests: again.batches,
    progress: samples
  }));
});

test("502 会退避重试，写回过的页中断后不再请求，公式槽重映射", { timeout: 420000 }, async (t) => {
  const version = await currentLayoutVersion();
  const paper = await loadOldPaper();
  const host = await formulaHost(paper);
  assert.ok(host, "no single-slot formula block with a stable source");
  const library = libraryFor(paper);
  const page = library.pages.find((entry) => entry.page === host.page);
  const pair = page.pairs.find((item) => item.sourceId === host.sourceId);
  assert.ok(pair, "formula pair missing");
  pair.text = String(pair.text).replace(/⟦f(\d+)⟧/g, (_, n) => `⟦f${Number(n) + 5}⟧`);
  pair.translation = `槽译${pair.text}`;
  const fixtures = new Map([["dpo-interrupt", library]]);
  const server = await serveRepo(fixtures);
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-layout-rev-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(child.stdio[3], child.stdio[4]);
  t.after(async () => {
    try { cdp.dispose(); } finally {
      await cleanupChrome({ t, child, server, ownedDir, userDataDir });
    }
  });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: stubSource(cacheFor(paper), { delay: 0, fails: 3, gate: 4 })
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const snapshot = async () => JSON.parse(await evaluate(READ));
  const src = `${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`;
  const viewer = `${origin}/pdf/viewer.html?oiAuto=stale&oiScene=dpo-interrupt&src=${encodeURIComponent(src)}`;
  await send("Page.navigate", { url: viewer });

  let mid = null;
  const midBy = Date.now() + 180000;
  while (Date.now() < midBy) {
    try { mid = await snapshot(); } catch { await sleep(200); continue; }
    const attempts = mid.layoutAttempts || [];
    const held = attempts.some((item) => item.status === 0);
    const failures = attempts.filter((item) => item.status === 502);
    if (held && failures.length >= 3 && (mid.saved || []).length >= 3) break;
    await sleep(200);
  }
  assert.ok(mid, "no snapshot");
  const attempts = mid.layoutAttempts || [];
  const failures = attempts.filter((item) => item.status === 502);
  assert.equal(failures.length, 3, JSON.stringify(attempts.slice(0, 6)));
  assert.equal(new Set(failures.map((item) => item.page)).size, 1);
  const retried = attempts.find((item) => item.status === 200 && item.page === failures[0].page);
  assert.ok(retried, "502 page never succeeded");
  assert.ok(failures[1].at - failures[0].at >= 450, `backoff ${failures[1].at - failures[0].at}`);
  assert.ok(failures[2].at - failures[1].at >= 900, `backoff ${failures[2].at - failures[1].at}`);
  assert.ok(retried.at - failures[2].at >= 1800, `backoff ${retried.at - failures[2].at}`);
  const completed = (mid.saved || []).filter((item) => item.layoutVersion === version).map((item) => item.page);
  assert.ok(completed.length >= 3, `saved ${JSON.stringify(mid.saved)}`);

  await evaluate(`sessionStorage.setItem("oiLayoutFails","0"); sessionStorage.setItem("oiLayoutGate","0"); true`);
  await send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  await send("Page.navigate", { url: viewer });

  let again = null;
  let have = new Set();
  const againBy = Date.now() + 180000;
  while (Date.now() < againBy) {
    try { again = await snapshot(); } catch { await sleep(300); continue; }
    have = new Set(completed);
    for (const item of again.library || []) {
      if (item.layoutVersion === version) have.add(item.page);
    }
    for (const item of again.saved || []) {
      if (item.layoutVersion === version) have.add(item.page);
    }
    if (have.size >= 27) break;
    await sleep(300);
  }
  assert.ok(again, "reopen produced no snapshot");
  for (const pageNo of completed) {
    assert.equal((again.layouts || []).includes(pageNo), false, `completed page ${pageNo} was requested again ${JSON.stringify(again.layouts)}`);
  }
  assert.ok((again.layouts || []).length > 0, "unfinished pages were abandoned");
  assert.equal(have.size, 27, `versions ${JSON.stringify([...have].sort((a, b) => a - b))}`);

  const formula = JSON.parse(await evaluate(`(() => {
    const body = document.getElementById("readerFlow")?.innerText || "";
    const bid = document.querySelector('#readerFlow [data-bid="${host.bid}"]');
    const node = bid?.querySelector(".rf-zh") || [...document.querySelectorAll("#readerFlow .rf-zh")].find((el) => (el.textContent || "").includes("槽译"));
    const text = node ? node.textContent || "" : "";
    return JSON.stringify({
      text,
      math: node ? node.querySelectorAll(".oi-pdf-inline-math").length : 0,
      lead: text.includes("公式槽待对齐"),
      inBody: body.includes("槽译"),
      bidText: bid ? (bid.innerText || "").slice(0, 240) : ""
    });
  })()`));
  assert.equal(formula.lead, false, JSON.stringify(formula));
  assert.match(formula.text, /槽译|译:/, JSON.stringify(formula));
  assert.ok(formula.math >= 1, JSON.stringify(formula));

  await send("Page.navigate", { url: "about:blank" });
  await sleep(300);
  await send("Page.navigate", { url: viewer });
  let quiet = null;
  const quietBy = Date.now() + 60000;
  while (Date.now() < quietBy) {
    try { quiet = await snapshot(); } catch { await sleep(200); continue; }
    const figures = quiet.visuals.some((item) => item.page === 7 && item.label === "figure")
      && quiet.visuals.some((item) => item.page === 23 && item.label === "figure");
    if (counted(quiet.doc, 27) === 27 && figures) break;
    await sleep(200);
  }
  assert.equal(quiet.layouts.length, 0, `third open layouts ${JSON.stringify(quiet.layouts)}`);
  assert.equal(quiet.batches, 0, `third open batches ${quiet.batches}`);
  t.diagnostic(JSON.stringify({
    completed,
    firstLayoutRequests: (mid.layouts || []).length,
    reopenLayoutRequests: (again.layouts || []).length,
    reopenTranslationRequests: again.batches,
    thirdLayoutRequests: quiet.layouts.length,
    thirdTranslationRequests: quiet.batches,
    formulaPage: host.page
  }));
});

async function loadCurrentPaper() {
  const { textLayerToBlocks } = await import("../lib/pdf-text-layer.js");
  const bytes = readFileSync(dpoPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
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
      pages.push({ page: number, blocks: built.blocks, layout: built });
    }
  } finally {
    await doc.destroy();
  }
  return { hash, pageCount: pages.length, pages };
}

function currentLibrary(paper, version) {
  return {
    pageCount: paper.pageCount,
    pages: paper.pages.map((entry) => {
      const skip = isSkipOnlyPage(entry.blocks);
      const layout = cacheableLayout({ ...entry.layout, page: entry.page, blocks: entry.blocks, layoutVersion: version });
      layout.layoutVersion = version;
      return {
        page: entry.page,
        pairs: skip ? [] : translatableBlocks(entry.blocks).map(pairFrom),
        layout,
        layoutVersion: version,
        ...(skip ? { skipped: true } : {})
      };
    })
  };
}

function misalignedHosts(paper) {
  const want = [[5, 1], [18, 2], [19, 1], [20, 1]];
  const chosen = [];
  for (const [page, count] of want) {
    const entry = paper.pages.find((item) => item.page === page);
    const blocks = (entry?.blocks || []).filter((block) => (
      block.label === "text" && block.bid && (String(block.text).match(/⟦f\d+⟧/g) || []).length >= 2
    ));
    chosen.push(...blocks.slice(0, count));
  }
  return chosen;
}

async function formulaHost(paper) {
  const { textLayerToBlocks } = await import("../lib/pdf-text-layer.js");
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(dpoPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  try {
    for (const entry of paper.pages) {
      if (isSkipOnlyPage(entry.blocks)) continue;
      const oldBlock = (entry.blocks || []).find((block) => (
        block.label === "text" && block.bid && block.sourceId &&
        (String(block.text).match(/⟦f\d+⟧/g) || []).length === 1
      ));
      if (!oldBlock) continue;
      const pdfPage = await doc.getPage(entry.page);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = stampLayoutBids(entry.page, textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: entry.page
      }));
      const live = built.blocks.find((block) => block.sourceId === oldBlock.sourceId || block.bid === oldBlock.bid);
      if (!live) continue;
      const liveCount = (String(live.text).match(/⟦f\d+⟧/g) || []).length;
      const sameSource = String(live.sourceText || live.text) === String(oldBlock.sourceText || oldBlock.text);
      if (liveCount === 1 && sameSource) {
        return { page: entry.page, sourceId: oldBlock.sourceId, bid: live.bid || oldBlock.bid };
      }
    }
  } finally {
    await doc.destroy();
  }
  return null;
}

test("当前版本的库再次打开不再划区", { timeout: 240000 }, async (t) => {
  const version = await currentLayoutVersion();
  const paper = await loadCurrentPaper();
  assert.equal(paper.pageCount, 27);
  const library = currentLibrary(paper, version);
  for (const entry of library.pages) {
    assert.equal(storedLayoutCurrent(entry, version)?.blocks?.length > 0, true, `page ${entry.page}`);
  }
  const fixtures = new Map([["dpo-current", library]]);
  const server = await serveRepo(fixtures);
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-layout-rev-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(child.stdio[3], child.stdio[4]);
  t.after(async () => {
    try { cdp.dispose(); } finally {
      await cleanupChrome({ t, child, server, ownedDir, userDataDir });
    }
  });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: stubSource({}, { delay: 0 }) });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const snapshot = async () => JSON.parse(await evaluate(READ));
  const src = `${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`;
  const viewer = `${origin}/pdf/viewer.html?oiAuto=stale&oiScene=dpo-current&src=${encodeURIComponent(src)}`;
  await send("Page.navigate", { url: viewer });
  let opened = null;
  const openBy = Date.now() + 180000;
  while (Date.now() < openBy) {
    try { opened = await snapshot(); } catch { await sleep(250); continue; }
    if (counted(opened.doc, 27) === 27) break;
    await sleep(250);
  }
  assert.equal(counted(opened?.doc, 27), 27, opened?.doc);
  await sleep(1500);
  opened = await snapshot();
  assert.deepEqual(opened.layouts, [], `current library requested ${JSON.stringify(opened.layouts)}`);
});

test("no-boxes 不重试，回退标记下次升级，错槽重译，重开不闪旧版", { timeout: 420000 }, async (t) => {
  const version = await currentLayoutVersion();
  const paper = await loadCurrentPaper();
  assert.equal(paper.pageCount, 27);
  const page7 = paper.pages.find((entry) => entry.page === 7);
  assert.equal(page7.blocks.some((block) => block.label === "figure"), true);
  const hosts = misalignedHosts(paper);
  assert.equal(hosts.length, 5, hosts.map((block) => block.bid).join(","));
  const library = currentLibrary(paper, version);
  const page4 = library.pages.find((entry) => entry.page === 4);
  page4.layout.fallback = { source: "text-layer", reason: "http-502" };
  const page12 = library.pages.find((entry) => entry.page === 12);
  delete page12.layout.layoutVersion;
  delete page12.layoutVersion;
  for (const block of hosts) {
    const row = library.pages.find((entry) => entry.page === Number(String(block.bid).match(/p(\d+)/)?.[1]) || block.page);
    const pair = library.pages.flatMap((entry) => entry.pairs || []).find((item) => item.bid === block.bid);
    assert.ok(pair, block.bid);
    pair.translation = `见⟦f99⟧${block.bid}`;
    void row;
  }
  const fixtures = new Map([["dpo-fallback", library]]);
  const server = await serveRepo(fixtures);
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-layout-rev-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(child.stdio[3], child.stdio[4]);
  t.after(async () => {
    try { cdp.dispose(); } finally {
      await cleanupChrome({ t, child, server, ownedDir, userDataDir });
    }
  });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: stubSource({}, { delay: 0, noBoxes: [12] })
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const snapshot = async () => JSON.parse(await evaluate(READ));
  const src = `${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`;
  const viewer = `${origin}/pdf/viewer.html?oiAuto=stale&oiScene=dpo-fallback&src=${encodeURIComponent(src)}`;
  await send("Page.navigate", { url: viewer });

  let firstPaint = null;
  let opened = null;
  const openBy = Date.now() + 180000;
  while (Date.now() < openBy) {
    try { opened = await snapshot(); } catch { await sleep(250); continue; }
    if (!firstPaint) {
      firstPaint = (opened.paint || []).find((item) => item.page === 7) || null;
    }
    const attempts12 = (opened.layoutAttempts || []).filter((item) => item.page === 12);
    const saved4 = (opened.saved || []).find((item) => item.page === 4 && item.layoutVersion === version && !item.layout?.fallback);
    const saved12 = (opened.saved || []).find((item) => item.page === 12 && item.layout?.fallback?.reason === "no-boxes");
    const shown = new Set((opened.messages || []).flatMap((message) => (message.items || []).map((item) => item.bid)));
    const queued = hosts.every((block) => shown.has(block.bid));
    const storedZh = hosts.every((block) => (opened.saved || []).some((page) => (
      (page.pairs || []).some((pair) => pair.bid === block.bid && String(pair.translation || "").includes("译:"))
    )));
    if (attempts12.length === 1 && saved4 && saved12 && queued && storedZh && counted(opened.doc, 27) === 27) break;
    await sleep(300);
  }
  assert.ok(opened, "no snapshot");
  assert.ok(firstPaint && firstPaint.visuals > 0, `page 7 first paint ${JSON.stringify(firstPaint)}`);
  assert.equal((opened.paint || []).find((item) => item.page === 7).visuals > 0, true);
  const attempts12 = (opened.layoutAttempts || []).filter((item) => item.page === 12);
  assert.equal(attempts12.length, 1, JSON.stringify(opened.layoutAttempts));
  assert.equal(attempts12[0].body, "no-boxes");
  const saved4 = (opened.saved || []).find((item) => item.page === 4);
  assert.equal(saved4?.layoutVersion, version);
  assert.equal(saved4?.layout?.fallback, undefined);
  const saved12 = (opened.saved || []).find((item) => item.page === 12);
  assert.equal(saved12?.layout?.fallback?.reason, "no-boxes");
  assert.equal(saved12?.layout?.fallback?.source, "text-layer");
  const requested = new Set((opened.messages || []).flatMap((message) => (message.items || []).map((item) => item.bid)));
  for (const block of hosts) assert.equal(requested.has(block.bid), true, block.bid);
  const formula = JSON.parse(await evaluate(`(() => {
    const hosts = ${JSON.stringify(hosts.map((block) => ({
      bid: block.bid,
      tokens: (String(block.text).match(/\u27e6f\d+\u27e7/g) || []).length
    })))};
    return JSON.stringify(hosts.map((host) => {
      const node = document.querySelector('#readerFlow [data-bid="' + host.bid + '"]');
      const zh = node ? [...node.querySelectorAll(".rf-zh")].map((el) => el.textContent || "").join("").trim() : "";
      return {
        bid: host.bid,
        zh,
        math: node ? node.querySelectorAll(".rf-zh .oi-pdf-inline-math").length : 0,
        tokens: host.tokens,
        lead: (node?.innerText || "").includes("公式槽待对齐")
      };
    }));
  })()`));
  for (const row of formula) {
    assert.equal(row.lead, false, JSON.stringify(row));
    assert.match(row.zh, /译:/, JSON.stringify(row));
    assert.equal(/^见⟦/.test(row.zh), false, JSON.stringify(row));
    assert.equal(row.math, row.tokens, JSON.stringify(row));
  }
  const firstLayouts = (opened.layouts || []).length;
  const firstBatches = opened.batches;
  let settledKey = "";
  let quiet = 0;
  const settleBy = Date.now() + 20000;
  while (quiet < 4 && Date.now() < settleBy) {
    const snap = await snapshot();
    const busy = (snap.pages || []).some((page) => page.state === "running" || page.state === "queued" || page.state === "layout");
    const key = JSON.stringify(snap.saved || []);
    if (!busy && key && key === settledKey) quiet += 1;
    else quiet = 0;
    settledKey = key;
    opened = snap;
    await sleep(300);
  }

  await send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  await send("Page.navigate", { url: viewer });
  let again = null;
  let reopenPaint = null;
  const againBy = Date.now() + 90000;
  while (Date.now() < againBy) {
    try { again = await snapshot(); } catch { await sleep(200); continue; }
    if (!reopenPaint) reopenPaint = (again.paint || []).find((item) => item.page === 7) || null;
    const figure = (again.visuals || []).some((item) => item.page === 7 && item.label === "figure");
    if (counted(again.doc, 27) === 27 && figure && again.layouts.length === 0 && again.batches === 0) break;
    await sleep(200);
  }
  assert.equal(counted(again?.doc, 27), 27, again?.doc);
  assert.equal(again.layouts.length, 0, `reopen layouts ${JSON.stringify(again.layouts)}`);
  assert.equal(again.batches, 0, JSON.stringify({
    batches: again.batches,
    messages: (again.messages || []).map((message) => (message.items || []).map((item) => item.bid || item.text || "").slice(0, 4))
  }));
  assert.ok(reopenPaint && reopenPaint.visuals > 0, `reopen page 7 ${JSON.stringify(reopenPaint)}`);
  t.diagnostic(JSON.stringify({
    firstLayouts,
    firstBatches,
    reopenLayouts: again.layouts.length,
    reopenBatches: again.batches,
    noBoxesAttempts: attempts12.length,
    hosts: hosts.map((block) => block.bid)
  }));
});

test("关闭页面会取消进行中的划区请求", { timeout: 240000 }, async (t) => {
  const version = await currentLayoutVersion();
  const paper = await loadCurrentPaper();
  const library = currentLibrary(paper, version);
  const page2 = library.pages.find((entry) => entry.page === 2);
  delete page2.layout.layoutVersion;
  delete page2.layoutVersion;
  const fixtures = new Map([["dpo-abort", library]]);
  const server = await serveRepo(fixtures);
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-layout-rev-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(child.stdio[3], child.stdio[4]);
  t.after(async () => {
    try { cdp.dispose(); } finally {
      await cleanupChrome({ t, child, server, ownedDir, userDataDir });
    }
  });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: stubSource({}, { delay: 0, hang: true })
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const src = `${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`;
  const viewer = `${origin}/pdf/viewer.html?oiAuto=stale&oiScene=dpo-abort&src=${encodeURIComponent(src)}`;
  await send("Page.navigate", { url: viewer });
  let started = null;
  const startBy = Date.now() + 180000;
  while (Date.now() < startBy) {
    try {
      started = JSON.parse(await evaluate(READ));
    } catch {
      await sleep(250);
      continue;
    }
    if ((started.layouts || []).length >= 1) break;
    await sleep(200);
  }
  assert.ok((started?.layouts || []).length >= 1, "layout request never started");
  const hung = started.layouts[0];
  await evaluate(`window.dispatchEvent(new Event("pagehide"))`);
  let after = null;
  const abortBy = Date.now() + 5000;
  while (Date.now() < abortBy) {
    try { after = JSON.parse(await evaluate(READ)); } catch { await sleep(100); continue; }
    if ((after.aborted || []).includes(hung)) break;
    await sleep(100);
  }
  assert.ok((after?.aborted || []).includes(hung), JSON.stringify(after?.aborted));
  const inflight = after.layouts.length;
  await sleep(600);
  const later = JSON.parse(await evaluate(READ));
  const extras = later.layouts.slice(inflight);
  assert.equal(extras.some((page) => page !== hung), false, `orphan layouts ${JSON.stringify(later.layouts)}`);
});

test("错槽译文仍画出公式，写回后二次打开不再请求，重开补上图裁区", { timeout: 420000 }, async (t) => {
  const version = await currentLayoutVersion();
  const paper = await loadCurrentPaper();
  const suffixes = ["t1am9nkw", "t1ip4wvs", "t06ip39c", "t1v9ih0t"];
  const hosts = [];
  for (const suffix of suffixes) {
    const block = paper.pages.flatMap((entry) => entry.blocks).find((item) => String(item.bid || "").endsWith(suffix));
    assert.ok(block, suffix);
    hosts.push(block);
  }
  for (const page of [7, 23, 24, 25]) {
    const visuals = paper.pages.find((entry) => entry.page === page).blocks.filter((block) => (
      block.label === "figure" || block.label === "table"
    ));
    assert.ok(visuals.length > 0, `p${page} visuals`);
  }
  const library = currentLibrary(paper, version);
  const page24 = library.pages.find((entry) => entry.page === 24);
  page24.layout.fallback = { source: "text-layer", reason: "http-502" };
  for (const block of hosts) {
    const pair = library.pages.flatMap((entry) => entry.pairs || []).find((item) => item.bid === block.bid);
    assert.ok(pair, block.bid);
    pair.translation = `中文⟦f99⟧${block.bid}`;
  }
  const fixtures = new Map([["dpo-slots", library]]);
  const server = await serveRepo(fixtures);
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-layout-rev-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(child.stdio[3], child.stdio[4]);
  t.after(async () => {
    try { cdp.dispose(); } finally {
      await cleanupChrome({ t, child, server, ownedDir, userDataDir });
    }
  });
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: stubSource({}, { delay: 0 }) });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const snapshot = async () => JSON.parse(await evaluate(READ));
  const src = `${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`;
  const viewer = `${origin}/pdf/viewer.html?oiAuto=slots&oiScene=dpo-slots&src=${encodeURIComponent(src)}`;
  const hostProbe = `(() => {
    const hosts = ${JSON.stringify(hosts.map((block) => block.bid))};
    return JSON.stringify(hosts.map((bid) => {
      const node = document.querySelector('#readerFlow [data-bid="' + bid + '"]');
      if (!node) return { bid, missing: true };
      const zh = [...node.querySelectorAll(".rf-zh")].map((el) => el.textContent || "").join("").trim();
      return {
        bid,
        zh,
        height: node.getBoundingClientRect().height,
        math: node.querySelectorAll(".rf-zh .oi-pdf-inline-math").length
      };
    }));
  })()`;
  const cropProbe = `(() => JSON.stringify([7, 23, 24, 25].map((page) => {
    const nodes = [...document.querySelectorAll('#readerFlow [data-page="' + page + '"][data-label="figure"], #readerFlow [data-page="' + page + '"][data-label="table"]')];
    return {
      page,
      count: nodes.length,
      imgs: nodes.filter((node) => node.querySelector("img")).length,
      placeholders: nodes.filter((node) => node.querySelector(".oi-pdf-asset-fallback")).length
    };
  })))()`;

  await send("Page.navigate", { url: viewer });
  let opened = null;
  const openBy = Date.now() + 240000;
  while (Date.now() < openBy) {
    try { opened = await snapshot(); } catch { await sleep(300); continue; }
    const requested = new Set((opened.messages || []).flatMap((message) => (message.items || []).map((item) => item.bid)));
    const queued = hosts.every((block) => requested.has(block.bid));
    const storedZh = hosts.every((block) => (opened.saved || []).some((page) => (
      (page.pairs || []).some((pair) => pair.bid === block.bid && String(pair.translation || "").includes("译:"))
    )));
    const attempts24 = (opened.layoutAttempts || []).filter((item) => item.page === 24);
    const saved24 = (opened.saved || []).find((item) => item.page === 24 && item.layoutVersion === version && !item.layout?.fallback);
    if (queued && storedZh && attempts24.length === 1 && saved24) break;
    await sleep(400);
  }
  assert.ok(opened, "no snapshot");
  const attempts24 = (opened.layoutAttempts || []).filter((item) => item.page === 24);
  assert.equal(attempts24.length, 1, JSON.stringify(opened.layoutAttempts));
  assert.equal((opened.layouts || []).filter((page) => page !== 24).length, 0, JSON.stringify(opened.layouts));
  const requested = new Set((opened.messages || []).flatMap((message) => (message.items || []).map((item) => item.bid)));
  for (const block of hosts) assert.equal(requested.has(block.bid), true, block.bid);
  const firstShown = JSON.parse(await evaluate(hostProbe));
  for (const row of firstShown) {
    assert.equal(row.missing, undefined, JSON.stringify(row));
    assert.ok(row.zh.length > 0, JSON.stringify(row));
    assert.ok(row.height > 0, JSON.stringify(row));
    assert.ok(row.math > 0, JSON.stringify(row));
    assert.match(row.zh, /译:/, JSON.stringify(row));
  }
  const firstBatches = opened.batches;

  await send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  await send("Page.navigate", { url: viewer });
  let again = null;
  let crops = null;
  const againBy = Date.now() + 180000;
  while (Date.now() < againBy) {
    try { again = await snapshot(); } catch { await sleep(300); continue; }
    crops = JSON.parse(await evaluate(cropProbe));
    const cropsReady = crops.every((row) => row.count > 0 && row.imgs === row.count && row.placeholders === 0);
    if (counted(again.doc, 27) === 27 && again.layouts.length === 0 && again.batches === 0 && cropsReady) break;
    await sleep(400);
  }
  assert.equal(again.layouts.length, 0, `reopen layouts ${JSON.stringify(again.layouts)}`);
  assert.equal(again.batches, 0, JSON.stringify({
    batches: again.batches,
    messages: (again.messages || []).map((message) => (message.items || []).map((item) => item.bid || "").slice(0, 4))
  }));
  const secondShown = JSON.parse(await evaluate(hostProbe));
  for (const row of secondShown) {
    assert.equal(row.missing, undefined, JSON.stringify(row));
    assert.ok(row.zh.length > 0, JSON.stringify(row));
    assert.ok(row.height > 0, JSON.stringify(row));
    assert.ok(row.math > 0, JSON.stringify(row));
    assert.match(row.zh, /译:/, JSON.stringify(row));
  }
  crops = JSON.parse(await evaluate(cropProbe));
  for (const row of crops) {
    assert.ok(row.count > 0, JSON.stringify(row));
    assert.equal(row.imgs, row.count, JSON.stringify(row));
    assert.equal(row.placeholders, 0, JSON.stringify(row));
  }
  t.diagnostic(JSON.stringify({
    firstBatches,
    reopenLayouts: again.layouts.length,
    reopenBatches: again.batches,
    hosts: hosts.map((block) => block.bid),
    crops
  }));
});
