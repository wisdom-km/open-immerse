// Local gitignored fixture: tests/fixtures/Attention_Is_All_You_Need.pdf
// arXiv v7, https://arxiv.org/pdf/1706.03762v7
// sha256 bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const shotDir = "/opt/cursor/artifacts/screenshots";
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
  mkdirSync(shotDir, { recursive: true });
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-pair-render-"));
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
    const send = (method, params, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs);
    await send("Page.enable");
    await send("Runtime.enable");
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
      const { data } = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      writeFileSync(join(shotDir, `${name}.png`), Buffer.from(data, "base64"));
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

    for (let page = 2; page <= 5; page += 1) {
      await clickSelector("#next");
      await waitFor(`document.querySelector('#readerFlow [data-src-page="${page}"][data-pair-id]') ? "p${page}" : ""`, `page ${page} pairs`, 40000);
    }
    await clickSelector('[data-scope="all"]');
    await waitFor(`(() => {
      const pages = new Set([...document.querySelectorAll("#readerFlow .rf-block[data-pair-id]")].map((el) => el.dataset.srcPage || el.dataset.page));
      return ["1", "2", "3", "4", "5"].every((page) => pages.has(page)) ? "ready" : "";
    })()`, "全文 pages 1-5", 20000);
    await evaluate(`document.body.focus()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(3);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "resume follow after paging");

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

    const stepTranslation = async (steps) => {
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
        near(after.trans, expectedTrans, 1, `FL2 translation scroll ${i}`);
        assert.equal(after.follow, "on", "FL2 follow stayed on");
        if (Math.abs(after.source - before.source) > 1) {
          const clamped = after.placed.scrollTop <= 1 || after.placed.scrollTop >= after.placed.max - 2;
          if (!clamped) near(after.placed.top - after.placed.pagesTop, 0.3 * after.placed.client, 8, `FL2 source 30% step ${i}`);
        } else if (after.placed) {
          assert.ok(after.placed.top >= after.placed.pagesTop - 1 && after.placed.bottom <= after.placed.pagesBottom + 1, `FL2 rect inside at step ${i}`);
        }
        if (Number(after.page) >= 5 && Number(before.page) >= 3) return after.page;
      }
      return await evaluate(`document.getElementById("pageCapsule")?.dataset.srcPage || ""`);
    };
    await evaluate(`(() => {
      const el = [...document.querySelectorAll('#readerFlow .rf-block[data-src-page="3"][data-pair-id]')][2] || document.querySelector('#readerFlow .rf-block[data-src-page="3"][data-pair-id]');
      el.dataset.oiProbe = "p3";
      return true;
    })()`);
    await scrollPairToAnchor('[data-oi-probe="p3"]');
    const reached = await stepTranslation(24);
    assert.ok(Number(reached) >= 5, `FL2 reached page ${reached}`);

    const pagesPoint = await evaluate(`(() => {
      const el = document.getElementById("pages");
      const box = el.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2, source: el.scrollTop };
    })()`);
    await wheelAt(pagesPoint.x, pagesPoint.y, 140);
    await sleep(80);
    const paused = await evaluate(`(() => ({
      follow: document.querySelector(".workspace")?.dataset.follow || "",
      status: document.getElementById("sourceStatus")?.textContent || ""
    }))()`);
    assert.equal(paused.follow, "paused", "FL3 wheel pauses");
    assert.match(paused.status, /跟随已暂停/, "FL3 header");
    await shot("paused-header");
    const heldSource = await evaluate(`document.getElementById("pages").scrollTop`);
    await evaluate(`document.getElementById("translateScroll").scrollTop += 180`);
    await frames(3);
    assert.equal(await evaluate(`document.getElementById("pages").scrollTop`), heldSource, "FL3 paused source stays");

    await evaluate(`document.body.focus()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(3);
    await sleep(80);
    const resumed = await evaluate(`(() => {
      const current = document.querySelector("#readerFlow .rf-block.is-pair-current");
      const placed = current ? window.__oi.sourceAnchor(window.__oi.firstRect(current.dataset.pairId)) : null;
      return { follow: document.querySelector(".workspace")?.dataset.follow || "", placed };
    })()`);
    assert.equal(resumed.follow, "on", "FL3 f resumes");
    if (resumed.placed && resumed.placed.scrollTop > 1 && resumed.placed.scrollTop < resumed.placed.max - 2) {
      near(resumed.placed.top - resumed.placed.pagesTop, 0.3 * resumed.placed.client, 8, "FL3 f lands at 30%");
    }

    await wheelAt(pagesPoint.x, pagesPoint.y, 80);
    await sleep(50);
    await clickSelector('[data-action="resume-follow"]');
    await frames(3);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "FL3 恢复");

    await wheelAt(pagesPoint.x, pagesPoint.y, 80);
    await sleep(50);
    await evaluate(`document.querySelector("#readerFlow .rf-block.is-pair-current")?.scrollIntoView({ block: "center", behavior: "auto" })`);
    await frames(2);
    await clickSelector("#readerFlow .rf-block.is-pair-current");
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "FL3 block click resumes");
    assert.equal(await evaluate(`localStorage.getItem("reader.follow")`), "1", "FL3 pause does not store off");

    const zoomBefore = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
    await clickSelector("#zoomIn");
    await sleep(200);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), zoomBefore, "zoom does not pause");
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await sleep(200);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "on", "resize does not pause");
    await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(200);

    await clickSelector("#followSwitch");
    await frames(2);
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), "off", "FL4 off");
    await evaluate(`document.getElementById("pages").scrollTop = document.getElementById("pages").scrollHeight`);
    await frames(3);
    const showCurrent = await evaluate(`document.querySelector("[data-action='show-current']")?.textContent || ""`);
    assert.match(showCurrent, /当前段/, "FL4 当前段");
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
    assert.equal(shown.follow, "off", "FL4 switch stays off");
    assert.equal(shown.checked, "false", "FL4 aria stays off");
    if (shown.placed && shown.placed.scrollTop > 1 && shown.placed.scrollTop < shown.placed.max - 2) {
      near(shown.placed.top - shown.placed.pagesTop, 0.3 * shown.placed.client, 8, "FL4 show current");
    }
    await evaluate(`document.body.focus()`);
    await keyTap("f", "KeyF", 70, { text: "f" });
    await frames(2);

    const sy1 = async (label) => {
      const marker = await evaluate(`(() => {
        const el = document.querySelector("#readerFlow .rf-block[data-pair-id]");
        window.__oiMark = el;
        return {
          trans: document.getElementById("translateScroll").scrollTop,
          scope: document.querySelector(".scope-seg-btn.is-on")?.dataset.scope || ""
        };
      })()`);
      assert.equal(marker.scope, "all", `${label} scope`);
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

    const lockedAt = await evaluate(`(() => ({
      lock: document.querySelector(".workspace")?.dataset.jumpLock || "",
      trans: document.getElementById("translateScroll").scrollTop,
      source: document.getElementById("pages").scrollTop
    }))()`);
    assert.equal(lockedAt.lock, "1", "SY4 locked");
    await sleep(1000);
    const still = await evaluate(`(() => ({
      lock: document.querySelector(".workspace")?.dataset.jumpLock || "",
      trans: document.getElementById("translateScroll").scrollTop,
      source: document.getElementById("pages").scrollTop
    }))()`);
    assert.equal(still.lock, "1", "SY4 still locked at 1000ms");
    assert.equal(still.trans, lockedAt.trans, "SY4 translation held");
    assert.equal(still.source, lockedAt.source, "SY4 source held");
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
    assert.equal(unlocked.lock, "", "SY4 wheel clears lock");
    assert.notEqual(unlocked.top, transPoint.top, "SY4 wheel scrolls");

    await jumpFromTranslation('[data-oi-probe="paragraph"]');
    await keyTap("Escape", "Escape", 27);
    await frames(2);
    const escaped = await evaluate(`(() => ({
      jump: document.querySelectorAll("#pages .pair-box.is-jump").length,
      passive: document.querySelectorAll("#pages .pair-box:not(.is-jump)").length
    }))()`);
    assert.equal(escaped.jump, 0, "SY5 esc removes jump");
    assert.ok(escaped.passive > 0, "SY5 passive stays");
    await sleep(1600);
    const previous = await evaluate(`document.querySelector("#readerFlow .rf-block.is-pair-current")?.dataset.pairId || ""`);
    await evaluate(`document.getElementById("translateScroll").scrollTop += document.getElementById("translateScroll").clientHeight`);
    await frames(4);
    const changed = await evaluate(`(() => ({
      id: document.querySelector("#readerFlow .rf-block.is-pair-current")?.dataset.pairId || "",
      jump: document.querySelectorAll("#pages .pair-box.is-jump").length,
      passive: document.querySelectorAll("#pages .pair-box").length
    }))()`);
    assert.notEqual(changed.id, previous, "SY5 current changed");
    assert.equal(changed.jump, 0, "SY5 old jump gone");
    assert.ok(changed.passive > 0, "SY5 new passive box");

    const ratioBefore = await evaluate(`document.querySelector(".workspace").style.getPropertyValue("--oi-split-ratio")`);
    const followBefore = await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`);
    const zoomBeforeSwap = await evaluate(`document.getElementById("zoomLabel").textContent`);
    const sourceBeforeSwap = await evaluate(`document.getElementById("pages").scrollTop`);
    await evaluate(`document.getElementById("moreButton").focus()`);
    await keyTap("Enter", "Enter", 13);
    await frames(2);
    let menuOpen = await evaluate(`document.getElementById("moreMenu")?.hidden === false`);
    if (!menuOpen) await clickSelector("#moreButton");
    await shot("more-menu");
    const menuOrder = await evaluate(`(() => [...document.querySelectorAll("#moreMenu [role='menuitem'], #moreMenu [role='menuitemcheckbox'], #moreMenu [role='separator']")].filter((el) => !el.hidden).map((el) => (el.getAttribute("role") === "separator" ? "separator" : el.textContent.replace(/\\s+/g, " ").trim())))()`);
    assert.deepEqual(menuOrder, ["互换两栏s", "separator", "导出 MD", "导出 PDF"]);
    await keyTap("Enter", "Enter", 13);
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
    await evaluate(`document.querySelector(".split-handle").focus()`);
    await keyTap("ArrowLeft", "ArrowLeft", 37);
    await frames(1);
    split = await splitMeasure();
    near(split.source, beforeArrow + 16, 2, "SW2 end-side ArrowLeft widens source");
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
    await evaluate(`document.body.focus()`);
    await keyTap("f", "KeyF", 70, { text: "f", modifiers: 2 });
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.follow || ""`), beforeField, "KB1 ignores ctrl");
    await clickSelector("#aaButton");
    await clickSelector("#aaSingleKey");
    await evaluate(`document.body.focus()`);
    await keyTap("s", "KeyS", 83, { text: "s" });
    assert.equal(await evaluate(`document.querySelector(".workspace")?.dataset.sourceSide || ""`), "start", "KB1 single key off");
    await clickSelector("#aaSingleKey");
    await clickSelector("#aaButton");
    await evaluate(`document.body.focus()`);

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

    await clickSelector('[data-scope="page"]');
    await frames(3);
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
      scope: document.querySelector(".scope-seg-btn.is-on")?.dataset.scope || ""
    }))()`);
    assert.equal(pageSwapped.scope, "page", "当前页 scope");
    assert.equal(pageSwapped.old, false, "当前页 replaces the flow");
    assert.equal(pageSwapped.page, String(pageTarget), "当前页 follows the source page");

    await clickSelector('[data-scope="all"]');
    await waitFor(`document.querySelector('#readerFlow [data-src-page="5"][data-pair-id]') ? "back" : ""`, "return to 全文");
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
});
