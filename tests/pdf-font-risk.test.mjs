// Real-device follow-ups on the Aa font size.
// At setting 40 the 585px column shows 28px, and an em-tall inline crop
// (1.8em) turns a 213×13 bitmap into an 826px box. Inline crops stay at
// the bitmap size and inside the column. A block that only barely crosses
// the pane top must still be in view after 32→16. A real DPO display
// formula in a narrow column shrinks to the shown-font floor, then scrolls.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { formulaReadabilityFloor } from "../lib/pdf-formula-size.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PREFIXES = ["oi-font-risk-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pdfRel = "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf";
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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

const handle = { child: null, cdp: null, server: null, ownedDir: null, userDataDir: null, evaluate: null, send: null };

describe("Aa font-size risk checks on DPO", () => {
  before(async () => {
    assert.equal(existsSync(join(root, pdfRel)), true, `${pdfRel} is missing`);
    handle.server = await serveRepo();
    handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-font-risk-"));
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
        try {
          localStorage.setItem("reader.fontSize", "40");
          localStorage.setItem("reader.sourceMode", "side");
          localStorage.setItem("reader.follow", "0");
        } catch {}
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
    handle.evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 60000);
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails;
        throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
      }
      return result.result?.value;
    };
    const origin = `http://127.0.0.1:${handle.server.address().port}`;
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
    });
    await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(`${origin}/${pdfRel}`)}` });
    const opened = Date.now();
    let ready = null;
    while (Date.now() - opened < 60000) {
      ready = await handle.evaluate(`(() => {
        const flow = document.getElementById("readerFlow");
        const pages = document.querySelectorAll("#pages .pdf-page").length;
        const painted = flow ? flow.querySelectorAll(".rf-page[data-page='1'] > *").length : 0;
        const next = document.getElementById("sourceNext");
        return { pages, painted, next: Boolean(next && !next.disabled) };
      })()`);
      if (ready?.painted > 0 && ready.pages > 1 && ready.next) break;
      await sleep(250);
    }
    assert.ok(ready?.painted > 0, "DPO did not paint page 1");
    for (let page = 2; page <= ready.pages; page += 1) {
      const clicked = await handle.evaluate(`(() => {
        const next = document.getElementById("sourceNext");
        if (!next || next.disabled) return false;
        next.click();
        return true;
      })()`);
      assert.equal(clicked, true, `stuck before page ${page}`);
      const step = Date.now();
      let last = -1;
      let stable = 0;
      while (Date.now() - step < 20000) {
        const n = await handle.evaluate(`document.querySelectorAll('#readerFlow .rf-page[data-page="${page}"] .rf-block').length`);
        if (n > 0 && n === last) {
          stable += 1;
          if (stable >= 2) break;
        } else stable = 0;
        last = n;
        await sleep(180);
      }
      assert.ok(last > 0, `page ${page} did not paint`);
    }
  }, { timeout: 180000 });

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

  test("font 40 keeps every DPO inline formula box inside the column at its bitmap size", async () => {
    const data = await handle.evaluate(`(() => {
      const flow = document.getElementById("readerFlow");
      const column = flow.getBoundingClientRect().width;
      const shown = parseFloat(getComputedStyle(flow).fontSize);
      const setting = document.getElementById("aaFontScale")?.getAttribute("aria-valuenow") || "";
      const rows = [];
      for (const span of flow.querySelectorAll(".oi-pdf-inline-math")) {
        const img = span.querySelector("img");
        if (!img || !(img.naturalWidth > 0)) continue;
        const box = img.getBoundingClientRect();
        const frame = span.getBoundingClientRect();
        if (!(box.width > 1)) continue;
        rows.push({
          id: span.dataset.blockId || "",
          page: span.closest("[data-src-page]")?.dataset.srcPage || span.dataset.page || "",
          w: box.width,
          frame: frame.width,
          nat: img.naturalWidth,
          raised: span.classList.contains("is-raised")
        });
      }
      let scrollMax = 0;
      for (const scroll of flow.querySelectorAll(".oi-pdf-math-scroll")) {
        scrollMax = Math.max(scrollMax, scroll.getBoundingClientRect().width);
      }
      return { column, shown, setting, rows, scrollMax };
    })()`);
    assert.equal(data.setting, "40");
    assert.ok(data.column >= 520 && data.column <= 640, `column ${data.column}`);
    assert.ok(data.shown >= 28, `shown font ${data.shown}`);
    assert.ok(data.rows.length > 40, `only ${data.rows.length} inline formulas`);
    for (const row of data.rows) {
      assert.ok(row.frame <= data.column + 1, `${row.page} ${row.id} frame ${row.frame} exceeds column ${data.column}`);
      if (row.raised) continue;
      assert.ok(row.w <= data.column + 1, `${row.page} ${row.id} box ${row.w} exceeds column ${data.column}`);
      assert.ok(row.w <= row.nat + 2, `${row.page} ${row.id} stretched to ${row.w}px from bitmap ${row.nat}px`);
    }
    assert.ok(data.scrollMax <= data.column + 1, `display formula frame ${data.scrollMax} exceeds column ${data.column}`);
  });

  test("p5 anchor block stays in the viewport after font 32 to 16", async () => {
    const setFont = async (target) => {
      const setting = await handle.evaluate(`(() => {
        const slider = document.getElementById("aaFontScale");
        if (!slider) return "";
        for (let i = 0; i < 20; i += 1) {
          const now = Number(slider.getAttribute("aria-valuenow"));
          if (now === ${target}) return String(now);
          const key = now < ${target} ? "ArrowRight" : "ArrowLeft";
          slider.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
        }
        return slider.getAttribute("aria-valuenow") || "";
      })()`);
      assert.equal(setting, String(target));
    };
    const ids = ["p5-b1", "p5-b5", "p5-b9", "p5-b21", "p5-b22"];
    for (const id of ids) {
      await setFont(32);
      await sleep(220);
      const before = await handle.evaluate(`(() => {
        const pane = document.getElementById("translateScroll");
        const el = document.querySelector('#readerFlow .rf-block[data-src-page="5"][data-block-id="${id}"]');
        if (!el) return null;
        const paneBox = pane.getBoundingClientRect();
        pane.scrollTop += el.getBoundingClientRect().bottom - paneBox.top - 2;
        const blocks = [...document.querySelectorAll("#readerFlow .rf-block[data-src-page]")];
        const top = pane.getBoundingClientRect().top;
        const picked = blocks.find((node) => node.getBoundingClientRect().bottom > top + 1);
        const box = picked.getBoundingClientRect();
        return {
          id: picked.dataset.blockId || "",
          page: picked.dataset.srcPage || "",
          bottom: box.bottom - top
        };
      })()`);
      assert.ok(before?.id, `missing anchor for ${id}`);
      assert.equal(before.page, "5");
      await setFont(16);
      await sleep(500);
      const after = await handle.evaluate(`(() => {
        const pane = document.getElementById("translateScroll");
        const paneBox = pane.getBoundingClientRect();
        const node = document.querySelector('#readerFlow .rf-block[data-src-page="${before.page}"][data-block-id="${before.id}"]');
        if (!node) return { missing: true };
        const box = node.getBoundingClientRect();
        return {
          top: box.top - paneBox.top,
          bottom: box.bottom - paneBox.top,
          intersects: box.bottom > paneBox.top + 0.5 && box.top < paneBox.bottom - 0.5
        };
      })()`);
      assert.equal(after.missing, undefined);
      assert.equal(after.intersects, true, `p5 ${before.id} left the viewport after 32→16 (top ${after.top}, bottom ${after.bottom})`);
    }
  });

  test("a real DPO display formula shrinks to the shown-font floor, then scrolls", async () => {
    await handle.send("Emulation.setDeviceMetricsOverride", {
      width: 320, height: 800, deviceScaleFactor: 1, mobile: false
    });
    await handle.evaluate(`window.dispatchEvent(new Event("resize"))`);
    let sample = null;
    const started = Date.now();
    while (Date.now() - started < 4000) {
      sample = await handle.evaluate(`(() => {
        const flow = document.getElementById("readerFlow");
        const shown = parseFloat(getComputedStyle(flow).fontSize);
        const setting = Number(document.getElementById("aaFontScale")?.getAttribute("aria-valuenow"));
        const rows = [];
        for (const row of flow.querySelectorAll(".oi-pdf-math-row.is-matched")) {
          const img = row.querySelector("img");
          const scroll = row.querySelector(".oi-pdf-math-scroll");
          const widthPt = Number(row.dataset.widthPt);
          const bodyPt = Number(row.dataset.bodyPt);
          if (!img || !(widthPt > 0) || !(bodyPt > 0) || !(img.getBoundingClientRect().width > 1)) continue;
          rows.push({
            id: row.closest("[data-block-id]")?.dataset.blockId || "",
            page: row.closest("[data-src-page]")?.dataset.srcPage || "",
            widthPt,
            bodyPt,
            img: img.getBoundingClientRect().width,
            scrollW: scroll ? scroll.scrollWidth : 0,
            clientW: scroll ? scroll.clientWidth : 0,
            frame: scroll ? scroll.getBoundingClientRect().width : 0
          });
        }
        rows.sort((a, b) => b.widthPt - a.widthPt);
        return {
          shown,
          setting,
          mode: document.querySelector(".workspace")?.dataset.sourceMode || "",
          column: flow.getBoundingClientRect().width,
          top: rows[0] || null
        };
      })()`);
      if (sample?.top && sample.top.scrollW > sample.top.clientW + 1) break;
      await sleep(200);
    }
    assert.ok(sample?.top, `no matched display formula (mode ${sample?.mode}, column ${sample?.column}, shown ${sample?.shown})`);
    const row = sample.top;
    const expected = formulaReadabilityFloor(sample.shown, row.bodyPt);
    const storedFloor = formulaReadabilityFloor(sample.setting, row.bodyPt);
    const observed = row.img / row.widthPt;
    assert.ok(row.widthPt > 300, `expected a wide DPO formula, got ${row.widthPt}pt on ${row.page} ${row.id}`);
    assert.ok(row.clientW > 0 && (row.clientW - 2) / row.widthPt < expected, `column ${row.clientW}px does not force ${row.widthPt}pt down to the floor ${expected}`);
    assert.ok(Math.abs(observed - expected) < 0.03, `${row.page} ${row.id} scale ${observed} != floor ${expected} (shown ${sample.shown}, body ${row.bodyPt}, img ${row.img}, pt ${row.widthPt})`);
    if (Math.abs(storedFloor - expected) > 0.02) {
      assert.ok(Math.abs(observed - storedFloor) > 0.02, "scale followed the stored font instead of the shown font");
    }
    assert.ok(row.scrollW > row.clientW + 1, `formula ${row.img}px did not scroll inside ${row.clientW}px`);
    assert.ok(row.frame <= sample.column + 1, `formula frame ${row.frame} exceeds column ${sample.column}`);
  });
});
