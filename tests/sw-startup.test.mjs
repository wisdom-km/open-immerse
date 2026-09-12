import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const swSource = readFileSync(join(root, "background/service-worker.js"), "utf8").replace(/\r\n/g, "\n");

function stubChrome(setImpl) {
  globalThis.chrome = {
    storage: {
      sync: {
        async get() {
          return { settings: { translateScope: "page" } };
        },
        set: setImpl
      },
      local: {
        async get() {
          return {};
        },
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
}

test("SW imports resolve and do not pull page-scan or site-presets", () => {
  const specifiers = [...swSource.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  assert.deepEqual(specifiers, [
    "../lib/providers.js",
    "../lib/storage.js",
    "../lib/learning.js",
    "../lib/features.js"
  ]);
  for (const spec of specifiers) {
    assert.equal(existsSync(join(root, "background", spec)), true, spec);
  }
  assert.equal(swSource.includes("page-scan"), false);
  assert.equal(swSource.includes("site-presets"), false);
  assert.equal(/^await /m.test(swSource), false);
});

test("SW cache version includes title-calque bust and guards cache hits", () => {
  assert.match(swSource, /CACHE_VER = "v5-title-calque"/);
  assert.match(swSource, /const cache = new Map\(\);\nconst CACHE_LIMIT = 2000;\nconst CACHE_VER = "v5-title-calque";\ncache\.clear\(\);/);
  assert.match(swSource, /onStartup\.addListener\(\(\) => \{\n  cache\.clear\(\);/);
  assert.match(swSource, /twoStepPolish: settings\.twoStepPolish === true/);
  assert.match(swSource, /isTwoStepPolish/);
  assert.match(swSource, /function readCachedTranslation\(key, text, targetLang\) \{\n  const \[guarded\] = guardZhTranslations\(\[text\], \[cache\.get\(key\)\], targetLang\);/);
  assert.match(swSource, /if \(cache\.has\(key\)\) results\[index\] = readCachedTranslation\(key, text, settings\.targetLang\);/);
  assert.match(
    swSource,
    /const guarded = guardZhTranslations\(\n      chunk\.map\(\(c\) => c\.text\),\n      translated,\n      settings\.targetLang\n    \);/
  );
  assert.match(swSource, /remember\(item\.key, value\);/);
  assert.match(swSource, /return guardZhTranslations\(texts, results, settings\.targetLang\);/);
  assert.match(swSource, /export \{ translateBatch, CACHE_VER, cache as translationCache \};/);
});

test("SW batch path cannot return or cache the exact Anvil title calque", async () => {
  const ANVIL_FAIL = "一千名小企业主让我们了解到了哪些关于人工智能的内容";
  const TITLE = "What 1,000 small business owners taught us about AI";
  stubChrome(async () => {});
  chrome.storage.sync.get = async () => ({
    settings: {
      provider: "openai",
      sourceLang: "en",
      targetLang: "zh-CN",
      twoStepPolish: true,
      batchSize: 8,
      settingsVersion: 7,
      articleScopeMigrated: true,
      providers: {
        openai: { apiKey: "sk-test", baseUrl: "https://api.example.com/v1", model: "test-model", prompt: "" }
      }
    }
  });
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content: `1. ${ANVIL_FAIL}` } }] };
    }
  });
  try {
    const sw = await import(`../background/service-worker.js?anvil=${Date.now()}`);
    assert.equal(sw.CACHE_VER, "v5-title-calque");
    const out = await sw.translateBatch([TITLE]);
    assert.doesNotMatch(out[0], /让我们了解到/);
    assert.doesNotMatch(out[0], /哪些关于.+的内容/);
    assert.match(out[0], /小企业主/);
    assert.ok(sw.translationCache.size > 0);
    for (const value of sw.translationCache.values()) {
      assert.doesNotMatch(String(value), /让我们了解到/);
    }
    for (const key of sw.translationCache.keys()) {
      sw.translationCache.set(key, ANVIL_FAIL);
    }
    const cached = await sw.translateBatch([TITLE]);
    assert.doesNotMatch(cached[0], /让我们了解到/);
    for (const value of sw.translationCache.values()) {
      assert.doesNotMatch(String(value), /让我们了解到/);
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("SW lib graph evaluates under chrome stubs", async () => {
  stubChrome(async () => {});
  await import(`../lib/features.js?sw=${Date.now()}`);
  await import(`../lib/providers.js?sw=${Date.now()}`);
  await import(`../lib/learning.js?sw=${Date.now()}`);
  await import(`../lib/storage.js?sw=${Date.now()}`);
});

test("getSettings still returns article settings when sync.set throws", async () => {
  stubChrome(async () => {
    throw new Error("quota");
  });
  const { getSettings } = await import(`../lib/storage.js?setfail=${Date.now()}`);
  const settings = await getSettings();
  assert.equal(settings.translateScope, "article");
  assert.ok(settings.settingsVersion >= 6);
});

test("getSettings still returns defaults when sync.get throws", async () => {
  stubChrome(async () => {});
  chrome.storage.sync.get = async () => {
    throw new Error("storage down");
  };
  const { getSettings } = await import(`../lib/storage.js?getfail=${Date.now()}`);
  const settings = await getSettings();
  assert.equal(settings.translateScope, "article");
  assert.equal(typeof settings.provider, "string");
});
