// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// arXiv v7 (15 pages), https://arxiv.org/pdf/1706.03762v7
// sha256 is locked in tests/fixtures/pdf-blocks/attention-boundaries.json
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

const CAPSULE_TMP_PREFIXES = ["oi-capsule-chrome-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(CAPSULE_TMP_PREFIXES);

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
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".map": "application/json"
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

test("Attention arXiv v7 capsules stay inside the content box on every page", { timeout: 180000 }, async (t) => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-capsule-chrome-"));
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
  const viewer = `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  }, sessionId);
  await cdp.send("Page.navigate", { url: viewer }, sessionId);

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

  const waitFor = async (expression, label, timeoutMs = 30000) => {
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

  await waitFor(`(() => {
    const pager = document.getElementById("pager")?.textContent || "";
    const next = document.getElementById("next");
    return /\\/\\s*15/.test(pager) && next && !next.disabled ? pager : "";
  })()`, "Attention PDF open");
  await waitFor(`document.querySelector("#readerFlow .rf-block[data-pair-id]") ? "p1" : ""`, "page 1 pairs");
  const openedFull = await evaluate(`document.querySelector(".scope-seg") ? "segment" : "all"`);
  assert.equal(openedFull, "all", "打开即默认全文，没有范围分段");

  const measureExpr = `(() => {
    const cap = document.getElementById("pageCapsule");
    if (!cap || cap.hidden) return null;
    const box = cap.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    const range = document.createRange();
    range.selectNodeContents(cap);
    const textBox = range.getBoundingClientRect();
    const style = getComputedStyle(cap);
    const px = (name) => {
      const value = parseFloat(style[name]);
      return Number.isFinite(value) ? value : 0;
    };
    return {
      text: cap.textContent || "",
      page: cap.dataset.srcPage || "",
      scrollHeight: cap.scrollHeight,
      clientHeight: cap.clientHeight,
      textLeft: textBox.left,
      textRight: textBox.right,
      textTop: textBox.top,
      textBottom: textBox.bottom,
      contentLeft: box.left + px("borderLeftWidth") + px("paddingLeft"),
      contentRight: box.right - px("borderRightWidth") - px("paddingRight"),
      contentTop: box.top + px("borderTopWidth") + px("paddingTop"),
      contentBottom: box.bottom - px("borderBottomWidth") - px("paddingBottom"),
      boxLeft: box.left,
      boxWidth: box.width,
      whiteSpace: style.whiteSpace
    };
  })()`;

  const pages = [];
  pages.push(await waitFor(`(() => {
    const row = ${measureExpr};
    return row && Number(row.page) === 1 ? row : null;
  })()`, "capsule for page 1"));
  for (let page = 2; page <= 15; page += 1) {
    await evaluate(`document.getElementById("next").click()`);
    pages.push(await waitFor(`(() => {
      const row = ${measureExpr};
      return row && Number(row.page) === ${page} ? row : null;
    })()`, `capsule for page ${page}`));
  }

  const slop = 0.5;
  for (const measured of pages) {
    const page = Number(measured.page);
    assert.equal(measured.whiteSpace, "nowrap", `${measured.text} white-space`);
    assert.match(measured.text, new RegExp(`第\\s*${page}\\s*页`), measured.text);
    assert.ok(measured.scrollHeight <= measured.clientHeight,
      `${measured.text} wraps: scrollHeight ${measured.scrollHeight} > clientHeight ${measured.clientHeight}`);
    assert.ok(measured.textLeft >= measured.contentLeft - slop && measured.textRight <= measured.contentRight + slop,
      `${measured.text} leaves the content box horizontally (${measured.textLeft.toFixed(2)}–${measured.textRight.toFixed(2)} vs ${measured.contentLeft.toFixed(2)}–${measured.contentRight.toFixed(2)})`);
    assert.ok(measured.textTop >= measured.contentTop - slop && measured.textBottom <= measured.contentBottom + slop,
      `${measured.text} leaves the content box vertically (${measured.textTop.toFixed(2)}–${measured.textBottom.toFixed(2)} vs ${measured.contentTop.toFixed(2)}–${measured.contentBottom.toFixed(2)})`);
  }
  const width = pages[0].boxWidth;
  const left = pages[0].boxLeft;
  for (const measured of pages) {
    assert.equal(measured.boxWidth, width, `page ${measured.page} capsule width`);
    assert.equal(measured.boxLeft, left, `page ${measured.page} capsule left`);
  }
});
