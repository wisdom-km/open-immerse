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
  assert.match(swSource, /enableThinking: settings\.enableThinking === true/);
  assert.match(swSource, /isTwoStepPolish/);
  assert.match(swSource, /isThinkingEnabled/);
  assert.match(swSource, /const think = isThinkingEnabled\(settings\) \? "think" : "fast"/);
  assert.match(swSource, /function readCachedTranslation\(key, text, targetLang\) \{\n  const \[guarded\] = guardZhTranslations\(\[text\], \[cache\.get\(key\)\], targetLang\);/);
  assert.match(swSource, /if \(cache\.has\(key\)\) results\[index\] = readCachedTranslation\(key, text, settings\.targetLang\);/);
  assert.match(
    swSource,
    /const guarded = guardZhTranslations\(\n      chunk\.map\(\(c\) => c\.text\),\n      translated,\n      settings\.targetLang\n    \);/
  );
  assert.match(swSource, /remember\(item\.key, value\);/);
  assert.match(swSource, /return guardZhTranslations\(texts, results, settings\.targetLang\);/);
  assert.match(swSource, /export \{ translateBatch, CACHE_VER, cache as translationCache \};/);
  assert.match(swSource, /OI_TRANSLATE_PROGRESS/);
  assert.match(swSource, /phase: progress\.phase/);
  assert.match(swSource, /onProgress: \(progress\) => emitTranslateProgress\(sender, message\.requestId, progress\)/);
  assert.match(swSource, /polishError: "润色失败"/);
  assert.match(swSource, /err\?\.polishFailed/);
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

test("two-step translateBatch emits guarded draft then returns final", async () => {
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
  let n = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    const content = n === 1 ? "1. 草稿你好" : "1. 你好呀";
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] };
      }
    };
  };
  try {
    const sw = await import(`../background/service-worker.js?draft=${Date.now()}`);
    const progress = [];
    const out = await sw.translateBatch(["Hello"], {
      onProgress: (p) => progress.push({ phase: p.phase, translations: [...p.translations] })
    });
    assert.deepEqual(progress, [{ phase: "draft", translations: ["草稿你好"] }]);
    assert.deepEqual(out, ["你好呀"]);
    assert.equal(n, 2);
    for (const value of sw.translationCache.values()) {
      assert.equal(value, "你好呀");
      assert.notEqual(value, "草稿你好");
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("two-step translateBatch guards draft before onProgress and does not cache it", async () => {
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
  let n = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    const content = n === 1 ? `1. ${ANVIL_FAIL}` : "1. 一千名小企业主给我们的人工智能";
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] };
      }
    };
  };
  try {
    const sw = await import(`../background/service-worker.js?draftguard=${Date.now()}`);
    const progress = [];
    const out = await sw.translateBatch([TITLE], {
      onProgress: (p) => {
        progress.push([...p.translations]);
        assert.equal(sw.translationCache.size, 0);
      }
    });
    assert.equal(progress.length, 1);
    assert.doesNotMatch(progress[0][0], /让我们了解到/);
    assert.doesNotMatch(progress[0][0], /哪些关于.+的内容/);
    assert.match(progress[0][0], /小企业主/);
    assert.doesNotMatch(out[0], /让我们了解到/);
    assert.match(out[0], /小企业主/);
    for (const value of sw.translationCache.values()) {
      assert.doesNotMatch(String(value), /让我们了解到/);
      assert.equal(String(value).includes(ANVIL_FAIL), false);
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("single-shot translateBatch does not emit draft progress", async () => {
  stubChrome(async () => {});
  chrome.storage.sync.get = async () => ({
    settings: {
      provider: "openai",
      sourceLang: "en",
      targetLang: "zh-CN",
      twoStepPolish: false,
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
      return { choices: [{ message: { content: "1. 你好" } }] };
    }
  });
  try {
    const sw = await import(`../background/service-worker.js?single=${Date.now()}`);
    const progress = [];
    const out = await sw.translateBatch(["Hello"], { onProgress: (p) => progress.push(p) });
    assert.deepEqual(out, ["你好"]);
    assert.deepEqual(progress, []);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("OI_TRANSLATE_BATCH forwards draft progress to the page tab", async () => {
  const sent = [];
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
  chrome.tabs.sendMessage = async (tabId, msg, opts) => {
    sent.push({ via: "tabs", tabId, msg, opts });
  };
  chrome.runtime.sendMessage = async (msg) => {
    sent.push({ via: "runtime", msg });
  };
  let handler = null;
  chrome.runtime.onMessage.addListener = (fn) => {
    handler = fn;
  };
  let n = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    const content = n === 1 ? "1. 草稿你好" : "1. 你好呀";
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] };
      }
    };
  };
  try {
    await import(`../background/service-worker.js?protocol=${Date.now()}`);
    assert.equal(typeof handler, "function");
    const result = await new Promise((resolve, reject) => {
      const ok = handler(
        { type: "OI_TRANSLATE_BATCH", texts: ["Hello"], requestId: "req-1" },
        { tab: { id: 3 }, frameId: 0, url: "https://example.com/post" },
        resolve
      );
      if (!ok) reject(new Error("listener must return true"));
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.translations, ["你好呀"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].via, "tabs");
    assert.equal(sent[0].tabId, 3);
    assert.deepEqual(sent[0].opts, { frameId: 0 });
    assert.deepEqual(sent[0].msg, {
      type: "OI_TRANSLATE_PROGRESS",
      requestId: "req-1",
      phase: "draft",
      translations: ["草稿你好"]
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("OI_TRANSLATE_BATCH forwards draft progress to documents via runtime", async () => {
  const sent = [];
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
  chrome.tabs.sendMessage = async (tabId, msg, opts) => {
    sent.push({ via: "tabs", tabId, msg, opts });
  };
  chrome.runtime.sendMessage = async (msg) => {
    sent.push({ via: "runtime", msg });
  };
  let handler = null;
  chrome.runtime.onMessage.addListener = (fn) => {
    handler = fn;
  };
  let n = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    const content = n === 1 ? "1. 草稿你好" : "1. 你好呀";
    return {
      ok: true,
      status: 200,
      async json() {
        return { choices: [{ message: { content } }] };
      }
    };
  };
  try {
    await import(`../background/service-worker.js?docs=${Date.now()}`);
    const result = await new Promise((resolve) => {
      handler(
        { type: "OI_TRANSLATE_BATCH", texts: ["Hello"], requestId: "doc-1" },
        { tab: { id: 9 }, url: "chrome-extension://abc/documents/documents.html" },
        resolve
      );
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.translations, ["你好呀"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].via, "runtime");
    assert.deepEqual(sent[0].msg, {
      type: "OI_TRANSLATE_PROGRESS",
      requestId: "doc-1",
      phase: "draft",
      translations: ["草稿你好"]
    });
    assert.equal(result.polishError, undefined);
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test("polish failure keeps draft, skips cache, and returns short polishError", async () => {
  const sent = [];
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
  chrome.tabs.sendMessage = async (tabId, msg, opts) => {
    sent.push({ via: "tabs", tabId, msg, opts });
  };
  let handler = null;
  chrome.runtime.onMessage.addListener = (fn) => {
    handler = fn;
  };
  let n = 0;
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    n += 1;
    if (n === 1) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { choices: [{ message: { content: "1. 草稿你好" } }] };
        }
      };
    }
    return { ok: false, status: 500, async json() { return {}; } };
  };
  try {
    const sw = await import(`../background/service-worker.js?polishfail=${Date.now()}`);
    const progress = [];
    const batchOpts = {
      onProgress: (p) => {
        progress.push([...p.translations]);
        assert.equal(sw.translationCache.size, 0);
      }
    };
    const out = await sw.translateBatch(["Hello"], batchOpts);
    assert.deepEqual(progress, [["草稿你好"]]);
    assert.deepEqual(out, ["草稿你好"]);
    assert.equal(batchOpts.polishFailed, true);
    assert.equal(sw.translationCache.size, 0);

    n = 0;
    const result = await new Promise((resolve) => {
      handler(
        { type: "OI_TRANSLATE_BATCH", texts: ["World"], requestId: "pf-1" },
        { tab: { id: 3 }, frameId: 0, url: "https://example.com/post" },
        resolve
      );
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.translations, ["草稿你好"]);
    assert.equal(result.polishError, "润色失败");
    assert.equal(sent.at(-1).msg.phase, "draft");
    assert.deepEqual(sent.at(-1).msg.translations, ["草稿你好"]);
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
