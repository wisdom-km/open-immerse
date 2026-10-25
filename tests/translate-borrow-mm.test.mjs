import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

import { getProvider } from "../lib/providers.js";
import { createNet, installNet } from "../lib/net/fetch.js";
import { resetDiagForTests } from "../lib/diag-log.js";
import {
  describeTranslateBorrow,
  resolveTranslateOutbound
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

test("TBM-01/02/05/11 settings page does not show a borrow hint", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  const optionsJs = readFileSync(join(root, "options/options.js"), "utf8");
  const borrowJs = readFileSync(join(root, "lib/translate-borrow.js"), "utf8");
  assert.match(html, /<p class="hint">只显示当前默认引擎的配置。改上方下拉框即可换家；其他引擎已保存的 Key 不会丢。<\/p>/);
  assert.equal(html.includes("translateBorrowHint"), false);
  assert.equal(html.includes("translateEngineHint"), false);
  assert.equal(html.includes("set-borrow"), false);
  assert.equal(html.includes("aria-live"), false);
  assert.equal(html.includes("单独设置"), false);
  assert.equal(html.includes("设置引擎"), false);
  assert.equal(html.includes("正在借用"), false);
  assert.equal(optionsJs.includes("translateBorrowHint"), false);
  assert.equal(optionsJs.includes("paintBorrowHint"), false);
  assert.equal(optionsJs.includes("focusBorrowTarget"), false);
  assert.equal(optionsJs.includes("data-borrow-focus"), false);
  assert.equal(borrowJs.includes("paintBorrowHint"), false);
  assert.equal(borrowJs.includes("focusBorrowTarget"), false);
  assert.equal(borrowJs.includes("单独设置"), false);
  assert.equal(borrowJs.includes("（借用）"), false);
  assert.equal(borrowJs.includes("formatBorrowedEngine"), false);
  const borrow = describeTranslateBorrow(unconfigured(), mm());
  assert.equal(borrow.mode, "borrow");
  assert.equal(JSON.stringify(borrow).includes(MM_KEY), false);
  assert.equal(describeTranslateBorrow(unconfigured(), { multimodal: { provider: "kimi", apiKey: "", model: "" } }).mode, "fallback");
  assert.equal(describeTranslateBorrow({ provider: "mymemory", providers: { mymemory: {} } }, mm()).mode, "own");
});

test("TBM-03/04 settings page has no borrow-hint layout", () => {
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  assert.equal(css.includes("translateBorrowHint"), false);
  assert.equal(css.includes("set-borrow"), false);
  assert.match(css, /body\.oi-settings \.set-group \+ \.hint \{[^}]*margin:\s*8px 4px 0/s);
  assert.match(css, /\.hint \{[^}]*font-size:\s*13px/s);
});

test("TBM-07/08 popup shows the engine actually used and hides the unconfigured warning", async () => {
  const popupJs = readFileSync(join(root, "popup/popup.js"), "utf8");
  const popupHtml = readFileSync(join(root, "popup/popup.html"), "utf8");
  const popupCss = readFileSync(join(root, "popup/popup.css"), "utf8");
  assert.match(popupJs, /described\.mode === "borrow"/);
  assert.match(popupJs, /引擎：\$\{described\.shortName\}/);
  assert.match(popupJs, /引擎：\$\{shortName\}（免费）/);
  assert.equal(popupJs.includes("（借用）"), false);
  assert.equal(popupJs.includes("formatBorrowedEngine"), false);
  assert.equal(popupJs.includes("engine-borrow"), false);
  assert.equal(popupJs.includes("is-borrow"), false);
  assert.equal(popupCss.includes("is-borrow"), false);
  assert.equal(popupCss.includes("engine-borrow"), false);
  assert.match(popupHtml, /id="engineWarn"/);
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
      if (linkText === "引擎：Kimi") break;
    }
    const link = parsed.document.getElementById("engineLink");
    const warn = parsed.document.getElementById("engineWarn");
    const warnText = parsed.document.getElementById("engineWarnText");
    assert.equal(link.textContent, "引擎：Kimi");
    assert.equal(link.title, "Kimi");
    assert.equal(link.querySelector(".engine-borrow"), null);
    assert.equal(link.textContent.includes("kimi-k2"), false);
    assert.equal(link.textContent.includes("借用"), false);
    assert.equal(link.textContent.includes("MyMemory"), false);
    assert.equal(link.textContent.includes("免费"), false);
    assert.equal(link.textContent.includes("还没配置"), false);
    assert.equal(link.title.includes("借用"), false);
    assert.equal(link.title.includes(MM_KEY), false);
    assert.equal(warn.hidden, true);
    assert.equal(warnText.textContent, "未配置引擎");
    assert.equal(warnText.textContent.includes("还没配置"), false);
    assert.equal(warnText.textContent.includes("MyMemory"), false);
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
    const { handleArxivSourceMessage } = await import("../background/arxiv-source.js");
    await handleArxivSourceMessage({ action: "diag", message: { type: "OI_DIAG_STATS" } });
    const logged = writes.flatMap((patch) => patch?.["diag.events"] || []);
    const borrowLog = logged.find((event) => event.type === "translate.borrow");
    assert.equal(borrowLog?.provider, "kimi");
    assert.equal(borrowLog?.code, "borrow");
    assert.equal(borrowLog?.reason, "kimi-k2");
    assert.equal(borrowLog?.count, 1);
    assert.equal(JSON.stringify(borrowLog).includes(MM_KEY), false);
    assert.equal(JSON.stringify(borrowLog).includes("apiKey"), false);
    assert.equal(JSON.stringify(writes).includes(MM_KEY), false);
    for (const key of sw.translationCache.keys()) {
      assert.equal(String(key).includes(MM_KEY), false);
    }
    const adapter = getProvider("kimi");
    assert.equal(typeof adapter.translate, "function");
    const worker = readFileSync(join(root, "background/service-worker.js"), "utf8");
    const report = worker.slice(worker.indexOf("function reportTranslateBorrow"), worker.indexOf("function emitTranslateProgress"));
    assert.match(report, /action: "diag-borrow"/);
    assert.equal(report.includes("apiKey"), false);
    assert.equal(report.includes("baseUrl"), false);
    const call = worker.slice(worker.indexOf("if (outbound.borrowed)"), worker.indexOf("const provider = outbound.provider"));
    assert.match(call, /provider: outbound\.vendorId/);
    assert.match(call, /model: outbound\.model/);
    assert.equal(call.includes("apiKey"), false);
    assert.equal(call.includes("runtimeConfig"), false);
  } finally {
    console.error = originalError;
    installNet(null);
    resetDiagForTests();
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
