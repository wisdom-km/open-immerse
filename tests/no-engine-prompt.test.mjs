import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

import { NO_ENGINE_COPY, flashFocus } from "../lib/no-engine-prompt.js";
import { parseSettingsHash } from "../options/route.js";
import { createNet, installNet } from "../lib/net/fetch.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

test("NEP-04 the three surfaces quote the shared no-engine copy", () => {
  const content = read("content/content.js");
  const popup = read("popup/popup.html");
  const pdf = read("pdf/viewer.html");
  const options = read("options/options.html");
  assert.equal(NO_ENGINE_COPY.title, "还没有可用的翻译引擎");
  assert.equal(NO_ENGINE_COPY.body, "去设置里选一个引擎并填写 API Key，就能开始翻译。");
  assert.equal(NO_ENGINE_COPY.primary, "去设置");
  assert.equal(NO_ENGINE_COPY.dismiss, "关闭");
  assert.equal(NO_ENGINE_COPY.engineUnset, "未设置");
  assert.equal(NO_ENGINE_COPY.providerPlaceholder, "请选择引擎");
  assert.equal(NO_ENGINE_COPY.providerHint, "选择引擎后填写 API Key。MyMemory 免费但质量有限，无需 Key。");
  assert.equal(NO_ENGINE_COPY.settingsHash, "#translate?focus=provider");
  for (const [name, value] of [
    ["NO_ENGINE_TITLE", NO_ENGINE_COPY.title],
    ["NO_ENGINE_BODY", NO_ENGINE_COPY.body],
    ["NO_ENGINE_PRIMARY", NO_ENGINE_COPY.primary],
    ["NO_ENGINE_DISMISS", NO_ENGINE_COPY.dismiss]
  ]) {
    assert.match(content, new RegExp(`const ${name} = ${JSON.stringify(value)};`));
  }
  assert.match(popup, /id="engineNote"[^>]*>去设置里选一个引擎并填写 API Key，就能开始翻译。<\/p>/);
  assert.match(popup, /id="engineUnsetName">未设置<\/span> · <a id="engineSetup"[^>]*>去设置<\/a>/);
  assert.match(pdf, /<h3>还没有可用的翻译引擎<\/h3>/);
  assert.match(pdf, /<p>去设置里选一个引擎并填写 API Key，就能开始翻译。<\/p>/);
  const banner = pdf.slice(pdf.indexOf('id="noEngineBanner"'), pdf.indexOf('id="reader"'));
  assert.ok(banner.indexOf('id="noEngineSetup"') < banner.indexOf('id="noEngineDismiss"'));
  assert.match(banner, /class="btn-primary">去设置</);
  assert.match(banner, /class="btn-secondary">关闭</);
  assert.match(options, /id="providerHint">选择引擎后填写 API Key。MyMemory 免费但质量有限，无需 Key。<\/p>/);
  assert.match(options, /<p class="hint">只显示当前默认引擎的配置。改上方下拉框即可换家；其他引擎已保存的 Key 不会丢。<\/p>/);
  for (const file of ["popup/popup.js", "popup/popup.html", "pdf/viewer.js", "pdf/viewer.html", "content/content.js", "options/options.html", "options/options.js"]) {
    assert.equal(read(file).includes("借用"), false, file);
  }
});

test("NEP-05/10 the provider anchor focuses the select and the ring lasts 1.2s", () => {
  const parsed = parseSettingsHash("#translate?focus=provider");
  assert.equal(parsed.id, "translate");
  assert.equal(parsed.focus, "provider");
  assert.equal(parsed.replace, "#translate");
  assert.equal(parseSettingsHash("#mm?focus=provider").focus, "");
  const optionsJs = read("options/options.js");
  assert.match(optionsJs, /if \(focus === "provider" && next === "translate"\) flashFocus\(el\("provider"\)\)/);
  assert.match(optionsJs, /showPage\(parsed\.id, parsed\.focus\)/);
  const optionsCss = read("options/options.css");
  assert.match(optionsCss, /select:focus[\s\S]*?box-shadow:\s*0 0 0 2px var\(--oi-bg\), 0 0 0 4px var\(--oi-accent\)/);
  assert.match(optionsCss, /body\.oi-settings \.set-flash \{ background: var\(--oi-accent-subtle\); \}/);
  const popupCss = read("popup/popup.css");
  const contentCss = read("content/content.css");
  const viewerCss = read("pdf/viewer.css");
  assert.match(popupCss, /\.engine-setup:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-focus\)/s);
  assert.match(contentCss, /\.oi-toast\.is-engine \.oi-engine-actions button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-focus\)/s);
  assert.match(viewerCss, /\.oi-no-engine \.oi-no-engine-actions button:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-reader-ink\)/s);

  const calls = [];
  const node = {
    classList: {
      names: new Set(),
      add(name) { this.names.add(name); },
      remove(name) { this.names.delete(name); }
    },
    scrollIntoView(opts) { calls.push(opts); },
    focus() { calls.push("focus"); }
  };
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    assert.equal(flashFocus(node), true);
    assert.equal(node.classList.names.has("set-flash"), true);
    assert.deepEqual(calls, [{ block: "center" }, "focus"]);
    mock.timers.tick(1199);
    assert.equal(node.classList.names.has("set-flash"), true);
    mock.timers.tick(1);
    assert.equal(node.classList.names.has("set-flash"), false);
    assert.equal(flashFocus(null), false);
  } finally {
    mock.timers.reset();
  }
});

test("NEP-06/07 toast and PDF banner keep one row and reader tokens", () => {
  const content = read("content/content.js");
  const toastFn = content.slice(content.indexOf("function showNoEngineToast"), content.indexOf("function dismissNoEngineToast"));
  assert.match(toastFn, /document\.querySelector\("\.oi-toast"\)/);
  assert.match(toastFn, /if \(!el\.classList\.contains\("is-engine"\)\)/);
  assert.match(toastFn, /actions\.append\(close, setup\)/);
  assert.equal(toastFn.includes("appendChild(document.createElement(\"div\"))"), false);
  const css = read("content/content.css");
  const engine = css.slice(css.indexOf(".oi-toast.is-engine"), css.indexOf(".oi-selection-card"));
  assert.match(engine, /\.oi-engine-title\s*\{[^}]*font-size:\s*14px;[^}]*font-weight:\s*600/s);
  assert.match(engine, /\.oi-engine-body\s*\{[^}]*font-size:\s*13px;[^}]*font-weight:\s*400/s);
  assert.match(engine, /\.oi-engine-actions\s*\{[^}]*justify-content:\s*flex-end;[^}]*flex-wrap:\s*nowrap;[^}]*height:\s*28px/s);
  assert.match(engine, /white-space:\s*nowrap/);
  assert.match(css, /\.oi-toast\.is-engine\s*\{[^}]*pointer-events:\s*auto/s);

  const viewerCss = read("pdf/viewer.css");
  const bannerCss = viewerCss.slice(viewerCss.indexOf(".oi-no-engine"), viewerCss.indexOf("#status.error"));
  assert.match(bannerCss, /flex-wrap:\s*nowrap/);
  assert.match(bannerCss, /height:\s*28px/);
  for (const name of [...bannerCss.matchAll(/var\((--[\w-]+)/g)].map((hit) => hit[1])) {
    assert.match(name, /^--oi-reader-/, name);
  }
  const viewer = read("pdf/viewer.js");
  const start = viewer.slice(viewer.indexOf("async function startTranslate"), viewer.indexOf("function rememberLibraryIdentity"));
  assert.match(start, /if \(blocker === "NO_ENGINE"\) \{\s*showNoEngineBanner\(\);/);
  assert.match(start, /hideNoEngineBanner\(\);\s*if \(blocker\)/);
  assert.equal(start.includes('setStatus("NO_ENGINE"'), false);
  assert.equal(start.includes(NO_ENGINE_COPY.body), false);
  const show = viewer.slice(viewer.indexOf("function showNoEngineBanner"), viewer.indexOf("function hideNoEngineBanner"));
  assert.match(show, /pending\.hidden = true/);
  assert.match(read("pdf/viewer.html"), /id="noEngineBanner" class="oi-store-banner oi-no-engine" hidden/);
});

test("NEP-01/02/08/11 web toast, popup line, and preflight send no translation request", async () => {
  const urls = [];
  installNet(createNet({
    transport(url) {
      urls.push(String(url));
      return { ok: true, status: 200, headers: {}, data: {} };
    }
  }));
  const state = {
    settings: {
      settingsVersion: 9,
      provider: "",
      sourceLang: "en",
      targetLang: "zh-CN",
      translateScope: "article",
      features: { webpage: true },
      providers: { openai: { apiKey: "" }, mymemory: { email: "" } }
    },
    formula: { multimodal: { provider: "kimi", apiKey: "", model: "" } }
  };
  const tabs = [];
  const created = [];
  const updated = [];
  const focused = [];
  const listeners = [];
  globalThis.chrome = {
    storage: {
      sync: {
        async get() { return { settings: state.settings }; },
        async set() {}
      },
      local: {
        async get() { return { formulaSettings: state.formula }; },
        async set() {}
      },
      session: {
        async get() { return {}; },
        async set() {}
      },
      onChanged: { addListener() {} }
    },
    runtime: {
      id: "oi-test",
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(fn) { listeners.push(fn); } },
      getURL: (path) => `chrome-extension://oi/${path}`,
      async sendMessage(message) {
        return call(message.type, message);
      }
    },
    contextMenus: {
      onClicked: { addListener() {} },
      async removeAll() {},
      create() {}
    },
    commands: { onCommand: { addListener() {} } },
    tabs: {
      async query() { return tabs.slice(); },
      async update(id, patch) { updated.push({ id, patch }); return { id }; },
      async create(patch) { created.push(patch); return { id: 9 }; },
      async sendMessage() { return null; }
    },
    windows: {
      async update(id, patch) { focused.push({ id, patch }); }
    }
  };
  function call(type, message = {}) {
    const listener = listeners[0];
    return new Promise((resolve, reject) => {
      const ok = listener({ type, ...message }, {}, resolve);
      if (!ok) reject(new Error("listener must return true"));
    });
  }
  const sw = await import(`../background/service-worker.js?nep=${Date.now()}`);
  const none = await call("OI_TRANSLATE_PREFLIGHT");
  assert.deepEqual(none, { ok: false, code: "NO_ENGINE" });
  assert.equal(urls.length, 0);

  state.formula = { multimodal: { provider: "kimi", apiKey: "sk-borrow-unit-key", model: "kimi-k2", baseUrl: "" } };
  const borrowed = await call("OI_TRANSLATE_PREFLIGHT");
  assert.deepEqual(borrowed, { ok: true, code: "" });
  assert.equal(urls.length, 0);

  state.settings = {
    ...state.settings,
    provider: "openai",
    providers: { openai: { apiKey: "sk-own-engine", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" } }
  };
  state.formula = { multimodal: { provider: "kimi", apiKey: "", model: "" } };
  const own = await call("OI_TRANSLATE_PREFLIGHT");
  assert.deepEqual(own, { ok: true, code: "" });
  assert.equal(urls.length, 0);

  tabs.push({ id: 4, windowId: 2, url: "chrome-extension://oi/options/options.html#mm" });
  const reused = await sw.openTranslateProviderSettings();
  assert.deepEqual(reused, { ok: true, reused: true });
  assert.deepEqual(updated, [{
    id: 4,
    patch: { active: true, url: "chrome-extension://oi/options/options.html#translate?focus=provider" }
  }]);
  assert.deepEqual(focused, [{ id: 2, patch: { focused: true } }]);
  assert.equal(created.length, 0);
  tabs.length = 0;
  const opened = await sw.openTranslateProviderSettings();
  assert.deepEqual(opened, { ok: true, reused: false });
  assert.equal(created.length, 1);
  assert.match(created[0].url, /options\/options\.html#translate\?focus=provider$/);

  const worker = read("background/service-worker.js");
  assert.equal(worker.includes("no-engine-prompt"), false);
  assert.match(worker, /options\/options\.html#translate\?focus=provider/);

  state.settings = {
    settingsVersion: 9,
    provider: "",
    sourceLang: "en",
    targetLang: "zh-CN",
    translateScope: "article",
    batchSize: 8,
    features: { webpage: true },
    providers: { mymemory: { email: "" } }
  };
  state.formula = { multimodal: { provider: "kimi", apiKey: "", model: "" } };
  const page = parseHTML(`<!doctype html><html><body><article><p>Hello from the article body for translation.</p></article></body></html>`);
  const proto = page.document.createElement("p").constructor.prototype;
  proto.getBoundingClientRect = () => ({ width: 240, height: 32, top: 0, left: 0, right: 240, bottom: 32 });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    location: globalThis.location,
    Event: globalThis.Event,
    CustomEvent: globalThis.CustomEvent,
    getComputedStyle: globalThis.getComputedStyle,
    MutationObserver: globalThis.MutationObserver,
    Node: globalThis.Node
  };
  globalThis.document = page.document;
  globalThis.window = page.window;
  globalThis.location = { hostname: "example.com", href: "https://example.com/post" };
  globalThis.Event = page.window.Event;
  globalThis.CustomEvent = page.window.CustomEvent;
  globalThis.getComputedStyle = () => ({ fontSize: "16px", display: "block", visibility: "visible", opacity: "1" });
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.Node = page.window.Node;
  const seen = [];
  const realSend = globalThis.chrome.runtime.sendMessage;
  globalThis.chrome.runtime.sendMessage = async (message) => {
    seen.push(message.type);
    if (message.type === "OI_GET_SETTINGS") return { settings: state.settings };
    if (message.type === "OI_TRANSLATE_PREFLIGHT") return call("OI_TRANSLATE_PREFLIGHT");
    if (message.type === "OI_TRANSLATE_BATCH") return { ok: true, translations: ["你好"] };
    return call(message.type, message);
  };
  try {
    await import(`../content/content.js?nep=${Date.now()}`);
    for (let i = 0; i < 30; i += 1) await Promise.resolve();
    page.window.dispatchEvent(new page.window.Event("oi-please-start"));
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    const first = [...page.document.querySelectorAll(".oi-toast")];
    assert.equal(first.length, 1);
    assert.equal(first[0].classList.contains("is-engine"), true);
    assert.equal(first[0].classList.contains("show"), true);
    assert.equal(first[0].querySelector(".oi-engine-title").textContent, NO_ENGINE_COPY.title);
    assert.equal(first[0].querySelector(".oi-engine-body").textContent, NO_ENGINE_COPY.body);
    const buttons = [...first[0].querySelectorAll("button")];
    assert.deepEqual(buttons.map((button) => button.textContent), [NO_ENGINE_COPY.dismiss, NO_ENGINE_COPY.primary]);
    assert.equal(seen.includes("OI_TRANSLATE_BATCH"), false);
    assert.equal(urls.length, 0);
    assert.equal(page.document.querySelector(".oi-translation"), null);
    page.window.dispatchEvent(new page.window.Event("oi-please-start"));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.equal(page.document.querySelectorAll(".oi-toast").length, 1);
    buttons[1].click();
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    assert.equal(first[0].classList.contains("show"), false);
    assert.equal(seen.includes("OI_OPEN_TRANSLATE_SETTINGS"), true);

    state.settings = {
      ...state.settings,
      provider: "openai",
      providers: { openai: { apiKey: "sk-own-engine", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" } }
    };
    page.window.dispatchEvent(new page.window.Event("oi-please-start"));
    for (let i = 0; i < 80; i += 1) await Promise.resolve();
    assert.equal(seen.includes("OI_TRANSLATE_BATCH"), true);
    assert.equal(page.document.querySelector(".oi-toast.is-engine.show"), null);
    assert.equal(page.document.querySelector(".oi-translation").textContent, "你好");
    assert.equal(urls.length, 0);
  } finally {
    globalThis.chrome.runtime.sendMessage = realSend;
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.location = previous.location;
    globalThis.Event = previous.Event;
    globalThis.CustomEvent = previous.CustomEvent;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.MutationObserver = previous.MutationObserver;
    globalThis.Node = previous.Node;
    installNet(null);
  }
});

test("NEP-03 a configured engine failure stays on that engine", async () => {
  const urls = [];
  installNet(createNet({
    transport(url) {
      urls.push(String(url));
      return { ok: false, status: 500, headers: {}, data: { error: { message: "upstream down" } } };
    }
  }));
  globalThis.chrome = {
    storage: {
      sync: {
        async get() {
          return {
            settings: {
              settingsVersion: 9,
              provider: "openai",
              sourceLang: "en",
              targetLang: "zh-CN",
              batchSize: 8,
              providers: {
                openai: { apiKey: "sk-own-engine", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
                mymemory: { email: "" }
              }
            }
          };
        },
        async set() {}
      },
      local: {
        async get() { return {}; },
        async set() {}
      },
      session: {
        async get() { return {}; },
        async set() {}
      }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
      getURL: (path) => path
    },
    contextMenus: {
      onClicked: { addListener() {} },
      async removeAll() {},
      create() {}
    },
    commands: { onCommand: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() {}, async create() {} }
  };
  try {
    const sw = await import(`../background/service-worker.js?nep-fail=${Date.now()}`);
    const opts = {};
    await assert.rejects(() => sw.translateBatch(["Hello"], opts), (err) => {
      assert.notEqual(err.code, "NO_ENGINE");
      assert.equal(String(err.message || err).includes("MyMemory"), false);
      return true;
    });
    assert.equal(opts.providerId, "openai");
    assert.equal(opts.outboundFallback, false);
    assert.equal(urls.length > 0, true);
    assert.equal(urls.some((url) => url.includes("mymemory")), false);
    assert.equal(urls.some((url) => url.includes("api.openai.com")), true);
  } finally {
    installNet(null);
  }
});
