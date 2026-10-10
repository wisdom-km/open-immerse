// A synthetic wide formula in a narrow column. At the default measure, real
// DPO's widest display (~401pt) still fits the narrowest column (~476px), so
// the later test forces a 280px column to reach the floor-then-scroll path.
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

const SCROLL_TMP_PREFIXES = ["oi-formula-scroll-chrome-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(SCROLL_TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".woff": "font/woff"
};
const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='640' height='120'><rect width='640' height='120' fill='%23000'/></svg>";
const src = `data:image/svg+xml,${svg}`;
const page = `<!doctype html>
<meta charset="utf-8">
<link rel="stylesheet" href="/pdf/viewer.css">
<style>
  .column { width: 280px; align-self: flex-start; font-size: 15px; }
</style>
<div class="pane-translate">
  <div class="column readout md-readout">
    <figure class="oi-pdf-display-math" id="matched">
      <div class="oi-pdf-math-row is-matched" style="--oi-formula-h:90px;--oi-formula-ar:5.3333">
        <div class="oi-pdf-math-scroll">
          <div class="oi-pdf-math-clip">
            <img class="oi-pdf-math-crop" alt="" width="640" height="120" src="${src}">
          </div>
        </div>
      </div>
    </figure>
    <figure class="oi-pdf-display-math" id="fallback">
      <div class="oi-pdf-math-row" style="--oi-formula-w:max(480px, min(100%, 640px))">
        <div class="oi-pdf-math-scroll">
          <div class="oi-pdf-math-clip">
            <img class="oi-pdf-math-crop" alt="" width="640" height="120" src="${src}">
          </div>
        </div>
      </div>
    </figure>
  </div>
</div>
`;

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/formula-scroll.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(page);
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
    "--window-size=800,600",
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

test("a wide formula in a narrow column stops at the floor and scrolls", { timeout: 60000 }, async (t) => {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-formula-scroll-chrome-"));
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
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  await cdp.send("Page.navigate", { url: `${origin}/formula-scroll.html` }, sessionId);

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

  const started = Date.now();
  let measured = null;
  while (Date.now() - started < 20000) {
    measured = await evaluate(`(() => {
      const sheet = [...document.styleSheets].find((item) => String(item.href || "").includes("viewer.css"));
      if (!sheet) return null;
      try {
        if (!sheet.cssRules.length) return null;
      } catch {
        return null;
      }
      const imgs = [...document.querySelectorAll("img")];
      if (!imgs.length || imgs.some((img) => !img.complete || img.naturalWidth < 1)) return null;
      const read = (id) => {
        const host = document.getElementById(id);
        const scroll = host.querySelector(".oi-pdf-math-scroll");
        const crop = host.querySelector(".oi-pdf-math-crop");
        const box = crop.getBoundingClientRect();
        const style = getComputedStyle(crop);
        return {
          width: box.width,
          height: box.height,
          scrollWidth: scroll.scrollWidth,
          clientWidth: scroll.clientWidth,
          maxHeight: style.maxHeight
        };
      };
      return { matched: read("matched"), fallback: read("fallback") };
    })()`);
    if (measured) break;
    await sleep(100);
  }
  assert.ok(measured, "formula images laid out");
  for (const [name, row] of Object.entries(measured)) {
    assert.equal(row.maxHeight, "none", `${name} max-height`);
    assert.ok(row.width >= 470 && row.width <= 490, `${name} width ${row.width} left the 0.75 floor`);
    assert.ok(row.height >= 80 && row.height <= 100, `${name} height ${row.height} left the 0.75 floor`);
    assert.ok(row.clientWidth <= 290, `${name} column ${row.clientWidth}`);
    assert.ok(row.scrollWidth > row.clientWidth + 40, `${name} scroll ${row.scrollWidth} vs ${row.clientWidth}`);
  }
});

const READER_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
  ".png": "image/png"
};
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");

function serveReader() {
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
        "content-type": READER_MIME[extname(file)] || "application/octet-stream",
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

function launchReaderChrome(userDataDir, scratchDir) {
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

async function wideDpoDisplay() {
  const { textLayerToBlocks } = await import("../lib/pdf-text-layer.js");
  const { describeBodyFont } = await import("../lib/pdf-body-font.js");
  const { getDocument, GlobalWorkerOptions } = await import("../pdf/vendor/pdf.min.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(dpoPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  try {
    let best = null;
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const built = textLayerToBlocks({ items: content.items, viewport, page: number });
      const described = describeBodyFont(content.items, {
        pageWidth: viewport.width,
        pageHeight: viewport.height
      });
      const bodyPt = described.trusted && described.bodyItemHeight > 0 ? described.bodyItemHeight : 10;
      let widthPt = 0;
      for (const block of built.blocks || []) {
        if (block.label !== "formula" || block.inlineOf || block.display === false) continue;
        if (!Array.isArray(block.bbox) || block.bbox.length < 4) continue;
        const width = (Number(block.bbox[2]) - Number(block.bbox[0])) * viewport.width;
        if (width > widthPt) widthPt = width;
      }
      if (!best || widthPt > best.widthPt) best = { page: number, widthPt, bodyPt };
    }
    return best;
  } finally {
    await doc.destroy();
  }
}

test("a real DPO display formula shrinks to the floor and scrolls in its box", { timeout: 240000 }, async (t) => {
  assert.equal(existsSync(dpoPath), true, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf is missing");
  const { formulaReadabilityFloor } = await import("../lib/pdf-formula-size.js");
  const found = await wideDpoDisplay();
  assert.ok(found && found.widthPt >= 370, `DPO widest display is ${found?.widthPt}`);
  const floor = formulaReadabilityFloor(16, found.bodyPt);
  assert.ok(floor >= 0.75 && floor <= 1, `floor ${floor}`);
  assert.ok(found.widthPt * floor > 280, `${found.widthPt}pt at ${floor} still fits 280px`);

  const server = await serveReader();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-formula-scroll-chrome-"));
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  handle.child = launchReaderChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      globalThis.chrome = {
        storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
        runtime: {
          getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
          sendMessage(message) {
            const type = message && message.type;
            if (type === "OI_GET_SETTINGS") {
              return Promise.resolve({ settings: { pdfAutoTranslate: false, batchSize: 8, targetLang: "zh-CN", provider: "mymemory", pdfLayout: { mode: "" }, features: { pdf: true } } });
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
  const src = `${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?oiAuto=formula-scroll&src=${encodeURIComponent(src)}` });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const sourcePage = async () => {
    const label = await evaluate(`document.getElementById("sourcePageLabel")?.textContent || ""`);
    return Number((/^(\d+)/.exec(String(label || "").trim()) || [])[1] || 0);
  };
  const opened = Date.now();
  let pager = "";
  while (Date.now() - opened < 90000) {
    pager = await evaluate(`document.getElementById("sourcePageLabel")?.textContent || ""`);
    if (/\/\s*\d+/.test(String(pager || "")) && await sourcePage() >= 1) break;
    await sleep(200);
  }
  assert.match(String(pager || ""), /\/\s*\d+/, "DPO did not open");
  // adoptDoc starts loadCurrentPageText after the pager is already visible.
  // An open issued in that window is superseded and returns no blocks; retry
  // until this page owns the text generation and the layout is stored.
  let openedBlocks = 0;
  const openBy = Date.now() + 120000;
  while (Date.now() < openBy) {
    openedBlocks = await evaluate(`globalThis.__oiOpenPage ? globalThis.__oiOpenPage(${found.page}) : 0`);
    if (openedBlocks > 0) break;
    await sleep(200);
  }
  if (!(openedBlocks > 0)) {
    const census = await evaluate(`(() => ({
      hook: typeof globalThis.__oiOpenPage,
      label: document.getElementById("sourcePageLabel")?.textContent || "",
      status: document.getElementById("status")?.textContent || "",
      phase: document.getElementById("docStatus")?.dataset.state || "",
      slots: [...document.querySelectorAll("#readerFlow .rf-page")].slice(0, 6).map((slot) => ({
        page: slot.dataset.page || "",
        state: slot.dataset.state || "",
        blocks: slot.querySelectorAll(".rf-block, .oi-pdf-display-math").length
      }))
    }))()`);
    assert.ok(openedBlocks > 0, `page ${found.page} layout did not open ${JSON.stringify(census)}`);
  }

  const readWide = `(() => {
    const flow = document.getElementById("readerFlow");
    const font = parseFloat(getComputedStyle(flow).fontSize);
    const rows = [...document.querySelectorAll('#readerFlow .oi-pdf-display-math[data-page="${found.page}"] .oi-pdf-math-row.is-matched')];
    const items = [];
    for (const row of rows) {
      const crop = row.querySelector(".oi-pdf-math-crop");
      const scroll = row.querySelector(".oi-pdf-math-scroll");
      if (!crop || !scroll || !crop.complete || crop.naturalWidth < 1) continue;
      const box = crop.getBoundingClientRect();
      if (!(box.width > 0) || !(box.height > 0)) continue;
      items.push({
        width: box.width,
        height: box.height,
        scrollWidth: scroll.scrollWidth,
        clientWidth: scroll.clientWidth
      });
    }
    items.sort((a, b) => b.width - a.width);
    return { font, flow: flow.getBoundingClientRect().width, widest: items[0] || null, count: items.length };
  })()`;
  let wide = null;
  const wideBy = Date.now() + 90000;
  while (Date.now() < wideBy) {
    wide = await evaluate(readWide);
    if (wide?.widest && wide.widest.width >= 360 && wide.widest.scrollWidth <= wide.widest.clientWidth + 2) break;
    await sleep(200);
  }
  if (!wide?.widest) {
    const census = await evaluate(`(() => {
      const flow = document.getElementById("readerFlow");
      const figs = [...document.querySelectorAll("#readerFlow .oi-pdf-display-math")].slice(0, 8).map((node) => ({
        page: node.dataset.page || "",
        matched: Boolean(node.querySelector(".oi-pdf-math-row.is-matched")),
        imgs: [...node.querySelectorAll("img")].map((img) => ({
          complete: img.complete,
          w: img.naturalWidth,
          box: Math.round(img.getBoundingClientRect().width)
        }))
      }));
      return {
        phase: document.getElementById("docStatus")?.dataset.state || "",
        status: document.getElementById("status")?.textContent || "",
        slots: [...(flow?.querySelectorAll(":scope > .rf-page") || [])].slice(0, 4).map((slot) => ({
          page: slot.dataset.page || "",
          state: slot.dataset.state || "",
          math: slot.querySelectorAll(".oi-pdf-display-math").length
        })),
        figs
      };
    })()`);
    assert.ok(wide?.widest, `page ${found.page} display formula did not paint ${JSON.stringify(wide)} ${JSON.stringify(census)}`);
  }
  assert.equal(wide.font, 16);
  assert.ok(wide.flow > wide.widest.width + 8, `column ${wide.flow} already shrinks ${wide.widest.width}`);
  assert.ok(wide.widest.width >= 360, `native width ${wide.widest.width} on page ${found.page} (${found.widthPt}pt)`);
  assert.ok(wide.widest.scrollWidth <= wide.widest.clientWidth + 2, "wide column should not scroll yet");

  await evaluate(`(() => {
    const row = [...document.querySelectorAll('#readerFlow .oi-pdf-display-math[data-page="${found.page}"] .oi-pdf-math-row.is-matched')]
      .sort((a, b) => b.querySelector(".oi-pdf-math-crop").getBoundingClientRect().width - a.querySelector(".oi-pdf-math-crop").getBoundingClientRect().width)[0];
    row.closest(".oi-pdf-display-math").dataset.oiProbe = "wide-formula";
    const flow = document.getElementById("readerFlow");
    flow.style.setProperty("width", "280px", "important");
    flow.style.setProperty("max-width", "280px", "important");
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);
  const readNarrow = `(() => {
    const host = document.querySelector('[data-oi-probe="wide-formula"]');
    const flow = document.getElementById("readerFlow");
    const pane = document.getElementById("translateScroll");
    const crop = host?.querySelector(".oi-pdf-math-crop");
    const scroll = host?.querySelector(".oi-pdf-math-scroll");
    if (!host || !crop || !scroll) return null;
    const box = crop.getBoundingClientRect();
    const flowBox = flow.getBoundingClientRect();
    const scrollBox = scroll.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      scrollWidth: scroll.scrollWidth,
      clientWidth: scroll.clientWidth,
      flowWidth: flowBox.width,
      paneScroll: pane.scrollWidth,
      paneClient: pane.clientWidth,
      hostScroll: host.scrollWidth,
      scrollOutset: Math.max(flowBox.left - scrollBox.left, scrollBox.right - flowBox.right, 0)
    };
  })()`;
  let narrow = null;
  const narrowBy = Date.now() + 8000;
  while (Date.now() < narrowBy) {
    await sleep(50);
    narrow = await evaluate(readNarrow);
    if (narrow && narrow.width < wide.widest.width - 20 && narrow.flowWidth < 300) break;
  }
  assert.ok(narrow, "narrowed formula was not measured");
  const expectedW = wide.widest.width * floor;
  const expectedH = wide.widest.height * floor;
  assert.ok(narrow.flowWidth >= 276 && narrow.flowWidth <= 284, `column ${narrow.flowWidth}`);
  assert.ok(Math.abs(narrow.width - expectedW) <= Math.max(8, expectedW * 0.05), `width ${narrow.width} vs floor ${expectedW} (${floor})`);
  assert.ok(Math.abs(narrow.height - expectedH) <= Math.max(4, expectedH * 0.05), `height ${narrow.height} vs floor ${expectedH}`);
  assert.ok(narrow.width > narrow.clientWidth + 8, `crop ${narrow.width} should exceed the scrollport ${narrow.clientWidth}`);
  assert.ok(narrow.scrollWidth > narrow.clientWidth + 16, `scroll ${narrow.scrollWidth} vs ${narrow.clientWidth}`);
  assert.ok(narrow.clientWidth <= narrow.flowWidth + 1, `scrollport ${narrow.clientWidth} wider than the column ${narrow.flowWidth}`);
  assert.ok(narrow.scrollOutset <= 1, `formula box left the column by ${narrow.scrollOutset}px`);
  assert.ok(narrow.hostScroll <= narrow.flowWidth + 2, `formula box widened the column ${narrow.hostScroll} > ${narrow.flowWidth}`);
  assert.ok(narrow.paneScroll <= narrow.paneClient + 4, `formula widened the pane ${narrow.paneScroll} > ${narrow.paneClient}`);
});
