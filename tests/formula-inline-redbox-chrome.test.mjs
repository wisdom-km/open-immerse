// Headless Chrome renders DPO page 4 and DDPM page 4. The PNG that would be
// sent for an inline formula must contain a red box around that formula.
// A display formula on the same page must not.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

installOwnedTmpGuard(["oi-redbox-chrome-", "com.google.Chrome.", ".com.google.Chrome."]);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
const PAPERS = [
  ["DPO", "Direct_Preference_Optimization_2305.18290.pdf"],
  ["DDPM", "DDPM_2006.11239.pdf"]
];

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

  send(method, params = {}, sessionId, timeout = 180000) {
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

function assertRedBox(name, row) {
  assert.equal(row.mode, "context", `${name} ${row.id} was not a context crop`);
  assert.equal(row.scale, 4, `${name} ${row.id} scale`);
  assert.ok(row.width > 8 && row.height > 8, `${name} ${row.id} png`);
  assert.ok(row.count > 20, `${name} ${row.id} red pixels ${row.count}`);
  assert.ok(row.bands.top > 0 && row.bands.bottom > 0 && row.bands.left > 0 && row.bands.right > 0,
    `${name} ${row.id} red pixels are not a box`);
  const [x, y] = row.center || [];
  assert.ok(Number.isFinite(x) && Number.isFinite(y), `${name} ${row.id} missing target`);
  assert.ok(x > row.minX + 2 && x < row.maxX - 2 && y > row.minY + 2 && y < row.maxY - 2,
    `${name} ${row.id} target center ${x.toFixed(1)},${y.toFixed(1)} is outside the red box ${row.minX}-${row.maxX},${row.minY}-${row.maxY}`);
}

// Runs in the page. Measures the request PNG; the pixels never come back to Node.
async function measureRequestImages() {
  const dump = await window.__oiInlineVisionCrops(4);
  const measure = async (row) => {
    const response = await fetch(row.image);
    const bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    const data = image.data;
    const width = image.width;
    const height = image.height;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    let count = 0;
    const redAt = (index) => data[index + 3] > 200 && data[index] > 180 && data[index + 1] < 40 && data[index + 2] < 40;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = (y * width + x) * 4;
        if (!redAt(index)) continue;
        count += 1;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    const bands = { top: 0, bottom: 0, left: 0, right: 0 };
    if (count) {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const index = (y * width + x) * 4;
          if (!redAt(index)) continue;
          if (y <= minY + 4) bands.top += 1;
          if (y >= maxY - 4) bands.bottom += 1;
          if (x <= minX + 4) bands.left += 1;
          if (x >= maxX - 4) bands.right += 1;
        }
      }
    }
    const mark = (row.glyphs && row.glyphs[0]) || row.target;
    let center = null;
    if (mark && row.crop && row.crop[2] > row.crop[0] && row.crop[3] > row.crop[1]) {
      center = [
        (((mark[0] + mark[2]) / 2) - row.crop[0]) / (row.crop[2] - row.crop[0]) * width,
        (((mark[1] + mark[3]) / 2) - row.crop[1]) / (row.crop[3] - row.crop[1]) * height
      ];
    }
    bitmap.close();
    return {
      id: row.id,
      inline: row.inline === true,
      mode: row.mode,
      scale: row.scale,
      width,
      height,
      count,
      minX,
      minY,
      maxX,
      maxY,
      bands,
      center
    };
  };
  const rows = [];
  for (const row of dump?.formulas || []) rows.push(await measure(row));
  return { dpr: dump?.dpr, rows };
}

test("Chrome DPO p4 and DDPM p4 inline request images box the formula in red", { timeout: 300000 }, async (t) => {
  const missing = PAPERS.filter(([, file]) => !existsSync(join(root, "tests/fixtures", file)));
  if (missing.length) {
    t.skip(`missing ${missing.map(([name]) => name).join(", ")}; gitignored arXiv PDFs are local only`);
    return;
  }
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-redbox-chrome-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const child = launchChrome(userDataDir, scratchDir);
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
    const origin = `http://127.0.0.1:${server.address().port}`;
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
    for (const [name, file] of PAPERS) {
      const src = `${origin}/tests/fixtures/${file}`;
      await send("Page.navigate", {
        url: `${origin}/pdf/viewer.html?oiAuto=probe&src=${encodeURIComponent(src)}`
      });
      const started = Date.now();
      let hook = false;
      while (Date.now() - started < 90000) {
        hook = await evaluate(`typeof window.__oiInlineVisionCrops === "function"`);
        if (hook === true) break;
        await sleep(300);
      }
      assert.equal(hook, true, `${name} viewer test hook`);
      for (const page of [1, 2, 3, 4]) {
        await evaluate(`window.__oiOpenPage(${page})`, 180000);
      }
      const dump = await evaluate(`(${measureRequestImages.toString()})()`, 180000);
      const inline = (dump?.rows || []).filter((row) => row.inline);
      const display = (dump?.rows || []).filter((row) => !row.inline);
      assert.ok(inline.length >= 1, `${name} page 4 has no inline formula`);
      for (const row of inline) assertRedBox(name, row);
      assert.equal(display.length, 1, `${name} display sample`);
      assert.equal(display[0].mode, "tight");
      assert.equal(display[0].count, 0, `${name} display crop contains red`);
    }
  } catch (error) {
    await close();
    throw error;
  }
  await close();
});
