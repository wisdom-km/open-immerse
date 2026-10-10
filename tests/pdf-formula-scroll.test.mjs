// A synthetic wide formula in a narrow column. Real DPO's widest display is
// 401pt and the narrowest column is 476px, so the floor-then-scroll path
// never runs on that paper.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
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
