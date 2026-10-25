// Library column fill in headless Chrome. Real reader CSS, no PDF.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const TMP_PREFIXES = ["oi-library-panel-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const shots = "/opt/cursor/artifacts/library-panel";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="/pdf/reader-tokens.css">
<link rel="stylesheet" href="/pdf/viewer.css">
<link rel="stylesheet" href="/pdf/notes-panel.css">
<link rel="stylesheet" href="/pdf/ask-panel.css">
<link rel="stylesheet" href="/pdf/library-panel.css">
<style>
  html, body { margin: 0; height: 100%; background: #d8d2c6; }
  .workspace { height: 100vh; }
  .pane-pdf, .pane-translate, #sideSlot { min-height: 0; }
  .pane-translate { background: #fffdf8; }
</style>
</head>
<body class="oi-reader-app" data-reader-theme="warm">
  <div class="workspace" data-source-mode="side" data-source-side="start" data-notes-side="end">
    <section class="pane-pdf" id="pdfPane" aria-label="原文栏"><div id="pages"></div></section>
    <div class="split-handle" data-split="source" role="separator" aria-orientation="vertical"></div>
    <aside class="pane-translate" aria-label="译文栏"><div id="translateScroll"></div></aside>
    <div class="split-handle" data-split="notes" role="separator" aria-orientation="vertical" aria-label="调整文献库宽度">
      <span class="split-bubble" aria-hidden="true">文献库 360px</span>
    </div>
    <div id="sideSlot">
      <section class="oi-library is-open" aria-label="文献库">
        <header class="oi-lib-head">
          <button type="button" class="oi-lib-back" hidden>‹ 返回</button>
          <div class="oi-lib-title"><h2>文献库</h2><span class="oi-lib-count">2 篇</span></div>
          <button type="button" class="oi-lib-open-pdf">＋ 打开 PDF…</button>
        </header>
        <div class="oi-lib-body">
          <div class="oi-lib-list">
            <div class="oi-lib-row">
              <button type="button" class="oi-lib-open">
                <span class="oi-lib-titleline"><span class="oi-lib-name" title="A">A</span></span>
                <span class="oi-lib-meta" title="全文已译 · 今天 02:01 · 9.18 MB">全文已译 · 今天 02:01 · 9.18 MB</span>
              </button>
              <button type="button" class="oi-lib-trash" aria-label="删除">×</button>
            </div>
            <div class="oi-lib-row">
              <button type="button" class="oi-lib-open">
                <span class="oi-lib-titleline"><span class="oi-lib-name" title="An age-structured SEIR model for COVID-19 incidence in Dublin, Ireland with framework for evaluating health intervention cost">An age-structured SEIR model for COVID-19 incidence in Dublin, Ireland with framework for evaluating health intervention cost</span><span class="oi-chip">正在阅读</span></span>
                <span class="oi-lib-meta">已暂停 · 34% · 今天 02:01 · 9.18 MB</span>
              </button>
              <button type="button" class="oi-lib-trash" aria-label="删除">×</button>
            </div>
          </div>
        </div>
        <footer class="oi-lib-foot">
          <span class="oi-lib-foot-copy">共 2 篇 · 约 18.4 MB（估算）</span>
          <a class="oi-lib-storage" href="../options/options.html#data">存储与备份 →</a>
        </footer>
      </section>
    </div>
  </div>
  <script type="module">
    import { libraryDisplayWidth, librarySourceColumnWidth } from "/lib/library-layout.js";
    import { notesDomOrder, reorderWorkspacePanes, threePaneColumns } from "/lib/notes-pane.js";
    const workspace = document.querySelector(".workspace");
    window.__paint = (windowWidth, sessionWidth) => {
      workspace.style.width = windowWidth + "px";
      const three = windowWidth >= 1314;
      const layout = three ? "3" : "";
      const sourceWidth = librarySourceColumnWidth({ workspaceWidth: windowWidth, splitRatio: 0.5 });
      const frame = libraryDisplayWidth({
        windowWidth,
        workspaceWidth: windowWidth,
        sessionWidth,
        sourceWidth,
        splitRatio: 0.5,
        layout
      });
      workspace.dataset.libraryOpen = "true";
      workspace.dataset.libraryBand = frame.band;
      const library = workspace.querySelector(".oi-library");
      library.classList.toggle("is-sheet", frame.band === "sheet");
      library.classList.toggle("is-compact", frame.band !== "sheet" && frame.width > 0 && frame.width < 360);
      library.classList.add("is-open");
      const back = workspace.querySelector(".oi-lib-back");
      if (back) back.hidden = frame.band !== "sheet";
      const openPdf = workspace.querySelector(".oi-lib-open-pdf");
      const icon = frame.band === "sheet" || library.classList.contains("is-compact");
      if (openPdf) {
        openPdf.textContent = icon ? "＋" : "＋ 打开 PDF…";
        openPdf.classList.toggle("is-icon", icon);
        if (icon) openPdf.setAttribute("aria-label", "打开 PDF…");
        else openPdf.removeAttribute("aria-label");
      }
      const count = workspace.querySelector(".oi-lib-count");
      if (sessionWidth == null) workspace.style.removeProperty("--library-width");
      else workspace.style.setProperty("--library-width", sessionWidth + "px");
      if (frame.band === "sheet") {
        delete workspace.dataset.layout;
        workspace.style.removeProperty("--oi-reader-library-col");
        if (count) count.textContent = "全屏";
        return frame;
      }
      workspace.style.setProperty("--oi-reader-library-col", frame.width + "px");
      if (count) count.textContent = frame.width + "px";
      const bubble = workspace.querySelector(".split-bubble");
      if (bubble) bubble.textContent = "文献库 " + frame.width + "px";
      if (three) {
        workspace.dataset.layout = "3";
        workspace.dataset.sourceMode = "side";
        const columns = threePaneColumns({ workspaceWidth: windowWidth, notesWidth: frame.width, splitRatio: 0.5 });
        workspace.style.setProperty("--oi-three-source", columns.source + "px");
        workspace.style.setProperty("--oi-three-translate", columns.translate + "px");
        workspace.style.setProperty("--oi-notes-pane-w", columns.notes + "px");
        workspace.style.setProperty("--notes-width", columns.notes + "px");
        reorderWorkspacePanes(workspace, notesDomOrder({ layout: "3", notesSide: "end", sourceSide: "start" }));
        frame.columns = columns;
      } else {
        delete workspace.dataset.layout;
        workspace.dataset.sourceMode = "side";
        reorderWorkspacePanes(workspace, notesDomOrder({ layout: "", notesSide: "end", sourceSide: "start" }));
      }
      return frame;
    };
    window.__measure = () => {
      const slot = document.getElementById("sideSlot");
      const panel = document.querySelector(".oi-library");
      const slotBox = slot.getBoundingClientRect();
      const panelBox = panel.getBoundingClientRect();
      const translate = document.querySelector(".pane-translate").getBoundingClientRect();
      const ws = workspace.getBoundingClientRect();
      const rows = [...document.querySelectorAll(".oi-lib-row")].map((row) => {
        const box = row.getBoundingClientRect();
        const trash = row.querySelector(".oi-lib-trash").getBoundingClientRect();
        return { width: box.width, trashRight: trash.right, panelRight: panelBox.right };
      });
      const link = getComputedStyle(document.querySelector(".oi-lib-storage"));
      return {
        slotW: slotBox.width,
        panelW: panelBox.width,
        panelClient: panel.clientWidth,
        slotRight: slotBox.right,
        panelRight: panelBox.right,
        wsRight: ws.right,
        wsW: ws.width,
        translateW: translate.width,
        rows,
        band: workspace.dataset.libraryBand || "",
        layout: workspace.dataset.layout || "",
        linkSize: link.fontSize,
        linkWeight: String(link.fontWeight),
        linkWrap: link.whiteSpace,
        linkColor: link.color,
        session: workspace.style.getPropertyValue("--library-width")
      };
    };
    window.__ready = true;
  </script>
</body>
</html>`;

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/library-panel.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(PAGE);
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
    "--force-device-scale-factor=1",
    `--user-data-dir=${userDataDir}`,
    "--window-size=1680,1050",
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

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

test("LIB-01/04/05 library panel and rows fill the column at default and dragged widths", { timeout: 120000 }, async (t) => {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-library-panel-"));
  rememberOwnedTemp(ownedDir);
  const userDataDir = join(ownedDir, "profile");
  const scratchDir = join(ownedDir, "scratch");
  mkdirSync(userDataDir);
  mkdirSync(scratchDir);
  mkdirSync(shots, { recursive: true });
  const handle = { child: null, cdp: null };
  t.after(async () => {
    try {
      handle.cdp?.dispose();
    } finally {
      await cleanupChrome({ t, child: handle.child, server, ownedDir, userDataDir });
    }
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url: `${origin}/library-panel.html` }, sessionId);
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, sessionId);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(detail || JSON.stringify(result.exceptionDetails));
    }
    return result.result?.value;
  };
  const started = Date.now();
  let ready = "";
  while (Date.now() - started < 8000) {
    ready = await evaluate(`window.__ready ? "yes" : ""`);
    if (ready) break;
    await sleep(40);
  }
  assert.equal(ready, "yes");

  const cases = [
    { name: "wide-1440-default", width: 1440, session: null, band: "wide", layout: "3", expect: 360 },
    { name: "wide-1440-drag-320", width: 1440, session: 320, band: "wide", layout: "3", expect: 320 },
    { name: "wide-1440-drag-400", width: 1440, session: 400, band: "wide", layout: "3", expect: 400 },
    { name: "wide-1440-drag-480", width: 1440, session: 480, band: "wide", layout: "3", expect: 480 },
    { name: "wide-1200-default", width: 1200, session: null, band: "wide", layout: "", expect: 360 },
    { name: "wide-1200-drag-480", width: 1200, session: 480, band: "wide", layout: "", expect: 480 },
    { name: "mid-1180-default", width: 1180, session: null, band: "mid", layout: "", min: 320, max: 400, translate: 618 },
    { name: "mid-1180-drag-320", width: 1180, session: 320, band: "mid", layout: "", expect: 320, translate: 618 },
    { name: "mid-1180-drag-480", width: 1180, session: 480, band: "mid", layout: "", expect: 400, sessionStays: "480px", translate: 618 },
    { name: "mid-1024-default", width: 1024, session: null, band: "mid", layout: "", expect: 398, translate: 618 },
    { name: "mid-1024-drag-320", width: 1024, session: 320, band: "mid", layout: "", expect: 320, translate: 618 },
    { name: "mid-1024-drag-480", width: 1024, session: 480, band: "mid", layout: "", min: 320, max: 400, sessionStays: "480px", translate: 618 },
    { name: "sheet-860", width: 860, session: 480, band: "sheet", layout: "", sheet: true }
  ];

  for (const item of cases) {
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: item.width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    }, sessionId);
    const sessionArg = item.session == null ? "null" : String(item.session);
    const frame = await evaluate(`window.__paint(${item.width}, ${sessionArg})`);
    await sleep(40);
    const measured = await evaluate(`window.__measure()`);
    assert.equal(frame.band, item.band, item.name);
    assert.equal(measured.band, item.band, item.name);
    assert.equal(measured.layout, item.layout, item.name);
    if (item.sheet) {
      assert.ok(Math.abs(measured.panelW - item.width) <= 2, JSON.stringify({ item, measured }));
      assert.ok(measured.panelW > 700, JSON.stringify(measured));
    } else {
      const expect = item.expect ?? frame.width;
      assert.ok(Math.abs(frame.width - expect) <= 1, JSON.stringify({ item, frame }));
      assert.ok(Math.abs(measured.panelW - frame.width) <= 2, JSON.stringify({ item, measured, frame }));
      assert.ok(Math.abs(measured.slotW - measured.panelW) <= 2, JSON.stringify({ item, measured }));
      assert.ok(Math.abs(measured.wsRight - measured.panelRight) <= 2, JSON.stringify({ item, measured }));
      assert.ok(measured.rows.length >= 2, item.name);
      for (const row of measured.rows) {
        assert.ok(Math.abs(row.width - measured.panelClient) <= 2, JSON.stringify({ item, row, measured }));
      }
      const trash = measured.rows.map((row) => row.trashRight);
      assert.ok(Math.abs(trash[0] - trash[1]) <= 1, JSON.stringify({ item, trash }));
      if (item.translate) assert.ok(measured.translateW + 1 >= item.translate, JSON.stringify({ item, measured }));
      if (item.min != null) assert.ok(frame.width >= item.min && frame.width <= item.max, JSON.stringify(frame));
      if (item.sessionStays) assert.equal(measured.session.trim(), item.sessionStays);
    }
    if (item.name === "wide-1440-default") {
      assert.equal(measured.linkSize, "12px");
      assert.equal(measured.linkWeight, "500");
      assert.equal(measured.linkWrap, "nowrap");
      assert.equal(measured.linkColor, "rgb(11, 74, 140)");
    }
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(join(shots, `${item.name}.png`), Buffer.from(shot.data, "base64"));
  }
});
