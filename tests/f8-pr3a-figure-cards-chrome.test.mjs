// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// The test server rewrites pageCropLooksEmpty so figure and table crops
// render placeholder cards. That rewrite is not in the file on disk.
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

const PREFIXES = ["oi-fig-cards-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

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
  ".png": "image/png",
  ".svg": "image/svg+xml"
};
const EMPTY_CROP = "export function pageCropLooksEmpty(pageRatio, bbox) {";
const FORCED_CROP = "export function pageCropLooksEmpty(pageRatio, bbox) {\n  return true;";
const CARD_HOOK = "globalThis.__oiFigureCards = { orphanVisualNotice, visualCropNotice };";

const PROBE = `(() => {
  const shown = (button, selector) => {
    const el = button.querySelector(selector);
    if (!el) return "";
    return getComputedStyle(el).display === "none" ? "" : (el.textContent || "");
  };
  const read = (button) => {
    if (!button) return null;
    const row = button.parentElement;
    const reserve = row && row.querySelector("[data-oi-reserve='f8']");
    const box = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const pad = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const sub = button.querySelector(".oi-ph-sub");
    return {
      tag: button.tagName,
      type: button.getAttribute("type"),
      label: button.getAttribute("aria-label") || "",
      hiddenText: button.querySelector(".oi-ph-text")?.getAttribute("aria-hidden") || "",
      figureLabel: button.dataset.figureLabel || "",
      page: button.dataset.page || "",
      l0: shown(button, ".l0"),
      l1: shown(button, ".l1"),
      l2: shown(button, ".l2"),
      s0: shown(button, ".s0"),
      s1: shown(button, ".s1"),
      subDisplay: sub ? getComputedStyle(sub).display : "",
      height: box.height,
      width: box.width,
      scroll: button.scrollWidth,
      client: button.clientWidth,
      lineScroll: button.querySelector(".oi-ph-line")?.scrollWidth || 0,
      subScroll: sub && getComputedStyle(sub).display !== "none" ? sub.scrollWidth : 0,
      query: button.clientWidth - pad,
      reserve: reserve ? (reserve.textContent || "") : null,
      focused: document.activeElement === button,
      mode: document.querySelector(".workspace")?.dataset.sourceMode || "",
      view: document.querySelector(".workspace")?.dataset.view || "",
      pop: document.getElementById("sourcePop")?.hidden === false,
      popFlag: document.querySelector(".workspace")?.dataset.sourcePop || ""
    };
  };
  const buttonFor = (page) => document.querySelector("#readerFlow .oi-figure-placeholder[data-page='" + page + "']");
  const tableButton = () => [...document.querySelectorAll("#readerFlow .oi-figure-placeholder")]
    .find((button) => (button.getAttribute("aria-label") || "").includes("原表")) || null;
  return { read, buttonFor, tableButton };
})()`;

function serveRepo() {
  let patched = false;
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
      let body = readFileSync(file);
      if (rel === "lib/pdf-formula-raster.js") {
        const source = body.toString("utf8");
        if (!source.includes(EMPTY_CROP)) throw new Error("pageCropLooksEmpty hook point missing");
        body = Buffer.from(source.replace(EMPTY_CROP, FORCED_CROP));
        patched = true;
      }
      if (rel === "pdf/viewer.js") {
        const source = body.toString("utf8");
        if (!source.includes("function orphanVisualNotice")) throw new Error("orphanVisualNotice hook point missing");
        if (source.includes(CARD_HOOK)) throw new Error("card hook must stay out of the repo");
        body = Buffer.from(`${source}\n${CARD_HOOK}\n`);
      }
      res.writeHead(200, {
        "content-type": MIME[extname(file)] || "application/octet-stream",
        "cache-control": "no-store"
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end();
    }
  });
  server.patched = () => patched;
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

function fits(card) {
  return card.scroll <= card.client + 1 && card.lineScroll <= card.client + 1 && card.subScroll <= card.client + 1;
}

test("figure and table placeholder cards", { timeout: 240000 }, async (t) => {
  const disk = readFileSync(join(root, "lib/pdf-formula-raster.js"), "utf8");
  assert.match(disk, /return pageRatio < VISUAL_CROP_EMPTY_INK/);
  assert.equal(disk.includes(FORCED_CROP), false);
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");

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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-fig-cards-"));
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
      try { localStorage.setItem("reader.follow", "0"); } catch {}
      window.addEventListener("error", (event) => {
        const list = window.__oiErrors || (window.__oiErrors = []);
        list.push(String(event.message || "error"));
      });
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
  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}` });

  const waitFor = async (expression, label, timeoutMs = 90000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`${label}: ${JSON.stringify(last)}`);
  };

  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    return /\\/\\s*15/.test(pager) ? pager : "";
  })()`, "Attention open");
  const sourcePage = async () => {
    const label = await evaluate(`document.getElementById("sourcePageLabel")?.textContent || ""`);
    return Number((/^(\d+)/.exec(String(label || "").trim()) || [])[1] || 0);
  };
  const gotoSourcePage = async (page) => {
    for (let step = 0; step < 20 && await sourcePage() < page; step += 1) {
      await evaluate(`document.getElementById("sourceNext")?.click()`);
      await sleep(200);
    }
    assert.equal(await sourcePage(), page, `source pager did not reach page ${page}`);
  };
  await gotoSourcePage(3);

  const cardExpr = (page) => `(() => {
    const api = ${PROBE};
    return api.read(api.buttonFor("${page}"));
  })()`;
  let card = null;
  const paintStarted = Date.now();
  while (Date.now() - paintStarted < 90000) {
    card = await evaluate(cardExpr("3"));
    if (card) break;
    await sleep(200);
  }
  assert.ok(handle.server.patched(), "viewer did not load the test crop hook");
  if (!card) {
    const snap = await evaluate(`(() => {
      const flow = document.getElementById("readerFlow");
      return {
        status: document.getElementById("docStatus")?.textContent || "",
        state: document.getElementById("docStatus")?.dataset.state || "",
        slots: [...document.querySelectorAll("#readerFlow .rf-page")].slice(0, 8).map((el) => el.dataset.page + ":" + (el.dataset.state || "")),
        figures: flow ? flow.querySelectorAll(".oi-pdf-figure").length : 0,
        cards: flow ? flow.querySelectorAll(".oi-figure-placeholder").length : 0,
        fallbacks: flow ? flow.querySelectorAll(".oi-pdf-asset-fallback").length : 0,
        pending: flow ? flow.querySelectorAll(".oi-pdf-asset-pending").length : 0,
        errors: window.__oiErrors || []
      };
    })()`);
    assert.ok(card, `page 3 figure card did not render ${JSON.stringify(snap)}`);
  }
  assert.equal(card.tag, "BUTTON");
  assert.equal(card.type, "button");
  assert.equal(card.page, "3");
  assert.equal(card.figureLabel, "1");
  assert.equal(card.label, "图 1 · 原文第 3 页 · 点击查看原图");
  assert.equal(card.hiddenText, "true");
  assert.equal(card.reserve, "");
  assert.ok(Math.abs(card.height - 64) < 1, `height ${card.height}`);
  assert.ok(card.width >= 160, `width ${card.width}`);
  assert.ok(fits(card), `natural overflow ${JSON.stringify(card)}`);
  assert.equal(card.l0, "点击查看原图");
  assert.equal(card.s0, "图 1 · 原文第 3 页");

  const sized = async (px) => {
    await evaluate(`(() => {
      const button = document.querySelector("#readerFlow .oi-figure-placeholder[data-page='3']");
      const row = button.parentElement;
      row.style.boxSizing = "border-box";
      row.style.width = "${px}px";
      row.style.maxWidth = "${px}px";
      row.style.flex = "0 0 auto";
      return true;
    })()`);
    await evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
    return evaluate(cardExpr("3"));
  };
  const mid = await sized(190);
  assert.equal(mid.l0, "", JSON.stringify(mid));
  assert.equal(mid.l1, "看原图");
  assert.equal(mid.s1, "图 1 · 第 3 页");
  assert.ok(mid.query < 200 && mid.query >= 128, `mid query ${mid.query}`);
  assert.ok(fits(mid), `190 overflow ${JSON.stringify(mid)}`);
  const narrow = await sized(120);
  assert.equal(narrow.l2, "原图", JSON.stringify(narrow));
  assert.equal(narrow.l0, "");
  assert.equal(narrow.l1, "");
  assert.equal(narrow.subDisplay, "none");
  assert.ok(narrow.query < 128, `narrow query ${narrow.query}`);
  assert.ok(fits(narrow), `120 overflow ${JSON.stringify(narrow)}`);
  assert.ok(narrow.width >= 28 && narrow.height >= 28, `hit target ${narrow.width}x${narrow.height}`);

  await evaluate(`(() => {
    const button = document.querySelector("#readerFlow .oi-figure-placeholder[data-page='3']");
    const row = button.parentElement;
    row.style.width = "";
    row.style.maxWidth = "";
    row.style.flex = "";
    button.focus();
    return document.activeElement === button;
  })()`);
  const focused = await evaluate(cardExpr("3"));
  assert.equal(focused.focused, true);
  assert.equal(focused.label, "图 1 · 原文第 3 页 · 点击查看原图");

  const point = await evaluate(`(() => {
    const button = document.querySelector("#readerFlow .oi-figure-placeholder[data-page='3']");
    button.scrollIntoView({ block: "center" });
    const box = button.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  await waitFor(`(() => {
    const label = document.getElementById("sourcePageLabel")?.textContent || "";
    return /^3\\s*\\//.test(label) ? label : "";
  })()`, "source reached page 3", 8000);

  await evaluate(`document.querySelector("#sourceModeSeg [data-source-mode='hidden']").click()`);
  await waitFor(`document.querySelector(".workspace")?.dataset.sourceMode === "hidden" ? "hidden" : ""`, "source hidden", 5000);
  await evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
  const popped = await evaluate(`(() => {
    const button = document.querySelector("#readerFlow .oi-figure-placeholder[data-page='3']");
    const before = {
      mode: document.querySelector(".workspace")?.dataset.sourceMode || "",
      view: document.querySelector(".workspace")?.dataset.view || ""
    };
    button.scrollIntoView({ block: "center" });
    button.click();
    const workspace = document.querySelector(".workspace");
    const pop = document.getElementById("sourcePop");
    return {
      before,
      mode: workspace?.dataset.sourceMode || "",
      view: workspace?.dataset.view || "",
      pop: pop ? pop.hidden === false : false,
      popFlag: workspace?.dataset.sourcePop || "",
      sideChecked: document.querySelector("#sourceModeSeg [data-source-mode='side']")?.getAttribute("aria-checked") || "",
      hiddenChecked: document.querySelector("#sourceModeSeg [data-source-mode='hidden']")?.getAttribute("aria-checked") || "",
      biChecked: document.querySelector("#viewSeg [data-view='bi']")?.getAttribute("aria-checked") || ""
    };
  })()`);
  assert.equal(popped.before.mode, "hidden");
  assert.equal(popped.before.view, "zh");
  assert.equal(popped.pop, true, JSON.stringify(popped));
  assert.equal(popped.popFlag, "open");
  assert.equal(popped.mode, "hidden");
  assert.equal(popped.view, "zh");
  assert.equal(popped.hiddenChecked, "true");
  assert.equal(popped.sideChecked, "false");
  assert.equal(popped.biChecked, "false");

  await gotoSourcePage(6);
  const tableLabels = await waitFor(`(() => {
    const labels = [...document.querySelectorAll("#readerFlow .oi-figure-placeholder[data-page='6']")]
      .map((button) => button.getAttribute("aria-label") || "");
    return labels.length ? labels : "";
  })()`, "page 6 cards", 90000);
  assert.ok(tableLabels.includes("表 1 · 原文第 6 页 · 点击查看原表"), JSON.stringify(tableLabels));
  const table = await evaluate(`(() => {
    const api = ${PROBE};
    const button = [...document.querySelectorAll("#readerFlow .oi-figure-placeholder[data-page='6']")]
      .find((node) => node.getAttribute("aria-label") === "表 1 · 原文第 6 页 · 点击查看原表");
    return api.read(button);
  })()`);
  assert.equal(table.tag, "BUTTON");
  assert.equal(table.page, "6");
  assert.equal(table.figureLabel, "1");
  assert.equal(table.label, "表 1 · 原文第 6 页 · 点击查看原表");
  assert.equal(table.l0, "点击查看原表");
  assert.equal(table.s0, "表 1 · 原文第 6 页");
  assert.ok(Math.abs(table.height - 64) < 1, `table height ${table.height}`);
  assert.ok(table.width >= 160, `table width ${table.width}`);
  assert.ok(fits(table), `table overflow ${JSON.stringify(table)}`);
});

test("caption-only cards and a hidden source without a pair", { timeout: 240000 }, async (t) => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.equal(viewer.includes(CARD_HOOK), false);
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");

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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-fig-cards-"));
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
      try { localStorage.setItem("reader.follow", "0"); } catch {}
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

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, 30000);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}` });
  const waitFor = async (expression, label, timeoutMs = 90000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(200);
    }
    throw new Error(`${label}: ${JSON.stringify(last)}`);
  };
  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    return /\\/\\s*15/.test(pager) ? pager : "";
  })()`, "Attention open");
  await waitFor(`globalThis.__oiFigureCards ? "hook" : ""`, "figure card hook");

  const mount = async (kind, block, page, caption) => evaluate(`(() => {
    const api = globalThis.__oiFigureCards;
    const row = api.${kind}(${JSON.stringify(block)}, ${page}, ${JSON.stringify(caption)});
    const host = document.getElementById("oi-orphan-host") || document.body.appendChild(Object.assign(document.createElement("div"), { id: "oi-orphan-host" }));
    const slot = document.createElement("div");
    host.append(slot);
    slot.append(row);
    const button = row.querySelector("button.oi-figure-placeholder");
    const read = ${PROBE}.read(button);
    read.pairHost = Boolean(button.closest("[data-pair-id]"));
    read.slot = slot.dataset.oiSlot = ${JSON.stringify(kind + ":" + (caption?.text || block.text || ""))};
    return read;
  })()`);

  const gated = await evaluate(`(() => {
    const api = globalThis.__oiFigureCards;
    const prose = api.orphanVisualNotice({
      label: "caption",
      text: "Table 2 summarizes our results and compares them.",
      sourceText: "Table 2 summarizes our results and compares them."
    }, 8);
    const real = api.orphanVisualNotice({
      label: "caption",
      text: "Table 3:",
      sourceText: "Table 3:"
    }, 8);
    const button = real.querySelector ? real.querySelector("button.oi-figure-placeholder") : null;
    return {
      proseCards: prose.querySelectorAll ? prose.querySelectorAll("button.oi-figure-placeholder").length : -1,
      realLabel: button ? (button.getAttribute("aria-label") || "") : ""
    };
  })()`);
  assert.equal(gated.proseCards, 0, JSON.stringify(gated));
  assert.equal(gated.realLabel, "表 3 · 原文第 8 页 · 点击查看原表");

  const table = await mount("orphanVisualNotice", {
    label: "caption",
    text: "Table 3: Win rates.",
    sourceText: "Table 3: Win rates."
  }, 5, null);
  assert.equal(table.pairHost, false);
  assert.equal(table.figureLabel, "3");
  assert.equal(table.l0, "点击查看原表");
  assert.equal(table.s0, "表 3 · 原文第 5 页");
  assert.equal(table.label, "表 3 · 原文第 5 页 · 点击查看原表");

  const figure = await mount("orphanVisualNotice", {
    label: "caption",
    text: "Figure 4: The model.",
    sourceText: "Figure 4: The model."
  }, 7, null);
  assert.equal(figure.pairHost, false);
  assert.equal(figure.figureLabel, "4");
  assert.equal(figure.l0, "点击查看原图");
  assert.equal(figure.s0, "图 4 · 原文第 7 页");
  assert.equal(figure.label, "图 4 · 原文第 7 页 · 点击查看原图");

  // A figure block keeps figure copy when the caption is a table, and the number is dropped.
  const mismatch = await mount("visualCropNotice", { label: "figure", id: "m-fig" }, 4, {
    label: "caption",
    text: "Table 2: Results.",
    sourceText: "Table 2: Results."
  });
  assert.equal(mismatch.figureLabel, "");
  assert.equal(mismatch.l0, "点击查看原图");
  assert.equal(mismatch.s0, "原文第 4 页");
  assert.equal(mismatch.label, "图 · 原文第 4 页 · 点击查看原图");

  const mismatchTable = await mount("visualCropNotice", { label: "table", id: "m-table" }, 8, {
    label: "caption",
    text: "Figure 9: Detail.",
    sourceText: "Figure 9: Detail."
  });
  assert.equal(mismatchTable.figureLabel, "");
  assert.equal(mismatchTable.l0, "点击查看原表");
  assert.equal(mismatchTable.s0, "原文第 8 页");
  assert.equal(mismatchTable.label, "表 · 原文第 8 页 · 点击查看原表");

  await evaluate(`document.querySelector("#sourceModeSeg [data-source-mode='hidden']").click()`);
  await waitFor(`document.querySelector(".workspace")?.dataset.sourceMode === "hidden" ? "hidden" : ""`, "source hidden");
  await evaluate(`(() => {
    const pop = document.getElementById("sourcePop");
    if (pop && pop.hidden === false) document.getElementById("sourcePopClose")?.click();
    return true;
  })()`);
  await waitFor(`document.getElementById("sourcePop")?.hidden === true ? "closed" : ""`, "source pop closed");
  await evaluate(`new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(true))))`);
  const popped = await evaluate(`(() => {
    const button = document.querySelector("#oi-orphan-host button.oi-figure-placeholder[data-figure-label='3']");
    const before = {
      mode: document.querySelector(".workspace")?.dataset.sourceMode || "",
      view: document.querySelector(".workspace")?.dataset.view || "",
      pairHost: Boolean(button.closest("[data-pair-id]"))
    };
    button.click();
    const workspace = document.querySelector(".workspace");
    const pop = document.getElementById("sourcePop");
    return {
      before,
      mode: workspace?.dataset.sourceMode || "",
      view: workspace?.dataset.view || "",
      pop: pop ? pop.hidden === false : false,
      popFlag: workspace?.dataset.sourcePop || "",
      sideChecked: document.querySelector("#sourceModeSeg [data-source-mode='side']")?.getAttribute("aria-checked") || "",
      hiddenChecked: document.querySelector("#sourceModeSeg [data-source-mode='hidden']")?.getAttribute("aria-checked") || "",
      biChecked: document.querySelector("#viewSeg [data-view='bi']")?.getAttribute("aria-checked") || ""
    };
  })()`);
  assert.equal(popped.before.pairHost, false);
  assert.equal(popped.before.mode, "hidden");
  assert.equal(popped.before.view, "zh");
  assert.equal(popped.pop, true, JSON.stringify(popped));
  assert.equal(popped.popFlag, "open");
  assert.equal(popped.mode, "hidden");
  assert.equal(popped.view, "zh");
  assert.equal(popped.hiddenChecked, "true");
  assert.equal(popped.sideChecked, "false");
  assert.equal(popped.biChecked, "false");
});
