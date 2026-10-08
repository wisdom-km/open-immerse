// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// Mini mode fits the page width to the source column. No production flag.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { fitWidthZoom, formatZoomPercent } from "../lib/pdf-viewer.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PREFIXES = ["oi-mini-fit-", "com.google.Chrome.", ".com.google.Chrome."];
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
    "--window-size=1280,800",
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

const MEASURE = `(() => {
  const pages = document.getElementById("pages");
  const wrap = pages && pages.querySelector(".pdf-page");
  if (!pages || !wrap) return null;
  const wrapWidth = wrap.getBoundingClientRect().width;
  if (!(wrapWidth > 40) || !(pages.clientWidth > 40)) return null;
  return {
    label: document.getElementById("zoomLabel")?.textContent || "",
    clientWidth: pages.clientWidth,
    scrollWidth: pages.scrollWidth,
    wrap: wrapWidth,
    mode: document.querySelector(".workspace")?.dataset.sourceMode || ""
  };
})()`;

test("mini mode fits the page width and keeps a manual zoom", { timeout: 180000 }, async (t) => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const data = new Uint8Array(readFileSync(fixture));
  const doc = await getDocument({ data, verbosity: 0, isOffscreenCanvasSupported: false }).promise;
  const baseWidth = (await doc.getPage(1)).getViewport({ scale: 1 }).width;
  await doc.destroy();
  assert.ok(baseWidth > 500 && baseWidth < 700, `unexpected page width ${baseWidth}`);

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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-mini-fit-"));
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
      try { localStorage.setItem("reader.sourceMode", "mini"); } catch {}
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
  const fitOf = (metrics) => {
    const fit = fitWidthZoom(baseWidth, metrics.clientWidth);
    assert.equal(metrics.mode, "mini");
    assert.equal(metrics.label, formatZoomPercent(fit));
    assert.ok(metrics.wrap <= metrics.clientWidth + 0.75, `wrap ${metrics.wrap} exceeds column ${metrics.clientWidth}`);
    assert.ok(metrics.clientWidth - metrics.wrap < 1.25, `wrap ${metrics.wrap} does not fill ${metrics.clientWidth}`);
    assert.ok(metrics.scrollWidth <= metrics.clientWidth + 1, `horizontal overflow ${metrics.scrollWidth - metrics.clientWidth}`);
    return { ...metrics, scale: fit, percent: formatZoomPercent(fit) };
  };
  const waitFit = async (label) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < 50000) {
      last = await evaluate(MEASURE);
      if (last) {
        try {
          return fitOf(last);
        } catch {
          /* layout still settling */
        }
      }
      await sleep(200);
    }
    throw new Error(`${label}: ${JSON.stringify(last)}`);
  };

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false
  });
  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}` });
  const at1280 = await waitFit("1280x800");

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1920,
    height: 1080,
    deviceScaleFactor: 1,
    mobile: false
  });
  await evaluate(`new Promise((done) => {
    window.dispatchEvent(new Event("resize"));
    requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
  })`);
  const at1920 = await waitFit("1920x1080");
  console.log(`MINI_FIT ${JSON.stringify({
    baseWidth,
    "1280x800": { label: at1280.percent, scale: at1280.scale, inner: at1280.clientWidth, wrap: at1280.wrap },
    "1920x1080": { label: at1920.percent, scale: at1920.scale, inner: at1920.clientWidth, wrap: at1920.wrap }
  })}`);

  const widened = await evaluate(`(() => {
    const handle = document.querySelector(".split-handle");
    handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    return true;
  })()`);
  assert.equal(widened, true);
  const started = Date.now();
  let resized = null;
  while (Date.now() - started < 8000) {
    const metrics = await evaluate(MEASURE);
    if (metrics && metrics.clientWidth > at1920.clientWidth + 8) {
      resized = fitOf(metrics);
      break;
    }
    await sleep(100);
  }
  assert.ok(resized, "column resize did not refit");
  assert.ok(resized.scale > at1920.scale);

  const waitFor = async (expression, label, timeoutMs = 8000) => {
    const begun = Date.now();
    let last = null;
    while (Date.now() - begun < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(80);
    }
    throw new Error(`${label}: ${JSON.stringify(last)}`);
  };
  await evaluate(`document.getElementById("zoomIn").click()`);
  const chosen = await waitFor(`(() => {
    const label = document.getElementById("zoomLabel")?.textContent || "";
    return label && label !== ${JSON.stringify(resized.percent)} ? label : "";
  })()`, "zoom in");
  await evaluate(`document.querySelector('#sourceModeSeg [data-source-mode="side"]').click()`);
  await waitFor(`(() => {
    const mode = document.querySelector(".workspace")?.dataset.sourceMode || "";
    const label = document.getElementById("zoomLabel")?.textContent || "";
    return mode === "side" && label === ${JSON.stringify(chosen)} ? "kept" : "";
  })()`, "side keeps manual zoom");
  await evaluate(`document.querySelector('#sourceModeSeg [data-source-mode="mini"]').click()`);
  await waitFor(`(() => {
    const mode = document.querySelector(".workspace")?.dataset.sourceMode || "";
    const label = document.getElementById("zoomLabel")?.textContent || "";
    return mode === "mini" && label === ${JSON.stringify(chosen)} ? "kept" : "";
  })()`, "mini keeps manual zoom");
});
