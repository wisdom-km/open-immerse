// Opens the viewer against the gitignored Attention fixture.
// tests/fixtures/Attention_Is_All_You_Need.pdf (sha256 bdfaa68d…df697)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const TMP_PREFIXES = ["oi-notes-probe-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const ATTENTION_SHA = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
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
  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => done(server));
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
    "--window-size=1280,800",
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

test("opening a PDF with no notes does not create oi-annotations; dead bids take alias and text", { timeout: 180000 }, async (t) => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  const digest = createHash("sha256").update(readFileSync(fixture)).digest("hex");
  assert.equal(digest, ATTENTION_SHA);

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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-notes-probe-"));
  rememberOwnedTemp(handle.ownedDir);
  const userDataDir = join(handle.ownedDir, "profile");
  const scratchDir = join(handle.ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  handle.userDataDir = userDataDir;
  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;

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
      globalThis.chrome = {
        storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
        runtime: {
          getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
          sendMessage(message) {
            if (message && message.type === "OI_GET_SETTINGS") {
              return Promise.resolve({ settings: { pdfAutoTranslate: false, targetLang: "zh-CN", pdfLayout: { mode: "" } } });
            }
            if (message && message.type === "OI_PDF_STRUCTURE") return Promise.resolve({ ok: false });
            return Promise.resolve({ ok: true });
          }
        }
      };
    })();`
  });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, 30000);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 40000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      try {
        last = await evaluate(expression);
      } catch (err) {
        if (!String(err?.message || err).includes("Inspected target navigated or closed")) throw err;
        last = null;
      }
      if (last) return last;
      await sleep(150);
    }
    const status = await evaluate(`document.getElementById("status")?.textContent || ""`).catch(() => "");
    throw new Error(`${label} timed out. status=${status} last=${JSON.stringify(last)}`);
  };

  await send("Page.navigate", {
    url: `${origin}/pdf/viewer.html?oiAuto=1&src=${encodeURIComponent(src)}`
  });
  await waitFor(`(() => {
    const bucket = window.__oiNotes;
    const laid = window.__oiLayouts && Object.keys(window.__oiLayouts).length;
    if (!bucket || typeof bucket.injectDeadExact !== "function" || !bucket.last || !bucket.last.docHash || !laid) return "";
    return "ready";
  })()`, "版面出来且笔记读过一次");

  const absent = await evaluate(`(async () => {
    const rows = await indexedDB.databases();
    return (rows || []).some((row) => row && row.name === "oi-annotations") ? "exists" : "absent";
  })()`);
  assert.equal(absent, "absent");

  const written = JSON.parse(await evaluate(`(async () => {
    const docHash = window.__oiNotes.last.docHash;
    const saved = await window.__oiNotes.store.put({
      id: "probe-one",
      docHash,
      kind: "note",
      page: 1,
      body: "第一条"
    });
    const names = (await indexedDB.databases()).map((row) => row && row.name).filter(Boolean);
    const row = await new Promise((resolve, reject) => {
      const request = indexedDB.open("oi-annotations");
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction("notes").objectStore("notes").get("probe-one");
        get.onerror = () => reject(get.error);
        get.onsuccess = () => {
          db.close();
          resolve(get.result || null);
        };
      };
    });
    return JSON.stringify({
      id: saved && saved.id,
      body: row && row.body,
      page: row && row.page,
      docHash: row && row.docHash,
      names
    });
  })()`));
  assert.equal(written.id, "probe-one");
  assert.equal(written.body, "第一条");
  assert.equal(written.page, 1);
  assert.equal(written.docHash, await evaluate(`window.__oiNotes.last.docHash`));
  assert.equal(written.names.includes("oi-annotations"), true);

  const alias = JSON.parse(await evaluate(`(async () => {
    const hit = await window.__oiNotes.injectDeadExact({ path: "alias", id: "probe-alias" });
    return JSON.stringify(hit);
  })()`));
  assert.equal(alias.status, "alias");
  assert.equal(alias.path, "alias");
  assert.equal(typeof alias.page, "number");
  assert.equal(alias.page >= 1, true);
  assert.notEqual(alias.bid, alias.deadBid);
  assert.equal(alias.located.how, "quoteSrc");
  assert.equal(alias.located.start, 0);

  const text = JSON.parse(await evaluate(`(async () => {
    const hit = await window.__oiNotes.injectDeadExact({ path: "text", id: "probe-text" });
    return JSON.stringify(hit);
  })()`));
  assert.equal(text.status, "text");
  assert.equal(text.path, "text");
  assert.equal(text.page, alias.page);
  assert.notEqual(text.bid, text.deadBid);
  assert.equal(text.located.how, "quoteSrc");
  assert.equal(text.located.start, 0);
  assert.notEqual(text.bid, "");
});
