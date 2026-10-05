// Local gitignored fixtures:
// tests/fixtures/Attention_Is_All_You_Need.pdf (sha256 bdfaa68d…df697)
// tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { isTranslatableBlock } from "../lib/pdf-blocks.js";
import { assignBids, isBid, stampLayoutBids } from "../lib/pdf-block-id.js";
import { layoutCacheKey } from "../lib/pdf-layout-client.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const BID_TMP_PREFIXES = ["oi-bid-render-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(BID_TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const ATTENTION_SHA = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

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

function slimBlock(block) {
  const next = {
    id: block.id,
    sourceId: block.sourceId,
    label: block.label,
    bbox: block.bbox
  };
  if (block.text) next.text = block.text;
  if (block.sourceText) next.sourceText = block.sourceText;
  if (block.presentation) next.presentation = block.presentation;
  if (block.skipTranslate) next.skipTranslate = true;
  if (block.captionFor) next.captionFor = block.captionFor;
  if (block.inlineOf) next.inlineOf = block.inlineOf;
  if (block.display === false) next.display = false;
  return next;
}

async function attentionPages(numbers) {
  const bytes = readFileSync(fixture);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), ATTENTION_SHA);
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pages = new Map();
  try {
    for (const number of numbers) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const layout = textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      pages.set(number, stampLayoutBids(number, layout));
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

function legacyPairs(layout) {
  return layout.blocks.filter(isTranslatableBlock).map((block, index) => ({
    id: block.id,
    sourceId: block.sourceId,
    text: block.text,
    sourceText: block.sourceText || block.text,
    translation: `汉块${index} ${block.text}`,
    status: "verified"
  }));
}

test("stable bids survive reload, restyle, retranslate, and a bid-less layout cache", { timeout: 300000 }, async (t) => {
  assert.equal(existsSync(fixture), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  const pages = await attentionPages([1, 4, 5]);
  const libraryPages = [4, 5].map((page) => ({ page, pairs: legacyPairs(pages.get(page)) }));
  const cacheBlocks = pages.get(1).blocks
    .filter((block) => !["formula", "figure", "table"].includes(block.label))
    .map(slimBlock);
  const cacheLayout = {
    protocol: "blocks-1",
    page: 1,
    textSource: "ocr",
    blocks: cacheBlocks
  };
  const cacheKey = layoutCacheKey({ hash: ATTENTION_SHA, page: 1, mode: "local-ocr" });
  const expectedById = Object.fromEntries(assignBids(1, cacheBlocks).map((block) => [block.id, block.bid]));
  const payload = JSON.stringify({ libraryPages, cacheKey, cacheLayout, expectedById }).replace(/</g, "\\u003c");

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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-bid-render-"));
  rememberOwnedTemp(handle.ownedDir);
  const userDataDir = join(handle.ownedDir, "profile");
  const scratchDir = join(handle.ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  handle.userDataDir = userDataDir;
  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  const viewerFor = (mode) => {
    const extra = mode === "text" ? "&oiAuto=1" : "";
    return `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}&oiBidMode=${mode}${extra}`;
  };

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
      const payload = ${payload};
      const mode = new URLSearchParams(location.search).get("oiBidMode") || "text";
      if (mode === "cache") localStorage.setItem("oi-pdf-engine", "local-ocr");
      else localStorage.removeItem("oi-pdf-engine");
      window.__oiPosts = [];
      const origFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("/v1/library/")) {
          if (init && String(init.method || "").toUpperCase() === "POST") {
            let body = {};
            try { body = JSON.parse(init.body || "{}"); } catch { body = {}; }
            window.__oiPosts.push(body);
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          }
          if (mode === "cache") return new Response("missing", { status: 404 });
          return new Response(JSON.stringify({ pageCount: 15, title: "Attention Is All You Need", pages: payload.libraryPages }), {
            status: 200,
            headers: { "content-type": "application/json" }
          });
        }
        return origFetch(input, init);
      };
      const store = { [payload.cacheKey]: payload.cacheLayout };
      globalThis.chrome = {
        storage: {
          local: {
            get(key) {
              const name = typeof key === "string" ? key : "";
              return Promise.resolve(store[name] === undefined ? {} : { [name]: store[name] });
            },
            set() { return Promise.resolve(); }
          }
        },
        runtime: {
          getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
          sendMessage(message) {
            const type = message && message.type;
            if (type === "OI_GET_SETTINGS") {
              return Promise.resolve({
                settings: { pdfAutoTranslate: false, batchSize: 8, targetLang: "zh-CN", pdfLayout: { mode: "" } }
              });
            }
            if (type === "OI_PDF_STRUCTURE") return Promise.resolve({ ok: false });
            if (type === "OI_ENSURE_GLMOCR") return Promise.resolve({ ok: true });
            if (type === "OI_TRANSLATE_BATCH") {
              const texts = message.texts || [];
              return Promise.resolve({ ok: true, translations: texts.map((text) => "重译" + text) });
            }
            return Promise.resolve({ ok: true });
          }
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
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
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
      last = await evaluate(expression);
      if (last) return last;
      await sleep(150);
    }
    const status = await evaluate(`document.getElementById("status")?.textContent || ""`).catch(() => "");
    throw new Error(`${label} timed out. status=${status} last=${JSON.stringify(last)}`);
  };
  const mouseClick = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  };
  const clickSelector = async (selector) => {
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return null;
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    assert.ok(point, selector);
    await mouseClick(point.x, point.y);
  };
  const keyTap = async (key, code, vk) => {
    const down = { type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text: key };
    await send("Input.dispatchKeyEvent", down);
    await send("Input.dispatchKeyEvent", { ...down, type: "keyUp" });
  };
  const frames = (n = 2) => evaluate(`new Promise((done) => {
    let left = ${n};
    const step = () => { left -= 1; if (left <= 0) done(true); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  })`);
  const lists = async (page) => JSON.parse(await evaluate(`(() => {
    const nodes = [...document.querySelectorAll('#readerFlow .rf-block[data-src-page="${page}"]')];
    return JSON.stringify({
      pair: nodes.map((el) => el.dataset.pairId || ""),
      bid: nodes.map((el) => el.dataset.bid || "")
    });
  })()`));
  const posts = async () => JSON.parse(await evaluate(`JSON.stringify(window.__oiPosts || [])`));
  const hasBid = (row, bid) => row.bid.includes(bid) || row.pair.includes(bid);
  const settled = async (page, needles) => {
    const want = Array.isArray(needles) ? needles : [needles];
    let previous = "";
    let steady = 0;
    let last = null;
    const started = Date.now();
    while (Date.now() - started < 20000) {
      last = await lists(page);
      const signature = JSON.stringify(last);
      const hit = want.every((bid) => hasBid(last, bid));
      if (hit && signature === previous) {
        steady += 1;
        if (steady >= 4) return last;
      } else if (signature !== previous) {
        steady = 0;
      }
      previous = signature;
      await sleep(150);
    }
    throw new Error(`page ${page} bids did not settle: ${JSON.stringify(last)}`);
  };
  const reveal = async () => {
    await waitFor(`(() => {
      const state = document.getElementById("docStatus")?.dataset.state || "";
      return state && state !== "opening" ? state : "";
    })()`, "reader left opening", 30000);
    await evaluate(`(() => {
      document.querySelectorAll("#readerFlow .rf-page").forEach((el) => { delete el.dataset.painted; });
      if (typeof globalThis.__oiRenderArticle === "function") globalThis.__oiRenderArticle();
      return true;
    })()`);
  };
  const currentPage = async () => {
    const label = await evaluate(`document.getElementById("sourcePageLabel")?.textContent || ""`);
    return Number((/^(\d+)\s*\//.exec(String(label || "").trim()) || [])[1] || 0);
  };
  const goTo = async (page) => {
    for (let step = 0; step < 20; step += 1) {
      const current = await currentPage();
      if (current === page) {
        await waitFor(
          `document.querySelector('#readerFlow .rf-block[data-src-page="${page}"][data-bid]') ? "ready" : ""`,
          `page ${page} bids`,
          50000
        );
        return;
      }
      await clickSelector(current && current > page ? "#sourcePrev" : "#sourceNext");
      await sleep(400);
    }
    throw new Error(`could not reach page ${page} (still ${await currentPage()})`);
  };
  const assertStable = (found, expected, label) => {
    assert.deepEqual(found.pair, expected.pair, `${label} pair ids`);
    assert.deepEqual(found.bid, expected.bid, `${label} bids`);
    assert.ok(found.bid.some((bid) => isBid(bid)), label);
  };

  await send("Page.navigate", { url: viewerFor("text") });
  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    return /\\/\\s*15/.test(pager) ? pager : "";
  })()`, "Attention open", 50000);
  await goTo(4);
  await waitFor(`(document.getElementById("readerFlow")?.innerText || "").includes("汉块0") ? "zh" : ""`, "page 4 old translation", 20000);
  assert.equal((await posts()).length, 0, "opening page 4 does not write the library");
  await reveal();
  const page4Needles = ["b1-p4-t010gv1t", "b1-p4-t1ejbcw1", "b1-p4-t1ewqjfg"];
  const TEXT_LAYER_FORMULA = "b1-p4-m0ihblz1";
  const page4 = await settled(4, page4Needles);
  const formulaBlockId = await evaluate(`document.querySelector('#readerFlow figure[data-label="formula"][data-bid="${TEXT_LAYER_FORMULA}"]')?.dataset.blockId || ""`);
  assert.ok(formulaBlockId, "display formula keeps the text-layer bid");
  const formulaBid = () => evaluate(`document.querySelector('#readerFlow figure[data-block-id="${formulaBlockId}"]')?.dataset.bid || ""`);
  assert.equal(await formulaBid(), TEXT_LAYER_FORMULA, "text-layer formula bid");
  assert.ok(page4.pair.includes("b1-p4-t010gv1t"), "pair id uses the block bid");
  assert.ok(page4.pair.includes(TEXT_LAYER_FORMULA) || page4.bid.includes(TEXT_LAYER_FORMULA), "formula bid is on the page");
  const anchor = JSON.parse(await evaluate(`(() => {
    const pane = document.getElementById("translateScroll");
    const top = pane.getBoundingClientRect().top;
    const block = [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => el.getBoundingClientRect().bottom > top + 1);
    return JSON.stringify({ id: block?.dataset.blockId || "", bid: block?.dataset.bid || "" });
  })()`));
  assert.ok(anchor.id && anchor.bid);

  await clickSelector("#aaButton");
  await waitFor(`document.getElementById("aaPanel")?.hidden === false ? "open" : ""`, "Aa panel");
  await clickSelector('#aaFontScale [data-size="14"]');
  await waitFor(`document.getElementById("aaFontValue")?.textContent === "14px" ? "14" : ""`, "font 14");
  await frames(3);
  assertStable(await settled(4, page4Needles), page4, "font 14");
  await clickSelector('#aaFontScale [data-size="20"]');
  await waitFor(`document.getElementById("aaFontValue")?.textContent === "20px" ? "20" : ""`, "font 20");
  await frames(3);
  assertStable(await settled(4, page4Needles), page4, "font 20");
  const anchored = await evaluate(`document.querySelector('#readerFlow [data-block-id="${anchor.id}"]')?.dataset.bid || ""`);
  assert.equal(anchored, anchor.bid, "restored block bid");
  for (const theme of ["white", "sepia", "green", "warm"]) {
    await clickSelector(`#aaThemes [data-theme="${theme}"]`);
    await waitFor(`document.body.dataset.readerTheme === "${theme}" ? "${theme}" : ""`, `theme ${theme}`);
    await frames(2);
    assertStable(await settled(4, page4Needles), page4, `theme ${theme}`);
  }
  await clickSelector("#translateScroll");
  await evaluate(`document.activeElement?.blur()`);
  await frames(1);
  await keyTap("s", "KeyS", 83);
  await frames(2);
  assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.sourceSide || ""`), "end");
  assertStable(await settled(4, page4Needles), page4, "swap to end");
  await keyTap("s", "KeyS", 83);
  await frames(2);
  assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.sourceSide || ""`), "start");
  assertStable(await settled(4, page4Needles), page4, "swap back to start");
  const expectZoom = async (label) => {
    await waitFor(
      `document.getElementById("zoomLabel")?.textContent === ${JSON.stringify(label)} ? "z" : ""`,
      `zoom ${label}`,
      15000
    );
    await frames(3);
    assert.equal(await formulaBid(), TEXT_LAYER_FORMULA, `formula bid at zoom ${label}`);
  };
  await clickSelector("#zoomOut");
  await expectZoom("75%");
  assertStable(await settled(4, page4Needles), page4, "zoom 0.75");
  await clickSelector("#zoomIn");
  await expectZoom("100%");
  await clickSelector("#zoomIn");
  await clickSelector("#zoomIn");
  await expectZoom("150%");
  assertStable(await settled(4, page4Needles), page4, "zoom 1.5");
  await clickSelector("#zoomOut");
  await clickSelector("#zoomOut");
  await expectZoom("100%");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await frames(3);
  assert.equal(await formulaBid(), TEXT_LAYER_FORMULA, "formula bid at dpr 2");
  assertStable(await settled(4, page4Needles), page4, "dpr 2");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await frames(3);
  assert.equal(await formulaBid(), TEXT_LAYER_FORMULA, "formula bid at dpr 1");
  assertStable(await settled(4, page4Needles), page4, "dpr 1");

  await goTo(5);
  await waitFor(`(document.getElementById("readerFlow")?.innerText || "").includes("汉块0") ? "zh" : ""`, "page 5 old translation", 20000);
  assert.equal((await posts()).length, 0, "opening page 5 does not write the library");
  await reveal();
  const page5Needles = ["b1-p5-t1gsw7yq", "b1-p5-t1r2ylcc"];
  const page5 = await settled(5, page5Needles);

  await send("Page.reload", { ignoreCache: true });
  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    return /\\/\\s*15/.test(pager) ? pager : "";
  })()`, "reload", 50000);
  await goTo(4);
  await reveal();
  assertStable(await settled(4, page4Needles), page4, "reload page 4");
  await goTo(5);
  await reveal();
  assertStable(await settled(5, page5Needles), page5, "reload page 5");
  assert.equal((await posts()).length, 0, "reload does not write the library");

  await goTo(4);
  await reveal();
  const beforeSave = page4;
  await evaluate(`document.querySelector('#readerFlow .rf-block[data-src-page="4"]')?.scrollIntoView({ block: "center", behavior: "auto" })`);
  await frames(4);
  await waitFor(`document.getElementById("pageCapsule")?.dataset.srcPage === "4" ? "4" : ""`, "capsule on page 4", 10000);
  await clickSelector("#retranslatePage");
  await waitFor(`(document.getElementById("status")?.textContent || "").includes("本页译文已更新") ? "done" : ""`, "retranslate page 4", 60000);
  await reveal();
  assertStable(await settled(4, page4Needles), beforeSave, "retranslate keeps bids");
  const saved = (await posts()).filter((body) => Number(body.page) === 4);
  assert.ok(saved.length >= 1, "retranslate writes the page");
  const pairBids = saved[saved.length - 1].pairs.map((pair) => pair.bid).filter(Boolean);
  assert.ok(pairBids.length > 0);
  assert.equal(pairBids.every((bid) => isBid(bid)), true, "saved pairs carry bids");
  assert.ok(pairBids.includes("b1-p4-t010gv1t"), "saved page 4 keeps the paragraph bid");

  await send("Page.navigate", { url: viewerFor("cache") });
  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    if (!/\\/\\s*15/.test(pager)) return "";
    const rows = [...document.querySelectorAll('#readerFlow .rf-block[data-block-id]')];
    if (rows.length < 3) return "";
    const expected = ${JSON.stringify(expectedById)};
    const ok = rows.every((el) => !el.dataset.blockId || el.dataset.bid === expected[el.dataset.blockId]);
    return ok ? "cache" : "";
  })()`, "cached layout bids match a fresh assign", 60000);
});
