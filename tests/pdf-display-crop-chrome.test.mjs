// Chrome paints DDPM page 4 as p4-b46 / p4-b47. The offline harness numbers
// those formulas p4-b43 / p4-b44, and its raster leaves a 3px gap where
// Chrome leaves 2px. This test opens the viewer and checks the bitmap the
// page actually shows.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

installOwnedTmpGuard(["oi-crop-chrome-", "com.google.Chrome.", ".com.google.Chrome."]);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const require = createRequire(import.meta.url);
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
      if (!res.headersSent) res.writeHead(404);
      res.end();
    }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

function launchChrome(userDataDir, scratchDir, dpr) {
  const child = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900",
    `--force-device-scale-factor=${dpr}`,
    "--no-first-run",
    "--no-default-browser-check"
  ], {
    detached: true,
    env: { ...process.env, TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir },
    stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
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
      let message;
      try { message = JSON.parse(text); } catch { continue; }
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.done(message.result);
      }
    }
  }

  dispose() {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  send(method, params = {}, sessionId, timeout = 120000) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const body = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function covers(crop, box, slop) {
  return crop[1] <= box[1] + slop && crop[3] >= box[3] - slop;
}

function darkIn(image, x0, x1, y0, y1) {
  const width = image.width;
  const data = image.data;
  let dark = 0;
  const left = Math.max(0, Math.floor(x0));
  const right = Math.min(width, Math.ceil(x1));
  const top = Math.max(0, Math.floor(y0));
  const bottom = Math.min(image.height, Math.ceil(y1));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] < 16) continue;
      if (data[index] < 200 || data[index + 1] < 200 || data[index + 2] < 200) dark += 1;
    }
  }
  return dark;
}

function imageRect(crop, box, width, height) {
  const spanX = crop[2] - crop[0];
  const spanY = crop[3] - crop[1];
  return [
    (box[0] - crop[0]) / spanX * width,
    (box[1] - crop[1]) / spanY * height,
    (box[2] - crop[0]) / spanX * width,
    (box[3] - crop[1]) / spanY * height
  ];
}

async function decodePng(url) {
  const { createCanvas, loadImage } = require("@napi-rs/canvas");
  const bytes = Buffer.from(String(url || "").replace(/^data:image\/png;base64,/, ""), "base64");
  const img = await loadImage(bytes);
  const canvas = createCanvas(img.width, img.height);
  const context = canvas.getContext("2d");
  context.drawImage(img, 0, 0);
  return context.getImageData(0, 0, img.width, img.height);
}

async function openDump(t, dpr) {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-crop-chrome-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const child = launchChrome(userDataDir, scratchDir, dpr);
  const cdp = new PipeCdp(child.stdio[3], child.stdio[4]);
  const close = async () => {
    try { cdp.dispose(); } finally {
      await cleanupChrome({ t, child, server, ownedDir, userDataDir });
    }
  };
  try {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params, timeout) => cdp.send(method, params, sessionId, timeout);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: dpr,
    mobile: false
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const src = `${origin}/tests/fixtures/DDPM_2006.11239.pdf`;
  await send("Page.navigate", {
    url: `${origin}/pdf/viewer.html?oiAuto=probe&src=${encodeURIComponent(src)}`
  });
  const evaluate = async (expression, timeout = 180000) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, timeout);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const started = Date.now();
  let hook = false;
  while (Date.now() - started < 90000) {
    hook = await evaluate(`typeof window.__oiOpenPage === "function"`);
    if (hook === true) break;
    await sleep(300);
  }
  assert.equal(hook, true, "viewer test hook");
  for (const page of [1, 2, 3, 4]) {
    await evaluate(`window.__oiOpenPage(${page})`, 180000);
  }
  const dump = await evaluate(`window.__oiFormulaDump(4)`, 180000);
  assert.equal(dump?.dpr, dpr);
  return { dump, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function assertProductLimit(t, dpr) {
  const opened = await openDump(t, dpr);
  const dump = opened.dump;
  try {
  const product = (dump.formulas || []).find((row) => row.id === "p4-b46");
  const cases = (dump.formulas || []).find((row) => row.id === "p4-b47");
  assert.ok(product, `DPR ${dpr} viewer did not build p4-b46`);
  assert.ok(cases, `DPR ${dpr} viewer did not build p4-b47`);
  assert.equal(cases.eq, "(13)");
  const symbol = (dump.items || []).find((item) => item.str === "∏");
  assert.ok(symbol, "product symbol in the text layer");
  const symbolMid = (symbol.box[1] + symbol.box[3]) / 2;
  assert.ok(symbolMid >= product.bbox[1] && symbolMid <= product.bbox[3], "p4-b46 is the product line");
  const limits = (dump.items || []).filter((item) => {
    if (item.str !== "i" && item.str !== "=1" && item.str !== "δ" && item.str !== "−") return false;
    const midX = (item.box[0] + item.box[2]) / 2;
    return midX >= symbol.box[0] - 0.005 && midX <= symbol.box[2] + 0.08 &&
      item.box[1] >= symbol.box[3] - 0.002 && item.box[3] <= symbol.box[3] + 0.04;
  });
  assert.ok(limits.some((item) => item.str === "=1"), "text-layer subscript i=1");
  assert.ok(limits.some((item) => item.str === "δ"), "text-layer integral lower limit");
  const slop = 0.002;
  for (const item of limits) {
    assert.ok(
      covers(product.bbox, item.box, slop),
      `DPR ${dpr} p4-b46 cut ${JSON.stringify(item.str)} ${item.box[1].toFixed(4)}-${item.box[3].toFixed(4)} crop ${product.bbox[1].toFixed(4)}-${product.bbox[3].toFixed(4)}`
    );
    assert.ok(
      cases.bbox[1] >= item.box[3] - slop,
      `DPR ${dpr} p4-b47 still shows ${JSON.stringify(item.str)} (crop top ${cases.bbox[1].toFixed(4)}, glyph bottom ${item.box[3].toFixed(4)})`
    );
  }
  const tag = (dump.items || []).find((item) => String(item.str).includes("(13)"));
  assert.ok(tag, "equation tag (13)");
  assert.ok(cases.bbox[1] > tag.box[3] - slop, `DPR ${dpr} kept (13) inside the cases crop`);
  const caseRows = (dump.items || []).filter((item) => {
    if (item.str !== "if") return false;
    return item.box[3] > tag.box[3] && item.box[3] < tag.box[3] + 0.05;
  });
  assert.ok(caseRows.length >= 2, "both case rows");
  for (const item of caseRows) {
    assert.ok(
      cases.bbox[1] <= item.box[3] && cases.bbox[3] >= item.box[3],
      `DPR ${dpr} cut a cases row at ${item.box[3].toFixed(4)}`
    );
  }
  const subscript = limits.find((item) => item.str === "=1");
  const productImage = await decodePng(product.image);
  const mapped = imageRect(product.bbox, subscript.box, productImage.width, productImage.height);
  const lowerTop = (mapped[1] + mapped[3]) / 2;
  const lowerInk = darkIn(productImage, mapped[0], mapped[2], lowerTop, mapped[3]);
  assert.ok(lowerInk > 0, `DPR ${dpr} p4-b46 image is missing the lower half of i=1`);
  const casesImage = await decodePng(cases.image);
  const foreign = imageRect(cases.bbox, subscript.box, casesImage.width, casesImage.height);
  const overlapTop = Math.max(0, foreign[1]);
  const overlapBottom = Math.min(casesImage.height, foreign[3]);
  if (overlapBottom > overlapTop) {
    const stray = darkIn(casesImage, foreign[0], foreign[2], overlapTop, overlapBottom);
    assert.equal(stray, 0, `DPR ${dpr} p4-b47 top still has ${stray} subscript pixels`);
  }
  } finally {
    await opened.close();
  }
}

test("Chrome DDPM p4 b46 keeps i=1 and b47 does not, at DPR 1 and DPR 2", { timeout: 180000 }, async (t) => {
  const pdf = join(root, "tests/fixtures/DDPM_2006.11239.pdf");
  if (!existsSync(pdf)) {
    t.skip("tests/fixtures/DDPM_2006.11239.pdf is gitignored and is not committed. scripts/ci/fetch-fixtures.sh leaves it absent on purpose.");
    return;
  }
  await assertProductLimit(t, 1);
  await assertProductLimit(t, 2);
});
