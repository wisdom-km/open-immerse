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
  for (const file of ["popup/popup.js", "popup/popup.html", "options/options.html", "options/options.js", "pdf/viewer.js"]) {
    assert.equal(readFileSync(join(root, file), "utf8").includes("借用"), false, file);
  }
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

let popupBoot = 0;

async function bootPopup(settings, formula) {
  const popupHtml = readFileSync(join(root, "popup/popup.html"), "utf8");
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
        if (message?.type === "OI_GET_SETTINGS") return { settings };
        return { ok: true };
      }
    },
    storage: {
      local: {
        async get() {
          return { formulaSettings: formula };
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
    popupBoot += 1;
    await import(`../popup/popup.js?borrow-popup=${popupBoot}`);
    let linkText = "引擎：—";
    for (let i = 0; i < 30; i += 1) {
      await Promise.resolve();
      linkText = parsed.document.getElementById("engineLink").textContent;
      if (linkText !== "引擎：—") break;
    }
    const link = parsed.document.getElementById("engineLink");
    const warn = parsed.document.getElementById("engineWarn");
    const warnText = parsed.document.getElementById("engineWarnText");
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
    return {
      text: link.textContent,
      title: link.title,
      warnHidden: warn.hidden,
      warnText: warnText.textContent,
      body: parsed.document.body.textContent
    };
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
    globalThis.chrome = previous.chrome;
    globalThis.setInterval = previous.setInterval;
  }
}

function popupSettings(provider, apiKey) {
  return {
    provider,
    providers: { [provider]: { apiKey } },
    sourceLang: "en",
    targetLang: "zh-CN",
    translateScope: "article",
    translateLimit: "all",
    features: {}
  };
}

test("TBM-01/02/09 popup borrow matches the vendor's own engine line, and fallback stays MyMemory", async () => {
  const popupJs = readFileSync(join(root, "popup/popup.js"), "utf8");
  const popupCss = readFileSync(join(root, "popup/popup.css"), "utf8");
  assert.match(popupJs, /引擎：\$\{shortName\}/);
  assert.match(popupJs, /link\.title = provider\.name/);
  assert.match(popupJs, /const ok = borrowed \|\|/);
  assert.equal(popupJs.includes("借用"), false);
  assert.equal(popupCss.includes("is-borrow"), false);

  const own = await bootPopup(popupSettings("kimi", "sk-own-kimi"), { multimodal: { provider: "kimi", apiKey: "", model: "" } });
  const borrowed = await bootPopup(popupSettings("openai", ""), mm({ model: "kimi-k2-0905-preview" }));
  assert.equal(borrowed.text, own.text);
  assert.equal(borrowed.title, own.title);
  assert.equal(borrowed.text, "引擎：Kimi");
  assert.equal(borrowed.title, "Kimi / 月之暗面");
  assert.equal(borrowed.warnHidden, true);
  assert.equal(borrowed.warnText, "");
  assert.equal(borrowed.body.includes("借用"), false);
  assert.equal(borrowed.body.includes("多模态"), false);
  assert.equal(borrowed.body.includes("MyMemory"), false);
  assert.equal(borrowed.body.includes("免费"), false);
  assert.equal(borrowed.body.includes("未配置引擎"), false);
  assert.equal(borrowed.body.includes("还没配置"), false);
  assert.equal(borrowed.body.includes("kimi-k2"), false);
  assert.equal(borrowed.body.includes(MM_KEY), false);

  const doubao = await bootPopup(
    popupSettings("openai", ""),
    { multimodal: { provider: "doubao", apiKey: MM_KEY, model: "glm-5.3-flash", baseUrl: "" } }
  );
  assert.equal(doubao.text, "引擎：豆包");
  assert.equal(doubao.title, "豆包");
  assert.equal(doubao.warnHidden, true);
  assert.equal(doubao.body.includes("MyMemory"), false);
  assert.equal(doubao.body.includes(MM_KEY), false);

  const fallback = await bootPopup(
    popupSettings("openai", ""),
    { multimodal: { provider: "kimi", apiKey: "", model: "" } }
  );
  assert.equal(fallback.text, "引擎：MyMemory（免费）");
  assert.match(fallback.warnText, /还没配置/);
  assert.match(fallback.warnText, /免费的 MyMemory/);
  assert.equal(fallback.warnHidden, false);
  assert.equal(fallback.title, fallback.warnText);
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
    const again = await sw.translateBatch(["World"], {});
    assert.equal(out[0], "你好");
    assert.equal(again[0], "你好");
    assert.equal(opts.borrowed, true);
    assert.equal(opts.providerCalled, false);
    assert.equal(opts.outboundFallback, false);
    assert.equal(urls.length, 2);
    assert.match(urls[0], /^https:\/\/api\.moonshot\.cn\/v1\/chat\/completions$/);
    const dumped = JSON.stringify(writes);
    assert.equal(dumped.includes(MM_KEY), false);
    assert.equal(logs.join("\n").includes(MM_KEY), false);
    const { handleArxivSourceMessage } = await import("../background/arxiv-source.js");
    await handleArxivSourceMessage({ action: "diag", message: { type: "OI_DIAG_STATS" } });
    const logged = writes.flatMap((patch) => patch?.["diag.events"] || []);
    const borrows = logged.filter((event) => event.type === "translate.borrow");
    assert.equal(borrows.length, 1);
    const borrowLog = borrows[0];
    assert.equal(borrowLog.ctx, "sw");
    assert.equal(borrowLog.provider, "kimi");
    assert.equal(borrowLog.model, "kimi-k2");
    assert.equal(borrowLog.reason, "translate-unconfigured");
    assert.equal(borrowLog.ok, true);
    assert.equal(borrowLog.code, undefined);
    const borrowPacked = JSON.stringify(borrowLog);
    assert.equal(borrowPacked.includes(MM_KEY), false);
    assert.equal(borrowPacked.includes("apiKey"), false);
    assert.equal(borrowPacked.includes("Authorization"), false);
    assert.equal(borrowPacked.includes("moonshot"), false);
    assert.equal(borrowPacked.includes("Hello"), false);
    assert.equal(borrowPacked.includes("World"), false);
    assert.equal(borrowPacked.includes("你好"), false);
    assert.equal(JSON.stringify(writes).includes(MM_KEY), false);
    for (const key of sw.translationCache.keys()) {
      assert.equal(String(key).includes(MM_KEY), false);
    }
    const adapter = getProvider("kimi");
    assert.equal(typeof adapter.translate, "function");
    const worker = readFileSync(join(root, "background/service-worker.js"), "utf8");
    const report = worker.slice(worker.indexOf("function reportTranslateBorrow"), worker.indexOf("function noteBorrowEpisode"));
    assert.match(report, /action: "diag-borrow"/);
    assert.equal(report.includes("apiKey"), false);
    assert.equal(report.includes("baseUrl"), false);
    assert.equal(report.includes("Authorization"), false);
    const reports = [...worker.matchAll(/reportTranslateBorrow\(\{[\s\S]*?\}\)/g)].map((match) => match[0]);
    assert.equal(reports.length, 2);
    for (const block of reports) {
      assert.match(block, /provider: outbound\.vendorId/);
      assert.match(block, /model: outbound\.model/);
      assert.equal(block.includes("apiKey"), false);
      assert.equal(block.includes("baseUrl"), false);
      assert.equal(block.includes("Authorization"), false);
    }
    const diag = readFileSync(join(root, "lib/diag-log.js"), "utf8");
    assert.match(diag, /reason: "translate-unconfigured"/);
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
