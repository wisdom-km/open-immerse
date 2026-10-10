// An old source-v2 layout cache already marks reference pages as skipped.
// The sidecar layout is slow. Those pages must count as done before that
// layout returns, and must not take a layout slot ahead of other pages.
// Local gitignored fixtures:
//   tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf
//   tests/fixtures/Attention_Is_All_You_Need.pdf
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { translatableBlocks } from "../lib/pdf-blocks.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { cacheableLayout, layoutCacheKey } from "../lib/pdf-layout-client.js";
import { isSkipOnlyPage, sourceReuseHash } from "../lib/pdf-library.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const SKIP_TMP_PREFIXES = ["oi-skip-layout-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(SKIP_TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const attentionPath = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
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
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json"
};

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

const fixtures = new Map();

function legacyKey({ hash, page }) {
  return layoutCacheKey({ hash, page, mode: "local-ocr" }).replace(/:source-v3$/, ":source-v2");
}

function oldTranslation(block) {
  return `旧译${sourceReuseHash(block.text)}`;
}

function pairFrom(block) {
  return {
    id: block.id,
    sourceId: block.sourceId,
    ...(block.bid ? { bid: block.bid } : {}),
    text: block.text,
    sourceText: block.sourceText || block.text,
    translation: oldTranslation(block),
    targetLang: SETTINGS.targetLang,
    provider: SETTINGS.provider
  };
}

async function loadPaper(pdfPath) {
  const bytes = readFileSync(pdfPath);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
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

function libraryFor(paper) {
  return {
    pageCount: paper.pageCount,
    pages: paper.pages.map((entry) => {
      if (isSkipOnlyPage(entry.blocks) || !translatableBlocks(entry.blocks).length) {
        return { page: entry.page, pairs: [] };
      }
      return { page: entry.page, pairs: translatableBlocks(entry.blocks).map(pairFrom) };
    })
  };
}

function cacheFor(paper) {
  const store = {};
  for (const entry of paper.pages) {
    if (!isSkipOnlyPage(entry.blocks)) continue;
    store[legacyKey({ hash: paper.hash, page: entry.page })] = cacheableLayout(entry.layout);
  }
  return store;
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
      if (visibleText(row.zh) !== visibleText(own)) {
        misses.push({ bid: row.bid, where: "display", painted: row.zh, expected: own });
      }
      continue;
    }
    if (/译:b1-/.test(row.zh) && !row.zh.includes(`译:${row.bid}`)) {
      misses.push({ bid: row.bid, where: "display-foreign", painted: row.zh });
    }
  }
  for (const page of snapshot.library || []) {
    for (const pair of page.pairs || []) {
      if (!pair?.bid || !pair.translation) continue;
      const own = returned.get(pair.bid);
      if (own && pair.translation !== own) misses.push({ bid: pair.bid, where: "library", saved: pair.translation, expected: own });
    }
  }
  return misses;
}

function progressDone(text, total) {
  const compact = String(text || "").replace(/\s/g, "");
  return compact.includes(`${total}/${total}`) || String(text || "").includes("全文已译");
}

function stubSource(cache) {
  return `(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get("oiAuto") || "";
  if (!mode) return;
  const scene = params.get("oiScene") || "";
  const settings = {
    provider: "mymemory",
    providers: { mymemory: { email: "" } },
    pdfAutoTranslate: true,
    targetLang: "zh-CN",
    pdfLayout: { mode: "local-ocr", localBaseUrl: "http://127.0.0.1:8765" },
    batchSize: 8
  };
  const listeners = [];
  window.__oiAuto = { scene, batches: [], messages: [], saved: [], layouts: [] };
  window.__oiLayoutDelay = ${LAYOUT_DELAY_MS};
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
    const cites = [...source.matchAll(/\\[\\s*\\d+(?:\\s*,\\s*\\d+)*\\s*\\]/g)].map((match) => match[0].replace(/\\s+/g, ""));
    return "译:" + item.bid + tokens.join("") + cites.join("");
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
        if (page) pages.push({ page, pairs: body.pairs || [], skipped: body.skipped === true });
        sessionStorage.setItem(storageKey, JSON.stringify(pages));
        window.__oiAuto.saved = pages;
        if (Array.isArray(window.__oiAuto.library)) {
          for (const item of pages) {
            const at = window.__oiAuto.library.findIndex((row) => Number(row.page) === Number(item.page));
            if (at >= 0) window.__oiAuto.library[at] = item;
            else window.__oiAuto.library.push(item);
          }
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      const fixture = await origFetch("/oi-fixture-library.json?scene=" + encodeURIComponent(scene)).then((res) => res.json());
      const saved = JSON.parse(sessionStorage.getItem(storageKey) || "[]");
      const pages = (fixture.pages || []).map((item) => ({ ...item, pairs: (item.pairs || []).slice() }));
      for (const item of saved) {
        const at = pages.findIndex((row) => Number(row.page) === Number(item.page));
        if (at >= 0) pages[at] = item;
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
      window.__oiAuto.layouts.push(page);
      const started = Date.now();
      while (true) {
        const budget = Number(window.__oiLayoutDelay);
        const want = Number.isFinite(budget) ? budget : ${LAYOUT_DELAY_MS};
        if (Date.now() - started >= want) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      return new Response(JSON.stringify({ layoutDetails: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
    if (url.includes("127.0.0.1:8765")) {
      return new Response("ok", { status: 200 });
    }
    return origFetch(input, init);
  };
  globalThis.chrome = {
    runtime: {
      getURL() {
        return new URL("./vendor/pdf.worker.min.mjs", location.href).href;
      },
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
          const returned = rows;
          for (const listener of listeners) {
            try {
              listener({
                type: "OI_TRANSLATE_PROGRESS",
                requestId: message.requestId,
                phase: "draft",
                translations: returned
              });
            } catch (error) { /* draft is best-effort */ }
          }
          return Promise.resolve({ ok: true, translations: returned });
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

function serveRepo() {
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
    blocks: el.querySelectorAll(":scope > .rf-block").length,
    src: [...el.querySelectorAll(":scope .rf-src")].map((node) => node.textContent || "").join(" ").replace(/\\s+/g, " ").slice(0, 160)
  }));
  const trail = (window.__oiAuto && window.__oiAuto.timeline) || [];
  const skipTrail = {};
  for (const row of trail) {
    for (const item of row.pages || []) {
      const hits = skipTrail[item.page] || (skipTrail[item.page] = []);
      if (!hits.length || hits[hits.length - 1] !== item.state) hits.push(item.state);
    }
  }
  return JSON.stringify({
    doc: document.querySelector("#docStatus .doc-text")?.textContent || "",
    state: document.querySelector("#docStatus")?.dataset.state || "",
    status: document.getElementById("status")?.textContent || "",
    skipTrail,
    pages,
    shown,
    batches: (window.__oiAuto && window.__oiAuto.batches || []).length,
    messages: (window.__oiAuto && window.__oiAuto.messages) || [],
    library: (window.__oiAuto && window.__oiAuto.library) || [],
    layouts: (window.__oiAuto && window.__oiAuto.layouts) || []
  });
})()`;

test("旧缓存的跳过页在慢速划区完成前就计入进度", { timeout: 600000 }, async (t) => {
  assert.equal(readFileSync(dpoPath).byteLength > 0, true);
  assert.equal(readFileSync(attentionPath).byteLength > 0, true);
  const dpo = await loadPaper(dpoPath);
  const attention = await loadPaper(attentionPath);
  assert.equal(dpo.pageCount, 27);
  assert.equal(attention.pageCount, 15);
  const dpoSkip = dpo.pages.filter((entry) => isSkipOnlyPage(entry.blocks));
  const attentionSkip = attention.pages.filter((entry) => isSkipOnlyPage(entry.blocks));
  assert.deepEqual(dpoSkip.map((entry) => entry.page), [12, 13, 14]);
  assert.deepEqual(dpoSkip.map((entry) => entry.blocks.length), [13, 13, 13]);
  assert.deepEqual(attentionSkip.map((entry) => entry.page), [11, 12]);
  assert.deepEqual(attentionSkip.map((entry) => entry.blocks.length), [20, 16]);
  for (const paper of [dpo, attention]) {
    for (const entry of paper.pages) {
      if (!isSkipOnlyPage(entry.blocks)) continue;
      assert.equal(Object.hasOwn(libraryFor(paper).pages.find((row) => row.page === entry.page), "skipped"), false);
    }
  }
  fixtures.set("dpo", libraryFor(dpo));
  fixtures.set("attention", libraryFor(attention));
  const cache = { ...cacheFor(dpo), ...cacheFor(attention) };

  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-skip-layout-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const handle = { child: null, cdp: null, chromeLog: "" };
  t.after(async () => {
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  handle.child.stderr.on("data", (chunk) => {
    handle.chromeLog = `${handle.chromeLog}${chunk.toString("utf8")}`.slice(-4000);
  });
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  let targetId;
  try {
    ({ targetId } = await cdp.send("Target.createTarget", { url: "about:blank" }));
  } catch (error) {
    throw new Error(`${error.message}\n${handle.chromeLog}`);
  }
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: stubSource(cache) }, sessionId);

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

  const open = async (scene, pdfName) => {
    const src = `${origin}/tests/fixtures/${pdfName}`;
    const viewer = `${origin}/pdf/viewer.html?oiAuto=skip&oiScene=${scene}&src=${encodeURIComponent(src)}`;
    await cdp.send("Page.navigate", { url: viewer }, sessionId);
  };

  const snapshot = async () => JSON.parse(await evaluate(READ));

  const assertSkippedNow = (shot, expected, label) => {
    for (const page of expected) {
      const row = shot.pages.find((item) => item.page === page.page);
      assert.ok(row, `${label} p${page.page} missing`);
      assert.equal(row.state, "skipped", `${label} p${page.page} ${row.state}`);
      assert.equal(row.ps, "参考文献 · 保留原文", `${label} p${page.page} ${row.ps}`);
      assert.equal(row.blocks, page.blocks.length, `${label} p${page.page} blocks ${row.blocks}`);
      assert.match(row.src, /\[\d+\]/, `${label} p${page.page} src`);
      const trail = shot.skipTrail[page.page] || [];
      const at = trail.indexOf("skipped");
      assert.ok(at >= 0, `${label} p${page.page} trail ${JSON.stringify(trail)}`);
      assert.equal(trail.slice(at).some((state) => state === "queued" || state === "running" || state === "empty"), false, JSON.stringify(trail));
      assert.equal((shot.layouts || []).includes(page.page), false, `${label} layout calls ${JSON.stringify(shot.layouts)}`);
    }
  };

  const waitUntilSkipped = async (expected, total, label) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < DONE_WITHIN_MS) {
      try {
        last = await snapshot();
      } catch {
        await sleep(200);
        continue;
      }
      const ready = progressDone(last.doc, total) && expected.every((page) => {
        const row = last.pages.find((item) => item.page === page.page);
        return row && row.state === "skipped" && row.blocks === page.blocks.length;
      });
      if (ready) {
        const elapsed = Date.now() - started;
        assert.ok(elapsed < DONE_WITHIN_MS, `${label} counted at ${elapsed}ms`);
        assertSkippedNow(last, expected, label);
        return { ...last, elapsed };
      }
      await sleep(200);
    }
    throw new Error(`${label} still waiting after ${DONE_WITHIN_MS}ms: ${JSON.stringify({
      doc: last?.doc,
      state: last?.state,
      status: last?.status,
      layouts: last?.layouts,
      pages: (last?.pages || []).map((row) => `${row.page}:${row.state}:${row.blocks}`)
    })}`);
  };

  const releaseLayout = async () => {
    await evaluate("window.__oiLayoutDelay = 0");
  };

  const waitForLayoutOrder = async (expected) => {
    const skip = new Set(expected.map((entry) => entry.page));
    const started = Date.now();
    let last = null;
    while (Date.now() - started < 180000) {
      try {
        last = await snapshot();
      } catch {
        await sleep(300);
        continue;
      }
      const calls = last.layouts || [];
      if ([...skip].every((page) => calls.includes(page))) {
        const firstSkip = calls.findIndex((page) => skip.has(page));
        let lastOther = -1;
        calls.forEach((page, index) => {
          if (!skip.has(page)) lastOther = index;
        });
        assert.ok(firstSkip > lastOther, `layout order ${JSON.stringify(calls)}`);
        return last;
      }
      await sleep(300);
    }
    throw new Error(`layout order did not settle: ${JSON.stringify({
      skips: [...skip].filter((page) => !(last?.layouts || []).includes(page)),
      calls: last?.layouts || []
    })}`);
  };

  const runPaper = async (scene, pdfName, paper, expected) => {
    await open(scene, pdfName);
    const early = await waitUntilSkipped(expected, paper.pageCount, scene);
    await releaseLayout();
    const settled = await waitForLayoutOrder(expected);
    assertSkippedNow({ ...settled, layouts: [] }, expected, `${scene} after layout`);
    assert.equal(progressDone(settled.doc, paper.pageCount), true, settled.doc);
    const misses = assess(settled);
    assert.equal(misses.length, 0, `${scene} misalignment ${JSON.stringify(misses.slice(0, 4))}`);
    await open(scene, pdfName);
    const again = await waitUntilSkipped(expected, paper.pageCount, `${scene} reopen`);
    assert.equal(again.batches, 0, `${scene} reopen batches ${again.batches}`);
    return {
      elapsedMs: early.elapsed,
      reopenMs: again.elapsed,
      requests: settled.batches,
      reopenRequests: again.batches,
      misalignment: misses.length,
      layoutsBeforeSkip: early.layouts
    };
  };

  const dpoResult = await runPaper("dpo", "Direct_Preference_Optimization_2305.18290.pdf", dpo, dpoSkip);
  const attentionResult = await runPaper("attention", "Attention_Is_All_You_Need.pdf", attention, attentionSkip);
  t.diagnostic(JSON.stringify({ dpo: dpoResult, attention: attentionResult }));
});
