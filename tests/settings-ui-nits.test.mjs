import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_SETTINGS, migrateSettings } from "../lib/storage.js";
import { DEFAULT_FEATURES } from "../lib/features.js";
import { mountDataPanel } from "../options/data-panel.js";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("settings html drops the empty data section and the duplicate privacy sentence", () => {
  const html = read("options/options.html");
  const panel = read("options/data-panel.js");
  assert.equal(html.includes('<section id="data"'), false);
  assert.equal(html.split("API 密钥永远不导出").length - 1, 1);
  assert.equal(panel.includes("API 密钥永远不导出"), false);
  assert.match(html, /id="pdfOnNotice"/);
  assert.match(html, /PDF 阅读已默认开启/);
  const pdf = html.slice(html.indexOf('id="panel-pdf"'), html.indexOf('id="panel-notes"'));
  assert.ok(pdf.indexOf('id="pdfFeatureList"') < pdf.indexOf('id="pdfAutoTranslate"'));
  assert.match(html, /PDF 阅读还没开启/);
  assert.doesNotMatch(html, /在实验室里还没开启/);
});

test("settings cards use flat --set-* tokens and multimodal cards do not use reader tokens", () => {
  const css = read("options/options.css");
  const manifest = read("manifest.json");
  assert.match(css, /--set-border:\s*1px solid var\(--oi-line\)/);
  assert.match(css, /--set-radius:\s*10px/);
  assert.match(css, /--set-row-pad:\s*8px 16px/);
  assert.match(css, /--set-group-gap:\s*16px/);
  assert.match(css, /body\.oi-settings section \{\s*box-shadow:\s*none/);
  assert.match(css, /body\.oi-settings \.set-group \{[^}]*box-shadow:\s*none/s);
  assert.match(css, /body\.oi-settings \.set-group \{[^}]*border:\s*var\(--set-border\)/s);
  assert.match(css, /body\.oi-settings \.set-group \+ \.set-group \{\s*margin-top:\s*var\(--set-group-gap\)/);
  assert.match(css, /padding:\s*var\(--set-row-pad\)/);
  assert.equal(css.includes("--oi-reader-"), false);
  assert.match(css, /\.oi-set-card \{[^}]*border:\s*var\(--set-border\)/s);
  assert.match(css, /\.oi-set-card \{[^}]*box-shadow:\s*none/s);
  assert.match(css, /\.set-key-line \{[^}]*display:\s*flex/s);
  assert.equal(manifest.includes("unlimitedStorage"), false);
});

test("translation key actions sit on one line beside the input", () => {
  const js = read("options/options.js");
  assert.match(js, /line\.className = "set-key-line"/);
  assert.match(js, /line\.append\(input, toggle, remove, saved\)/);
  assert.match(js, /renderFeatures\(el\("pdfFeatureList"\), FEATURES\.filter\(\(feat\) => feat\.id === "pdf"\)/);
  assert.match(js, /pdfFeatureNotice/);
});

test("migration flips a stored pdf=false once and leaves a later off choice alone", () => {
  const storedOff = { settingsVersion: 8, features: { pdf: false, webpage: true } };
  const mergedOff = {
    ...DEFAULT_SETTINGS,
    ...storedOff,
    features: { ...DEFAULT_FEATURES, ...storedOff.features }
  };
  const flipped = migrateSettings(mergedOff, storedOff);
  assert.equal(flipped.changed, true);
  assert.equal(flipped.settings.features.pdf, true);
  assert.equal(flipped.settings.pdfFeatureNotice, true);
  assert.equal(flipped.settings.settingsVersion, 9);

  const keptOn = migrateSettings(
    { ...DEFAULT_SETTINGS, settingsVersion: 8, features: { ...DEFAULT_FEATURES, pdf: true } },
    { settingsVersion: 8, features: { pdf: true } }
  );
  assert.equal(keptOn.settings.features.pdf, true);
  assert.equal(keptOn.settings.pdfFeatureNotice, undefined);

  const missing = migrateSettings(
    { ...DEFAULT_SETTINGS, settingsVersion: 8, features: { ...DEFAULT_FEATURES, webpage: true } },
    { settingsVersion: 8, features: { webpage: true } }
  );
  assert.equal(missing.settings.features.pdf, true);
  assert.equal(missing.settings.pdfFeatureNotice, undefined);

  const choice = migrateSettings(
    { ...flipped.settings, features: { ...flipped.settings.features, pdf: false }, pdfFeatureNotice: false },
    { ...flipped.settings, features: { ...flipped.settings.features, pdf: false }, pdfFeatureNotice: false }
  );
  assert.equal(choice.changed, false);
  assert.equal(choice.settings.features.pdf, false);
  assert.equal(choice.settings.pdfFeatureNotice, false);
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
    focus() {}
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
  globalThis.document = { createElement };
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
    assert.equal(stateOf(off).getAttribute("data-persist-state"), "off");
    assert.match(off.textContent, /未开启/);
    click(off, "再申请一次");
    assert.equal(stateOf(off).getAttribute("data-persist-state"), "asking");
    const askingButton = [...walkText(off)].find((node) => node.tag === "button" && String(node.textContent).includes("再申请一次"));
    assert.equal(askingButton.disabled, true);
    assert.match(off.textContent, /申请中/);
    pending(false);
    await asking.reload();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(stateOf(off).getAttribute("data-persist-state"), "denied");
    assert.match(off.textContent, /浏览器未同意/);
    assert.match(off.textContent, /空间紧张时仍可能清掉文献库/);
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

    const unsupported = document.createElement("div");
    const unsupportedPanel = mountDataPanel(unsupported, {
      store: panelStore(),
      coordinator: quietCoordinator(),
      usage: async () => ({ usage: 1, quota: 2, persisted: false }),
      persistSupported: false
    });
    assert.equal(stateOf(unsupported).getAttribute("data-persist-state"), "unsupported");
    assert.match(unsupported.textContent, /不支持/);
    assert.equal(unsupported.textContent.includes("再申请一次"), false);
    asking.destroy();
    onPanel.destroy();
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
