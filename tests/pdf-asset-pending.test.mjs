// Reopening a stored layout used to paint 「表见原文第 N 页（点击查看）」
// before the page raster came back. The hold is a same-size pending box
// until that crop has actually failed.
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
import { cacheableLayout, currentLayoutVersion } from "../lib/pdf-layout-client.js";
import { isSkipOnlyPage, sourceReuseHash } from "../lib/pdf-library.js";
import { stampLayoutBids } from "../lib/pdf-block-id.js";
import { CROP_SCALE, translatableBlocks } from "../lib/pdf-blocks.js";
import { assetDisplayCssSize } from "../lib/pdf-formula-raster.js";

const PREFIXES = ["oi-asset-pending-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const PAGES = [7, 23, 24, 26];
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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

test("a stored figure waits in its own box and the fallback button waits for a failed crop", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const hold = viewer.slice(viewer.indexOf("function visualCropPendingBox"), viewer.indexOf("function markVisualCropsFailed"));
  assert.match(hold, /oi-pdf-asset-pending/);
  assert.match(hold, /aria-busy/);
  assert.match(hold, /aspect-ratio/);
  assert.match(hold, /visualDisplayCssSize/);
  assert.match(hold, /CROP_SCALE/);
  assert.doesNotMatch(hold, /见原文|createElement\("button"\)/);
  assert.match(viewer, /visualCropStillPending\(block, shownPage\)/);
  assert.match(viewer, /armStoredVisualCrops\(page, laid\)/);
  const stored = cacheableLayout({
    page: 7,
    blocks: [{ id: "fig", label: "figure", bbox: [0, 0, 1, 1], imageUrl: "data:image/png;base64,aa", visualCropFailed: true }]
  });
  assert.equal(stored.blocks[0].visualCropFailed, undefined);
  assert.equal(stored.blocks[0].imageUrl, undefined);
});

function pairFrom(block) {
  const tokens = [...String(block.text || "").matchAll(/⟦f\d+⟧/g)].map((match) => match[0]).join("");
  return {
    id: block.id,
    sourceId: block.sourceId,
    ...(block.bid ? { bid: block.bid } : {}),
    text: block.text,
    sourceText: block.sourceText || block.text,
    translation: `旧译${sourceReuseHash(block.text)}${tokens}`,
    targetLang: "zh-CN",
    provider: "mymemory"
  };
}

async function dpoLibrary() {
  const { textLayerToBlocks } = await import("../lib/pdf-text-layer.js");
  const { getDocument, GlobalWorkerOptions } = await import("../pdf/vendor/pdf.min.mjs");
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const version = await currentLayoutVersion();
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(dpoPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pages = [];
  const visuals = [];
  try {
    for (const number of PAGES) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = stampLayoutBids(number, textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      }));
      const layout = cacheableLayout({
        ...built,
        page: number,
        blocks: built.blocks,
        layoutVersion: version
      });
      layout.layoutVersion = version;
      const skip = isSkipOnlyPage(built.blocks);
      pages.push({
        page: number,
        pairs: skip ? [] : translatableBlocks(built.blocks).map(pairFrom),
        layout,
        layoutVersion: version,
        ...(skip ? { skipped: true } : {})
      });
      for (const block of built.blocks) {
        if (block.label !== "figure" && block.label !== "table") continue;
        if (!Array.isArray(block.bbox) || block.bbox.length < 4) continue;
        const sized = assetDisplayCssSize({
          block,
          pageWidth: viewport.width,
          pageHeight: viewport.height,
          rasterWidth: Math.max(1, Math.floor(viewport.width * CROP_SCALE)),
          rasterHeight: Math.max(1, Math.floor(viewport.height * CROP_SCALE))
        });
        visuals.push({
          page: number,
          id: String(block.id || ""),
          label: block.label,
          cap: sized.layoutCapPx,
          cssHeight: sized.cssHeight
        });
      }
    }
  } finally {
    await doc.destroy();
  }
  return { pageCount: 27, pages, visuals };
}

function serveRepo(library) {
  const payload = JSON.stringify(library);
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/oi-fixture-library.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(payload);
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

test("reopening DPO figures holds the crop box and does not flash the page button", { timeout: 240000 }, async (t) => {
  assert.equal(existsSync(dpoPath), true, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf is missing");
  const built = await dpoLibrary();
  for (const page of PAGES) {
    assert.ok(built.visuals.some((item) => item.page === page), `page ${page} has no figure or table`);
  }
  const server = await serveRepo({ pageCount: built.pageCount, pages: built.pages });
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-asset-pending-"));
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
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const origFetch = window.fetch.bind(window);
      window.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("/v1/library/")) {
          if (init && String(init.method || "GET").toUpperCase() === "POST") {
            return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
          }
          return origFetch("/oi-fixture-library.json");
        }
        if (url.includes("127.0.0.1:8765")) return new Response("ok", { status: 200 });
        return origFetch(input, init);
      };
      globalThis.__oiAssetSlot = [];
      const slotSeen = new Set();
      const slotHooked = new WeakSet();
      const measureSlot = (node, phase) => {
        const host = node.closest("[data-block-id]");
        if (!host || !host.isConnected) return;
        const page = Number(host.dataset.page) || 0;
        const id = host.dataset.blockId || "";
        const height = host.getBoundingClientRect().height;
        const key = phase + ":" + page + ":" + id + ":" + height.toFixed(2);
        if (slotSeen.has(key)) return;
        slotSeen.add(key);
        globalThis.__oiAssetSlot.push({ phase, page, id, height });
      };
      const scanSlots = () => {
        document.querySelectorAll("#readerFlow .oi-pdf-asset-pending").forEach((node) => {
          requestAnimationFrame(() => measureSlot(node, "pending"));
        });
        document.querySelectorAll("#readerFlow .oi-pdf-asset-crop").forEach((img) => {
          const take = () => requestAnimationFrame(() => measureSlot(img, "image"));
          if (img.complete && img.naturalWidth > 0) take();
          else if (!slotHooked.has(img)) {
            slotHooked.add(img);
            img.addEventListener("load", take, { once: true });
          }
        });
      };
      const armSlots = () => {
        const root = document.documentElement;
        if (!root || root.dataset.oiSlotWatch) return;
        root.dataset.oiSlotWatch = "1";
        new MutationObserver(scanSlots).observe(root, { childList: true, subtree: true });
        scanSlots();
      };
      armSlots();
      document.addEventListener("DOMContentLoaded", armSlots);
      globalThis.chrome = {
        storage: { local: { get() { return Promise.resolve({}); }, set() { return Promise.resolve(); } } },
        runtime: {
          getURL() { return new URL("./vendor/pdf.worker.min.mjs", location.href).href; },
          sendMessage(message) {
            const type = message && message.type;
            if (type === "OI_GET_SETTINGS") {
              return Promise.resolve({ settings: { pdfAutoTranslate: false, batchSize: 8, targetLang: "zh-CN", provider: "mymemory", pdfLayout: { mode: "" }, features: { pdf: true } } });
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  const src = `${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?oiAuto=asset-pending&src=${encodeURIComponent(src)}` });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const wanted = new Set(built.visuals.map((item) => `${item.page}:${item.id}`));
  const read = `(() => {
    const log = globalThis.__oiAssetPaint || [];
    const buttons = [...document.querySelectorAll("#readerFlow .oi-pdf-asset-fallback")].map((node) => node.textContent || "");
    return {
      log,
      slots: globalThis.__oiAssetSlot || [],
      buttons,
      pending: document.querySelectorAll("#readerFlow .oi-pdf-asset-pending").length,
      phase: document.getElementById("docStatus")?.dataset.state || "",
      status: document.getElementById("status")?.textContent || ""
    };
  })()`;
  let snap = null;
  const by = Date.now() + 180000;
  while (Date.now() < by) {
    snap = await evaluate(read);
    const log = snap?.log || [];
    const early = log.find((row) => (
      wanted.has(`${row.page}:${row.id}`) && row.kind === "fallback" &&
      !log.some((prev) => prev.page === row.page && prev.id === row.id && prev.kind === "image")
    ));
    if (early) assert.fail(`fallback button painted before the crop ${JSON.stringify(early)} ${JSON.stringify(snap.buttons)}`);
    const covered = built.visuals.every((item) => log.some((row) => (
      row.page === item.page && row.id === item.id && row.kind === "image"
    )));
    const held = built.visuals.every((item) => log.some((row) => (
      row.page === item.page && row.id === item.id && row.kind === "pending" && row.aspect
    )));
    const slots = snap?.slots || [];
    const sized = built.visuals.every((item) => (
      slots.some((row) => row.page === item.page && row.id === item.id && row.phase === "pending") &&
      slots.some((row) => row.page === item.page && row.id === item.id && row.phase === "image")
    ));
    if (covered && held && sized) break;
    await sleep(200);
  }
  assert.ok(snap, "reader did not report asset paints");
  for (const item of built.visuals) {
    const rows = (snap.log || []).filter((row) => row.page === item.page && row.id === item.id);
    assert.ok(rows.length, `page ${item.page} ${item.id} never painted ${JSON.stringify(snap)}`);
    assert.equal(rows[0].kind, "pending", JSON.stringify(rows));
    assert.equal(rows.some((row) => row.kind === "fallback"), false, JSON.stringify(rows));
    assert.equal(rows.some((row) => row.kind === "image"), true, JSON.stringify(rows));
    assert.equal(rows[0].width, `min(100%, ${item.cap}px)`, JSON.stringify(rows[0]));
    assert.equal(rows[0].aspect, `${item.cap} / ${item.cssHeight}`, JSON.stringify(rows[0]));
    const slots = (snap.slots || []).filter((row) => row.page === item.page && row.id === item.id);
    const before = slots.filter((row) => row.phase === "pending").at(-1)?.height;
    const after = slots.filter((row) => row.phase === "image").at(-1)?.height;
    assert.equal(typeof before, "number", JSON.stringify(slots));
    assert.equal(typeof after, "number", JSON.stringify(slots));
    assert.ok(Math.abs(before - after) <= 1, `page ${item.page} ${item.id} slot ${before} -> ${after}`);
  }
  assert.equal((snap.buttons || []).some((text) => text.includes("见原文")), false, JSON.stringify(snap.buttons));
});
