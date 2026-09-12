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
