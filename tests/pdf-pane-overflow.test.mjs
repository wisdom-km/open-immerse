// Side-by-side at 1440 used to give the translation pane a horizontal
// scrollbar. Long URLs and reference lines in .rf-zh did not wrap, and
// text-align:justify then stretched a short line such as "提示。" across
// that width. Display formulas stay inside .oi-pdf-math-scroll.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PREFIXES = ["oi-pane-overflow-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docs = [
  ["DPO", "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf"],
  ["Attention", "tests/fixtures/Attention_Is_All_You_Need.pdf"]
];
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

test("translation text can break a long URL inside the column", () => {
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  const rule = css.slice(css.indexOf(".reader-flow .rf-zh,"), css.indexOf(".reader-flow .oi-pdf-p + .oi-pdf-p"));
  assert.match(rule, /\.reader-flow \.rf-zh/);
  assert.match(rule, /\.reader-flow \.rf-src/);
  assert.match(rule, /\.reader-flow \.oi-pdf-p/);
  assert.match(rule, /\.reader-flow \.oi-pdf-footnote/);
  assert.match(rule, /overflow-wrap:\s*anywhere/);
});

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
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
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
    "--force-device-scale-factor=1",
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

  send(method, params = {}, sessionId, timeoutMs = 30000) {
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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const MEASURE = `(() => {
  const pane = document.getElementById("translateScroll");
  const flow = document.getElementById("readerFlow");
  const slider = document.getElementById("aaFontScale");
  if (!pane || !flow || !(pane.clientWidth > 100)) return null;
  const limit = pane.clientWidth + 1;
  let zhMax = 0;
  let zhText = "";
  for (const el of flow.querySelectorAll(".rf-zh, .rf-src")) {
    const width = el.getBoundingClientRect().width;
    if (width > zhMax) {
      zhMax = width;
      zhText = (el.textContent || "").replace(/\\s+/g, " ").slice(0, 80);
    }
  }
  let scrollMax = 0;
  let imgMax = 0;
  let imgPage = "";
  for (const scroll of flow.querySelectorAll(".oi-pdf-math-scroll")) {
    scrollMax = Math.max(scrollMax, scroll.getBoundingClientRect().width);
  }
  for (const img of flow.querySelectorAll(".oi-pdf-display-math img")) {
    const width = img.getBoundingClientRect().width;
    if (width > imgMax) {
      imgMax = width;
      imgPage = img.closest("[data-page]")?.dataset.page || "";
    }
  }
  return {
    scrollWidth: pane.scrollWidth,
    clientWidth: pane.clientWidth,
    flow: Math.round(flow.getBoundingClientRect().width),
    setting: slider?.getAttribute("aria-valuenow") || "",
    shown: getComputedStyle(flow).fontSize,
    mode: document.querySelector(".workspace")?.dataset.sourceMode || "",
    view: document.querySelector(".workspace")?.dataset.view || "",
    zhMax: Math.round(zhMax),
    zhText,
    scrollMax: Math.round(scrollMax),
    imgMax: Math.round(imgMax),
    imgPage,
    overflow: pane.scrollWidth > limit
  };
})()`;

test("translation pane does not scroll sideways on DPO or Attention", { timeout: 300000 }, async (t) => {
  for (const [, rel] of docs) {
    assert.equal(existsSync(join(root, rel)), true, `${rel} is missing`);
  }
  const handle = { child: null, cdp: null, server: null, ownedDir: null, userDataDir: null };
  t.after(async () => {
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({
        t,
        child: handle.child,
        server: handle.server,
        ownedDir: handle.ownedDir,
        userDataDir: handle.userDataDir
      });
    }
  });

  handle.server = await serveRepo();
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-pane-overflow-"));
  rememberOwnedTemp(handle.ownedDir);
  const userDataDir = join(handle.ownedDir, "profile");
  const scratchDir = join(handle.ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  handle.userDataDir = userDataDir;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      try {
        localStorage.setItem("reader.fontSize", "20");
        localStorage.setItem("reader.sourceMode", "side");
        localStorage.setItem("reader.follow", "0");
      } catch {}
      globalThis.chrome = {
        storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
        runtime: {
          getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
          sendMessage(message) {
            const type = message && message.type;
            if (type === "OI_GET_SETTINGS") {
              return Promise.resolve({ settings: { pdfAutoTranslate: false, batchSize: 8, targetLang: "zh-CN", pdfLayout: { mode: "" }, features: { pdf: true } } });
            }
            if (type === "OI_PDF_STRUCTURE") return Promise.resolve({ ok: false });
            if (type === "OI_ENSURE_GLMOCR") return Promise.resolve({ ok: true });
            return Promise.resolve({ ok: true });
          },
          onMessage: { addListener() {} }
        }
      };
    })();`
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30000);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const origin = `http://127.0.0.1:${handle.server.address().port}`;

  const viewport = async (width, height) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await evaluate("window.dispatchEvent(new Event('resize'))");
    await sleep(400);
  };

  const setMode = async (mode) => {
    const applied = await evaluate(`(() => {
      const button = document.querySelector('#sourceModeSeg [data-source-mode="${mode}"]');
      if (!button) return "";
      button.click();
      return document.querySelector(".workspace")?.dataset.sourceMode || "";
    })()`);
    assert.equal(applied, mode);
    await sleep(300);
  };

  const setFont = async (target) => {
    const setting = await evaluate(`(() => {
      const slider = document.getElementById("aaFontScale");
      if (!slider || slider.getAttribute("aria-disabled") === "true") return "";
      for (let i = 0; i < 20; i += 1) {
        const now = Number(slider.getAttribute("aria-valuenow"));
        if (now === ${target}) return String(now);
        const key = now < ${target} ? "ArrowRight" : "ArrowLeft";
        slider.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      }
      return slider.getAttribute("aria-valuenow") || "";
    })()`);
    assert.equal(setting, String(target), `font setting ${setting}`);
    await sleep(250);
  };

  const measure = async () => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < 8000) {
      last = await evaluate(MEASURE);
      if (last?.clientWidth > 100 && last.flow > 100) return last;
      await sleep(150);
    }
    throw new Error(`pane not measured: ${JSON.stringify(last)}`);
  };

  const assertFits = (doc, row) => {
    assert.equal(row.overflow, false, `${doc} ${row.mode} setting ${row.setting} shown ${row.shown} view ${row.view}: scroll ${row.scrollWidth} > pane ${row.clientWidth} (${row.zhText})`);
    assert.ok(row.scrollWidth <= row.clientWidth + 1, `${doc} scroll ${row.scrollWidth} pane ${row.clientWidth}`);
    assert.ok(row.zhMax <= row.clientWidth + 1, `${doc} text ${row.zhMax}px exceeds pane ${row.clientWidth}: ${row.zhText}`);
    assert.ok(row.scrollMax <= row.clientWidth + 1, `${doc} formula scroll ${row.scrollMax} exceeds pane ${row.clientWidth} (image ${row.imgMax} on p${row.imgPage})`);
  };

  await viewport(1440, 900);
  for (const [doc, rel] of docs) {
    await viewport(1440, 900);
    await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(`${origin}/${rel}`)}` });
    const opened = Date.now();
    let ready = null;
    while (Date.now() - opened < 60000) {
      ready = await evaluate(`(() => {
        const flow = document.getElementById("readerFlow");
        const pages = document.querySelectorAll("#pages .pdf-page").length;
        const painted = flow ? flow.querySelectorAll(".rf-page[data-page='1'] > *").length : 0;
        const next = document.getElementById("sourceNext");
        return { pages, painted, next: Boolean(next && !next.disabled) };
      })()`);
      if (ready?.painted > 0 && ready.pages > 1 && ready.next) break;
      await sleep(250);
    }
    assert.ok(ready?.painted > 0, `${doc} did not paint page 1`);
    for (let page = 2; page <= ready.pages; page += 1) {
      const clicked = await evaluate(`(() => {
        const next = document.getElementById("sourceNext");
        if (!next || next.disabled) return false;
        next.click();
        return true;
      })()`);
      assert.equal(clicked, true, `${doc} stuck before page ${page}`);
      const step = Date.now();
      let painted = 0;
      while (Date.now() - step < 20000) {
        painted = await evaluate(`document.querySelectorAll('#readerFlow .rf-page[data-page="${page}"] > *').length`);
        if (painted > 0) break;
        await sleep(200);
      }
      assert.ok(painted > 0, `${doc} page ${page} did not paint`);
    }

    const gap = await evaluate(`(() => {
      const flow = document.getElementById("readerFlow");
      const probe = document.createElement("p");
      probe.className = "oi-pdf-p";
      probe.dataset.probe = "justify";
      const zh = document.createElement("span");
      zh.className = "rf-zh";
      zh.textContent = "提示。https://huggingface.co/CarperAI/openai_summarize_tldr_sft";
      probe.append(zh);
      flow.append(probe);
      const text = zh.firstChild;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 1);
      const first = range.getBoundingClientRect();
      range.setStart(text, 1);
      range.setEnd(text, 2);
      const second = range.getBoundingClientRect();
      const box = zh.getBoundingClientRect();
      const column = flow.getBoundingClientRect().width;
      probe.remove();
      return {
        gap: second.left - first.right,
        sameLine: Math.abs(first.top - second.top) < 1,
        width: box.width,
        column
      };
    })()`);
    assert.equal(gap.sameLine, true, `${doc} 提 and 示 split across lines`);
    assert.ok(gap.gap < 12, `${doc} justify gap ${gap.gap}px between 提 and 示`);
    assert.ok(gap.width <= gap.column + 1, `${doc} probe ${gap.width} exceeds column ${gap.column}`);

    for (const font of [20, 32, 40]) {
      await setFont(font);
      for (const view of ["zh", "src"]) {
        await evaluate(`document.querySelector('#viewSeg [data-view="${view}"]')?.click()`);
        const row = await measure();
        assert.equal(row.setting, String(font));
        assert.equal(row.mode, "side");
        assert.equal(row.view, view);
        assertFits(doc, row);
      }
    }

    await viewport(1280, 900);
    await setMode("mini");
    for (const font of [20, 32, 40]) {
      await setFont(font);
      for (const view of ["zh", "src"]) {
        await evaluate(`document.querySelector('#viewSeg [data-view="${view}"]')?.click()`);
        const row = await measure();
        assert.equal(row.setting, String(font));
        assert.equal(row.mode, "mini");
        assert.equal(row.view, view);
        assertFits(doc, row);
      }
    }
  }
});
