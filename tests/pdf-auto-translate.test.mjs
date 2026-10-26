// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// arXiv v7 (15 pages), https://arxiv.org/pdf/1706.03762v7
// sha256 bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { e2eLibrarySceneResetSource, storedLibraryPagesSource } from "./helpers/library-observe.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const AUTO_TMP_PREFIXES = ["oi-auto-translate-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(AUTO_TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const FIXTURE_SHA256 = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
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

const STUB = `(() => {
  const params = new URLSearchParams(location.search);
  const mode = params.get("oiAuto") || "";
  if (!mode || mode === "runtime") return;
  ${e2eLibrarySceneResetSource()}
  const lang = params.get("oiLang") || (mode === "en" ? "en" : mode === "ja" ? "ja" : "zh-CN");
  const delayMs = Number(params.get("oiDelay") || 0);
  const settings = {
    provider: mode === "missing" ? "openai" : "mymemory",
    providers: {
      mymemory: { email: "" },
      openai: { apiKey: "" }
    },
    pdfAutoTranslate: mode !== "off",
    targetLang: lang,
    pdfLayout: mode === "local"
      ? { mode: "local-ocr", localBaseUrl: "http://127.0.0.1:8765" }
      : { mode: "" },
    batchSize: mode === "retryOpenBody" ? 1 : 8
  };
  if (mode === "echo") sessionStorage.removeItem("oiSavedLib");
  window.__oiAuto = { mode, lang, batches: [], texts: [], messages: [], page3AtFirstBatch: null, clickedDuringOpen: false, saved: [] };
  const libraryText = lang === "en"
    ? "Stored English translation for this page."
    : lang === "ja"
      ? "ちゅういりょくのやく"
      : "这是库里已经存好的一句译文。";
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/v1/library/")) {
      const wait = (mode === "openRace" ? 80 : 0) + (delayMs > 0 ? Math.random() * delayMs : 0);
      if (wait > 0) await new Promise((done) => setTimeout(done, wait));
      if (init && String(init.method || "").toUpperCase() === "POST") {
        let body = {};
        try { body = JSON.parse(init.body || "{}"); } catch { body = {}; }
        const prev = JSON.parse(sessionStorage.getItem("oiSavedLib") || "[]");
        const page = Number(body.page) || 0;
        const pages = prev.filter((item) => Number(item.page) !== page);
        if (page) pages.push({ page, pairs: body.pairs || [], skipped: body.skipped === true });
        sessionStorage.setItem("oiSavedLib", JSON.stringify(pages));
        window.__oiAuto.saved = pages;
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }
      if (mode === "replay" || mode === "polluted") {
        const key = mode === "polluted" ? "oiPolluted" : "oiRecorded";
        const pages = JSON.parse(sessionStorage.getItem(key) || "[]");
        return new Response(JSON.stringify({ pageCount: 15, pages }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (mode === "cache") {
        return new Response(JSON.stringify({
          pageCount: 15,
          pages: [
            {
              page: 1,
              pairs: [{
                sourceId: "cached-sentence",
                text: "Cached sentence that is not on the page.",
                translation: "这是库里已经存好的一句译文。"
              }]
            },
            {
              page: 2,
              pairs: [{
                text: "Stored page two sentence.",
                translation: "第二页库译文。"
              }]
            },
            {
              page: 5,
              pairs: [{
                text: "Stored page five sentence.",
                translation: "第五页库译文。"
              }]
            }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (mode === "cacheHead") {
        return new Response(JSON.stringify({
          pageCount: 15,
          pages: [
            {
              page: 1,
              pairs: [{ text: "Cached sentence that is not on the page.", translation: "这是库里已经存好的一句译文。" }]
            },
            {
              page: 2,
              pairs: [{ text: "Stored page two sentence.", translation: "第二页库译文。" }]
            }
          ]
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (mode === "article") {
        return new Response(JSON.stringify({
          pageCount: 15,
          readout: "这是库里的通读稿，只有开头这一段旧译文。\\n\\n后面的页还没有逐页译文，重新打开要继续译。"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (mode === "cacheAll") {
        const pages = [];
        for (let page = 1; page <= 15; page += 1) {
          if (page === 11 || page === 12) continue;
          const pairs = page === 1
            ? [{ text: "Abstract", translation: libraryText }]
            : [{ text: "Stored sentence for page " + page + ".", translation: libraryText }];
          pages.push({ page, pairs });
        }
        return new Response(JSON.stringify({ pageCount: 15, pages }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response("missing", { status: 404 });
    }
    if (mode === "local" && url.includes("127.0.0.1:8765")) {
      throw new TypeError("Failed to fetch");
    }
    return origFetch(input, init);
  };
  globalThis.chrome = {
    runtime: {
      id: "oi-e2e",
      getURL() {
        return new URL("./vendor/pdf.worker.min.mjs", location.href).href;
      },
      sendMessage(message) {
        const type = message && message.type;
        if (type === "OI_GET_SETTINGS") return Promise.resolve({ settings });
        if (type === "OI_PDF_STRUCTURE") {
          if (mode === "retryOpen" || mode === "retryOpenBody") {
            return Promise.resolve({
              ok: true,
              raw: JSON.stringify({
                version: 1,
                title: "Synthesized Title For Retry",
                authors: [{ name: "Ada Lovelace", affiliation: "Analytical Engines", email: "ada@example.com" }],
                abstract: {
                  heading: "Abstract",
                  body: "A synthesized abstract that is not a line on the page."
                }
              })
            });
          }
          if (mode === "struct") {
            return Promise.resolve({
              ok: true,
              raw: JSON.stringify({
                version: 1,
                title: "Attention Is All You Need",
                authors: [
                  { name: "Ashish Vaswani", affiliation: "Google Brain", email: "avaswani@google.com" },
                  { name: "Noam Shazeer", affiliation: "Google Brain", email: "noam@google.com" },
                  { name: "Niki Parmar", affiliation: "Google Research", email: "nikip@google.com" },
                  { name: "Jakob Uszkoreit", affiliation: "Google Research", email: "usz@google.com" },
                  { name: "Llion Jones", affiliation: "Google Research", email: "llion@google.com" },
                  { name: "Aidan N. Gomez", affiliation: "University of Toronto", email: "aidan@cs.toronto.edu" },
                  { name: "Łukasz Kaiser", affiliation: "Google Brain", email: "lukaszkaiser@google.com" },
                  { name: "Illia Polosukhin", affiliation: "Google Research", email: "illia.polosukhin@gmail.com" }
                ],
                abstract: {
                  heading: "Abstract",
                  body: "The dominant sequence transduction models are based on complex recurrent or convolutional neural networks."
                },
                rest: [{ role: "other", text: "Equal contribution." }]
              })
            });
          }
          return Promise.resolve({ ok: false });
        }
        if (type === "OI_TRANSLATE_BATCH") {
          if (window.__oiAuto.page3AtFirstBatch == null) {
            window.__oiAuto.page3AtFirstBatch = document.querySelector('#readerFlow .rf-page[data-page="3"]')?.dataset.state || "";
          }
          const texts = message.texts || [];
          window.__oiAuto.batches.push(texts.length);
          window.__oiAuto.texts.push(...texts);
          const runningPages = [...document.querySelectorAll("#readerFlow .rf-page")]
            .filter((el) => el.dataset.state === "running" || el.dataset.state === "layout")
            .map((el) => el.dataset.page || "")
            .filter(Boolean);
          const capsulePage = document.getElementById("pageCapsule")?.dataset.srcPage || "";
          const page = runningPages.includes(capsulePage) ? capsulePage : (runningPages[0] || capsulePage);
          window.__oiAuto.messages.push({ bypassCache: message.bypassCache === true, texts, page });
          if (mode === "hang") return new Promise(() => {});
          if (mode === "bothfail") return Promise.resolve({ ok: false, error: "500" });
          if (mode === "echo") return Promise.resolve({ ok: true, translations: texts.slice() });
          const index = window.__oiAuto.batches.length - 1;
          if ((mode === "retryTitle" || mode === "retryOpen") && index === 0) return Promise.resolve({ ok: false, error: "500" });
          if (mode === "retryBody" && index === 1) return Promise.resolve({ ok: false, error: "500" });
          if (mode === "retryOpenBody" && texts.some((text) => String(text).includes("second sentence")) && !window.__oiAuto.bodyFailed) {
            window.__oiAuto.bodyFailed = true;
            return Promise.resolve({ ok: false });
          }
          if (mode === "retryBoth" && index < 2) return Promise.resolve({ ok: false, error: "500" });
          if (mode === "short") {
            return Promise.resolve({
              ok: true,
              translations: texts.map((text, index) => (index === texts.length - 1 ? "" : "译:" + text))
            });
          }
          if (lang === "en") {
            return Promise.resolve({
              ok: true,
              translations: texts.map(() => "Rendered English translation for the reader.")
            });
          }
          if (lang === "ja") {
            return Promise.resolve({
              ok: true,
              translations: texts.map(() => "ちゅういりょくのやく")
            });
          }
          const pad = mode === "fast" ? " " + "译文补长以撑起右栏。".repeat(40) : "";
          return Promise.resolve({
            ok: true,
            translations: texts.map((text) => "译:" + text + pad)
          });
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
  if (mode === "openRace") {
    const timer = setInterval(() => {
      const phase = document.querySelector("#docStatus")?.dataset.state || "";
      const button = document.getElementById("retranslatePageItem");
      if (phase === "opening" && button && !button.disabled) {
        clearInterval(timer);
        window.__oiAuto.clickedDuringOpen = true;
        button.click();
      }
    }, 5);
    setTimeout(() => clearInterval(timer), 20000);
  }
})();`;

function serveRepo(extras = new Map()) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const extra = extras.get(rel);
    if (extra) {
      res.writeHead(200, {
        "content-type": MIME[extname(rel)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(extra);
      return;
    }
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
    env: {
      ...process.env,
      TMPDIR: scratchDir,
      TMP: scratchDir,
      TEMP: scratchDir
    },
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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const SNAPSHOT = `(() => JSON.stringify({
  segment: "",
  pages: document.querySelectorAll("#pages .pdf-page").length,
  folds: document.querySelectorAll("#readerFlow .rf-untranslated").length,
  ranges: document.querySelectorAll("#readerFlow .rf-q").length,
  untranslatedText: [...document.querySelectorAll("#readerFlow .rf-untranslated")].map((el) => el.textContent || "").join("\\n"),
  progress: document.querySelector("#readerFlow .rf-ps[data-kind='running'] .rf-ps-text")?.textContent || "",
  bar: document.querySelector("#readerFlow .rf-ps-bar i")?.style.inlineSize || "",
  flowHasUntranslated: (document.getElementById("readerFlow")?.innerText || "").includes("未翻译"),
  doc: document.querySelector("#docStatus .doc-text")?.textContent || "",
  docState: document.querySelector("#docStatus")?.dataset.state || "",
  page1: document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "",
  status: document.getElementById("status")?.textContent || "",
  label: (document.getElementById("translatePage")?.textContent || "").trim(),
  hidden: document.getElementById("translatePage")?.hidden === true,
  restore: (document.querySelector('#viewSeg [data-view="src"]')?.textContent || "").trim(),
  retranslate: (document.getElementById("retranslatePage")?.textContent || "").trim(),
  batches: (window.__oiAuto && window.__oiAuto.batches || []).length,
  pairs: document.querySelectorAll("#readerFlow .rf-block[data-pair-id]").length,
  view: document.querySelector(".workspace")?.dataset.view || ""
}))()`;

test("打开 PDF 自动全文翻译：缓存、开关、运行环境与进度占位", { timeout: 480000 }, async (t) => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  const digest = createHash("sha256").update(readFileSync(fixture)).digest("hex");
  assert.equal(digest, FIXTURE_SHA256);

  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-auto-translate-"));
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
      await cleanupChrome({
        t,
        child: handle.child,
        server,
        ownedDir,
        userDataDir
      });
    }
  });

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
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

  const waitFor = async (expression, label, timeoutMs = 90000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(200);
    }
    const status = await evaluate(`document.getElementById("status")?.textContent || ""`).catch(() => "");
    throw new Error(`${label} timed out. status=${status} last=${JSON.stringify(last)}`);
  };

  const openMode = async (mode, extra = {}) => {
    const lang = extra.lang ? `&oiLang=${encodeURIComponent(extra.lang)}` : "";
    const delay = process.env.OI_AUTO_DELAY ? `&oiDelay=${encodeURIComponent(process.env.OI_AUTO_DELAY)}` : "";
    const viewer = `${origin}/pdf/viewer.html?oiAuto=${mode}${lang}${delay}&src=${encodeURIComponent(src)}`;
    await cdp.send("Page.navigate", { url: viewer }, sessionId);
    if (mode === "runtime") {
      await waitFor(`(() => {
        const text = document.querySelector("#docStatus .doc-text")?.textContent || "";
        const state = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
        const status = document.getElementById("status")?.textContent || "";
        const reading = text.includes("正在读取 PDF") || text.includes("已译 0 /");
        if (!reading) return "";
        if (state === "layout" || state === "running") return state;
        if (status.includes("无法翻译") && status.includes("扩展") && state) return state;
        return "";
      })()`, "LD-01 顶栏与第 1 页", 15000);
    }
    if (mode === "fast") {
      await evaluate(`(() => {
        window.__oiDrift = { max: 0, samples: 0 };
        const pane = document.getElementById("translateScroll");
        let lastId = "";
        let lastTop = 0;
        const tick = () => {
          if (!pane) return;
          const paneTop = pane.getBoundingClientRect().top + 1;
          const block = [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => el.getBoundingClientRect().bottom > paneTop);
          if (block) {
            const id = block.dataset.blockId || block.dataset.pairId || "";
            const top = block.getBoundingClientRect().top;
            if (window.__oiArmDrift && id && id === lastId) {
              const drift = Math.abs(top - lastTop);
              if (drift > window.__oiDrift.max) window.__oiDrift.max = drift;
              window.__oiDrift.samples += 1;
            }
            lastId = id;
            lastTop = top;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        return true;
      })()`);
    }
    await waitFor(`(() => {
      const pager = document.getElementById("sourcePageLabel")?.textContent || "";
      return /\\/\\s*15/.test(pager) ? pager : "";
    })()`, `${mode}: Attention PDF open`);
  };

  const read = async () => JSON.parse(await evaluate(SNAPSHOT));

  await openMode("runtime");
  const runtime = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (!data.status.includes("无法翻译") || !data.status.includes("扩展")) return "";
    return row;
  })()`, "runtime: 状态栏说明扩展不可用"));
  assert.equal(runtime.pages, 15);
  assert.equal(runtime.folds, 0);
  assert.equal(runtime.ranges, 1);
  assert.equal(runtime.flowHasUntranslated, false);
  assert.match(runtime.doc, /已译 0 \/ 15 页|正在读取 PDF/);
  assert.equal(runtime.batches, 0);
  assert.equal(runtime.label, "翻译");
  assert.equal(runtime.hidden, false);
  assert.equal(runtime.restore, "原文");
  assert.equal(runtime.retranslate, "重译本页");
  assert.match(runtime.status, /chrome:\/\/extensions/);
  assert.match(runtime.status, /重新加载/);
  const toolbar = JSON.parse(await evaluate(`(() => {
    const bar = document.querySelector(".toolbar");
    const barBox = bar.getBoundingClientRect();
    const label = document.getElementById("sourcePageLabel");
    const prev = document.getElementById("sourcePrev").getBoundingClientRect();
    const next = document.getElementById("sourceNext").getBoundingClientRect();
    const head = document.querySelector(".source-head").getBoundingClientRect();
    return JSON.stringify({
      barH: barBox.height,
      headH: head.height,
      pagerInToolbar: Boolean(bar.querySelector("#pager, #prev, #next")),
      pickHidden: getComputedStyle(document.getElementById("pick")).display === "none",
      label: label.textContent || "",
      prev: prev.width,
      next: next.width,
      value: label.getBoundingClientRect().width,
      inHead: Boolean(label.closest(".source-head"))
    });
  })()`));
  assert.equal(toolbar.barH, 48);
  assert.equal(toolbar.headH, 36);
  assert.equal(toolbar.pagerInToolbar, false);
  assert.equal(toolbar.pickHidden, true);
  assert.match(toolbar.label, /\/\s*15/);
  assert.equal(toolbar.prev, 24);
  assert.equal(toolbar.next, 24);
  assert.ok(toolbar.value >= 52);
  assert.equal(toolbar.inHead, true);

  await openMode("off");
  const off = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (data.pages !== 15 || data.pairs < 1 || data.ranges < 1 || data.batches !== 0 || data.folds !== 0) return "";
    return row;
  })()`, "off: 页面已打开且没有自动开译"));
  await sleep(600);
  const offSettled = await read();
  assert.equal(offSettled.batches, 0);
  assert.equal(offSettled.folds, 0);
  assert.ok(offSettled.ranges >= 1);
  assert.equal(offSettled.flowHasUntranslated, false);
  assert.equal(offSettled.status.includes("无法翻译"), false);
  assert.equal(off.batches, 0);
  await sleep(600);
  const stayed = await read();
  assert.equal(stayed.batches, 0);
  assert.equal(stayed.progress, "");

  await openMode("missing");
  const missing = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    const outbound = document.documentElement.dataset.oiOutbound || "";
    if (outbound !== "mymemory-free") return "";
    return JSON.stringify({ ...data, outbound });
  })()`, "missing: 未配置引擎时改用免费 MyMemory"));
  assert.equal(missing.outbound, "mymemory-free");
  assert.equal(missing.status.includes("API Key"), false);
  assert.equal(missing.label, "翻译");

  await openMode("local");
  const local = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (!data.status.includes("本机服务没启动")) return "";
    return row;
  })()`, "local: 状态栏说明本机服务没启动"));
  assert.equal(local.batches, 0);
  assert.match(local.status, /127\.0\.0\.1:8765/);
  assert.equal(local.label, "翻译");

  await openMode("cache");
  const cached = JSON.parse(await waitFor(`(() => {
    const gap = (window.__oiLibraryGap || []).find((item) => item.page === 2 && item.pairs < item.live);
    if (!window.__oiAuto || window.__oiAuto.page3AtFirstBatch == null) return "";
    if (!gap) return "";
    return JSON.stringify({
      page1: document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "",
      page2: document.querySelector('#readerFlow .rf-page[data-page="2"]')?.dataset.state || "",
      page3: window.__oiAuto.page3AtFirstBatch,
      page5: document.querySelector('#readerFlow .rf-page[data-page="5"]')?.dataset.state || "",
      bare: (window.__oiDoneWithoutTranslation || []).join(","),
      doc: document.querySelector("#docStatus .doc-text")?.textContent || "",
      batches: (window.__oiAuto && window.__oiAuto.batches || []).length,
      texts: (window.__oiAuto && window.__oiAuto.texts || []).join("\\n"),
      pairs: gap.pairs,
      live: gap.live
    });
  })()`, "cache: 对不上活块的库页进队，缺页继续译"));
  assert.ok(cached.pairs < cached.live, "库对 < 活块须进队");
  assert.notEqual(cached.page3, "done");
  assert.equal(cached.bare, "");
  assert.doesNotMatch(cached.doc, /全文已译/);
  assert.equal(cached.texts.includes("Stored page two sentence"), false);
  assert.equal(cached.texts.includes("Stored page five sentence"), false);
  const cacheMoved = JSON.parse(await waitFor(`(() => {
    const batches = (window.__oiAuto && window.__oiAuto.batches || []).length;
    const page3 = document.querySelector('#readerFlow .rf-page[data-page="3"]')?.dataset.state || "";
    if (batches < 1 && page3 !== "running") return "";
    return JSON.stringify({ batches, page3, doc: document.querySelector("#docStatus .doc-text")?.textContent || "" });
  })()`, "cache: 缺页进入翻译"));
  assert.ok(cacheMoved.batches >= 1 || cacheMoved.page3 === "running");
  assert.doesNotMatch(cacheMoved.doc, /全文已译/);

  const stripped = JSON.parse(await evaluate(`(() => {
    const slot = document.querySelector('#readerFlow .rf-page[data-page="2"]');
    slot.querySelectorAll(".rf-zh, .rf-src").forEach((el) => el.remove());
    slot.dataset.state = "done";
    slot.dataset.painted = "1";
    window.__oiRenderArticle();
    return JSON.stringify({
      state: slot.dataset.state || "",
      zh: slot.querySelector(".rf-zh")?.textContent || ""
    });
  })()`));
  assert.ok(stripped.state !== "done" || stripped.zh.includes("译:"), "没有译文不能维持 done");

  await openMode("cacheHead");
  const head = JSON.parse(await waitFor(`(() => {
    const gap = (window.__oiLibraryGap || []).find((item) => item.page === 2 && item.pairs < item.live);
    if (!gap) return "";
    if (!window.__oiAuto || window.__oiAuto.page3AtFirstBatch == null) return "";
    return JSON.stringify({
      page3: window.__oiAuto.page3AtFirstBatch,
      batches: window.__oiAuto.batches.length,
      doc: document.querySelector("#docStatus .doc-text")?.textContent || ""
    });
  })()`, "cacheHead: 库里最后一页之后的缺页也进队列"));
  assert.notEqual(head.page3, "done");
  assert.ok(head.batches >= 1);
  assert.doesNotMatch(head.doc, /全文已译/);

  await openMode("article");
  const article = JSON.parse(await waitFor(`(() => {
    const batches = (window.__oiAuto && window.__oiAuto.batches || []).length;
    if (batches < 1) return "";
    return JSON.stringify({
      batches,
      doc: document.querySelector("#docStatus .doc-text")?.textContent || ""
    });
  })()`, "article: 只有通读稿时继续译后面的页"));
  assert.ok(article.batches >= 1);

  await openMode("hang");
  const hang = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (data.batches < 1) return "";
    if (!/正在翻译 · \\d+ \\/ \\d+ 段/.test(data.progress)) return "";
    if (data.folds !== 0 || data.flowHasUntranslated) return "";
    if (!data.doc.includes("已译")) return "";
    return row;
  })()`, "hang: 自动开始且右栏显示段进度"));
  assert.equal(hang.folds, 0);
  assert.equal(hang.ranges <= 1, true);
  assert.equal(hang.flowHasUntranslated, false);
  assert.equal(hang.untranslatedText, "");
  assert.match(hang.progress, /^正在翻译 · \d+ \/ \d+ 段$/);
  assert.match(hang.bar, /%$/);
  assert.match(hang.doc, /已译 \d+ \/ 15 页/);
  assert.doesNotMatch(hang.doc, /全文已译/);
  assert.equal(hang.page1, "running");
  assert.ok(hang.batches >= 1);
  assert.equal(hang.restore, "原文");
  assert.equal(hang.retranslate, "重译本页");

  await evaluate(`document.querySelector('#viewSeg [data-view="src"]').click()`);
  const toggled = await read();
  assert.equal(toggled.view, "src");
  assert.equal(toggled.hidden, true, "原文切换不中止翻译");
  assert.ok(toggled.batches >= hang.batches);
  assert.equal(toggled.page1, "running");
  assert.doesNotMatch(toggled.status, /已停止/);

  const queuedBefore = await evaluate(`document.querySelector('#readerFlow .rf-page[data-page="2"]')?.dataset.state || ""`);
  await evaluate(`document.getElementById("stopTranslate").click()`);
  await waitFor(`document.getElementById("translatePage")?.hidden === false ? "idle" : ""`, "停止后主按钮回到翻译");
  const retried = JSON.parse(await waitFor(`(() => {
    const state = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    if (state === "running") return ${SNAPSHOT};
    const button = document.getElementById("retranslatePageItem");
    if (button && !button.disabled) button.click();
    return "";
  })()`, "LD-08 重译胶囊页"));
  assert.equal(retried.page1, "running");
  const page2 = await evaluate(`document.querySelector('#readerFlow .rf-page[data-page="2"]')?.dataset.state || ""`);
  assert.equal(page2, queuedBefore);

  await openMode("fast");
  await waitFor(`(() => {
    const pane = document.getElementById("translateScroll");
    const block = document.querySelector("#readerFlow .rf-block");
    if (!pane || !block) return "";
    if (pane.scrollHeight - pane.clientHeight < 360) return "";
    return "tall";
  })()`, "fast: 译文高过视口");
  const armed = JSON.parse(await evaluate(`(() => {
    const pane = document.getElementById("translateScroll");
    const block = [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => el.querySelector(".rf-zh"));
    pane.scrollTop = 280;
    window.__oiAnchorId = block?.dataset.blockId || block?.dataset.pairId || "";
    const spacer = document.createElement("div");
    spacer.id = "oiScrollSpacer";
    spacer.style.height = "48px";
    document.getElementById("readerFlow").prepend(spacer);
    const top = block ? block.getBoundingClientRect().top : 0;
    window.__oiAnchorTop = top;
    window.__oiArmDrift = true;
    window.__oiMinScroll = pane.scrollTop;
    pane.addEventListener("scroll", () => {
      if (pane.scrollTop < window.__oiMinScroll) window.__oiMinScroll = pane.scrollTop;
    });
    return JSON.stringify({ scroll: pane.scrollTop, top });
  })()`));
  assert.ok(armed.scroll >= 279, `scrollTop stuck at ${armed.scroll}`);
  const drifted = JSON.parse(await evaluate(`(() => {
    window.__oiRenderArticle();
    const pane = document.getElementById("translateScroll");
    const block = window.__oiAnchorId
      ? document.querySelector('#readerFlow [data-block-id="' + window.__oiAnchorId + '"], #readerFlow [data-pair-id="' + window.__oiAnchorId + '"]')
      : document.querySelector("#readerFlow .rf-block");
    const top = block ? block.getBoundingClientRect().top : window.__oiAnchorTop;
    return JSON.stringify({
      scroll: pane.scrollTop,
      minScroll: window.__oiMinScroll,
      drift: Math.abs(top - window.__oiAnchorTop)
    });
  })()`));
  assert.ok(drifted.drift <= 1, `viewport drift ${drifted.drift}px`);
  assert.ok(drifted.scroll >= 200, `scrollTop collapsed to ${drifted.scroll}`);
  const collapsed = JSON.parse(await evaluate(`(() => {
    const pane = document.getElementById("translateScroll");
    pane.scrollTop = 280;
    window.__oiForceScrollCollapse = true;
    window.__oiRenderArticle();
    window.__oiForceScrollCollapse = false;
    return JSON.stringify({ scroll: pane.scrollTop });
  })()`));
  assert.ok(Math.abs(collapsed.scroll - 280) <= 1, `writeback left scrollTop ${collapsed.scroll}`);
  const noAnchor = JSON.parse(await evaluate(`(() => {
    const pane = document.getElementById("translateScroll");
    document.querySelectorAll("#readerFlow .rf-block").forEach((el) => {
      el.classList.remove("rf-block");
      delete el.dataset.blockId;
      delete el.dataset.pairId;
    });
    pane.scrollTop = 280;
    window.__oiForceScrollCollapse = true;
    window.__oiRenderArticle();
    window.__oiForceScrollCollapse = false;
    return JSON.stringify({
      scroll: pane.scrollTop,
      tall: pane.scrollHeight - pane.clientHeight
    });
  })()`));
  assert.ok(noAnchor.tall >= 200, `no-anchor content is not tall (${noAnchor.tall})`);
  assert.ok(Math.abs(noAnchor.scroll - 280) <= 1, `no-anchor writeback left scrollTop ${noAnchor.scroll}`);

  await waitFor(`(() => {
    const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
    if (!doc.includes("全文已译")) return "";
    if (document.getElementById("translatePage")?.hidden !== false) return "";
    const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    if (page1 === "running" || page1 === "layout") return "";
    return "idle";
  })()`, "fast: 全文译完后主按钮回到翻译", 180000);
  await evaluate(`(async () => {
    ${storedLibraryPagesSource()}
    sessionStorage.setItem("oiRecorded", JSON.stringify(await oiStoredLibraryPages()));
    return true;
  })()`);
  const forced = JSON.parse(await waitFor(`(() => {
    const auto = window.__oiAuto || (window.__oiAuto = { messages: [] });
    const all = auto.messages || [];
    const pane = document.getElementById("translateScroll");
    const capsuleNow = () => document.getElementById("pageCapsule")?.dataset.srcPage || "";
    const pinPageOne = () => {
      if (!pane) return false;
      document.querySelectorAll("#readerFlow [data-src-page]").forEach((el) => el.classList.add("rf-block"));
      if (pane.scrollTop > 1) pane.scrollTop = 0;
      pane.dispatchEvent(new Event("scroll"));
      return capsuleNow() === "1" && pane.scrollTop <= 1;
    };
    if (!auto.retranslateClicked) {
      if (!pinPageOne()) return "";
      auto.retranslateAt = all.length;
      auto.retranslatePage = capsuleNow();
      auto.retranslateClicked = true;
      document.getElementById("retranslatePageItem").click();
    }
    let start = auto.retranslateAt || 0;
    const watched = String(auto.retranslatePage || capsuleNow());
    const state = document.querySelector('#readerFlow .rf-page[data-page="' + watched + '"]')?.dataset.state || "";
    if (state !== "running" && state !== "layout" && start >= all.length) {
      if (!pinPageOne()) return "";
      const button = document.getElementById("retranslatePageItem");
      if (button && !button.disabled && capsuleNow() === "1") {
        auto.retranslateAt = all.length;
        auto.retranslatePage = capsuleNow();
        start = all.length;
        button.click();
      }
    }
    const pageNow = String(auto.retranslatePage || watched);
    const mine = all.slice(start).filter((item) => String(item.page || "") === pageNow);
    if (mine.some((item) => item.bypassCache !== true)) {
      return JSON.stringify({ ok: false, reason: "bypass", target: pageNow, batches: mine });
    }
    const status = document.getElementById("status")?.textContent || "";
    const pageState = document.querySelector('#readerFlow .rf-page[data-page="' + pageNow + '"]')?.dataset.state || "";
    const finished = pageState === "done" || pageState === "partial" || pageState === "failed"
      || status.includes("本页译文已更新") || status.includes("本页重译失败");
    if (!finished) return "";
    const titlePage = pageNow === "1";
    const batches = mine.map((item) => ({
      bypassCache: item.bypassCache === true,
      page: String(item.page || ""),
      n: (item.texts || []).length,
      head: String((item.texts || [])[0] || "").slice(0, 48),
      title: (item.texts || []).some((text) => String(text).replace(/\\s+/g, " ").includes("Attention Is All You Need"))
    }));
    const title = batches.some((item) => item.title);
    return JSON.stringify({
      ok: mine.length >= 1 && (!titlePage || title),
      target: pageNow,
      titlePage,
      title,
      state: pageState,
      batches
    });
  })()`, "重译的标题批次和正文批次都带 bypassCache"));
  assert.equal(forced.target, "1", JSON.stringify(forced));
  assert.equal(forced.ok, true, JSON.stringify(forced));
  assert.ok(forced.batches.length >= 1, JSON.stringify(forced));
  assert.ok(forced.batches.every((item) => item.bypassCache === true), JSON.stringify(forced));
  if (forced.titlePage) assert.equal(forced.title, true, "标题页重译要发出标题批次 " + JSON.stringify(forced));

  const ready = JSON.parse(await waitFor(`(() => {
    const block = [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => (el.querySelector(".rf-zh")?.textContent || "").includes("译:"));
    const title = document.querySelector("#readerFlow h1 .rf-zh");
    const caption = document.querySelector('#readerFlow [data-label="caption"] .rf-zh');
    if (!block || !block.querySelector(".rf-src") || !title || !caption) return "";
    if (!(title.textContent || "").includes("译:")) return "";
    if (!(caption.textContent || "").includes("译:")) return "";
    return JSON.stringify({
      id: block.dataset.blockId || "",
      pair: block.dataset.pairId || "",
      zh: block.querySelector(".rf-zh").textContent.slice(0, 80),
      src: block.querySelector(".rf-src").textContent.slice(0, 80),
      title: title.textContent.slice(0, 80),
      caption: caption.textContent.slice(0, 80),
      titleSrc: document.querySelector("#readerFlow h1 .rf-src")?.textContent.slice(0, 80) || "",
      captionSrc: document.querySelector('#readerFlow [data-label="caption"] .rf-src')?.textContent.slice(0, 80) || "",
      batches: (window.__oiAuto && window.__oiAuto.batches || []).length,
      status: document.getElementById("status")?.textContent || ""
    });
  })()`, "原文: 段、标题和题注里同时有中文和原文"));
  assert.match(ready.zh, /译:/);
  assert.match(ready.title, /译:/);
  assert.match(ready.caption, /译:/);
  assert.equal(ready.src.includes("译:"), false);
  assert.equal(ready.titleSrc.includes("译:"), false);
  assert.equal(ready.captionSrc.includes("译:"), false);
  await evaluate(`document.querySelector('#viewSeg [data-view="src"]').click()`);
  const srcView = JSON.parse(await evaluate(`(() => {
    const block = document.querySelector("#readerFlow .rf-block[data-block-id=\\"${ready.id}\\"]")
      || [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => (el.querySelector(".rf-zh")?.textContent || "").includes("译:"));
    const zh = block.querySelector(".rf-zh");
    const src = block.querySelector(".rf-src");
    const button = document.querySelector('#viewSeg [data-view="src"]');
    const box = button.getBoundingClientRect();
    const visual = document.querySelector("#readerFlow .oi-pdf-display-math img, #readerFlow .oi-pdf-figure img, #readerFlow .oi-pdf-table img");
    const titleZh = document.querySelector("#readerFlow h1 .rf-zh");
    const titleSrc = document.querySelector("#readerFlow h1 .rf-src");
    const capZh = document.querySelector('#readerFlow [data-label="caption"] .rf-zh');
    const capSrc = document.querySelector('#readerFlow [data-label="caption"] .rf-src');
    return JSON.stringify({
      view: document.querySelector(".workspace")?.dataset.view || "",
      pressed: button.getAttribute("aria-checked"),
      zhDisplay: getComputedStyle(zh).display,
      srcDisplay: getComputedStyle(src).display,
      titleZhDisplay: titleZh ? getComputedStyle(titleZh).display : "",
      titleSrcDisplay: titleSrc ? getComputedStyle(titleSrc).display : "",
      capZhDisplay: capZh ? getComputedStyle(capZh).display : "",
      capSrcDisplay: capSrc ? getComputedStyle(capSrc).display : "",
      titleVisible: (document.querySelector("#readerFlow h1")?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      capVisible: (document.querySelector('#readerFlow [data-label="caption"]')?.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      visible: (block.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 180),
      srcText: (src.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 80),
      pair: block.dataset.pairId || "",
      height: box.height,
      visual: visual ? getComputedStyle(visual).display : "",
      batches: (window.__oiAuto && window.__oiAuto.batches || []).length,
      status: document.getElementById("status")?.textContent || ""
    });
  })()`));
  assert.equal(srcView.view, "src");
  assert.equal(srcView.pressed, "true");
  assert.equal(srcView.zhDisplay, "none");
  assert.notEqual(srcView.srcDisplay, "none");
  assert.equal(srcView.visible.includes("译:"), false);
  assert.equal(srcView.titleZhDisplay, "none");
  assert.notEqual(srcView.titleSrcDisplay, "none");
  assert.equal(srcView.capZhDisplay, "none");
  assert.notEqual(srcView.capSrcDisplay, "none");
  assert.equal(srcView.titleVisible.includes("译:"), false);
  assert.equal(srcView.capVisible.includes("译:"), false);
  assert.equal(srcView.visible.includes(srcView.srcText.slice(0, 24)), true);
  assert.equal(srcView.pair, ready.pair);
  assert.equal(srcView.height, 30);
  if (srcView.visual) assert.notEqual(srcView.visual, "none");
  assert.equal(srcView.status.includes("已停止"), ready.status.includes("已停止"));
  await evaluate(`document.querySelector('#viewSeg [data-view="zh"]').click()`);
  const zhView = JSON.parse(await evaluate(`(() => {
    const block = [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => (el.querySelector(".rf-zh")?.textContent || "").includes("译:"));
    const zh = block.querySelector(".rf-zh");
    const src = block.querySelector(".rf-src");
    return JSON.stringify({
      view: document.querySelector(".workspace")?.dataset.view || "",
      pressed: document.querySelector('#viewSeg [data-view="src"]').getAttribute("aria-checked"),
      zhDisplay: getComputedStyle(zh).display,
      srcDisplay: getComputedStyle(src).display,
      visible: (block.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 180)
    });
  })()`));
  assert.equal(zhView.view, "zh");
  assert.equal(zhView.pressed, "false");
  assert.notEqual(zhView.zhDisplay, "none");
  assert.equal(zhView.srcDisplay, "none");
  assert.match(zhView.visible, /译:/);

  await openMode("bothfail");
  const failed = JSON.parse(await waitFor(`(() => {
    const state = (n) => document.querySelector('#readerFlow .rf-page[data-page="' + n + '"]')?.dataset.state || "";
    const titleFailed = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.titleFailed || "";
    if (state(1) !== "failed" || state(2) !== "failed" || state(3) !== "failed") return "";
    if (titleFailed !== "1") return "";
    if (state(4) === "running" || state(4) === "done" || state(4) === "partial") return "";
    const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
    if (!doc.includes("已译 0")) return "";
    if (doc.includes("全文已译")) return "";
    if (document.getElementById("retranslatePage")?.disabled) return "";
    const status = document.getElementById("status")?.textContent || "";
    if (!status.includes("连续 3 页翻译失败，已暂停")) return "";
    const queue = document.querySelector("#readerFlow .rf-q-text")?.textContent || "";
    if (queue.includes("排队翻译")) return "";
    if (!queue.includes("已暂停")) return "";
    if (document.getElementById("translatePage")?.hidden !== false) return "";
    return JSON.stringify({
      page1: state(1),
      page2: state(2),
      page3: state(3),
      page4: state(4),
      titleFailed,
      doc,
      status: document.getElementById("status")?.textContent || "",
      queue: document.querySelector("#readerFlow .rf-q-text")?.textContent || "",
      translateHidden: document.getElementById("translatePage")?.hidden === true,
      retranslateDisabled: document.getElementById("retranslatePage")?.disabled === true
    });
  })()`, "bothfail: 无中文是失败，连续三页才停", 180000));
  assert.equal(failed.page1, "failed");
  assert.equal(failed.page2, "failed");
  assert.equal(failed.page3, "failed");
  assert.equal(failed.titleFailed, "1");
  assert.equal(failed.page4 === "queued" || failed.page4 === "", true);
  assert.match(failed.doc, /已译 0/);
  assert.doesNotMatch(failed.doc, /全文已译/);
  assert.equal(failed.retranslateDisabled, false);
  assert.match(failed.status, /连续 3 页翻译失败，已暂停/);
  assert.match(failed.status, /翻译/);
  assert.equal(failed.translateHidden, false);
  assert.doesNotMatch(failed.queue, /排队翻译/);
  assert.match(failed.queue, /已暂停/);
  const emptyState = JSON.parse(await evaluate(`(() => {
    const capsule = document.getElementById("pageCapsule");
    capsule.dataset.srcPage = "8";
    window.__oiNoteState(8, "failed");
    const failedOn = document.getElementById("retranslatePage")?.disabled === true;
    window.__oiNoteState(8, "partial");
    const partialOn = document.getElementById("retranslatePage")?.disabled === true;
    capsule.dataset.srcPage = "1";
    window.__oiNoteState(1, "failed");
    return JSON.stringify({ failedOn, partialOn });
  })()`));
  assert.equal(emptyState.failedOn, false, "failed page with no blocks can retranslate");
  assert.equal(emptyState.partialOn, false, "partial page with no blocks can retranslate");

  async function resumeFailed(mode) {
    await openMode(mode);
    const stalled = JSON.parse(await waitFor(`(() => {
      const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
      if (document.getElementById("translatePage")?.hidden !== false) return "";
      if (page1 !== "partial" && page1 !== "failed") return "";
      const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
      if (doc.includes("全文已译")) return "";
      const title = window.__oiTitleState ? window.__oiTitleState() : null;
      return JSON.stringify({
        page1,
        doc,
        status: document.getElementById("status")?.textContent || "",
        slotsDone: title ? title.slotsDone === true : null,
        titleFailed: title ? title.failed === true : null,
        count: (window.__oiAuto && window.__oiAuto.messages || []).length
      });
    })()`, mode + ": 失败批次留下未完成的第 1 页", 180000));
    const before = stalled.count;
    await evaluate(`document.getElementById("translatePage").click()`);
    const resumed = JSON.parse(await waitFor(`(() => {
      const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
      const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
      if (page1 !== "done" || !doc.includes("全文已译")) return "";
      const title = window.__oiTitleState ? window.__oiTitleState() : null;
      return JSON.stringify({
        page1,
        doc,
        slotsDone: title ? title.slotsDone === true : null,
        messages: window.__oiAuto.messages
      });
    })()`, mode + ": 点翻译后全文已译", 180000));
    return { stalled, resumed, before };
  }

  const titleRetry = await resumeFailed("retryTitle");
  assert.equal(titleRetry.stalled.slotsDone, false);
  assert.equal(titleRetry.stalled.titleFailed, true);
  assert.doesNotMatch(titleRetry.stalled.status, /模型和密钥/);
  assert.match(titleRetry.stalled.status, /点「翻译」/);
  assert.equal(titleRetry.resumed.page1, "done");
  assert.match(titleRetry.resumed.doc, /全文已译/);
  assert.equal(titleRetry.resumed.slotsDone, true);
  const titleAgain = titleRetry.resumed.messages.slice(titleRetry.before);
  const titleFirst = titleRetry.resumed.messages[0];
  assert.ok(titleAgain.some((item) => item.bypassCache === true && JSON.stringify(item.texts) === JSON.stringify(titleFirst.texts)), "失败的标题批要带 bypassCache 重发");

  const bodyRetry = await resumeFailed("retryBody");
  assert.equal(bodyRetry.stalled.slotsDone, true);
  assert.equal(bodyRetry.resumed.slotsDone, true);
  assert.equal(bodyRetry.resumed.page1, "done");
  assert.match(bodyRetry.resumed.doc, /全文已译/);
  const bodyAgain = bodyRetry.resumed.messages.slice(bodyRetry.before);
  const bodyFirst = bodyRetry.resumed.messages[1];
  assert.ok(bodyAgain.some((item) => item.bypassCache === true && JSON.stringify(item.texts) === JSON.stringify(bodyFirst.texts)), "失败的正文批要带 bypassCache 重发");

  const bothRetry = await resumeFailed("retryBoth");
  assert.equal(bothRetry.stalled.slotsDone, false);
  assert.equal(bothRetry.resumed.page1, "done");
  assert.match(bothRetry.resumed.doc, /全文已译/);
  assert.equal(bothRetry.resumed.slotsDone, true);
  const bothAgain = bothRetry.resumed.messages.slice(bothRetry.before);
  const bothHead = bothRetry.resumed.messages.slice(0, 2);
  for (const failedBatch of bothHead) {
    assert.ok(bothAgain.some((item) => item.bypassCache === true && JSON.stringify(item.texts) === JSON.stringify(failedBatch.texts)), "两批失败都要重发");
  }

  async function fullLibraryHit(lang) {
    await openMode("cacheAll", lang ? { lang } : {});
    return JSON.parse(await waitFor(`(() => {
      const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
      const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
      const gap = (window.__oiLibraryGap || []).find((item) => item.page === 1 && item.pairs < item.live);
      if (doc.includes("全文已译") && !gap) return "";
      if (page1 !== "done" || !doc.includes("全文已译")) return "";
      const batches = (window.__oiAuto && window.__oiAuto.batches || []).length;
      const pages = [...document.querySelectorAll("#readerFlow .rf-page")].map((slot) => slot.dataset.state || "");
      const abstract = [...document.querySelectorAll('#readerFlow .rf-page[data-page="1"] .rf-zh')].map((el) => el.textContent || "").join("\\n");
      return JSON.stringify({ doc, batches, page1, pages, gap: gap || null, abstract: abstract.slice(0, 180) });
    })()`, "cacheAll " + (lang || "zh") + ": 库对少于活块须进队", 180000));
  }
  const hitZh = await fullLibraryHit("");
  assert.ok(hitZh.gap && hitZh.gap.pairs < hitZh.gap.live, "库对 < 活块须进队");
  assert.ok(hitZh.batches > 0);
  assert.equal(hitZh.page1, "done");
  assert.match(hitZh.doc, /全文已译/);
  assert.match(hitZh.abstract, /译:/);
  const hitEn = await fullLibraryHit("en");
  assert.ok(hitEn.gap && hitEn.gap.pairs < hitEn.gap.live, "en 库对 < 活块须进队");
  assert.ok(hitEn.batches > 0);
  assert.equal(hitEn.page1, "done");
  assert.match(hitEn.abstract, /Rendered English translation/);
  const hitJa = await fullLibraryHit("ja");
  assert.ok(hitJa.gap && hitJa.gap.pairs < hitJa.gap.live, "ja 库对 < 活块须进队");
  assert.ok(hitJa.batches > 0);
  assert.equal(hitJa.page1, "done");
  assert.match(hitJa.abstract, /ちゅういりょくのやく/);

  async function replayWrittenLibrary(lang, mark) {
    await openMode("replay", lang ? { lang } : {});
    return JSON.parse(await waitFor(`(() => {
      const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
      const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
      const rows = [...document.querySelectorAll('#readerFlow .rf-page[data-page="1"] .rf-block')];
      const abstract = rows.find((el) => (el.querySelector(".rf-src")?.textContent || "").includes("dominant sequence"));
      const zh = abstract?.querySelector(".rf-zh")?.textContent || "";
      if (doc.includes("全文已译") && abstract && !zh.includes(${JSON.stringify(mark)})) return "";
      if (page1 !== "done" || !doc.includes("全文已译") || !zh.includes(${JSON.stringify(mark)})) return "";
      return JSON.stringify({
        page1,
        doc,
        zh: zh.slice(0, 120),
        batches: (window.__oiAuto && window.__oiAuto.batches || []).length
      });
    })()`, "replay " + (lang || "zh") + ": 本版写入的库重开后摘要有译文", 180000));
  }
  const replayZh = await replayWrittenLibrary("", "译:");
  assert.equal(replayZh.page1, "done");
  assert.match(replayZh.doc, /全文已译/);
  assert.match(replayZh.zh, /译:/);

  await openMode("echo");
  const echoed = JSON.parse(await waitFor(`(async () => {
    ${storedLibraryPagesSource()}
    const docEl = document.querySelector("#docStatus");
    const doc = docEl?.querySelector(".doc-text")?.textContent || "";
    const pages = [...document.querySelectorAll("#readerFlow .rf-page")];
    if (docEl?.dataset.state !== "done" || !pages.length) return "";
    if (pages.some((el) => !["done", "skipped", "empty"].includes(el.dataset.state || ""))) return "";
    const saved = await oiStoredLibraryPages();
    const blocks = window.__oiLiveBlocks ? window.__oiLiveBlocks(1) : [];
    const zh = [...document.querySelectorAll('#readerFlow .rf-page[data-page="1"] .rf-zh')].map((el) => el.textContent || "").join("\\n");
    if (!zh.includes("dominant sequence")) return "";
    return JSON.stringify({
      doc,
      saved: saved.map((item) => item.page),
      blocks,
      zh: zh.slice(0, 160)
    });
  })()`, "echo: 回声算译完并写入，第二次不必再译", 180000));
  assert.ok(echoed.saved.includes(1), JSON.stringify(echoed.saved));
  assert.match(echoed.zh, /dominant sequence/);
  assert.ok(echoed.blocks.length > 1);
  await evaluate(`(() => {
    const blocks = window.__oiLiveBlocks(1);
    const pages = [1, 2, 3].map((page) => ({
      page,
      pairs: (page === 1 ? blocks : [{ text: "Stored sentence for page " + page + " that is long enough to be a real paragraph.", sourceId: "p" + page }]).map((block) => ({
        text: block.text,
        sourceId: block.sourceId || "",
        translation: block.text
      }))
    }));
    sessionStorage.setItem("oiPolluted", JSON.stringify(pages));
    return true;
  })()`);
  await openMode("polluted");
  const washed = JSON.parse(await waitFor(`(() => {
    const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    const docEl = document.querySelector("#docStatus");
    const doc = docEl?.querySelector(".doc-text")?.textContent || "";
    const rows = [...document.querySelectorAll('#readerFlow .rf-page[data-page="1"] .rf-block')];
    const abstract = rows.find((el) => (el.querySelector(".rf-src")?.textContent || "").includes("dominant sequence"));
    const zh = abstract?.querySelector(".rf-zh")?.textContent || "";
    if (docEl?.dataset.state === "done" && (!abstract || !zh.includes("dominant sequence") || zh.includes("译:"))) return "";
    if (docEl?.dataset.state !== "done" || !abstract || !zh.includes("dominant sequence") || zh.includes("译:") || page1 !== "done") return "";
    const timeline = (window.__oiAuto && window.__oiAuto.timeline) || [];
    const progressive = timeline.some((row) => {
      const pages = row.pages || [];
      const head = pages.find((item) => item.page === 1 && item.state === "done" && /译:|[\\u4e00-\\u9fff]/.test(item.zh || ""));
      const later = pages.some((item) => item.page > 1 && item.state !== "done" && item.state !== "skipped" && item.state !== "empty");
      return Boolean(head && later);
    });
    const echoed = timeline.some((row) => (row.pages || []).some((item) => (item.state === "queued" || item.state === "running") && item.echo));
    const falseHold = timeline.some((row) => String(row.status || "").includes("不会自动重新翻译"));
    const counts = [];
    for (const row of timeline) {
      const matched = String(row.doc || "").match(/已译\\s+(\\d+)/);
      if (matched) counts.push(Number(matched[1]));
      else if (String(row.doc || "").includes("全文已译")) counts.push(15);
    }
    const grew = counts.some((count, index) => index > 0 && count > counts[index - 1]);
    const bypass = ((window.__oiAuto && window.__oiAuto.messages) || []).some((item) => item.bypassCache === true);
    return JSON.stringify({
      page1,
      doc,
      zh: zh.slice(0, 80),
      batches: (window.__oiAuto && window.__oiAuto.batches || []).length,
      progressive,
      echoed,
      falseHold,
      grew,
      bypass,
      counts: counts.slice(0, 24)
    });
  })()`, "polluted: 回声库直接沿用，不再整页重试", 180000));
  assert.equal(washed.page1, "done");
  assert.match(washed.zh, /dominant sequence/);
  assert.equal(washed.zh.includes("译:"), false);
  assert.equal(washed.echoed, false, "排队或翻译中的页不能把英文原文画进译文");
  assert.equal(washed.falseHold, false);
  assert.equal(washed.bypass, false, "补译不走重译本页的 bypass");

  await openMode("en");
  const english = JSON.parse(await waitFor(`(() => {
    const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    const zh = document.querySelector('#readerFlow .rf-page[data-page="1"] .rf-zh')?.textContent || "";
    if (page1 !== "done" || !zh.includes("Rendered English translation")) return "";
    return JSON.stringify({ page1, zh: zh.slice(0, 80) });
  })()`, "en: 英文译文能让第 1 页 done", 120000));
  assert.equal(english.page1, "done");
  assert.match(english.zh, /Rendered English translation/);
  await waitFor(`(async () => {
    ${storedLibraryPagesSource()}
    const pages = await oiStoredLibraryPages();
    const page1 = pages.find((item) => Number(item.page) === 1);
    return JSON.stringify(page1 || {}).includes("Rendered English translation") ? "saved" : "";
  })()`, "en: 第 1 页已写入库");
  await evaluate(`(async () => {
    ${storedLibraryPagesSource()}
    sessionStorage.setItem("oiRecorded", JSON.stringify(await oiStoredLibraryPages()));
    return true;
  })()`);
  const replayEn = await replayWrittenLibrary("en", "Rendered English translation");
  assert.equal(replayEn.page1, "done");
  assert.match(replayEn.zh, /Rendered English translation/);

  await openMode("ja");
  const kana = JSON.parse(await waitFor(`(() => {
    const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    const zh = document.querySelector('#readerFlow .rf-page[data-page="1"] .rf-zh')?.textContent || "";
    if (page1 !== "done" || !zh.includes("ちゅういりょくのやく")) return "";
    return JSON.stringify({ page1, zh: zh.slice(0, 80) });
  })()`, "ja: 假名译文能让第 1 页 done", 120000));
  assert.equal(kana.page1, "done");
  assert.match(kana.zh, /ちゅういりょくのやく/);
  await waitFor(`(async () => {
    ${storedLibraryPagesSource()}
    const pages = await oiStoredLibraryPages();
    const page1 = pages.find((item) => Number(item.page) === 1);
    return JSON.stringify(page1 || {}).includes("ちゅういりょくのやく") ? "saved" : "";
  })()`, "ja: 第 1 页已写入库");
  await evaluate(`(async () => {
    ${storedLibraryPagesSource()}
    sessionStorage.setItem("oiRecorded", JSON.stringify(await oiStoredLibraryPages()));
    return true;
  })()`);
  const replayJa = await replayWrittenLibrary("ja", "ちゅういりょくのやく");
  assert.equal(replayJa.page1, "done");
  assert.match(replayJa.zh, /ちゅういりょくのやく/);

  await openMode("fast");
  await waitFor(`document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state === "done" ? "done" : ""`, "切换目标前第 1 页已是中文 done");
  const switched = JSON.parse(await evaluate(`(() => {
    window.__oiSetTarget("en");
    return JSON.stringify({
      page1: document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || ""
    });
  })()`));
  assert.notEqual(switched.page1, "done", "目标改成英文后，汉字译文不再算落地");

  await openMode("struct");
  await waitFor(`(() => {
    const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
    if (!doc.includes("全文已译")) return "";
    if (document.getElementById("retranslatePage")?.disabled) return "";
    return "done";
  })()`, "struct: 结构批先译完", 180000);
  await evaluate(`(() => {
    window.__oiAuto.retranslateAt = (window.__oiAuto.messages || []).length;
    document.getElementById("retranslatePageItem").click();
    return true;
  })()`);
  const structAgain = JSON.parse(await waitFor(`(() => {
    const all = (window.__oiAuto && window.__oiAuto.messages) || [];
    const start = window.__oiAuto.retranslateAt || 0;
    const state = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    if (state !== "running" && state !== "layout" && start >= all.length) {
      const button = document.getElementById("retranslatePageItem");
      if (button && !button.disabled) {
        window.__oiAuto.retranslateAt = all.length;
        button.click();
        return "";
      }
    }
    const title = all.slice(window.__oiAuto.retranslateAt || 0).find((item) => String(item.texts?.[0] || "").includes("Attention Is All You Need"));
    if (!title || title.bypassCache !== true) return "";
    return JSON.stringify({ bypassCache: title.bypassCache, head: String(title.texts[0] || "").slice(0, 80) });
  })()`, "struct: 重译标题批必须带 bypassCache", 180000));
  assert.equal(structAgain.bypassCache, true);
  assert.match(structAgain.head, /Attention Is All You Need/);

  await openMode("openRace");
  const raced = JSON.parse(await waitFor(`(() => {
    if (!window.__oiAuto || window.__oiAuto.clickedDuringOpen !== true) return "";
    const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
    const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    if (!doc.includes("全文已译")) return "";
    if (page1 === "running" || page1 === "layout") return "";
    return JSON.stringify({
      doc,
      page1,
      batches: window.__oiAuto.batches.length,
      clicked: window.__oiAuto.clickedDuringOpen
    });
  })()`, "打开时重译结束后仍自动全文", 180000));
  assert.equal(raced.clicked, true);
  assert.match(raced.doc, /全文已译/);
  assert.notEqual(raced.page1, "running");
  assert.ok(raced.batches >= 2);
});

function pdfEscape(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function pdfLineStream(lines, size) {
  const body = lines.map((line, index) => `${index === 0 ? "" : "0 -18 Td\n"}(${pdfEscape(line)}) Tj`).join("\n");
  return `BT /F1 ${size} Tf 72 700 Td\n${body}\nET`;
}

/** Two pages: a title candidate with two body sentences, then a skip-only bibliography. */
function titleRetryOpenPdf() {
  const kept = "The dominant sequence models use attention instead of recurrence.";
  const failed = "A second sentence stays failed until the retry.";
  const pages = [
    `BT /F1 12 Tf 72 700 Td\n(${pdfEscape(kept)}) Tj\n0 -80 Td\n(${pdfEscape(failed)}) Tj\nET`,
    pdfLineStream([
      "[1] Vaswani Ashish. Attention is all you need. Advances in Neural Information Processing Systems. 2017.",
      "[2] Devlin Jacob. Bert pretraining of deep bidirectional transformers for language understanding. 2019.",
      "[3] Brown Tom. Language models are few shot learners with a very large transformer. 2020.",
      "[4] Kaplan Jared. Scaling laws for neural language models across compute and data. 2020."
    ], 11)
  ];
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let id = 4;
  const kids = [];
  for (const stream of pages) {
    const pageId = id;
    id += 1;
    const contentId = id;
    id += 1;
    kids.push(`${pageId} 0 R`);
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    objects.set(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`);
  }
  objects.set(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages.length} >>`);
  const maxId = id - 1;
  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  let cursor = Buffer.byteLength(chunks[0]);
  for (let n = 1; n <= maxId; n += 1) {
    offsets.push(cursor);
    const piece = `${n} 0 obj\n${objects.get(n)}\nendobj\n`;
    chunks.push(piece);
    cursor += Buffer.byteLength(piece);
  }
  let xref = `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= maxId; n += 1) xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  chunks.push(xref);
  chunks.push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function probeTitleRetryPdf(pdfPath) {
  const { getDocument, GlobalWorkerOptions } = await import("../pdf/vendor/pdf.min.mjs");
  const { textLayerToBlocks } = await import("../lib/pdf-text-layer.js");
  const { isSkipOnlyPage } = await import("../lib/pdf-library.js");
  const { isTitlePageCandidate, pageTextForStructure } = await import("../lib/pdf-structure-schema.js");
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const probed = await getDocument({ data: new Uint8Array(readFileSync(pdfPath)), verbosity: 0 }).promise;
  try {
    assert.equal(probed.numPages, 2);
    for (const [pageNo, expectSkip] of [[1, false], [2, true]]) {
      const page = await probed.getPage(pageNo);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const built = textLayerToBlocks({ items: content.items, viewport, page: pageNo });
      const blocks = built.blocks || [];
      assert.equal(isSkipOnlyPage(blocks), expectSkip, `page ${pageNo} skip-only`);
      if (pageNo === 1) assert.equal(isTitlePageCandidate(1, pageTextForStructure(blocks)), true);
    }
  } finally {
    await probed.destroy();
  }
}

async function runOpenRecordRetry(t, { mode, ready, label, requireSavedBody = false, beforeClick, afterClick }) {
  const pdfDir = mkdtempSync(join(tmpdir(), "oi-auto-translate-"));
  rememberOwnedTemp(pdfDir);
  const pdfPath = join(pdfDir, "title-retry-open.pdf");
  writeFileSync(pdfPath, titleRetryOpenPdf());
  await probeTitleRetryPdf(pdfPath);
  const pdfBytes = readFileSync(pdfPath);
  const server = await serveRepo(new Map([["title-retry-open.pdf", pdfBytes]]));
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-auto-translate-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const handle = { child: null, cdp: null };
  t.after(async () => {
    rmSync(pdfDir, { recursive: true, force: true });
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({
        t,
        child: handle.child,
        server,
        ownedDir,
        userDataDir
      });
    }
  });

  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const src = `${origin}/title-retry-open.pdf`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
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
  const waitFor = async (expression, step, timeoutMs = 90000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(200);
    }
    const status = await evaluate(`document.getElementById("status")?.textContent || ""`).catch(() => "");
    throw new Error(`${step} timed out. status=${status} last=${JSON.stringify(last)}`);
  };

  await cdp.send("Page.navigate", {
    url: `${origin}/pdf/viewer.html?oiAuto=${mode}&src=${encodeURIComponent(src)}`
  }, sessionId);
  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    return /\\/\\s*2/.test(pager) ? pager : "";
  })()`, `${label}: PDF open`, 20000);

  const stalled = JSON.parse(await waitFor(`(async () => {
    const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
    const title = window.__oiTitleState ? window.__oiTitleState() : null;
    if (!title) return "";
    if (!(${ready})) return "";
    if (page1 !== "partial" && page1 !== "failed") return "";
    if (document.getElementById("translatePage")?.hidden !== false) return "";
    if (doc.includes("全文已译")) return "";
    const { sharedLibraryStore } = await import("/lib/library-session.js");
    const store = sharedLibraryStore();
    const papers = await store.listPapers();
    const paper = papers && papers[0];
    if (!paper || !paper.docHash || !(Number(paper.lastOpenedAt) > 0)) return "";
    const pages = await store.getPages(paper.docHash);
    const skipped = (pages || []).some((row) => row.skipped === true);
    if (!skipped) return "";
    if (${requireSavedBody ? "true" : "false"}) {
      const pageOne = (pages || []).find((row) => Number(row.page) === 1);
      const pairs = pageOne && pageOne.pairs || [];
      const kept = pairs.some((pair) => String(pair.translation || "").trim() && !String(pair.text || "").includes("second sentence"));
      const leaked = pairs.some((pair) => String(pair.text || "").includes("second sentence"));
      if (!kept || leaked) return "";
    }
    const messages = (window.__oiAuto && window.__oiAuto.messages) || [];
    return JSON.stringify({
      page1,
      doc,
      slotsDone: title.slotsDone === true,
      titleFailed: title.failed === true,
      papers: papers.length,
      storedTitle: paper.title || "",
      pageRows: (pages || []).length,
      count: messages.length,
      messages
    });
  })()`, `${label}: 文献已有跳过页，失败批仍停着`, 120000));

  const before = stalled.count;
  if (typeof beforeClick === "function") await beforeClick(evaluate, stalled);
  await evaluate(`document.getElementById("translatePage").click()`);
  if (typeof afterClick === "function") return afterClick(evaluate, { stalled, before });
  const resumed = JSON.parse(await waitFor(`(() => {
    const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
    const doc = document.querySelector("#docStatus .doc-text")?.textContent || "";
    const phase = document.querySelector("#docStatus")?.dataset.state || "";
    const running = phase === "running" || phase === "opening" || page1 === "running" || page1 === "layout";
    if (running) return "";
    const title = window.__oiTitleState ? window.__oiTitleState() : null;
    if (!title) return "";
    const messages = (window.__oiAuto && window.__oiAuto.messages) || [];
    const settled = page1 === "done" || page1 === "partial" || page1 === "failed";
    if (!settled) return "";
    if (messages.length === ${before} && !doc.includes("全文已译") && title.slotsDone !== true) return "";
    return JSON.stringify({
      page1,
      doc,
      slotsDone: title.slotsDone === true,
      messages
    });
  })()`, `${label}: 点翻译后失败批重发`, 120000));
  return { stalled, resumed, before };
}

test("打开即写入文献后，失败的标题批仍带 bypassCache 重试", { timeout: 180000 }, async (t) => {
  const { stalled, resumed, before } = await runOpenRecordRetry(t, {
    mode: "retryOpen",
    ready: "title.failed === true && title.slotsDone !== true",
    label: "retryOpen"
  });
  assert.equal(stalled.slotsDone, false);
  assert.equal(stalled.titleFailed, true);
  assert.ok(stalled.papers >= 1);
  assert.ok(stalled.pageRows >= 1);
  const first = stalled.messages[0];
  assert.ok(first && first.bypassCache !== true, JSON.stringify(first));
  assert.ok(Array.isArray(first.texts) && first.texts.includes("Synthesized Title For Retry"), JSON.stringify(first));
  assert.equal(resumed.slotsDone, true, JSON.stringify({ page1: resumed.page1, doc: resumed.doc, slotsDone: resumed.slotsDone }));
  assert.equal(resumed.page1, "done");
  assert.match(resumed.doc, /全文已译/);
  const again = resumed.messages.slice(before);
  assert.ok(again.some((item) => item.bypassCache === true && JSON.stringify(item.texts) === JSON.stringify(first.texts)), "失败的标题批要带 bypassCache 重发");
});

test("打开即写入文献后，失败的正文批仍带 bypassCache 重试", { timeout: 180000 }, async (t) => {
  const { stalled, resumed, before } = await runOpenRecordRetry(t, {
    mode: "retryOpenBody",
    ready: "title.failed !== true && title.slotsDone === true && (window.__oiAuto.messages || []).some((item) => (item.texts || []).some((text) => String(text).includes('second sentence')))",
    label: "retryOpenBody",
    requireSavedBody: true
  });
  assert.equal(stalled.slotsDone, true);
  assert.equal(stalled.titleFailed, false);
  assert.ok(stalled.papers >= 1);
  assert.ok(stalled.pageRows >= 2);
  const failedBody = stalled.messages.find((item) => (item.texts || []).some((text) => String(text).includes("second sentence")));
  assert.ok(failedBody && failedBody.bypassCache !== true, JSON.stringify(stalled.messages));
  assert.equal(resumed.slotsDone, true, JSON.stringify({ page1: resumed.page1, doc: resumed.doc, slotsDone: resumed.slotsDone }));
  assert.equal(resumed.page1, "done");
  assert.match(resumed.doc, /全文已译/);
  const again = resumed.messages.slice(before);
  assert.ok(again.some((item) => item.bypassCache === true && JSON.stringify(item.texts) === JSON.stringify(failedBody.texts)), "失败的正文批要带 bypassCache 重发");
});

test("标题失败但正文缓存没有失败行时，点翻译仍带 bypassCache 重发标题", { timeout: 180000 }, async (t) => {
  const { stalled, resumed, before } = await runOpenRecordRetry(t, {
    mode: "retryOpen",
    ready: "title.failed === true && title.slotsDone !== true",
    label: "retryOpen-title-only",
    beforeClick: (evaluate) => evaluate(`window.__oiSetPageCache(1, [{
      role: "paragraph",
      original: "Hello world from the paper body.",
      text: "Hello world from the paper body.",
      translation: "这是已经译好的正文。",
      failed: false
    }])`)
  });
  assert.equal(stalled.titleFailed, true);
  const again = resumed.messages.slice(before);
  assert.ok(again.some((item) => item.bypassCache === true && (item.texts || []).includes("Synthesized Title For Retry")), JSON.stringify(again));
  assert.equal(resumed.slotsDone, true);
});

test("采纳会把页标成完成时，失败正文仍带 bypassCache 重发", { timeout: 180000 }, async (t) => {
  const { stalled, resumed, before } = await runOpenRecordRetry(t, {
    mode: "retryOpenBody",
    ready: "title.failed !== true && title.slotsDone === true && (window.__oiAuto.messages || []).some((item) => (item.texts || []).some((text) => String(text).includes('second sentence')))",
    label: "retryOpenBody-hold",
    requireSavedBody: true,
    beforeClick: async (evaluate) => {
      const attached = await evaluate(`(() => {
        const failed = "A second sentence stays failed until the retry.";
        const kept = "The dominant sequence models use attention instead of recurrence.";
        window.__oiSetPageCache(1, [
          { role: "paragraph", original: kept, text: kept, translation: "主导模型用注意力。", failed: false },
          { role: "paragraph", original: "This failed row stays unsettled.", text: "This failed row stays unsettled.", translation: "", failed: true }
        ]);
        return window.__oiSetLibraryPairs(1, [
          { text: kept, translation: "主导模型用注意力。", targetLang: "zh-CN" },
          { text: failed, translation: "第二句已经在库里译好了。", targetLang: "zh-CN" }
        ]);
      })()`);
      if (attached !== true) throw new Error("文献页不存在，失败行对不上库里的译文");
    }
  });
  const failedBody = stalled.messages.find((item) => (item.texts || []).some((text) => String(text).includes("second sentence")));
  const again = resumed.messages.slice(before);
  assert.ok(again.some((item) => item.bypassCache === true && JSON.stringify(item.texts) === JSON.stringify(failedBody.texts)), JSON.stringify(again));
});

test("文献里已经有同一语言的译文时，失败行不再重发", { timeout: 180000 }, async (t) => {
  const { resumed, before } = await runOpenRecordRetry(t, {
    mode: "retryOpenBody",
    ready: "title.failed !== true && title.slotsDone === true && (window.__oiAuto.messages || []).some((item) => (item.texts || []).some((text) => String(text).includes('second sentence')))",
    label: "retryOpenBody-reuse",
    requireSavedBody: true,
    beforeClick: async (evaluate) => {
      const attached = await evaluate(`(() => {
        const original = "A second sentence stays failed until the retry.";
        window.__oiSetPageCache(1, [{ role: "paragraph", original, text: original, translation: "", failed: true }]);
        return window.__oiSetLibraryPairs(1, [{ text: original, translation: "第二句已经在库里译好了。", targetLang: "zh-CN" }]);
      })()`);
      if (attached !== true) throw new Error("文献页不存在，失败行对不上库里的译文");
    }
  });
  const again = resumed.messages.slice(before);
  assert.equal(again.some((item) => (item.texts || []).some((text) => String(text).includes("second sentence"))), false, JSON.stringify(again));
  assert.equal(resumed.page1, "done");
  assert.match(resumed.doc, /全文已译|第二句已经在库里译好了/);
});

test("采纳失败页时，停在采纳之后也不会把状态画成完成", { timeout: 180000 }, async (t) => {
  const seen = await runOpenRecordRetry(t, {
    mode: "retryOpenBody",
    ready: "title.failed !== true && title.slotsDone === true && (window.__oiAuto.messages || []).some((item) => (item.texts || []).some((text) => String(text).includes('second sentence')))",
    label: "retryOpenBody-hold-stop",
    requireSavedBody: true,
    beforeClick: async (evaluate) => {
      const attached = await evaluate(`(() => {
        window.__oiWatchPageState = true;
        window.__oiPageStateLog = [];
        window.__oiStopAfterAdopt = true;
        const failed = "A second sentence stays failed until the retry.";
        const kept = "The dominant sequence models use attention instead of recurrence.";
        // The failed row is not the live sentence, so library reuse does not clear it.
        // The pairs still cover both live sentences and would paint the page done.
        window.__oiSetPageCache(1, [
          { role: "paragraph", original: kept, text: kept, translation: "主导模型用注意力。", failed: false },
          { role: "paragraph", original: "This failed row stays unsettled.", text: "This failed row stays unsettled.", translation: "", failed: true }
        ]);
        return window.__oiSetLibraryPairs(1, [
          { text: kept, translation: "主导模型用注意力。", targetLang: "zh-CN" },
          { text: failed, translation: "第二句已经在库里译好了。", targetLang: "zh-CN" }
        ]);
      })()`);
      if (attached !== true) throw new Error("文献页不存在，停不住采纳");
    },
    afterClick: async (evaluate) => {
      const started = Date.now();
      let last = null;
      while (Date.now() - started < 20000) {
        last = await evaluate(`(() => {
          const log = window.__oiPageStateLog || [];
          const page1 = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
          if (!log.length) return "";
          return JSON.stringify({ log, page1 });
        })()`);
        if (last) break;
        await sleep(200);
      }
      if (!last) throw new Error("采纳后没有记下页状态");
      return JSON.parse(last);
    }
  });
  const states = (seen.log || []).map((item) => item.state);
  assert.ok(states.some((state) => state === "failed" || state === "partial"), JSON.stringify(seen));
  assert.equal(states.includes("done"), false, JSON.stringify(seen));
  assert.notEqual(seen.page1, "done");
});
