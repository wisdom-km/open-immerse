// Divider drags in mini mode must not leave source-page canvases blank.
// On c26011b, syncMiniFitZoom calls applyZoom on every pointermove. A
// round trip (72 → 73 → 72) hides canvases in layoutPages, and pages
// outside ±RENDER_RADIUS stay hidden because renderView returns early
// when renderedScale === zoom.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { fitWidthZoom } from "../lib/pdf-viewer.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PREFIXES = ["oi-mini-blank-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PAGE_COUNT = 12;
const FAR_PAGE = PAGE_COUNT;
const HOME_PAGE = 1;
const DRAGS = 20;
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

function multiPagePdf(pageCount) {
  const objects = new Map();
  objects.set(1, "<< /Type /Catalog /Pages 2 0 R >>");
  objects.set(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const kids = [];
  let id = 4;
  for (let n = 1; n <= pageCount; n += 1) {
    const contentId = id;
    id += 1;
    const pageId = id;
    id += 1;
    kids.push(`${pageId} 0 R`);
    const stream = `BT /F1 18 Tf 72 720 Td (Mini blank page ${n}) Tj ET`;
    objects.set(contentId, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    objects.set(
      pageId,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
    );
  }
  objects.set(2, `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pageCount} >>`);
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
  for (let n = 1; n <= maxId; n += 1) {
    xref += `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  }
  chunks.push(xref);
  chunks.push(`trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`);
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function instrumentViewer(source) {
  const needle = "async function applyZoom(scale) {";
  const at = source.indexOf(needle);
  if (at < 0) throw new Error("applyZoom signature missing");
  const injected = `${source.slice(0, at + needle.length)}\n  globalThis.__oiZoomApplies = (globalThis.__oiZoomApplies || 0) + 1;${source.slice(at + needle.length)}`;
  return `${injected}
globalThis.__oiPdfViews = () => ({
  zoom,
  applies: globalThis.__oiZoomApplies || 0,
  pages: pageViews.map((view) => ({
    num: view.num,
    hidden: view.canvas.hidden === true,
    renderedScale: view.renderedScale,
    canvasWidth: view.canvas.width || 0
  }))
});
`;
}

function serveRepo(syntheticPdf) {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    if (rel === "synthetic/mini-blank.pdf") {
      res.writeHead(200, { "content-type": "application/pdf", "cache-control": "no-store" });
      res.end(syntheticPdf);
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
      if (rel === "pdf/viewer.js") {
        const body = instrumentViewer(readFileSync(file, "utf8"));
        res.writeHead(200, {
          "content-type": MIME[".js"],
          "cache-control": "no-store"
        });
        res.end(body);
        return;
      }
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

const SNAPSHOT = `(() => {
  if (typeof globalThis.__oiPdfViews !== "function") return null;
  const probe = globalThis.__oiPdfViews();
  const pages = document.getElementById("pages");
  const mode = document.querySelector(".workspace")?.dataset.sourceMode || "";
  const mini = parseFloat(document.querySelector(".workspace")?.style.getPropertyValue("--oi-mini-width")) || 0;
  const label = document.getElementById("zoomLabel")?.textContent || "";
  return { ...probe, mode, mini, label, clientWidth: pages ? pages.clientWidth : 0 };
})()`;

function scrollExpr(page) {
  return `(() => {
    const wrap = document.querySelector('.pdf-page[data-page="${page}"]');
    if (!wrap) return false;
    wrap.scrollIntoView({ block: "start", behavior: "instant" });
    document.getElementById("pages")?.dispatchEvent(new Event("scroll"));
    return true;
  })()`;
}

function dragExpr(target) {
  return `(() => {
    const workspace = document.querySelector(".workspace");
    const handle = document.querySelector(".split-handle");
    if (!workspace || !handle) return { error: "missing handle" };
    const rect = workspace.getBoundingClientRect();
    const current = parseFloat(workspace.style.getPropertyValue("--oi-mini-width")) || 360;
    const target = ${target};
    const before = globalThis.__oiZoomApplies || 0;
    const pointerId = 1;
    const y = rect.y + 48;
    const at = (width) => rect.x + width;
    const fire = (type, width, buttons) => {
      handle.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        pointerId,
        pointerType: "mouse",
        isPrimary: true,
        clientX: at(width),
        clientY: y
      }));
    };
    fire("pointerdown", current, 1);
    const steps = 6;
    for (let i = 1; i <= steps; i += 1) {
      fire("pointermove", current + (target - current) * (i / steps), 1);
    }
    fire("pointerup", target, 0);
    const mini = parseFloat(workspace.style.getPropertyValue("--oi-mini-width")) || 0;
    return { from: current, to: mini, target, applies: (globalThis.__oiZoomApplies || 0) - before };
  })()`;
}

test("mini divider drags do not blank pages outside the render radius", { timeout: 180000 }, async (t) => {
  const syntheticPdf = multiPagePdf(PAGE_COUNT);
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(syntheticPdf),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const baseWidth = (await doc.getPage(1)).getViewport({ scale: 1 }).width;
  assert.equal(doc.numPages, PAGE_COUNT);
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

  handle.server = await serveRepo(syntheticPdf);
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-mini-blank-"));
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
      const capture = Element.prototype.setPointerCapture;
      Element.prototype.setPointerCapture = function(id) {
        try { return capture.call(this, id); } catch { /* synthetic divider pointer */ }
      };
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
  const waitFor = async (expression, label, timeoutMs = 20000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(80);
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
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(`${origin}/synthetic/mini-blank.pdf`)}` });

  const painted = (page) => `(() => {
    const snap = ${SNAPSHOT};
    if (!snap || snap.mode !== "mini" || !(snap.clientWidth > 40)) return null;
    const row = (snap.pages || []).find((item) => item.num === ${page});
    if (!row || row.hidden || !(row.canvasWidth > 0)) return null;
    if (row.renderedScale !== snap.zoom) return null;
    return snap;
  })()`;

  const home = await waitFor(painted(HOME_PAGE), "page 1 painted");
  assert.equal(await evaluate(scrollExpr(FAR_PAGE)), true);
  const far = await waitFor(painted(FAR_PAGE), "far page painted");
  const homeRow = far.pages.find((item) => item.num === HOME_PAGE);
  assert.equal(homeRow.hidden, false);
  assert.equal(homeRow.renderedScale, far.zoom);
  const originZoom = far.zoom;
  const originMini = far.mini;
  assert.ok(originMini >= 300 && originMini <= 480, `mini width ${originMini}`);

  const drags = [];
  for (let i = 0; i < DRAGS; i += 1) {
    const target = i === DRAGS - 1 ? originMini : (i % 2 === 0 ? 480 : 300);
    const moved = await evaluate(dragExpr(target));
    assert.equal(moved.to, target, `drag ${i + 1} width ${JSON.stringify(moved)}`);
    assert.ok(moved.applies <= 2, `drag ${i + 1} applyZoom ${moved.applies}`);
    if (Math.abs(moved.target - moved.from) >= 24) {
      assert.ok(moved.applies >= 1, `drag ${i + 1} did not refit`);
    }
    drags.push(moved);
  }

  assert.equal(await evaluate(scrollExpr(FAR_PAGE)), true);
  const settled = await waitFor(painted(FAR_PAGE), "far page after drags");
  assert.equal(settled.mini, originMini);
  assert.ok(Math.abs(settled.zoom - originZoom) < 1e-6, `zoom ${settled.zoom} did not return to ${originZoom}`);
  const fit = fitWidthZoom(baseWidth, settled.clientWidth);
  assert.ok(Math.abs(settled.zoom - fit) < 1e-6, `zoom ${settled.zoom} is not the fit ${fit}`);
  const stuck = settled.pages.filter((item) => item.hidden && item.renderedScale === settled.zoom);
  assert.deepEqual(stuck, [], `blank pages ${JSON.stringify(stuck)}`);

  assert.equal(await evaluate(scrollExpr(HOME_PAGE)), true);
  const returned = await waitFor(painted(HOME_PAGE), "page 1 renders when scrolled back");
  const back = returned.pages.find((item) => item.num === HOME_PAGE);
  assert.equal(back.hidden, false);
  assert.equal(back.renderedScale, returned.zoom);

  const mid = 6;
  assert.ok(Math.abs(mid - HOME_PAGE) > 2);
  assert.equal(await evaluate(scrollExpr(mid)), true);
  const middle = await waitFor(painted(mid), "page beyond ±2 renders when scrolled to");
  const midRow = middle.pages.find((item) => item.num === mid);
  assert.equal(midRow.hidden, false);
  assert.equal(midRow.renderedScale, middle.zoom);

  const nudged = await evaluate(dragExpr(originMini + 2));
  assert.equal(nudged.to, originMini + 2);
  assert.equal(nudged.applies, 0, `1% slack still called applyZoom ${nudged.applies} times`);

  const widened = await evaluate(dragExpr(originMini >= 420 ? 320 : 460));
  assert.ok(widened.applies >= 1 && widened.applies <= 2);
  const fitted = await waitFor(`(() => {
    const snap = ${SNAPSHOT};
    if (!snap) return null;
    const row = (snap.pages || []).find((item) => item.num === ${mid});
    if (!row || row.hidden) return null;
    return snap;
  })()`, "refit after widen");
  const nextFit = fitWidthZoom(baseWidth, fitted.clientWidth);
  assert.ok(Math.abs(fitted.zoom - nextFit) <= 0.01, `fit drift ${fitted.zoom} vs ${nextFit}`);
  const wrap = await evaluate(`document.querySelector('.pdf-page[data-page="${mid}"]')?.getBoundingClientRect().width || 0`);
  assert.ok(wrap <= fitted.clientWidth + 0.75, `wrap ${wrap} exceeds column ${fitted.clientWidth}`);
  assert.ok(fitted.clientWidth - wrap < 1.25, `wrap ${wrap} does not fill ${fitted.clientWidth}`);

  await evaluate(`document.getElementById("zoomIn").click()`);
  const chosen = await waitFor(`(() => {
    const label = document.getElementById("zoomLabel")?.textContent || "";
    return label && label !== ${JSON.stringify(fitted.label)} ? label : "";
  })()`, "manual zoom");
  const keptDrag = await evaluate(dragExpr(originMini));
  assert.ok(keptDrag.applies <= 2);
  const kept = await evaluate(SNAPSHOT);
  assert.equal(kept.label, chosen, "manual zoom was not kept for this document");
  console.log(`MINI_BLANK ${JSON.stringify({
    baseWidth,
    originZoom,
    originMini,
    drags: drags.map((item) => item.applies),
    home: home.zoom
  })}`);
});
