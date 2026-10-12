// NTP column geometry in headless Chrome. No PDF fixture.
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

const TMP_PREFIXES = ["oi-notes-three-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(TMP_PREFIXES);

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
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
<style>
  html, body { margin: 0; }
  .workspace { width: 1440px; height: 640px; }
  #pages, #translateScroll, .oi-notes-scroll { height: 400px; overflow: auto; }
  .filler { height: 1800px; }
</style>
</head>
<body class="oi-reader-app" data-reader-theme="warm">
  <div class="workspace" data-source-mode="side" data-source-side="start" data-notes-open="true">
    <section class="pane-pdf" id="pdfPane" aria-label="原文栏">
      <div id="pages"><canvas id="pageCanvas"></canvas><div class="filler"></div></div>
    </section>
    <div class="split-handle" data-split="source" role="separator" aria-orientation="vertical" aria-controls="pdfPane" tabindex="0" aria-label="调整分栏"><span class="split-bubble" aria-hidden="true">原文栏 50%</span></div>
    <aside class="pane-translate" aria-label="译文栏">
      <div id="translateScroll"><div class="filler"></div></div>
    </aside>
    <div id="sideSlot"><div class="oi-notes"><div class="oi-notes-scroll"><div class="filler"></div></div></div></div>
    <div class="split-handle" data-split="notes" role="separator" aria-orientation="vertical" aria-controls="sideSlot" aria-label="调整笔记栏宽度" tabindex="0"><span class="split-bubble" aria-hidden="true">笔记栏 360px</span></div>
  </div>
  <script type="module">
    import {
      applyNotesSplitAria,
      notesChromeKind,
      notesDomOrder,
      notesSplitAria,
      reorderWorkspacePanes,
      threePaneColumns,
      threeSourceAria
    } from "/lib/notes-pane.js";
    const workspace = document.querySelector(".workspace");
    window.__paint = (width, notesWidth, ratio, side) => {
      workspace.style.width = width + "px";
      const columns = threePaneColumns({ workspaceWidth: width, notesWidth, splitRatio: ratio });
      workspace.dataset.layout = "3";
      workspace.dataset.notesOpen = "true";
      workspace.dataset.notesSide = side;
      workspace.dataset.sourceSide = side === "start" ? "end" : "start";
      workspace.dataset.sourceMode = "side";
      workspace.style.setProperty("--oi-three-source", columns.source + "px");
      workspace.style.setProperty("--oi-three-translate", columns.translate + "px");
      workspace.style.setProperty("--notes-width", columns.notes + "px");
      workspace.style.setProperty("--oi-notes-pane-w", columns.notes + "px");
      const notes = document.querySelector('.split-handle[data-split="notes"]');
      applyNotesSplitAria(notes, notesSplitAria({ notesWidth: columns.notes, workspaceWidth: width }));
      const source = threeSourceAria({ workspaceWidth: width, notesWidth: columns.notes, splitRatio: columns.ratio });
      const handle = document.querySelector('.split-handle[data-split="source"]');
      handle.setAttribute("aria-valuetext", source.valuetext);
      handle.querySelector(".split-bubble").textContent = source.bubble;
      reorderWorkspacePanes(workspace, notesDomOrder({ layout: "3", notesSide: side, sourceSide: workspace.dataset.sourceSide }));
      return columns;
    };
    window.__kind = (windowWidth, workspaceWidth, notesWidth, extra) => notesChromeKind({
      windowWidth, workspaceWidth, notesWidth, ...extra
    });
    window.__ready = true;
  </script>
</body>
</html>`;

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/three-pane.html") {
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

test("NTP-01/02/06/12/13 three-pane columns keep order, scroll, and the notes splitter", { timeout: 90000 }, async (t) => {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-notes-three-"));
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
  const origin = `http://127.0.0.1:${server.address().port}`;
  handle.child = launchChrome(userDataDir, scratchDir);
  const cdp = new PipeCdp(handle.child.stdio[3], handle.child.stdio[4]);
  handle.cdp = cdp;
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("DOM.enable", {}, sessionId);
  await cdp.send("CSS.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url: `${origin}/three-pane.html` }, sessionId);
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

  const wide = JSON.parse(await evaluate(`(() => {
    document.querySelector("#pages").scrollTop = 120;
    document.querySelector("#translateScroll").scrollTop = 80;
    document.querySelector(".oi-notes-scroll").scrollTop = 40;
    const canvas = document.getElementById("pageCanvas");
    window.__canvas = canvas;
    const columns = window.__paint(1440, 360, 0.5, "end");
    const pdf = document.querySelector(".pane-pdf").getBoundingClientRect();
    const translate = document.querySelector(".pane-translate").getBoundingClientRect();
    const notes = document.getElementById("sideSlot").getBoundingClientRect();
    const order = [...document.querySelector(".workspace").children].map((node) => node.id || node.getAttribute("data-split") || node.className);
    const ws = document.querySelector(".workspace");
    return JSON.stringify({
      columns,
      pdf: pdf.width,
      translate: translate.width,
      notes: notes.width,
      gapA: translate.left - pdf.right,
      gapB: notes.left - translate.right,
      order,
      layout: ws.dataset.layout,
      notesSide: ws.dataset.notesSide,
      sourceSide: ws.dataset.sourceSide,
      sameCanvas: document.getElementById("pageCanvas") === canvas,
      pages: document.querySelector("#pages").scrollTop,
      translation: document.querySelector("#translateScroll").scrollTop,
      list: document.querySelector(".oi-notes-scroll").scrollTop
    });
  })()`));
  assert.equal(wide.layout, "3");
  assert.equal(wide.notesSide, "end");
  assert.equal(wide.sourceSide, "start");
  assert.equal(wide.columns.source, 446);
  assert.equal(wide.columns.translate, 618);
  assert.ok(Math.abs(wide.pdf - 446) <= 1, JSON.stringify(wide));
  assert.ok(Math.abs(wide.translate - 618) <= 1, JSON.stringify(wide));
  assert.ok(Math.abs(wide.notes - 360) <= 1, JSON.stringify(wide));
  assert.ok(Math.abs(wide.gapA - 8) <= 1, JSON.stringify(wide));
  assert.ok(Math.abs(wide.gapB - 8) <= 1, JSON.stringify(wide));
  assert.deepEqual(wide.order, ["pdfPane", "source", "pane-translate", "notes", "sideSlot"]);
  assert.equal(wide.sameCanvas, true);
  assert.ok(Math.abs(wide.pages - 120) <= 2, JSON.stringify(wide));
  assert.ok(Math.abs(wide.translation - 80) <= 2, JSON.stringify(wide));
  assert.ok(Math.abs(wide.list - 40) <= 2, JSON.stringify(wide));

  const bigger = JSON.parse(await evaluate(`(() => {
    const columns = window.__paint(1680, 360, 0.5, "end");
    const pdf = document.querySelector(".pane-pdf").getBoundingClientRect();
    const translate = document.querySelector(".pane-translate").getBoundingClientRect();
    return JSON.stringify({ columns, pdf: pdf.width, translate: translate.width });
  })()`));
  assert.equal(bigger.columns.source, 652);
  assert.equal(bigger.columns.translate, 652);
  assert.ok(Math.abs(bigger.pdf - 652) <= 1, JSON.stringify(bigger));
  assert.ok(Math.abs(bigger.translate - 652) <= 1, JSON.stringify(bigger));

  const flipped = JSON.parse(await evaluate(`(() => {
    document.querySelector("#pages").scrollTop = 90;
    document.querySelector("#translateScroll").scrollTop = 70;
    document.querySelector(".oi-notes-scroll").scrollTop = 30;
    const before = document.getElementById("pageCanvas");
    window.__paint(1440, 360, 0.5, "start");
    const order = [...document.querySelector(".workspace").children].map((node) => node.id || node.getAttribute("data-split") || node.className);
    const notes = document.getElementById("sideSlot").getBoundingClientRect();
    const pdf = document.querySelector(".pane-pdf").getBoundingClientRect();
    return JSON.stringify({
      order,
      notesLeft: notes.left < pdf.left,
      sameCanvas: document.getElementById("pageCanvas") === before,
      pages: document.querySelector("#pages").scrollTop,
      translation: document.querySelector("#translateScroll").scrollTop,
      list: document.querySelector(".oi-notes-scroll").scrollTop,
      side: document.querySelector(".workspace").dataset.notesSide,
      source: document.querySelector(".workspace").dataset.sourceSide
    });
  })()`));
  assert.deepEqual(flipped.order, ["sideSlot", "notes", "pane-translate", "source", "pdfPane"]);
  assert.equal(flipped.notesLeft, true);
  assert.equal(flipped.sameCanvas, true);
  assert.equal(flipped.side, "start");
  assert.equal(flipped.source, "end");
  assert.ok(Math.abs(flipped.pages - 90) <= 2, JSON.stringify(flipped));
  assert.ok(Math.abs(flipped.translation - 70) <= 2, JSON.stringify(flipped));
  assert.ok(Math.abs(flipped.list - 30) <= 2, JSON.stringify(flipped));

  const aria = JSON.parse(await evaluate(`(() => {
    window.__paint(1440, 360, 0.5, "end");
    const handle = document.querySelector('.split-handle[data-split="notes"]');
    const source = document.querySelector('.split-handle[data-split="source"]');
    const grip = getComputedStyle(handle, "::after");
    const line = getComputedStyle(handle, "::before");
    const sourceGrip = getComputedStyle(source, "::after");
    return JSON.stringify({
      now: handle.getAttribute("aria-valuenow"),
      min: handle.getAttribute("aria-valuemin"),
      max: handle.getAttribute("aria-valuemax"),
      text: handle.getAttribute("aria-valuetext"),
      label: handle.getAttribute("aria-label"),
      controls: handle.getAttribute("aria-controls"),
      bubble: handle.querySelector(".split-bubble").textContent,
      sourceText: source.getAttribute("aria-valuetext"),
      gripOpacity: grip.opacity,
      gripW: grip.width,
      gripH: grip.height,
      sourceGripW: sourceGrip.width,
      sourceGripH: sourceGrip.height,
      lineW: line.width
    });
  })()`));
  assert.equal(aria.now, "360");
  assert.equal(aria.min, "320");
  assert.equal(aria.max, "480");
  assert.equal(aria.text, "笔记栏 360 像素");
  assert.equal(aria.bubble, "笔记栏 360px");
  assert.equal(aria.label, "调整笔记栏宽度");
  assert.equal(aria.controls, "sideSlot");
  assert.match(aria.sourceText, /^原文栏 \d+%$/);
  assert.equal(aria.gripOpacity, "0");
  assert.equal(aria.gripW, aria.sourceGripW);
  assert.equal(aria.gripH, aria.sourceGripH);

  const { root: docRoot } = await cdp.send("DOM.getDocument", {}, sessionId);
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: docRoot.nodeId,
    selector: '.split-handle[data-split="notes"]'
  }, sessionId);
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] }, sessionId);
  const hovered = await evaluate(`(() => {
    const handle = document.querySelector('.split-handle[data-split="notes"]');
    const grip = getComputedStyle(handle, "::after");
    return JSON.stringify({ delay: grip.transitionDelay, opacity: grip.opacity });
  })()`);
  const hover = JSON.parse(hovered);
  assert.ok(hover.delay === "0.12s" || hover.delay === "120ms", hovered);
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }, sessionId);

  const kinds = JSON.parse(await evaluate(`JSON.stringify({
    open: window.__kind(1314, 1314, 360, { opening: true }),
    below: window.__kind(1297, 1297, 360, { opening: true }),
    back: window.__kind(1330, 1330, 360, { latched: "slot" })
  })`));
  assert.equal(kinds.open, "three");
  assert.equal(kinds.below, "slot");
  assert.equal(kinds.back, "three");
});
