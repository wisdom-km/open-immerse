// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// The test server rewrites pageCropLooksEmpty so a figure crop renders the
// placeholder. That rewrite is not in the file on disk.
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

const PREFIXES = ["oi-asset-fallback-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
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
const EMPTY_CROP = "export function pageCropLooksEmpty(pageRatio, bbox) {";
const FORCED_CROP = "export function pageCropLooksEmpty(pageRatio, bbox) {\n  return true;";

function serveRepo() {
  let patched = false;
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
      let body = readFileSync(file);
      if (rel === "lib/pdf-formula-raster.js") {
        const source = body.toString("utf8");
        if (!source.includes(EMPTY_CROP)) throw new Error("pageCropLooksEmpty hook point missing");
        body = Buffer.from(source.replace(EMPTY_CROP, FORCED_CROP));
        patched = true;
      }
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.patched = () => patched;
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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

test("figure placeholder jumps the source pane to its page", { timeout: 180000 }, async (t) => {
  const disk = readFileSync(join(root, "lib/pdf-formula-raster.js"), "utf8");
  assert.match(disk, /return pageRatio < VISUAL_CROP_EMPTY_INK/);
  assert.equal(disk.includes(FORCED_CROP), false);
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");

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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-asset-fallback-"));
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
      try { localStorage.setItem("reader.follow", "0"); } catch {}
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
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
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
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}` });

  const waitFor = async (expression, label, timeoutMs = 60000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`${label}: ${JSON.stringify(last)}`);
  };
  const sourcePage = async () => {
    const label = await evaluate(`document.getElementById("sourcePageLabel")?.textContent || ""`);
    return Number((/^(\d+)/.exec(String(label || "").trim()) || [])[1] || 0);
  };
  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    return /\\/\\s*15/.test(pager) ? pager : "";
  })()`, "Attention open");
  for (let step = 0; step < 6 && await sourcePage() < 3; step += 1) {
    await evaluate(`document.getElementById("sourceNext")?.click()`);
    await sleep(300);
  }
  assert.equal(await sourcePage(), 3, "source pager did not reach page 3");

  let ready = null;
  const paintStarted = Date.now();
  while (Date.now() - paintStarted < 60000) {
    ready = await evaluate(`(() => {
      const button = document.querySelector("#readerFlow .oi-pdf-asset-fallback[data-page='3']");
      const page3 = document.querySelector("#pages .pdf-page[data-page='3']");
      if (!button || !page3 || page3.getBoundingClientRect().height < 40) return null;
      return {
        tag: button.tagName,
        type: button.getAttribute("type"),
        text: button.textContent,
        label: button.getAttribute("aria-label"),
        page: button.dataset.page,
        follow: document.querySelector(".workspace")?.dataset.follow || ""
      };
    })()`);
    if (ready) break;
    await sleep(200);
  }
  assert.ok(handle.server.patched(), "viewer did not load the test crop hook");
  if (!ready) {
    const snap = await evaluate(`(() => {
      const flow = document.getElementById("readerFlow");
      return {
        status: document.getElementById("docStatus")?.textContent || "",
        state: document.getElementById("docStatus")?.dataset.state || "",
        slots: [...document.querySelectorAll("#readerFlow .rf-page")].map((el) => el.dataset.page + ":" + (el.dataset.state || "")),
        figures: flow ? flow.querySelectorAll(".oi-pdf-figure").length : 0,
        fallbacks: flow ? flow.querySelectorAll(".oi-pdf-asset-fallback").length : 0
      };
    })()`);
    assert.ok(ready, `placeholder did not render ${JSON.stringify(snap)}`);
  }
  assert.equal(ready.tag, "BUTTON");
  assert.equal(ready.type, "button");
  assert.equal(ready.page, "3");
  assert.match(ready.text, /图见原文第 3 页（点击查看）/);
  assert.equal(ready.label, "图见原文第 3 页");
  assert.equal(ready.follow, "off");

  await evaluate(`(() => {
    const pane = document.getElementById("pages");
    const wrap = pane.querySelector(".pdf-page[data-page='1']");
    const top = pane.scrollTop + (wrap.getBoundingClientRect().top - pane.getBoundingClientRect().top);
    pane.scrollTop = Math.max(0, top);
    return true;
  })()`);
  await waitFor(`(() => {
    const pane = document.getElementById("pages");
    const paneTop = pane.getBoundingClientRect().top;
    const wrap = pane.querySelector(".pdf-page[data-page='1']");
    const top = wrap.getBoundingClientRect().top - paneTop;
    return Math.abs(top) < 8 ? "page1" : "";
  })()`, "source returned to page 1", 5000);

  const before = await evaluate(`(() => {
    const pane = document.getElementById("pages");
    const paneTop = pane.getBoundingClientRect().top;
    let best = null;
    for (const wrap of pane.querySelectorAll(".pdf-page")) {
      const top = wrap.getBoundingClientRect().top - paneTop;
      const score = Math.abs(top);
      if (!best || score < best.score) best = { page: Number(wrap.dataset.page), score };
    }
    const button = document.querySelector("#readerFlow .oi-pdf-asset-fallback[data-page='3']");
    let node = button;
    while (node) {
      if (node.dataset && node.dataset.pairId) delete node.dataset.pairId;
      node = node.parentElement;
    }
    button.scrollIntoView({ block: "center" });
    const box = button.getBoundingClientRect();
    return {
      page: best && best.page,
      score: best && best.score,
      paired: Boolean(button.closest("[data-pair-id]")),
      x: box.left + box.width / 2,
      y: box.top + box.height / 2
    };
  })()`);
  assert.equal(before.page, 1);
  assert.ok(before.score < 8);
  assert.equal(before.paired, false);

  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: before.x, y: before.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: before.x, y: before.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: before.x, y: before.y, button: "left", clickCount: 1 });
  await evaluate(`new Promise((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
  })`);

  const after = await evaluate(`(() => {
    const pane = document.getElementById("pages");
    const paneTop = pane.getBoundingClientRect().top;
    const wrap = pane.querySelector(".pdf-page[data-page='3']");
    const top = wrap.getBoundingClientRect().top - paneTop;
    return {
      top,
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      label: document.getElementById("sourcePageLabel")?.textContent || ""
    };
  })()`);
  assert.ok(Math.abs(after.top) < 8, `page 3 top ${after.top}`);
  assert.equal(after.follow, "on");
  assert.match(after.label, /^3\s*\//);
});
