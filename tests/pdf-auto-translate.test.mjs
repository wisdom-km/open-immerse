// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// arXiv v7 (15 pages), https://arxiv.org/pdf/1706.03762v7
// sha256 bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
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
  const mode = new URLSearchParams(location.search).get("oiAuto") || "";
  if (!mode || mode === "runtime") return;
  const settings = {
    provider: mode === "missing" ? "openai" : "mymemory",
    providers: {
      mymemory: { email: "" },
      openai: { apiKey: "" }
    },
    pdfAutoTranslate: mode !== "off",
    pdfLayout: mode === "local"
      ? { mode: "local-ocr", localBaseUrl: "http://127.0.0.1:8765" }
      : { mode: "" },
    batchSize: 8
  };
  window.__oiAuto = { mode, batches: [] };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("/v1/library/")) {
      if (mode === "cache") {
        return new Response(JSON.stringify({
          pageCount: 15,
          pages: [{
            page: 1,
            pairs: [{
              sourceId: "cached-sentence",
              text: "Cached sentence that is not on the page.",
              translation: "这是库里已经存好的一句译文。"
            }]
          }]
        }), { status: 200, headers: { "content-type": "application/json" } });
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
      getURL() {
        return new URL("./vendor/pdf.worker.min.mjs", location.href).href;
      },
      sendMessage(message) {
        const type = message && message.type;
        if (type === "OI_GET_SETTINGS") return Promise.resolve({ settings });
        if (type === "OI_PDF_STRUCTURE") return Promise.resolve({ ok: false });
        if (type === "OI_TRANSLATE_BATCH") {
          window.__oiAuto.batches.push((message.texts || []).length);
          if (mode === "hang") return new Promise(() => {});
          return Promise.resolve({
            ok: true,
            translations: (message.texts || []).map((text) => "译:" + text)
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
})();`;

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
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
  segment: document.querySelector(".scope-seg") ? "yes" : "",
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
  restore: (document.getElementById("restoreOriginal")?.textContent || "").trim(),
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

  const openMode = async (mode) => {
    const viewer = `${origin}/pdf/viewer.html?oiAuto=${mode}&src=${encodeURIComponent(src)}`;
    await cdp.send("Page.navigate", { url: viewer }, sessionId);
    if (mode === "runtime") {
      await waitFor(`(() => {
        const text = document.querySelector("#docStatus .doc-text")?.textContent || "";
        const state = document.querySelector('#readerFlow .rf-page[data-page="1"]')?.dataset.state || "";
        const ready = text.includes("正在读取 PDF") || text.includes("已译 0 /");
        return ready && (state === "layout" || state === "running") ? state : "";
      })()`, "LD-01 顶栏与第 1 页", 2000);
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
      const pager = document.getElementById("pager")?.textContent || "";
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
  assert.equal(runtime.segment, "");
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

  await openMode("off");
  const off = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (data.pages !== 15 || data.pairs < 1 || data.ranges < 1 || data.batches !== 0 || data.folds !== 0) return "";
    return row;
  })()`, "off: 页面已打开且没有自动开译"));
  await sleep(600);
  const offSettled = await read();
  assert.equal(offSettled.segment, "");
  assert.equal(offSettled.batches, 0);
  assert.equal(offSettled.folds, 0);
  assert.ok(offSettled.ranges >= 1);
  assert.equal(offSettled.flowHasUntranslated, false);
  assert.equal(offSettled.status.includes("无法翻译"), false);
  assert.equal(off.batches, 0);
  await sleep(600);
  const stayed = await read();
  assert.equal(stayed.segment, "");
  assert.equal(stayed.batches, 0);
  assert.equal(stayed.progress, "");

  await openMode("missing");
  const missing = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (!data.status.includes("API Key") || !data.status.includes("设置")) return "";
    return row;
  })()`, "missing: 状态栏说明要填写密钥"));
  assert.equal(missing.batches, 0);
  assert.equal(missing.segment, "");
  assert.match(missing.status, /引擎/);
  assert.equal(missing.label, "翻译");

  await openMode("local");
  const local = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (!data.status.includes("本机服务没启动")) return "";
    return row;
  })()`, "local: 状态栏说明本机服务没启动"));
  assert.equal(local.batches, 0);
  assert.equal(local.segment, "");
  assert.match(local.status, /127\.0\.0\.1:8765/);
  assert.equal(local.label, "翻译");

  await openMode("cache");
  const cached = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (!data.status.includes("已沿用")) return "";
    return row;
  })()`, "cache: 沿用本地库"));
  await sleep(800);
  const cacheSettled = await read();
  assert.equal(cached.batches, 0);
  assert.equal(cacheSettled.batches, 0);
  assert.equal(cacheSettled.segment, "");
  assert.equal(cacheSettled.page1, "done");
  assert.match(cacheSettled.status, /已沿用/);
  assert.doesNotMatch(cacheSettled.doc, /全文已译/);

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
  assert.equal(hang.segment, "");
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

  for (let i = 0; i < 3; i += 1) {
    await evaluate(`document.getElementById("restoreOriginal").click()`);
  }
  const toggled = await read();
  assert.equal(toggled.view, "src");
  assert.equal(toggled.hidden, true, "原文切换不中止翻译");
  assert.ok(toggled.batches >= hang.batches);
  assert.equal(toggled.page1, "running");
  assert.doesNotMatch(toggled.status, /已停止/);

  const queuedBefore = await evaluate(`document.querySelector('#readerFlow .rf-page[data-page="2"]')?.dataset.state || ""`);
  await evaluate(`document.getElementById("stopTranslate").click()`);
  await waitFor(`document.getElementById("translatePage")?.hidden === false ? "idle" : ""`, "停止后主按钮回到翻译");
  await evaluate(`document.getElementById("retranslatePage").click()`);
  const retried = JSON.parse(await waitFor(`(() => {
    const row = ${SNAPSHOT};
    const data = JSON.parse(row);
    if (data.page1 !== "running") return "";
    return row;
  })()`, "LD-08 重译胶囊页"));
  assert.equal(retried.page1, "running");
  const page2 = await evaluate(`document.querySelector('#readerFlow .rf-page[data-page="2"]')?.dataset.state || ""`);
  assert.equal(page2, queuedBefore);

  await openMode("fast");
  await waitFor(`document.querySelector("#readerFlow .rf-block") ? "blocks" : ""`, "fast: 第 1 页已有段落");
  await evaluate(`(() => {
    document.getElementById("translateScroll").scrollTop = 280;
    requestAnimationFrame(() => { window.__oiArmDrift = true; });
    return true;
  })()`);
  const drift = JSON.parse(await waitFor(`(() => {
    const probe = window.__oiDrift;
    const batches = (window.__oiAuto && window.__oiAuto.batches || []).length;
    if (!probe || batches < 2 || probe.samples < 4) return "";
    return JSON.stringify(probe);
  })()`, "LD-12 视口锚点", 90000));
  assert.ok(drift.max <= 1, `viewport drift ${drift.max}px`);

  const ready = JSON.parse(await waitFor(`(() => {
    const block = [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => (el.querySelector(".rf-zh")?.textContent || "").includes("译:"));
    if (!block || !block.querySelector(".rf-src")) return "";
    return JSON.stringify({
      id: block.dataset.blockId || "",
      pair: block.dataset.pairId || "",
      zh: block.querySelector(".rf-zh").textContent.slice(0, 80),
      src: block.querySelector(".rf-src").textContent.slice(0, 80),
      batches: (window.__oiAuto && window.__oiAuto.batches || []).length,
      status: document.getElementById("status")?.textContent || ""
    });
  })()`, "原文: 段里同时有中文和原文"));
  assert.match(ready.zh, /译:/);
  assert.equal(ready.src.includes("译:"), false);
  await evaluate(`document.getElementById("restoreOriginal").click()`);
  const srcView = JSON.parse(await evaluate(`(() => {
    const block = document.querySelector("#readerFlow .rf-block[data-block-id=\\"${ready.id}\\"]")
      || [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => (el.querySelector(".rf-zh")?.textContent || "").includes("译:"));
    const zh = block.querySelector(".rf-zh");
    const src = block.querySelector(".rf-src");
    const button = document.getElementById("restoreOriginal");
    const box = button.getBoundingClientRect();
    const visual = document.querySelector("#readerFlow .oi-pdf-display-math img, #readerFlow .oi-pdf-figure img, #readerFlow .oi-pdf-table img");
    return JSON.stringify({
      view: document.querySelector(".workspace")?.dataset.view || "",
      pressed: button.getAttribute("aria-pressed"),
      zhDisplay: getComputedStyle(zh).display,
      srcDisplay: getComputedStyle(src).display,
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
  assert.equal(srcView.visible.includes(srcView.srcText.slice(0, 24)), true);
  assert.equal(srcView.pair, ready.pair);
  assert.equal(srcView.height, 30);
  if (srcView.visual) assert.notEqual(srcView.visual, "none");
  assert.equal(srcView.status.includes("已停止"), ready.status.includes("已停止"));
  await evaluate(`document.getElementById("restoreOriginal").click()`);
  const zhView = JSON.parse(await evaluate(`(() => {
    const block = [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => (el.querySelector(".rf-zh")?.textContent || "").includes("译:"));
    const zh = block.querySelector(".rf-zh");
    const src = block.querySelector(".rf-src");
    return JSON.stringify({
      view: document.querySelector(".workspace")?.dataset.view || "",
      pressed: document.getElementById("restoreOriginal").getAttribute("aria-pressed"),
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
});
