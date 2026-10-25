import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { parseHTML } from "linkedom";

import { formatApproxBytes } from "../lib/usage-format.js";
import { mountDataPanel } from "../options/data-panel.js";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const SHOT_DIR = "/opt/cursor/artifacts/settings-polish-2";
installOwnedTmpGuard(["oi-set-polish-", "com.google.Chrome.", ".com.google.Chrome."]);

function quietCoordinator() {
  return {
    state: () => ({ phase: "idle" }),
    subscribe() { return () => {}; },
    attach() {},
    detach() {},
    destroy() {},
    errorsForExport() { return []; }
  };
}

function withDom() {
  const previous = globalThis.document;
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const proto = Object.getPrototypeOf(document.createElement("input"));
  if (!proto.__oiToggle) {
    const nativeClick = proto.click;
    proto.click = function click() {
      if (this.type === "checkbox" && !this.disabled) this.checked = !this.checked;
      nativeClick.call(this);
      if (this.type === "checkbox" && !this.disabled) {
        const view = this.ownerDocument?.defaultView;
        if (view) this.dispatchEvent(new view.Event("change", { bubbles: true }));
      }
    };
    proto.focus = function focus() {
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    };
    proto.__oiToggle = true;
  }
  globalThis.document = document;
  return () => {
    globalThis.document = previous;
  };
}

function libraryStore({ sourceSize = 0, trashPad = 0, fail = false, hold = false } = {}) {
  const calls = [];
  let releaseHold = () => {};
  const gate = hold ? new Promise((resolve) => { releaseHold = resolve; }) : Promise.resolve();
  let opened = !hold;
  return {
    calls,
    releaseHold,
    async listPapers() {
      if (!opened) {
        await gate;
        opened = true;
      }
      if (fail) throw new Error("size");
      return sourceSize > 0 ? [{ sourceSize }] : [];
    },
    async exportLibrary(options) {
      calls.push(options);
      if (fail) throw new Error("size");
      if (sourceSize === 0 && trashPad === 0) return { papers: [] };
      const include = options?.include || {};
      return { papers: [{ notes: ["n"], extra: include.trash ? "t".repeat(trashPad) : "" }] };
    },
    async usage() { return { usage: 10, quota: 100, persisted: true }; },
    async migrationStatus() { return null; },
    subscribe() { return () => {}; }
  };
}

async function expectedSizes(store) {
  const papers = await store.listPapers();
  let sources = 0;
  let hasSource = false;
  for (const paper of papers) {
    const size = Number(paper.sourceSize) || 0;
    if (size > 0) {
      sources += size;
      hasSource = true;
    }
  }
  const plain = await store.exportLibrary({ include: { notes: true, trash: false, layouts: false, sources: false } });
  const withTrash = await store.exportLibrary({ include: { notes: true, trash: true, layouts: false, sources: false } });
  return {
    base: JSON.stringify(plain).length,
    sources,
    trash: Math.max(0, JSON.stringify(withTrash).length - JSON.stringify(plain).length),
    hasSource
  };
}

function exportGroupOf(node) {
  return node.querySelector('[data-focus-group="export"]');
}

function mount(node, store, extra = {}) {
  node.replaceChildren?.();
  document.body.append(node);
  return mountDataPanel(node, {
    store,
    coordinator: quietCoordinator(),
    usage: async () => ({ usage: 10, quota: 100, persisted: true }),
    width: () => extra.width || 800,
    ...extra
  });
}

test("EXI-02 / NAV-02 / NAV-13 source rules reuse the switch and add no hex tokens", () => {
  const css = read("options/options.css");
  const dataCss = read("options/data-panel.css");
  const panel = read("options/data-panel.js");
  const html = read("options/options.html");
  const selector = ':is(.set-row > input[role="switch"], .oi-data .set-actions > input[role="switch"])';
  assert.ok(css.includes(`body.oi-settings ${selector} {`));
  assert.ok(css.includes(`body.oi-settings ${selector}::before`));
  assert.ok(css.includes(`body.oi-settings ${selector}:checked`));
  assert.ok(css.includes(`body.oi-settings ${selector}:checked::before`));
  assert.ok(css.includes(`body.oi-settings ${selector}:disabled`));
  const block = css.slice(css.indexOf(`body.oi-settings ${selector} {`), css.indexOf("/* SVA-03"));
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(block), false);
  assert.equal(panel.includes("oi-switch"), false);
  assert.equal(dataCss.includes("appearance:"), false);
  assert.match(html, /button > .set-badge|data-nav="translate"[^>]*>翻译<span class="set-badge"/);
  assert.equal(html.includes("set-nav-item"), false);
  assert.equal(html.includes("brand-links"), false);
  assert.equal(read("options/options.js").includes("brand-links"), false);
  assert.equal(css.includes("--oi-reader-"), false);
  assert.equal(dataCss.includes("--oi-reader-"), false);
  const navTokens = css.slice(css.indexOf("--set-nav-w:"), css.indexOf("--set-nav-radius:") + "--set-nav-radius: 7px;".length);
  assert.match(navTokens, /--set-nav-w:\s*232px/);
  assert.match(navTokens, /--set-nav-gap:\s*32px/);
  assert.match(navTokens, /--set-nav-pad:\s*20px 12px/);
  assert.match(navTokens, /--set-nav-inset:\s*8px/);
  assert.match(navTokens, /--set-nav-item-h:\s*30px/);
  assert.match(navTokens, /--set-nav-item-gap:\s*2px/);
  assert.equal(/#[0-9a-fA-F]{3,8}/.test(navTokens), false);
  assert.match(css, /body\.oi-settings\s*\{[^]*--set-nav-w:\s*232px/);
});

test("EXI-04/05/07/11/12/13/14 export switches, copy, and include flags", async () => {
  const restore = withDom();
  try {
    const held = libraryStore({ sourceSize: 8 * 1024 * 1024, trashPad: 4000, hold: true });
    const loadingRoot = document.createElement("div");
    const loadingPanel = mount(loadingRoot, held);
    const loadingExport = exportGroupOf(loadingRoot);
    assert.match(loadingExport.textContent, /正在计算大小/);
    assert.match(loadingExport.textContent, /预计 计算中…/);
    assert.ok(loadingExport.querySelector(".oi-data-skel"));
    assert.equal(loadingExport.querySelector("#exportIncTrash").disabled, false);
    assert.equal(loadingExport.querySelector('input:not([role="switch"])'), null);
    held.releaseHold();
    await loadingPanel.reload();

    const store = libraryStore({ sourceSize: 8 * 1024 * 1024, trashPad: 4000 });
    const host = document.createElement("div");
    const panel = mount(host, store);
    await panel.reload();
    const group = exportGroupOf(host);
    const sizes = await expectedSizes(store);
    assert.equal(sizes.hasSource, true);
    assert.ok(sizes.trash > 0);
    const source = group.querySelector("#exportIncSource");
    const trash = group.querySelector("#exportIncTrash");
    assert.equal(source.getAttribute("role"), "switch");
    assert.equal(trash.getAttribute("role"), "switch");
    assert.equal(source.getAttribute("aria-checked"), "false");
    assert.equal(trash.getAttribute("aria-checked"), "false");
    assert.equal(source.checked, false);
    assert.equal(trash.checked, false);
    assert.equal(source.getAttribute("aria-labelledby"), "exportIncSourceTitle");
    assert.equal(source.getAttribute("aria-describedby"), "exportIncSourceNote");
    assert.equal(trash.getAttribute("aria-labelledby"), "exportIncTrashTitle");
    assert.equal(trash.getAttribute("aria-describedby"), "exportIncTrashNote");
    assert.equal(group.querySelector("#exportIncSourceTitle").textContent, "原 PDF");
    assert.equal(group.querySelector("#exportIncTrashTitle").textContent, "回收站里的笔记");
    const sourceNote = group.querySelector("#exportIncSourceNote").textContent;
    const trashNote = group.querySelector("#exportIncTrashNote").textContent;
    assert.match(sourceNote, /^约 .+ · 体积大，默认不带$/);
    assert.match(trashNote, /^约 .+ · 已删除但还没清空的笔记$/);
    assert.equal(sourceNote.includes("+"), false);
    assert.equal(trashNote.includes("+"), false);
    assert.equal(group.querySelector(".set-value"), null);
    assert.equal(group.querySelector(".oi-data-chip"), null);
    assert.equal(group.querySelector(".oi-data-always").textContent, "始终包含");
    assert.equal(group.querySelector(".oi-data-always").closest(".set-actions") != null, true);
    const estimate = group.querySelector("#exportEstimate");
    assert.equal(estimate.getAttribute("role"), "status");
    assert.equal(estimate.getAttribute("aria-live"), "polite");
    assert.equal(estimate.textContent, `预计约 ${formatApproxBytes(sizes.base)}`);

    const sourceRow = source.closest(".set-row");
    sourceRow.querySelector("h3").click();
    const sourceAfter = exportGroupOf(host).querySelector("#exportIncSource");
    assert.equal(sourceAfter.getAttribute("aria-checked"), "true");
    assert.equal(sourceAfter.checked, true);
    assert.equal(document.activeElement, sourceAfter);
    assert.equal(exportGroupOf(host).querySelector("#exportEstimate"), estimate);
    assert.equal(estimate.textContent, `预计约 ${formatApproxBytes(sizes.base + sizes.sources)}`);
    exportGroupOf(host).querySelector("#exportIncTrash").click();
    assert.equal(exportGroupOf(host).querySelector("#exportIncTrash").getAttribute("aria-checked"), "true");
    assert.equal(estimate.textContent, `预计约 ${formatApproxBytes(sizes.base + sizes.sources + sizes.trash)}`);
    exportGroupOf(host).querySelector("#exportIncSource").click();
    assert.equal(exportGroupOf(host).querySelector("#exportIncSource").getAttribute("aria-checked"), "false");
    assert.equal(estimate.textContent, `预计约 ${formatApproxBytes(sizes.base + sizes.trash)}`);

    const flagged = libraryStore({ sourceSize: 4096, trashPad: 1500 });
    let downloaded = null;
    const exportHost = document.createElement("div");
    const exporting = mount(exportHost, flagged, {
      download: (_filename, _text, bundle) => {
        downloaded = bundle;
        return true;
      }
    });
    await exporting.reload();
    exportGroupOf(exportHost).querySelector("#exportIncSource").click();
    exportGroupOf(exportHost).querySelector("button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(downloaded);
    const includeCall = flagged.calls.find((call) => call?.exportedAt != null && call.include?.sources === true && call.include?.trash === false);
    assert.ok(includeCall, JSON.stringify(flagged.calls.filter((call) => call?.exportedAt)));
    assert.equal(includeCall.include.notes, true);
    assert.equal(includeCall.include.layouts, false);
    exportGroupOf(exportHost).querySelector("#exportIncTrash").click();
    exportGroupOf(exportHost).querySelector("button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const both = flagged.calls.find((call) => call?.exportedAt != null && call.include?.sources === true && call.include?.trash === true);
    assert.ok(both, JSON.stringify(flagged.calls.filter((call) => call?.exportedAt)));

    const emptyStore = libraryStore();
    const emptyHost = document.createElement("div");
    const emptyPanel = mount(emptyHost, emptyStore);
    await emptyPanel.reload();
    const emptyExport = exportGroupOf(emptyHost);
    assert.equal(emptyExport.querySelector("#exportIncSource"), null);
    assert.equal(emptyExport.querySelector("#exportIncTrash").disabled, true);
    assert.equal(emptyExport.querySelector("#exportIncTrashNote").textContent, "回收站是空的");
    assert.equal(emptyExport.querySelector("#exportEstimate").textContent, "预计 0 MB");
    assert.equal(emptyExport.querySelector("#exportIncTrash").getAttribute("aria-checked"), "false");

    const errorStore = libraryStore({ fail: true });
    const errorHost = document.createElement("div");
    const errorPanel = mount(errorHost, errorStore);
    await errorPanel.reload();
    const errorExport = exportGroupOf(errorHost);
    assert.match(errorExport.querySelector("#exportIncSourceNote").textContent, /大小未知 · 体积大，默认不带/);
    assert.match(errorExport.querySelector("#exportIncTrashNote").textContent, /大小未知/);
    assert.equal(errorExport.querySelector("#exportIncSource").disabled, false);
    assert.equal(errorExport.querySelector("#exportIncTrash").disabled, false);
    assert.equal(errorExport.querySelector("#exportEstimate").textContent, "预计 —");
    errorExport.querySelector("#exportIncSource").click();
    assert.equal(exportGroupOf(errorHost).querySelector("#exportIncSource").getAttribute("aria-checked"), "true");

    loadingPanel.destroy();
    panel.destroy();
    exporting.destroy();
    emptyPanel.destroy();
    errorPanel.destroy();
  } finally {
    restore();
  }
});

test("EXI-10 packing disables both switches and an empty trash row stays off", async () => {
  const restore = withDom();
  try {
    const store = libraryStore({ sourceSize: 2048, trashPad: 800 });
    let releaseDownload = () => {};
    const host = document.createElement("div");
    const panel = mount(host, store, {
      download: () => new Promise((resolve) => { releaseDownload = () => resolve(true); })
    });
    await panel.reload();
    const group = exportGroupOf(host);
    group.querySelector("#exportIncSource").click();
    group.querySelector("#exportIncTrash").click();
    exportGroupOf(host).querySelector("button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const packing = exportGroupOf(host);
    assert.equal(packing.querySelector("#exportIncSource").disabled, true);
    assert.equal(packing.querySelector("#exportIncTrash").disabled, true);
    assert.equal(packing.querySelector("#exportIncSource").getAttribute("aria-checked"), "true");
    releaseDownload();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(exportGroupOf(host).querySelector("#exportIncSource").disabled, false);
    const include = store.calls.filter((call) => call?.exportedAt != null).at(-1);
    assert.equal(include.include.sources, true);
    assert.equal(include.include.trash, true);
    panel.destroy();
  } finally {
    restore();
  }
});

const SHOT_MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
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
        "content-type": SHOT_MIME[extname(file)] || "application/octet-stream",
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
    "--window-size=1280,900",
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

const PAGE_STUB = `(() => {
  globalThis.chrome = {
    runtime: {
      id: "oi-set-polish",
      getManifest() { return { version: "0.3.0" }; },
      getURL(path) { return new URL(path, location.href).href; },
      sendMessage() {
        return Promise.resolve({
          ok: true,
          settings: {
            provider: "mymemory",
            sourceLang: "auto",
            targetLang: "zh-CN",
            batchSize: 8,
            pdfAutoTranslate: true,
            features: { pdf: true, webpage: true },
            providers: {},
            pdfLayout: { mode: "bilingual" }
          }
        });
      },
      onMessage: { addListener() {} }
    },
    storage: {
      local: {
        get() { return Promise.resolve({}); },
        set() { return Promise.resolve(); },
        remove() { return Promise.resolve(); }
      },
      sync: {
        get() { return Promise.resolve({}); },
        set() { return Promise.resolve(); }
      },
      onChanged: { addListener() {}, removeListener() {} }
    },
    tabs: { create() { return Promise.resolve(); } }
  };
})();`;

function near(actual, expected, slack, label) {
  assert.ok(Math.abs(actual - expected) <= slack, `${label}: ${actual} vs ${expected}`);
}

test("settings polish 2 computed style, keyboard, and screenshots", { timeout: 120000 }, async (t) => {
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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-set-polish-"));
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
  await send("DOM.enable");
  await send("Accessibility.enable");
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_STUB });
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true
    }, 30000);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description || detail.text || JSON.stringify(detail));
    }
    return result.result?.value;
  };
  const origin = `http://127.0.0.1:${handle.server.address().port}`;
  await send("Page.navigate", { url: `${origin}/options/options.html#data` });
  const started = Date.now();
  let ready = false;
  while (Date.now() - started < 20000) {
    ready = await evaluate(`(() => {
      const pdf = document.querySelector("[data-nav='pdf']");
      const panel = document.getElementById("panel-data");
      return !!(
        document.querySelector(".options-nav .brand h1")
        && document.getElementById("dataPanelMount")
        && pdf
        && pdf.tabIndex === -1
        && panel
        && panel.hidden === false
      );
    })()`);
    if (ready) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(ready, true);

  const navMeasure = await evaluate(`(() => {
    const nav = document.querySelector(".options-nav");
    const navBox = nav.getBoundingClientRect();
    const textLeft = (el) => {
      const range = document.createRange();
      const node = [...el.childNodes].find((item) => item.nodeType === 3 && item.textContent.trim()) || el;
      if (node.nodeType === 3) {
        range.setStart(node, 0);
        range.setEnd(node, node.textContent.length);
      } else range.selectNodeContents(node);
      return range.getBoundingClientRect().left - navBox.left;
    };
    const h1 = document.querySelector(".brand h1");
    const lead = document.querySelector(".brand .lead");
    const mark = document.querySelector(".brand .mark");
    const label = document.querySelector(".set-label");
    const button = document.querySelector("[data-nav='web']");
    const pdf = document.querySelector("[data-nav='pdf']");
    const search = document.querySelector("#setSearch");
    const shell = getComputedStyle(document.querySelector(".options-shell"));
    const main = getComputedStyle(document.querySelector(".set-main"));
    const searchStyle = getComputedStyle(search);
    const leadStyle = getComputedStyle(lead);
    const h1Style = getComputedStyle(h1);
    const markStyle = getComputedStyle(mark);
    const labelStyle = getComputedStyle(label);
    const buttonStyle = getComputedStyle(button);
    const selected = document.querySelector("[aria-selected='true']");
    const selectedStyle = getComputedStyle(selected);
    const markBox = mark.getBoundingClientRect();
    const h1Box = h1.getBoundingClientRect();
    const leadBox = lead.getBoundingClientRect();
    const webBox = button.getBoundingClientRect();
    const pdfBox = pdf.getBoundingClientRect();
    const searchBox = search.getBoundingClientRect();
    return {
      navWidth: navBox.width,
      shellGap: shell.columnGap,
      shellCols: shell.gridTemplateColumns,
      mainMax: main.maxWidth,
      h1Size: h1Style.fontSize,
      h1Line: h1Style.lineHeight,
      h1Weight: h1Style.fontWeight,
      leadSize: leadStyle.fontSize,
      leadLine: leadStyle.lineHeight,
      leadWrap: leadStyle.whiteSpace,
      leadOverflow: leadStyle.overflow,
      leadEllipsis: leadStyle.textOverflow,
      leadScroll: lead.scrollWidth,
      leadClient: lead.clientWidth,
      leadText: lead.textContent,
      markWidth: parseFloat(markStyle.width),
      markHeight: parseFloat(markStyle.height),
      markMid: (markBox.top + markBox.bottom) / 2,
      h1Mid: (h1Box.top + h1Box.bottom) / 2,
      h1Left: h1Box.left,
      leadLeft: leadBox.left,
      markLeft: markBox.left - navBox.left,
      labelLeft: textLeft(label),
      buttonLeft: textLeft(button),
      searchPad: parseFloat(searchStyle.paddingLeft),
      searchText: searchBox.left - navBox.left + parseFloat(searchStyle.paddingLeft),
      searchH: parseFloat(searchStyle.height),
      searchRadius: searchStyle.borderRadius,
      searchIcon: searchStyle.backgroundImage.includes("svg") || searchStyle.backgroundImage.includes("data:"),
      searchIconSize: searchStyle.backgroundSize,
      itemH: parseFloat(buttonStyle.height),
      itemGap: pdfBox.top - webBox.bottom,
      labelTop: parseFloat(labelStyle.marginTop),
      labelBottom: parseFloat(labelStyle.marginBottom),
      labelSize: labelStyle.fontSize,
      labelWeight: labelStyle.fontWeight,
      selectedWeight: selectedStyle.fontWeight,
      selectedBg: selectedStyle.backgroundColor,
      itemColor: buttonStyle.color,
      focusOffset: getComputedStyle(button).outlineOffset
    };
  })()`);
  near(navMeasure.navWidth, 232, 1, "NAV-07 width");
  assert.equal(navMeasure.shellGap, "32px");
  assert.match(navMeasure.shellCols, /^232px/);
  assert.equal(navMeasure.mainMax, "720px");
  assert.equal(navMeasure.h1Size, "20px");
  assert.equal(navMeasure.h1Line, "28px");
  assert.equal(String(navMeasure.h1Weight), "650");
  assert.equal(navMeasure.leadSize, "12px");
  assert.equal(navMeasure.leadLine, "16px");
  assert.equal(navMeasure.leadWrap, "nowrap");
  assert.notEqual(navMeasure.leadEllipsis, "ellipsis");
  assert.equal(navMeasure.leadText, "Open Immerse · 设置");
  assert.ok(navMeasure.leadScroll <= navMeasure.leadClient + 1, `NAV-04 ${navMeasure.leadScroll} > ${navMeasure.leadClient}`);
  near(navMeasure.markWidth, 18, 0.5, "NAV-03 icon");
  near(navMeasure.markMid, navMeasure.h1Mid, 1, "NAV-03 center");
  near(navMeasure.h1Left, navMeasure.leadLeft, 1, "NAV-03 edges");
  near(navMeasure.labelLeft, 20, 1, "NAV-06 label");
  near(navMeasure.buttonLeft, 20, 1, "NAV-06 item");
  near(navMeasure.markLeft, 20, 1, "NAV-06 brand icon");
  near(navMeasure.labelLeft, navMeasure.buttonLeft, 1, "NAV-06 label/item");
  assert.equal(navMeasure.searchPad, 28);
  assert.equal(navMeasure.searchH, 28);
  assert.equal(navMeasure.searchIcon, true);
  assert.match(navMeasure.searchIconSize, /14px/);
  assert.equal(navMeasure.itemH, 30);
  near(navMeasure.itemGap, 2, 1, "NAV-08 gap");
  assert.equal(navMeasure.labelTop, 20);
  assert.equal(navMeasure.labelBottom, 4);
  assert.equal(navMeasure.labelSize, "11px");
  assert.equal(String(navMeasure.labelWeight), "600");
  assert.equal(String(navMeasure.selectedWeight), "600");
  assert.match(navMeasure.selectedBg, /rgba\(34,\s*32,\s*28,\s*0?\.0/);

  const hover = await evaluate(`(() => {
    const button = document.querySelector("[data-nav='web']");
    const box = button.getBoundingClientRect();
    return { x: box.x + 12, y: box.y + 10, before: getComputedStyle(button).backgroundColor };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: hover.x, y: hover.y });
  const hovered = await evaluate(`(() => {
    const button = document.querySelector("[data-nav='web']");
    const style = getComputedStyle(button);
    const text = getComputedStyle(document.body).getPropertyValue("--oi-text").trim();
    const probe = document.createElement("span");
    probe.style.color = text;
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { bg: style.backgroundColor, color: style.color, expected };
  })()`);
  assert.match(hovered.bg, /rgba\(34,\s*32,\s*28,\s*0?\.0/);
  assert.equal(hovered.color, hovered.expected);

  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await evaluate(`document.querySelector("[data-nav='translate']").focus()`);
  for (let step = 0; step < 3; step += 1) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 });
  }
  const navFocus = await evaluate(`(() => {
    const button = document.activeElement;
    const style = getComputedStyle(button);
    const nav = document.querySelector(".options-nav").getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return {
      nav: button?.dataset?.nav || "",
      width: style.outlineWidth,
      style: style.outlineStyle,
      offset: style.outlineOffset,
      inside: box.left >= nav.left - 1 && box.right <= nav.right + 1 && box.top >= nav.top - 1
    };
  })()`);
  assert.equal(navFocus.nav, "pdf");
  assert.equal(navFocus.width, "2px");
  assert.equal(navFocus.style, "solid");
  assert.equal(navFocus.offset, "-2px");
  assert.equal(navFocus.inside, true);

  const axName = async (selector) => {
    const doc = await send("DOM.getDocument");
    const { nodeId } = await send("DOM.querySelector", { nodeId: doc.root.nodeId, selector });
    const tree = await send("Accessibility.getPartialAXTree", { nodeId, fetchRelatives: false });
    return tree.nodes?.[0]?.name?.value || "";
  };
  await evaluate(`document.querySelector("[data-badge='translate']").hidden = false`);
  const shownName = await axName("[data-nav='translate']");
  assert.equal(shownName.replace(/\s/g, ""), "翻译，需处理");
  const badgeStyle = await evaluate(`(() => {
    const badge = document.querySelector("[data-badge='data']");
    badge.hidden = false;
    const button = badge.parentElement;
    const style = getComputedStyle(badge);
    const selected = getComputedStyle(button);
    const probe = document.createElement("span");
    probe.style.color = "var(--oi-warn)";
    probe.style.background = "var(--oi-warn-soft)";
    document.body.append(probe);
    const paint = getComputedStyle(probe);
    const warn = paint.color;
    const warnSoft = paint.backgroundColor;
    probe.remove();
    const badgeBox = badge.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    return {
      parent: button.dataset.nav,
      selected: button.getAttribute("aria-selected"),
      size: style.fontSize,
      weight: String(style.fontWeight),
      wrap: style.whiteSpace,
      color: style.color,
      bg: style.backgroundColor,
      warn,
      warnSoft,
      selectedBg: selected.backgroundColor,
      inside: badgeBox.left >= buttonBox.left - 1 && badgeBox.right <= buttonBox.right + 1,
      margin: style.marginLeft,
      rightGap: buttonBox.right - badgeBox.right
    };
  })()`);
  assert.equal(badgeStyle.parent, "data");
  assert.equal(badgeStyle.selected, "true");
  assert.equal(badgeStyle.size, "11px");
  assert.equal(badgeStyle.weight, "500");
  assert.equal(badgeStyle.wrap, "nowrap");
  assert.equal(badgeStyle.color, badgeStyle.warn);
  assert.equal(badgeStyle.bg, badgeStyle.warnSoft);
  assert.equal(badgeStyle.inside, true);
  assert.ok(badgeStyle.margin === "auto" || badgeStyle.rightGap <= 12, `NAV-10 align ${badgeStyle.margin} gap ${badgeStyle.rightGap}`);
  assert.notEqual(badgeStyle.selectedBg, "rgba(0, 0, 0, 0)");
  await evaluate(`document.querySelector("[data-badge='translate']").hidden = true; document.querySelector("[data-badge='data']").hidden = true`);
  const hiddenName = await axName("[data-nav='translate']");
  assert.equal(hiddenName.replace(/\s/g, ""), "翻译");

  const searchFocus = await evaluate(`(() => {
    const search = document.querySelector("#setSearch");
    search.focus();
    const style = getComputedStyle(search);
    const placeholder = getComputedStyle(search, "::placeholder");
    return { h: parseFloat(style.height), radius: style.borderRadius, placeholder: placeholder.fontSize, placeholderColor: placeholder.color };
  })()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await evaluate(`document.querySelector("#setSearch").focus()`);
  const searchRing = await evaluate(`(() => {
    const search = document.querySelector("#setSearch");
    const style = getComputedStyle(search);
    return { width: style.outlineWidth, style: style.outlineStyle, offset: style.outlineOffset };
  })()`);
  assert.equal(searchFocus.h, 28);
  assert.equal(searchFocus.placeholder, "13px");
  assert.equal(searchRing.width, "2px");
  assert.equal(searchRing.style, "solid");

  await evaluate(`document.querySelector("#setSearch").value = "引擎"; document.querySelector("#setSearch").dispatchEvent(new Event("input", { bubbles: true }));`);
  const searchWidths = await evaluate(`(() => {
    const search = document.querySelector("#setSearch");
    const results = document.querySelector("#setResults");
    const a = search.getBoundingClientRect();
    const b = results.getBoundingClientRect();
    return { hidden: results.hidden, search: a.width, results: b.width, radius: getComputedStyle(results).borderRadius };
  })()`);
  assert.equal(searchWidths.hidden, false);
  near(searchWidths.search, searchWidths.results, 1, "NAV-12 width");
  assert.equal(searchWidths.radius, "7px");

  const mounted = await evaluate(`(async () => {
    const mod = await import(new URL("./data-panel.js", location.href).href);
    const old = document.getElementById("dataPanelMount");
    const fresh = document.createElement("div");
    fresh.id = "polishExport";
    old.replaceWith(fresh);
    let release;
    const held = new Promise((done) => { release = done; });
    let opened = false;
    const store = {
      async listPapers() {
        if (!opened) { await held; opened = true; }
        return [{ sourceSize: Math.round(7.55 * 1024 * 1024) }];
      },
      async exportLibrary(options) {
        const include = options && options.include || {};
        return { papers: [{ notes: ["n"], extra: include.trash ? "t".repeat(12000) : "" }] };
      },
      subscribe() { return () => {}; }
    };
    const panel = mod.mountDataPanel(fresh, {
      store,
      coordinator: { state: () => ({ phase: "idle" }), subscribe() { return () => {}; }, attach() {}, detach() {}, destroy() {}, errorsForExport() { return []; } },
      usage: async () => ({ usage: 20, quota: 100, persisted: true }),
      width: () => 800
    });
    const group = fresh.querySelector("[data-focus-group='export']");
    const before = group.querySelector("#exportIncTrash").closest(".set-row").getBoundingClientRect().height;
    const skel = getComputedStyle(group.querySelector(".oi-data-skel"));
    const skelW = skel.width;
    const skelH = skel.height;
    const skelR = skel.borderRadius;
    release();
    await panel.reload();
    const afterRow = fresh.querySelector("#exportIncTrash").closest(".set-row");
    const after = afterRow.getBoundingClientRect().height;
    return { before, after, skelW, skelH, skelR };
  })()`);
  near(mounted.before, mounted.after, 2, "EXI-11 layout");
  assert.equal(mounted.skelW, "56px");
  assert.equal(mounted.skelH, "10px");
  assert.equal(mounted.skelR, "5px");

  const exi = await evaluate(`(() => {
    const group = document.querySelector("#polishExport [data-focus-group='export']");
    const source = group.querySelector("#exportIncSource");
    const trash = group.querySelector("#exportIncTrash");
    const always = group.querySelector(".oi-data-always");
    const row = source.closest(".set-row");
    const rowStyle = getComputedStyle(row);
    const groupStyle = getComputedStyle(group);
    const sourceStyle = getComputedStyle(source);
    const knob = getComputedStyle(source, "::before");
    const num = group.querySelector("#exportIncSourceNote .set-num");
    const numStyle = getComputedStyle(num);
    const alwaysStyle = getComputedStyle(always);
    const rights = [always, source, trash].map((node) => node.getBoundingClientRect().right);
    const probe = document.createElement("span");
    probe.style.color = "var(--oi-text-muted)";
    document.body.append(probe);
    const muted = getComputedStyle(probe).color;
    probe.remove();
    const other = document.querySelector("[data-focus='backup'] .set-row");
    const otherStyle = other ? getComputedStyle(other) : null;
    return {
      role: source.getAttribute("role"),
      bare: group.querySelectorAll("input:not([role='switch'])").length,
      width: sourceStyle.width,
      height: sourceStyle.height,
      appearance: sourceStyle.appearance,
      knob: knob.width,
      rights,
      num: num.textContent,
      note: group.querySelector("#exportIncSourceNote").textContent,
      tabular: numStyle.fontVariantNumeric,
      plus: group.textContent.includes("+"),
      always: always.textContent,
      alwaysSize: alwaysStyle.fontSize,
      alwaysColor: alwaysStyle.color,
      muted,
      chip: !!group.querySelector(".oi-data-chip"),
      minH: rowStyle.minHeight,
      pad: [rowStyle.paddingTop, rowStyle.paddingRight, rowStyle.paddingBottom, rowStyle.paddingLeft],
      shadow: groupStyle.boxShadow,
      otherPad: otherStyle ? [otherStyle.paddingTop, otherStyle.paddingRight, otherStyle.paddingBottom, otherStyle.paddingLeft] : null,
      otherMin: otherStyle ? otherStyle.minHeight : "",
      otherShadow: otherStyle ? getComputedStyle(other.parentElement).boxShadow : ""
    };
  })()`);
  assert.equal(exi.role, "switch");
  assert.equal(exi.bare, 0);
  assert.equal(exi.width, "36px");
  assert.equal(exi.height, "20px");
  assert.equal(exi.appearance, "none");
  assert.equal(exi.knob, "16px");
  near(Math.max(...exi.rights), Math.min(...exi.rights), 1, "EXI-03");
  assert.match(exi.note, /^约 .+ · 体积大，默认不带$/);
  assert.match(exi.tabular, /tabular-nums/);
  assert.equal(exi.plus, false);
  assert.equal(exi.always, "始终包含");
  assert.equal(exi.alwaysSize, "12px");
  assert.equal(exi.alwaysColor, exi.muted);
  assert.equal(exi.chip, false);
  assert.equal(exi.minH, "44px");
  assert.deepEqual(exi.pad, ["8px", "16px", "8px", "16px"]);
  assert.equal(exi.shadow, "none");
  assert.deepEqual(exi.otherPad, exi.pad);
  assert.equal(exi.otherMin, "44px");
  assert.equal(exi.otherShadow, "none");

  const mouse = await evaluate(`(() => {
    const source = document.querySelector("#exportIncSource");
    source.scrollIntoView({ block: "center", inline: "nearest" });
    const box = source.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: mouse.x, y: mouse.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: mouse.x, y: mouse.y, button: "left", clickCount: 1 });
  const mouseFocus = await evaluate(`(() => {
    const source = document.querySelector("#exportIncSource");
    const style = getComputedStyle(source);
    return { id: document.activeElement && document.activeElement.id, checked: source.getAttribute("aria-checked"), width: style.outlineWidth, style: style.outlineStyle };
  })()`);
  assert.equal(mouseFocus.id, "exportIncSource");
  assert.equal(mouseFocus.checked, "true");
  assert.equal(mouseFocus.style, "none");

  await evaluate(`document.querySelector("#exportIncSource").focus()`);
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
  const keyFocus = await evaluate(`(() => {
    const source = document.querySelector("#exportIncSource");
    const style = getComputedStyle(source);
    const probe = document.createElement("span");
    probe.style.color = "var(--oi-focus)";
    document.body.append(probe);
    const focus = getComputedStyle(probe).color;
    probe.remove();
    return {
      id: document.activeElement && document.activeElement.id,
      checked: source.getAttribute("aria-checked"),
      width: style.outlineWidth,
      line: style.outlineStyle,
      offset: style.outlineOffset,
      color: style.outlineColor,
      focus
    };
  })()`);
  assert.equal(keyFocus.id, "exportIncSource");
  assert.equal(keyFocus.checked, "false");
  assert.equal(keyFocus.width, "2px");
  assert.equal(keyFocus.line, "solid");
  assert.equal(keyFocus.offset, "2px");
  assert.equal(keyFocus.color, keyFocus.focus);

  mkdirSync(SHOT_DIR, { recursive: true });
  const clipOf = async (selector) => evaluate(`(() => {
    window.scrollTo(0, 0);
    const node = document.querySelector(${JSON.stringify(selector)});
    const box = node.getBoundingClientRect();
    return {
      x: Math.max(0, Math.floor(box.x + window.scrollX) - 8),
      y: Math.max(0, Math.floor(box.y + window.scrollY) - 8),
      width: Math.min(Math.ceil(box.width) + 16, 1200),
      height: Math.min(Math.ceil(box.height) + 16, 1600)
    };
  })()`);
  const saveShot = async (name, selector) => {
    const clip = await clipOf(selector);
    const { data } = await send("Page.captureScreenshot", {
      format: "png",
      clip: { ...clip, scale: 1 },
      captureBeyondViewport: true
    });
    const file = join(SHOT_DIR, name);
    writeFileSync(file, Buffer.from(data, "base64"));
    assert.ok(statSync(file).size > 1000, name);
    return file;
  };
  await evaluate(`(() => {
    const search = document.querySelector("#setSearch");
    search.value = "";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    window.scrollTo(0, 0);
    document.querySelector("[data-nav='pdf']").focus();
  })()`);
  const sidebarShot = await saveShot("sidebar.png", ".options-nav");
  const focusNavShot = await saveShot("sidebar-focus.png", ".options-nav");
  await evaluate(`document.querySelector("[data-badge='translate']").hidden = false`);
  const badgeShot = await saveShot("sidebar-badge.png", ".options-nav");
  await evaluate(`document.querySelector("[data-badge='translate']").hidden = true`);
  await evaluate(`(() => {
    const source = document.querySelector("#exportIncSource");
    const trash = document.querySelector("#exportIncTrash");
    if (source.checked) source.click();
    if (trash.checked) trash.click();
  })()`);
  const offShot = await saveShot("export-off.png", "#polishExport [data-focus-group='export']");
  await evaluate(`(() => {
    const source = document.querySelector("#exportIncSource");
    if (!source.checked) source.click();
  })()`);
  await evaluate(`(() => {
    const trash = document.querySelector("#exportIncTrash");
    if (!trash.checked) trash.click();
  })()`);
  const onShot = await saveShot("export-on.png", "#polishExport [data-focus-group='export']");
  await evaluate(`document.querySelector("#exportIncSource").focus()`);
  const focusSwitchShot = await saveShot("export-focus.png", "#polishExport [data-focus-group='export']");

  await send("Emulation.setDeviceMetricsOverride", { width: 480, height: 900, deviceScaleFactor: 1, mobile: false });
  const narrow = await evaluate(`(() => {
    const row = document.querySelector("#exportIncSource").closest(".set-row");
    const style = getComputedStyle(row);
    const num = getComputedStyle(document.querySelector("#exportIncSourceNote .set-num"));
    const nav = getComputedStyle(document.querySelector(".options-nav"));
    const top = getComputedStyle(document.querySelector(".set-topbar"));
    return {
      dir: style.flexDirection,
      wrap: num.whiteSpace,
      nav: nav.display,
      top: top.display
    };
  })()`);
  assert.equal(narrow.dir, "row");
  assert.equal(narrow.wrap, "nowrap");
  assert.equal(narrow.nav, "none");
  assert.equal(narrow.top, "flex");
  await send("Emulation.clearDeviceMetricsOverride");

  await evaluate(`document.querySelector("[data-nav='about']").click()`);
  const learning = await evaluate(`document.querySelector("#panel-about a[href*='learning.html']").href`);
  assert.match(learning, /learning\/learning\.html$/);
  await evaluate(`document.querySelector("#panel-about a[href*='learning.html']").click()`);
  const learnStarted = Date.now();
  let learnUrl = "";
  while (Date.now() - learnStarted < 8000) {
    learnUrl = await evaluate(`location.pathname`);
    if (learnUrl.includes("learning.html")) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.match(learnUrl, /learning\.html$/);
  await send("Page.navigate", { url: `${origin}/options/options.html#about` });
  const back = Date.now();
  let aboutReady = false;
  while (Date.now() - back < 8000) {
    aboutReady = await evaluate(`!!document.querySelector("#panel-about a[href*='documents.html']")`);
    if (aboutReady) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.equal(aboutReady, true);
  await evaluate(`document.querySelector("#panel-about a[href*='documents.html']").click()`);
  const docStarted = Date.now();
  let docUrl = "";
  while (Date.now() - docStarted < 8000) {
    docUrl = await evaluate(`location.pathname`);
    if (docUrl.includes("documents.html")) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.match(docUrl, /documents\.html$/);
  assert.ok(sidebarShot && focusNavShot && badgeShot && offShot && onShot && focusSwitchShot);
});
