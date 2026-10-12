// Headless measurements for NIM-01…09. No PDF fixture: the panel mounts against a fake document.
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

const TMP_PREFIXES = ["oi-notes-layout-", "com.google.Chrome.", ".com.google.Chrome."];
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
<link rel="stylesheet" href="/pdf/notes-panel.css">
<style>
  html, body { margin: 0; height: 100%; }
  body { --oi-reader-font-size: 16px; }
  #sideSlot { width: 400px; height: 560px; display: flex; }
  .more-item { display: flex; align-items: center; width: 100%; min-height: 32px; padding: 0 12px; border: 0; background: transparent; }
  #flow { position: absolute; left: 420px; top: 0; width: 280px; }
</style>
</head>
<body class="oi-reader-app">
  <div class="workspace" data-source-mode="side">
    <div id="sideSlot"></div>
  </div>
  <div class="reader-flow" id="flow">
    <div class="rf-block" data-bid="b1" data-pair-id="p1" data-src-page="4">
      <div class="rf-zh">AlphaBeta 还在这段里</div>
    </div>
  </div>
  <script type="module">
    import { mountNotesUi } from "/pdf/notes-panel.js";
    const quote = "这是一段很长的划线引文用来确认最多只显示两行多出来的部分被截断不会把卡片撑高。".repeat(4);
    const notes = [];
    const trash = [{ id: "t1", kind: "note", author: "me", body: "删", page: 1, deletedAt: 9, createdAt: 1, updatedAt: 1, anchor: null }];
    let dismissed = false;
    let releaseList = () => {};
    const gate = new Promise((done) => { releaseList = done; });
    window.__releaseList = () => releaseList();
    window.__current = null;
    function row(id, extra) {
      notes.push({
        id, kind: "note", author: "me", body: id, page: 4, createdAt: notes.length + 1, updatedAt: notes.length + 1,
        anchor: { bid: "bx", page: 4, quote: "不在页面上", offset: { start: 0, end: 5 } },
        anchorState: { status: "exact" },
        ...extra
      });
    }
    row("h1", { kind: "highlight", body: "", anchor: { bid: "b1", page: 4, quote, offset: { start: 0, end: quote.length } } });
    row("n1", { anchor: { bid: "b1", page: 4, quote: "AlphaBeta", offset: { start: 0, end: 9 } } });
    row("approx", { anchorState: { status: "quote" }, body: "近似" });
    row("q1", { kind: "question", body: "为什么", qa: { answer: "" } });
    row("n2"); row("n3"); row("n4"); row("n5");
    row("l1", { page: 2, body: "丢一", anchor: { bid: "dead", page: 2, quote: "找不到的话", offset: { start: 0 } }, anchorState: { status: "lost" }, createdAt: 20 });
    row("l2", { kind: "highlight", page: 5, body: "", anchor: { bid: "dead2", page: 5, quote: "另一条丢失引文也很长".repeat(6), offset: { start: 0 } }, anchorState: { status: "lost" }, createdAt: 21 });
    const ui = mountNotesUi({
      hasDoc: () => true,
      docHash: () => "doc-layout",
      list: () => gate.then(() => notes.slice()),
      listTrash: async () => trash.slice(),
      readPrefs: () => ({ panelWidth: 440 }),
      currentParagraph: () => window.__current,
      blockOrder: () => new Map(),
      flow: () => document.getElementById("flow"),
      pane: () => document.getElementById("flow"),
      pointerFine: () => true,
      persistDenied: async () => true,
      persistDismissed: () => dismissed,
      dismissPersist: () => { dismissed = true; },
      jumpPage: () => {},
      jumpAnchor: () => {},
      put: async (note) => note,
      softDelete: async (id) => {
        const index = notes.findIndex((note) => note.id === id);
        const note = notes.splice(index, 1)[0];
        note.deletedAt = Date.now();
        trash.push(note);
        return note;
      },
      subscribe: () => () => {},
      onOpenChange: () => {}
    });
    window.__ui = ui;
    window.__notes = notes;
    ui.open(false);
  </script>
</body>
</html>`;

function serveRepo() {
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/nim-layout.html") {
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
    "--window-size=1280,800",
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

test("NIM-01…09 notes panel layout holds without a PDF fixture", { timeout: 90000 }, async (t) => {
  const server = await serveRepo();
  const ownedDir = mkdtempSync(join(tmpdir(), "oi-notes-layout-"));
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
  await cdp.send("Page.navigate", { url: `${origin}/nim-layout.html` }, sessionId);

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

  const waitFor = async (expression, label) => {
    const started = Date.now();
    let last = "";
    while (Date.now() - started < 8000) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(40);
    }
    throw new Error(`${label} timed out: ${last}`);
  };

  await waitFor(`document.querySelector(".oi-notes-skeleton") ? "skeleton" : ""`, "skeleton");
  const skeleton = JSON.parse(await evaluate(`(() => {
    const cards = [...document.querySelectorAll(".oi-notes-skeleton")];
    const gap = cards.length > 1 ? cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().bottom : -1;
    const panel = document.querySelector(".oi-notes").getBoundingClientRect().left;
    const pad = parseFloat(getComputedStyle(document.querySelector(".oi-notes")).getPropertyValue("--oi-notes-pad-x"));
    return JSON.stringify({
      gap,
      left: cards[0] ? Math.abs(cards[0].getBoundingClientRect().left - panel - pad) : 99
    });
  })()`));
  assert.ok(Math.abs(skeleton.gap - 16) <= 1, JSON.stringify(skeleton));
  assert.ok(skeleton.left <= 1, JSON.stringify(skeleton));

  await evaluate(`window.__releaseList()`);
  await waitFor(`document.querySelector('[data-note-id="n1"]') ? "cards" : ""`, "cards");
  await waitFor(`document.querySelector(".oi-notes-banner-line") ? "banner" : ""`, "persist banner");

  const idle = JSON.parse(await evaluate(`(() => {
    const button = document.querySelector(".addb");
    const hint = document.querySelector(".hint2");
    return JSON.stringify({
      disabled: button.disabled,
      hint: hint.textContent,
      rects: button.getClientRects().length,
      height: button.getBoundingClientRect().height
    });
  })()`));
  assert.equal(idle.disabled, true);
  assert.equal(idle.hint, "先在译文里点一段");
  assert.equal(idle.rects, 1);
  assert.ok(Math.abs(idle.height - 28) <= 1, JSON.stringify(idle));

  await evaluate(`window.__current = { page: 4 };`);
  await evaluate(`window.__ui.refresh()`);
  await waitFor(`document.querySelector(".hint2")?.textContent === "当前段：原文第 4 页" ? "hint" : ""`, "current hint");

  const sized = JSON.parse(await evaluate(`(async () => {
    const slot = document.getElementById("sideSlot");
    const out = [];
    for (const width of [360, 340, 320]) {
      for (const font of [14, 40]) {
        document.body.style.setProperty("--oi-reader-font-size", font + "px");
        slot.style.width = width + "px";
        window.dispatchEvent(new Event("resize"));
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const button = document.querySelector(".addb");
        const hint = document.querySelector(".hint2");
        const hintStyle = getComputedStyle(hint);
        const head = document.querySelector(".oi-notes-group-head");
        const add = document.querySelector(".oi-notes-add-row").getBoundingClientRect();
        const headBox = head.getBoundingClientRect();
        out.push({
          width, font,
          rects: button.getClientRects().length,
          height: button.getBoundingClientRect().height,
          hintRects: hint.getClientRects().length,
          ellipsis: hintStyle.textOverflow,
          nowrap: hintStyle.whiteSpace,
          overlap: Math.min(add.bottom, headBox.bottom) - Math.max(add.top, headBox.top) > 0 && add.bottom > headBox.top && add.top < headBox.bottom
        });
      }
    }
    return JSON.stringify(out);
  })()`));
  for (const row of sized) {
    assert.equal(row.rects, 1, JSON.stringify(row));
    assert.ok(Math.abs(row.height - 28) <= 1, JSON.stringify(row));
    assert.equal(row.hintRects, 1, JSON.stringify(row));
    assert.equal(row.ellipsis, "ellipsis", JSON.stringify(row));
    assert.equal(row.nowrap, "nowrap", JSON.stringify(row));
    assert.equal(row.overlap, false, JSON.stringify(row));
  }

  await evaluate(`window.__current = { page: 4, section: "缩放点积" };`);
  await evaluate(`window.__ui.refresh()`);
  await waitFor(`document.querySelector(".hint2")?.textContent.includes("缩放点积") ? "section" : ""`, "section hint");
  const sectionHint = await evaluate(`document.querySelector(".hint2").textContent`);
  assert.equal(sectionHint, "当前段：原文第 4 页 · 缩放点积");

  const align = JSON.parse(await evaluate(`(async () => {
    const slot = document.getElementById("sideSlot");
    document.body.style.setProperty("--oi-reader-font-size", "16px");
    const measure = async (width) => {
      slot.style.width = width + "px";
      window.dispatchEvent(new Event("resize"));
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
      const panel = document.querySelector(".oi-notes").getBoundingClientRect().left;
      const pad = parseFloat(getComputedStyle(document.querySelector(".oi-notes")).getPropertyValue("--oi-notes-pad-x"));
      const nodes = [
        document.querySelector(".oi-notes-banner-line"),
        document.querySelector(".oi-notes-add-row"),
        document.querySelector(".oi-notes-group-head"),
        document.querySelector(".oi-notes-group .oi-note-card")
      ];
      const lefts = nodes.map((node) => node.getBoundingClientRect().left);
      const cards = [...document.querySelectorAll(".oi-notes-group .oi-note-card")];
      const gap = cards[1].getBoundingClientRect().top - cards[0].getBoundingClientRect().bottom;
      const midX = cards[0].getBoundingClientRect().left + 8;
      const midY = cards[0].getBoundingClientRect().bottom + gap / 2;
      const hit = document.elementFromPoint(midX, midY);
      return {
        width, pad,
        delta: lefts.map((left) => Math.abs(left - panel - pad)),
        gap,
        hitCard: Boolean(hit && hit.closest && hit.closest(".oi-note-card"))
      };
    };
    return JSON.stringify([await measure(500), await measure(360)]);
  })()`));
  assert.deepEqual(align.map((row) => row.pad), [24, 16]);
  for (const row of align) {
    assert.ok(row.delta.every((delta) => delta <= 1), JSON.stringify(row));
    assert.ok(Math.abs(row.gap - 16) <= 1, JSON.stringify(row));
    assert.equal(row.hitCard, false, JSON.stringify(row));
  }

  const lost = JSON.parse(await evaluate(`(() => {
    const groups = [...document.querySelectorAll(".oi-notes-group .card.lost")];
    const sec = document.querySelector(".lostsec");
    const list = document.querySelector(".oi-notes-list");
    const hint = "译文重排后没找到这段话，没有画到别处。";
    const l1 = document.querySelector('.lostsec [data-note-id="l1"]');
    const actions = l1.querySelector(".oi-note-actions");
    const quote = document.querySelector('.lostsec [data-note-id="l2"] .oi-note-quote');
    return JSON.stringify({
      inGroups: groups.length,
      last: list.lastElementChild.className,
      title: sec.querySelector(".lostsec-title").textContent,
      hints: sec.textContent.split(hint).length - 1,
      toggle: sec.querySelector(".lostsec-toggle").textContent,
      page: l1.querySelector(".oi-note-page").textContent,
      actions: actions.textContent,
      actionsVisible: getComputedStyle(actions).visibility,
      strike: getComputedStyle(quote).textDecorationLine,
      line: document.querySelector(".lostline").textContent,
      approx: document.querySelector('.oi-notes-group [data-note-id="approx"]').textContent.includes("位置近似"),
      approxOutside: !document.querySelector(".lostsec [data-note-id='approx']")
    });
  })()`));
  assert.equal(lost.inGroups, 0);
  assert.match(lost.last, /lostsec/);
  assert.equal(lost.title, "找不到原位置 · 2");
  assert.equal(lost.hints, 1);
  assert.equal(lost.toggle, "收起 ▴");
  assert.equal(lost.page, "原文第 2 页");
  assert.match(lost.actions, /跳到第 2 页 ↗/);
  assert.match(lost.actions, /编辑/);
  assert.match(lost.actions, /删除/);
  assert.equal(lost.actionsVisible, "visible");
  assert.equal(lost.strike, "line-through");
  assert.match(lost.line, /2 条找不到原位置/);
  assert.match(lost.line, /在列表末尾 ↓/);
  assert.equal(lost.approx, true);
  assert.equal(lost.approxOutside, true);

  const jumped = JSON.parse(await evaluate(`(() => {
    document.getElementById("sideSlot").style.height = "280px";
    const scroller = document.querySelector(".oi-notes-scroll");
    scroller.scrollTop = 0;
    const before = document.querySelector(".lostsec").getBoundingClientRect().top;
    document.querySelector(".lostline").click();
    const sec = document.querySelector(".lostsec").getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    return JSON.stringify({
      before,
      delta: sec.top - view.top,
      seen: sec.top >= view.top - 2 && sec.top <= view.bottom
    });
  })()`));
  assert.equal(jumped.seen, true, JSON.stringify(jumped));
  assert.ok(Math.abs(jumped.delta) <= 2, JSON.stringify(jumped));

  await evaluate(`document.querySelector(".lostsec-toggle").click()`);
  const collapsed = await evaluate(`document.querySelector(".lostsec-toggle").textContent`);
  assert.equal(collapsed, "展开 ▾");
  assert.equal(await evaluate(`document.querySelector(".lostsec .oi-note-card") ? "card" : ""`), "");
  await evaluate(`document.querySelector(".lostsec-toggle").click()`);

  await evaluate(`document.querySelector('[data-notes-filter="pending"]').click()`);
  const pending = JSON.parse(await evaluate(`(() => {
    const chip = document.querySelector('[data-notes-filter="pending"]');
    const cards = [...document.querySelectorAll(".oi-notes-list .oi-note-card, .oi-notes-list .card")];
    return JSON.stringify({
      chip: chip.textContent,
      cards: cards.length,
      lostsec: Boolean(document.querySelector(".lostsec")),
      lostline: Boolean(document.querySelector(".lostline"))
    });
  })()`));
  assert.equal(pending.chip, "待回答 1");
  assert.equal(pending.cards, 1);
  assert.equal(pending.lostsec, false);
  assert.equal(pending.lostline, false);
  await evaluate(`document.querySelector('[data-notes-filter="all"]').click()`);

  const menu = JSON.parse(await evaluate(`(() => {
    document.querySelector(".oi-notes-more").click();
    const heads = [...document.querySelectorAll(".oi-notes-menu .mh")].map((node) => node.textContent);
    const items = [...document.querySelectorAll(".oi-notes-menu .more-item")].map((node) => ({
      label: node.querySelector("span")?.textContent || "",
      suffix: node.querySelector(".r")?.textContent || ""
    }));
    const input = document.querySelector(".oi-notes-file");
    let clicks = 0;
    input.click = () => { clicks += 1; };
    items;
    [...document.querySelectorAll(".oi-notes-menu .more-item")].find((node) => node.textContent.includes("导入 JSON")).click();
    return JSON.stringify({ heads, items, clicks, inPanel: Boolean(input.closest("aside.oi-notes")) });
  })()`));
  assert.deepEqual(menu.heads, ["导出 · 本 PDF，不含回收站", "导入 · 合并到本机，含其他文档的笔记"]);
  assert.deepEqual(menu.items.map((item) => item.suffix), [".md", ".json", ".json"]);
  assert.equal(menu.clicks, 1);
  assert.equal(menu.inPanel, true);

  const banner = JSON.parse(await evaluate(`(() => {
    const node = document.querySelector(".oi-notes-banner-line");
    const text = node.querySelector(".oi-notes-banner-line-text");
    const close = node.querySelector(".oi-notes-banner-x");
    return JSON.stringify({
      height: node.getBoundingClientRect().height,
      lines: text.getClientRects().length,
      text: text.textContent,
      title: node.getAttribute("title"),
      tip: close.getAttribute("title"),
      button: node.querySelector(".oi-notes-banner-btn").textContent
    });
  })()`));
  assert.ok(Math.abs(banner.height - 32) <= 1, JSON.stringify(banner));
  assert.equal(banner.lines, 1);
  assert.equal(banner.text, "浏览器可能清理本机笔记，建议定期导出备份");
  assert.equal(banner.title, banner.text);
  assert.equal(banner.tip, "本文档不再提示");
  assert.equal(banner.button, "导出备份");
  await evaluate(`document.querySelector(".oi-notes-banner-x").click()`);
  assert.equal(await evaluate(`document.querySelector(".oi-notes-banner-line") ? "on" : ""`), "");
  await evaluate(`window.__ui.refresh()`);
  await waitFor(`document.querySelector('[data-note-id="n1"]') ? "back" : ""`, "reload after dismiss");
  assert.equal(await evaluate(`document.querySelector(".oi-notes-banner-line") ? "on" : ""`), "");

  const trash = JSON.parse(await evaluate(`(async () => {
    const slot = document.getElementById("sideSlot");
    slot.style.width = "360px";
    window.dispatchEvent(new Event("resize"));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const wide = document.querySelector(".oi-notes-trash");
    const wideLabel = getComputedStyle(wide.querySelector(".tbtn-label")).display;
    slot.style.width = "320px";
    window.dispatchEvent(new Event("resize"));
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    const narrow = document.querySelector(".oi-notes-trash");
    return JSON.stringify({
      wideText: wide.textContent,
      wideLabel,
      narrowLabel: getComputedStyle(narrow.querySelector(".tbtn-label")).display,
      narrowNumber: narrow.querySelector(".oi-notes-trash-n").textContent,
      aria: narrow.getAttribute("aria-label"),
      title: narrow.getAttribute("title")
    });
  })()`));
  assert.match(trash.wideText, /回收站/);
  assert.match(trash.wideText, /1/);
  assert.notEqual(trash.wideLabel, "none");
  assert.equal(trash.narrowLabel, "none");
  assert.equal(trash.narrowNumber, "1");
  assert.equal(trash.aria, "回收站，1 条");
  assert.equal(trash.title, "回收站 · 1 条，可恢复");

  await evaluate(`document.getElementById("sideSlot").style.width = "400px"`);
  await evaluate(`window.dispatchEvent(new Event("resize"))`);
  const linked = JSON.parse(await evaluate(`(() => {
    document.querySelector('[data-note-id="n1"]').click();
    const card = document.querySelector('[data-note-id="n1"]');
    const probe = document.createElement("div");
    probe.id = "mineProbe";
    probe.style.background = "var(--oi-reader-mine-soft)";
    document.body.append(probe);
    const want = getComputedStyle(probe).backgroundColor;
    const mark = document.querySelector('.hl.linked, .oi-note-mark.linked');
    const shadow = mark ? getComputedStyle(mark).boxShadow : "";
    const border = mark ? getComputedStyle(mark).borderBottomWidth : "";
    return JSON.stringify({
      bg: getComputedStyle(card).backgroundColor,
      want,
      linked: card.classList.contains("linked"),
      shadow,
      border
    });
  })()`));
  assert.equal(linked.bg, linked.want, JSON.stringify(linked));
  assert.equal(linked.linked, true);
  assert.equal(linked.border, "2px");
  assert.equal(linked.shadow, "none");

  const { root: domRoot } = await cdp.send("DOM.getDocument", {}, sessionId);
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: domRoot.nodeId,
    selector: '[data-note-id="n1"]'
  }, sessionId);
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: ["hover"] }, sessionId);
  const hovered = await evaluate(`(() => {
    const card = document.querySelector('[data-note-id="n1"]');
    const probe = document.getElementById("mineProbe");
    return getComputedStyle(card).backgroundColor === getComputedStyle(probe).backgroundColor ? "same" : getComputedStyle(card).backgroundColor;
  })()`);
  assert.equal(hovered, "same");
  await cdp.send("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] }, sessionId);

  const quoteBox = JSON.parse(await evaluate(`(() => {
    const quote = document.querySelector('[data-note-id="h1"] .oi-note-quote');
    const line = parseFloat(getComputedStyle(quote).lineHeight);
    const add = document.querySelector('[data-note-id="h1"] .ghostadd');
    return JSON.stringify({
      height: quote.getBoundingClientRect().height,
      line,
      add: add.textContent,
      shown: getComputedStyle(add).visibility
    });
  })()`));
  assert.ok(quoteBox.height <= quoteBox.line * 2 + 1, JSON.stringify(quoteBox));
  assert.equal(quoteBox.add, "＋ 加笔记");
  assert.equal(quoteBox.shown, "visible");
  await evaluate(`document.querySelector('[data-note-id="h1"] .ghostadd').click()`);
  await waitFor(`document.querySelector(".oi-note-field") ? "editor" : ""`, "highlight editor");

  const kept = JSON.parse(await evaluate(`(async () => {
    document.querySelector(".oi-notes-head").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    for (let i = 0; i < 20 && document.querySelector(".oi-note-field"); i += 1) {
      await new Promise((done) => setTimeout(done, 20));
    }
    const scroller = document.querySelector(".oi-notes-scroll");
    scroller.scrollTop = 36;
    const before = scroller.scrollTop;
    const lost = window.__notes.filter((note) => note.anchorState.status === "lost");
    for (const note of lost) note.anchorState = { status: "exact" };
    await window.__ui.refresh();
    const after = document.querySelector(".oi-notes-scroll").scrollTop;
    return JSON.stringify({
      before, after,
      l1Group: Boolean(document.querySelector('.oi-notes-group [data-note-id="l1"]')),
      lostsec: Boolean(document.querySelector(".lostsec"))
    });
  })()`));
  assert.ok(Math.abs(kept.after - kept.before) <= 1, JSON.stringify(kept));
  assert.equal(kept.l1Group, true);
  assert.equal(kept.lostsec, false);

  const safe = JSON.parse(await evaluate(`(async () => {
    document.getElementById("sideSlot").style.height = "360px";
    const cards = [...document.querySelectorAll(".oi-note-card")];
    const target = cards[cards.length - 2];
    target.querySelector(".oi-note-actions button:last-child").click();
    for (let i = 0; i < 30; i += 1) {
      if (document.querySelector(".oi-note-undo:not([hidden])")) break;
      await new Promise((done) => setTimeout(done, 30));
    }
    const scroller = document.querySelector(".oi-notes-scroll");
    scroller.scrollTop = scroller.scrollHeight;
    const last = [...document.querySelectorAll(".oi-note-card")].at(-1).getBoundingClientRect();
    const toast = document.querySelector(".oi-note-undo").getBoundingClientRect();
    return JSON.stringify({
      cardBottom: last.bottom,
      toastTop: toast.top,
      toastHeight: toast.height
    });
  })()`));
  assert.ok(Math.abs(safe.toastHeight - 40) <= 1, JSON.stringify(safe));
  assert.ok(safe.cardBottom <= safe.toastTop - 8 + 0.5, JSON.stringify(safe));

  const headLine = JSON.parse(await evaluate(`(async () => {
    const slot = document.getElementById("sideSlot");
    const rows = [];
    const textLines = (node) => {
      if (!node) return 0;
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getClientRects().length;
    };
    for (const width of [320, 360, 480]) {
      for (const font of [14, 40]) {
        document.body.style.setProperty("--oi-reader-font-size", font + "px");
        slot.style.width = width + "px";
        window.dispatchEvent(new Event("resize"));
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        const head = document.querySelector(".oi-notes-head");
        const buttons = [...head.querySelectorAll(".view-seg-btn")];
        const label = head.querySelector(".tbtn-label");
        const box = head.getBoundingClientRect();
        rows.push({
          width,
          font,
          headH: box.height,
          scroll: head.scrollWidth,
          client: head.clientWidth,
          buttons: buttons.map((node) => ({
            text: node.textContent,
            lines: textLines(node),
            h: node.getBoundingClientRect().height
          })),
          trashLines: label && getComputedStyle(label).display !== "none" ? textLines(label) : 0,
          trashH: head.querySelector(".oi-notes-trash").getBoundingClientRect().height
        });
      }
    }
    document.body.style.removeProperty("--oi-reader-font-size");
    slot.style.width = "400px";
    window.dispatchEvent(new Event("resize"));
    return JSON.stringify(rows);
  })()`));
  for (const row of headLine) {
    assert.ok(row.headH <= 44.5, JSON.stringify(row));
    assert.ok(row.scroll <= row.client + 1, JSON.stringify(row));
    for (const button of row.buttons) {
      assert.equal(button.lines, 1, JSON.stringify(row));
      assert.ok(button.h <= 30, JSON.stringify(row));
    }
    if (row.trashLines) assert.equal(row.trashLines, 1, JSON.stringify(row));
    assert.ok(row.trashH <= 30.5, JSON.stringify(row));
  }
});
