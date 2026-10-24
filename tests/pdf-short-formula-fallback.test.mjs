// Short inline formulas used to miss the 24×12 crop floor and paint
// 「（公式见左栏）」. The crop scale lifts just enough to clear that floor.
// A short sourceText is the reader fallback when the bitmap has no ink.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { CROP_SCALE, rasterCropRect } from "../lib/pdf-blocks.js";
import { attachFontRealNames } from "../lib/pdf-mirror.js";
import { PDF_COPY } from "../lib/pdf-viewer.js";
import {
  FORMULA_INK_MIN_SPAN,
  imageInkRatio,
  inlineShortCropScale,
  isInlineFormulaBlock,
  shortInlineFormulaLabel
} from "../lib/pdf-formula-raster.js";
import { blankFormulaMask, boxesInCrop, measureFormulaCrop, textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PREFIXES = ["oi-short-formula-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dpoRel = "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf";
const ddpmRel = "tests/fixtures/DDPM_2006.11239.pdf";
const fallback = PDF_COPY.formulaFallback;

/** Optional PNG dir. Unset uses the temp dir. An unwritable path is skipped. */
function formulaShotDir() {
  const requested = String(process.env.OI_FORMULA_SHOT_DIR || "").trim();
  return requested || join(tmpdir(), "oi-short-formula-shots");
}

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

test("DPO and DDPM short inline blocks crop or show source text", { timeout: 600000 }, async (t) => {
  const papers = [
    ["DPO", join(root, dpoRel)],
    ["DDPM", join(root, ddpmRel)]
  ];
  const missing = papers.filter(([, path]) => !existsSync(path));
  if (missing.length === papers.length) {
    t.skip(`missing ${dpoRel}`);
    return;
  }
  let createCanvas;
  try {
    ({ createCanvas } = createRequire(import.meta.url)("@napi-rs/canvas"));
  } catch {
    t.skip("@napi-rs/canvas is not installed; the short-crop ink check did not run");
    return;
  }
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const present = papers.filter(([, path]) => existsSync(path));
  const skipped = missing.map(([name, path]) => `${name} (${path.slice(root.length + 1)})`);
  const reports = [];
  for (const [paperName, pdfPath] of present) {
    reports.push(await scanPaper(paperName, pdfPath, createCanvas));
  }
  const failures = reports.flatMap((report) => report.failures);
  const summary = reports.map((report) => (
    `${report.paper}: inline ${report.inline} below-floor ${report.below} crop ${report.crop} text ${report.text}`
  )).join("; ");
  console.log(summary);
  assert.deepEqual(failures, [], `${summary}; ${skipped.join(", ")}`);
  const dpo = reports.find((report) => report.paper === "DPO");
  const ddpm = reports.find((report) => report.paper === "DDPM");
  assert.ok(dpo, "DPO fixture did not scan");
  assert.ok(dpo.below > 0, "DPO produced no below-floor inline formulas");
  const dpoPitheta = dpo.rows.find((row) => row.id === "p4-b4");
  assert.ok(dpoPitheta, `DPO p4-b4 missing; page 4 formulas ${dpo.page4.join(" | ")}`);
  assert.match(dpoPitheta.source, /π/);
  assert.match(dpoPitheta.source, /θ/);
  assert.equal(dpoPitheta.fallback, false);
  assertNamed(dpo, [
    ["πθ", /πθ/],
    ["rˆθ", /r\u02C6θ/]
  ]);
  if (!ddpm) {
    assert.ok(skipped.some((line) => line.includes(ddpmRel)), skipped.join(", ") || ddpmRel);
    return;
  }
  assert.ok(ddpm.below > 0, "DDPM produced no below-floor inline formulas");
  assertNamed(ddpm, [
    ["xˆ0", /x\u02C60/],
    ["x′t", /x\u2032t/],
    // The text layer stores this epsilon as U+000F, not U+03B5.
    ["εθ", /\u000fθ|εθ/],
    ["μ˜t", /μ\u02DCt/]
  ]);
  assert.equal(reports.every((report) => report.failures.length === 0), true, summary);
});

function assertNamed(report, patterns) {
  for (const [name, pattern] of patterns) {
    const hit = report.all.find((row) => pattern.test(row.source));
    assert.ok(hit, `${report.paper} missing ${name}; sources ${report.all.map((row) => row.source).filter((text) => /[πθεμrxXtθ̂̃′']/.test(text)).slice(0, 24).join(" | ")}`);
    assert.equal(hit.fallback, false, `${report.paper} ${hit.id} ${name} would show ${fallback}`);
  }
}

async function scanPaper(paperName, pdfPath, createCanvas) {
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const rows = [];
  const all = [];
  const failures = [];
  const page4 = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const ops = await pdfPage.getOperatorList();
      attachFontRealNames(content.items, pdfPage.commonObjs);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const built = textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      const pixelWidth = Math.max(1, Math.floor(viewport.width * CROP_SCALE));
      const pixelHeight = Math.max(1, Math.floor(viewport.height * CROP_SCALE));
      const canvas = createCanvas(pixelWidth, pixelHeight);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pixelWidth, pixelHeight);
      await pdfPage.render({
        canvasContext: context,
        viewport: pdfPage.getViewport({ scale: CROP_SCALE })
      }).promise;
      const image = context.getImageData(0, 0, pixelWidth, pixelHeight);
      for (const block of built.blocks) {
        if (!isInlineFormulaBlock(block) || !Array.isArray(block.bbox)) continue;
        const measured = measureFormulaCrop(block.bbox, image, {
          inline: true,
          protect: block.formulaInkProtect === true,
          maskBoxes: block.maskBoxes,
          glyphBoxes: block.glyphBoxes
        });
        const bbox = measured?.bbox || block.bbox;
        const rect = rasterCropRect(bbox, pixelWidth, pixelHeight);
        const pdfW = (bbox[2] - bbox[0]) * viewport.width;
        const pdfH = (bbox[3] - bbox[1]) * viewport.height;
        const below = rect.sw < FORMULA_INK_MIN_SPAN.x || rect.sh < FORMULA_INK_MIN_SPAN.y;
        const label = shortInlineFormulaLabel(block);
        let cropOk = false;
        let scale = 0;
        if (below) {
          scale = inlineShortCropScale(pdfW, pdfH, {
            pageWidth: viewport.width,
            pageHeight: viewport.height,
            pixelWidth,
            pixelHeight
          });
          if (scale > 0) {
            const crop = await renderShortCrop(pdfPage, createCanvas, block, bbox, scale);
            cropOk = crop.pixelWidth >= FORMULA_INK_MIN_SPAN.x
              && crop.pixelHeight >= FORMULA_INK_MIN_SPAN.y
              && crop.ink > 0;
          }
        }
        const rescued = !below || cropOk || Boolean(label);
        const row = {
          id: block.id,
          page: number,
          source: String(block.sourceText || ""),
          sw: rect.sw,
          sh: rect.sh,
          scale,
          cropOk,
          label,
          below,
          fallback: !rescued || (label && label.includes("公式见左栏")) || String(block.sourceText || "").includes(fallback)
        };
        all.push(row);
        if (number === 4 && block.label === "formula") page4.push(`${block.id}:${row.source}`);
        if (!below) continue;
        rows.push(row);
        if (row.fallback || !rescued) {
          failures.push(`${paperName} ${block.id} ${rect.sw}×${rect.sh} scale ${scale} crop ${cropOk} label ${JSON.stringify(label)} source ${JSON.stringify(row.source)}`);
        }
      }
    }
  } finally {
    await doc.destroy();
  }
  return {
    paper: paperName,
    inline: all.length,
    below: rows.length,
    crop: rows.filter((row) => row.cropOk).length,
    text: rows.filter((row) => !row.cropOk && row.label).length,
    rows,
    all,
    failures,
    page4
  };
}

async function renderShortCrop(pdfPage, createCanvas, block, bbox, scale) {
  const unit = pdfPage.getViewport({ scale: 1 });
  const pdfW = (bbox[2] - bbox[0]) * unit.width;
  const pdfH = (bbox[3] - bbox[1]) * unit.height;
  const pixelWidth = Math.max(1, Math.round(pdfW * scale));
  const pixelHeight = Math.max(1, Math.round(pdfH * scale));
  const full = pdfPage.getViewport({ scale });
  const viewport = pdfPage.getViewport({
    scale,
    offsetX: -(Number(bbox[0]) || 0) * full.width,
    offsetY: -(Number(bbox[1]) || 0) * full.height
  });
  const canvas = createCanvas(pixelWidth, pixelHeight);
  const context = canvas.getContext("2d");
  await pdfPage.render({ canvasContext: context, viewport }).promise;
  context.save();
  context.globalCompositeOperation = "destination-over";
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, pixelWidth, pixelHeight);
  context.restore();
  const image = context.getImageData(0, 0, pixelWidth, pixelHeight);
  if (block.maskBoxes?.length) {
    blankFormulaMask(image, {
      maskBoxes: boxesInCrop(block.maskBoxes, bbox),
      glyphBoxes: boxesInCrop(block.glyphBoxes, bbox),
      seedBoxes: boxesInCrop(block.seedBoxes, bbox)
    });
    context.putImageData(image, 0, 0);
  }
  return {
    pixelWidth,
    pixelHeight,
    ink: imageInkRatio(image)
  };
}

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
    this.readStream.on("data", (chunk) => {
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

const handle = { child: null, cdp: null, server: null, ownedDir: null, userDataDir: null, evaluate: null, send: null };

function layoutProbe() {
  return `(() => {
    const root = document.documentElement;
    const flow = document.getElementById("readerFlow");
    const slots = [...(flow ? flow.querySelectorAll(":scope > .rf-page") : [])];
    const pages = slots.map((slot) => ({
      page: slot.dataset.page || "",
      painted: slot.dataset.painted || "",
      state: slot.dataset.state || "",
      blocks: slot.querySelectorAll(".rf-block").length
    }));
    const crops = [...(flow ? flow.querySelectorAll("img.oi-pdf-math-crop, img.oi-pdf-asset-crop") : [])];
    const pending = crops.filter((img) => !img.complete || !(img.naturalWidth > 0)).length;
    return {
      fonts: document.fonts?.status || "loaded",
      crop: root?.dataset.oiFormulaCrop || "idle",
      anchor: root?.dataset.oiFontAnchor || "idle",
      nav: root?.dataset.oiPageNav || "idle",
      pending,
      pages,
      label: document.getElementById("sourcePageLabel")?.textContent || ""
    };
  })()`;
}

function slotReady(slot) {
  return Boolean(slot) && slot.painted === "1" && slot.state !== "layout" && slot.state !== "running" && slot.blocks > 0;
}

async function waitForPage(page, timeout = 120000) {
  const started = Date.now();
  let sample = null;
  while (Date.now() - started < timeout) {
    sample = await handle.evaluate(layoutProbe());
    const ready = sample
      && sample.fonts === "loaded"
      && sample.crop === "idle"
      && sample.anchor === "idle"
      && sample.nav === "idle"
      && sample.pending === 0
      && String(sample.label).startsWith(`${page} /`)
      && slotReady((sample.pages || []).find((item) => Number(item.page) === page));
    if (ready) return sample;
    await new Promise((done) => setTimeout(done, 200));
  }
  throw new Error(`page ${page} did not paint (${JSON.stringify(sample)})`);
}

async function openPdf(origin, pdfRel) {
  await handle.send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(`${origin}/${pdfRel}`)}` });
  await waitForPage(1);
}

async function goToPage(page) {
  for (let n = 2; n <= page; n += 1) {
    const clicked = await handle.evaluate(`(() => {
      const next = document.getElementById("sourceNext");
      if (!next || next.disabled) return false;
      next.click();
      return true;
    })()`);
    assert.equal(clicked, true, `stuck before page ${n}`);
    await waitForPage(n);
  }
}

function saveShot(name, data) {
  if (!name || !data) return "";
  const dir = formulaShotDir();
  try {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, Buffer.from(data, "base64"));
    return file;
  } catch {
    return "";
  }
}

test("an empty crop shows short source text and keeps the fallback string otherwise", () => {
  const shown = (formula) => shortInlineFormulaLabel(formula) || fallback;
  const inline = { label: "formula", display: false, inlineOf: "p4-b3", imageUrl: "" };
  assert.equal(shown({ ...inline, sourceText: "πθ" }), "πθ");
  assert.equal(shown({ ...inline, sourceText: "rˆθ" }), "rˆθ");
  assert.equal(shown({
    ...inline,
    sourceText: "r(x, y) = rϕ(x, y) − β(logπθ(y | x) − logπref(y | x))"
  }), fallback);
  assert.equal(shown({ label: "formula", display: true, sourceText: "πθ", imageUrl: "" }), fallback);
  assert.equal(shown({ ...inline, sourceText: "" }), fallback);
  assert.equal(shown({ ...inline, sourceText: "πθ\nnext" }), fallback);
  assert.equal(fallback.includes("公式见左栏"), true);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const paint = viewer.slice(
    viewer.indexOf("function paintRenderPieces"),
    viewer.indexOf("function unitsForLayout")
  );
  assert.match(paint, /shortInlineFormulaLabel\(formula\)/);
  assert.match(paint, /label \|\| PDF_COPY\.formulaFallback/);
});

test("shot files stay out of /opt unless asked, and an unwritable dir is skipped", () => {
  const previous = process.env.OI_FORMULA_SHOT_DIR;
  // A file where a directory should be. recursive mkdir throws ENOTDIR.
  // Do not use /proc here: mkdirSync(recursive) on /proc never returns.
  const blocked = join(tmpdir(), `oi-short-formula-blocked-${process.pid}`);
  delete process.env.OI_FORMULA_SHOT_DIR;
  try {
    assert.equal(formulaShotDir().startsWith(tmpdir()), true);
    assert.equal(formulaShotDir().startsWith("/opt"), false);
    writeFileSync(blocked, "");
    process.env.OI_FORMULA_SHOT_DIR = join(blocked, "shots");
    assert.equal(saveShot("n1.png", Buffer.from("png").toString("base64")), "");
    assert.equal(existsSync(join(blocked, "shots")), false);
  } finally {
    rmSync(blocked, { force: true });
    if (previous == null) delete process.env.OI_FORMULA_SHOT_DIR;
    else process.env.OI_FORMULA_SHOT_DIR = previous;
  }
});

describe("DPO page 4 block p4-b4 does not show the formula fallback", () => {
  before(async () => {
    assert.equal(existsSync(join(root, dpoRel)), true, `${dpoRel} is missing`);
    handle.server = await serveRepo();
    handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-short-formula-"));
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
    handle.send = send;
    await send("Page.enable");
    await send("Runtime.enable");
    await send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        try { localStorage.setItem("reader.follow", "0"); } catch {}
        const nativeFetch = globalThis.fetch;
        if (typeof nativeFetch === "function") {
          globalThis.fetch = function(input, init) {
            const url = typeof input === "string" ? input : (input && input.url) || "";
            if (String(url).includes(":8765/")) return Promise.reject(new TypeError("library unavailable"));
            return nativeFetch.call(this, input, init);
          };
        }
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
    handle.evaluate = async (expression, timeoutMs = 60000) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails;
        throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
      }
      return result.result?.value;
    };
    const origin = `http://127.0.0.1:${handle.server.address().port}`;
    handle.origin = origin;
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await openPdf(origin, dpoRel);
    await goToPage(4);
  }, { timeout: 600000 });

  after(async (t) => {
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

  test("p4-b4 renders as an image at least 24 by 12", async () => {
    const probe = await handle.evaluate(`(() => {
      const fallback = ${JSON.stringify(fallback)};
      const spans = [...document.querySelectorAll("#readerFlow .oi-pdf-inline-math")];
      const bad = spans.filter((span) => (span.textContent || "").includes("公式见左栏") || (span.textContent || "").includes(fallback)).map((span) => span.dataset.blockId || "");
      const span = document.querySelector('#readerFlow .oi-pdf-inline-math[data-block-id="p4-b4"]');
      if (!span) return { bad, missing: true, ids: spans.map((node) => node.dataset.blockId || "").filter((id) => id.startsWith("p4-")) };
      const img = span.querySelector("img.oi-pdf-math-crop");
      return {
        bad,
        missing: false,
        text: span.textContent || "",
        alt: img ? img.alt || "" : "",
        src: img ? String(img.currentSrc || img.src || "").slice(0, 32) : "",
        naturalWidth: img ? img.naturalWidth : 0,
        naturalHeight: img ? img.naturalHeight : 0
      };
    })()`);
    assert.ok(probe && !probe.missing, `p4-b4 missing (${(probe?.ids || []).join(",")})`);
    assert.deepEqual(probe.bad, []);
    assert.equal(probe.text.includes("公式见左栏"), false);
    assert.equal(probe.text.includes(fallback), false);
    assert.equal(probe.alt.includes(fallback), false);
    assert.equal(probe.src.startsWith("data:image"), true, JSON.stringify(probe));
    assert.ok(probe.naturalWidth >= FORMULA_INK_MIN_SPAN.x, JSON.stringify(probe));
    assert.ok(probe.naturalHeight >= FORMULA_INK_MIN_SPAN.y, JSON.stringify(probe));
    const shot = await captureBlock('#readerFlow .oi-pdf-inline-math[data-block-id="p4-b4"]');
    if (shot) saveShot("n1-dpo-p4.png", shot);
  });

  test("DDPM page 8 short block is not the fallback string", async (t) => {
    if (!existsSync(join(root, ddpmRel))) {
      t.skip(`missing ${ddpmRel}; gitignored arXiv PDF is not in the repo`);
      return;
    }
    await openPdf(handle.origin, ddpmRel);
    await goToPage(8);
    const probe = await handle.evaluate(`(() => {
      const fallback = ${JSON.stringify(fallback)};
      const spans = [...document.querySelectorAll('#readerFlow .oi-pdf-inline-math')];
      const page8 = spans.filter((span) => (span.dataset.blockId || "").startsWith("p8-") || span.closest("[data-src-page='8'], [data-page='8']"));
      const bad = page8.filter((span) => (span.textContent || "").includes(fallback) || (span.textContent || "").includes("公式见左栏")).map((span) => ({
        id: span.dataset.blockId || "",
        text: span.textContent || ""
      }));
      const preferred = document.querySelector('#readerFlow .oi-pdf-inline-math[data-block-id="p8-b21"]')
        || page8.find((span) => /[′'\u2032]/.test(span.textContent || "") || span.querySelector("img"))
        || page8[0]
        || null;
      return {
        bad,
        count: page8.length,
        id: preferred?.dataset.blockId || "",
        text: preferred?.textContent || ""
      };
    })()`);
    assert.ok(probe.count > 0, "DDPM page 8 painted no inline formulas");
    assert.deepEqual(probe.bad, []);
    const selector = probe.id
      ? `#readerFlow .oi-pdf-inline-math[data-block-id="${probe.id}"]`
      : "#readerFlow .rf-page[data-page='8']";
    const shot = await captureBlock(selector);
    if (shot) saveShot("n1-ddpm-p8.png", shot);
  });
});

async function captureBlock(selector) {
  const box = await handle.evaluate(`(() => {
    const span = document.querySelector(${JSON.stringify(selector)});
    const host = span ? (span.closest(".rf-block") || span) : document.querySelector(${JSON.stringify(selector)});
    if (!host) return null;
    host.scrollIntoView({ block: "center", inline: "nearest" });
    const rect = host.getBoundingClientRect();
    const pad = 16;
    const x = Math.max(0, Math.floor(rect.x - pad));
    const y = Math.max(0, Math.floor(rect.y - pad));
    const width = Math.max(1, Math.min(window.innerWidth - x, Math.ceil(rect.width + pad * 2)));
    const height = Math.max(1, Math.min(window.innerHeight - y, Math.ceil(Math.max(rect.height + pad * 2, 96))));
    return { x, y, width, height };
  })()`);
  if (!box || !(box.width > 1) || !(box.height > 1)) return "";
  const shot = await handle.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
    clip: { x: box.x, y: box.y, width: box.width, height: box.height, scale: 2 }
  });
  return shot?.data || "";
}
