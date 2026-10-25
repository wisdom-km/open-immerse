import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

import { getProvider } from "../lib/providers.js";
import { createNet, installNet } from "../lib/net/fetch.js";
import {
  TRANSLATE_BORROW_COPY,
  describeTranslateBorrow,
  formatBorrowedEngine,
  paintBorrowHint,
  resolveTranslateOutbound,
  truncateBorrowModel
} from "../lib/translate-borrow.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MM_KEY = "sk-borrow-unit-key";

function unconfigured(provider = "openai") {
  return { provider, providers: { [provider]: { apiKey: "" }, mymemory: {} } };
}

function mm(extra = {}) {
  return {
    multimodal: {
      provider: "kimi",
      apiKey: MM_KEY,
      model: "kimi-k2",
      baseUrl: "",
      ...extra
    }
  };
}

test("TBM-01/05/11 borrow hint copy, fallback copy, and aria-live", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  assert.match(html, /id="translateBorrowHint"[^>]*class="hint set-borrow"[^>]*aria-live="polite"/);
  assert.match(html, /id="translateEngineHint"/);
  const { document } = parseHTML("<p id='engine' class='hint'>只显示当前默认引擎的配置。改上方下拉框即可换家；其他引擎已保存的 Key 不会丢。</p><p id='hint' class='hint set-borrow' aria-live='polite'></p>");
  const hint = document.getElementById("hint");
  const engine = document.getElementById("engine");
  const borrow = describeTranslateBorrow(unconfigured(), mm());
  paintBorrowHint(hint, engine, borrow);
  assert.equal(hint.hidden, false);
  assert.equal(engine.hidden, true);
  assert.match(hint.textContent, /正在借用「多模态 · OCR」的/);
  assert.match(hint.textContent, /Kimi · kimi-k2/);
  assert.equal(hint.querySelector(".set-inline").textContent, TRANSLATE_BORROW_COPY.setupLink);
  assert.equal(hint.querySelector(".set-borrow-model").title, "kimi-k2");
  assert.equal(hint.querySelector(".set-borrow-model").textContent, "kimi-k2");
  assert.equal(hint.textContent.includes(MM_KEY), false);
  assert.equal(JSON.stringify(borrow).includes(MM_KEY), false);

  paintBorrowHint(hint, engine, describeTranslateBorrow(unconfigured(), { multimodal: { provider: "kimi", apiKey: "", model: "" } }));
  assert.match(hint.textContent, /未配置翻译服务，正在使用免费的 MyMemory/);
  assert.equal(hint.querySelector(".set-inline").textContent, TRANSLATE_BORROW_COPY.fallbackLink);
  assert.equal(engine.hidden, true);

  paintBorrowHint(hint, engine, describeTranslateBorrow({ provider: "mymemory", providers: { mymemory: {} } }, mm()));
  assert.equal(hint.hidden, true);
  assert.equal(engine.hidden, false);
  assert.match(engine.textContent, /只显示当前默认引擎/);
});

test("TBM-03/04 borrow hint stays one line with existing tokens", () => {
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  const block = css.slice(css.indexOf("#translateBorrowHint.set-borrow"));
  assert.match(block, /#translateBorrowHint\.set-borrow\s*\{[^}]*white-space:\s*nowrap/s);
  assert.match(block, /overflow:\s*hidden/);
  assert.match(block, /\.set-borrow-model\s*\{[^}]*max-width:\s*18em/s);
  assert.match(block, /\.set-borrow-model\s*\{[^}]*text-overflow:\s*ellipsis/s);
  assert.match(block, /#translateBorrowHint \.set-inline\s*\{[^}]*flex:\s*none/s);
  assert.match(block, /color:\s*var\(--oi-text-2\)/);
  assert.match(block, /color:\s*var\(--oi-accent-hover\)/);
  assert.match(block, /outline:\s*2px solid var\(--oi-focus\)/);
  assert.equal(/--oi-warn|warn-soft|#(?:[0-9a-fA-F]{3,8})/.test(block.slice(0, block.indexOf("body.oi-settings .diag-heading"))), false);
  assert.equal(/@media[\s\S]{0,400}set-borrow[\s\S]{0,200}white-space:\s*normal/.test(css), false);
  const { document } = parseHTML("<p id='hint'></p>");
  paintBorrowHint(document.getElementById("hint"), null, describeTranslateBorrow(unconfigured(), mm({ model: "kimi-k2-0905-preview-extra-long-name" })));
  const model = document.querySelector(".set-borrow-model");
  assert.equal(model.textContent, "kimi-k2-0905-preview-extra-long-name");
  assert.equal(model.title, model.textContent);
  assert.equal(document.querySelector(".set-inline").textContent, "单独设置");
});

test("TBM-07/08 popup borrow line keeps the model, truncates past 16, and hides warn", async () => {
  assert.equal(truncateBorrowModel("kimi-k2"), "kimi-k2");
  assert.equal(truncateBorrowModel("kimi-k2-0905-pre"), "kimi-k2-0905-pre");
  assert.equal(truncateBorrowModel("kimi-k2-0905-preview"), "kimi-k2-0905…");
  const line = formatBorrowedEngine({ shortName: "Kimi", vendorLabel: "Kimi", model: "kimi-k2" });
  assert.equal(line.text, "引擎：Kimi · kimi-k2（借用）");
  assert.equal(line.suffix, "（借用）");
  assert.equal(line.title, "借用「多模态 · OCR」：Kimi · kimi-k2");
  const long = formatBorrowedEngine({ shortName: "Kimi", vendorLabel: "Kimi", model: "kimi-k2-0905-preview" });
  assert.equal(long.main, "引擎：Kimi · kimi-k2-0905…");
  assert.equal(long.text.endsWith("（借用）"), true);
  assert.equal(long.title.endsWith("kimi-k2-0905-preview"), true);

  const popupHtml = readFileSync(join(root, "popup/popup.html"), "utf8");
  const popupCss = readFileSync(join(root, "popup/popup.css"), "utf8");
  assert.match(popupHtml, /id="engineWarn"/);
  assert.match(popupCss, /\.engine-link\.is-borrow \.engine-borrow\s*\{[^}]*flex:\s*none/s);
  assert.match(popupCss, /\.engine-link\s*\{[^}]*text-overflow:\s*ellipsis/s);

  const parsed = parseHTML(popupHtml);
  const selectProto = Object.getPrototypeOf(parsed.document.createElement("select"));
  Object.defineProperty(selectProto, "value", {
    configurable: true,
    get() { return this._value ?? ""; },
    set(next) { this._value = String(next ?? ""); }
  });
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    chrome: globalThis.chrome,
    setInterval: globalThis.setInterval
  };
  globalThis.document = parsed.document;
  globalThis.window = parsed.window;
  globalThis.setInterval = () => 0;
  globalThis.chrome = {
    runtime: {
      getURL: (path) => path,
      openOptionsPage() {},
      async sendMessage(message) {
        if (message?.type === "OI_GET_SETTINGS") {
          return {
            settings: {
              provider: "openai",
              providers: { openai: { apiKey: "" } },
              sourceLang: "en",
              targetLang: "zh-CN",
              translateScope: "article",
              translateLimit: "all",
              features: {}
            }
          };
        }
        return { ok: true };
      }
    },
    storage: {
      local: {
        async get() {
          return { formulaSettings: mm({ model: "kimi-k2-0905-preview" }) };
        }
      },
      onChanged: { addListener() {} }
    },
    tabs: {
      async query() { return [{ id: 1, url: "https://example.com/article" }]; },
      async sendMessage() { return null; }
    }
  };
  try {
    await import(`../popup/popup.js?borrow-popup=${Date.now()}`);
    let linkText = "";
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve();
      linkText = parsed.document.getElementById("engineLink").textContent;
      if (linkText.includes("借用")) break;
    }
    const link = parsed.document.getElementById("engineLink");
    const warn = parsed.document.getElementById("engineWarn");
    assert.equal(link.textContent, "引擎：Kimi · kimi-k2-0905…（借用）");
    assert.equal(link.querySelector(".engine-borrow").textContent, "（借用）");
    assert.equal(link.title, "借用「多模态 · OCR」：Kimi · kimi-k2-0905-preview");
    assert.equal(link.textContent.includes(MM_KEY), false);
    assert.equal(warn.hidden, true);
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.chrome = previous.chrome;
    globalThis.setInterval = previous.setInterval;
  }
});

test("TBM-09/10 own config wins, borrow does not copy the key into storage, and the request uses it", async () => {
  const settings = unconfigured();
  const formula = mm();
  const beforeSettings = JSON.stringify(settings);
  const beforeFormula = JSON.stringify(formula);
  const outbound = resolveTranslateOutbound(settings, formula);
  assert.equal(JSON.stringify(settings), beforeSettings);
  assert.equal(JSON.stringify(formula), beforeFormula);
  assert.equal(outbound.borrowed, true);
  assert.equal(outbound.adapterId, "kimi");
  assert.equal(outbound.runtimeConfig.model, "kimi-k2");
  assert.equal(outbound.runtimeConfig.baseUrl, "https://api.moonshot.cn/v1");
  assert.equal(settings.providers.kimi, undefined);
  assert.equal(settings.providers.openai.apiKey, "");

  const own = resolveTranslateOutbound(
    { provider: "openai", providers: { openai: { apiKey: "sk-own" } } },
    formula
  );
  assert.equal(own.mode, "own");
  assert.equal(own.borrowed, false);
  assert.equal(own.runtimeConfig, undefined);

  const mismatch = resolveTranslateOutbound(unconfigured(), mm({ baseUrl: "https://evil.example/v1" }));
  assert.equal(mismatch.mode, "fallback");
  assert.equal(mismatch.providerId, "mymemory");

  const custom = resolveTranslateOutbound(unconfigured(), {
    multimodal: { provider: "custom", apiKey: MM_KEY, model: "my-model", baseUrl: "" }
  });
  assert.equal(custom.mode, "fallback");

  const doubao = resolveTranslateOutbound(unconfigured(), {
    multimodal: { provider: "doubao", apiKey: MM_KEY, model: "glm-5.3-flash", baseUrl: "" }
  });
  assert.equal(doubao.adapterId, "openai");
  assert.match(doubao.baseUrl, /volces\.com/);
  assert.equal(describeTranslateBorrow(unconfigured(), {
    multimodal: { provider: "doubao", apiKey: MM_KEY, model: "glm-5.3-flash", baseUrl: "" }
  }).shortName, "豆包");

  const writes = [];
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => {
    logs.push(args.map((item) => String(item)).join(" "));
  };
  const urls = [];
  installNet(createNet({
    transport(url, init) {
      urls.push(String(url));
      const auth = init?.headers?.Authorization || init?.headers?.authorization || "";
      assert.equal(auth, `Bearer ${MM_KEY}`);
      assert.equal(String(init?.body || "").includes(MM_KEY), false);
      return {
        ok: true,
        status: 200,
        headers: {},
        data: { choices: [{ message: { content: "1. 你好" } }] }
      };
    }
  }));
  globalThis.chrome = {
    storage: {
      sync: {
        async get() {
          return {
            settings: {
              ...unconfigured(),
              sourceLang: "en",
              targetLang: "zh-CN",
              batchSize: 8,
              twoStepPolish: false,
              deepThink: false
            }
          };
        },
        async set(patch) { writes.push(patch); }
      },
      local: {
        async get(key) {
          if (key === "formulaSettings") return { formulaSettings: formula };
          return {};
        },
        async set(patch) { writes.push(patch); }
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
    const sw = await import(`../background/service-worker.js?borrow-batch=${Date.now()}`);
    const opts = {};
    const out = await sw.translateBatch(["Hello"], opts);
    assert.equal(out[0], "你好");
    assert.equal(opts.borrowed, true);
    assert.equal(opts.providerCalled, false);
    assert.equal(opts.outboundFallback, false);
    assert.equal(urls.length, 1);
    assert.match(urls[0], /^https:\/\/api\.moonshot\.cn\/v1\/chat\/completions$/);
    const dumped = JSON.stringify(writes);
    assert.equal(dumped.includes(MM_KEY), false);
    assert.equal(logs.join("\n").includes(MM_KEY), false);
    for (const key of sw.translationCache.keys()) {
      assert.equal(String(key).includes(MM_KEY), false);
    }
    const adapter = getProvider("kimi");
    assert.equal(typeof adapter.translate, "function");
  } finally {
    console.error = originalError;
    installNet(null);
  }
});

test("pdf missing mode states that multimodal is also unconfigured", () => {
  const src = readFileSync(join(root, "tests/pdf-auto-translate.test.mjs"), "utf8");
  assert.match(src, /多模态也没有 key/);
  assert.match(src, /mode === "missing" && \(key == null \|\| key === "formulaSettings"\)/);
  assert.match(src, /apiKey: ""/);
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.match(viewer, /await formulaSettingsReady/);
  assert.match(viewer, /resolveTranslateOutbound\(settings, formulaViewerSettings\)/);
});
