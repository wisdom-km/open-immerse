// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// arXiv v7 (15 pages), https://arxiv.org/pdf/1706.03762v7
// sha256 is locked in tests/fixtures/pdf-blocks/attention-boundaries.json
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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

function launchChrome(userDataDir) {
  return new Promise((resolveChrome, reject) => {
    const child = spawn("google-chrome", [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,900",
      "about:blank"
    ], { stdio: ["ignore", "pipe", "pipe"] });
    let buf = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Chrome did not open a debugging port\n${buf.slice(-800)}`));
    }, 20000);
    const onData = (chunk) => {
      buf += chunk.toString();
      const match = buf.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (!match || settled) return;
      settled = true;
      clearTimeout(timer);
      resolveChrome({ child, port: Number(match[1]) });
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Chrome exited ${code}\n${buf.slice(-800)}`));
    });
  });
}

function openSocket(url) {
  return new Promise((resolveSocket, reject) => {
    const ws = new WebSocket(url);
    const fail = () => reject(new Error(`websocket failed for ${url}`));
    ws.addEventListener("open", () => resolveSocket(ws));
    ws.addEventListener("error", fail);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener("message", (event) => {
      const raw = typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8");
      const message = JSON.parse(raw);
      if (message.id && this.pending.has(message.id)) {
        const { resolve: done, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
        else done(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((done, reject) => {
      this.pending.set(id, { resolve: done, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

test("Attention arXiv v7 two-digit capsules stay on one line inside the box", { timeout: 180000 }, async () => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  const server = await serveRepo();
  const userDataDir = mkdtempSync(join(tmpdir(), "oi-capsule-chrome-"));
  let chrome = null;
  let ws = null;
  try {
    const address = server.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
    const viewer = `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}`;
    chrome = await launchChrome(userDataDir);
    const version = await fetch(`http://127.0.0.1:${chrome.port}/json/version`).then((res) => res.json());
    ws = await openSocket(version.webSocketDebuggerUrl);
    const cdp = new Cdp(ws);
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

    const measureExpr = `(() => {
      const cap = document.getElementById("pageCapsule");
      if (!cap || cap.hidden) return null;
      const box = cap.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return null;
      const range = document.createRange();
      range.selectNodeContents(cap);
      const textBox = range.getBoundingClientRect();
      const style = getComputedStyle(cap);
      return {
        text: cap.textContent || "",
        page: cap.dataset.srcPage || "",
        scrollHeight: cap.scrollHeight,
        clientHeight: cap.clientHeight,
        scrollWidth: cap.scrollWidth,
        clientWidth: cap.clientWidth,
        textLeft: textBox.left,
        textRight: textBox.right,
        textTop: textBox.top,
        textBottom: textBox.bottom,
        boxLeft: box.left,
        boxRight: box.right,
        boxTop: box.top,
        boxBottom: box.bottom,
        whiteSpace: style.whiteSpace,
        fontSize: getComputedStyle(document.getElementById("aaFontValue") || document.body).fontSize
      };
    })()`;

    await waitFor(measureExpr, "page 1 capsule");
    for (let page = 2; page <= 15; page += 1) {
      await evaluate(`document.getElementById("next").click()`);
      const measured = await waitFor(`(() => {
        const row = ${measureExpr};
        return row && Number(row.page) === ${page} ? row : null;
      })()`, `capsule for page ${page}`);
      if (page < 10) continue;
      assert.equal(measured.whiteSpace, "nowrap", `${measured.text} white-space`);
      assert.match(measured.text, new RegExp(`第\\s*${page}\\s*页`), measured.text);
      assert.ok(measured.scrollHeight <= measured.clientHeight + 1,
        `${measured.text} wraps: scrollHeight ${measured.scrollHeight} > clientHeight ${measured.clientHeight}`);
      assert.ok(measured.scrollWidth <= measured.clientWidth + 1,
        `${measured.text} overflows width: scrollWidth ${measured.scrollWidth} > clientWidth ${measured.clientWidth}`);
      assert.ok(measured.textLeft >= measured.boxLeft - 1 && measured.textRight <= measured.boxRight + 1,
        `${measured.text} draws outside the capsule horizontally (${measured.textLeft.toFixed(1)}–${measured.textRight.toFixed(1)} vs ${measured.boxLeft.toFixed(1)}–${measured.boxRight.toFixed(1)})`);
      assert.ok(measured.textTop >= measured.boxTop - 1 && measured.textBottom <= measured.boxBottom + 1,
        `${measured.text} draws outside the capsule vertically`);
    }
  } finally {
    if (ws) ws.close();
    if (chrome?.child) chrome.child.kill("SIGKILL");
    server.close();
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
