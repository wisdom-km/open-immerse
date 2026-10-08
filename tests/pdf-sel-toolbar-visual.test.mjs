// Headless checks for the SEL-20 polish: strip vs current-block wash,
// menu direction, pointer focus, and the narrow bottom sheet.
// Screenshots: SEL-05 coarse, SEL-03 clamp, SEL-08 disabled.
// Fixtures stay gitignored:
//   tests/fixtures/Attention_Is_All_You_Need.pdf (arXiv 1706.03762v7)
//   tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf (arXiv 2305.18290v3)
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const PREFIXES = ["oi-sel-visual-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const attention = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const dpo = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
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

const HOOKS = `(() => {
  window.__selText = function (block) {
    return (block?.querySelector(".rf-zh")?.textContent || "").replace(/\\s+/g, " ").trim();
  };
  window.__selArm = function (block, mode) {
    const zh = block?.querySelector(".rf-zh");
    if (!zh) return null;
    const nodes = [];
    const walker = document.createTreeWalker(zh, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if ((node.textContent || "").trim().length >= 2) nodes.push(node);
    }
    if (!nodes.length) return null;
    const target = mode === "end" ? nodes[nodes.length - 1] : nodes[0];
    const value = target.textContent || "";
    const range = document.createRange();
    if (mode === "end") {
      range.setStart(target, Math.max(0, value.length - 3));
      range.setEnd(target, value.length);
    } else {
      const lead = value.length - value.trimStart().length;
      const from = Math.min(lead, Math.max(0, value.length - 2));
      range.setStart(target, from);
      range.setEnd(target, Math.min(value.length, from + 28));
    }
    if (range.collapsed) return null;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    (range.startContainer.parentElement || zh).dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1 }));
    const rect = range.getBoundingClientRect();
    return { text: range.toString(), top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height };
  };
  window.__selPlaceBlock = function (block) {
    const pane = document.getElementById("translateScroll");
    if (!pane || !block) return false;
    const paneBox = pane.getBoundingClientRect();
    const anchor = paneBox.top + paneBox.height * 0.32;
    const box = block.getBoundingClientRect();
    pane.scrollTop += box.top - (anchor - 90);
    return true;
  };
  window.__selLong = function (pred) {
    return [...document.querySelectorAll("#readerFlow .rf-block[data-pair-id]")].find((el) => {
      if (window.__selText(el).length < 48) return false;
      return pred ? pred(el) : true;
    }) || null;
  };
  return true;
})()`;

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
      const body = readFileSync(file);
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

test("SEL-20 polish holds in headless Chrome on Attention and DPO", { timeout: 300000 }, async (t) => {
  assert.equal(existsSync(attention), true, "tests/fixtures/Attention_Is_All_You_Need.pdf is missing");
  assert.equal(existsSync(dpo), true, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf is missing");

  const handle = { child: null, cdp: null, server: null, ownedDir: null, userDataDir: null };
  const shotDir = { path: "" };
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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-sel-visual-"));
  rememberOwnedTemp(handle.ownedDir);
  shotDir.path = join(handle.ownedDir, "shots");
  mkdirSync(shotDir.path);
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
  const frames = (n = 2) => evaluate(`new Promise((done) => {
    let left = ${n};
    const step = () => { left -= 1; if (left <= 0) done(true); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  })`);
  const clickAt = async (x, y) => {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await frames();
  };
  const keyTap = async (key, code, vk, modifiers = 0, text = "") => {
    const down = {
      type: text ? "keyDown" : "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers
    };
    if (text) {
      down.text = text;
      down.unmodifiedText = text;
    }
    await send("Input.dispatchKeyEvent", down);
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers
    });
    await frames();
  };
  const buttonPoint = async (action) => evaluate(`(() => {
    const el = document.querySelector(".oi-sel-toolbar [data-sel-action='${action}']");
    if (!el) return null;
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, disabled: el.disabled, title: el.title || "" };
  })()`);
  const focusState = () => evaluate(`(() => {
    const el = document.activeElement;
    return {
      tag: el ? el.tagName : "",
      action: el?.dataset?.selAction || "",
      role: el?.getAttribute?.("role") || "",
      focusVisible: Boolean(el?.matches?.(":focus-visible")),
      offset: el ? getComputedStyle(el).outlineOffset : ""
    };
  })()`);
  const saveShot = async (name, clip) => {
    const params = { format: "png", fromSurface: true };
    if (clip) params.clip = clip;
    const { data } = await send("Page.captureScreenshot", params);
    const buf = Buffer.from(data, "base64");
    assert.ok(buf.length > 1500, `${name} screenshot is empty`);
    writeFileSync(join(shotDir.path, name), buf);
    const artifacts = "/opt/cursor/artifacts/screenshots";
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, name), buf);
    t.diagnostic(`${name} ${buf.length} bytes`);
    return buf.length;
  };
  const annotate = (rects) => evaluate(`(() => {
    document.getElementById("oi-shot-notes")?.remove();
    const layer = document.createElement("div");
    layer.id = "oi-shot-notes";
    layer.style.cssText = "position:fixed;inset:0;z-index:10000;pointer-events:none;";
    const items = ${JSON.stringify(rects)};
    for (const item of items) {
      const box = document.createElement("div");
      box.style.cssText = "position:fixed;left:" + item.x + "px;top:" + item.y + "px;width:" + item.w + "px;height:" + item.h + "px;border:2px solid " + (item.color || "#E23B2F") + ";box-sizing:border-box;";
      const label = document.createElement("div");
      label.textContent = item.label;
      label.style.cssText = "position:absolute;left:0;top:-18px;background:#17140f;color:#fff;font:600 12px/16px sans-serif;padding:0 4px;white-space:nowrap;";
      box.append(label);
      layer.append(box);
    }
    document.body.append(layer);
    return true;
  })()`);
  const clearNotes = () => evaluate(`(() => { document.getElementById("oi-shot-notes")?.remove(); return true; })()`);
  const metrics = async (width, height) => {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    });
    await frames(3);
  };

  await metrics(1440, 900);
  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(`${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`)}` });
  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    return /\\/\\s*15/.test(pager) ? pager : "";
  })()`, "Attention open");
  await evaluate(HOOKS);
  await waitFor(`(() => {
    const blocks = [...document.querySelectorAll("#readerFlow .rf-block[data-pair-id]")].filter((el) => window.__selText(el).length > 48);
    return blocks.length >= 2 ? String(blocks.length) : "";
  })()`, "Attention blocks");

  const armOther = async () => {
    const armed = await evaluate(`(() => {
      const current = document.querySelector("#readerFlow .rf-block.is-pair-current[data-pair-id]");
      let other = current?.nextElementSibling || null;
      while (other && !(other.classList?.contains("rf-block") && other.dataset.pairId && window.__selText(other).length > 20)) {
        other = other.nextElementSibling;
      }
      if (!other) other = window.__selLong((el) => el !== current);
      if (!other) return null;
      const pane = document.getElementById("translateScroll");
      const paneBox = pane.getBoundingClientRect();
      const box = other.getBoundingClientRect();
      if (box.bottom < paneBox.top + 24 || box.top > paneBox.bottom - 24) {
        pane.scrollTop += box.top - (paneBox.bottom - 120);
      }
      return window.__selArm(other, "mid");
    })()`);
    await frames();
    await waitFor(`(() => {
      const bar = document.querySelector(".oi-sel-toolbar");
      return bar && !bar.hidden ? "bar" : "";
    })()`, "toolbar for a block that is not current", 8000);
    return armed;
  };

  await armOther();
  const see = await buttonPoint("see-source");
  assert.ok(see && see.disabled === false, JSON.stringify(see));
  await clickAt(see.x, see.y);
  const pointerFocus = await focusState();
  assert.equal(pointerFocus.focusVisible, false, JSON.stringify(pointerFocus));
  assert.notEqual(pointerFocus.action, "see-source");
  const loose = await evaluate(`(() => {
    const strip = document.querySelector(".oi-src-strip");
    const block = strip?.previousElementSibling;
    if (!strip || !block) return null;
    const style = getComputedStyle(strip);
    return {
      current: block.classList.contains("is-pair-current"),
      marginTop: style.marginTop,
      padding: style.padding,
      align: getComputedStyle(strip.querySelector(".oi-src-strip-text")).textAlign
    };
  })()`);
  assert.ok(loose, "inline strip missing");
  assert.equal(loose.current, false, JSON.stringify(loose));
  assert.equal(loose.marginTop, "-8px", JSON.stringify(loose));
  assert.ok(loose.padding === "4px 0px 4px 12px" || loose.padding === "4px 0 4px 12px", JSON.stringify(loose));
  assert.ok(loose.align === "start" || loose.align === "left", JSON.stringify(loose));
  const closeStrip = await evaluate(`(() => {
    const btn = document.querySelector(".oi-src-strip-x");
    if (!btn) return null;
    const box = btn.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  assert.ok(closeStrip, "strip close button missing");
  await clickAt(closeStrip.x, closeStrip.y);
  await waitFor(`(() => document.querySelector(".oi-src-strip") ? "" : "gone")()`, "strip dismissed", 4000);

  const placed = await evaluate(`(() => {
    const block = window.__selLong((el) => true);
    if (!block) return null;
    window.__selPlaceBlock(block);
    return block.dataset.bid || "block";
  })()`);
  assert.ok(placed, "no long paired block");
  await frames(3);
  await evaluate(`(() => {
    const block = document.querySelector("#readerFlow .rf-block.is-pair-current[data-pair-id]") || window.__selLong((el) => true);
    return window.__selArm(block, "mid");
  })()`);
  await frames();
  await waitFor(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    return bar && !bar.hidden && bar.dataset.placement === "above" ? "above" : "";
  })()`, "toolbar above the selection", 8000);

  const seeAgain = await buttonPoint("see-source");
  assert.ok(seeAgain && seeAgain.disabled === false, JSON.stringify(seeAgain));
  const selectionBefore = await evaluate(`(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount < 1) return null;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
  })()`);
  await clickAt(seeAgain.x, seeAgain.y);
  const pointerAgain = await focusState();
  assert.equal(pointerAgain.focusVisible, false, JSON.stringify(pointerAgain));
  const tight = await evaluate(`(() => {
    const strip = document.querySelector(".oi-src-strip");
    const block = strip?.previousElementSibling;
    if (!strip || !block) return null;
    const blockBox = block.getBoundingClientRect();
    const stripBox = strip.getBoundingClientRect();
    const wash = getComputedStyle(block, "::before");
    const bar = document.querySelector(".oi-sel-toolbar");
    const btn = bar?.querySelector(".oi-sel-btn");
    const btnStyle = btn ? getComputedStyle(btn) : null;
    const barStyle = bar ? getComputedStyle(bar) : null;
    return {
      current: block.classList.contains("is-pair-current"),
      marginTop: getComputedStyle(strip).marginTop,
      blockBottom: blockBox.bottom,
      stripTop: stripBox.top,
      washBottom: wash.bottom,
      barH: bar ? bar.getBoundingClientRect().height : 0,
      btnH: btn ? btn.getBoundingClientRect().height : 0,
      weight: btnStyle?.fontWeight || "",
      lineHeight: btnStyle?.lineHeight || "",
      barSpecified: barStyle?.height || ""
    };
  })()`);
  assert.ok(tight, "current-block strip missing");
  assert.equal(tight.current, true, JSON.stringify(tight));
  assert.equal(tight.marginTop, "8px", JSON.stringify(tight));
  assert.ok(tight.stripTop >= tight.blockBottom + 6 - 0.5, JSON.stringify(tight));
  assert.equal(tight.barH, 36, JSON.stringify(tight));
  assert.equal(tight.btnH, 32, JSON.stringify(tight));
  assert.equal(tight.weight, "500", JSON.stringify(tight));
  assert.equal(tight.lineHeight, "32px", JSON.stringify(tight));

  const more = await buttonPoint("more");
  assert.ok(more, "more button missing");
  await clickAt(more.x, more.y);
  const menuGeo = await evaluate(`(() => {
    const menu = document.querySelector(".oi-sel-menu");
    const bar = document.querySelector(".oi-sel-toolbar");
    const sel = window.getSelection();
    const live = sel && sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
    const stored = ${JSON.stringify(selectionBefore)};
    const selTop = live && live.height > 0 ? live.top : stored.top;
    const menuBox = menu.getBoundingClientRect();
    const barBox = bar.getBoundingClientRect();
    const item = menu.querySelector("[role='menuitem']");
    const hint = item?.querySelector(".k");
    const hintStyle = hint ? getComputedStyle(hint) : null;
    const itemStyle = item ? getComputedStyle(item) : null;
    return {
      placement: bar.dataset.placement,
      hidden: menu.hidden,
      menuTop: menuBox.top,
      menuBottom: menuBox.bottom,
      barTop: barBox.top,
      barBottom: barBox.bottom,
      selTop,
      itemFocus: Boolean(item?.matches(":focus-visible")),
      hintSize: hintStyle?.fontSize || "",
      hintOpacity: hintStyle?.opacity || "",
      itemWeight: itemStyle?.fontWeight || "",
      itemH: item ? item.getBoundingClientRect().height : 0
    };
  })()`);
  assert.equal(menuGeo.hidden, false, JSON.stringify(menuGeo));
  assert.equal(menuGeo.placement, "above", JSON.stringify(menuGeo));
  assert.ok(menuGeo.menuBottom < menuGeo.selTop, JSON.stringify(menuGeo));
  assert.ok(menuGeo.menuBottom <= menuGeo.barTop + 1, JSON.stringify(menuGeo));
  assert.equal(menuGeo.itemFocus, false, JSON.stringify(menuGeo));
  assert.equal(menuGeo.hintSize, "11px", JSON.stringify(menuGeo));
  assert.ok(Math.abs(Number(menuGeo.hintOpacity) - 0.55) < 0.02, JSON.stringify(menuGeo));
  assert.equal(menuGeo.itemWeight, "500", JSON.stringify(menuGeo));
  assert.equal(menuGeo.itemH, 32, JSON.stringify(menuGeo));
  await evaluate(`(() => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    return true;
  })()`);
  await frames();

  await evaluate(`(() => {
    const block = document.querySelector("#readerFlow .rf-block.is-pair-current[data-pair-id]") || window.__selLong((el) => true);
    return window.__selArm(block, "mid");
  })()`);
  await frames();
  await waitFor(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    return bar && !bar.hidden ? "bar" : "";
  })()`, "toolbar before keyboard", 8000);
  await keyTap("F10", "F10", 121, 8);
  const f10 = await focusState();
  assert.equal(f10.focusVisible, true, JSON.stringify(f10));
  assert.equal(f10.action, "see-source", JSON.stringify(f10));
  await keyTap("ArrowRight", "ArrowRight", 39);
  const roved = await focusState();
  assert.equal(roved.focusVisible, true, JSON.stringify(roved));
  assert.equal(roved.action, "jump-source", JSON.stringify(roved));
  await keyTap("ArrowRight", "ArrowRight", 39);
  const onMore = await focusState();
  assert.equal(onMore.focusVisible, true, JSON.stringify(onMore));
  assert.equal(onMore.action, "more", JSON.stringify(onMore));
  await keyTap("Enter", "Enter", 13, 0, "\r");
  const menuKey = await focusState();
  assert.equal(menuKey.focusVisible, true, JSON.stringify(menuKey));
  assert.equal(menuKey.role, "menuitem", JSON.stringify(menuKey));
  assert.equal(menuKey.offset, "-2px", JSON.stringify(menuKey));
  await keyTap("Escape", "Escape", 27);
  const restored = await focusState();
  assert.equal(restored.focusVisible, true, JSON.stringify(restored));
  assert.equal(restored.action, "more", JSON.stringify(restored));

  await keyTap("Escape", "Escape", 27);
  const clamped = await evaluate(`(() => {
    const root = document.getElementById("translateScroll");
    const rootBox = root.getBoundingClientRect();
    const contentRight = rootBox.left + root.clientLeft + root.clientWidth;
    const contentLeft = rootBox.left + root.clientLeft;
    const flow = document.querySelector("#readerFlow");
    const flowBox = flow ? flow.getBoundingClientRect() : null;
    const flowRight = flowBox ? flowBox.right : contentRight;
    let best = null;
    for (const zh of document.querySelectorAll("#readerFlow .rf-block[data-pair-id] .rf-zh")) {
      const host = zh.closest(".rf-block");
      if (!host?.dataset?.bid) continue;
      const hostBox = host.getBoundingClientRect();
      if (hostBox.bottom < rootBox.top + 40 || hostBox.top > rootBox.bottom - 20) continue;
      const walker = document.createTreeWalker(zh, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const value = node.textContent || "";
        if (value.trim().length < 12) continue;
        let rightmost = null;
        for (let i = 0; i < value.length; i += 1) {
          if (/\\s/.test(value[i])) continue;
          const probe = document.createRange();
          probe.setStart(node, i);
          probe.setEnd(node, i + 1);
          const rect = probe.getBoundingClientRect();
          if (rect.width < 0.4 || rect.height < 1) continue;
          if (rect.top < rootBox.top + 80 || rect.bottom > rootBox.bottom - 40) continue;
          if (!rightmost || rect.right > rightmost.right) {
            rightmost = { index: i, right: rect.right, top: rect.top };
          }
        }
        if (!rightmost || flowRight - rightmost.right > 28) continue;
        let start = rightmost.index;
        let count = 1;
        while (start > 0 && count < 3) {
          if (/\\s/.test(value[start - 1])) break;
          const probe = document.createRange();
          probe.setStart(node, start - 1);
          probe.setEnd(node, start);
          const rect = probe.getBoundingClientRect();
          if (Math.abs(rect.top - rightmost.top) > 3) break;
          start -= 1;
          count += 1;
        }
        if (!best || rightmost.right > best.right) {
          best = { node, start, end: rightmost.index + 1, right: rightmost.right };
        }
      }
    }
    if (!best) return {
      found: false,
      contentRight,
      contentLeft,
      rootW: root.clientWidth,
      flow: flowBox ? { left: flowBox.left, right: flowBox.right, width: flowBox.width } : null
    };
    const range = document.createRange();
    range.setStart(best.node, best.start);
    range.setEnd(best.node, best.end);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    (range.startContainer.parentElement || best.node.parentElement).dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0, detail: 1 }));
    const rect = range.getBoundingClientRect();
    return { found: true, lineRight: best.right, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, text: range.toString() };
  })()`);
  assert.equal(clamped.found, true, JSON.stringify(clamped));
  await frames();
  await waitFor(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    return bar && !bar.hidden ? "bar" : "";
  })()`, "clamped toolbar", 8000);
  const clampBox = await evaluate(`(() => {
    const root = document.getElementById("translateScroll");
    const bar = document.querySelector(".oi-sel-toolbar");
    const rootBox = root.getBoundingClientRect();
    const contentRight = rootBox.left + root.clientLeft + root.clientWidth;
    const contentLeft = rootBox.left + root.clientLeft;
    const barBox = bar.getBoundingClientRect();
    const sel = window.getSelection().getRangeAt(0).getBoundingClientRect();
    return {
      gapRight: contentRight - barBox.right,
      gapLeft: barBox.left - contentLeft,
      bar: { x: barBox.left, y: barBox.top, w: barBox.width, h: barBox.height },
      sel: { x: sel.left, y: sel.top, w: sel.width, h: sel.height },
      edge: contentRight
    };
  })()`);
  assert.ok(clampBox.gapRight >= 8 && clampBox.gapRight <= 12, JSON.stringify(clampBox));
  assert.ok(clampBox.gapLeft >= 10, JSON.stringify(clampBox));
  assert.ok(clampBox.bar.x + clampBox.bar.w <= clampBox.edge + 0.5, JSON.stringify(clampBox));
  await annotate([
    { x: clampBox.bar.x, y: clampBox.bar.y, w: clampBox.bar.w, h: clampBox.bar.h, label: `条贴边 ${clampBox.gapRight.toFixed(1)}px`, color: "#2F55D4" },
    { x: clampBox.sel.x, y: clampBox.sel.y, w: Math.max(clampBox.sel.w, 2), h: clampBox.sel.h, label: "选区", color: "#A86B12" }
  ]);
  await saveShot("SEL-03-attention-clamp.png");
  await clearNotes();

  await metrics(880, 760);
  await waitFor(`(() => document.querySelector(".workspace")?.dataset.sourceMode === "hidden" ? "hidden" : "")()`, "narrow source hidden", 8000);
  await evaluate(`(() => {
    document.querySelector(".oi-src-strip-x")?.click();
    const block = window.__selLong((el) => true);
    window.__selPlaceBlock(block);
    return window.__selArm(block, "mid");
  })()`);
  await frames();
  await waitFor(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    return bar && !bar.hidden ? "bar" : "";
  })()`, "toolbar before the sheet", 8000);
  const jump = await buttonPoint("jump-source");
  assert.ok(jump && jump.disabled === false, JSON.stringify(jump));
  await clickAt(jump.x, jump.y);
  await waitFor(`(() => {
    const pop = document.getElementById("sourcePop");
    return pop && !pop.hidden && pop.dataset.place === "bottom" ? "sheet" : "";
  })()`, "bottom sheet", 8000);
  const covered = await evaluate(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    const pop = document.getElementById("sourcePop");
    const barBox = bar ? bar.getBoundingClientRect() : { height: 0, top: 0, bottom: 0 };
    const popBox = pop.getBoundingClientRect();
    const hidden = !bar || bar.hidden || barBox.height < 1;
    const overlaps = !hidden && barBox.bottom > popBox.top + 1 && barBox.top < popBox.bottom - 1;
    return { hidden, overlaps, place: pop.dataset.place, popH: popBox.height, popTop: popBox.top };
  })()`);
  assert.equal(covered.place, "bottom", JSON.stringify(covered));
  assert.equal(covered.hidden, true, JSON.stringify(covered));
  assert.equal(covered.overlaps, false, JSON.stringify(covered));
  assert.ok(covered.popH > 120, JSON.stringify(covered));
  await evaluate(`(() => {
    const block = window.__selLong((el) => true);
    return window.__selArm(block, "mid");
  })()`);
  await frames();
  const stayed = await evaluate(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    return !bar || bar.hidden ? "hidden" : "open";
  })()`);
  assert.equal(stayed, "hidden");

  await metrics(1440, 900);
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?src=${encodeURIComponent(`${origin}/tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf`)}` });
  await waitFor(`(() => {
    const pager = document.getElementById("sourcePageLabel")?.textContent || "";
    return /\\/\\s*27/.test(pager) ? pager : "";
  })()`, "DPO open");
  await evaluate(HOOKS);
  await waitFor(`(() => {
    const block = document.querySelector("#readerFlow .rf-block .rf-zh");
    return block && block.textContent.trim().length > 20 ? "flow" : "";
  })()`, "DPO flow", 90000);
  const clickSelector = async (selector) => {
    const point = await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el || el.disabled) return null;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1) return null;
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    })()`);
    assert.ok(point, `${selector} is not clickable`);
    await clickAt(point.x, point.y);
  };
  for (const page of [2, 3]) {
    const ready = await evaluate(`(() => {
      const block = document.querySelector("#readerFlow .rf-block[data-src-page='${page}'] .rf-zh");
      return block && block.textContent.trim().length > 20 ? "yes" : "";
    })()`);
    if (ready) continue;
    await clickSelector("#sourceNext");
    await waitFor(`(() => {
      const block = document.querySelector("#readerFlow .rf-block[data-src-page='${page}'] .rf-zh");
      const pages = [...document.querySelectorAll("#readerFlow .rf-block[data-src-page]")].map((el) => el.dataset.srcPage);
      if (block && block.textContent.trim().length > 20) return "p${page}";
      window.__selPageWait = { want: ${page}, pager: document.getElementById("sourcePageLabel")?.textContent || "", pages: [...new Set(pages)].slice(0, 8) };
      return "";
    })()`, `DPO page ${page}`, 40000);
  }

  const disabled = await evaluate(`(() => {
    const natural = [...document.querySelectorAll("#readerFlow .rf-block")].find((el) => {
      return el.dataset.bid && !el.dataset.pairId && window.__selText(el).length > 2;
    });
    const heading = natural || [...document.querySelectorAll("#readerFlow h1.rf-block, #readerFlow h2.rf-block")].find((el) => el.dataset.bid && window.__selText(el).length > 2);
    if (!heading) return null;
    const made = !natural;
    if (made) delete heading.dataset.pairId;
    heading.scrollIntoView({ block: "center" });
    const armed = window.__selArm(heading, "mid");
    return { made, text: (armed && armed.text) || window.__selText(heading).slice(0, 40), tag: heading.tagName };
  })()`);
  assert.ok(disabled, "no heading to show the disabled toolbar");
  await frames();
  await waitFor(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    const seeBtn = bar?.querySelector("[data-sel-action='see-source']");
    return bar && !bar.hidden && seeBtn?.disabled ? "disabled" : "";
  })()`, "disabled toolbar", 8000);
  const disabledBox = await evaluate(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    const seeBtn = bar.querySelector("[data-sel-action='see-source']");
    const jumpBtn = bar.querySelector("[data-sel-action='jump-source']");
    const moreBtn = bar.querySelector("[data-sel-action='more']");
    const barBox = bar.getBoundingClientRect();
    seeBtn.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    const bg = getComputedStyle(seeBtn).backgroundColor;
    return {
      seeDisabled: seeBtn.disabled,
      jumpDisabled: jumpBtn.disabled,
      moreDisabled: moreBtn.disabled,
      title: seeBtn.title,
      bg,
      bar: { x: barBox.left, y: barBox.top, w: barBox.width, h: barBox.height }
    };
  })()`);
  assert.equal(disabledBox.seeDisabled, true, JSON.stringify(disabledBox));
  assert.equal(disabledBox.jumpDisabled, true, JSON.stringify(disabledBox));
  assert.equal(disabledBox.moreDisabled, false, JSON.stringify(disabledBox));
  assert.equal(disabledBox.title, "这段没有配对", JSON.stringify(disabledBox));
  assert.ok(disabledBox.bg === "rgba(0, 0, 0, 0)" || disabledBox.bg === "transparent", JSON.stringify(disabledBox));
  await annotate([
    {
      x: disabledBox.bar.x,
      y: disabledBox.bar.y,
      w: disabledBox.bar.w,
      h: disabledBox.bar.h,
      label: `禁用 · title ${disabledBox.title}`,
      color: "#E23B2F"
    }
  ]);
  await saveShot("SEL-08-dpo-disabled.png");
  await clearNotes();
  if (disabled.made) {
    t.diagnostic("SEL-08 used a real DPO heading after clearing data-pair-id; these fixtures pair every text-layer block");
  }

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: 1440,
    screenHeight: 900
  });
  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "pointer", value: "coarse" }, { name: "any-pointer", value: "coarse" }]
  });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await sleep(80);
  const coarseMedia = await evaluate(`window.matchMedia("(pointer: coarse)").matches ? "coarse" : "fine"`);
  assert.equal(coarseMedia, "coarse", "pointer: coarse did not apply");
  await evaluate(`(() => {
    const block = document.querySelector("#readerFlow .rf-block[data-src-page='3'][data-pair-id]");
    if (!block) return null;
    block.scrollIntoView({ block: "center" });
    return window.__selArm(block, "mid");
  })()`);
  await frames(3);
  await waitFor(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    return bar && !bar.hidden ? "bar" : "";
  })()`, "coarse toolbar", 8000);
  const coarse = await evaluate(`(() => {
    const bar = document.querySelector(".oi-sel-toolbar");
    const btn = bar.querySelector(".oi-sel-btn");
    const barBox = bar.getBoundingClientRect();
    const btnBox = btn.getBoundingClientRect();
    return {
      barH: barBox.height,
      btnH: btnBox.height,
      bar: { x: barBox.left, y: barBox.top, w: barBox.width, h: barBox.height },
      btn: { x: btnBox.left, y: btnBox.top, w: btnBox.width, h: btnBox.height }
    };
  })()`);
  assert.equal(coarse.barH, 48, JSON.stringify(coarse));
  assert.equal(coarse.btnH, 44, JSON.stringify(coarse));
  await annotate([
    { x: coarse.bar.x, y: coarse.bar.y, w: coarse.bar.w, h: coarse.bar.h, label: `条 ${coarse.barH}`, color: "#2F55D4" },
    { x: coarse.btn.x, y: coarse.btn.y, w: coarse.btn.w, h: coarse.btn.h, label: `钮 ${coarse.btnH}`, color: "#A86B12" }
  ]);
  await saveShot("SEL-05-dpo-coarse-toolbar.png");
  await clearNotes();
  const coarseMore = await buttonPoint("more");
  assert.ok(coarseMore, "coarse more button missing");
  await clickAt(coarseMore.x, coarseMore.y);
  const coarseMenu = await evaluate(`(() => {
    const item = document.querySelector(".oi-sel-menu [role='menuitem']");
    const box = item.getBoundingClientRect();
    return { h: box.height, x: box.left, y: box.top, w: box.width };
  })()`);
  assert.equal(coarseMenu.h, 44, JSON.stringify(coarseMenu));
  await annotate([
    { x: coarseMenu.x, y: coarseMenu.y, w: coarseMenu.w, h: coarseMenu.h, label: `菜单项 ${coarseMenu.h}`, color: "#2F55D4" }
  ]);
  await saveShot("SEL-05-dpo-coarse-menu.png");
  await clearNotes();
});
