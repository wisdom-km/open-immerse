// Cold start: page 3's text layer is still in __oiHoldRasterMs when the reader
// opens page 4. The continuation "of the values, where…" must not stay behind
// on page 4 after page 3 finally arrives.
// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
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

const PREFIXES = ["oi-page-join-late-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const ATTENTION_SHA = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
const TAIL_BID = "b1-p4-t031i7d0";
const TAIL = "of the values, where";
const JOINED = "weighted sum of the values";
const HOLD_MS = 20000;

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
  const blocks = (page) => [...document.querySelectorAll('#readerFlow .rf-block[data-src-page="' + page + '"]')].map((el) => ({
    id: el.dataset.blockId || "",
    bid: el.dataset.bid || "",
    text: (el.innerText || "").replace(/\\s+/g, " ").trim()
  }));
  const layouts = window.__oiLayouts || {};
  return {
    label: document.getElementById("sourcePageLabel")?.textContent || "",
    holdSeen: window.__oiHoldSeen || 0,
    page3: blocks(3),
    page4: blocks(4),
    laid3: Array.isArray(layouts[3]) ? layouts[3].length : 0
  };
})()`;

test("cold start joins the page 3 sentence after page 4 was already shown", { timeout: 180000 }, async (t) => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  assert.equal(createHash("sha256").update(readFileSync(fixture)).digest("hex"), ATTENTION_SHA);

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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-page-join-late-"));
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
      const origFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("/v1/library/") || url.includes("127.0.0.1:8765")) {
          return new Response("missing", { status: 404 });
        }
        return origFetch(input, init);
      };
      const origTimeout = window.setTimeout.bind(window);
      window.__oiHoldSeen = 0;
      window.setTimeout = (fn, ms, ...args) => {
        if (Number(ms) === ${HOLD_MS}) window.__oiHoldSeen += 1;
        return origTimeout(fn, ms, ...args);
      };
      globalThis.chrome = {
        storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
        runtime: {
          id: "oi-e2e",
          getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
          sendMessage(message) {
            const type = message && message.type;
            if (type === "OI_GET_SETTINGS") {
              return Promise.resolve({
                settings: { pdfAutoTranslate: false, batchSize: 8, targetLang: "zh-CN", pdfLayout: { mode: "" }, features: { pdf: true } }
              });
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

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30000);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 60000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(150);
    }
    const snap = await evaluate(SNAPSHOT).catch((error) => String(error));
    throw new Error(`${label} timed out. last=${JSON.stringify(last)} snap=${JSON.stringify(snap)}`);
  };
  const click = async (id) => {
    const clicked = await evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      if (!el || el.disabled) return false;
      el.click();
      return true;
    })()`);
    assert.equal(clicked, true, id);
  };
  const snapshot = async () => evaluate(SNAPSHOT);
  const carriers = (snap) => [...(snap.page3 || []), ...(snap.page4 || [])].filter((block) => block.text.includes(TAIL));

  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?oiAuto=1&src=${encodeURIComponent(src)}` });
  await waitFor(`(() => {
    const label = document.getElementById("sourcePageLabel")?.textContent || "";
    const block = document.querySelector('#readerFlow .rf-block[data-src-page="1"]');
    return /1\\s*\\/\\s*15/.test(label) && block ? "open" : "";
  })()`, "cold open page 1", 70000);
  await click("sourceNext");
  await waitFor(`(() => {
    const label = document.getElementById("sourcePageLabel")?.textContent || "";
    const block = document.querySelector('#readerFlow .rf-block[data-src-page="2"]');
    return /2\\s*\\/\\s*15/.test(label) && block ? "page2" : "";
  })()`, "page 2 text layer", 70000);

  const heldAt = Date.now();
  await evaluate(`window.__oiHoldRasterMs = ${HOLD_MS}`);
  await click("sourceNext");
  await waitFor(`(() => {
    const label = document.getElementById("sourcePageLabel")?.textContent || "";
    return /3\\s*\\/\\s*15/.test(label) ? "page3" : "";
  })()`, "nav reached page 3", 15000);
  const holdStarted = Date.now();
  let holdSeen = 0;
  while (Date.now() - holdStarted < 8000 && !holdSeen) {
    holdSeen = Number(await evaluate(`window.__oiHoldSeen || 0`)) || 0;
    if (!holdSeen) await sleep(100);
  }
  // The in-flight page 3 raster already captured HOLD_MS. Page 4 must not.
  await evaluate(`window.__oiHoldRasterMs = 0; document.getElementById("sourceNext").click()`);
  const split = await waitFor(`(() => {
    const page4 = [...document.querySelectorAll('#readerFlow .rf-block[data-src-page="4"]')];
    const tail = page4.some((el) => (el.innerText || "").includes(${JSON.stringify(TAIL)}));
    const laid3 = Array.isArray(window.__oiLayouts && window.__oiLayouts[3]) ? window.__oiLayouts[3].length : 0;
    const label = document.getElementById("sourcePageLabel")?.textContent || "";
    if (!/4\\s*\\/\\s*15/.test(label) || !tail || laid3) return "";
    return "split";
  })()`, "page 4 shows the continuation before page 3 arrives", 70000);
  assert.equal(split, "split");
  const before = await snapshot();
  console.log(`PAGE_JOIN_SPLIT ${JSON.stringify({
    holdSeen,
    waitedMs: Date.now() - heldAt,
    page4: before.page4.map((block) => block.bid),
    laid3: before.laid3
  })}`);
  assert.equal(before.laid3, 0, "page 3 must still be absent when page 4 is showing the tail");
  assert.ok(before.page4.some((block) => block.bid === TAIL_BID), "page 4 paints the tail bid on its own");
  const page4Bids = before.page4.map((block) => block.bid);

  const remain = HOLD_MS - (Date.now() - heldAt);
  if (remain > 0) await sleep(remain + 1500);
  await evaluate(`window.__oiHoldRasterMs = 0`);
  await click("sourcePrev");
  await waitFor(`(() => {
    const label = document.getElementById("sourcePageLabel")?.textContent || "";
    const hit = [...document.querySelectorAll('#readerFlow .rf-block[data-src-page="3"]')]
      .some((el) => (el.innerText || "").includes("weighted sum"));
    return /3\\s*\\/\\s*15/.test(label) && hit ? "late" : "";
  })()`, "page 3 arrives", 70000);

  const after = await snapshot();
  console.log(`PAGE_JOIN_LATE ${JSON.stringify({
    page3: after.page3.filter((block) => /weighted sum|of the values/.test(block.text)).map((block) => ({
      id: block.id,
      bid: block.bid,
      text: block.text.slice(0, 280)
    })),
    page4Tail: after.page4.filter((block) => block.bid === TAIL_BID || block.text.includes(TAIL)).map((block) => ({
      id: block.id,
      bid: block.bid,
      text: block.text.slice(0, 280)
    })),
    page4Bids: after.page4.map((block) => block.bid)
  })}`);
  const joined = carriers(after);
  assert.equal(joined.length, 1, "the continuation is one block, not dropped and not repeated");
  assert.equal(joined[0].text.includes(JOINED), true, "page 3 keeps the whole sentence");
  assert.equal(after.page3.some((block) => block.text.includes(JOINED)), true, "the joined sentence is on page 3");
  assert.equal(after.page4.some((block) => block.bid === TAIL_BID), false, "page 4 no longer shows the tail bid");
  assert.equal(after.page4.some((block) => block.text.includes(TAIL)), false, "page 4 no longer shows the tail sentence");
  assert.deepEqual(after.page4.map((block) => block.bid), page4Bids.filter((bid) => bid !== TAIL_BID), "other page 4 bids stay put");
});
