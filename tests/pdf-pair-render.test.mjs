// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// arXiv v7, https://arxiv.org/pdf/1706.03762v7
// sha256 bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PAIR_TMP_PREFIXES = ["oi-pair-render-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PAIR_TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fixture = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");

async function assertOpenedOnFullDocument(evaluate, waitFor) {
  const raw = await waitFor(`(() => {
    const status = document.getElementById("status")?.textContent || "";
    if (!status.includes("无法翻译") || !status.includes("扩展")) return "";
    return JSON.stringify({
      folds: document.querySelectorAll("#readerFlow .rf-untranslated").length,
      ranges: document.querySelectorAll("#readerFlow .rf-q").length,
      untranslated: (document.getElementById("readerFlow")?.innerText || "").includes("未翻译"),
      pages: document.querySelectorAll("#pages .pdf-page").length,
      label: (document.getElementById("translatePage")?.textContent || "").trim(),
      hidden: document.getElementById("translatePage")?.hidden === true,
      restore: (document.getElementById("restoreOriginal")?.textContent || "").trim(),
      retranslate: (document.getElementById("retranslatePage")?.textContent || "").trim(),
      doc: document.querySelector("#docStatus .doc-text")?.textContent || "",
      status
    });
  })()`, "打开后说明运行环境不可用");
  const opened = JSON.parse(raw);
  assert.equal(opened.pages, 15, "Attention v7 is 15 pages");
  assert.equal(opened.folds, 0, "不再渲染未翻译行");
  assert.equal(opened.ranges, 1, "没有版面的排队页收成一行");
  assert.equal(opened.untranslated, false, "不出现未翻译");
  assert.match(opened.doc, /已译 0 \/ 15 页|正在读取 PDF/);
  assert.equal(opened.label, "翻译", "失败后主按钮回到翻译");
  assert.equal(opened.hidden, false, "失败后不留在停止");
  assert.equal(opened.restore, "原文");
  assert.equal(opened.retranslate, "重译本页");
  assert.match(opened.status, /chrome:\/\/extensions/);
  return opened;
}

async function useCurrentPageScope() {}

function explicitShotDir() {
  const value = String(process.env.OI_PAIR_SHOTS_DIR || "").trim();
  return value;
}

function assertDirectoryWritable(dir) {
  mkdirSync(dir, { recursive: true });
  const probe = join(dir, `.oi-pair-write-${process.pid}`);
  try {
    writeFileSync(probe, "x");
  } finally {
    rmSync(probe, { force: true });
  }
}
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
    "--force-device-scale-factor=1",
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

function decodePng(buf) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (offset + 8 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    offset += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || !channels) throw new Error(`unsupported png ${bitDepth}/${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let src = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const row = Buffer.from(raw.subarray(src, src + stride));
    src += stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? row[i - channels] : 0;
      const up = prev[i];
      const ul = i >= channels ? prev[i - channels] : 0;
      let value = row[i];
      if (filter === 1) value = (value + left) & 255;
      else if (filter === 2) value = (value + up) & 255;
      else if (filter === 3) value = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) {
        const estimate = left + up - ul;
        const pa = Math.abs(estimate - left);
        const pb = Math.abs(estimate - up);
        const pc = Math.abs(estimate - ul);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        value = (value + predictor) & 255;
      }
      row[i] = value;
    }
    prev = row;
    for (let x = 0; x < width; x += 1) {
      const i = x * channels;
      const o = (y * width + x) * 4;
      rgba[o] = row[i];
      rgba[o + 1] = row[i + 1];
      rgba[o + 2] = row[i + 2];
      rgba[o + 3] = channels === 4 ? row[i + 3] : 255;
    }
  }
  return { width, height, rgba };
}

function installProbe() {
  const px = (style, name) => {
    const value = parseFloat(style.getPropertyValue(name) || style[name]);
    return Number.isFinite(value) ? value : null;
  };
  const color = (value) => {
    const match = String(value || "").match(/rgba?\(([^)]+)\)/);
    if (!match) {
      const hex = String(value || "").trim().match(/^#([0-9a-f]{6})$/i);
      if (!hex) return null;
      return [
        parseInt(hex[1].slice(0, 2), 16),
        parseInt(hex[1].slice(2, 4), 16),
        parseInt(hex[1].slice(4, 6), 16),
        1
      ];
    }
    const parts = match[1].split(",").map((part) => parseFloat(part.trim()));
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  window.__oi = {
    color,
    token(name) {
      return getComputedStyle(document.body).getPropertyValue(name).trim();
    },
    center(el) {
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, w: box.width, h: box.height };
    },
    pagePt(pageEl) {
      const zoom = parseFloat(document.getElementById("zoomLabel")?.textContent) / 100 || 1;
      const width = parseFloat(pageEl.style.width) / zoom;
      const parts = String(pageEl.style.aspectRatio || "").split("/").map((part) => parseFloat(part.trim()));
      const height = parts[0] > 0 && parts[1] > 0 ? width * (parts[1] / parts[0]) : 0;
      return { width, height, zoom };
    },
    rectBox(rect, outset) {
      const pageEl = document.querySelector(`#pages .pdf-page[data-page="${rect.p}"]`);
      if (!pageEl) return null;
      const page = pageEl.getBoundingClientRect();
      const pt = window.__oi.pagePt(pageEl);
      return {
        x: page.left + (rect.x / pt.width) * page.width - outset,
        y: page.top + (rect.y / pt.height) * page.height - outset,
        w: (rect.w / pt.width) * page.width + outset * 2,
        h: (rect.h / pt.height) * page.height + outset * 2
      };
    },
    sourceAnchor(rect) {
      const pages = document.getElementById("pages");
      const pageEl = document.querySelector(`#pages .pdf-page[data-page="${rect.p}"]`);
      if (!pages || !pageEl) return null;
      const page = pageEl.getBoundingClientRect();
      const pane = pages.getBoundingClientRect();
      const pt = window.__oi.pagePt(pageEl);
      const top = page.top + (rect.y / pt.height) * page.height;
      const height = (rect.h / pt.height) * page.height;
      return {
        top,
        bottom: top + height,
        pagesTop: pane.top,
        pagesBottom: pane.bottom,
        client: pages.clientHeight,
        scrollTop: pages.scrollTop,
        max: Math.max(0, pages.scrollHeight - pages.clientHeight)
      };
    },
    firstRect(pairId) {
      const node = document.querySelector(`[data-pair-id="${CSS.escape(pairId)}"]:not([data-pair-part="inline"])`);
      const rects = JSON.parse(node?.dataset.srcRects || "[]");
      return rects[0] || null;
    },
    pseudo(el) {
      const before = getComputedStyle(el, "::before");
      const after = getComputedStyle(el, "::after");
      const read = (style) => ({
        width: px(style, "width"),
        top: px(style, "top"),
        bottom: px(style, "bottom"),
        left: px(style, "left"),
        right: px(style, "right"),
        inlineStart: px(style, "inset-inline-start"),
        bg: color(style.backgroundColor),
        radii: [
          px(style, "border-top-left-radius"),
          px(style, "border-top-right-radius"),
          px(style, "border-bottom-right-radius"),
          px(style, "border-bottom-left-radius")
        ]
      });
      return { before: read(before), after: read(after) };
    },
    hit(el) {
      const style = getComputedStyle(el, "::after");
      return { w: px(style, "width"), h: px(style, "height"), boxH: el.getBoundingClientRect().height, boxW: el.getBoundingClientRect().width };
    }
  };
  return true;
}

test("Attention pairing, follow, and swap match the phase-1 brief", { timeout: 300000 }, async (t) => {
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
  const requestedShots = explicitShotDir();
  if (requestedShots) assertDirectoryWritable(requestedShots);
  handle.server = await serveRepo();
  const server = handle.server;
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-pair-render-"));
  const ownedDir = handle.ownedDir;
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  handle.userDataDir = userDataDir;
  const scratchDir = join(ownedDir, "scratch");
  const downloadDir = join(ownedDir, "downloads");
  const shotDir = requestedShots || join(ownedDir, "shots");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  mkdirSync(downloadDir);
  if (!requestedShots) mkdirSync(shotDir, { recursive: true });
  const address = server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  const viewer = `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
    await send("Page.enable");
    await send("Runtime.enable");
    await cdp.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: downloadDir,
      eventsEnabled: true
    });
    await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true
      });
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails;
        throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
      }
      return result.result?.value;
    };
    const waitFor = async (expression, label, timeoutMs = 30000) => {
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
    const wheelAt = async (x, y, deltaY) => {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: 0, deltaY });
    };
    const keyTap = async (key, code, vk, extra = {}) => {
      const down = {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode: vk,
        nativeVirtualKeyCode: vk,
        modifiers: extra.modifiers || 0,
        text: extra.text || ""
      };
      await send("Input.dispatchKeyEvent", down);
      await send("Input.dispatchKeyEvent", { ...down, type: "keyUp" });
    };
    const frames = (n = 2) => evaluate(`new Promise((done) => {
      let left = ${n};
      const step = () => { left -= 1; if (left <= 0) done(true); else requestAnimationFrame(step); };
      requestAnimationFrame(step);
    })`);
    const touchAt = async (x, y, move) => {
      await send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y, id: 1 }]
      });
      if (move) {
        await send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: move.x, y: move.y, id: 1 }]
        });
      }
      await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
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
      return point;
    };
    const shot = async (name) => {
      const dir = explicitShotDir() || join(ownedDir, "shots");
      mkdirSync(dir, { recursive: true });
      const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(join(dir, `${name}.png`), Buffer.from(data, "base64"));
      return dir;
    };
    const near = (actual, expected, slop, label) => {
      assert.ok(Math.abs(actual - expected) <= slop, `${label}: ${actual} vs ${expected} ±${slop}`);
    };

    await send("Page.navigate", { url: viewer });
    await waitFor(`(() => {
      const pager = document.getElementById("pager")?.textContent || "";
      const next = document.getElementById("next");
      return /\\/\\s*15/.test(pager) && next && !next.disabled ? pager : "";
    })()`, "Attention PDF open");
    await evaluate(`(${installProbe.toString()})()`);
    await waitFor(`document.querySelector("#readerFlow .rf-block[data-pair-id]") ? "p1" : ""`, "page 1 pairs");
    await assertOpenedOnFullDocument(evaluate, waitFor);

    const fresh = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      checked: document.getElementById("followSwitch")?.getAttribute("aria-checked") || "",
      stored: localStorage.getItem("reader.follow")
    }))()`);
    assert.equal(fresh.follow, "on", "FL1 fresh data-follow");
    assert.equal(fresh.checked, "true", "FL1 fresh aria-checked");

    await clickSelector("#followSwitch");
    await frames(2);
    const turnedOff = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
    assert.equal(turnedOff, "off", "FL1 toggle off");
    await send("Page.reload", { ignoreCache: true });
    await waitFor(`(() => {
      const pager = document.getElementById("pager")?.textContent || "";
      return /\\/\\s*15/.test(pager) ? pager : "";
    })()`, "reload after follow off");
    await evaluate(`(${installProbe.toString()})()`);
    await waitFor(`document.querySelector("#readerFlow .rf-block[data-pair-id]") ? "p1" : ""`, "page 1 after reload");
    const reloadedOff = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      checked: document.getElementById("followSwitch")?.getAttribute("aria-checked") || "",
      stored: localStorage.getItem("reader.follow")
    }))()`);
    assert.equal(reloadedOff.follow, "off", "FL1 reload stays off");
    assert.equal(reloadedOff.checked, "false", "FL1 reload aria-checked");
    assert.equal(reloadedOff.stored, "0", "FL1 stored off");

    await evaluate(`document.getElementById("followSwitch").focus()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    const turnedOn = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      stored: localStorage.getItem("reader.follow")
    }))()`);
    assert.equal(turnedOn.follow, "on", "f turns follow on");
    assert.equal(turnedOn.stored, "1", "toggle on stores 1");

    await useCurrentPageScope(clickSelector, waitFor);
    await clickSelector("#next");
    await waitFor(`document.querySelector('#readerFlow [data-src-page="2"][data-pair-id]') ? "p2" : ""`, "page 2 pairs", 40000);
    await clickSelector("#prev");
    await waitFor(`document.querySelector('#readerFlow [data-src-page="1"][data-pair-id]') ? "p1" : ""`, "page 1 pairs again", 40000);
    await evaluate(`document.getElementById("translateScroll").scrollTop = 320`);
    await frames(3);
    assert.ok(await evaluate(`document.getElementById("translateScroll").scrollTop`) > 40, "当前页 translation scrolled before next");
    await clickSelector("#next");
    await waitFor(`document.querySelector('#readerFlow [data-src-page="2"][data-pair-id]') ? "p2" : ""`, "page 2 pairs after scroll", 40000);
    await frames(4);
    const pageChange = await evaluate(`(() => {
      const pane = document.getElementById("translateScroll");
      const paneBox = pane.getBoundingClientRect();
      const bar = pane.dataset.capsuleMode === "bar" ? 44 : 0;
      const line = pane.scrollTop + bar + (paneBox.height - bar) * 0.3;
      const blocks = [...document.querySelectorAll("#readerFlow .rf-block")].map((el) => {
        const box = el.getBoundingClientRect();
        return {
          id: el.dataset.pairId || "",
          top: pane.scrollTop + (box.top - paneBox.top),
          bottom: pane.scrollTop + (box.bottom - paneBox.top),
          current: el.classList.contains("is-pair-current")
        };
      }).filter((item) => item.bottom > item.top);
      let hit = blocks.find((item) => item.top <= line && item.bottom >= line);
      if (!hit) hit = blocks.find((item) => item.top > line) || blocks[blocks.length - 1] || null;
      return {
        id: hit?.id || "",
        current: Boolean(hit?.current),
        pager: document.getElementById("pager")?.textContent || ""
      };
    })()`);
    assert.ok(pageChange.id, "page 2 anchor has a pair");
    assert.equal(pageChange.current, true, "page change highlights the anchor block");
    const stayed = await evaluate(`(() => ({
      scroll: document.getElementById("translateScroll").scrollTop,
      pager: document.getElementById("pager")?.textContent || "",
      capsule: document.getElementById("pageCapsule")?.dataset.srcPage || ""
    }))()`);
    assert.ok(stayed.scroll > 40, "已载入的页再翻页时译文不滚回顶部");
    assert.equal(stayed.pager, `${stayed.capsule} / 15`, "toolbar stays on the capsule");

    await clickSelector("#prev");
    await waitFor(`document.querySelector('#readerFlow [data-src-page="1"][data-pair-id]') ? "p1" : ""`, "R3b page 1", 40000);
    await evaluate(`document.getElementById("translateScroll").scrollTop = 320`);
    await frames(3);
    await clickSelector("#next");
    await waitFor(`document.querySelector('#readerFlow [data-src-page="2"][data-pair-id]') ? "p2" : ""`, "R3b page 2 again", 40000);
    await frames(4);
    const pageReturn = await evaluate(`(() => {
      const pane = document.getElementById("translateScroll");
      const paneBox = pane.getBoundingClientRect();
      const bar = pane.dataset.capsuleMode === "bar" ? 44 : 0;
      const line = pane.scrollTop + bar + (paneBox.height - bar) * 0.3;
      const blocks = [...document.querySelectorAll("#readerFlow .rf-block")].map((el) => {
        const box = el.getBoundingClientRect();
        return {
          id: el.dataset.pairId || "",
          top: pane.scrollTop + (box.top - paneBox.top),
          bottom: pane.scrollTop + (box.bottom - paneBox.top),
          current: el.classList.contains("is-pair-current")
        };
      }).filter((item) => item.bottom > item.top);
      let hit = blocks.find((item) => item.top <= line && item.bottom >= line);
      if (!hit) hit = blocks.find((item) => item.top > line) || blocks[blocks.length - 1] || null;
      return { id: hit?.id || "", current: Boolean(hit?.current) };
    })()`);
    assert.ok(pageReturn.id, "R3b anchor has a pair");
    assert.equal(pageReturn.current, true, "R3b highlights the anchor block on return");

    for (let page = 3; page <= 5; page += 1) {
      await clickSelector("#next");
      await waitFor(`document.querySelector('#readerFlow [data-src-page="${page}"][data-pair-id]') ? "p${page}" : ""`, `page ${page} pairs`, 40000);
    }
    await waitFor(`(() => {
      const pages = new Set([...document.querySelectorAll("#readerFlow .rf-block[data-pair-id]")].map((el) => el.dataset.srcPage || el.dataset.page));
      return ["1", "2", "3", "4", "5"].every((page) => pages.has(page)) ? "ready" : "";
    })()`, "全文 pages 1-5", 20000);
    const stayedOnPage = await evaluate(`(() => ({
      capsule: document.getElementById("pageCapsule")?.dataset.srcPage || "",
      pager: document.getElementById("pager")?.textContent || "",
      target: document.getElementById("retranslatePage")?.dataset.page || ""
    }))()`);
    assert.equal(stayedOnPage.capsule, "5", "全文 keeps the capsule on page 5");
    assert.equal(stayedOnPage.pager, "5 / 15", "全文 keeps the toolbar on page 5");
    assert.equal(stayedOnPage.target, "5", "全文 keeps retranslate on page 5");
    await evaluate(`document.body.focus()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(3);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "resume follow after paging");

    const readNav = () => evaluate(`(() => {
      const pages = document.getElementById("pages");
      const pane = pages.getBoundingClientRect();
      const mid = (pane.top + pane.bottom) / 2;
      let source = 0;
      let best = Infinity;
      for (const el of document.querySelectorAll("#pages .pdf-page")) {
        const box = el.getBoundingClientRect();
        if (box.height < 1) continue;
        const dist = Math.abs((box.top + box.bottom) / 2 - mid);
        if (dist < best) {
          best = dist;
          source = Number(el.dataset.page) || 0;
        }
      }
      return {
        source,
        label: document.getElementById("sourcePageLabel")?.textContent || "",
        pager: document.getElementById("pager")?.textContent || "",
        capsule: document.getElementById("pageCapsule")?.dataset.srcPage || "",
        target: document.getElementById("retranslatePage")?.dataset.page || "",
        follow: document.querySelector(".workspace")?.dataset.follow || "",
        prev: document.getElementById("prev")?.disabled === true,
        next: document.getElementById("next")?.disabled === true
      };
    })()`);
    const parkSourceAt4 = async () => {
      await evaluate(`(() => {
        const el = document.querySelector('#readerFlow .rf-block[data-pair-id][data-src-page="3"]');
        const pane = document.getElementById("translateScroll");
        const paneBox = pane.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const bar = pane.dataset.capsuleMode === "bar" ? 44 : 0;
        const line = paneBox.top + bar + (paneBox.height - bar) * 0.3;
        pane.scrollTop += box.top - line;
      })()`);
      await frames(4);
      await evaluate(`document.querySelector('#pages .pdf-page[data-page="4"]').scrollIntoView({ block: "start", behavior: "auto" })`);
      await frames(4);
      await sleep(200);
    };
    const burstPages = async (mode, follow, label) => {
      await parkSourceAt4();
      const start = await readNav();
      assert.equal(start.follow, follow, `${label} follow starts ${follow}`);
      assert.equal(start.source, 4, `${label} starts on source page 4`);
      assert.equal(start.label, "第 4/15 页", `${label} source label starts on page 4`);
      assert.equal(start.capsule, "3", `${label} capsule is page 3`);
      assert.equal(start.pager, "3 / 15", `${label} toolbar is the capsule page`);
      assert.equal(start.target, "3", `${label} retranslate target is the toolbar page`);
      assert.equal(start.prev, false, `${label} prev is enabled on source page 4`);
      assert.equal(start.next, false, `${label} next is enabled on source page 4`);
      for (let step = 1; step <= 4; step += 1) {
        if (mode === "click") await clickSelector("#next");
        else {
          await evaluate(`document.activeElement?.blur()`);
          await keyTap("ArrowRight", "ArrowRight", 39);
        }
        await sleep(500);
        const row = await readNav();
        assert.equal(row.source, 4 + step, `${label} source advances to ${4 + step}`);
        assert.equal(row.label, `第 ${4 + step}/15 页`, `${label} source label advances to ${4 + step}`);
        assert.equal(row.pager, "3 / 15", `${label} toolbar stays on the capsule`);
        assert.equal(row.capsule, "3", `${label} capsule stays`);
        assert.equal(row.target, "3", `${label} retranslate target stays`);
        assert.equal(row.prev, false, `${label} prev stays enabled`);
        assert.equal(row.next, 4 + step >= 15, `${label} next follows the source page`);
      }
    };
    await burstPages("click", "on", "follow on next");
    await evaluate(`document.activeElement?.blur()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "follow on before the arrow burst");
    await burstPages("key", "on", "follow on arrow");
    await evaluate(`document.activeElement?.blur()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "off", "follow off before the second paging burst");
    await burstPages("click", "off", "follow off next");
    await burstPages("key", "off", "follow off arrow");
    await evaluate(`document.activeElement?.blur()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "follow restored after paging bursts");

    const centerIn = async (selector) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    const wheelUntil = async (point, read, goal, step) => {
      let last = await read();
      for (let i = 0; i < 48 && !goal(last); i += 1) {
        await wheelAt(point.x, point.y, step(last));
        await frames(2);
        last = await read();
      }
      return last;
    };
    await evaluate(`document.activeElement?.blur()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "off", "F1 follow is off");
    await evaluate(`document.querySelector('#pages .pdf-page[data-page="1"]').scrollIntoView({ block: "start", behavior: "auto" })`);
    await evaluate(`document.getElementById("translateScroll").scrollTop = 0`);
    await frames(4);
    const parkedAt1 = await readNav();
    assert.equal(parkedAt1.source, 1, "F1 source starts on page 1");
    assert.equal(parkedAt1.capsule, "1", "F1 translation starts at the top");
    assert.equal(parkedAt1.prev, true, "F1 prev is disabled on source page 1");
    const translationWheel = await centerIn("#translateScroll");
    const atCapsule4 = await wheelUntil(
      translationWheel,
      readNav,
      (row) => row.capsule === "4",
      (row) => (Number(row.capsule) > 4 ? -160 : 280)
    );
    assert.equal(atCapsule4.capsule, "4", "F1 capsule is page 4");
    assert.equal(atCapsule4.pager, "4 / 15", "F1 toolbar follows the capsule");
    assert.equal(atCapsule4.source, 1, "F1 source stays on page 1");
    assert.equal(atCapsule4.prev, true, "F1 prev stays disabled while the source is on page 1");
    const page4Point = await evaluate(`(() => {
      const pane = document.getElementById("translateScroll").getBoundingClientRect();
      const el = [...document.querySelectorAll('#readerFlow .rf-block[data-pair-id][data-src-page="4"]')].find((node) => {
        const box = node.getBoundingClientRect();
        return box.bottom > pane.top + 10 && box.top < pane.bottom - 10 && box.width > 16;
      });
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const top = Math.max(box.top, pane.top + 8);
      const bottom = Math.min(box.bottom, pane.bottom - 8);
      return { x: Math.min(Math.max(box.left + 28, pane.left + 12), pane.right - 12), y: (top + bottom) / 2 };
    })()`);
    assert.ok(page4Point, "F1a page 4 block");
    await mouseClick(page4Point.x, page4Point.y);
    await frames(4);
    const jumped = await readNav();
    assert.equal(jumped.source, 4, "F1a source follows the block to page 4");
    assert.equal(jumped.prev, false, "F1a prev is enabled");
    assert.equal(jumped.pager, "4 / 15", "F1a toolbar stays on the capsule");
    await clickSelector("#prev");
    await frames(4);
    assert.equal((await readNav()).source, 3, "F1a prev goes to source page 3");
    await evaluate(`document.querySelector('#pages .pdf-page[data-page="1"]').scrollIntoView({ block: "start", behavior: "auto" })`);
    await frames(4);
    const backTo1 = await readNav();
    assert.equal(backTo1.source, 1, "F1b source returns to page 1");
    assert.equal(backTo1.capsule, "4", "F1b capsule stays on page 4");
    assert.equal(backTo1.prev, true, "F1b prev is disabled on source page 1");
    await evaluate(`document.activeElement?.blur()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(4);
    const followed = await readNav();
    assert.equal(followed.follow, "on", "F1b follow turns on");
    assert.equal(followed.source, 4, "F1b follow brings the source to page 4");
    assert.equal(followed.prev, false, "F1b prev is enabled");
    await clickSelector("#prev");
    await frames(4);
    assert.equal((await readNav()).source, 3, "F1b prev goes to source page 3");
    let lastPage = await readNav();
    for (let i = 0; i < 20 && lastPage.source < 15; i += 1) {
      await clickSelector("#next");
      await frames(2);
      lastPage = await readNav();
    }
    assert.equal(lastPage.source, 15, "F1c source reaches page 15");
    assert.equal(lastPage.next, true, "F1c next is disabled on the last page");
    const sourceWheel = await centerIn("#pages");
    const backTo12 = await wheelUntil(
      sourceWheel,
      readNav,
      (row) => row.source === 12,
      (row) => (row.source > 12 ? -280 : 280)
    );
    assert.equal(backTo12.source, 12, "F1c wheel returns the source to page 12");
    assert.equal(backTo12.next, false, "F1c next is enabled");
    await evaluate(`document.activeElement?.blur()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "follow restored after F1");

    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    const centerOf = async (selector) => evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    const armJump = async () => {
      const point = await evaluate(`(() => {
        const paneEl = document.getElementById("translateScroll");
        const pane = paneEl.getBoundingClientRect();
        const el = document.querySelector('#readerFlow .rf-block.oi-pdf-p[data-label="text"][data-pair-id][data-src-page="3"]')
          || document.querySelector('#readerFlow .rf-block.oi-pdf-p[data-label="text"][data-pair-id]');
        if (!el) {
          const labels = [...document.querySelectorAll("#readerFlow .rf-block")].slice(0, 8).map((node) => node.dataset.label + "@" + (node.dataset.srcPage || ""));
          return { missing: labels.join(",") };
        }
        const box0 = el.getBoundingClientRect();
        const bar = paneEl.dataset.capsuleMode === "bar" ? 44 : 0;
        const line = pane.top + bar + (pane.height - bar) * 0.45;
        paneEl.scrollTop += box0.top - line;
        const box = el.getBoundingClientRect();
        const top = Math.max(box.top, pane.top + 8);
        const bottom = Math.min(box.bottom, pane.bottom - 8);
        if (bottom - top < 8) return { short: bottom - top };
        return {
          x: Math.min(Math.max(box.left + 24, pane.left + 12), pane.right - 12),
          y: (top + bottom) / 2
        };
      })()`);
      assert.ok(point?.x, `visible paragraph for the jump lock ${JSON.stringify(point)}`);
      await mouseClick(point.x, point.y);
      await frames(2);
    };
    const hitPane = async (x, y) => evaluate(`(() => {
      const el = document.elementFromPoint(${x}, ${y});
      return {
        translation: Boolean(el && el.closest(".pane-translate")),
        source: Boolean(el && el.closest("#pages"))
      };
    })()`);
    await armJump();
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.jumpLock || ""`), "1", "T3 jump lock is armed");
    const translationTouch = await evaluate(`(() => {
      const pane = document.getElementById("translateScroll");
      const paneBox = pane.getBoundingClientRect();
      const el = [...document.querySelectorAll("#readerFlow .rf-block[data-pair-id]")].find((node) => {
        const box = node.getBoundingClientRect();
        return box.bottom > paneBox.top + 16 && box.top < paneBox.bottom - 16 && box.width > 20 && box.height > 12;
      });
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const x = Math.min(Math.max(box.left + 24, paneBox.left + 12), paneBox.right - 12);
      const top = Math.max(box.top, paneBox.top + 8);
      const bottom = Math.min(box.bottom, paneBox.bottom - 8);
      const y = (top + bottom) / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || hit === pane || !pane.contains(hit)) return null;
      if (hit.closest("button, a, input, textarea")) return null;
      return { x, y };
    })()`);
    assert.ok(translationTouch, "T3 touch point is a translation block");
    const translationHit = await hitPane(translationTouch.x, translationTouch.y);
    assert.equal(translationHit.translation, true, "T3 touch point is in the translation pane");
    assert.equal(translationHit.source, false, "T3 touch point is not in the source pane");
    const followBeforeTouch = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
    await evaluate(`((x, y) => {
      const el = document.elementFromPoint(x, y);
      el.dispatchEvent(new Event("touchstart", { bubbles: true, cancelable: true }));
      return el === document.getElementById("translateScroll");
    })(${translationTouch.x}, ${translationTouch.y})`);
    const touchOnly = await evaluate(`((x, y) => document.elementFromPoint(x, y) !== document.getElementById("translateScroll"))(${translationTouch.x}, ${translationTouch.y})`);
    assert.equal(touchOnly, true, "T3 touchstart target is not the scroll surface");
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.jumpLock || ""`), "", "T3 translation touch unlocks");
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), followBeforeTouch, "T3 translation touch does not pause");
    await armJump();
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.jumpLock || ""`), "1", "T4 jump lock is armed");
    const sourceTap = await evaluate(`(() => {
      const pages = document.getElementById("pages");
      const pane = pages.getBoundingClientRect();
      const pageEl = [...pages.querySelectorAll(".pdf-page")].find((el) => {
        const box = el.getBoundingClientRect();
        return box.bottom > pane.top + 40 && box.top < pane.bottom - 40;
      });
      const box = pageEl.getBoundingClientRect();
      return {
        x: Math.min(Math.max(box.left + 3, pane.left + 4), pane.right - 4),
        y: Math.min(Math.max(box.top + 36, pane.top + 24), pane.bottom - 24)
      };
    })()`);
    const sourceHit = await hitPane(sourceTap.x, sourceTap.y);
    assert.equal(sourceHit.source, true, "T4 tap point is in the source pane");
    assert.equal(sourceHit.translation, false, "T4 tap point is not in the translation pane");
    await touchAt(sourceTap.x, sourceTap.y);
    await sleep(80);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), followBeforeTouch, "T4 source tap does not pause");
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.jumpLock || ""`), "", "T4 source tap unlocks");
    const switchTouch = await centerOf("#followSwitch");
    await touchAt(switchTouch.x, switchTouch.y);
    await sleep(80);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "off", "touch on the follow switch turns it off");
    await evaluate(`document.body.focus()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "follow restored after the switch tap");
    const sourceTouch = await centerOf("#pages");
    await touchAt(sourceTouch.x, sourceTouch.y, { x: sourceTouch.x, y: sourceTouch.y + 48 });
    await sleep(80);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "paused", "touch pan on the source content pauses");
    await evaluate(`document.body.focus()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "follow restored after the source pan");
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });

    await clickSelector("#followSwitch");
    await frames(2);
    const followOff = async (label) => {
      const state = await evaluate(`(() => ({
        follow: document.querySelector(".workspace")?.dataset.follow || "",
        checked: document.getElementById("followSwitch")?.getAttribute("aria-checked") || "",
        stored: localStorage.getItem("reader.follow")
      }))()`);
      assert.equal(state.follow, "off", `${label} follow stays off`);
      assert.equal(state.checked, "false", `${label} switch stays off`);
      assert.equal(state.stored, "0", `${label} stores 0`);
    };
    const scrollTranslationPage = async (page, paragraph) => evaluate(`(() => {
      const selector = ${paragraph ? `'.rf-block.oi-pdf-p[data-label="text"][data-pair-id][data-src-page="${page}"]'` : `'.rf-block[data-pair-id][data-src-page="${page}"]'`};
      const el = document.querySelector("#readerFlow " + selector);
      const pane = document.getElementById("translateScroll");
      if (!el || !pane) return null;
      const paneBox = pane.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      const bar = pane.dataset.capsuleMode === "bar" ? 44 : 0;
      const line = paneBox.top + bar + (paneBox.height - bar) * 0.3;
      pane.scrollTop += box.top - line;
      const placed = el.getBoundingClientRect();
      const top = Math.max(placed.top, paneBox.top + 8);
      const bottom = Math.min(placed.bottom, paneBox.bottom - 8);
      return {
        source: document.getElementById("pages").scrollTop,
        x: Math.min(Math.max(placed.left + Math.min(24, placed.width / 3), paneBox.left + 12), paneBox.right - 12),
        y: bottom > top ? (top + bottom) / 2 : placed.top + placed.height / 2
      };
    })()`);
    const readPanes = () => evaluate(`(() => ({
      pager: document.getElementById("pager")?.textContent || "",
      capsule: document.getElementById("pageCapsule")?.dataset.srcPage || "",
      sourceLabel: document.getElementById("sourcePageLabel")?.textContent || "",
      source: document.getElementById("pages").scrollTop
    }))()`);
    await followOff("switch");
    await evaluate(`document.getElementById("pages").scrollTop = 0`);
    await frames(3);
    const parked = await scrollTranslationPage(1, false);
    assert.ok(parked, "page 1 block");
    await frames(4);
    const atPage1 = await readPanes();
    assert.equal(atPage1.capsule, "1", "capsule is page 1");
    assert.equal(atPage1.pager, "1 / 15", "toolbar leaves the paged page for the capsule");
    assert.match(atPage1.sourceLabel, /第 1\//, "source pane is page 1");
    near(atPage1.source, parked.source, 1, "parking scroll stays");
    const atFive = await scrollTranslationPage(5, true);
    assert.ok(atFive, "page 5 paragraph");
    await frames(4);
    const atPage5 = await readPanes();
    assert.equal(atPage5.capsule, "5", "capsule is page 5");
    assert.equal(atPage5.pager, "5 / 15", "toolbar follows the translation capsule");
    assert.match(atPage5.sourceLabel, /第 1\//, "source pane stays on page 1");
    near(atPage5.source, parked.source, 1, "translation scroll leaves the source pane");
    await followOff("capsule page");
    await mouseClick(atFive.x, atFive.y);
    await frames(3);
    await followOff("paragraph click");
    await clickSelector("#pageCapsule");
    await frames(3);
    await followOff("capsule click");
    const sourceLine = await evaluate(`(() => {
      const pages = document.getElementById("pages");
      const pane = pages.getBoundingClientRect();
      for (const node of document.querySelectorAll("#readerFlow [data-pair-id][data-src-rects]")) {
        if (node.dataset.pairPart === "inline") continue;
        const rect = JSON.parse(node.dataset.srcRects || "[]")[0];
        if (!rect) continue;
        const pageEl = document.querySelector('#pages .pdf-page[data-page="' + rect.p + '"]');
        if (!pageEl) continue;
        const page = pageEl.getBoundingClientRect();
        const pt = window.__oi.pagePt(pageEl);
        if (!pt?.width || !pt?.height) continue;
        const x = page.left + ((rect.x + Math.min(24, rect.w / 3)) / pt.width) * page.width;
        const y = page.top + ((rect.y + Math.min(8, rect.h / 3)) / pt.height) * page.height;
        if (x < pane.left + 8 || x > pane.right - 8 || y < pane.top + 8 || y > pane.bottom - 36) continue;
        return { x, y };
      }
      return null;
    })()`);
    assert.ok(sourceLine, "visible source line");
    await mouseClick(sourceLine.x, sourceLine.y);
    await frames(3);
    await followOff("source click");
    await sleep(1700);
    const heldAfterJump = await evaluate(`document.getElementById("pages").scrollTop`);
    await evaluate(`document.getElementById("translateScroll").scrollTop += 220`);
    await frames(4);
    near(await evaluate(`document.getElementById("pages").scrollTop`), heldAfterJump, 1, "translation scroll does not move a followed-off source");
    await evaluate(`document.body.focus()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "follow restored after the off checks");

    const catalog = await evaluate(`(() => {
      const blocks = [...document.querySelectorAll("#readerFlow .rf-block[data-pair-id]")].map((el) => ({
        page: el.dataset.srcPage || el.dataset.page || "",
        label: el.dataset.label || el.dataset.role || "",
        cls: el.className,
        text: (el.textContent || "").replace(/\\s+/g, " ").slice(0, 60)
      }));
      const inlines = [...document.querySelectorAll('#readerFlow .oi-pdf-inline-math[data-pair-part="inline"]')].map((el) => ({
        page: el.dataset.page || el.closest("[data-src-page]")?.dataset.srcPage || "",
        id: el.dataset.pairId || ""
      }));
      return { blocks: blocks.slice(0, 80), inlines: inlines.slice(0, 40), inlineCount: inlines.length };
    })()`);

    const scrollPairToAnchor = async (selector) => {
      const moved = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const pane = document.getElementById("translateScroll");
        if (!el || !pane) return "";
        const paneBox = pane.getBoundingClientRect();
        const box = el.getBoundingClientRect();
        const bar = pane.dataset.capsuleMode === "bar" ? 44 : 0;
        const line = paneBox.top + bar + (paneBox.height - bar) * 0.3;
        pane.scrollTop += box.top - line;
        return el.dataset.pairId || "moved";
      })()`);
      assert.ok(moved, selector);
      await frames(3);
      await sleep(120);
      return moved;
    };

    const assertPassive = async (label) => {
      const row = await evaluate(`(() => {
        const el = document.querySelector("#readerFlow .rf-block.is-pair-current");
        if (!el) return null;
        const pseudo = window.__oi.pseudo(el);
        const pair = document.querySelector("#pages .pair-box:not(.is-jump)");
        const rect = window.__oi.firstRect(el.dataset.pairId);
        const expected = rect ? window.__oi.rectBox(rect, 5) : null;
        const box = pair ? pair.getBoundingClientRect() : null;
        const style = pair ? getComputedStyle(pair) : null;
        const outside = [...document.querySelectorAll(".pair-box")].filter((node) => !node.closest("#pages")).length;
        return {
          label: el.dataset.label || el.className,
          pseudo,
          pair: box && style ? {
            x: box.x, y: box.y, w: box.width, h: box.height,
            border: (pair.offsetWidth - pair.clientWidth) / 2,
            raw: style.borderTopWidth,
            tokenW: window.__oi.token("--oi-reader-pair-box-w"),
            dpr: window.devicePixelRatio,
            radius: parseFloat(style.borderTopLeftRadius),
            color: window.__oi.color(style.borderTopColor)
          } : null,
          expected,
          outside,
          token: window.__oi.color(window.__oi.token("--oi-reader-pair")),
          bg: window.__oi.color(window.__oi.token("--oi-reader-pair-bg"))
        };
      })()`);
      assert.ok(row, `${label} current block`);
      near(row.pseudo.after.width, 3, 0.2, `${label} bar width`);
      near(row.pseudo.after.inlineStart ?? row.pseudo.after.left, -12, 0.2, `${label} bar inset`);
      near(row.pseudo.after.top, -6, 0.2, `${label} bar top`);
      near(row.pseudo.after.bottom, -6, 0.2, `${label} bar bottom`);
      assert.deepEqual(row.pseudo.after.radii.map((n) => Math.round(n)), [3, 0, 0, 3], `${label} bar radii`);
      assert.deepEqual(row.pseudo.after.bg.slice(0, 3), row.token.slice(0, 3), `${label} bar color`);
      near(row.pseudo.before.left, -12, 0.2, `${label} bg inline start`);
      near(row.pseudo.before.right, -12, 0.2, `${label} bg inline end`);
      near(row.pseudo.before.top, -6, 0.2, `${label} bg block start`);
      near(row.pseudo.before.bottom, -6, 0.2, `${label} bg block end`);
      assert.deepEqual(row.pseudo.before.radii.map((n) => Math.round(n)), [3, 8, 8, 3], `${label} bg radii`);
      assert.ok(Math.abs(row.pseudo.before.bg[0] - row.bg[0]) <= 2, `${label} honey`);
      assert.ok(row.pair && row.expected, `${label} pair box`);
      near(row.pair.x, row.expected.x, 1, `${label} box x`);
      near(row.pair.y, row.expected.y, 1, `${label} box y`);
      near(row.pair.w, row.expected.w, 1, `${label} box w`);
      near(row.pair.h, row.expected.h, 1, `${label} box h`);
      assert.equal(row.pair.tokenW, "1.5px", `${label} box border token`);
      near(row.pair.border, 1.5, 0.5, `${label} box border device px`);
      near(row.pair.radius, 4, 0.2, `${label} box radius`);
      assert.equal(row.outside, 0, `${label} boxes stay in #pages`);
    };

    const paragraph = await evaluate(`(() => {
      const el = [...document.querySelectorAll('#readerFlow .rf-block.oi-pdf-p[data-pair-id]')].find((node) => node.dataset.label === "text" && (node.dataset.srcPage || node.dataset.page) === "3");
      const fallback = el || [...document.querySelectorAll('#readerFlow .rf-block.oi-pdf-p[data-pair-id]')].find((node) => node.dataset.label === "text");
      if (!fallback) return "";
      fallback.dataset.oiProbe = "paragraph";
      return "ok";
    })()`);
    assert.equal(paragraph, "ok", `paragraph missing ${JSON.stringify(catalog.blocks.slice(0, 12))}`);
    await scrollPairToAnchor('[data-oi-probe="paragraph"]');
    await assertPassive("paragraph");
    await shot("warm-current-p3");

    const heading = await evaluate(`(() => {
      const el = document.querySelector("#readerFlow h1[data-pair-id], #readerFlow h2[data-pair-id], #readerFlow .oi-pdf-h2[data-pair-id]");
      if (!el) return "";
      el.dataset.oiProbe = "heading";
      return el.tagName;
    })()`);
    assert.ok(heading, "heading missing");
    await scrollPairToAnchor('[data-oi-probe="heading"]');
    await assertPassive("heading");

    const formula = await evaluate(`(() => {
      const el = document.querySelector("#readerFlow figure.oi-pdf-display-math[data-pair-id], #readerFlow .oi-pdf-display-math[data-pair-id]");
      if (!el) return "";
      el.dataset.oiProbe = "formula";
      return "ok";
    })()`);
    assert.equal(formula, "ok", "display formula missing");
    await scrollPairToAnchor('[data-oi-probe="formula"]');
    const sized = await evaluate(`(() => {
      const el = document.querySelector('[data-oi-probe="formula"]');
      const box = el.getBoundingClientRect();
      return { w: el.offsetWidth, h: el.offsetHeight, current: el.classList.contains("is-pair-current"), top: box.top };
    })()`);
    await assertPassive("display formula");
    await evaluate(`document.getElementById("translateScroll").scrollTop += 240`);
    await frames(3);
    const sizedAway = await evaluate(`(() => {
      const el = document.querySelector('[data-oi-probe="formula"]');
      return { w: el.offsetWidth, h: el.offsetHeight, current: el.classList.contains("is-pair-current") };
    })()`);
    assert.equal(sizedAway.w, sized.w, "formula width unchanged by current mark");
    assert.equal(sizedAway.h, sized.h, "formula height unchanged by current mark");
    assert.equal(sized.current, true, "formula was current");
    assert.equal(sizedAway.current, false, "formula left the anchor");

    const figure = await evaluate(`(() => {
      const el = [...document.querySelectorAll("#readerFlow .oi-pdf-figure[data-pair-id], #readerFlow figure[data-label='figure'][data-pair-id]")].find((node) => !node.classList.contains("oi-pdf-display-math"));
      if (!el) return "";
      el.dataset.oiProbe = "figure";
      return "ok";
    })()`);
    assert.equal(figure, "ok", "figure missing");
    await scrollPairToAnchor('[data-oi-probe="figure"]');
    await assertPassive("figure");

    await scrollPairToAnchor('[data-oi-probe="formula"]');
    const sample = await evaluate(`(() => {
      const el = document.querySelector('[data-oi-probe="formula"] img');
      if (!el) return null;
      const box = el.getBoundingClientRect();
      const solid = window.__oi.color(window.__oi.token("--oi-reader-pair-bg-solid"));
      return { x: box.left + 4, y: box.top + Math.min(4, box.height / 2), w: Math.max(8, Math.min(24, box.width - 2)), h: Math.max(8, Math.min(16, box.height - 2)), solid };
    })()`);
    assert.ok(sample, "formula image");
    const shotClip = await send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      clip: { x: sample.x, y: sample.y, width: sample.w, height: sample.h, scale: 1 }
    });
    const png = decodePng(Buffer.from(shotClip.data, "base64"));
    let light = null;
    let brightest = [0, 0, 0];
    for (let i = 0; i < png.rgba.length; i += 4) {
      const pixel = [png.rgba[i], png.rgba[i + 1], png.rgba[i + 2]];
      if (pixel[0] + pixel[1] + pixel[2] > brightest[0] + brightest[1] + brightest[2]) brightest = pixel;
      if (pixel.every((channel) => channel > 200)) {
        if (!light || pixel[0] + pixel[1] + pixel[2] > light[0] + light[1] + light[2]) light = pixel;
      }
    }
    assert.ok(light, `no light pixel in the current formula image brightest=${brightest} sample=${JSON.stringify(sample)} png=${png.width}x${png.height}`);
    for (let channel = 0; channel < 3; channel += 1) {
      assert.ok(Math.abs(light[channel] - sample.solid[channel]) <= 3, `PC1 multiply channel ${channel}: ${light} vs ${sample.solid}`);
      assert.ok(Math.abs(light[channel] - 255) > 3, "PC1 multiply is not white");
    }

    const stepTranslation = async (steps, label) => {
      for (let i = 0; i < steps; i += 1) {
        const before = await evaluate(`(() => {
          const trans = document.getElementById("translateScroll");
          const pages = document.getElementById("pages");
          const current = document.querySelector("#readerFlow .rf-block.is-pair-current");
          const rect = current ? window.__oi.firstRect(current.dataset.pairId) : null;
          const placed = rect ? window.__oi.sourceAnchor(rect) : null;
          return {
            trans: trans.scrollTop,
            step: trans.clientHeight / 3,
            max: trans.scrollHeight - trans.clientHeight,
            source: pages.scrollTop,
            page: document.getElementById("pageCapsule")?.dataset.srcPage || ""
          };
        })()`);
        if (before.trans >= before.max - 2) break;
        await evaluate(`document.getElementById("translateScroll").scrollTop += ${before.step}`);
        await frames(2);
        const after = await evaluate(`(() => {
          const trans = document.getElementById("translateScroll");
          const pages = document.getElementById("pages");
          const current = document.querySelector("#readerFlow .rf-block.is-pair-current");
          const rect = current ? window.__oi.firstRect(current.dataset.pairId) : null;
          const placed = rect ? window.__oi.sourceAnchor(rect) : null;
          return {
            trans: trans.scrollTop,
            source: pages.scrollTop,
            placed,
            page: document.getElementById("pageCapsule")?.dataset.srcPage || "",
            follow: document.querySelector(".workspace")?.dataset.follow || ""
          };
        })()`);
        const expectedTrans = Math.min(before.max, before.trans + before.step);
        near(after.trans, expectedTrans, 1, `${label} translation scroll ${i}`);
        assert.equal(after.follow, "on", `${label} follow stayed on`);
        if (Math.abs(after.source - before.source) > 1) {
          const clamped = after.placed.scrollTop <= 1 || after.placed.scrollTop >= after.placed.max - 2;
          if (!clamped) near(after.placed.top - after.placed.pagesTop, 0.3 * after.placed.client, 8, `${label} source 30% step ${i}`);
        } else if (after.placed) {
          assert.ok(after.placed.top >= after.placed.pagesTop - 1 && after.placed.bottom <= after.placed.pagesBottom + 1, `${label} rect inside at step ${i}`);
        }
        if (Number(after.page) >= 5 && Number(before.page) >= 3) return after.page;
      }
      return await evaluate(`document.getElementById("pageCapsule")?.dataset.srcPage || ""`);
    };
    const runFl2 = async (label) => {
      await evaluate(`(() => {
        const el = [...document.querySelectorAll('#readerFlow .rf-block[data-src-page="3"][data-pair-id]')][2] || document.querySelector('#readerFlow .rf-block[data-src-page="3"][data-pair-id]');
        el.dataset.oiProbe = "p3";
        return true;
      })()`);
      await scrollPairToAnchor('[data-oi-probe="p3"]');
      const reached = await stepTranslation(24, label);
      assert.ok(Number(reached) >= 5, `${label} reached page ${reached}`);
    };
    const sourceWheelPoint = () => evaluate(`(() => {
      const el = document.getElementById("pages");
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, source: el.scrollTop };
    })()`);
    const runFl3 = async (label) => {
      const pagesPoint = await sourceWheelPoint();
      await wheelAt(pagesPoint.x, pagesPoint.y, 140);
      await sleep(80);
      const paused = await evaluate(`(() => ({
        follow: document.querySelector(".workspace")?.dataset.follow || "",
        status: document.getElementById("sourceStatus")?.textContent || ""
      }))()`);
      assert.equal(paused.follow, "paused", `${label} wheel pauses`);
      assert.match(paused.status, /跟随已暂停/, `${label} header`);
      if (label === "FL3") await shot("paused-header");
      const heldSource = await evaluate(`document.getElementById("pages").scrollTop`);
      await evaluate(`document.getElementById("translateScroll").scrollTop += 180`);
      await frames(3);
      assert.equal(await evaluate(`document.getElementById("pages").scrollTop`), heldSource, `${label} paused source stays`);

      await evaluate(`document.body.focus()`);
      await keyTap("f", "KeyF", 70, { text: "f" });
      await frames(3);
      await sleep(80);
      const resumed = await evaluate(`(() => {
        const current = document.querySelector("#readerFlow .rf-block.is-pair-current");
        const placed = current ? window.__oi.sourceAnchor(window.__oi.firstRect(current.dataset.pairId)) : null;
        return { follow: document.querySelector(".workspace")?.dataset.follow || "", placed };
      })()`);
      assert.equal(resumed.follow, "on", `${label} f resumes`);
      if (resumed.placed && resumed.placed.scrollTop > 1 && resumed.placed.scrollTop < resumed.placed.max - 2) {
        near(resumed.placed.top - resumed.placed.pagesTop, 0.3 * resumed.placed.client, 8, `${label} f lands at 30%`);
      }

      const resumePoint = await sourceWheelPoint();
      await wheelAt(resumePoint.x, resumePoint.y, 80);
      await sleep(50);
      await clickSelector('[data-action="resume-follow"]');
      await frames(3);
      assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", `${label} 恢复`);

      const blockPoint = await sourceWheelPoint();
      await wheelAt(blockPoint.x, blockPoint.y, 80);
      await sleep(50);
      await evaluate(`document.querySelector("#readerFlow .rf-block.is-pair-current")?.scrollIntoView({ block: "center", behavior: "auto" })`);
      await frames(2);
      await clickSelector("#readerFlow .rf-block.is-pair-current");
      await frames(2);
      assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", `${label} block click resumes`);
      assert.equal(await evaluate(`localStorage.getItem("reader.follow")`), "1", `${label} pause does not store off`);

      const zoomBefore = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
      await clickSelector("#zoomIn");
      await sleep(200);
      assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), zoomBefore, `${label} zoom does not pause`);
      await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
      assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", `${label} resize does not pause`);
      await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
      await sleep(200);
    };
    const runFl4 = async (label) => {
      await clickSelector("#followSwitch");
      await frames(2);
      assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "off", `${label} off`);
      await evaluate(`document.getElementById("pages").scrollTop = document.getElementById("pages").scrollHeight`);
      await frames(3);
      const showCurrent = await evaluate(`document.querySelector("[data-action='show-current']")?.textContent || ""`);
      assert.match(showCurrent, /当前段/, `${label} 当前段`);
      await clickSelector("[data-action='show-current']");
      await frames(3);
      const shown = await evaluate(`(() => {
        const current = document.querySelector("#readerFlow .rf-block.is-pair-current");
        const placed = current ? window.__oi.sourceAnchor(window.__oi.firstRect(current.dataset.pairId)) : null;
        return {
          follow: document.querySelector(".workspace")?.dataset.follow || "",
          checked: document.getElementById("followSwitch")?.getAttribute("aria-checked") || "",
          placed
        };
      })()`);
      assert.equal(shown.follow, "off", `${label} switch stays off`);
      assert.equal(shown.checked, "false", `${label} aria stays off`);
      if (shown.placed && shown.placed.scrollTop > 1 && shown.placed.scrollTop < shown.placed.max - 2) {
        near(shown.placed.top - shown.placed.pagesTop, 0.3 * shown.placed.client, 8, `${label} show current`);
      }
      await evaluate(`document.body.focus()`);
      await keyTap("f", "KeyF", 70, { text: "f" });
      await frames(2);
    };
    await runFl2("FL2");
    await runFl3("FL3");
    await runFl4("FL4");

    const sy1 = async (label) => {
      const marker = await evaluate(`(() => {
        const el = document.querySelector("#readerFlow .rf-block[data-pair-id]");
        window.__oiMark = el;
        return {
          trans: document.getElementById("translateScroll").scrollTop,
          pages: document.querySelectorAll("#readerFlow .rf-page").length
        };
      })()`);
      assert.equal(marker.pages, 15, `${label} 全文页槽还在`);
      const point = await evaluate(`(() => {
        const el = document.getElementById("pages");
        const box = el.getBoundingClientRect();
        return { x: box.left + 40, y: box.top + 80 };
      })()`);
      await wheelAt(point.x, point.y, 80);
      await frames(3);
      await evaluate(`document.getElementById("pages").scrollTop += 48`);
      await frames(3);
      const after = await evaluate(`(() => ({
        trans: document.getElementById("translateScroll").scrollTop,
        same: window.__oiMark?.isConnected === true
      }))()`);
      assert.equal(after.trans, marker.trans, `${label} translation scroll`);
      assert.equal(after.same, true, `${label} flow node`);
    };
    await sy1("SY1");
    const restamped = await evaluate(`(() => {
      const text = [...document.querySelectorAll('#readerFlow .rf-block.oi-pdf-p[data-pair-id]')].find((node) => node.dataset.label === "text");
      const heading = document.querySelector("#readerFlow h1[data-pair-id], #readerFlow h2[data-pair-id]");
      const formula = document.querySelector("#readerFlow .oi-pdf-display-math[data-pair-id]");
      const figure = [...document.querySelectorAll("#readerFlow .oi-pdf-figure[data-pair-id]")].find((node) => !node.classList.contains("oi-pdf-display-math"));
      if (text) text.dataset.oiProbe = "paragraph";
      if (heading) heading.dataset.oiProbe = "heading";
      if (formula) formula.dataset.oiProbe = "formula";
      if (figure) figure.dataset.oiProbe = "figure";
      return Boolean(text && heading && formula && figure);
    })()`);
    assert.equal(restamped, true, "pair probes");

    const jumpFromTranslation = async (selector, { inline = false } = {}) => {
      const before = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const trans = document.getElementById("translateScroll");
        const box = el.getBoundingClientRect();
        el.scrollIntoView({ block: "center", behavior: "auto" });
        return { trans: trans.scrollTop, x: box.left + Math.min(12, box.width / 2), y: box.top + box.height / 2, id: el.dataset.pairId || "" };
      })()`);
      await frames(2);
      const point = await evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        const box = el.getBoundingClientRect();
        const pane = document.getElementById("translateScroll").getBoundingClientRect();
        const x = Math.min(pane.right - 12, Math.max(pane.left + 12, box.left + 16));
        const y = Math.min(pane.bottom - 12, Math.max(pane.top + 12, box.top + 12));
        return { x, y, trans: document.getElementById("translateScroll").scrollTop, id: el.dataset.pairId || "" };
      })()`);
      const transBefore = point.trans;
      await mouseClick(point.x, point.y);
      await frames(2);
      const landed = await evaluate(`((inline) => {
        const trans = document.getElementById("translateScroll").scrollTop;
        const jump = document.querySelector("#pages .pair-box.is-jump");
        const passive = document.querySelector("#pages .pair-box:not(.is-jump)");
        const style = jump ? getComputedStyle(jump) : null;
        const box = jump ? jump.getBoundingClientRect() : null;
        const target = document.querySelector(${JSON.stringify(selector)});
        const rects = JSON.parse(target?.dataset.srcRects || "[]");
        const outset = inline ? 2 : 5;
        const expected = rects[0] ? window.__oi.rectBox(rects[0], outset) : null;
        const placed = rects[0] ? window.__oi.sourceAnchor(rects[0]) : null;
        return {
          trans,
          jump: Boolean(jump),
          passive: Boolean(passive),
          border: style ? parseFloat(style.borderTopWidth) : 0,
          radius: style ? parseFloat(style.borderTopLeftRadius) : 0,
          shadow: style ? style.boxShadow : "",
          box: box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null,
          expected,
          placed,
          lock: document.querySelector(".workspace")?.dataset.jumpLock || "",
          marked: target?.classList.contains("is-pair-jump") === true
        };
      })(${inline ? "true" : "false"})`);
      assert.equal(landed.trans, transBefore, `${selector} translation stayed`);
      assert.equal(landed.jump, true, `${selector} jump box`);
      assert.equal(landed.lock, "1", `${selector} lock`);
      near(landed.border, 2, 0.2, `${selector} jump border`);
      near(landed.radius, 5, 0.2, `${selector} jump radius`);
      assert.match(landed.shadow, /rgba?\(/, `${selector} halo`);
      if (landed.box && landed.expected) {
        near(landed.box.x, landed.expected.x, 1.5, `${selector} jump x`);
        near(landed.box.y, landed.expected.y, 1.5, `${selector} jump y`);
      }
      if (landed.placed && landed.placed.scrollTop > 1 && landed.placed.scrollTop < landed.placed.max - 2) {
        near(landed.placed.top - landed.placed.pagesTop, 0.3 * landed.placed.client, 8, `${selector} source 30%`);
      }
      if (inline) assert.equal(landed.passive, true, "inline keeps the paragraph box");
      return { before: transBefore, landed };
    };

    await jumpFromTranslation('[data-oi-probe="paragraph"]');
    await jumpFromTranslation('[data-oi-probe="formula"]');
    const inlineSel = await evaluate(`(() => {
      const el = document.querySelector('#readerFlow .rf-page[data-page="4"] .oi-pdf-inline-math[data-pair-part="inline"], #readerFlow [data-src-page="4"] .oi-pdf-inline-math[data-pair-part="inline"]');
      if (!el) return "";
      el.dataset.oiProbe = "inline";
      return "ok";
    })()`);
    assert.equal(inlineSel, "ok", `p4 inline missing count=${catalog.inlineCount}`);
    await jumpFromTranslation('[data-oi-probe="inline"]', { inline: true });
    await jumpFromTranslation('[data-oi-probe="figure"]');

    const sourceClick = async (selector) => {
      const info = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        const rect = JSON.parse(node.dataset.srcRects || "[]")[0];
        const pageEl = document.querySelector('#pages .pdf-page[data-page="' + rect.p + '"]');
        const pages = document.getElementById("pages");
        const page = pageEl.getBoundingClientRect();
        const pane = pages.getBoundingClientRect();
        const pt = window.__oi.pagePt(pageEl);
        const x = page.left + ((rect.x + rect.w / 2) / pt.width) * page.width;
        const y = page.top + ((rect.y + Math.min(8, rect.h / 3)) / pt.height) * page.height;
        if (y < pane.top || y > pane.bottom) {
          pages.scrollTop += y - (pane.top + pane.height * 0.5);
        }
        return { x, y, id: node.dataset.pairId };
      })()`);
      await frames(2);
      const point = await evaluate(`(() => {
        const node = document.querySelector(${JSON.stringify(selector)});
        const rect = JSON.parse(node.dataset.srcRects || "[]")[0];
        const pageEl = document.querySelector('#pages .pdf-page[data-page="' + rect.p + '"]');
        const page = pageEl.getBoundingClientRect();
        const pt = window.__oi.pagePt(pageEl);
        return {
          x: page.left + ((rect.x + rect.w / 2) / pt.width) * page.width,
          y: page.top + ((rect.y + Math.min(8, rect.h / 3)) / pt.height) * page.height,
          id: node.dataset.pairId
        };
      })()`);
      await mouseClick(point.x, point.y);
      await frames(3);
      const landed = await evaluate(`((id) => {
        const node = document.querySelector('[data-pair-id="' + CSS.escape(id) + '"].rf-block, [data-pair-id="' + CSS.escape(id) + '"]');
        const block = node?.classList.contains("rf-block") ? node : node?.closest(".rf-block");
        const pane = document.getElementById("translateScroll");
        const paneBox = pane.getBoundingClientRect();
        const box = block.getBoundingClientRect();
        const bar = pane.dataset.capsuleMode === "bar" ? 44 : 0;
        const anchor = paneBox.top + bar + (paneBox.height - bar) * 0.3;
        const height = box.height + 12;
        const desired = Math.max(8, Math.min(0.3 * paneBox.height, paneBox.height - 40 - height));
        return {
          current: document.querySelector("#readerFlow .rf-block.is-pair-current")?.dataset.pairId || "",
          jump: block?.classList.contains("is-pair-jump") === true,
          sourceJump: Boolean(document.querySelector("#pages .pair-box.is-jump")),
          offset: box.top - paneBox.top,
          desired,
          visualBottom: box.bottom + 6,
          fadeTop: paneBox.bottom - 40,
          tall: height > pane.clientHeight - 48,
          lock: document.querySelector(".workspace")?.dataset.jumpLock || ""
        };
      })(${JSON.stringify(point.id)})`);
      assert.equal(landed.current, point.id, `${selector} became current`);
      assert.equal(landed.jump, true, `${selector} translation jump`);
      assert.equal(landed.sourceJump, true, `${selector} source jump`);
      assert.equal(landed.lock, "1", `${selector} source lock`);
      if (landed.tall) near(landed.offset, 8, 8, `${selector} tall top`);
      else {
        near(landed.offset, landed.desired, 8, `${selector} VS2 offset`);
        assert.ok(landed.visualBottom <= landed.fadeTop + 8, `${selector} clears the fade`);
      }
    };
    const visibleSource = await evaluate(`(() => {
      const pages = document.getElementById("pages");
      const pane = pages.getBoundingClientRect();
      let best = null;
      for (const node of document.querySelectorAll("#readerFlow [data-pair-id][data-src-rects]")) {
        if (node.dataset.pairPart === "inline") continue;
        const rect = JSON.parse(node.dataset.srcRects || "[]")[0];
        if (!rect) continue;
        const pageEl = document.querySelector('#pages .pdf-page[data-page="' + rect.p + '"]');
        if (!pageEl) continue;
        const page = pageEl.getBoundingClientRect();
        const pt = window.__oi.pagePt(pageEl);
        if (!pt?.width || !pt?.height) continue;
        const top = page.top + (rect.y / pt.height) * page.height;
        const height = (rect.h / pt.height) * page.height;
        const bottom = top + height;
        const x = page.left + ((rect.x + rect.w / 2) / pt.width) * page.width;
        const visibleBottom = pane.top + pages.clientHeight;
        const visibleRight = pane.left + pages.clientWidth;
        if (top < pane.top + 2 || bottom > visibleBottom - 2) continue;
        if (x < pane.left + 4 || x > visibleRight - 4) continue;
        const ratio = (top - pane.top) / pane.height;
        if (ratio < 0.6) continue;
        const y = Math.min(visibleBottom - 4, top + Math.min(8, height / 3));
        if (!best || ratio > best.ratio) best = { x, y, ratio, source: pages.scrollTop, id: node.dataset.pairId };
      }
      return best;
    })()`);
    assert.ok(visibleSource, "S-6 visible source hit");
    assert.ok(visibleSource.ratio > 0.6, "S-6 hit sits below the 30% line");
    await mouseClick(visibleSource.x, visibleSource.y);
    await frames(3);
    const keptSource = await evaluate(`(() => ({
      source: document.getElementById("pages").scrollTop,
      current: document.querySelector("#readerFlow .is-pair-current, #readerFlow .is-pair-jump")?.dataset.pairId || ""
    }))()`);
    near(keptSource.source, visibleSource.source, 1, "S-6 visible source click keeps the source pane");
    assert.equal(keptSource.current, visibleSource.id, "S-6 visible source click jumps the translation");
    const clipped = await evaluate(`(() => {
      const pages = document.getElementById("pages");
      const pane = pages.getBoundingClientRect();
      let pick = null;
      for (const node of document.querySelectorAll("#readerFlow .rf-block[data-pair-id][data-src-rects]")) {
        const rect = JSON.parse(node.dataset.srcRects || "[]")[0];
        if (!rect) continue;
        const pageEl = document.querySelector('#pages .pdf-page[data-page="' + rect.p + '"]');
        if (!pageEl) continue;
        const page = pageEl.getBoundingClientRect();
        const pt = window.__oi.pagePt(pageEl);
        if (!pt?.height) continue;
        const height = (rect.h / pt.height) * page.height;
        if (height < 80) continue;
        const top = page.top + (rect.y / pt.height) * page.height;
        const contentTop = pages.scrollTop + (top - pane.top);
        if (contentTop < pane.height) continue;
        if (!pick || contentTop < pick.contentTop) pick = { node, contentTop, height };
      }
      if (!pick) return { ok: false };
      pick.node.dataset.oiProbe = "clipped";
      const next = pick.contentTop - ((pane.bottom - 70) - pane.top);
      if (!(next > 1)) return { ok: false, contentTop: pick.contentTop };
      pages.scrollTop = next;
      return { ok: true, contentTop: pick.contentTop };
    })()`);
    assert.equal(clipped.ok, true, "S-6 clip setup");
    await frames(2);
    const clippedPoint = await evaluate(`(() => {
      const pages = document.getElementById("pages");
      const pane = pages.getBoundingClientRect();
      const node = document.querySelector('[data-oi-probe="clipped"]');
      const rect = JSON.parse(node.dataset.srcRects || "[]")[0];
      const pageEl = document.querySelector('#pages .pdf-page[data-page="' + rect.p + '"]');
      const page = pageEl.getBoundingClientRect();
      const pt = window.__oi.pagePt(pageEl);
      const top = page.top + (rect.y / pt.height) * page.height;
      const bottom = page.top + ((rect.y + rect.h) / pt.height) * page.height;
      return {
        x: page.left + ((rect.x + Math.min(24, rect.w / 3)) / pt.width) * page.width,
        y: Math.min(pane.bottom - 36, Math.max(pane.top + 8, top + 16)),
        source: pages.scrollTop,
        id: node.dataset.pairId,
        hangs: bottom > pane.bottom + 1,
        top,
        bottom,
        paneBottom: pane.bottom
      };
    })()`);
    assert.equal(clippedPoint.hangs, true, `S-6 block hangs outside the source pane ${JSON.stringify(clippedPoint)}`);
    await mouseClick(clippedPoint.x, clippedPoint.y);
    await frames(3);
    const revealed = await evaluate(`(() => ({
      source: document.getElementById("pages").scrollTop,
      id: document.querySelector("#readerFlow .is-pair-current, #readerFlow .is-pair-jump")?.dataset.pairId || ""
    }))()`);
    assert.equal(revealed.id, clippedPoint.id, "S-6 offscreen source click hits the block");
    assert.ok(Math.abs(revealed.source - clippedPoint.source) > 20, `S-6 offscreen source click scrolls (${clippedPoint.source} -> ${revealed.source})`);
    await sourceClick('[data-oi-probe="paragraph"]');

    const miss = await evaluate(`(() => {
      const pageEl = [...document.querySelectorAll("#pages .pdf-page")].find((el) => {
        const box = el.getBoundingClientRect();
        const pane = document.getElementById("pages").getBoundingClientRect();
        return box.bottom > pane.top + 20 && box.top < pane.bottom - 20;
      });
      const box = pageEl.getBoundingClientRect();
      const pane = document.getElementById("pages").getBoundingClientRect();
      const pt = window.__oi.pagePt(pageEl);
      const page = Number(pageEl.dataset.page);
      const rects = [];
      document.querySelectorAll("[data-src-rects]").forEach((node) => {
        for (const rect of JSON.parse(node.dataset.srcRects || "[]")) {
          if (Number(rect.p) !== page) continue;
          rects.push({
            x: box.left + (rect.x / pt.width) * box.width,
            y: box.top + (rect.y / pt.height) * box.height,
            r: box.left + ((rect.x + rect.w) / pt.width) * box.width,
            b: box.top + ((rect.y + rect.h) / pt.height) * box.height
          });
        }
      });
      const inside = (x, y) => rects.some((rect) => x >= rect.x && x <= rect.r && y >= rect.y && y <= rect.b);
      for (let y = Math.max(box.top, pane.top) + 6; y < Math.min(box.bottom, pane.bottom) - 6; y += 14) {
        for (const x of [box.left + 3, box.right - 3, box.left + box.width / 2]) {
          if (!inside(x, y)) {
            return { x, y, trans: document.getElementById("translateScroll").scrollTop, jumps: document.querySelectorAll("#pages .pair-box.is-jump").length };
          }
        }
      }
      return null;
    })()`);
    assert.ok(miss, "SY3 miss point");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: miss.x, y: miss.y });
    await frames(2);
    const hot = await evaluate(`document.getElementById("pages").classList.contains("is-pair-hot")`);
    await mouseClick(miss.x, miss.y);
    await frames(2);
    const missed = await evaluate(`(() => ({
      trans: document.getElementById("translateScroll").scrollTop,
      jumps: document.querySelectorAll("#pages .pair-box.is-jump").length
    }))()`);
    assert.equal(hot, false, "SY3 margin cursor");
    assert.equal(missed.trans, miss.trans, "SY3 margin scroll");
    assert.equal(missed.jumps, miss.jumps, "SY3 margin box");

    const restampProbes = async () => {
      const ok = await evaluate(`(() => {
        const text = [...document.querySelectorAll('#readerFlow .rf-block.oi-pdf-p[data-pair-id]')].find((node) => node.dataset.label === "text");
        const heading = document.querySelector("#readerFlow h1[data-pair-id], #readerFlow h2[data-pair-id]");
        const formula = document.querySelector("#readerFlow .oi-pdf-display-math[data-pair-id]");
        const figure = [...document.querySelectorAll("#readerFlow .oi-pdf-figure[data-pair-id]")].find((node) => !node.classList.contains("oi-pdf-display-math"));
        if (text) text.dataset.oiProbe = "paragraph";
        if (heading) heading.dataset.oiProbe = "heading";
        if (formula) formula.dataset.oiProbe = "formula";
        if (figure) figure.dataset.oiProbe = "figure";
        return Boolean(text && heading && formula && figure);
      })()`);
      assert.equal(ok, true, "pair probes");
    };
    const runSy4 = async (label) => {
      await restampProbes();
      await jumpFromTranslation('[data-oi-probe="paragraph"]');
      const lockedAt = await evaluate(`(() => ({
        lock: document.querySelector(".workspace")?.dataset.jumpLock || "",
        trans: document.getElementById("translateScroll").scrollTop,
        source: document.getElementById("pages").scrollTop
      }))()`);
      assert.equal(lockedAt.lock, "1", `${label} locked`);
      await sleep(1000);
      const still = await evaluate(`(() => ({
        lock: document.querySelector(".workspace")?.dataset.jumpLock || "",
        trans: document.getElementById("translateScroll").scrollTop,
        source: document.getElementById("pages").scrollTop
      }))()`);
      assert.equal(still.lock, "1", `${label} still locked at 1000ms`);
      assert.equal(still.trans, lockedAt.trans, `${label} translation held`);
      assert.equal(still.source, lockedAt.source, `${label} source held`);
      await jumpFromTranslation('[data-oi-probe="heading"]');
      await sleep(300);
      const transPoint = await evaluate(`(() => {
        const el = document.getElementById("translateScroll");
        const box = el.getBoundingClientRect();
        return { x: box.left + 30, y: box.top + box.height / 2, top: el.scrollTop };
      })()`);
      await wheelAt(transPoint.x, transPoint.y, 240);
      await sleep(40);
      const unlocked = await evaluate(`(() => ({
        lock: document.querySelector(".workspace")?.dataset.jumpLock || "",
        top: document.getElementById("translateScroll").scrollTop
      }))()`);
      assert.equal(unlocked.lock, "", `${label} wheel clears lock`);
      assert.notEqual(unlocked.top, transPoint.top, `${label} wheel scrolls`);
    };
    const runSy5 = async (label) => {
      await jumpFromTranslation('[data-oi-probe="paragraph"]');
      await keyTap("Escape", "Escape", 27);
      await frames(2);
      const escaped = await evaluate(`(() => ({
        jump: document.querySelectorAll("#pages .pair-box.is-jump").length,
        passive: document.querySelectorAll("#pages .pair-box:not(.is-jump)").length
      }))()`);
      assert.equal(escaped.jump, 0, `${label} esc removes jump`);
      assert.ok(escaped.passive > 0, `${label} passive stays`);
      await sleep(1600);
      const previous = await evaluate(`document.querySelector("#readerFlow .rf-block.is-pair-current")?.dataset.pairId || ""`);
      await evaluate(`document.getElementById("translateScroll").scrollTop += document.getElementById("translateScroll").clientHeight`);
      await frames(4);
      const changed = await evaluate(`(() => ({
        id: document.querySelector("#readerFlow .rf-block.is-pair-current")?.dataset.pairId || "",
        jump: document.querySelectorAll("#pages .pair-box.is-jump").length,
        passive: document.querySelectorAll("#pages .pair-box").length
      }))()`);
      assert.notEqual(changed.id, previous, `${label} current changed`);
      assert.equal(changed.jump, 0, `${label} old jump gone`);
      assert.ok(changed.passive > 0, `${label} new passive box`);
    };
    await runSy4("SY4");
    await runSy5("SY5");

    const ratioBefore = await evaluate(`document.querySelector(".workspace").style.getPropertyValue("--oi-split-ratio")`);
    const followBefore = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
    const zoomBeforeSwap = await evaluate(`document.getElementById("zoomLabel").textContent`);
    const sourceBeforeSwap = await evaluate(`document.getElementById("pages").scrollTop`);
    const menuFocus = () => evaluate(`document.activeElement?.id || ""`);
    await evaluate(`document.getElementById("moreButton").focus()`);
    await keyTap("Enter", "Enter", 13);
    await frames(2);
    let menuOpen = await evaluate(`document.getElementById("moreMenu")?.hidden === false`);
    if (!menuOpen) await clickSelector("#moreButton");
    assert.equal(await menuFocus(), "swapPanes", "menu keyboard opens on 互换两栏");
    await keyTap("ArrowDown", "ArrowDown", 40);
    await frames(1);
    assert.equal(await menuFocus(), "exportMd", "menu ArrowDown skips the separator");
    await keyTap("ArrowDown", "ArrowDown", 40);
    assert.equal(await menuFocus(), "exportPdf", "menu ArrowDown reaches 导出 PDF");
    await keyTap("ArrowUp", "ArrowUp", 38);
    assert.equal(await menuFocus(), "exportMd", "menu ArrowUp returns to 导出 MD");
    await keyTap("Home", "Home", 36);
    assert.equal(await menuFocus(), "swapPanes", "menu Home returns to 互换两栏");
    await keyTap("End", "End", 35);
    assert.equal(await menuFocus(), "exportPdf", "menu End moves to the last item");
    await keyTap("Escape", "Escape", 27);
    await frames(1);
    assert.equal(await evaluate(`document.getElementById("moreMenu")?.hidden === true`), true, "menu Escape closes");
    assert.equal(await menuFocus(), "moreButton", "menu Escape returns to 更多");
    await keyTap("Enter", "Enter", 13);
    await frames(2);
    menuOpen = await evaluate(`document.getElementById("moreMenu")?.hidden === false`);
    if (!menuOpen) await clickSelector("#moreButton");
    await shot("more-menu");
    assert.equal(existsSync(join(shotDir, "more-menu.png")), true, "screenshot uses the selected shot directory");
    const menuOrder = await evaluate(`(() => [...document.querySelectorAll("#moreMenu [role='menuitem'], #moreMenu [role='menuitemcheckbox'], #moreMenu [role='separator']")].filter((el) => !el.hidden).map((el) => (el.getAttribute("role") === "separator" ? "separator" : el.textContent.replace(/\\s+/g, " ").trim())))()`);
    assert.deepEqual(menuOrder, ["互换两栏s", "separator", "导出 MD", "导出 PDF"]);
    const menuItem = await evaluate(`(() => {
      const el = document.getElementById("swapPanes");
      const style = getComputedStyle(el);
      return { h: el.getBoundingClientRect().height, pad: style.paddingLeft, padEnd: style.paddingRight };
    })()`);
    near(menuItem.h, 32, 0.5, "menu item height");
    assert.equal(menuItem.pad, "12px", "menu item padding");
    assert.equal(menuItem.padEnd, "12px", "menu item end padding");
    await clickSelector("#exportMd");
    await frames(2);
    await sleep(400);
    assert.ok(readdirSync(downloadDir).length >= 1, "export saved into the test download dir");
    assert.equal(await evaluate(`document.getElementById("moreMenu")?.hidden === true`), true, "export closes the menu");
    assert.equal(await menuFocus(), "moreButton", "export returns to 更多");
    await keyTap("Enter", "Enter", 13);
    await frames(2);
    menuOpen = await evaluate(`document.getElementById("moreMenu")?.hidden === false`);
    if (!menuOpen) await clickSelector("#moreButton");
    await keyTap(" ", "Space", 32);
    await frames(3);
    const swapped = await evaluate(`(() => {
      const source = document.getElementById("pdfPane").getBoundingClientRect();
      const translation = document.querySelector(".pane-translate").getBoundingClientRect();
      const chip = document.getElementById("zoomChip");
      return {
        side: document.querySelector(".workspace")?.dataset.sourceSide || "",
        stored: localStorage.getItem("reader.sourceSide"),
        translationLeft: translation.left < source.left,
        ratio: document.querySelector(".workspace").style.getPropertyValue("--oi-split-ratio"),
        follow: document.querySelector(".workspace")?.dataset.follow || "",
        zoom: document.getElementById("zoomLabel").textContent,
        source: document.getElementById("pages").scrollTop,
        chip: chip?.closest("#pdfPane") != null,
        checked: document.getElementById("swapPanes")?.getAttribute("aria-checked") || ""
      };
    })()`);
    assert.equal(swapped.side, "end", "SW1 side");
    assert.equal(swapped.translationLeft, true, "PC2 translation is visually first");
    assert.equal(swapped.ratio, ratioBefore, "SW1 ratio");
    assert.equal(swapped.follow, followBefore, "SW1 follow");
    assert.equal(swapped.zoom, zoomBeforeSwap, "SW1 zoom");
    near(swapped.source, sourceBeforeSwap, 2, "SW1 source scroll");
    assert.equal(swapped.chip, true, "zoom chip stays in the source pane");
    assert.equal(swapped.checked, "true", "SW1 menu checked");
    await assertPassive("swapped paragraph");
    await shot("warm-swapped");

    await runFl2("swapped FL2");
    await runFl3("swapped FL3");
    await runFl4("swapped FL4");
    await runSy4("swapped SY4");
    await runSy5("swapped SY5");
    await send("Page.reload", { ignoreCache: true });
    await waitFor(`(() => {
      const pager = document.getElementById("pager")?.textContent || "";
      return /\\/\\s*15/.test(pager) ? pager : "";
    })()`, "reload keeps swap");
    await evaluate(`(${installProbe.toString()})()`);
    await waitFor(`document.querySelector("#readerFlow .rf-block[data-pair-id]") ? "reloaded" : ""`, "pairs after swap reload");
    const keptSwap = await evaluate(`(() => ({
      side: document.querySelector(".workspace")?.dataset.sourceSide || "",
      stored: localStorage.getItem("reader.sourceSide")
    }))()`);
    assert.equal(keptSwap.stored, "end", "reload keeps the stored swap");
    assert.equal(keptSwap.side, "end", "reload applies the stored swap");
    await useCurrentPageScope(clickSelector, waitFor);
    for (let page = 2; page <= 5; page += 1) {
      await clickSelector("#next");
      await waitFor(`document.querySelector('#readerFlow [data-src-page="${page}"][data-pair-id]') ? "p${page}" : ""`, `reloaded page ${page}`, 40000);
    }
    await waitFor(`(() => {
      const pages = new Set([...document.querySelectorAll("#readerFlow .rf-block[data-pair-id]")].map((el) => el.dataset.srcPage || el.dataset.page));
      return ["1", "2", "3", "4", "5"].every((page) => pages.has(page)) ? "ready" : "";
    })()`, "全文 after swap reload", 20000);
    await restampProbes();
    if (await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`) !== "on") {
      await evaluate(`document.body.focus()`);
      await keyTap("f", "KeyF", 70, { text: "f" });
      await frames(2);
    }

    await evaluate(`document.querySelector("[data-theme='sepia']")?.click()`);
    await frames(2);
    await shot("sepia-current");
    await evaluate(`document.querySelector("[data-theme='warm']")?.click()`);

    const focusWhere = () => evaluate(`(() => {
      const el = document.activeElement;
      if (!el) return "";
      if (el.closest(".toolbar")) return "toolbar";
      if (el.closest("#pdfPane")) return "source";
      if (el.closest(".pane-translate")) return "translation";
      if (el.classList.contains("split-handle")) return "split";
      return "other";
    })()`);
    await evaluate(`document.getElementById("moreButton").focus()`);
    await keyTap("Tab", "Tab", 9);
    assert.equal(await focusWhere(), "translation", "SW1 tab leaves the top bar into the first visual pane");
    await evaluate(`document.querySelector(".split-handle").focus()`);
    await keyTap("Tab", "Tab", 9, { modifiers: 8 });
    assert.equal(await focusWhere(), "translation", "SW1 shift-tab from the splitter stays in the first pane");
    await keyTap("Tab", "Tab", 9);
    assert.equal(await focusWhere(), "split", "SW1 tab returns to the splitter");
    await keyTap("Tab", "Tab", 9);
    assert.equal(await focusWhere(), "source", "SW1 tab enters the second visual pane");

    await sy1("SY1 swapped");
    await jumpFromTranslation('[data-oi-probe="paragraph"]');
    await sourceClick('[data-oi-probe="formula"]');

    const splitMeasure = async () => evaluate(`(() => {
      const workspace = document.querySelector(".workspace");
      const source = document.getElementById("pdfPane").getBoundingClientRect().width;
      const handle = document.querySelector(".split-handle");
      const box = handle.getBoundingClientRect();
      const splitW = parseFloat(getComputedStyle(workspace).getPropertyValue("--oi-reader-split-w")) || 8;
      const now = Number(handle.getAttribute("aria-valuenow"));
      const share = Math.round((source / Math.max(1, workspace.clientWidth - splitW)) * 100);
      return { source, width: workspace.clientWidth, splitW, now, share, x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    const expectSource = (width, ratio) => {
      const gap = 8;
      const available = width - gap;
      const tMin = width >= 1200 ? 560 : 540;
      const maxSource = available - tMin;
      const minSource = Math.min(320, maxSource);
      const preferred = ratio * available;
      return Math.min(maxSource, Math.max(minSource, preferred));
    };
    await evaluate(`document.querySelector(".split-handle").focus()`);
    await keyTap("Home", "Home", 36);
    await frames(2);
    let split = await splitMeasure();
    near(split.source, 320, 2, "SW2 min source");
    assert.equal(split.now, split.share, "SW2 aria min");
    await keyTap("End", "End", 35);
    await frames(2);
    split = await splitMeasure();
    near(split.source, split.width - split.splitW - 560, 2, "SW2 max source");
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: split.x, y: split.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: split.x, y: split.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: split.x, y: split.y, button: "left", clickCount: 2 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: split.x, y: split.y, button: "left", clickCount: 2 });
    await frames(2);
    split = await splitMeasure();
    near(split.source, expectSource(split.width, 0.5), 8, "SW2 double click");
    const beforeArrow = split.source;
    await evaluate(`document.activeElement?.blur()`);
    if (await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`) !== "on") {
      await keyTap("f", "KeyF", 70, { text: "f" });
      await frames(2);
    }
    const beforeSplitKey = await evaluate(`(() => ({
      pager: document.getElementById("pager")?.textContent || "",
      follow: document.querySelector(".workspace")?.dataset.follow || ""
    }))()`);
    assert.equal(beforeSplitKey.follow, "on", "follow is on before the splitter arrow");
    await evaluate(`document.querySelector(".split-handle").focus()`);
    await keyTap("ArrowLeft", "ArrowLeft", 37);
    await frames(2);
    split = await splitMeasure();
    near(split.source, beforeArrow + 16, 2, "SW2 end-side ArrowLeft widens source");
    const afterSplitKey = await evaluate(`(() => ({
      pager: document.getElementById("pager")?.textContent || "",
      follow: document.querySelector(".workspace")?.dataset.follow || ""
    }))()`);
    assert.equal(afterSplitKey.pager, beforeSplitKey.pager, "splitter arrow does not turn the page");
    assert.equal(afterSplitKey.follow, "on", "splitter arrow does not pause follow");
    await keyTap("ArrowRight", "ArrowRight", 39, { modifiers: 8 });
    await frames(1);
    split = await splitMeasure();
    const draggedFrom = split.source;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: split.x, y: split.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: split.x - 40, y: split.y, button: "left" });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: split.x - 40, y: split.y, button: "left" });
    await frames(2);
    split = await splitMeasure();
    assert.ok(split.source > draggedFrom + 8, `SW2 drag toward the screen origin widens source (${draggedFrom} -> ${split.source})`);
    await evaluate(`document.querySelector(".split-handle").focus()`);
    await keyTap("Enter", "Enter", 13);
    await frames(2);
    split = await splitMeasure();
    near(split.source, expectSource(split.width, 0.5), 8, "SW2 enter resets");

    await evaluate(`document.body.focus()`);
    await keyTap("s", "KeyS", 83, { text: "s" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.sourceSide || ""`), "start", "s swaps back");
    await evaluate(`document.querySelector(".split-handle").focus()`);
    await keyTap("ArrowRight", "ArrowRight", 39);
    await frames(1);
    const stepped = await splitMeasure();
    await keyTap("ArrowLeft", "ArrowLeft", 37);
    await frames(1);
    const back = await splitMeasure();
    near(stepped.source - back.source, 16, 2, "SW2 start-side arrows are 16px");

    const hits = await evaluate(`(() => {
      const ids = ["#followSwitch", "#moreButton"];
      const rows = ids.map((selector) => {
        const el = document.querySelector(selector);
        return { selector, ...window.__oi.hit(el) };
      });
      return rows;
    })()`);
    for (const row of hits) {
      assert.ok(row.w >= 24 && row.h >= 24, `KB2 ${row.selector} ${row.w}x${row.h}`);
    }
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: true,
      screenWidth: 1440,
      screenHeight: 900
    });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "any-pointer", value: "coarse" }] });
    await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await sleep(80);
    const coarseOn = await evaluate(`window.matchMedia("(pointer: coarse)").matches`);
    assert.equal(coarseOn, true, "KB2 coarse media");
    const coarse = await evaluate(`window.__oi.hit(document.getElementById("followSwitch"))`);
    const visual = await evaluate(`document.getElementById("followSwitch").getBoundingClientRect().height`);
    assert.ok(coarse.w >= 44 && coarse.h >= 44, `KB2 coarse ${coarse.w}x${coarse.h}`);
    near(visual, hits[0].boxH, 0.5, "KB2 visual size");
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await send("Emulation.setEmulatedMedia", { media: "", features: [] });
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    await evaluate(`document.getElementById("file").focus()`);
    const beforeField = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), beforeField, "KB1 ignores fields");
    await evaluate(`document.activeElement?.blur()`);
    assert.equal(await evaluate(`document.activeElement === document.body`), true, "R2 focus is body");
    const beforeMods = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      side: document.querySelector(".workspace")?.dataset.sourceSide || ""
    }))()`);
    await keyTap("f", "KeyF", 70, { text: "f", modifiers: 2 });
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), beforeMods.follow, "R2-Ctrl ignores ctrl");
    await keyTap("f", "KeyF", 70, { text: "f", modifiers: 1 });
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), beforeMods.follow, "R2-Alt ignores alt");
    await keyTap("s", "KeyS", 83, { text: "s", modifiers: 4 });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.sourceSide || ""`), beforeMods.side, "R2-Meta ignores meta");
    await evaluate(`document.activeElement?.blur()`);
    assert.equal(await evaluate(`document.getElementById("aaPanel")?.hidden === true`), true, "shift shortcut panel closed");
    assert.equal(await evaluate(`document.activeElement === document.body`), true, "shift shortcut focus is body");
    const beforeShift = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      side: document.querySelector(".workspace")?.dataset.sourceSide || ""
    }))()`);
    await keyTap("F", "KeyF", 70, { text: "F", modifiers: 8 });
    await keyTap("S", "KeyS", 83, { text: "S", modifiers: 8 });
    await frames(2);
    const afterShift = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      side: document.querySelector(".workspace")?.dataset.sourceSide || ""
    }))()`);
    assert.equal(afterShift.follow, beforeShift.follow, "Shift+F does not toggle follow");
    assert.equal(afterShift.side, beforeShift.side, "Shift+S does not swap panes");
    await clickSelector("#aaButton");
    await clickSelector("#aaSingleKey");
    await keyTap("Escape", "Escape", 27);
    await frames(1);
    await evaluate(`document.activeElement?.blur()`);
    const singleOff = await evaluate(`(() => ({
      panel: document.getElementById("aaPanel")?.hidden === true,
      focus: document.activeElement === document.body,
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      side: document.querySelector(".workspace")?.dataset.sourceSide || ""
    }))()`);
    assert.equal(singleOff.panel, true, "KB1 panel closed");
    assert.equal(singleOff.focus, true, "KB1 focus is body");
    await keyTap("f", "KeyF", 70, { text: "f" });
    await keyTap("s", "KeyS", 83, { text: "s" });
    await frames(2);
    const ignored = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      side: document.querySelector(".workspace")?.dataset.sourceSide || ""
    }))()`);
    assert.equal(ignored.follow, singleOff.follow, "KB1 f ignored when single key is off");
    assert.equal(ignored.side, singleOff.side, "KB1 s ignored when single key is off");
    await clickSelector("#aaButton");
    await clickSelector("#aaSingleKey");
    await keyTap("Escape", "Escape", 27);
    await frames(1);
    await evaluate(`document.activeElement?.blur()`);
    assert.equal(await evaluate(`document.getElementById("aaPanel")?.hidden === true`), true, "KB1 panel stays closed");
    assert.equal(await evaluate(`document.activeElement === document.body`), true, "KB1 focus stays on body");
    const beforeOn = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      side: document.querySelector(".workspace")?.dataset.sourceSide || ""
    }))()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);
    assert.notEqual(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), beforeOn.follow, "KB1 f works when single key is on");
    if (await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`) !== "on") {
      await keyTap("f", "KeyF", 70, { text: "f" });
      await frames(2);
    }
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "KB1 follow restored");
    await keyTap("s", "KeyS", 83, { text: "s" });
    await frames(2);
    assert.notEqual(await evaluate(`document.querySelector(".workspace")?.dataset.sourceSide || ""`), beforeOn.side, "KB1 s works when single key is on");
    await keyTap("s", "KeyS", 83, { text: "s" });
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.sourceSide || ""`), beforeOn.side, "KB1 side restored");

    await send("Emulation.setDeviceMetricsOverride", { width: 899, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    await clickSelector("#moreButton");
    const narrow = await evaluate(`(() => ({
      hidden: document.getElementById("swapPanes")?.hidden === true,
      text: document.querySelector(".toolbar")?.textContent || ""
    }))()`);
    assert.equal(narrow.hidden, true, "VS8 899 hides 互换两栏");
    assert.equal(narrow.text.includes("术语"), false, "VS8 no 术语");
    await keyTap("Escape", "Escape", 27);
    const sideBefore = await evaluate(`localStorage.getItem("reader.sourceSide")`);
    await evaluate(`document.body.focus()`);
    await keyTap("s", "KeyS", 83, { text: "s" });
    await frames(2);
    const narrowSide = await evaluate(`(() => ({
      stored: localStorage.getItem("reader.sourceSide"),
      applied: document.querySelector(".workspace")?.dataset.sourceSide || ""
    }))()`);
    assert.notEqual(narrowSide.stored, sideBefore, "VS8 s works without the menu");
    assert.equal(narrowSide.applied, "start", "VS8 stored side is not applied");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(250);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.sourceSide || ""`), narrowSide.stored, "wide layout applies the stored side");
    if (narrowSide.stored === "end") {
      await evaluate(`document.body.focus()`);
      await keyTap("s", "KeyS", 83, { text: "s" });
      await frames(2);
    }

    const pageNode = await evaluate(`(() => {
      const el = document.querySelector("#readerFlow .rf-block[data-pair-id]");
      window.__oiPage = el;
      return el?.dataset.srcPage || "";
    })()`);
    const pageTarget = pageNode === "2" ? 4 : 2;
    await evaluate(`(() => {
      const wrap = document.querySelector('#pages .pdf-page[data-page="${pageTarget}"]');
      const pages = document.getElementById("pages");
      const pane = pages.getBoundingClientRect();
      const box = wrap.getBoundingClientRect();
      pages.scrollTop += box.top - pane.top;
      return true;
    })()`);
    await frames(4);
    await sleep(200);
    const pageSwapped = await evaluate(`(() => ({
      old: window.__oiPage?.isConnected === true,
      page: document.querySelector("#readerFlow .rf-block")?.dataset.srcPage || "",
      pages: document.querySelectorAll("#readerFlow .rf-page").length
    }))()`);
    assert.equal(pageSwapped.pages, 15, "全文仍铺开全部页槽");
    assert.equal(pageSwapped.old, true, "原文滚动保留已有译文节点");
    assert.equal(pageSwapped.page, pageNode, "第一块仍是原来的页");

    await waitFor(`document.querySelector('#readerFlow [data-src-page="5"][data-pair-id]') ? "back" : ""`, "全文仍留着第 5 页");
    const resumePoint = await evaluate(`(() => {
      const el = document.getElementById("pages");
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    await wheelAt(resumePoint.x, resumePoint.y, 100);
    await sleep(40);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "paused", "PG1 setup");
    const capsule = await evaluate(`(() => {
      const cap = document.getElementById("pageCapsule");
      if (!cap || cap.hidden) return null;
      const box = cap.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, page: cap.dataset.srcPage || "" };
    })()`);
    assert.ok(capsule, "PG1 capsule");
    await mouseClick(capsule.x, capsule.y);
    await frames(3);
    const arrived = await evaluate(`((page) => {
      const wrap = document.querySelector('#pages .pdf-page[data-page="' + page + '"]');
      const pages = document.getElementById("pages");
      const pane = pages.getBoundingClientRect();
      const box = wrap.getBoundingClientRect();
      return { follow: document.querySelector(".workspace")?.dataset.follow || "", delta: box.top - pane.top };
    })(${JSON.stringify(capsule.page)})`);
    assert.equal(arrived.follow, "on", "PG1 capsule resumes follow");
    near(arrived.delta, 0, 8, "PG1 source page top");

    await send("Page.reload", { ignoreCache: true });
    await waitFor(`(() => {
      const pager = document.getElementById("pager")?.textContent || "";
      return /\\/\\s*15/.test(pager) ? pager : "";
    })()`, "FL3 reload");
    const storedOn = await evaluate(`(() => ({
      stored: localStorage.getItem("reader.follow"),
      follow: document.querySelector(".workspace")?.dataset.follow || ""
    }))()`);
    assert.equal(storedOn.stored, "1", "FL3 reload keeps reader.follow 1");
    assert.equal(storedOn.follow, "on", "FL3 reload resumes on");

    const shotProbe = join(ownedDir, "shot2");
    mkdirSync(shotProbe);
    const previousShot = process.env.OI_PAIR_SHOTS_DIR;
    process.env.OI_PAIR_SHOTS_DIR = shotProbe;
    try {
      const written = await shot("shot2");
      assert.equal(written, shotProbe, "SHOT2 reads OI_PAIR_SHOTS_DIR");
      assert.equal(existsSync(join(shotProbe, "shot2.png")), true, "SHOT2 writes into OI_PAIR_SHOTS_DIR");
      assert.equal(existsSync(join(shotDir, "shot2.png")), false, "SHOT2 does not write into the default shot dir");
    } finally {
      if (previousShot == null) delete process.env.OI_PAIR_SHOTS_DIR;
      else process.env.OI_PAIR_SHOTS_DIR = previousShot;
    }
});

// Full-text capsule clicks assign scrollTop while the click driver owns the
// pane, so onPdfScroll takes the ignores("pdf") branch and never reaches
// noteSourcePage. That branch has to call updatePager, or prev/next stay
// latched to the page the source just left.
async function openAttentionPair(t) {
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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-pair-render-"));
  rememberOwnedTemp(handle.ownedDir);
  const userDataDir = join(handle.ownedDir, "profile");
  handle.userDataDir = userDataDir;
  const scratchDir = join(handle.ownedDir, "scratch");
  const downloadDir = join(handle.ownedDir, "downloads");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  mkdirSync(downloadDir);
  const address = handle.server.address();
  const origin = `http://127.0.0.1:${address.port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  const viewer = `${origin}/pdf/viewer.html?src=${encodeURIComponent(src)}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
  await send("Page.enable");
  await send("Runtime.enable");
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadDir,
    eventsEnabled: true
  });
  await send("Page.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false
  });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 30000) => {
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
  const frames = (n = 2) => evaluate(`new Promise((done) => {
    let left = ${n};
    const step = () => { left -= 1; if (left <= 0) done(true); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  })`);
  const clickSelector = async (selector) => {
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return null;
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    assert.ok(point, selector);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    return point;
  };
  const readNav = () => evaluate(`(() => {
    const pages = document.getElementById("pages");
    const pane = pages.getBoundingClientRect();
    const mid = (pane.top + pane.bottom) / 2;
    let source = 0;
    let best = Infinity;
    for (const el of document.querySelectorAll("#pages .pdf-page")) {
      const box = el.getBoundingClientRect();
      if (box.height < 1) continue;
      const dist = Math.abs((box.top + box.bottom) / 2 - mid);
      if (dist < best) {
        best = dist;
        source = Number(el.dataset.page) || 0;
      }
    }
    return {
      source,
      label: document.getElementById("sourcePageLabel")?.textContent || "",
      capsule: document.getElementById("pageCapsule")?.dataset.srcPage || "",
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      prev: document.getElementById("prev")?.disabled === true,
      next: document.getElementById("next")?.disabled === true
    };
  })()`);
  const waitNav = async (goal, label, timeoutMs = 8000) => {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
      last = await readNav();
      if (goal(last)) return last;
      await sleep(100);
    }
    throw new Error(`${label} timed out. last=${JSON.stringify(last)}`);
  };
  const setFollow = async (want) => {
    let state = "";
    for (let i = 0; i < 3; i += 1) {
      state = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
      if (state === want) return state;
      await clickSelector("#followSwitch");
      await frames(3);
    }
    state = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
    assert.equal(state, want, `follow becomes ${want}`);
    return state;
  };
  const showAllThrough = async (lastPage) => {
    await useCurrentPageScope(clickSelector, waitFor);
    for (let page = 2; page <= lastPage; page += 1) {
      await clickSelector("#next");
      await waitFor(
        `document.querySelector('#readerFlow [data-src-page="${page}"][data-pair-id]') ? "p${page}" : ""`,
        `page ${page} pairs`,
        40000
      );
    }
    const wanted = JSON.stringify(Array.from({ length: lastPage }, (_, index) => String(index + 1)));
    await waitFor(`(() => {
      const have = new Set([...document.querySelectorAll("#readerFlow .rf-block[data-pair-id]")].map((el) => el.dataset.srcPage || el.dataset.page));
      return ${wanted}.every((page) => have.has(page)) ? "ready" : "";
    })()`, `全文 pages 1-${lastPage}`, 20000);
  };
  const parkSource = async (page) => {
    const parked = await evaluate(`(() => {
      const wrap = document.querySelector('#pages .pdf-page[data-page="${page}"]');
      if (!wrap) return false;
      wrap.scrollIntoView({ block: "start", behavior: "auto" });
      return true;
    })()`);
    assert.equal(parked, true, `source page ${page} exists`);
    await frames(4);
    await sleep(200);
  };

  await send("Page.navigate", { url: viewer });
  await waitFor(`(() => {
    const pager = document.getElementById("pager")?.textContent || "";
    const next = document.getElementById("next");
    return /\\/\\s*15/.test(pager) && next && !next.disabled ? pager : "";
  })()`, "Attention PDF open");
  await waitFor(`document.querySelector("#readerFlow .rf-block[data-pair-id]") ? "p1" : ""`, "page 1 pairs");
  await assertOpenedOnFullDocument(evaluate, waitFor);
  return { evaluate, waitFor, clickSelector, frames, readNav, waitNav, setFollow, showAllThrough, parkSource };
}

test("CAP1 全文跟随关：原文在第 1 页时点胶囊第 4 页，上一页恢复可用", { timeout: 300000 }, async (t) => {
  const { clickSelector, frames, waitNav, setFollow, showAllThrough, parkSource } = await openAttentionPair(t);
  await setFollow("off");
  await showAllThrough(4);
  await setFollow("off");
  await parkSource(1);
  const parked = await waitNav(
    (row) => row.follow === "off" && row.source === 1 && row.prev === true && row.capsule === "4",
    "CAP1 parked on page 1 with capsule 4"
  );
  assert.equal(parked.source, 1, "CAP1 source starts on page 1");
  assert.equal(parked.prev, true, "CAP1 #prev.disabled === true on page 1");
  assert.equal(parked.capsule, "4", "CAP1 capsule is page 4");
  assert.equal(parked.follow, "off", "CAP1 follow is off");
  await clickSelector("#pageCapsule");
  await frames(4);
  const jumped = await waitNav(
    (row) => row.source === 4 && row.prev === false && row.follow === "off",
    "CAP1 capsule jump enables prev"
  );
  assert.equal(jumped.source, 4, "CAP1 source is page 4");
  assert.equal(jumped.prev, false, "CAP1 #prev.disabled === false after the capsule");
  assert.equal(jumped.capsule, "4", "CAP1 capsule stays on page 4");
  assert.equal(jumped.follow, "off", "CAP1 follow stays off");
  await clickSelector("#prev");
  await frames(4);
  const stepped = await waitNav((row) => row.source === 3, "CAP1 prev reaches page 3");
  assert.equal(stepped.source, 3, "CAP1 #prev goes to source page 3");
});

test("CAP2 全文跟随开：原文在第 15 页时点胶囊第 5 页，下一页恢复可用", { timeout: 300000 }, async (t) => {
  const { clickSelector, frames, waitNav, setFollow, showAllThrough, parkSource } = await openAttentionPair(t);
  await showAllThrough(5);
  await setFollow("on");
  await parkSource(15);
  const parked = await waitNav(
    (row) => row.follow === "on" && row.source === 15 && row.next === true && row.capsule === "5",
    "CAP2 parked on page 15 with capsule 5"
  );
  assert.equal(parked.source, 15, "CAP2 source starts on page 15");
  assert.equal(parked.next, true, "CAP2 #next.disabled === true on page 15");
  assert.equal(parked.capsule, "5", "CAP2 capsule is page 5");
  assert.equal(parked.follow, "on", "CAP2 follow is on");
  await clickSelector("#pageCapsule");
  await frames(4);
  const jumped = await waitNav(
    (row) => row.source === 5 && row.next === false && row.follow === "on",
    "CAP2 capsule jump enables next"
  );
  assert.equal(jumped.source, 5, "CAP2 source is page 5");
  assert.equal(jumped.next, false, "CAP2 #next.disabled === false after the capsule");
  assert.equal(jumped.capsule, "5", "CAP2 capsule stays on page 5");
  assert.equal(jumped.follow, "on", "CAP2 follow stays on");
  await clickSelector("#next");
  await frames(4);
  const stepped = await waitNav((row) => row.source === 6, "CAP2 next reaches page 6");
  assert.equal(stepped.source, 6, "CAP2 #next goes to source page 6");
});
