import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import { cleanupChrome } from "./helpers/chrome-cleanup.mjs";
import { installOwnedTmpGuard, rememberOwnedTemp } from "./helpers/owned-tmp.mjs";

import { DEFAULT_SETTINGS, migrateSettings } from "../lib/storage.js";
import { DEFAULT_FEATURES } from "../lib/features.js";
import { mountDataPanel } from "../options/data-panel.js";
import {
  PDF_DEFAULT_NOTICE_COPY,
  PDF_DEFAULT_NOTICE_KEY,
  dismissPdfDefaultNotice,
  pdfDefaultNoticeVisible,
  readPdfDefaultNoticeSeen,
  writePdfDefaultNoticeSeen
} from "../lib/pdf-default-notice.js";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const PDF_OFF_PREFIXES = ["oi-pdf-off-", "com.google.Chrome.", ".com.google.Chrome."];
installOwnedTmpGuard(PDF_OFF_PREFIXES);

test("settings html drops the empty data section and the duplicate privacy sentence", () => {
  const html = read("options/options.html");
  const panel = read("options/data-panel.js");
  assert.equal(html.includes('<section id="data"'), false);
  assert.equal(html.split("API 密钥永远不导出").length - 1, 1);
  assert.equal(panel.includes("API 密钥永远不导出"), false);
  const pdf = html.slice(html.indexOf('id="panel-pdf"'), html.indexOf('id="panel-notes"'));
  assert.ok(pdf.indexOf('id="pdfFeatureList"') < pdf.indexOf('id="pdfAutoTranslate"'));
  const list = pdf.slice(pdf.indexOf('id="pdfFeatureList"'), pdf.indexOf('id="pdfAutoTranslate"'));
  const firstRow = list.slice(list.indexOf('<div class="set-row">'), list.indexOf('id="pdfOnNotice"'));
  assert.match(firstRow, /在浏览器里打开 PDF 时，用沉浸译的双栏阅读器显示原文和译文。/);
  assert.match(firstRow, /id="pdfEnabled"[^>]*role="switch"/);
  assert.match(firstRow, /aria-labelledby="pdfEnabledLabel"/);
  assert.match(firstRow, /aria-describedby="pdfEnabledNote"/);
  assert.ok(list.indexOf('id="pdfEnabled"') < list.indexOf('id="pdfOnNotice"'));
  assert.match(list, /id="pdfOnNotice" class="set-banner"/);
  assert.ok(list.includes(PDF_DEFAULT_NOTICE_COPY));
  assert.match(list, /id="pdfOnNoticeOff" class="set-inline">关闭 PDF 阅读/);
  assert.match(list, /id="pdfOnNoticeDismiss" class="btn-secondary">知道了/);
  assert.match(html, /PDF 阅读已关闭 · <button type="button" id="mmEnablePdf" class="set-inline">去开启<\/button>/);
  assert.doesNotMatch(html, /PDF 阅读还没开启/);
  assert.doesNotMatch(html, /在实验室里还没开启/);
  const about = html.slice(html.indexOf('id="panel-about"'));
  const versionAt = about.indexOf('id="aboutVersionHeading"');
  const diagAt = about.indexOf('id="diagHeading"');
  const groupAt = about.indexOf('id="diagGroup"');
  assert.match(about, /<h3 class="set-gh" id="aboutVersionHeading">版本<\/h3>/);
  assert.match(about, /<h3 class="set-gh" id="diagHeading">问题诊断<\/h3>/);
  assert.ok(versionAt > 0 && versionAt < diagAt && diagAt < groupAt);
  assert.equal(about.slice(diagAt, groupAt).includes("diag-heading"), false);
  const viewer = read("pdf/viewer.html");
  assert.match(viewer, /id="pdfDefaultNotice" class="oi-reader-notice"/);
  assert.match(viewer, /id="pdfDefaultNoticeSettings" href="\.\.\/options\/options\.html#pdf">设置 › PDF 阅读<\/a> 里关闭。/);
  assert.equal(viewer.includes(PDF_DEFAULT_NOTICE_COPY), false);
  assert.equal(viewer.includes("在这里关闭"), false);
  assert.match(viewer, /id="pdfDefaultNoticeDismiss" class="btn-secondary">知道了/);
  assert.equal(viewer.includes("关闭 PDF 阅读"), false);
  const readerCss = read("pdf/viewer.css");
  assert.match(readerCss, /\.oi-reader-notice \{[^}]*var\(--oi-reader-line\)/s);
  assert.match(readerCss, /\.oi-reader-notice\[hidden\] \{\s*display:\s*none/);
  assert.equal(readerCss.includes("--set-"), false);
});

test("settings cards use flat --set-* tokens and multimodal cards do not use reader tokens", () => {
  const css = read("options/options.css");
  const manifest = read("manifest.json");
  assert.match(css, /--set-card-border:\s*1px solid var\(--oi-line\)/);
  assert.match(css, /--set-card-radius:\s*10px/);
  assert.match(css, /--set-card-pad:\s*8px 16px/);
  assert.match(css, /--set-card-gap:\s*16px/);
  assert.match(css, /--set-ctl-h:\s*28px/);
  assert.equal(css.includes("--set-border"), false);
  assert.equal(css.includes("--set-radius:"), false);
  assert.equal(css.includes("--set-row-pad"), false);
  assert.equal(css.includes("--set-group-gap"), false);
  assert.match(css, /body\.oi-settings section \{\s*box-shadow:\s*none/);
  assert.match(css, /body\.oi-settings \.set-group \{[^}]*box-shadow:\s*none/s);
  assert.match(css, /body\.oi-settings \.set-group \{[^}]*border:\s*var\(--set-card-border\)/s);
  assert.match(css, /body\.oi-settings \.set-group \+ \.set-group \{\s*margin-top:\s*var\(--set-card-gap\)/);
  assert.match(css, /body\.oi-settings \.set-group \+ \.hint \{[^}]*margin:\s*8px 4px 0/s);
  assert.match(css, /body\.oi-settings \.set-ctl button \{[^}]*height:\s*var\(--set-ctl-h\)/s);
  assert.match(css, /body\.oi-settings \.set-ctl a \{[^}]*color:\s*var\(--oi-accent\)/s);
  assert.match(css, /\.set-row\[aria-disabled="true"\] \{\s*opacity:\s*0\.5/);
  assert.match(css, /\.set-row\[aria-disabled="true"\] \.set-title/);
  assert.match(css, /\.set-row\[aria-disabled="true"\] \.set-note \{\s*color:\s*var\(--oi-text-muted\)/);
  assert.match(css, /\.set-row\[aria-disabled="true"\] > input\[role="switch"\]:checked/);
  assert.match(css, /\.set-row\[aria-disabled="true"\] > input\[role="switch"\]:disabled \{[^}]*background:\s*var\(--oi-line-strong\)/s);
  assert.match(css, /\.set-row\[aria-disabled="true"\] :is\(input, select, textarea, button\) \{\s*opacity:\s*1/);
  assert.match(css, /padding:\s*var\(--set-card-pad\)/);
  assert.equal(css.includes("--oi-reader-"), false);
  assert.match(css, /\.oi-set-card \{[^}]*border:\s*var\(--set-card-border\)/s);
  assert.match(css, /\.oi-set-card \{[^}]*box-shadow:\s*none/s);
  const dataCss = read("options/data-panel.css");
  assert.match(dataCss, /\[data-persist-ask\] \{[^}]*white-space:\s*nowrap/s);
  assert.equal(dataCss.includes("8.5em"), false);
  assert.match(dataCss, /a\.oi-data-browse,\s*\n\.oi-data a\.oi-data-browse:visited \{[^}]*color:\s*var\(--oi-text-muted\)/s);
  assert.match(dataCss, /a\.oi-data-browse:hover \{[^}]*text-decoration:\s*underline/s);
  assert.match(dataCss, /a\.oi-data-browse:focus-visible \{[^}]*outline:\s*2px solid var\(--oi-focus\)/s);
  assert.match(css, /\.set-key-line \{[^}]*display:\s*flex/s);
  assert.equal(manifest.includes("unlimitedStorage"), false);
});

test("translation key actions sit on one line beside the input", () => {
  const js = read("options/options.js");
  assert.match(js, /line\.className = "set-key-line"/);
  assert.match(js, /line\.append\(input, toggle, remove, saved\)/);
  assert.equal(js.includes("renderPdfFeature"), false);
  assert.equal(js.includes('FEATURES.filter((feat) => feat.id === "pdf")'), false);
  assert.match(js, /const PDF_ON_NOTE = "在浏览器里打开 PDF 时，用沉浸译的双栏阅读器显示原文和译文。"/);
  assert.match(js, /const PDF_OFF_NOTE = "已关闭。PDF 会用浏览器自带的查看器打开。"/);
  assert.match(read("options/data-panel.js"), /persistLockWidth = Math\.ceil\(measured\) \+ 18/);
  assert.match(read("docs/settings-spec.md"), /「版面识别」组置灰/);
  assert.match(js, /row\.setAttribute\("aria-disabled", on \? "false" : "true"\)/);
  assert.match(js, /control\.disabled = !on/);
  assert.match(js, /el\("mmEnablePdf"\)\?\.addEventListener\("click", \(\) => \{\s*showPage\("pdf"\);\s*el\("pdfEnabled"\)\?\.focus\(\);/s);
  assert.equal(js.includes("pdfFeatureNotice"), false);
  const viewer = read("pdf/viewer.js");
  assert.match(viewer, /tabs\.create\(\{ url: `\$\{base\}#pdf` \}\)/);
  assert.match(viewer, /void maybeShowPdfDefaultNotice\(\)/);
  assert.match(viewer, /dismissReaderPdfNotice\("ack"\)/);
  assert.match(js, /dismissPdfNotice\("ack"\)/);
  assert.match(js, /dismissPdfNotice\("off"\)/);
  assert.match(js, /dismissPdfDefaultNotice\("seen"/);
  assert.match(viewer, /dismissPdfDefaultNotice\("seen"/);
  assert.match(js, /PDF_DEFAULT_NOTICE_KEY/);
  assert.match(viewer, /PDF_DEFAULT_NOTICE_KEY/);
});

const FLIP_AT = 1_700_000_000_000;

test("migration flips a stored pdf=false once and leaves a later off choice alone", () => {
  const storedOff = { settingsVersion: 8, features: { pdf: false, webpage: true } };
  const mergedOff = {
    ...DEFAULT_SETTINGS,
    ...storedOff,
    features: { ...DEFAULT_FEATURES, ...storedOff.features }
  };
  const flipped = migrateSettings(mergedOff, storedOff, FLIP_AT);
  assert.equal(flipped.changed, true);
  assert.equal(flipped.settings.features.pdf, true);
  assert.equal(flipped.settings.migrationNotes.pdfFlippedAt, FLIP_AT);
  assert.equal(flipped.settings.settingsVersion, 9);
  assert.equal(flipped.settings.pdfFeatureNotice, undefined);
  assert.equal(pdfDefaultNoticeVisible(flipped.settings, null), true);

  const keptOn = migrateSettings(
    { ...DEFAULT_SETTINGS, settingsVersion: 8, features: { ...DEFAULT_FEATURES, pdf: true } },
    { settingsVersion: 8, features: { pdf: true } },
    FLIP_AT
  );
  assert.equal(keptOn.settings.features.pdf, true);
  assert.equal(keptOn.settings.migrationNotes, undefined);
  assert.equal(pdfDefaultNoticeVisible(keptOn.settings, null), false);

  const missing = migrateSettings(
    { ...DEFAULT_SETTINGS, settingsVersion: 8, features: { ...DEFAULT_FEATURES, webpage: true } },
    { settingsVersion: 8, features: { webpage: true } },
    FLIP_AT
  );
  assert.equal(missing.settings.features.pdf, true);
  assert.equal(missing.settings.migrationNotes, undefined);
  assert.equal(pdfDefaultNoticeVisible(missing.settings, null), false);

  const fresh = migrateSettings({ ...DEFAULT_SETTINGS }, {}, FLIP_AT);
  assert.equal(fresh.settings.features.pdf, true);
  assert.equal(fresh.settings.migrationNotes, undefined);
  assert.equal(pdfDefaultNoticeVisible(fresh.settings, null), false);

  const choice = migrateSettings(
    { ...flipped.settings, features: { ...flipped.settings.features, pdf: false } },
    { ...flipped.settings, features: { ...flipped.settings.features, pdf: false } },
    FLIP_AT + 50
  );
  assert.equal(choice.changed, false);
  assert.equal(choice.settings.features.pdf, false);
  assert.equal(choice.settings.migrationNotes.pdfFlippedAt, FLIP_AT);
});

test("pdf default-on notice dismisses forever from either place", async () => {
  const settings = { features: { pdf: true }, migrationNotes: { pdfFlippedAt: FLIP_AT } };
  assert.equal(pdfDefaultNoticeVisible(settings, null), true);
  assert.equal(pdfDefaultNoticeVisible(settings, {}), true);
  assert.equal(pdfDefaultNoticeVisible({ features: { pdf: true } }, null), false);
  assert.equal(dismissPdfDefaultNotice("later", FLIP_AT), null);

  const mem = {};
  const area = {
    async get(key) { return { [key]: mem[key] }; },
    async set(patch) { Object.assign(mem, patch); }
  };
  for (const reason of ["ack", "off", "seen"]) {
    const record = dismissPdfDefaultNotice(reason, FLIP_AT + 1);
    assert.deepEqual(record, { seenAt: FLIP_AT + 1 });
    assert.equal(pdfDefaultNoticeVisible(settings, record), false);
    await writePdfDefaultNoticeSeen(area, record);
  }
  assert.deepEqual(mem[PDF_DEFAULT_NOTICE_KEY], { seenAt: FLIP_AT + 1 });
  assert.deepEqual(await readPdfDefaultNoticeSeen(area), { seenAt: FLIP_AT + 1 });
  assert.equal(pdfDefaultNoticeVisible(settings, await readPdfDefaultNoticeSeen(area)), false);
  assert.equal(PDF_DEFAULT_NOTICE_KEY, "oi.notice.pdfDefaultOn");
});

function quietCoordinator() {
  return {
    state: () => ({ phase: "idle" }),
    subscribe() { return () => {}; },
    attach() {},
    detach() {},
    destroy() {},
    importFolder() {},
    importBundle() {},
    pause() {},
    resume() {},
    allow() {},
    later() {},
    abandon() {},
    retry() {},
    errorsForExport() { return []; }
  };
}

function panelStore() {
  return {
    retryPersist: async () => false,
    subscribe() { return () => {}; },
    migrationStatus: async () => null,
    listPapers: async () => [],
    exportLibrary: async () => ({ papers: [] }),
    readImportMeta: async () => null
  };
}

function installDom() {
  const nodes = new Map();
  function createElement(tag) {
    const node = {
      tag,
      className: "",
      attrs: {},
      children: [],
      textContent: "",
      disabled: false,
    offsetWidth: tag === "button" ? 120 : 0,
    style: {},
    listeners: {},
    classList: {
      add() {},
      toggle() {},
      contains() { return false; }
    },
    setAttribute(name, value) { node.attrs[name] = String(value); },
    getAttribute(name) { return node.attrs[name]; },
    addEventListener(type, fn) {
      node.listeners[type] = node.listeners[type] || [];
      node.listeners[type].push(fn);
    },
    click() {
      for (const fn of node.listeners.click || []) fn({ preventDefault() {} });
    },
    append(...kids) {
      for (const kid of kids) if (kid) node.children.push(kid);
    },
    replaceChildren(...kids) {
      node.children = kids.filter(Boolean);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    focus() { document.activeElement = node; }
  };
    Object.defineProperty(node, "textContent", {
      get() {
        return node._text || node.children.map((kid) => kid.textContent || "").join("");
      },
      set(value) { node._text = String(value); }
    });
    nodes.set(node, true);
    return node;
  }
  const previous = globalThis.document;
  globalThis.document = { createElement, activeElement: null };
  return () => { globalThis.document = previous; };
}

function click(root, label) {
  const buttons = [];
  const walk = (node) => {
    if (!node) return;
    if (node.tag === "button" && String(node.textContent).includes(label)) buttons.push(node);
    for (const kid of node.children || []) walk(kid);
  };
  walk(root);
  assert.equal(buttons.length > 0, true, label);
  const button = buttons[0];
  button.click?.();
  return button;
}

function stateOf(root) {
  const found = [];
  const walk = (node) => {
    if (!node) return;
    if (node.attrs?.["data-persist-state"]) found.push(node);
    for (const kid of node.children || []) walk(kid);
  };
  walk(root);
  return found[0];
}

test("long-term storage reports inline and does not toast", async () => {
  const restore = installDom();
  try {
    const off = document.createElement("div");
    let pending;
    const asking = mountDataPanel(off, {
      store: panelStore(),
      coordinator: quietCoordinator(),
      usage: async () => ({ usage: 10, quota: 100, persisted: false }),
      requestPersist: () => new Promise((resolve) => { pending = resolve; })
    });
    await asking.reload();
    const headings = walkText(off).filter((node) => node.tag === "h3" && node.className === "set-gh").map((node) => node.textContent);
    assert.deepEqual(headings, ["存储用量", "文献库 · 导入", "文献库 · 导出"]);
    const usageGroup = walkText(off).find((node) => node.getAttribute?.("data-focus-group") === "usage");
    assert.equal(usageGroup.tag, "section");
    assert.equal(usageGroup.getAttribute("aria-labelledby"), "dataUsageHeading");
    assert.equal(usageGroup.children.some((node) => node.tag === "h2" || node.tag === "h3"), false);
    assert.equal(stateOf(off).getAttribute("data-persist-state"), "off");
    assert.match(off.textContent, /未开启/);
    const idleStatus = walkText(off).find((node) => node.getAttribute?.("role") === "status");
    assert.equal(idleStatus.getAttribute("aria-live"), "polite");
    click(off, "申请长期保存");
    assert.equal(stateOf(off).getAttribute("data-persist-state"), "asking");
    const askingButton = [...walkText(off)].find((node) => node.tag === "button" && node.getAttribute?.("data-persist-ask") != null);
    assert.equal(askingButton.disabled, true);
    assert.equal(askingButton.getAttribute("aria-busy"), "true");
    assert.equal(askingButton.style.width, "138px");
    assert.equal(askingButton.children.some((node) => node.className === "oi-set-spin"), true);
    assert.match(askingButton.textContent, /申请长期保存/);
    assert.match(off.textContent, /申请中/);
    pending(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stateOf(off).getAttribute("data-persist-state"), "denied");
    assert.equal(off.textContent.includes("浏览器未同意"), false);
    const deniedChip = walkText(off).find((node) => String(node.className).includes("oi-data-chip") && node.textContent === "未开启");
    assert.ok(deniedChip);
    assert.match(off.textContent, /再试一次/);
    assert.match(off.textContent, /导出文献库/);
    assert.match(off.textContent, /可以导出文献库，留在自己的文件夹里/);
    assert.match(off.textContent, /空间紧张时仍可能清掉文献库/);
    const deniedStatus = walkText(off).find((node) => node.getAttribute?.("role") === "status" && String(node.textContent).includes("可以导出文献库"));
    assert.equal(deniedStatus.getAttribute("aria-live"), "polite");
    assert.equal(document.activeElement?.getAttribute("data-persist-ask"), "true");
    assert.match(document.activeElement.textContent, /再试一次/);
    assert.equal(off.textContent.includes("oi-data-toast") || [...walkText(off)].some((node) => node.className === "oi-data-toast"), false);

    const on = document.createElement("div");
    const onPanel = mountDataPanel(on, {
      store: panelStore(),
      coordinator: quietCoordinator(),
      usage: async () => ({ usage: 1, quota: 2, persisted: true }),
      requestPersist: async () => true
    });
    await onPanel.reload();
    assert.equal(stateOf(on).getAttribute("data-persist-state"), "on");
    assert.match(on.textContent, /已开启/);

    const granted = document.createElement("div");
    const grantedPanel = mountDataPanel(granted, {
      store: panelStore(),
      coordinator: quietCoordinator(),
      usage: async () => ({ usage: 1, quota: 2, persisted: false }),
      requestPersist: async () => true
    });
    await grantedPanel.reload();
    click(granted, "申请长期保存");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stateOf(granted).getAttribute("data-persist-state"), "on");
    assert.equal(document.activeElement, stateOf(granted));
    assert.equal(document.activeElement.getAttribute("tabindex"), "-1");

    const unsupported = document.createElement("div");
    const unsupportedPanel = mountDataPanel(unsupported, {
      store: panelStore(),
      coordinator: quietCoordinator(),
      usage: async () => ({ usage: 1, quota: 2, persisted: false }),
      persistSupported: false
    });
    assert.equal(stateOf(unsupported).getAttribute("data-persist-state"), "unsupported");
    assert.match(unsupported.textContent, /不支持/);
    assert.equal(unsupported.textContent.includes("申请长期保存"), false);
    assert.equal(unsupported.textContent.includes("再试一次"), false);
    asking.destroy();
    onPanel.destroy();
    grantedPanel.destroy();
    unsupportedPanel.destroy();
  } finally {
    restore();
  }
});

function walkText(node, out = []) {
  if (!node) return out;
  out.push(node);
  for (const kid of node.children || []) walkText(kid, out);
  return out;
}

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

const PDF_OFF_STUB = `(() => {
  globalThis.chrome = {
    runtime: {
      id: "oi-pdf-off",
      getManifest() { return { version: "0.0.0" }; },
      getURL(path) { return new URL(path, location.href).href; },
      sendMessage(message) {
        const type = message && message.type;
        if (type === "OI_GET_SETTINGS") {
          return Promise.resolve({
            ok: true,
            settings: {
              provider: "mymemory",
              sourceLang: "auto",
              targetLang: "zh-CN",
              batchSize: 8,
              pdfAutoTranslate: true,
              features: { pdf: false },
              providers: {},
              pdfLayout: { mode: "" }
            }
          });
        }
        return Promise.resolve({ ok: true, settings: {} });
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

const PDF_OFF_STYLE = `(() => {
  const sw = document.getElementById("pdfAutoTranslate");
  const note = document.getElementById("pdfEnabledNote");
  const box = document.getElementById("pdfLayoutBox");
  if (!sw || !note || !box || box.hidden) return null;
  if (!note.textContent.startsWith("已关闭")) return null;
  const row = sw.closest(".set-row");
  const title = document.getElementById("pdfAutoTranslateLabel");
  const mode = document.getElementById("pdfLayoutMode");
  const gap = document.getElementById("bodyGlossGap");
  const master = document.getElementById("pdfEnabled");
  const step = row.parentElement.querySelector(".set-step");
  const probe = document.createElement("span");
  probe.style.color = getComputedStyle(document.body).getPropertyValue("--oi-text-muted").trim();
  document.body.appendChild(probe);
  const muted = getComputedStyle(probe).color;
  probe.style.color = getComputedStyle(document.body).getPropertyValue("--oi-accent").trim();
  const accent = getComputedStyle(probe).color;
  probe.style.background = getComputedStyle(document.body).getPropertyValue("--oi-line-strong").trim();
  const line = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const paint = (node) => {
    const style = getComputedStyle(node);
    return { opacity: style.opacity, color: style.color, background: style.backgroundColor };
  };
  return {
    note: note.textContent,
    rowOpacity: paint(row).opacity,
    titleColor: paint(title).color,
    noteColor: paint(row.querySelector(".set-note")).color,
    switchBg: paint(sw).background,
    switchOpacity: paint(sw).opacity,
    switchDisabled: sw.disabled,
    switchChecked: sw.checked,
    modeDisabled: mode.disabled,
    modeOpacity: paint(mode).opacity,
    modeRowOpacity: paint(mode.closest(".set-row")).opacity,
    modeTitle: paint(mode.closest(".set-row").querySelector(".set-title")).color,
    gapDisabled: gap.disabled,
    gapRowOpacity: paint(gap.closest(".set-row")).opacity,
    stepDisabled: step.disabled,
    stepOpacity: paint(step).opacity,
    masterDisabled: master.disabled,
    masterOpacity: paint(master).opacity,
    masterRowOpacity: paint(master.closest(".set-row")).opacity,
    muted,
    accent,
    line
  };
})()`;

test("pdf off greys affected rows in computed style", { timeout: 120000 }, async (t) => {
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
  handle.ownedDir = mkdtempSync(join(tmpdir(), "oi-pdf-off-"));
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
  await send("Page.addScriptToEvaluateOnNewDocument", { source: PDF_OFF_STUB });
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
  await send("Page.navigate", { url: `${origin}/options/options.html#pdf` });
  const started = Date.now();
  let style = null;
  while (Date.now() - started < 20000) {
    style = await evaluate(PDF_OFF_STYLE);
    if (style) break;
    await new Promise((done) => setTimeout(done, 100));
  }
  assert.ok(style, "pdf-off styles did not settle");
  assert.match(style.note, /^已关闭/);
  assert.equal(style.switchDisabled, true);
  assert.equal(style.switchChecked, true);
  assert.equal(style.rowOpacity, "0.5");
  assert.equal(style.titleColor, style.muted);
  assert.equal(style.noteColor, style.muted);
  assert.equal(style.switchBg, style.line);
  assert.notEqual(style.switchBg, style.accent);
  assert.equal(style.switchOpacity, "1");
  assert.equal(style.modeDisabled, true);
  assert.equal(style.modeOpacity, "1");
  assert.equal(style.modeRowOpacity, "0.5");
  assert.equal(style.modeTitle, style.muted);
  assert.equal(style.gapDisabled, true);
  assert.equal(style.gapRowOpacity, "0.5");
  assert.equal(style.stepDisabled, true);
  assert.equal(style.stepOpacity, "1");
  assert.equal(style.masterDisabled, false);
  assert.equal(style.masterRowOpacity, "1");
  assert.equal(style.masterOpacity, "1");
});
