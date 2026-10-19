// F5 right-pane tier 0. Headless Chrome, local fixtures only.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";
import { loadSource, SRC_V7, SRC_V7_SHA } from "./helpers/arxiv-paper.mjs";

installOwnedTmpGuard(["oi-f5-chrome-", "com.google.Chrome.", ".com.google.Chrome."]);

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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
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

  send(method, params = {}, sessionId) {
    const id = this.next++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const body = Buffer.from(`${JSON.stringify(payload)}\0`, "utf8");
    return new Promise((done, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 20000);
      this.pending.set(id, { done, reject, timer });
      this.writeStream.write(body);
    });
  }
}

test("F5 Attention source formulas reach the right pane", { timeout: 600000 }, async (t) => {
  const packed = await loadSource(SRC_V7, SRC_V7_SHA, "把 1706.03762v7.tar.gz 放到 tests/fixtures/arxiv-src/。");
  const files = (packed.files || []).map((file) => ({ path: file.path, text: file.text }));
  const hits = [];
  const alignments = new Map();
  let downloads = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    hits.push(url.pathname);
    if (url.pathname === "/__oi/align" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = {}; }
        if (body.key) alignments.set(body.key, body.alignment || null);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    if (url.pathname === "/__oi/align") {
      const alignment = alignments.get(url.searchParams.get("key") || "") || null;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ alignment }));
      return;
    }
    if (url.pathname === "/__oi/downloads" && req.method === "POST") {
      downloads += 1;
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ downloads }));
      return;
    }
    if (url.pathname === "/__oi/downloads") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ downloads }));
      return;
    }
    if (url.pathname === "/__oi/arxiv-src-v7.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify({ files }));
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
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-f5-chrome-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  const handle = { child: null, cdp: null };
  t.after(async () => {
    try { handle.cdp?.dispose(); } finally {
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const src = `${origin}/tests/fixtures/Attention_Is_All_You_Need.pdf`;
  handle.child = spawn("google-chrome", [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--remote-debugging-pipe",
    "--force-device-scale-factor=1",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1440,900",
    "--no-first-run",
    "--no-default-browser-check"
  ], {
    detached: true,
    env: { ...process.env, TMPDIR: scratchDir, TMP: scratchDir, TEMP: scratchDir },
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"]
  });
  handle.child.stderr.on("data", () => {});
  handle.child.stdio[3].on("error", () => {});
  handle.child.stdio[4].on("error", () => {});
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => cdp.send(method, params, sessionId);
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  });
  await send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const orig = window.fetch.bind(window);
      window.__oiArxivMode = localStorage.getItem("oi.f5.arxivMode") || "offline";
      window.__oiAlerted = false;
      window.__oiArxivFetches = 0;
      window.alert = () => { window.__oiAlerted = true; };
      window.fetch = (input, init) => {
        const url = String(input && input.url || input || "");
        if (/arxiv\\.org/i.test(url)) {
          window.__oiArxivFetches += 1;
          return Promise.reject(new Error("blocked-arxiv"));
        }
        return orig(input, init);
      };
      const alignKey = (message) => String(message.id || "") + "@" + String(message.version || "") + ":" + String(message.pdfSha256 || "");
      const listeners = [];
      window.chrome = {
        runtime: {
          getURL(path) { return location.origin + "/" + String(path || "").replace(/^\\/+/, ""); },
          sendMessage(message) {
            if (!message || message.type !== "OI_ARXIV_SOURCE") return Promise.resolve({ ok: false });
            // A download is any OI_ARXIV_SOURCE message with no action.
            // The payload never contains "arxiv.org", so that string is not a counter.
            if (message.action == null || message.action === "") {
              window.__oiSourceGets = (window.__oiSourceGets || 0) + 1;
            }
            if (message.action === "save-alignment") {
              return orig(location.origin + "/__oi/align", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ key: alignKey(message), alignment: message.alignment })
              }).then(() => ({ ok: true })).catch(() => ({ ok: false }));
            }
            if (message.action === "read-alignment") {
              const reads = Number(localStorage.getItem("oi.f5.alignReads") || "0") + 1;
              localStorage.setItem("oi.f5.alignReads", String(reads));
              return orig(location.origin + "/__oi/align?key=" + encodeURIComponent(alignKey(message)))
                .then((res) => res.json())
                .then((body) => body.alignment || null)
                .catch(() => null);
            }
            if (message.action === "status" || message.action === "clear" || message.action === "asset") {
              return Promise.resolve({ ok: true });
            }
            if (message.userTriggered !== true) return Promise.resolve({ ok: false, reason: "not-triggered" });
            return orig(location.origin + "/__oi/downloads", { method: "POST" }).then(() => {
              if (window.__oiArxivMode === "offline") return { ok: false, reason: "offline" };
              return orig(location.origin + "/__oi/arxiv-src-v7.json").then((res) => res.json()).then((body) => ({
                ok: true, files: body.files || [], assets: [], skipped: [], id: message.id, version: message.version || null
              }));
            }).catch(() => ({ ok: false, reason: "offline" }));
          },
          onMessage: { addListener(fn) { listeners.push(fn); } }
        },
        storage: { local: {
          get(keys) {
            let bag = {};
            try { bag = JSON.parse(localStorage.getItem("oi.f5.chromeStorage") || "{}"); } catch { bag = {}; }
            if (!Array.isArray(keys)) return Promise.resolve(bag);
            const out = {};
            keys.forEach((key) => { if (Object.prototype.hasOwnProperty.call(bag, key)) out[key] = bag[key]; });
            return Promise.resolve(out);
          },
          set(patch) {
            let bag = {};
            try { bag = JSON.parse(localStorage.getItem("oi.f5.chromeStorage") || "{}"); } catch { bag = {}; }
            Object.assign(bag, patch || {});
            localStorage.setItem("oi.f5.chromeStorage", JSON.stringify(bag));
            return Promise.resolve();
          }
        } }
      };
    })();`
  });
  await send("Page.navigate", { url: `${origin}/pdf/viewer.html?oiAuto=1&src=${encodeURIComponent(src)}` });

  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || JSON.stringify(result.exceptionDetails);
      throw new Error(detail);
    }
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 60000) => {
    const started = Date.now();
    let last = null;
    let logged = 0;
    while (Date.now() - started < timeoutMs) {
      try {
        last = await evaluate(expression);
      } catch (error) {
        last = null;
        waitFor.lastError = String(error?.message || error);
      }
      if (last) return last;
      if (Date.now() - logged > 4000) {
        logged = Date.now();
        const snap = await evaluate(`window.__oiF5Wait || null`).catch((error) => String(error));
        const text = JSON.stringify(snap);
        if (text !== waitFor.lastSnap) {
          waitFor.lastSnap = text;
          console.log(`${label} waiting ${text}`);
        }
      }
      await sleep(250);
    }
    const status = await evaluate(`document.getElementById("status")?.textContent || ""`).catch(() => "");
    const snap = await evaluate(`window.__oiF5Wait || null`).catch(() => null);
    throw new Error(`${label} timed out. status=${status} last=${JSON.stringify(last)} snap=${JSON.stringify(snap)}`);
  };

  const offer = await waitFor(`(() => {
    const chip = document.getElementById("arxivSourceChip");
    if (!chip || chip.hidden) return "";
    return chip.querySelector(".oi-arxiv-label")?.textContent || "";
  })()`, "arxiv offer");
  assert.equal(offer, "用 arXiv 源码");
  assert.equal(await evaluate(`window.__oiSourceGets || 0`), 0);
  assert.equal(downloads, 0);
  assert.equal(await evaluate(`window.__oiArxivFetches || 0`), 0);
  assert.equal(await evaluate(`document.getElementById("arxivSourceAuto").closest("button")`), null);
  assert.equal(await evaluate(`document.querySelectorAll(".is-katex").length`), 0);

  await evaluate(`document.getElementById("arxivSourceChip").click()`);
  const failed = await waitFor(`(() => {
    const text = document.querySelector("#arxivSourceChip .oi-arxiv-label")?.textContent || "";
    return text.startsWith("未用") ? text : "";
  })()`, "offline chip");
  assert.equal(failed, "未用 arXiv 源码：离线");
  assert.equal(await evaluate(`window.__oiAlerted`), false);
  assert.equal(await evaluate(`document.querySelectorAll(".is-katex").length`), 0);
  const beforeHeights = await evaluate(`(() => {
    const pane = document.getElementById("translateScroll") || document.querySelector(".pane-translate");
    const view = pane ? pane.getBoundingClientRect() : { top: 0, bottom: 0 };
    return [...document.querySelectorAll(".oi-pdf-math-row, .oi-pdf-inline-math")].map((el) => {
      const rect = el.getBoundingClientRect();
      const host = el.closest("[data-block-id]") || el;
      const inView = rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
      return { id: host.dataset.blockId || "", height: rect.height, inView };
    }).filter((row) => row.id && row.inView && row.height > 0);
  })()`);

  await evaluate(`window.__oiArxivMode = "ok"; document.getElementById("arxivSourceChip").click();`);
  const counts = await waitFor(`(() => {
    const shown = (node) => {
      if (!node || node.closest("[hidden]")) return false;
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        el = el.parentElement;
      }
      return true;
    };
    const display = [...document.querySelectorAll(".oi-pdf-math-row.is-katex")].filter(shown).length;
    const inline = [...document.querySelectorAll(".oi-pdf-inline-math.is-katex")].filter(shown).length;
    const label = document.querySelector("#arxivSourceChip .oi-arxiv-label")?.textContent || "";
    const chip = document.getElementById("arxivSourceChip");
    const rows = [...document.querySelectorAll(".oi-pdf-math-row")].filter(shown).map((row) => ({
      katex: row.classList.contains("is-katex"),
      reason: row.querySelector("[data-oi-reason]")?.getAttribute("data-oi-reason") || "",
      page: row.closest(".rf-page")?.dataset.page || "",
      eq: row.querySelector(".oi-pdf-eq-num")?.textContent || ""
    }));
    window.__oiF5Wait = { display, inline, label, rows };
    if (display < 5 || inline < 71 || !label.includes("独立")) return null;
    return { display, inline, label, title: chip.title };
  })()`, "katex on screen", 90000);
  console.log(`Attention on screen display ${counts.display} inline ${counts.inline} chip ${counts.label}`);
  const afterHeights = await evaluate(`(() => {
    const pane = document.getElementById("translateScroll") || document.querySelector(".pane-translate");
    const view = pane ? pane.getBoundingClientRect() : { top: 0, bottom: 0 };
    return [...document.querySelectorAll(".oi-pdf-math-row, .oi-pdf-inline-math")].map((el) => {
      const rect = el.getBoundingClientRect();
      const host = el.closest("[data-block-id]") || el;
      const inView = rect.bottom > view.top + 1 && rect.top < view.bottom - 1;
      return { id: host.dataset.blockId || "", height: rect.height, inView, lock: el.dataset.oiHeightLock || host.dataset.oiHeightLock || "" };
    });
  })()`);
  for (const prev of beforeHeights) {
    const now = afterHeights.find((row) => row.id === prev.id && row.inView);
    if (!now) continue;
    assert.ok(Math.abs(now.height - prev.height) <= 2, `${prev.id} height ${prev.height} -> ${now.height}`);
  }
  assert.equal(counts.display, 5);
  assert.ok(counts.inline >= 71, `inline ${counts.inline}`);
  assert.match(counts.label, new RegExp(`独立 ${counts.display}/5`));
  assert.match(counts.label, new RegExp(`行内 ${counts.inline}/87`));
  assert.equal(counts.title, counts.label);
  const tiered = await evaluate(`(() => {
    const nodes = [...document.querySelectorAll(".is-katex")];
    return nodes.every((node) => node.dataset.oiTier === "arxiv" || node.closest("[data-oi-tier='arxiv']"));
  })()`);
  assert.equal(tiered, true);
  assert.equal(await evaluate(`window.__oiArxivFetches || 0`), 0);
  const tabOrder = await evaluate(`(() => {
    const formulas = [...document.querySelectorAll(".oi-pdf-math-row.is-katex .oi-pdf-math-scroll, .oi-pdf-inline-math.is-katex")];
    const tabbable = [...document.querySelectorAll("a[href], button, input, select, textarea, [tabindex]")].filter((el) => {
      if (el.tabIndex < 0) return false;
      if (el.closest("[hidden]")) return false;
      const style = getComputedStyle(el);
      return style.display !== "none" && style.visibility !== "hidden";
    });
    const indexes = formulas.map((el) => tabbable.indexOf(el));
    return {
      formulas: formulas.length,
      missing: indexes.filter((index) => index < 0).length,
      ordered: indexes.every((index, i) => index >= 0 && (i === 0 || index > indexes[i - 1]))
    };
  })()`);
  assert.equal(tabOrder.missing, 0, JSON.stringify(tabOrder));
  assert.equal(tabOrder.ordered, true, JSON.stringify(tabOrder));
  assert.ok(tabOrder.formulas >= counts.inline + counts.display, JSON.stringify(tabOrder));
  await evaluate(`document.querySelector(".oi-pdf-math-row.is-katex .oi-pdf-math-scroll, .oi-pdf-inline-math.is-katex").focus()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  const tabbed = await evaluate(`(() => {
    const formulas = [...document.querySelectorAll(".oi-pdf-math-row.is-katex .oi-pdf-math-scroll, .oi-pdf-inline-math.is-katex")];
    const active = document.activeElement;
    return { landed: formulas[1] === active, index: formulas.indexOf(active), count: formulas.length };
  })()`);
  assert.equal(tabbed.landed, true, JSON.stringify(tabbed));

  const type = await evaluate(`(() => {
    const row = document.querySelector(".oi-pdf-math-row.is-katex");
    const inline = document.querySelector(".oi-pdf-inline-math.is-katex");
    const body = getComputedStyle(document.querySelector(".reader-flow")).fontSize;
    const displaySize = getComputedStyle(row.querySelector(".katex")).fontSize;
    const inlineSize = getComputedStyle(inline.querySelector(".katex")).fontSize;
    const bodyPx = parseFloat(body);
    const cols = getComputedStyle(row).gridTemplateColumns;
    const num = row.querySelector(".oi-pdf-eq-num");
    const reserve = row.querySelector(".oi-formula-reserve");
    return {
      bodyPx,
      displayPx: parseFloat(displaySize),
      inlinePx: parseFloat(inlineSize),
      cols,
      reserve: reserve ? reserve.getBoundingClientRect().width : -1,
      numWidth: num ? num.getBoundingClientRect().width : -1,
      numText: num ? num.textContent : "",
      badge: /源码|arXiv/.test(row.innerText || "")
    };
  })()`);
  assert.ok(Math.abs(type.inlinePx - type.bodyPx) <= 0.5, JSON.stringify(type));
  assert.ok(Math.abs(type.displayPx - type.bodyPx * 1.1) <= 0.5, JSON.stringify(type));
  assert.equal(type.badge, false);
  assert.ok(type.reserve >= 47 && type.reserve <= 49, JSON.stringify(type));
  assert.ok(type.numWidth >= 47 && type.numWidth <= 49, JSON.stringify(type));

  await evaluate(`(() => {
    document.getElementById("aaButton").click();
    const slider = document.getElementById("aaFontScale");
    slider.focus();
    slider.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  })()`);
  await sleep(200);
  const scaled = await evaluate(`(() => {
    const body = parseFloat(getComputedStyle(document.querySelector(".reader-flow")).fontSize);
    const displayPx = parseFloat(getComputedStyle(document.querySelector(".oi-pdf-math-row.is-katex .katex")).fontSize);
    const inlinePx = parseFloat(getComputedStyle(document.querySelector(".oi-pdf-inline-math.is-katex .katex")).fontSize);
    return { body, displayPx, inlinePx };
  })()`);
  assert.ok(Math.abs(scaled.inlinePx - scaled.body) <= 0.5, JSON.stringify(scaled));
  assert.ok(Math.abs(scaled.displayPx - scaled.body * 1.1) <= 0.5, JSON.stringify(scaled));

  const switches = await evaluate(`(() => {
    const host = document.getElementById("aaFormulaSwitches");
    const text = host ? host.textContent : "";
    const boxes = host ? host.querySelectorAll("input").length : 0;
    return { text, boxes };
  })()`);
  assert.equal(switches.text.includes("需先配置多模态模型"), true);
  assert.equal(switches.text.includes("需先配置 OCR"), true);
  assert.equal(switches.text.includes("认不好时显示占位"), true);
  assert.equal(switches.text.includes("用 arXiv 源码"), false);
  const beforeToggle = counts.inline + counts.display;
  await evaluate(`(() => {
    const box = document.querySelector("#aaFormulaSwitches input");
    if (box) box.click();
  })()`);
  const afterToggle = await evaluate(`(() => {
    const shown = (node) => {
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        el = el.parentElement;
      }
      return true;
    };
    return [...document.querySelectorAll(".oi-pdf-math-row.is-katex, .oi-pdf-inline-math.is-katex")].filter(shown).length;
  })()`);
  assert.equal(afterToggle, beforeToggle);

  const placed = await evaluate(`(() => {
    const makeProbe = () => {
      const probe = document.createElement("span");
      probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;padding:0;margin:0;border:0;line-height:0;";
      return probe;
    };
    const shown = (node) => {
      if (!node?.parentElement || !node.querySelector(".katex")) return false;
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        el = el.parentElement;
      }
      return true;
    };
    const inlines = [...document.querySelectorAll(".oi-pdf-inline-math.is-katex")].filter(shown);
    const deltas = [];
    for (const inline of inlines) {
      const parent = inline.parentElement;
      const wrap = document.createElement("span");
      wrap.style.whiteSpace = "nowrap";
      const lineProbe = makeProbe();
      const mathProbe = makeProbe();
      parent.insertBefore(wrap, inline);
      wrap.append(lineProbe, inline);
      inline.insertBefore(mathProbe, inline.firstChild);
      deltas.push(Math.abs(lineProbe.getBoundingClientRect().bottom - mathProbe.getBoundingClientRect().bottom));
      mathProbe.remove();
      parent.insertBefore(inline, wrap);
      wrap.remove();
    }
    const displaced = deltas.filter((delta) => delta > 1).length;
    const flow = document.querySelector(".reader-flow");
    const flowBox = flow.getBoundingClientRect();
    const padL = parseFloat(getComputedStyle(flow).paddingLeft) || 0;
    const padR = parseFloat(getComputedStyle(flow).paddingRight) || 0;
    const center = flowBox.left + padL + (flowBox.width - padL - padR) / 2;
    const rows = [...document.querySelectorAll(".oi-pdf-math-row.is-katex")].map((row) => {
      const scroll = row.querySelector(".oi-pdf-math-scroll");
      const katex = row.querySelector(".katex");
      const box = katex.getBoundingClientRect();
      const num = row.querySelector(".oi-pdf-eq-num");
      return {
        delta: (box.left + box.width / 2) - center,
        overflow: scroll.scrollWidth > scroll.clientWidth + 1,
        num: num ? num.textContent : "",
        badge: /源码|arXiv/.test(row.innerText || "")
      };
    });
    const quiet = rows.filter((row) => !row.overflow);
    return {
      baseline: deltas.length ? Math.max(...deltas) : null,
      displaced,
      measured: deltas.length,
      quiet: quiet.map((row) => ({ delta: row.delta, num: row.num })),
      badge: rows.some((row) => row.badge),
      numbered: rows.some((row) => row.num.trim())
    };
  })()`);
  assert.ok(placed.measured >= 1, JSON.stringify(placed));
  assert.equal(placed.displaced, 0, JSON.stringify(placed));
  console.log(`displaced inline formulas ${placed.displaced} of ${placed.measured}`);
  assert.equal(placed.badge, false);
  assert.equal(placed.numbered, true);
  assert.ok(placed.quiet.length >= 1, JSON.stringify(placed.quiet));
  for (const row of placed.quiet) {
    assert.ok(Math.abs(row.delta) <= 2, JSON.stringify(row));
  }

  await evaluate(`(() => {
    window.__oiCopied = [];
    navigator.clipboard.writeText = (text) => {
      window.__oiCopied.push(String(text));
      return Promise.resolve();
    };
    const orig = window.__oiJumpFormula;
    window.__oiJumps = 0;
    window.__oiJumpFormula = (node) => {
      window.__oiJumps += 1;
      if (typeof orig === "function") return orig(node);
    };
  })()`);
  const dragged = await evaluate(`(() => {
    const before = window.__oiJumps;
    const inline = document.querySelector(".oi-pdf-inline-math.is-katex");
    inline.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 12, clientY: 12, button: 0 }));
    inline.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 24, clientY: 12, button: 0 }));
    return window.__oiJumps - before;
  })()`);
  assert.equal(dragged, 0);
  await evaluate(`(() => {
    const scroll = document.querySelector(".oi-pdf-math-row.is-katex .oi-pdf-math-scroll");
    scroll.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: 40, clientY: 40, button: 0 }));
    scroll.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 41, clientY: 40, button: 0 }));
    scroll.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    scroll.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
  })()`);
  await sleep(200);
  const landing = await evaluate(`(() => {
    const pane = document.getElementById("pages");
    const box = document.querySelector("#pages .pair-box.is-jump");
    const toast = document.getElementById("tbToast")?.textContent || "";
    const page = document.querySelector(".oi-pdf-math-row.is-katex .oi-pdf-math-scroll")?.dataset.page || "";
    const pageEl = page ? document.querySelector("#pages .pdf-page[data-page='" + page + "']") : null;
    const paneBox = pane ? pane.getBoundingClientRect() : null;
    const pageBox = pageEl ? pageEl.getBoundingClientRect() : null;
    const pageVisible = Boolean(paneBox && pageBox && pageBox.bottom > paneBox.top + 1 && pageBox.top < paneBox.bottom - 1);
    if (!pane || !box) return { jumps: window.__oiJumps, toast, ratio: null, pageVisible };
    const rect = box.getBoundingClientRect();
    return { jumps: window.__oiJumps, toast, pageVisible, ratio: (rect.top - paneBox.top) / paneBox.height };
  })()`);
  assert.equal(landing.jumps, 3);
  if (landing.ratio != null) assert.ok(Math.abs(landing.ratio - 0.3) <= 0.05, JSON.stringify(landing));
  else assert.ok(/已到第 \d+ 页/.test(landing.toast) || landing.pageVisible, JSON.stringify(landing));

  const copied = await evaluate(`(async () => {
    const before = window.__oiJumps;
    const row = document.querySelector(".oi-pdf-math-row.is-katex");
    const scroll = row.querySelector(".oi-pdf-math-scroll");
    scroll.focus({ focusVisible: true });
    await new Promise((done) => setTimeout(done, 360));
    const button = row.querySelector(".oi-latex-copy");
    const shown = getComputedStyle(button).opacity;
    button.click();
    await new Promise((done) => setTimeout(done, 30));
    const outline = getComputedStyle(scroll).outlineWidth;
    return {
      shown,
      outline,
      label: button.textContent,
      latex: scroll.dataset.latex,
      copied: window.__oiCopied[window.__oiCopied.length - 1] || "",
      jumps: window.__oiJumps - before,
      aria: scroll.getAttribute("aria-label") || ""
    };
  })()`);
  assert.equal(copied.shown, "1");
  assert.equal(copied.outline, "2px");
  assert.equal(copied.label, "已复制 LaTeX");
  assert.equal(copied.copied, copied.latex);
  assert.equal(copied.copied.includes("$$"), false);
  assert.equal(copied.jumps, 0);
  assert.equal(copied.aria.includes("公式"), true);

  const menu = await evaluate(`(() => {
    const inline = document.querySelector(".oi-pdf-inline-math.is-katex");
    inline.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 30 }));
    const more = document.querySelector(".oi-sel-toolbar [data-sel-action='more']");
    if (more) more.click();
    const item = [...document.querySelectorAll(".oi-sel-menu [role='menuitem']")].find((el) => (el.textContent || "").includes("复制 LaTeX"));
    return { open: Boolean(item && !item.closest("[hidden]")), text: item ? item.textContent : "" };
  })()`);
  assert.equal(menu.open, true);
  const keyed = await evaluate(`(async () => {
    const inline = document.querySelector(".oi-pdf-inline-math.is-katex");
    inline.focus();
    inline.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
    await new Promise((done) => setTimeout(done, 30));
    return window.__oiCopied[window.__oiCopied.length - 1] || "";
  })()`);
  const inlineLatex = await evaluate(`document.querySelector(".oi-pdf-inline-math.is-katex").dataset.latex`);
  assert.equal(keyed, inlineLatex);
  const cropCopy = await evaluate(`(() => {
    document.querySelector(".oi-sel-toolbar")?.setAttribute("hidden", "");
    const crop = document.querySelector(".oi-pdf-math-crop, .oi-formula-placeholder-row");
    if (crop) crop.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 8, clientY: 8 }));
    const item = [...document.querySelectorAll(".oi-sel-menu [role='menuitem']")].find((el) => (el.textContent || "").includes("复制 LaTeX") && !el.closest("[hidden]"));
    const onCrop = crop ? crop.querySelectorAll(".oi-latex-copy").length : 0;
    return { item: Boolean(item), onCrop, crop: Boolean(crop) };
  })()`);
  assert.equal(cropCopy.item, false);
  assert.equal(cropCopy.onCrop, 0);

  const plainLatex = await evaluate(`(() => {
    window.__oiPlain = "";
    document.addEventListener("copy", (event) => {
      window.__oiPlain = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
    });
    const inline = [...document.querySelectorAll(".oi-pdf-inline-math.is-katex")].find((node) => {
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        el = el.parentElement;
      }
      return true;
    });
    const range = document.createRange();
    range.selectNodeContents(inline.parentElement);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return inline.dataset.latex;
  })()`);
  await send("Input.dispatchKeyEvent", {
    type: "keyDown",
    modifiers: 2,
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67
  });
  await send("Input.dispatchKeyEvent", {
    type: "keyUp",
    modifiers: 2,
    key: "c",
    code: "KeyC",
    windowsVirtualKeyCode: 67
  });
  await sleep(100);
  const plain = await evaluate(`window.__oiPlain || ""`);
  assert.match(plain, new RegExp(`\\$${plainLatex.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\$`));

  const themes = await evaluate(`(() => {
    const lum = (color) => {
      const parts = color.match(/[\\d.]+/g).map(Number);
      const alpha = parts.length > 3 ? parts[3] : 1;
      const rgb = parts.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      });
      return { L: 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2], alpha };
    };
    const paperOf = (node) => {
      let here = node;
      while (here) {
        const color = getComputedStyle(here).backgroundColor;
        const parsed = lum(color);
        if (parsed.alpha > 0.9) return color;
        here = here.parentElement;
      }
      return getComputedStyle(document.body).backgroundColor;
    };
    const contrast = (a, b) => {
      const left = lum(a).L;
      const right = lum(b).L;
      return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    };
    const katex = document.querySelector(".oi-pdf-math-row.is-katex .katex");
    const names = ["warm", "white", "sepia", "green", "dark"];
    return names.map((theme) => {
      document.querySelectorAll("[data-reader-theme]").forEach((el) => { el.dataset.readerTheme = theme; });
      const ink = getComputedStyle(katex).color;
      const paper = paperOf(katex);
      const bg = getComputedStyle(katex).backgroundColor;
      return { theme, ratio: contrast(ink, paper), bg };
    });
  })()`);
  for (const theme of themes) {
    assert.ok(theme.ratio >= 4.5, JSON.stringify(theme));
    assert.match(theme.bg, /rgba?\(0,\s*0,\s*0,\s*0\)|transparent/);
  }
  const darkButton = await evaluate(`(() => {
    document.querySelectorAll("[data-reader-theme]").forEach((el) => { el.dataset.readerTheme = "dark"; });
    const button = document.querySelector(".oi-latex-copy:not(.is-copied)");
    const style = getComputedStyle(button);
    return {
      bg: style.backgroundColor,
      border: style.borderTopColor,
      width: style.borderTopWidth,
      shadow: style.boxShadow,
      height: button.getBoundingClientRect().height
    };
  })()`);
  assert.equal(darkButton.height, 24);
  assert.equal(darkButton.bg, "rgb(35, 36, 39)");
  assert.equal(darkButton.border, "rgb(58, 60, 64)");
  assert.equal(darkButton.width, "1px");
  assert.notEqual(darkButton.shadow, "none");

  await send("Emulation.setDeviceMetricsOverride", {
    width: 860, height: 900, deviceScaleFactor: 1, mobile: false
  });
  await evaluate(`(() => {
    const flow = document.getElementById("readerFlow");
    const pane = flow.closest(".pane-translate") || flow.parentElement;
    pane.style.flex = "0 0 400px";
    pane.style.width = "400px";
    pane.style.maxWidth = "400px";
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);
  await sleep(80);
  const narrow = await evaluate(`(() => {
    const flow = document.getElementById("readerFlow");
    const rows = [...document.querySelectorAll(".oi-pdf-math-row.is-katex")];
    const row = rows.find((item) => (item.querySelector(".oi-pdf-eq-num")?.textContent || "").includes("(4)"))
      || rows.sort((a, b) => (b.querySelector(".oi-pdf-math-scroll")?.scrollWidth || 0) - (a.querySelector(".oi-pdf-math-scroll")?.scrollWidth || 0))[0];
    row.scrollIntoView({ block: "center" });
    const scroll = row.querySelector(".oi-pdf-math-scroll");
    const reserve = row.querySelector(".oi-formula-reserve").getBoundingClientRect().width;
    const num = row.querySelector(".oi-pdf-eq-num");
    const before = num.getBoundingClientRect().left;
    if (scroll.scrollWidth > scroll.clientWidth + 1) scroll.scrollLeft = 40;
    const after = num.getBoundingClientRect().left;
    const fade = getComputedStyle(row, "::after").backgroundImage;
    return {
      column: flow.clientWidth,
      narrow: flow.dataset.oiNarrow,
      cols: getComputedStyle(row).gridTemplateColumns,
      reserve,
      num: num.getBoundingClientRect().width,
      shift: Math.abs(after - before),
      overflow: scroll.scrollWidth > scroll.clientWidth + 1,
      fade,
      pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  })()`);
  assert.ok(narrow.column < 560, JSON.stringify(narrow));
  assert.equal(narrow.narrow, "1");
  assert.ok(narrow.reserve <= 1, JSON.stringify(narrow));
  assert.ok(narrow.num >= 35 && narrow.num <= 37, JSON.stringify(narrow));
  assert.ok(narrow.pageOverflow <= 1, JSON.stringify(narrow));
  if (narrow.overflow) {
    assert.ok(narrow.shift <= 0.5, JSON.stringify(narrow));
    assert.match(narrow.fade, /gradient/i);
  }

  await send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  const motion = await evaluate(`getComputedStyle(document.querySelector(".oi-pdf-math-row.is-katex")).animationName`);
  assert.equal(motion, "none");
  const magenta = await evaluate(`(() => {
    return [...document.querySelectorAll(".katex, .katex *")].some((node) => {
      const color = getComputedStyle(node).color.replace(/\\s+/g, "").toLowerCase();
      return color === "rgb(225,0,145)" || color === "rgba(225,0,145,1)" || (node.textContent || "").includes("#e10091") || /ParseError|KaTeX parse/.test(node.textContent || "");
    });
  })()`);
  assert.equal(magenta, false);

  const unlocked = await evaluate(`(() => {
    const row = [...document.querySelectorAll(".oi-pdf-math-row.is-katex")].find((node) => {
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        el = el.parentElement;
      }
      return true;
    });
    row.dataset.oiHeightLock = "1";
    row.style.minHeight = "48px";
    row.style.maxHeight = "48px";
    row.querySelector(".oi-pdf-math-scroll").focus();
    return row.dataset.oiHeightLock || "";
  })()`);
  assert.equal(unlocked, "");

  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false
  });
  await evaluate(`(() => {
    const flow = document.getElementById("readerFlow");
    const pane = flow.closest(".pane-translate") || flow.parentElement;
    pane.style.flex = "";
    pane.style.width = "";
    pane.style.maxWidth = "";
    document.querySelectorAll("[data-reader-theme]").forEach((el) => { el.dataset.readerTheme = "warm"; });
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);
  await sleep(80);
  await evaluate(`document.getElementById("arxivSourceChip").click()`);
  await evaluate(`document.getElementById("arxivSourceSkip").click()`);
  const skippedChip = await waitFor(`(() => {
    const chip = document.getElementById("arxivSourceChip");
    const label = chip?.querySelector(".oi-arxiv-label")?.textContent || "";
    const restore = document.getElementById("arxivSourceRestore");
    const katex = document.querySelectorAll(".is-katex").length;
    window.__oiF5Wait = { label, hidden: restore ? restore.hidden : null, katex };
    if (!label.includes("已不用源码") || !restore || restore.hidden || katex !== 0) return null;
    const probe = document.createElement("span");
    probe.style.color = "var(--oi-reader-focus)";
    document.body.append(probe);
    const accent = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(restore);
    restore.focus();
    return {
      title: chip.title,
      label,
      restore: restore.textContent,
      active: document.activeElement === restore,
      color: style.color,
      accent,
      underline: style.textDecorationLine || style.textDecoration,
      chipH: chip.getBoundingClientRect().height,
      restoreH: restore.getBoundingClientRect().height
    };
  })()`, "skipped chip", 90000);
  assert.equal(`${skippedChip.label} ${skippedChip.restore}`.replace(/\\s+/g, " ").trim(), "公式 · 已不用源码 · 改回");
  assert.equal(skippedChip.title, "公式 · 已不用源码 · 改回");
  assert.equal(skippedChip.active, true);
  assert.equal(skippedChip.color, skippedChip.accent);
  assert.match(skippedChip.underline, /underline/);
  assert.equal(skippedChip.chipH, 30);
  assert.ok(skippedChip.restoreH >= 30, JSON.stringify(skippedChip));

  await evaluate(`document.getElementById("arxivSourceRestore").click()`);
  const restored = await waitFor(`(() => {
    const shown = (node) => {
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        el = el.parentElement;
      }
      return true;
    };
    const display = [...document.querySelectorAll(".oi-pdf-math-row.is-katex")].filter(shown).length;
    const inline = [...document.querySelectorAll(".oi-pdf-inline-math.is-katex")].filter(shown).length;
    const label = document.querySelector("#arxivSourceChip .oi-arxiv-label")?.textContent || "";
    window.__oiF5Wait = { display, inline, label };
    if (display < 5 || inline < 71 || !label.includes("独立")) return null;
    return { display, inline, label };
  })()`, "source restored", 90000);
  assert.equal(restored.display, 5);
  assert.ok(restored.inline >= 71, `restored inline ${restored.inline}`);
  console.log(`restored display ${restored.display} inline ${restored.inline}`);

  await evaluate(`localStorage.setItem("oi.f5.arxivMode", "ok")`);
  const downloadsBeforeRefresh = downloads;
  const readsBeforeRefresh = await evaluate(`Number(localStorage.getItem("oi.f5.alignReads") || "0")`);
  await evaluate(`document.documentElement.dataset.oiGen = "before-refresh"`);
  await send("Page.reload", { ignoreCache: true });
  await waitFor(`document.documentElement.dataset.oiGen === "before-refresh" ? "" : "reloaded"`, "refresh navigation");
  const afterReload = await waitFor(`(() => {
    const shown = (node) => {
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        el = el.parentElement;
      }
      return true;
    };
    const display = [...document.querySelectorAll(".oi-pdf-math-row.is-katex")].filter(shown).length;
    const inline = [...document.querySelectorAll(".oi-pdf-inline-math.is-katex")].filter(shown).length;
    const label = document.querySelector("#arxivSourceChip .oi-arxiv-label")?.textContent || "";
    let bag = {};
    try { bag = JSON.parse(localStorage.getItem("oi.f5.chromeStorage") || "{}"); } catch { bag = {}; }
    window.__oiF5Wait = { display, inline, label, on: bag.arxivSourceOn || [], skip: bag.arxivSourceSkip || [] };
    if (display < 5 || inline < 71 || !label.includes("独立")) return null;
    return { display, inline, label, on: bag.arxivSourceOn || [], skip: bag.arxivSourceSkip || [] };
  })()`, "source after refresh", 120000);
  assert.equal(afterReload.display, 5);
  assert.ok(afterReload.inline >= 71, `refresh inline ${afterReload.inline}`);
  assert.equal(afterReload.skip.includes("1706.03762"), false);
  assert.equal(afterReload.on.includes("1706.03762"), true);
  const readsAfterRefresh = await evaluate(`Number(localStorage.getItem("oi.f5.alignReads") || "0")`);
  assert.equal(downloads, downloadsBeforeRefresh);
  assert.ok(readsAfterRefresh > readsBeforeRefresh, `align reads ${readsBeforeRefresh} -> ${readsAfterRefresh}`);
  console.log(`after refresh display ${afterReload.display} inline ${afterReload.inline} downloads ${downloads}`);

  await evaluate(`(() => {
    localStorage.setItem("oi.f5.arxivMode", "ok");
    const bag = JSON.parse(localStorage.getItem("oi.f5.chromeStorage") || "{}");
    bag.arxivSourceAuto = true;
    bag.arxivSourceOn = [];
    bag.arxivSourceSkip = [];
    localStorage.setItem("oi.f5.chromeStorage", JSON.stringify(bag));
    return true;
  })()`);
  const downloadsBeforeAuto = downloads;
  const readsBeforeAuto = await evaluate(`Number(localStorage.getItem("oi.f5.alignReads") || "0")`);
  await evaluate(`document.documentElement.dataset.oiGen = "before-auto"`);
  await send("Page.reload", { ignoreCache: true });
  await waitFor(`document.documentElement.dataset.oiGen === "before-auto" ? "" : "reloaded"`, "auto navigation");
  const auto = await waitFor(`(() => {
    const shown = (node) => {
      let el = node;
      while (el) {
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden") return false;
        el = el.parentElement;
      }
      return true;
    };
    const display = [...document.querySelectorAll(".oi-pdf-math-row.is-katex")].filter(shown).length;
    const inline = [...document.querySelectorAll(".oi-pdf-inline-math.is-katex")].filter(shown).length;
    const label = document.querySelector("#arxivSourceChip .oi-arxiv-label")?.textContent || "";
    const autoBox = document.getElementById("arxivSourceAuto");
    window.__oiF5Wait = { display, inline, label, auto: autoBox ? autoBox.checked : null };
    if (display < 5 || inline < 71 || !label.includes("独立") || !autoBox || autoBox.checked !== true) return null;
    return { display, inline, label, auto: true };
  })()`, "source with auto", 120000);
  assert.equal(auto.display, 5);
  assert.ok(auto.inline >= 71, `auto inline ${auto.inline}`);
  const readsAfterAuto = await evaluate(`Number(localStorage.getItem("oi.f5.alignReads") || "0")`);
  assert.equal(downloads, downloadsBeforeAuto);
  assert.ok(readsAfterAuto > readsBeforeAuto, `auto reads ${readsBeforeAuto} -> ${readsAfterAuto}`);
  console.log(`auto display ${auto.display} inline ${auto.inline}`);
});
