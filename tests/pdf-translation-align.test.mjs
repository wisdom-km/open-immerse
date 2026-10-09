// Opens the reader the way a device does: viewer.html, an old library, then a
// translation response keyed by bid and returned out of order.
// Local gitignored fixtures:
//   tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf
//   tests/fixtures/Attention_Is_All_You_Need.pdf
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { translatableBlocks } from "../lib/pdf-blocks.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { isSkipOnlyPage, sourceReuseHash } from "../lib/pdf-library.js";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const ALIGN_TMP_PREFIXES = ["oi-align-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(ALIGN_TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const attentionPath = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const MAIN_V2 = "d06b9fb5ec653524fcaf7bfc4126b275441ca0ab";
const SETTINGS = { targetLang: "zh-CN", provider: "mymemory" };
const WATCH = ["b1-p20-t1ho201s", "b1-p20-t0kcfxuw", "b1-p27-t1dwp43s"];
const ECHO_ONLY = [
  "b1-p20-t1gvf53f",
  "b1-p20-t1wim4k9",
  "b1-p20-t1vpeb8d",
  "b1-p20-t0t2kdy1",
  "b1-p20-t1r7vjbx",
  "b1-p27-t1j3zjzu"
];
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

function protectedTranslation(prefix, block) {
  const text = String(block?.text || "");
  const source = String(block?.sourceText || text);
  const tokens = [...text.matchAll(/⟦f\d+⟧/g)].map((match) => match[0]);
  const cites = [...source.matchAll(/\[\s*\d+(?:\s*,\s*\d+)*\s*\]/g)].map((match) => match[0].replace(/\s+/g, ""));
  return `${prefix}${tokens.join("")}${cites.join("")}`;
}

function oldTranslation(block) {
  return protectedTranslation(`旧译${sourceReuseHash(block.text)}`, block);
}

function pairFrom(block, translation) {
  return {
    id: block.id,
    sourceId: block.sourceId,
    ...(block.bid ? { bid: block.bid } : {}),
    text: block.text,
    sourceText: block.sourceText || block.text,
    translation,
    targetLang: SETTINGS.targetLang,
    provider: SETTINGS.provider
  };
}

function keepEchoOnly(library) {
  const bids = new Set(ECHO_ONLY);
  for (const page of library.pages || []) {
    const rest = [];
    const echoed = new Map();
    for (const pair of page.pairs || []) {
      if (!bids.has(pair.bid)) {
        rest.push(pair);
        continue;
      }
      if (!echoed.has(pair.bid)) echoed.set(pair.bid, { ...pair, translation: pair.text });
    }
    page.pairs = [...rest, ...echoed.values()];
  }
  return library;
}

function libraryFor(pages) {
  return {
    pageCount: pages.length,
    pages: pages.map((entry) => {
      const blocks = entry.previous.blocks;
      if (isSkipOnlyPage(blocks) || !translatableBlocks(blocks).length) {
        return { page: entry.page, pairs: [], skipped: true };
      }
      const pairs = [];
      for (const block of translatableBlocks(blocks)) {
        if (WATCH.includes(block.bid)) pairs.push(pairFrom(block, block.text));
        pairs.push(pairFrom(block, oldTranslation(block)));
      }
      return { page: entry.page, pairs };
    })
  };
}

function historicalLayer(commit) {
  const dir = mkdtempSync(join(tmpdir(), "oi-align-layer-"));
  for (const file of readdirSync(join(root, "lib"))) {
    if (!file.endsWith(".js")) continue;
    writeFileSync(join(dir, file), readFileSync(join(root, "lib", file)));
  }
  writeFileSync(
    join(dir, "pdf-text-layer.js"),
    execFileSync("git", ["show", `${commit}:lib/pdf-text-layer.js`], { cwd: root })
  );
  return import(join(dir, "pdf-text-layer.js"));
}

async function loadLayouts(pdfPath, layer) {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
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
      const input = {
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      };
      pages.push({
        page: number,
        next: stampLayoutBids(number, textLayerToBlocks(input)),
        previous: stampLayoutBids(number, layer(input))
      });
    }
  } finally {
    await doc.destroy();
  }
  return pages;
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
      if (own) {
        if (pair.translation !== own) misses.push({ bid: pair.bid, where: "library", saved: pair.translation, expected: own });
        continue;
      }
      if (String(pair.translation).startsWith("译:")) {
        const named = String(pair.translation).slice(2).split("⟦")[0].split("[")[0];
        if (named !== pair.bid) misses.push({ bid: pair.bid, where: "library-foreign", saved: pair.translation });
      }
    }
  }
  for (const [bid, translation] of returned) {
    const pair = (snapshot.library || []).flatMap((page) => page.pairs || []).find((item) => item.bid === bid);
    if (!pair) misses.push({ bid, where: "library-missing", expected: translation });
    const row = (snapshot.shown || []).find((item) => item.bid === bid);
    if (!row) misses.push({ bid, where: "display-missing", expected: translation });
  }
  return misses;
}

const STUB = `(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get("oiAuto") || "";
  if (!mode) return;
  const scene = params.get("oiScene") || "";
  const settings = {
    provider: "mymemory",
    providers: { mymemory: { email: "" } },
    pdfAutoTranslate: true,
    targetLang: "zh-CN",
    pdfLayout: { mode: "text-layer" },
    batchSize: 8
  };
  const listeners = [];
  window.__oiAuto = { scene, batches: [], messages: [], saved: [] };
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
  const echoBids = new Set(${JSON.stringify(ECHO_ONLY)});
  function fresh(item) {
    if (echoBids.has(item.bid)) return String(item.text || "");
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
            const at = window.__oiAuto.library.findIndex((page) => Number(page.page) === Number(item.page));
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
        const at = pages.findIndex((page) => Number(page.page) === Number(item.page));
        if (at >= 0) pages[at] = item;
        else pages.push(item);
      }
      window.__oiAuto.library = pages;
      return new Response(JSON.stringify({ pageCount: fixture.pageCount || pages.length, pages }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
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
        if (type === "OI_TRANSLATE_BATCH") {
          const items = Array.isArray(message.items) ? message.items : [];
          window.__oiAuto.batches.push(items.length || (message.texts || []).length);
          const rows = shuffle(items.filter((item) => item && item.bid).map((item) => ({
            bid: item.bid,
            translation: fresh(item)
          })));
          window.__oiAuto.messages.push({
            texts: message.texts || [],
            items: items.map((item) => ({ bid: item.bid || "", text: item.text || "" })),
            returned: rows
          });
          const returned = [{ bid: "b1-p0-tmissing", translation: "不该出现" }].concat(rows);
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
    storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } }
  };
})();`;

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
      }, 30000);
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
    src: [...el.querySelectorAll(":scope .rf-src")].map((node) => node.textContent || "").join(" ").replace(/\\s+/g, " ").slice(0, 120)
  }));
  const trail = (window.__oiAuto && window.__oiAuto.timeline) || [];
  const skipTrail = {};
  for (const page of [11, 12, 13, 14]) {
    const hits = [];
    for (const row of trail) {
      const item = (row.pages || []).find((entry) => entry.page === page);
      if (!item) continue;
      if (!hits.length || hits[hits.length - 1] !== item.state) hits.push(item.state);
    }
    skipTrail[page] = hits.slice(0, 6);
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
    saved: (window.__oiAuto && window.__oiAuto.saved) || []
  });
})()`;

test("打开阅读器时译文按 bid 回写，旧缓存第二次打开不再请求", { timeout: 600000 }, async (t) => {
  assert.equal(readFileSync(dpoPath).byteLength > 0, true);
  assert.equal(readFileSync(attentionPath).byteLength > 0, true);
  const mainLayer = (await historicalLayer(MAIN_V2)).textLayerToBlocks;
  const dpoMain = (await loadLayouts(dpoPath, mainLayer)).map((entry) => ({ ...entry, scene: "main" }));
  const attention = (await loadLayouts(attentionPath, mainLayer)).map((entry) => ({ ...entry, scene: "attention" }));
  fixtures.set("main", keepEchoOnly(libraryFor(dpoMain)));
  for (const page of [22, 23]) {
    const entry = dpoMain.find((item) => item.page === page);
    assert.equal(isSkipOnlyPage(entry.previous.blocks), false, `main p${page} is not a reference page`);
    assert.equal(isSkipOnlyPage(entry.next.blocks), false, `current p${page} is not a reference page`);
  }
  fixtures.set("tip", { pageCount: dpoMain.length, pages: [] });
  fixtures.set("attention", libraryFor(attention));

  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-align-"));
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
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: STUB }, sessionId);

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

  const openScene = async (scene, pdfName) => {
    const src = `${origin}/tests/fixtures/${pdfName}`;
    const viewer = `${origin}/pdf/viewer.html?oiAuto=align&oiScene=${scene}&src=${encodeURIComponent(src)}`;
    await cdp.send("Page.navigate", { url: viewer }, sessionId);
    const started = Date.now();
    let last = null;
    while (Date.now() - started < 180000) {
      const raw = await evaluate(READ);
      last = JSON.parse(raw);
      const terminal = last.pages.length > 0 && last.pages.every((row) => (
        row.state === "done" || row.state === "skipped" || row.state === "empty" || row.state === "held"
      ));
      if (terminal && last.state === "done") {
        await sleep(500);
        const again = JSON.parse(await evaluate(READ));
        if (again.state === "done" && JSON.stringify(again.saved) === JSON.stringify(last.saved)) {
          again.elapsed = Date.now() - started;
          return again;
        }
        last = again;
        continue;
      }
      await sleep(400);
    }
    const brief = {
      doc: last?.doc,
      state: last?.state,
      status: last?.status,
      batches: last?.batches,
      pages: (last?.pages || []).map((row) => `${row.page}:${row.state}`).join(",")
    };
    throw new Error(`${scene} did not finish: ${JSON.stringify(brief)}`);
  };

  const sentBids = (snapshot) => snapshot.messages.flatMap((message) => message.items.map((item) => item.bid).filter(Boolean));

  const main = await openScene("main", "Direct_Preference_Optimization_2305.18290.pdf");
  const mainMisses = assess(main);
  assert.equal(mainMisses.length, 0, `main misalignment ${mainMisses.length}: ${JSON.stringify(mainMisses.slice(0, 6))}`);
  assert.equal(main.messages.every((message) => message.items.every((item) => item.bid)), true);
  for (const bid of WATCH) {
    const row = main.shown.find((item) => item.bid === bid);
    assert.ok(row && visibleText(row.zh), `${bid} has a displayed translation`);
    assert.equal(sentBids(main).includes(bid), false, `${bid} is reused, not re-requested`);
    assert.match(visibleText(row.zh), /^旧译/);
  }
  assert.equal(main.pages.filter((row) => row.page === 20 || row.page === 27).every((row) => row.state === "done"), true);
  assert.equal(main.shown.some((row) => row.zh.includes("不该出现")), false);
  for (const bid of ECHO_ONLY) {
    assert.equal(sentBids(main).includes(bid), false, `${bid} echo is kept, not re-requested`);
    const row = main.shown.find((item) => item.bid === bid);
    assert.ok(row && visibleText(row.zh), `${bid} echo stays on screen`);
  }
  for (const page of [12, 13, 14]) {
    const row = main.pages.find((item) => item.page === page);
    assert.equal(row.state, "skipped", `p${page} state ${row.state}`);
    assert.equal(row.ps, "参考文献 · 保留原文");
    assert.equal(row.blocks, 13, `p${page} blocks ${row.blocks}`);
    assert.match(row.src, /\[\d+\]/);
    const trail = main.skipTrail[page] || [];
    assert.equal(trail.includes("empty") || trail.includes("running"), false, `p${page} trail ${JSON.stringify(trail)}`);
    assert.equal(trail.includes("skipped"), true, `p${page} trail ${JSON.stringify(trail)}`);
  }
  for (const page of [22, 23]) {
    const row = main.pages.find((item) => item.page === page);
    assert.notEqual(row.state, "skipped", `p${page} is an appendix, not a reference page`);
    assert.equal(row.ps.includes("参考文献"), false, row.ps);
    assert.ok(row.blocks > 0, `p${page} still has blocks`);
  }

  const reopened = await openScene("main", "Direct_Preference_Optimization_2305.18290.pdf");
  const reopenMisses = assess(reopened);
  assert.equal(reopenMisses.length, 0, `reopen misalignment ${reopenMisses.length}: ${JSON.stringify(reopenMisses.slice(0, 6))}`);
  assert.equal(reopened.batches, 0, JSON.stringify({
    batches: reopened.batches,
    bids: sentBids(reopened),
    states: reopened.pages.filter((row) => row.state !== "done" && row.state !== "skipped" && row.state !== "empty"),
    saved: (reopened.saved || []).map((page) => ({ page: page.page, pairs: (page.pairs || []).length, skipped: page.skipped === true }))
  }));
  for (const bid of WATCH) {
    const row = reopened.shown.find((item) => item.bid === bid);
    assert.ok(row && visibleText(row.zh), `${bid} still displayed after reopen`);
  }
  for (const bid of ECHO_ONLY) {
    assert.equal(sentBids(reopened).includes(bid), false, `${bid} echo is not requested on reopen`);
  }
  assert.equal(reopened.pages.filter((row) => row.page === 20 || row.page === 27).every((row) => row.state === "done"), true);

  const laidOut = JSON.parse(await evaluate("JSON.stringify(window.__oiLayouts || {})"));
  const tipPages = [];
  for (let number = 1; number <= dpoMain.length; number += 1) {
    const blocks = laidOut[String(number)] || laidOut[number] || [];
    if (!blocks.length) {
      tipPages.push({ page: number, pairs: [], skipped: true });
      continue;
    }
    const pairs = [];
    for (const block of blocks) {
      if (WATCH.includes(block.bid)) pairs.push(pairFrom(block, block.text));
      pairs.push(pairFrom(block, oldTranslation(block)));
    }
    tipPages.push({ page: number, pairs });
  }
  fixtures.set("tip", { pageCount: dpoMain.length, pages: tipPages });

  const tip = await openScene("tip", "Direct_Preference_Optimization_2305.18290.pdf");
  const tipMisses = assess(tip);
  assert.equal(tipMisses.length, 0, `tip misalignment ${tipMisses.length}: ${JSON.stringify(tipMisses.slice(0, 6))}`);
  assert.equal(tip.batches, 0, JSON.stringify({
    batches: tip.batches,
    bids: sentBids(tip)
  }));
  for (const bid of WATCH) {
    const row = tip.shown.find((item) => item.bid === bid);
    assert.ok(row && visibleText(row.zh), `${bid} recovered from the 6bfa659 library`);
    assert.match(visibleText(row.zh), /^旧译/);
  }

  await openScene("attention", "Attention_Is_All_You_Need.pdf");
  const attentionLaid = JSON.parse(await evaluate("JSON.stringify(window.__oiLayouts || {})"));
  const attentionPages = [];
  const skippedOnMain = new Set(attention.filter((entry) => isSkipOnlyPage(entry.previous.blocks)).map((entry) => entry.page));
  for (let number = 1; number <= attention.length; number += 1) {
    const blocks = attentionLaid[String(number)] || attentionLaid[number] || [];
    if (!blocks.length || skippedOnMain.has(number)) {
      attentionPages.push({ page: number, pairs: [], skipped: true });
      continue;
    }
    attentionPages.push({
      page: number,
      pairs: blocks.map((block) => pairFrom(block, oldTranslation(block)))
    });
  }
  fixtures.set("attention2", { pageCount: attention.length, pages: attentionPages });
  const paper = await openScene("attention2", "Attention_Is_All_You_Need.pdf");
  const attentionMisses = assess(paper);
  assert.equal(attentionMisses.length, 0, `attention misalignment ${attentionMisses.length}: ${JSON.stringify(attentionMisses.slice(0, 6))}`);
  assert.equal(paper.batches, 0, JSON.stringify({ batches: paper.batches, bids: sentBids(paper) }));
  assert.equal(paper.pages.length, 15);
  assert.equal(paper.pages.every((row) => row.state === "done" || row.state === "skipped" || row.state === "empty"), true);
  const skipped = new Set(paper.pages.filter((row) => row.state === "skipped").map((row) => row.page));
  for (const page of skippedOnMain) {
    assert.equal(skipped.has(page), true, `page ${page} stays skipped`);
    const row = paper.pages.find((item) => item.page === page);
    assert.equal(row.ps, "参考文献 · 保留原文");
    assert.ok(row.blocks > 0, `attention p${page} blocks`);
    const trail = paper.skipTrail[page] || [];
    assert.equal(trail.includes("empty") || trail.includes("running"), false, `attention p${page} trail ${JSON.stringify(trail)}`);
    assert.equal(trail.includes("skipped"), true, `attention p${page} trail ${JSON.stringify(trail)}`);
  }
  t.diagnostic(JSON.stringify({
    main: {
      requests: main.batches,
      blocks: sentBids(main).length,
      misalignment: mainMisses.length,
      elapsedMs: main.elapsed,
      skip: [12, 13, 14].map((page) => {
        const row = main.pages.find((item) => item.page === page);
        return { page, state: row.state, blocks: row.blocks };
      })
    },
    reopen: { requests: reopened.batches, misalignment: reopenMisses.length, elapsedMs: reopened.elapsed },
    tip: { requests: tip.batches, misalignment: tipMisses.length, elapsedMs: tip.elapsed },
    attention: {
      requests: paper.batches,
      misalignment: attentionMisses.length,
      pages: paper.pages.length,
      elapsedMs: paper.elapsed,
      skip: [...skippedOnMain].map((page) => {
        const row = paper.pages.find((item) => item.page === page);
        return { page, state: row.state, blocks: row.blocks };
      })
    }
  }));
});
