import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { mock } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

import { FORMULA_SWITCH_KEYS } from "../lib/formula-settings.js";
import { deliverAsk, renderAskNotice, resolveAskTarget, ASK_EMPTY } from "../lib/ask-route.js";
import { getSettings, noteTranslationSucceeded, saveSettings, SETTINGS_VERSION } from "../lib/storage.js";
import { mergeLiveSecrets, prepareSettingsImport, sealSettingsPatch, settingsForExport, settingsImportHasChanges } from "../lib/settings-secrets.js";
import { normalizeAttention } from "../lib/provider-attention.js";
import { parseSettingsHash, SETTINGS_PAGES } from "../options/route.js";

const realBroadcastChannel = globalThis.BroadcastChannel;
class MemoryBroadcastChannel {
  constructor() {
    this.onmessage = null;
  }
  postMessage() {}
  close() {}
}
test.after(() => {
  globalThis.BroadcastChannel = realBroadcastChannel;
});

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OPENAI_KEY = "sk-testKEY3f9a";
const PDF_KEY = "pdf-secret-99abcd";
const MM_KEY = "sk-mmmmmmmmWXYZ";
const OCR_KEY = "sk-ooooooooABCD";

function memoryLocalStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    key(index) {
      return [...map.keys()][index] ?? null;
    },
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(String(key), String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    }
  };
}

function providerKeyText(value) {
  if (value && typeof value === "object") return String(value.apiKey || "");
  return String(value || "");
}

function payloadHasProviderKey(patch, bag) {
  const pairs = [
    [patch?.oiSecrets?.providers, bag?.oiSecrets?.providers],
    [patch?.settings?.providers, bag?.settings?.providers]
  ];
  return pairs.some(([next, prev]) => next && Object.entries(next).some(([id, value]) => {
    const key = providerKeyText(value);
    if (!key.trim()) return false;
    return key !== providerKeyText(prev?.[id]);
  }));
}

const lockState = new Map();
const heldReleases = new Set();

function releaseHeldEngineLocks() {
  for (const drop of [...heldReleases]) drop();
}

function sharedEngineLocks() {
  return {
    request(name, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      const state = lockState.get(name) || { chain: Promise.resolve(), held: false };
      lockState.set(name, state);
      if (options?.ifAvailable && state.held) return Promise.resolve().then(() => callback(null));
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const prev = state.chain;
      state.chain = prev.then(() => gate, () => gate);
      let dropped = false;
      const drop = () => {
        if (dropped) return;
        dropped = true;
        state.held = false;
        heldReleases.delete(drop);
        release();
      };
      return prev.then(() => {
        state.held = true;
        heldReleases.add(drop);
        return callback({ name, mode: "exclusive" });
      }, () => {
        state.held = true;
        heldReleases.add(drop);
        return callback({ name, mode: "exclusive" });
      }).finally(() => drop());
    }
  };
}

function installChrome(seed = {}) {
  const sync = { settings: seed.settings || {} };
  const local = { ...(seed.local || {}) };
  const listeners = [];
  const calls = [];
  const api = {
    sync,
    local,
    calls,
    failGet: false,
    failSave: false,
    localSetThrows: false,
    holdGet: null,
    holdNextSecretRead: null,
    holdNextWrite: null,
    holdNextSecretWrite: null,
    holdNextSyncSet: null,
    failHeldSync: false,
    failNextKeyCommit: false,
    failClearTimes: 0,
    legacyBackground: false
  };
  function area(bag, name) {
    return {
      async get(key) {
        if (name === "local" && key === "oiSecrets" && api.holdNextSecretRead) {
          const gate = api.holdNextSecretRead;
          api.holdNextSecretRead = null;
          await gate;
        }
        if (Array.isArray(key)) {
          const out = {};
          for (const item of key) if (Object.prototype.hasOwnProperty.call(bag, item)) out[item] = bag[item];
          return out;
        }
        if (typeof key === "string") return { [key]: bag[key] };
        return { ...bag };
      },
      async set(patch) {
        if (name === "local" && api.localSetThrows) throw new Error("local quota");
        if (name === "sync" && api.failNextSync) {
          api.failNextSync = false;
          throw new Error("sync quota");
        }
        if (api.holdNextWrite && payloadHasProviderKey(patch, bag)) {
          const gate = api.holdNextWrite;
          api.holdNextWrite = null;
          await gate;
        }
        if (name === "local" && api.holdNextSecretWrite && payloadHasProviderKey(patch, bag)) {
          const gate = api.holdNextSecretWrite;
          api.holdNextSecretWrite = null;
          await gate;
        }
        if (name === "sync" && api.holdNextSyncSet) {
          const gate = api.holdNextSyncSet;
          api.holdNextSyncSet = null;
          await gate;
        }
        if (name === "sync" && api.failHeldSync) {
          api.failHeldSync = false;
          throw new Error("sync quota");
        }
        if (name === "local" && api.failNextKeyCommit && payloadHasProviderKey(patch, bag)) {
          api.failNextKeyCommit = false;
          throw new Error("local commit failed");
        }
        Object.assign(bag, patch);
        const changes = {};
        for (const [item, value] of Object.entries(patch)) changes[item] = { newValue: value };
        for (const listener of listeners) listener(changes, name);
      }
    };
  }
  globalThis.chrome = {
    runtime: {
      getManifest: () => ({ version: "0.3.0" }),
      getURL: (path) => `chrome-extension://oi/${path}`,
      async sendMessage(message) {
        calls.push(message);
        if (message.type === "OI_GET_SETTINGS") {
          if (api.holdGet) await api.holdGet;
          if (api.failGet) throw new Error("read failed");
          if (api.legacyBackground) {
            const bag = await globalThis.chrome.storage.sync.get("settings");
            return { ok: true, settings: JSON.parse(JSON.stringify(bag.settings || {})) };
          }
          const settings = await getSettings();
          return { ok: true, settings };
        }
        if (message.type === "OI_SAVE_SETTINGS") {
          if (api.failSave) return { ok: false };
          if (message.clear?.providers?.length && api.failClearTimes > 0) {
            api.failClearTimes -= 1;
            return { ok: false };
          }
          if (message.keySeq && api.failKeySeq && Object.values(message.keySeq).some((n) => Number(n) === Number(api.failKeySeq))) {
            api.failNextSync = true;
          }
          if (api.legacyBackground) {
            const bag = await globalThis.chrome.storage.sync.get("settings");
            const current = JSON.parse(JSON.stringify(bag.settings || {}));
            const next = legacyBackgroundMerge(current, JSON.parse(JSON.stringify(message.patch || {})));
            try {
              await globalThis.chrome.storage.sync.set({ settings: next });
            } catch (err) {
              console.error("Open Immerse: storage.sync.set failed", err);
            }
            return { ok: true, settings: next };
          }
          const settings = await saveSettings(message.patch, message.clear || {}, message.keySeq);
          return { ok: settings.settingsSaved !== false, settings };
        }
        if (message.type === "OI_TEST_PROVIDER") {
          const canned = api.testProviderResult;
          return typeof canned === "function" ? canned() : (canned || { ok: true, text: "probe" });
        }
        if (message.type === "OI_DIAG_LOG" || message.type === "OI_DIAG_EXPORT" || message.type === "OI_DIAG_CLEAR" || message.type === "OI_DIAG_STATS") {
          const diag = await import("../lib/diag-log.js");
          diag.installServiceWorkerDiag({
            storage: globalThis.chrome.storage.local,
            sync: globalThis.chrome.storage.sync
          });
          return diag.handleDiagMessage(message);
        }
        return { ok: false };
      }
    },
    storage: {
      sync: area(sync, "sync"),
      local: area(local, "local"),
      onChanged: {
        addListener(fn) {
          listeners.push(fn);
        },
        removeListener(fn) {
          const index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        }
      }
    },
    tabs: { create() {} }
  };
  return api;
}

function syncHasSecrets(settings) {
  if (!settings || typeof settings !== "object") return false;
  for (const cfg of Object.values(settings.providers || {})) {
    if (cfg && String(cfg.apiKey || "").trim()) return true;
  }
  if (String(settings.pdfLayout?.cloudApiKey || "").trim()) return true;
  const formula = settings.formulaSettings;
  if (formula && typeof formula === "object") {
    if (String(formula.multimodal?.apiKey || "").trim()) return true;
    if (String(formula.ocr?.apiKey || "").trim()) return true;
  }
  return false;
}

function savedSettings() {
  return {
    settingsVersion: SETTINGS_VERSION,
    provider: "openai",
    sourceLang: "auto",
    targetLang: "zh-CN",
    features: { pdf: false },
    providers: {
      openai: { apiKey: OPENAI_KEY, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
    },
    pdfLayout: {
      mode: "",
      localBaseUrl: "http://127.0.0.1:8765",
      cloudBaseUrl: "https://open.bigmodel.cn/api/paas/v4/layout_parsing",
      cloudApiKey: PDF_KEY
    }
  };
}

function formulaSeed() {
  return {
    [FORMULA_SWITCH_KEYS.tier2]: true,
    [FORMULA_SWITCH_KEYS.ocr]: true,
    multimodal: { provider: "openai", apiKey: MM_KEY, model: "gpt-4o", baseUrl: "https://api.openai.com/v1" },
    ocr: { provider: "zhipu", apiKey: OCR_KEY }
  };
}

test("secret migration, import, and rollback stay inside local storage", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  const first = await getSettings();
  assert.equal(first.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(first.pdfLayout.cloudApiKey, PDF_KEY);
  assert.equal(syncHasSecrets(chrome.sync.settings), false);
  assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
  assert.equal(chrome.local.oiSecrets.pdfCloudApiKey, PDF_KEY);
  const second = await getSettings();
  assert.equal(second.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
  assert.equal(syncHasSecrets(chrome.sync.settings), false);

  const fresh = installChrome({ settings: savedSettings() });
  fresh.localSetThrows = true;
  const rolled = await getSettings();
  assert.equal(rolled.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(fresh.sync.settings.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(fresh.local.oiSecrets, undefined);

  const writing = installChrome({ settings: savedSettings() });
  await getSettings();
  writing.localSetThrows = true;
  const failed = await saveSettings({ fontScale: 1.1, providers: { openai: { apiKey: "sk-should-not-land" } } });
  assert.equal(failed.settingsSaved, false);
  assert.equal(writing.sync.settings.fontScale, 0.95);
  assert.notEqual(writing.sync.settings.fontScale, 1.1);
  assert.equal(writing.local.oiSecrets.providers.openai, OPENAI_KEY);
  assert.equal(syncHasSecrets(writing.sync.settings), false);

  const importing = installChrome({
    settings: { settingsVersion: SETTINGS_VERSION, provider: "openai", providers: { openai: { apiKey: "" } } },
    local: { oiSecrets: { providers: { openai: OPENAI_KEY }, pdfCloudApiKey: "" } }
  });
  await getSettings();
  const prepared = prepareSettingsImport({
    settings: {
      settingsVersion: SETTINGS_VERSION,
      fontScale: 1.15,
      providers: { openai: { apiKey: "sk-from-file-9999" } },
      pdfLayout: { cloudApiKey: "cloud-from-file" },
      formulaSettings: { multimodal: { apiKey: "mm-from-file" }, ocr: { apiKey: "ocr-from-file" } }
    }
  });
  assert.equal(prepared.ignoredKeys, true);
  assert.equal(prepared.settings.formulaSettings, undefined);
  assert.equal(String(prepared.settings.providers?.openai?.apiKey || ""), "");
  const imported = await saveSettings(prepared.settings);
  assert.equal(imported.settingsSaved, true);
  assert.equal(imported.fontScale, 1.15);
  assert.equal(imported.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(importing.local.oiSecrets.providers.openai, OPENAI_KEY);
  assert.equal(syncHasSecrets(importing.sync.settings), false);
  const exported = settingsForExport(imported);
  assert.equal(syncHasSecrets(exported), false);
  assert.equal(exported.providers.openai.apiKey, undefined);
  assert.equal(exported.oiProviderAttention, undefined);
  const aliased = prepareSettingsImport({
    settings: {
      targetLang: "ja",
      tokenLimit: 4096,
      secretly: "keep-secretly",
      passwordHint: "keep-hint",
      tokenizer: "keep-tokenizer",
      pdfCloudApiKey: "top-level-pdf",
      oiSecrets: { providers: { openai: "bag-key" } },
      client_secret: "top-client",
      clientSecret: "top-client-camel",
      bearer: "top-bearer",
      Bearer: "top-bearer-case",
      cloud_api_key: "top-cloud",
      "access-token": "top-access",
      arxiv: { key: "keep-arxiv" },
      shortcuts: { key: "keep-hotkey", keys: "keep-keys" },
      headers: { "Content-Type": "application/json" },
      placeholders: [{ token: "keep-placeholder-token", client_secret: "array-client" }],
      providers: {
        openai: { apiKey: "sk-file", api_key: "alias-key", baseUrl: "https://api.openai.com/v1" },
        custom: {
          headers: { "x-api-key": "header-key", accessToken: "token-key", authorization: "auth-key" },
          nested: { apiKey: "deep-key", client_secret: "nested-client", bearer: "nested-bearer", cloud_api_key: "nested-cloud", "access-token": "nested-access" },
          list: [{ password: "array-password", secret: "array-secret", access_token: "array-access" }],
          tokenLimit: 2048
        }
      }
    }
  });
  assert.equal(aliased.ignoredKeys, true);
  assert.equal(aliased.settings.targetLang, "ja");
  assert.equal(aliased.settings.tokenLimit, 4096);
  assert.equal(aliased.settings.secretly, "keep-secretly");
  assert.equal(aliased.settings.passwordHint, "keep-hint");
  assert.equal(aliased.settings.tokenizer, "keep-tokenizer");
  assert.equal(aliased.settings.arxiv.key, "keep-arxiv");
  assert.equal(aliased.settings.shortcuts.key, "keep-hotkey");
  assert.equal(aliased.settings.shortcuts.keys, "keep-keys");
  assert.equal(aliased.settings.headers["Content-Type"], "application/json");
  assert.equal(aliased.settings.placeholders[0].token, "keep-placeholder-token");
  assert.equal(aliased.settings.placeholders[0].client_secret, undefined);
  assert.equal(aliased.settings.providers.openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(aliased.settings.providers.custom.tokenLimit, 2048);
  const aliasedText = JSON.stringify(aliased.settings);
  for (const secret of [
    "top-level-pdf", "bag-key", "sk-file", "alias-key", "header-key", "token-key", "deep-key",
    "top-client", "top-client-camel", "top-bearer", "top-bearer-case", "top-cloud", "top-access",
    "array-client", "nested-client", "nested-bearer", "nested-cloud", "nested-access",
    "auth-key", "array-password", "array-secret", "array-access"
  ]) {
    assert.equal(aliasedText.includes(secret), false, secret);
  }
  const onlySecrets = prepareSettingsImport({
    settings: {
      client_secret: "only-client",
      bearer: "only-bearer",
      cloud_api_key: "only-cloud",
      "access-token": "only-access",
      providers: [{ clientSecret: "only-nested" }],
      list: [{ bearer: "only-array" }]
    }
  });
  assert.equal(onlySecrets.ignoredKeys, true);
  const onlyText = JSON.stringify(onlySecrets.settings);
  for (const secret of ["only-client", "only-bearer", "only-cloud", "only-access", "only-nested", "only-array"]) {
    assert.equal(onlyText.includes(secret), false, secret);
  }
  const savedAliases = await saveSettings(aliased.settings);
  assert.equal(savedAliases.settingsSaved, true);
  const storedText = JSON.stringify(importing.sync.settings);
  for (const secret of ["top-client", "top-bearer", "top-cloud", "top-access", "nested-client", "array-password", "alias-key"]) {
    assert.equal(storedText.includes(secret), false, secret);
  }
  assert.equal(importing.sync.settings.tokenLimit, 4096);
  assert.equal(importing.sync.settings.placeholders[0].token, "keep-placeholder-token");
  const exportedAliases = settingsForExport(savedAliases);
  const exportedText = JSON.stringify(exportedAliases);
  for (const secret of ["top-client", "top-bearer", "top-cloud", "top-access", "nested-bearer", "array-access", OPENAI_KEY]) {
    assert.equal(exportedText.includes(secret), false, secret);
  }
  assert.equal(exportedAliases.tokenLimit, 4096);
  assert.equal(exportedAliases.placeholders[0].token, "keep-placeholder-token");
  assert.equal(exportedAliases.secretly, "keep-secretly");
  const round = settingsForExport({
    providers: { openai: { apiKey: "should-not-export", baseUrl: "https://api.openai.com/v1" } },
    extra: { access_token: "nope", client_secret: "nope-client", bearer: "nope-bearer", cloud_api_key: "nope-cloud", "access-token": "nope-access" }
  });
  const roundText = JSON.stringify(round);
  for (const secret of ["should-not-export", "nope", "nope-client", "nope-bearer", "nope-cloud", "nope-access"]) {
    assert.equal(roundText.includes(secret), false, secret);
  }
});

/** 887ecd2 merge: providers are deep-merged, pdfLayout is replaced wholesale. */
function legacyBackgroundMerge(base, patch) {
  const out = { ...base, ...patch };
  if (base.providers || patch.providers) {
    out.providers = { ...base.providers };
    const incoming = patch.providers || {};
    for (const [id, cfg] of Object.entries(incoming)) {
      out.providers[id] = { ...(base.providers?.[id] || {}), ...cfg };
    }
  }
  return out;
}

test("export then import keeps keys when the old background is still running", async () => {
  const stored = savedSettings();
  const exported = settingsForExport(stored);
  const prepared = prepareSettingsImport({
    settings: { ...exported, targetLang: "ja", oiProviderAttention: { openai: OPENAI_KEY } }
  });
  const patch = sealSettingsPatch(prepared.settings, { pdfCloudApiKey: PDF_KEY });
  assert.equal(exported.providers.openai.apiKey, undefined);
  assert.equal(exported.pdfLayout.cloudApiKey, undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(patch.providers.openai, "apiKey"), false);
  assert.equal(patch.pdfLayout.cloudApiKey, PDF_KEY);
  assert.equal(patch.targetLang, "ja");
  assert.equal(patch.oiProviderAttention, undefined);
  assert.equal(JSON.stringify(patch).includes(OPENAI_KEY), false);

  const syncBag = { settings: JSON.parse(JSON.stringify(stored)) };
  const localBag = { oiSecrets: { providers: { openai: OPENAI_KEY }, pdfCloudApiKey: PDF_KEY } };
  syncBag.settings = legacyBackgroundMerge(syncBag.settings, patch);
  assert.equal(syncBag.settings.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(syncBag.settings.pdfLayout.cloudApiKey, PDF_KEY);
  assert.equal(syncBag.settings.targetLang, "ja");
  assert.equal(localBag.oiSecrets.providers.openai, OPENAI_KEY);
  assert.equal(localBag.oiSecrets.pdfCloudApiKey, PDF_KEY);

  const chrome = installChrome({ settings: savedSettings() });
  await getSettings();
  const roundTrip = sealSettingsPatch(
    prepareSettingsImport({ settings: { ...settingsForExport(await getSettings()), targetLang: "ja" } }).settings,
    { pdfCloudApiKey: PDF_KEY }
  );
  const imported = await saveSettings(roundTrip);
  assert.equal(imported.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(imported.pdfLayout.cloudApiKey, PDF_KEY);
  assert.equal(imported.targetLang, "ja");
  assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
  assert.equal(chrome.local.oiSecrets.pdfCloudApiKey, PDF_KEY);
  assert.equal(syncHasSecrets(chrome.sync.settings), false);

  const kept = await saveSettings({ providers: { openai: { apiKey: "" } }, pdfLayout: { cloudApiKey: "" } });
  assert.equal(kept.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(kept.pdfLayout.cloudApiKey, PDF_KEY);
  assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
  const cleared = await saveSettings({ providers: { openai: { apiKey: "" } } }, { providers: ["openai"] });
  assert.equal(cleared.providers.openai.apiKey, "");
  assert.equal(chrome.local.oiSecrets.providers.openai, "");
  assert.deepEqual(normalizeAttention({ openai: OPENAI_KEY, deepl: true, "": true, custom: 1 }), { deepl: true });
});

test("ask routing never calls the network and does not fall back from multimodal", async () => {
  const llm = { provider: "openai", providers: { openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" } } };
  const mm = formulaSeed();
  const sent = [];
  const target = resolveAskTarget(llm, mm);
  assert.equal(target.via, "multimodal");
  assert.equal(target.provider, "openai");
  assert.equal(target.model, "gpt-4o");
  const failed = await deliverAsk(target, async (req) => {
    sent.push(req);
    return { ok: false, error: "nope" };
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url.includes("api.openai.com"), true);
  assert.equal(failed.fallback, false);
  assert.equal(failed.ok, false);

  const plain = resolveAskTarget(llm, { multimodal: { provider: "", apiKey: "" } });
  assert.equal(plain.via, "translation");
  assert.equal(plain.model, "gpt-4o-mini");
  const custom = resolveAskTarget(
    { provider: "custom", providers: { custom: { url: "https://example.test/translate" } } },
    {}
  );
  assert.equal(custom.ok, false);
  assert.equal(custom.message, ASK_EMPTY);

  const previousDocument = globalThis.document;
  globalThis.document = {
    createElement() {
      return { textContent: "", href: "" };
    }
  };
  const host = { children: [], replaceChildren() { this.children = []; }, append(...nodes) { this.children.push(...nodes); } };
  const notice = renderAskNotice(host, custom);
  assert.equal(notice.children[0].textContent, ASK_EMPTY);
  assert.equal(notice.children[1].textContent, "去设置");
  assert.match(notice.children[1].href, /#mm$/);
  globalThis.document = previousDocument;

  const removed = resolveAskTarget(llm, { ...mm, multimodal: { ...mm.multimodal, apiKey: "" } });
  assert.equal(removed.via, "translation");
  const restored = resolveAskTarget(llm, mm);
  assert.equal(restored.via, "multimodal");
});

test("settings routes redirect old anchors and keep eight pages", () => {
  assert.deepEqual(SETTINGS_PAGES.map((page) => page.id), ["translate", "mm", "web", "pdf", "notes", "labs", "data", "about"]);
  assert.equal(SETTINGS_PAGES.filter((page) => page.group === "常规").map((page) => page.label).join("|"), "翻译|多模态 · OCR");
  for (const [from, to] of [["engine", "translate"], ["reading", "pdf"], ["features", "web"], ["advanced", "labs"], ["ai", "mm"], ["formula", "mm"]]) {
    const parsed = parseSettingsHash(`#${from}`);
    assert.equal(parsed.id, to);
    assert.equal(parsed.redirected, true);
    assert.equal(parsed.replace, `#${to}`);
  }
  const focus = parseSettingsHash("#data?focus=export");
  assert.equal(focus.id, "data");
  assert.equal(focus.focus, "export");
  assert.equal(focus.replace, "#data");
  assert.equal(parseSettingsHash("#data?focus=nope").focus, "");
  assert.equal(parseSettingsHash("#nope").id, "translate");
  assert.equal(parseSettingsHash("").id, "translate");
});

function contrast(a, b) {
  const lum = (hex) => {
    const n = hex.replace("#", "");
    const rgb = [0, 2, 4].map((i) => {
      const c = parseInt(n.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  };
  const [hi, lo] = lum(a) > lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(base, rgba) {
  const n = base.replace("#", "");
  const br = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
  const parts = rgba.match(/rgba\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*\)/);
  const alpha = Number(parts[4]);
  const fg = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const mixed = br.map((channel, i) => Math.round(fg[i] * alpha + channel * (1 - alpha)));
  return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

test("palette A contrast and scope stay on the settings page", () => {
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  const block = css.match(/body\.oi-settings\s*\{[^}]+\}/)[0];
  const tokens = Object.fromEntries([...block.matchAll(/--(oi-[\w-]+):\s*([^;]+);/g)].map((hit) => [hit[1], hit[2].trim()]));
  const value = (name) => {
    let current = tokens[name];
    const ref = current.match(/^var\(--(oi-[\w-]+)\)$/);
    if (ref) current = tokens[ref[1]];
    return current;
  };
  assert.equal(block.includes("color-scheme: light"), true);
  const panel = value("oi-panel");
  const text = value("oi-text");
  const note = value("oi-text-2");
  const muted = value("oi-text-muted");
  const side = value("oi-bg-elevated");
  const warn = value("oi-warn");
  const warnBg = mix(panel, value("oi-warn-soft"));
  assert.ok(contrast(text, panel) >= 4.5);
  assert.ok(contrast(note, panel) >= 4.5);
  assert.ok(contrast(muted, panel) >= 4.5);
  assert.ok(contrast(muted, side) >= 4.5);
  assert.ok(contrast(value("oi-accent"), panel) >= 4.5);
  assert.ok(contrast(value("oi-on-accent"), value("oi-primary")) >= 4.5);
  assert.ok(contrast(warn, warnBg) >= 4.5);
  assert.ok(contrast(note, warnBg) >= 4.5);
  assert.ok(contrast(value("oi-line-strong"), value("oi-input")) >= 3);
  const forbidden = ["#12151c", "#181c26", "#1e2430", "#232a38", "#171b24", "#6b8cff", "#e8a0a0"];
  for (const color of Object.values(tokens)) {
    assert.equal(forbidden.includes(color.toLowerCase()), false);
  }
  const own = css.replace(/@import[^;]+;/, "").replace(/body\.oi-settings\s*\{[^}]+\}/g, "");
  for (const color of forbidden) assert.equal(own.toLowerCase().includes(color), false);
  // SET-41 checks content. History on pdf/ stays red after the five approved
  // viewer.js changes, so that directory is read instead of filtered by log.
  // `git diff A B` compares two commits and ignores the worktree. The second
  // call compares the files on disk with e4f464d, so an uncommitted edit fails.
  const scope = ["ui/tokens.css", "lib/notes-prefs.js", "lib/reader-notes-local.js"];
  execFileSync("git", ["diff", "--quiet", "e4f464d", "HEAD", "--", ...scope]);
  execFileSync("git", ["diff", "--quiet", "e4f464d", "--", ...scope]);
  const shared = new Set([...readFileSync(join(root, "ui/tokens.css"), "utf8").matchAll(/--(oi-[\w-]+)\s*:/g)].map((hit) => hit[1]));
  const settingsPalette = Object.keys(tokens).filter((name) => !shared.has(name));
  assert.ok(settingsPalette.length > 0);
  const walk = (dir) => {
    const found = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(path));
      else if (entry.isFile() && /\.(?:css|js|mjs|html)$/.test(entry.name)) found.push(path);
    }
    return found;
  };
  for (const file of walk(join(root, "pdf"))) {
    const src = readFileSync(file, "utf8");
    const rel = file.slice(root.length + 1);
    assert.equal(/body\.oi-settings/.test(src), false, `${rel} has a body.oi-settings selector`);
    for (const name of settingsPalette) {
      assert.equal(src.includes(`--${name}`), false, `${rel} has settings palette --${name}`);
    }
  }
  for (const path of [
    "tests/fixtures/Attention_Is_All_You_Need.pdf",
    "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf",
    "tests/fixtures/arxiv-src/1706.03762v1.tar.gz",
    "tests/fixtures/arxiv-src/1706.03762v7.tar.gz"
  ]) {
    execFileSync("git", ["check-ignore", "-q", path]);
  }
  const status = execFileSync("git", ["status", "--short", "--", "tests/fixtures"], { encoding: "utf8" });
  assert.equal(status.trim(), "");
});

function patchSelectValue(document) {
  const proto = Object.getPrototypeOf(document.createElement("select"));
  Object.defineProperty(proto, "value", {
    configurable: true,
    get() {
      return this._value ?? "";
    },
    set(next) {
      this._value = String(next ?? "");
    }
  });
}

function mountPage(hash) {
  const html = readFileSync(join(root, "options/options.html"), "utf8").replace(/<script\b[\s\S]*?<\/script>/g, "");
  const parsed = parseHTML(html);
  const { document, window } = parsed;
  patchSelectValue(document);
  const location = { hash };
  const history = {
    replaceState(_state, _title, url) {
      if (typeof url === "string") location.hash = url.includes("#") ? url.slice(url.indexOf("#")) : url;
    }
  };
  const focused = [];
  const proto = document.createElement("div").constructor.prototype;
  const originalFocus = proto.focus;
  proto.focus = function focus() {
    focused.push(this);
    document._focused = this;
    if (originalFocus) return originalFocus.call(this);
  };
  Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: window.Event });
  Object.defineProperty(globalThis, "CustomEvent", { configurable: true, writable: true, value: window.CustomEvent });
  globalThis.OI_OPTIONS_MANUAL = true;
  globalThis.document = document;
  globalThis.window = window;
  globalThis.location = location;
  globalThis.history = history;
  globalThis.localStorage = memoryLocalStorage({ "reader.follow": "off" });
  const storageApi = {
    asked: 0,
    async persist() {
      this.asked += 1;
      return true;
    }
  };
  globalThis.BroadcastChannel = MemoryBroadcastChannel;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage: storageApi, locks: sharedEngineLocks() }
  });
  globalThis.__oiStorage = storageApi;
  window.location = location;
  globalThis.URL.createObjectURL = (blob) => {
    globalThis.__oiBlob = blob;
    return "blob:oi-settings";
  };
  globalThis.URL.revokeObjectURL = () => {};
  return { document, window, location, focused };
}

async function flush() {
  for (let i = 0; i < 100; i += 1) await Promise.resolve();
}

async function settle() {
  for (let i = 0; i < 12; i += 1) await flush();
}

function fire(node, type) {
  node.dispatchEvent(new node.ownerDocument.defaultView.Event(type, { bubbles: true }));
}

test("settings page behavior covers routing, secrets, notes, and data", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const chrome = installChrome({
      settings: savedSettings(),
      local: {
        formulaSettings: formulaSeed(),
        "reader.panelWidth": 520,
        "reader.notesWidth": 400,
        "reader.notesPaneSide": "start"
      }
    });
    const page = mountPage("#formula");
    const { startOptions, searchHits } = await import("../options/options.js");
    const started = startOptions();
    await flush();
    mock.timers.tick(160);
    assert.equal(page.document.getElementById("setSkeleton").hidden, true);
    await started;
    await flush();

    const nav = [...page.document.querySelectorAll("[data-nav]")].map((tab) => tab.dataset.nav);
    assert.deepEqual(nav, ["translate", "mm", "web", "pdf", "notes", "labs", "data", "about"]);
    assert.equal(page.document.body.textContent.includes("保存设置"), false);
    assert.equal(page.document.getElementById("save"), null);
    assert.equal(page.document.querySelector("[data-nav='advanced']"), null);
    assert.equal(page.document.querySelector("[data-nav='ask']"), null);
    assert.equal(page.location.hash, "#mm");
    assert.equal(page.document.getElementById("panel-formula").hidden, false);
    assert.equal(page.document.getElementById("formulaSettingsRoot").getAttribute("data-reader-theme"), "warm");
    assert.equal(page.document.getElementById("mmPdfBanner").hidden, false);
    assert.match(page.document.getElementById("formulaSettingsRoot").textContent, /问 AI 也用这个模型/);
    assert.match(page.document.getElementById("formulaSettingsRoot").textContent, /问 AI 时还会发送你的问题和引用的段落/);
    assert.equal(page.document.querySelector("[data-formula-switch='formula.tier2.enabled']").checked, true);

    const confirms = [];
    page.window.confirm = () => {
      confirms.push(true);
      return true;
    };
    assert.equal(page.document.querySelector("[data-badge='mm']").hidden, true);
    const tier2 = page.document.querySelector("[data-formula-switch='formula.tier2.enabled']");
    tier2.checked = false;
    fire(tier2, "change");
    await flush();
    assert.equal(confirms.length, 0);
    tier2.checked = true;
    fire(tier2, "change");
    await flush();
    await globalThis.chrome.storage.local.set({
      formulaSettings: {
        ...formulaSeed(),
        multimodal: { ...formulaSeed().multimodal, probe: { ok: false, chip: "密钥无效", at: 1 } }
      }
    });
    await flush();
    assert.equal(page.document.querySelector("[data-badge='mm']").hidden, false);
    await globalThis.chrome.storage.local.set({ formulaSettings: formulaSeed() });
    await flush();
    assert.equal(page.document.querySelector("[data-badge='mm']").hidden, true);

    for (const hash of ["#engine", "#reading", "#features", "#advanced", "#ai", "#formula", "#unknown"]) {
      page.location.hash = hash;
      page.window.dispatchEvent(new page.window.Event("hashchange"));
      await flush();
      const expected = parseSettingsHash(hash).id;
      assert.equal(page.location.hash, `#${expected}`);
      assert.equal(page.document.querySelector(`[data-panel="${expected}"]`).hidden, false);
    }

    page.location.hash = "#data?focus=export";
    page.window.dispatchEvent(new page.window.Event("hashchange"));
    await flush();
    assert.equal(page.location.hash, "#data");
    const exportGroup = page.document.querySelector("[data-focus-group='export']");
    assert.equal(page.document._focused, exportGroup);
    assert.equal(exportGroup.classList.contains("set-flash"), true);
    mock.timers.tick(1200);
    assert.equal(exportGroup.classList.contains("set-flash"), false);

    const target = page.document.getElementById("targetLang");
    const beforeSaves = chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").length;
    const t0 = Date.now();
    target.value = "en";
    fire(target, "change");
    await flush();
    assert.ok(Date.now() - t0 < 300);
    const save = chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").at(-1);
    assert.equal(chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").length, beforeSaves + 1);
    assert.equal(save.patch.targetLang, "en");
    assert.equal(syncHasSecrets(chrome.sync.settings), false);
    assert.equal(chrome.sync.settings.providers.openai.apiKey, "");

    const key = page.document.querySelector("[data-key-slot='translate'] input");
    assert.equal(key.value, "sk-••••3f9a");
    key.value = "";
    fire(key, "blur");
    await flush();
    assert.equal(key.value, "sk-••••3f9a");
    assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
    assert.equal(page.document.querySelector("[data-secret-saved]").textContent, "");
    key.value = "   ";
    key.dispatchEvent(Object.assign(new page.window.Event("keydown", { bubbles: true }), { key: "Enter" }));
    await flush();
    assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
    key.value = "  sk-new123  ";
    key.dispatchEvent(new page.window.Event("blur", { bubbles: true }));
    await flush();
    assert.equal(chrome.local.oiSecrets.providers.openai, "sk-new123");
    assert.equal(page.document.querySelector("[data-key-slot='translate'] [data-secret-saved]").textContent, "已保存");
    const typed = page.document.querySelector("[data-key-slot='translate'] input");
    typed.value = "sk-typed-only";
    await flush();
    assert.equal(chrome.local.oiSecrets.providers.openai, "sk-new123");

    const show = [...page.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "显示");
    show.click();
    assert.equal(page.document.querySelector("[data-key-slot='translate'] input").value, "sk-new123");
    mock.timers.tick(30000);
    assert.equal(page.document.querySelector("[data-key-slot='translate'] input").value, "sk-••••w123");

    const remove = [...page.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "移除密钥");
    remove.click();
    await settle();
    assert.equal(chrome.local.oiSecrets.providers.openai, "");
    assert.match(page.document.getElementById("setToast").textContent, /已移除 .+ 密钥/);
    page.document.getElementById("setToast").querySelector("button").click();
    await flush();
    assert.equal(chrome.local.oiSecrets.providers.openai, "sk-new123");

    const mmRemove = [...page.document.querySelectorAll("[data-key-slot='mm'] button")].find((button) => button.textContent === "移除密钥");
    assert.ok(page.document.querySelector("[data-formula-switch='formula.tier2.enabled']"));
    mmRemove.click();
    await flush();
    assert.equal(page.document.querySelector("[data-formula-switch='formula.tier2.enabled']"), null);
    assert.match(page.document.getElementById("setToast").textContent, /已移除 多模态 密钥/);
    page.document.getElementById("setToast").querySelector("button").click();
    await flush();
    assert.equal(page.document.querySelector("[data-formula-switch='formula.tier2.enabled']").checked, true);
    mock.timers.tick(5000);

    page.document.getElementById("setSearch").value = "密钥";
    fire(page.document.getElementById("setSearch"), "input");
    const hits = searchHits("密钥");
    assert.deepEqual(hits.map((node) => node.getAttribute("data-key-slot")), ["translate", "mm", "ocr", "pdf"]);
    const resultButtons = [...page.document.getElementById("setResults").querySelectorAll("button")];
    assert.equal(resultButtons.length, 4);
    resultButtons[3].click();
    assert.equal(page.location.hash, "#pdf");
    assert.equal(page.document.querySelector("[data-key-slot='pdf']").classList.contains("set-flash"), true);
    mock.timers.tick(1200);

    for (const [word, focus, attr] of [["导入", "import", "data-focus-group"], ["导出", "export", "data-focus-group"], ["备份", "backup", "data-focus"]]) {
      const found = searchHits(word);
      assert.equal(found.length, 1, word);
      assert.equal(found[0].getAttribute(attr), focus);
    }

    const notes = page.document.getElementById("panel-notes");
    assert.equal(notes.textContent.includes("默认布局"), false);
    assert.equal(notes.textContent.includes("新笔记默认类型"), false);
    assert.equal([...notes.querySelectorAll(".set-row")].length, 3);
    page.location.hash = "#notes";
    page.window.dispatchEvent(new page.window.Event("hashchange"));
    assert.equal(page.document.getElementById("notesPaneSide").value, "start");
    assert.equal(page.document.getElementById("panelWidthValue").textContent, "520");
    assert.equal(page.document.getElementById("restorePanelWidth").disabled, false);
    page.document.getElementById("restorePanelWidth").click();
    await flush();
    assert.equal(page.document.getElementById("panelWidthValue").textContent, "440");
    assert.equal(page.document.getElementById("restorePanelWidth").disabled, true);
    assert.equal(String(chrome.local["reader.panelWidth"]), "440");
    page.document.getElementById("restoreNotesWidth").click();
    await flush();
    assert.equal(page.document.getElementById("notesWidthValue").textContent, "360");
    assert.equal(String(chrome.local["reader.notesWidth"]), "360");

    const mount = page.document.getElementById("dataPanelMount");
    assert.ok(mount.querySelector("[data-focus-group='usage']"));
    assert.ok(mount.querySelector("[data-focus-group='import']"));
    assert.ok(mount.querySelector("[data-focus-group='export']"));
    assert.match(mount.textContent, /文献库 · 导入/);
    assert.match(mount.textContent, /文献库 · 导出/);
    assert.equal(page.document.querySelector("[data-badge='data']").hidden, true);
    assert.equal(page.document.getElementById("setReadError").hidden, true);
    assert.equal(page.document.getElementById("exportSettings").disabled, false);
    assert.equal(page.document.body.textContent.includes("不再提示"), false);

    const syncSwitch = page.document.getElementById("keysSync");
    assert.equal(syncSwitch.disabled, true);
    assert.equal(syncSwitch.getAttribute("aria-checked"), "false");
    assert.equal(syncSwitch.checked, false);
    assert.equal(chrome.local["keys.syncOptIn"], false);
    const syncRow = syncSwitch.closest(".set-row");
    assert.equal(syncRow.firstElementChild.querySelector(".set-title").textContent, "在我的浏览器之间同步密钥");
    assert.equal(syncRow.lastElementChild, syncSwitch);
    chrome.localSetThrows = true;
    const formulaSwitch = page.document.querySelector("[data-formula-switch]");
    assert.ok(formulaSwitch);
    const formulaWas = formulaSwitch.checked;
    formulaSwitch.checked = !formulaWas;
    fire(formulaSwitch, "change");
    await flush();
    assert.equal(page.document.querySelector("[data-formula-switch]").checked, formulaWas);
    assert.match(page.document.getElementById("formulaSaveMiss").textContent, /没保存上 · 重试/);
    chrome.localSetThrows = false;

    page.document.getElementById("mmEnablePdf").click();
    await flush();
    assert.equal(page.location.hash, "#pdf");
    assert.equal(page.document._focused?.id, "pdfEnabled");
    const pdfSwitch = page.document.getElementById("pdfEnabled");
    assert.equal(pdfSwitch.checked, false);
    assert.equal(pdfSwitch.getAttribute("role"), "switch");
    assert.equal(pdfSwitch.closest(".set-row").getAttribute("aria-disabled"), "false");
    assert.equal(page.document.getElementById("pdfEnabledNote").textContent, "已关闭。PDF 会用浏览器自带的查看器打开。");
    const autoRow = page.document.getElementById("pdfAutoTranslate").closest(".set-row");
    assert.equal(autoRow.getAttribute("aria-disabled"), "true");
    assert.equal(page.document.getElementById("pdfAutoTranslate").disabled, true);
    assert.equal(page.document.querySelector("#panel-pdf .set-group").id, "pdfFeatureList");
    assert.equal(page.document.getElementById("mmPdfBanner").hidden, false);

    const scale = page.document.getElementById("fontScale");
    const scaleBefore = scale.value;
    page.document.querySelector("[data-step-for='fontScale'][data-dir='1']").click();
    await flush();
    assert.ok(Number(scale.value) > Number(scaleBefore));

    chrome.failSave = true;
    const lang = page.document.getElementById("sourceLang");
    const previous = lang.value;
    lang.value = previous === "en" ? "ja" : "en";
    fire(lang, "change");
    await flush();
    assert.equal(lang.value, previous);
    const miss = lang.parentElement.querySelector(".set-save-miss");
    assert.match(miss.textContent, /没保存上 · 重试/);
    const retry = miss.querySelector("button");
    assert.equal(retry?.textContent, "重试");
    chrome.failSave = false;
    retry.click();
    await flush();
    assert.equal(lang.value, previous === "en" ? "ja" : "en");
    assert.equal(miss.hidden, true);

    const savesBeforeImport = chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").length;
    const input = page.document.getElementById("importFile");
    const file = new File([JSON.stringify({
      settings: {
        settingsVersion: SETTINGS_VERSION + 1,
        providers: { openai: { apiKey: "sk-newer" } }
      }
    })], "new.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
    fire(input, "change");
    await flush();
    assert.equal(page.document.getElementById("status").textContent, "文件来自更新版本");
    assert.equal(chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").length, savesBeforeImport);

    const oldFile = new File([JSON.stringify({
      settings: {
        settingsVersion: SETTINGS_VERSION,
        targetLang: "ja",
        providers: { openai: { apiKey: "sk-file-key-should-ignore" } },
        pdfLayout: { cloudApiKey: "pdf-file-key" }
      }
    })], "old.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, get: () => [oldFile] });
    fire(input, "change");
    await flush();
    assert.equal(page.document.getElementById("status").textContent, "文件里的 API 密钥已忽略，请在本机重新填写。");
    assert.equal(page.document.getElementById("importKeyNote").hidden, false);
    assert.equal(page.document.getElementById("targetLang").value, "ja");
    assert.equal(syncHasSecrets(chrome.sync.settings), false);
    assert.equal(chrome.local.oiSecrets.providers.openai, "sk-new123");
    assert.equal(String(chrome.local.oiSecrets.pdfCloudApiKey || ""), PDF_KEY);

    page.document.getElementById("exportSettings").click();
    await flush();
    const exported = JSON.parse(await globalThis.__oiBlob.text());
    assert.equal(syncHasSecrets(exported.settings), false);
    assert.equal(page.document.getElementById("status").textContent, "已导出（不含密钥）");

    const down = page.document.querySelector("[data-nav='translate']");
    down.dispatchEvent(Object.assign(new page.window.Event("keydown", { bubbles: true, cancelable: true }), { key: "ArrowDown" }));
    assert.equal(page.document._focused, page.document.querySelector("[data-nav='mm']"));
    assert.equal(page.document.querySelector("[data-nav='web']").getAttribute("role"), "tab");
    assert.equal(page.document.getElementById("twoStepPolish").getAttribute("role"), "switch");
    assert.equal(page.document.getElementById("twoStepPolish").disabled, false);
    assert.equal(page.document.getElementById("twoStepPolishHint").textContent, "先直译再润色，质量更好，更耗 token");
    const polishTitle = page.document.getElementById("twoStepPolishLabel");
    const polishInput = page.document.getElementById("twoStepPolish");
    const polishRow = polishInput.closest(".set-row");
    assert.equal(polishRow.firstElementChild.contains(polishTitle), true);
    assert.equal(polishRow.lastElementChild, polishInput);
    assert.equal(page.document.querySelector(".set-help").hasAttribute("open"), false);
    assert.match(page.document.querySelector(".set-help").textContent, /总量由什么决定/);
    const batch = page.document.getElementById("batchSize");
    const batchMinus = page.document.querySelector("[data-step-for='batchSize'][data-dir='-1']");
    const batchPlus = page.document.querySelector("[data-step-for='batchSize'][data-dir='1']");
    batch.value = "1";
    fire(batch, "input");
    assert.equal(batchMinus.disabled, true);
    assert.equal(batchPlus.disabled, false);
    batch.value = "20";
    fire(batch, "input");
    assert.equal(batchPlus.disabled, true);
    assert.equal(batchMinus.disabled, false);
    batch.value = "8";
    fire(batch, "input");
    batchPlus.click();
    assert.notEqual(batch.getAttribute("role"), "switch");
    const scope = page.document.getElementById("translateScope");
    fire(scope, "change");
    await flush();
    assert.notEqual(scope.getAttribute("role"), "switch");
    assert.notEqual(page.document.getElementById("sourceLang").getAttribute("role"), "switch");
    assert.notEqual(page.document.getElementById("fontScale").getAttribute("role"), "switch");
    const providerSelect = page.document.getElementById("provider");
    providerSelect.value = "deepl";
    fire(providerSelect, "change");
    await flush();
    assert.equal(polishInput.disabled, true);
    assert.equal(page.document.getElementById("deepThink").disabled, true);
    assert.match(page.document.getElementById("twoStepPolishHint").textContent, /当前引擎（DeepL）不支持/);
    assert.match(page.document.getElementById("deepThinkHint").textContent, /换引擎/);
    assert.equal(page.document.querySelector("#twoStepPolishHint .set-why")?.className, "set-why");
    page.document.getElementById("testConnection").click();
    await flush();
    assert.equal(page.document.querySelector("[data-badge='translate']").hidden, false);
    mock.timers.tick(8000);
    assert.equal(page.document.querySelector("[data-badge='translate']").hidden, false);
    assert.notEqual(page.document.getElementById("testConnectionStatus").textContent, "");
    page.document.querySelector(".set-engine-jump").click();
    assert.equal(page.document._focused, providerSelect);
    providerSelect.value = "openai";
    fire(providerSelect, "change");
    await flush();
    assert.equal(polishInput.disabled, false);
    assert.equal(page.document.getElementById("twoStepPolishHint").textContent, "先直译再润色，质量更好，更耗 token");

    const readHtml = readFileSync(join(root, "options/options.html"), "utf8").replace(/<script\b[\s\S]*?<\/script>/g, "");
    const readDom = parseHTML(readHtml);
    patchSelectValue(readDom.document);
    globalThis.document = readDom.document;
    globalThis.window = readDom.window;
    const readChrome = installChrome({ settings: savedSettings() });
    let releaseGet;
    readChrome.holdGet = new Promise((resolve, reject) => {
      releaseGet = () => {
        readChrome.failGet = true;
        reject(new Error("read failed"));
      };
    });
    readChrome.holdGet.catch(() => {});
    const readPage = { document: readDom.document, window: readDom.window };
    Object.defineProperty(globalThis, "Event", { configurable: true, writable: true, value: readDom.window.Event });
    Object.defineProperty(globalThis, "CustomEvent", { configurable: true, writable: true, value: readDom.window.CustomEvent });
    globalThis.location = { hash: "#translate" };
    globalThis.history = { replaceState(_s, _t, url) { globalThis.location.hash = String(url); } };
    const failing = await import("../options/options.js?read-fail=1");
    const pending = failing.startOptions();
    mock.timers.tick(150);
    assert.equal(readPage.document.getElementById("setSkeleton").hidden, false);
    releaseGet();
    await pending;
    await flush();
    assert.equal(readPage.document.getElementById("setSkeleton").hidden, true);
    assert.equal(readPage.document.getElementById("setReadError").hidden, false);
    assert.match(readPage.document.getElementById("setReadError").textContent, /没能读取已保存的设置/);
    const reads = readChrome.calls.length;
    readPage.document.getElementById("targetLang").value = "ja";
    readPage.document.getElementById("targetLang").dispatchEvent(new readDom.window.Event("change", { bubbles: true }));
    await flush();
    assert.equal(readChrome.calls.length, reads);
    const blocked = readPage.document.getElementById("importFile");
    const blockedFile = new File([JSON.stringify({ settings: { settingsVersion: SETTINGS_VERSION, targetLang: "de" } })], "blocked.json", { type: "application/json" });
    Object.defineProperty(blocked, "files", { configurable: true, get: () => [blockedFile] });
    blocked.dispatchEvent(new readDom.window.Event("change", { bubbles: true }));
    await flush();
    assert.equal(readChrome.calls.length, reads);
    assert.match(readPage.document.getElementById("status").textContent, /先重试再导入/);
  } finally {
    mock.timers.reset();
  }
});

test("rows-v2 and skeleton styles stay in the settings stylesheet", () => {
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  const js = readFileSync(join(root, "options/options.js"), "utf8");
  assert.match(css, /\.set-skeleton\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /width:\s*36px;\s*height:\s*20px/);
  assert.match(css, /width:\s*16px;\s*height:\s*16px/);
  assert.match(css, /translateX\(16px\)/);
  assert.match(css, /\.set-quality \.set-stepper[\s\S]*width:\s*100px;\s*height:\s*28px/);
  assert.match(css, /#formulaSettingsRoot\s*\{\s*min-width:\s*0;\s*max-width:\s*100%/);
  assert.match(js, /kind === "llm"/);
  assert.doesNotMatch(js, /kind === "llm" \|\| kind === "custom"/);
});

test("translate 需处理 badge survives refresh until a successful test or an engine switch", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  const queue = [
    { ok: false, httpStatus: 401, error: "unauthorized" },
    { ok: true, translation: "你好" }
  ];
  chrome.testProviderResult = () => queue.shift();
  const page = mountPage("#translate");
  const { startOptions } = await import("../options/options.js?attention=1");
  await startOptions();
  await flush();
  page.document.getElementById("testConnection").click();
  await flush();
  assert.equal(page.document.querySelector("[data-badge='translate']").hidden, false);
  assert.deepEqual(chrome.local.oiProviderAttention, { openai: true });
  assert.equal(JSON.stringify(chrome.local.oiProviderAttention).includes(OPENAI_KEY), false);
  const exported = settingsForExport(await getSettings());
  assert.equal(exported.oiProviderAttention, undefined);
  assert.equal(syncHasSecrets(exported), false);
  assert.equal(chrome.sync.settings.oiProviderAttention, undefined);

  const refreshed = mountPage("#translate");
  await startOptions();
  await flush();
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, false);
  assert.equal(refreshed.document.getElementById("testConnectionStatus").textContent, "");

  refreshed.document.getElementById("testConnection").click();
  await flush();
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, true);
  assert.deepEqual(chrome.local.oiProviderAttention, {});

  chrome.testProviderResult = () => ({ ok: false, httpStatus: 401, error: "unauthorized" });
  refreshed.document.getElementById("testConnection").click();
  await flush();
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, false);
  assert.deepEqual(chrome.local.oiProviderAttention, { openai: true });
  const providerSelect = refreshed.document.getElementById("provider");
  providerSelect.value = "deepl";
  fire(providerSelect, "change");
  await flush();
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, true);
  assert.equal(chrome.local.oiProviderAttention.openai, undefined);
  assert.equal(JSON.stringify(chrome.local.oiProviderAttention).includes(OPENAI_KEY), false);

  providerSelect.value = "openai";
  fire(providerSelect, "change");
  await flush();
  chrome.testProviderResult = () => ({ ok: false, httpStatus: 401, error: "unauthorized" });
  refreshed.document.getElementById("testConnection").click();
  await flush();
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, false);
  const key = refreshed.document.querySelector("[data-key-slot='translate'] input");
  key.value = "sk-replaced-key";
  fire(key, "blur");
  await flush();
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, true);
  assert.equal(chrome.local.oiProviderAttention.openai, undefined);

  chrome.local.oiProviderAttention = { openai: true };
  await noteTranslationSucceeded("openai");
  assert.deepEqual(chrome.local.oiProviderAttention, {});
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
  const handler = sw.slice(sw.indexOf('case "OI_TRANSLATE_BATCH"'), sw.indexOf('case "OI_TEST_PROVIDER"'));
  assert.match(handler, /await translateBatch\([\s\S]*if \(batchOpts\.providerCalled\) await noteTranslationSucceeded\(batchOpts\.providerId\)/);
  assert.match(sw, /options\.providerId = outbound\.providerId/);
  assert.equal(sw.slice(sw.indexOf("async function translateBatch"), sw.indexOf("export { translateBatch")).includes("noteTranslationSucceeded"), false);
  const menu = sw.slice(sw.indexOf("oi-save-selection"), sw.indexOf("chrome.commands.onCommand"));
  assert.match(menu, /translateBatch\(\[text\], batchOpts\)[\s\S]*if \(batchOpts\.providerCalled\) await noteTranslationSucceeded\(batchOpts\.providerId\)/);

  await globalThis.chrome.storage.local.set({ oiProviderAttention: { openai: true } });
  await flush();
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, false);
  refreshed.document.getElementById("testConnectionStatus").className = "provider-test-status is-err";
  await globalThis.chrome.storage.local.set({ oiProviderAttention: {} });
  await flush();
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, true);
});

test("removed and stale PDF cloud keys are not written back", async () => {
  const live = mergeLiveSecrets(null, {
    providers: { openai: { apiKey: "sk-live-sync" } },
    pdfLayout: { cloudApiKey: "pdf-live-sync" }
  });
  assert.equal(live.pdfCloudApiKey, "pdf-live-sync");
  assert.equal(live.providers.openai, "sk-live-sync");
  const localWins = mergeLiveSecrets(
    { providers: { openai: "sk-live-local" }, pdfCloudApiKey: "pdf-live-local" },
    { providers: { openai: { apiKey: "sk-live-sync" } }, pdfLayout: { cloudApiKey: "pdf-live-sync" } }
  );
  assert.equal(localWins.pdfCloudApiKey, "pdf-live-local");
  assert.equal(localWins.providers.openai, "sk-live-local");

  const chrome = installChrome({ settings: savedSettings() });
  const page = mountPage("#pdf");
  const { startOptions } = await import("../options/options.js?freshness=1");
  await startOptions();
  await flush();
  const pdfRemove = [...page.document.querySelectorAll("button")].find((button) => {
    return button.textContent === "移除密钥" && button.parentElement?.querySelector("#pdfCloudApiKey");
  });
  pdfRemove.click();
  await flush();
  assert.equal(chrome.local.oiSecrets.pdfCloudApiKey, "");
  const input = page.document.getElementById("importFile");
  const file = new File([JSON.stringify({
    settings: {
      settingsVersion: SETTINGS_VERSION,
      targetLang: "ja",
      pdfLayout: { mode: "cloud", cloudApiKey: "from-file" },
      providers: { openai: { apiKey: "from-file" } }
    }
  })], "back.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
  fire(input, "change");
  await flush();
  assert.equal(chrome.local.oiSecrets.pdfCloudApiKey, "");
  assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
  const removedPatch = chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").at(-1).patch;
  assert.equal(JSON.stringify(removedPatch).includes(PDF_KEY), false);

  chrome.local.oiSecrets = {
    providers: { openai: "sk-live-from-storage" },
    pdfCloudApiKey: "pdf-live-from-storage"
  };
  fire(input, "change");
  await flush();
  const importPatch = chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").at(-1).patch;
  assert.equal(importPatch.pdfLayout.cloudApiKey, "pdf-live-from-storage");
  assert.equal(Object.prototype.hasOwnProperty.call(importPatch.providers?.openai || {}, "apiKey"), false);
  assert.equal(JSON.stringify(importPatch).includes(PDF_KEY), false);
  assert.equal(JSON.stringify(importPatch).includes(OPENAI_KEY), false);
  const imported = legacyBackgroundMerge({
    providers: { openai: { apiKey: "sk-live-from-storage", baseUrl: "https://api.openai.com/v1" } },
    pdfLayout: { mode: "cloud", cloudApiKey: "pdf-live-from-storage" }
  }, importPatch);
  assert.equal(imported.pdfLayout.cloudApiKey, "pdf-live-from-storage");
  assert.equal(imported.providers.openai.apiKey, "sk-live-from-storage");
  assert.equal(chrome.local.oiSecrets.pdfCloudApiKey, "pdf-live-from-storage");
  assert.equal(chrome.local.oiSecrets.providers.openai, "sk-live-from-storage");

  chrome.local.oiSecrets = {
    providers: { openai: "sk-live-again" },
    pdfCloudApiKey: "pdf-live-again"
  };
  const target = page.document.getElementById("targetLang");
  target.value = "de";
  fire(target, "change");
  await flush();
  const savePatch = chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").at(-1).patch;
  assert.equal(savePatch.pdfLayout.cloudApiKey, "pdf-live-again");
  assert.equal(Object.prototype.hasOwnProperty.call(savePatch.providers?.openai || {}, "apiKey"), false);
  assert.equal(JSON.stringify(savePatch).includes("pdf-live-from-storage"), false);
  assert.equal(JSON.stringify(savePatch).includes(OPENAI_KEY), false);
  const saved = legacyBackgroundMerge({
    providers: { openai: { apiKey: "sk-live-again", baseUrl: "https://api.openai.com/v1" } },
    pdfLayout: { mode: "", cloudApiKey: "pdf-live-again" }
  }, savePatch);
  assert.equal(saved.pdfLayout.cloudApiKey, "pdf-live-again");
  assert.equal(saved.providers.openai.apiKey, "sk-live-again");
  assert.equal(chrome.local.oiSecrets.pdfCloudApiKey, "pdf-live-again");
  assert.equal(chrome.local.oiSecrets.providers.openai, "sk-live-again");
});

test("a file of only secret-like names is not reported as imported", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  const page = mountPage("#data");
  const { startOptions } = await import("../options/options.js?only-secrets=1");
  await startOptions();
  await flush();
  const input = page.document.getElementById("importFile");
  const file = new File([JSON.stringify({
    settings: {
      settingsVersion: SETTINGS_VERSION,
      client_secret: "only-client",
      bearer: "only-bearer",
      cloud_api_key: "only-cloud",
      "access-token": "only-access",
      nested: { clientSecret: "only-nested" },
      list: [{ bearer: "only-array", token: "keep-token" }]
    }
  })], "secrets.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
  fire(input, "change");
  await flush();
  const status = page.document.getElementById("status").textContent;
  assert.equal(status, "文件里的 API 密钥已忽略，请在本机重新填写。");
  assert.notEqual(status, "已导入");
  const stored = JSON.stringify(chrome.sync.settings);
  for (const secret of ["only-client", "only-bearer", "only-cloud", "only-access", "only-nested", "only-array"]) {
    assert.equal(stored.includes(secret), false, secret);
  }
  assert.equal(chrome.sync.settings.list[0].token, "keep-token");
  page.document.getElementById("exportSettings").click();
  await flush();
  const exported = JSON.parse(await globalThis.__oiBlob.text());
  const text = JSON.stringify(exported);
  for (const secret of ["only-client", "only-bearer", "only-cloud", "only-access", "only-nested", "only-array"]) {
    assert.equal(text.includes(secret), false, secret);
  }
  assert.equal(exported.settings.list[0].token, "keep-token");
  assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
});

test("a removed provider key is not written back by a failed or in-flight edit", async () => {
  const typed = "sk-should-not-return";
  const chrome = installChrome({ settings: savedSettings() });
  const page = mountPage("#translate");
  const { startOptions } = await import("../options/options.js?remove-edit=1");
  await startOptions();
  await flush();
  chrome.failSave = true;
  const key = page.document.querySelector("[data-key-slot='translate'] input");
  key.value = typed;
  fire(key, "blur");
  await flush();
  assert.equal(chrome.local.oiSecrets.providers.openai, OPENAI_KEY);
  chrome.failSave = false;
  const remove = [...page.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "移除密钥");
  remove.click();
  await flush();
  assert.equal(chrome.local.oiSecrets.providers.openai, "");
  const input = page.document.getElementById("importFile");
  const file = new File([JSON.stringify({
    settings: { settingsVersion: SETTINGS_VERSION, targetLang: "ja", providers: { openai: { apiKey: "file-key" } } }
  })], "removed.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
  fire(input, "change");
  await flush();
  assert.equal(chrome.local.oiSecrets.providers.openai, "");
  const mark = chrome.calls.length;
  const target = page.document.getElementById("targetLang");
  target.value = "de";
  fire(target, "change");
  await flush();
  assert.equal(chrome.local.oiSecrets.providers.openai, "");
  const later = chrome.calls.slice(mark).filter((call) => call.type === "OI_SAVE_SETTINGS");
  assert.ok(later.length >= 1);
  for (const call of later) assert.equal(JSON.stringify(call.patch).includes(typed), false);
  const merged = legacyBackgroundMerge({
    providers: { openai: { apiKey: "", baseUrl: "https://api.openai.com/v1" } },
    pdfLayout: { cloudApiKey: PDF_KEY }
  }, later.at(-1).patch);
  assert.equal(merged.providers.openai.apiKey, "");
  assert.equal(JSON.stringify(merged).includes(typed), false);

  const racingChrome = installChrome({ settings: savedSettings() });
  const racingPage = mountPage("#translate");
  const racing = await import("../options/options.js?remove-race=1");
  await racing.startOptions();
  await flush();
  let release;
  racingChrome.holdNextSecretRead = new Promise((resolve) => {
    release = resolve;
  });
  const racingKey = racingPage.document.querySelector("[data-key-slot='translate'] input");
  racingKey.value = typed;
  fire(racingKey, "blur");
  await flush();
  assert.equal(racingChrome.local.oiSecrets.providers.openai, OPENAI_KEY);
  const racingRemove = [...racingPage.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "移除密钥");
  racingRemove.click();
  await flush();
  assert.equal(racingChrome.local.oiSecrets.providers.openai, OPENAI_KEY);
  const beforeRelease = racingChrome.calls.length;
  release();
  await settle();
  assert.equal(racingChrome.local.oiSecrets.providers.openai, "");
  const after = racingChrome.calls.slice(beforeRelease).filter((call) => call.type === "OI_SAVE_SETTINGS" && call.keySeq);
  const clear = after.at(-1);
  assert.equal(clear.clear.providers.includes("openai"), true);
  assert.equal(JSON.stringify(clear.patch).includes(typed), false);
  assert.equal(legacyBackgroundMerge({ providers: { openai: { apiKey: typed } } }, clear.patch).providers.openai.apiKey, "");
  const lang = racingPage.document.getElementById("targetLang");
  lang.value = "ja";
  fire(lang, "change");
  await flush();
  assert.equal(racingChrome.local.oiSecrets.providers.openai, "");
  const last = racingChrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").at(-1).patch;
  assert.equal(JSON.stringify(last).includes(typed), false);
  assert.equal(legacyBackgroundMerge({ providers: { openai: { apiKey: "" } } }, last).providers.openai.apiKey, "");
});

test("secret-like names are stripped by word and allow-listed settings stay", () => {
  const secrets = {
    auth: "v-auth",
    authToken: "v-authToken",
    auth_token: "v-auth_token",
    "auth-token": "v-auth-token",
    AUTH_TOKEN: "v-AUTH_TOKEN",
    credential: "v-credential",
    credentials: "v-credentials",
    apiKeys: ["v-apiKeys"],
    api_keys: { primary: "v-api_keys" },
    session_token: "v-session_token",
    sessionToken: "v-sessionToken",
    secretKey: "v-secretKey",
    secret_key: "v-secret_key",
    passphrase: "v-passphrase",
    api_token: "v-api_token",
    id_token: "v-id_token",
    bearer_token: "v-bearer_token",
    oauth_token: "v-oauth_token",
    botToken: "v-botToken",
    privateKeys: "v-privateKeys",
    passwords: "v-passwords",
    aws_secret_access_key: "v-aws_secret_access_key",
    signing_key: "v-signing_key",
    session_key: "v-session_key",
    auth_key: "v-auth_key",
    apiKey2: "v-apiKey2",
    apiKey1: "v-apiKey1",
    api_key2: "v-api_key2",
    api2Key: "v-api2Key",
    password2: "v-password2",
    secret2: "v-secret2",
    token2: "v-token2",
    auth2: "v-auth2",
    clientSecret2: "v-clientSecret2",
    jwt: "v-jwt",
    cookies: "v-cookies",
    sessionCookie: "v-sessionCookie",
    "set-cookie": "v-set-cookie",
    pat: "v-pat",
    xpat: "v-xpat-run",
    githubpat: "v-githubpat-run",
    mypat: "v-mypat-run",
    "x-pat": "v-x-pat",
    myPat: "v-myPat",
    github_pat: "v-github_pat",
    ghPat: "v-ghPat",
    cOoKiEs: "v-cOoKiEs",
    CLOUDAPIKEY: "v-CLOUDAPIKEY",
    aPiKeY: "v-aPiKeY",
    encryptionKey: "v-encryptionKey",
    masterKey: "v-masterKey",
    serviceAccountKey: "v-serviceAccountKey",
    aws_access_key_id: "v-aws_access_key_id",
    oauth: "v-oauth",
    sessionId: "v-sessionId",
    "\uff41\uff50\uff49Key": "v-fullwidth-apiKey",
    "\u0430piKey": "v-cyrillic-apiKey",
    csrf: "v-csrf",
    CSRF: "v-CSRF"
  };
  const prepared = prepareSettingsImport({
    settings: {
      ...secrets,
      tokenLimit: 4096,
      tokenizer: "keep-tokenizer",
      passwordHint: "keep-hint",
      secretly: "keep-secretly",
      maxTokens: 100,
      accessKey: "keep-access",
      authorName: "keep-author",
      secretMode: "keep-mode",
      client_id: "keep-client",
      keyCode: "keep-keycode",
      singleKey: "keep-single",
      authorMode: "keep-author-mode",
      patch: "keep-patch",
      patient: "keep-patient",
      path: "keep-path",
      oauthScope: "keep-oauth-scope",
      oauthClientId: "keep-oauth-client",
      cookieConsent: "keep-cookie-consent",
      cookieName: "keep-cookie-name",
      tokenLimit2: 2048,
      passwordHint2: "keep-hint-2",
      secretMode2: "keep-mode-2",
      maxTokens2: 50,
      comPat: "keep-compat",
      myPatient: "keep-mypatient",
      xpath: "keep-xpath",
      browserCompat: "keep-browser-compat",
      cssCompat: "keep-css-compat",
      token: "keep-bare-token",
      key2: "keep-key-2",
      "Content-Type": "application/json",
      arxiv: { key: "keep-arxiv" },
      shortcuts: { keys: "keep-keys", key: "keep-hotkey" },
      placeholders: [{ token: "keep-placeholder-token" }],
      nested: { ...secrets },
      list: [{ ...secrets, token: "keep-row-token" }]
    }
  });
  assert.equal(prepared.ignoredKeys, true);
  const text = JSON.stringify(prepared.settings);
  for (const [name, value] of Object.entries(secrets)) {
    const samples = Array.isArray(value) ? value : value && typeof value === "object" ? Object.values(value) : [value];
    for (const sample of samples) assert.equal(text.includes(String(sample)), false, name);
  }
  assert.equal(prepared.settings.tokenLimit, 4096);
  assert.equal(prepared.settings.tokenizer, "keep-tokenizer");
  assert.equal(prepared.settings.passwordHint, "keep-hint");
  assert.equal(prepared.settings.secretly, "keep-secretly");
  assert.equal(prepared.settings.maxTokens, 100);
  assert.equal(prepared.settings.accessKey, "keep-access");
  assert.equal(prepared.settings.authorName, "keep-author");
  assert.equal(prepared.settings.secretMode, "keep-mode");
  assert.equal(prepared.settings.client_id, "keep-client");
  assert.equal(prepared.settings.keyCode, "keep-keycode");
  assert.equal(prepared.settings.singleKey, "keep-single");
  assert.equal(prepared.settings.authorMode, "keep-author-mode");
  assert.equal(prepared.settings.patch, "keep-patch");
  assert.equal(prepared.settings.patient, "keep-patient");
  assert.equal(prepared.settings.path, "keep-path");
  assert.equal(prepared.settings.oauthScope, "keep-oauth-scope");
  assert.equal(prepared.settings.oauthClientId, "keep-oauth-client");
  assert.equal(prepared.settings.cookieConsent, "keep-cookie-consent");
  assert.equal(prepared.settings.cookieName, "keep-cookie-name");
  assert.equal(prepared.settings.tokenLimit2, 2048);
  assert.equal(prepared.settings.passwordHint2, "keep-hint-2");
  assert.equal(prepared.settings.secretMode2, "keep-mode-2");
  assert.equal(prepared.settings.maxTokens2, 50);
  assert.equal(prepared.settings.comPat, "keep-compat");
  assert.equal(prepared.settings.myPatient, "keep-mypatient");
  assert.equal(prepared.settings.xpath, "keep-xpath");
  assert.equal(prepared.settings.xpat, undefined);
  assert.equal(prepared.settings.githubpat, undefined);
  assert.equal(prepared.settings.browserCompat, "keep-browser-compat");
  assert.equal(prepared.settings.cssCompat, "keep-css-compat");
  assert.equal(prepared.settings.token, "keep-bare-token");
  assert.equal(prepared.settings.key2, "keep-key-2");
  assert.equal(prepared.settings["Content-Type"], "application/json");
  assert.equal(prepared.settings.arxiv.key, "keep-arxiv");
  assert.equal(prepared.settings.shortcuts.keys, "keep-keys");
  assert.equal(prepared.settings.shortcuts.key, "keep-hotkey");
  assert.equal(prepared.settings.placeholders[0].token, "keep-placeholder-token");
  assert.equal(prepared.settings.list[0].token, "keep-row-token");
  const only = prepareSettingsImport({ settings: secrets });
  assert.equal(only.ignoredKeys, true);
  assert.equal(settingsImportHasChanges(only.settings), false);
  const onlyPdf = prepareSettingsImport({ settings: { pdfLayout: { cloudApiKey: "only-pdf-cloud" } } });
  assert.equal(onlyPdf.ignoredKeys, true);
  assert.equal(onlyPdf.settings.pdfLayout, undefined);
  assert.equal(settingsImportHasChanges(onlyPdf.settings), false);
  for (const name of ["apiKey2", "api2Key", "password2", "token2", "auth2", "clientSecret2", "jwt", "sessionCookie", "pat", "xpat", "githubpat", "mypat", "x-pat", "myPat", "github_pat", "ghPat", "cOoKiEs", "CLOUDAPIKEY", "aPiKeY", "encryptionKey", "aws_access_key_id"]) {
    const lone = prepareSettingsImport({ settings: { [name]: "only-one" } });
    assert.equal(lone.ignoredKeys, true, name);
    assert.equal(settingsImportHasChanges(lone.settings), false, name);
    const layout = prepareSettingsImport({ settings: { pdfLayout: { [name]: "only-layout", mode: "local", localBaseUrl: "http://127.0.0.1:9999", cloudModel: "glm-ocr" } } });
    assert.equal(layout.ignoredKeys, true, name);
    assert.equal(layout.settings.pdfLayout.mode, "local", name);
    assert.equal(layout.settings.pdfLayout.localBaseUrl, "http://127.0.0.1:9999", name);
    assert.equal(layout.settings.pdfLayout.cloudModel, "glm-ocr", name);
    assert.equal(JSON.stringify(layout.settings).includes("only-layout"), false, name);
  }
  const onlyLayout = prepareSettingsImport({ settings: { pdfLayout: { apiKey2: "only-layout-key" } } });
  assert.equal(onlyLayout.ignoredKeys, true);
  assert.equal(onlyLayout.settings.pdfLayout, undefined);
  assert.equal(settingsImportHasChanges(onlyLayout.settings), false);
  const exported = settingsForExport({
    apiKey2: "export-api-2",
    jwt: "export-jwt",
    accessKey: "keep-access",
    keyCode: "keep-keycode",
    oiAppliedSeq: 4,
    providers: { openai: { apiKey: "sk-export", oiAppliedSeq: 9, model: "gpt-4o-mini" } },
    nested: { oiAppliedSeq: 2, leftpat: "keep-leftpat" }
  });
  assert.equal(JSON.stringify(exported).includes("export-api-2"), false);
  assert.equal(JSON.stringify(exported).includes("export-jwt"), false);
  assert.equal(JSON.stringify(exported).includes("oiAppliedSeq"), false);
  assert.equal(exported.accessKey, "keep-access");
  assert.equal(exported.keyCode, "keep-keycode");
  assert.equal(exported.oiAppliedSeq, undefined);
  assert.equal(exported.providers.openai.oiAppliedSeq, undefined);
  assert.equal(exported.providers.openai.apiKey, undefined);
  assert.equal(exported.providers.openai.model, "gpt-4o-mini");
  assert.equal(exported.nested.oiAppliedSeq, undefined);
  assert.equal(exported.nested.leftpat, "keep-leftpat");
  const importedSeq = prepareSettingsImport({
    settings: {
      targetLang: "ja",
      oiAppliedSeq: 4,
      providers: { openai: { oiAppliedSeq: 8, baseUrl: "https://api.openai.com/v1" } },
      list: [{ oiAppliedSeq: 1, patch: "keep-patch" }]
    }
  });
  assert.equal(importedSeq.settings.oiAppliedSeq, undefined);
  assert.equal(importedSeq.settings.targetLang, "ja");
  assert.equal(importedSeq.settings.providers.openai.oiAppliedSeq, undefined);
  assert.equal(importedSeq.settings.providers.openai.baseUrl, "https://api.openai.com/v1");
  assert.equal(importedSeq.settings.list[0].oiAppliedSeq, undefined);
  assert.equal(importedSeq.settings.list[0].patch, "keep-patch");
});

test("a key-only import does not save or clear pdf layout", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  const page = mountPage("#pdf");
  const { startOptions } = await import("../options/options.js?key-only-import=1");
  await startOptions();
  await flush();
  chrome.sync.settings.pdfLayout.mode = "local";
  chrome.sync.settings.pdfLayout.localBaseUrl = "http://127.0.0.1:9999";
  const saves = chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").length;
  const input = page.document.getElementById("importFile");
  const file = new File([JSON.stringify({
    settings: { pdfLayout: { cloudApiKey: "only-pdf-cloud" }, auth: "only-auth", passphrase: "only-pass" }
  })], "keys-only.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
  fire(input, "change");
  await flush();
  assert.equal(page.document.getElementById("status").textContent, "文件里的 API 密钥已忽略，请在本机重新填写。");
  assert.notEqual(page.document.getElementById("status").textContent, "已导入");
  assert.equal(chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").length, saves);
  assert.equal(chrome.sync.settings.pdfLayout.mode, "local");
  assert.equal(chrome.sync.settings.pdfLayout.localBaseUrl, "http://127.0.0.1:9999");
  assert.equal(JSON.stringify(chrome.sync.settings).includes("only-pdf-cloud"), false);
  assert.equal(JSON.stringify(chrome.sync.settings).includes("only-auth"), false);
});

test("a key edit already sent does not land after the key is removed", async () => {
  const typed = "sk-should-not-return";
  for (const legacy of [false, true]) {
    const chrome = installChrome({ settings: savedSettings() });
    chrome.legacyBackground = legacy;
    const page = mountPage("#translate");
    const mod = await import(`../options/options.js?defer-write=${legacy ? "old" : "new"}`);
    await mod.startOptions();
    await flush();
    let release;
    chrome.holdNextWrite = new Promise((resolve) => {
      release = resolve;
    });
    const key = page.document.querySelector("[data-key-slot='translate'] input");
    key.value = typed;
    fire(key, "blur");
    await flush();
    if (legacy) assert.equal(chrome.sync.settings.providers.openai.apiKey, OPENAI_KEY);
    else assert.equal(String(chrome.local.oiSecrets.providers.openai), OPENAI_KEY);
    const remove = [...page.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "移除密钥");
    remove.click();
    await flush();
    if (legacy) assert.equal(chrome.sync.settings.providers.openai.apiKey, OPENAI_KEY);
    else assert.equal(String(chrome.local.oiSecrets.providers.openai), OPENAI_KEY);
    release();
    await settle();
    if (legacy) assert.equal(chrome.sync.settings.providers.openai.apiKey, "");
    else assert.equal(String(chrome.local.oiSecrets.providers.openai), "");
    assert.equal(JSON.stringify(chrome.sync.settings).includes(typed), false);
    assert.equal(JSON.stringify(chrome.local).includes(typed), false);
    const shown = page.document.querySelector("[data-key-slot='translate'] input").value;
    assert.equal(shown.includes("should-not-return"), false);
    assert.equal(shown.includes("turn"), false);
  }
});

test("a newer key wins when an older edit lands after it was saved", async () => {
  const stale = "sk-should-not-return";
  const newest = "sk-newest-bbbb";
  for (const legacy of [false, true]) {
    const chrome = installChrome({ settings: savedSettings() });
    chrome.legacyBackground = legacy;
    const page = mountPage("#translate");
    const mod = await import(`../options/options.js?defer-ab=${legacy ? "old" : "new"}`);
    await mod.startOptions();
    await flush();
    let release;
    chrome.holdNextWrite = new Promise((resolve) => {
      release = resolve;
    });
    const key = page.document.querySelector("[data-key-slot='translate'] input");
    key.value = stale;
    fire(key, "blur");
    await flush();
    if (legacy) assert.equal(chrome.sync.settings.providers.openai.apiKey, OPENAI_KEY);
    else assert.equal(String(chrome.local.oiSecrets.providers.openai), OPENAI_KEY);
    const remove = [...page.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "移除密钥");
    remove.click();
    await flush();
    if (legacy) assert.equal(chrome.sync.settings.providers.openai.apiKey, OPENAI_KEY);
    else assert.equal(String(chrome.local.oiSecrets.providers.openai), OPENAI_KEY);
    const next = page.document.querySelector("[data-key-slot='translate'] input");
    next.value = newest;
    fire(next, "blur");
    await flush();
    if (legacy) assert.equal(chrome.sync.settings.providers.openai.apiKey, OPENAI_KEY);
    else assert.equal(String(chrome.local.oiSecrets.providers.openai), OPENAI_KEY);
    release();
    await settle();
    if (legacy) assert.equal(chrome.sync.settings.providers.openai.apiKey, newest);
    else assert.equal(String(chrome.local.oiSecrets.providers.openai), newest);
    assert.equal(JSON.stringify(chrome.sync.settings).includes(stale), false);
    assert.equal(JSON.stringify(chrome.local).includes(stale), false);
    const shown = page.document.querySelector("[data-key-slot='translate'] input").value;
    assert.equal(shown.includes("should-not-return"), false);
    assert.equal(shown.includes("turn"), false);
    assert.notEqual(shown, "");
    assert.equal(shown.includes("bbbb"), true);
  }
});

function permute(items) {
  if (items.length <= 1) return [items];
  const out = [];
  for (let i = 0; i < items.length; i += 1) {
    const head = items[i];
    for (const tail of permute(items.filter((_, index) => index !== i))) out.push([head, ...tail]);
  }
  return out;
}

test("key ops stay in order on both backgrounds, including a failed last write", async () => {
  const actions = [
    { kind: "edit", value: "sk-action-AAAA" },
    { kind: "remove", value: "" },
    { kind: "edit", value: "sk-action-BBBB" }
  ];
  let caseNo = 0;
  for (const legacy of [false, true]) {
    for (const outcome of ["success", "failure"]) {
      for (const order of permute(actions)) {
        caseNo += 1;
        const chrome = installChrome({ settings: savedSettings() });
        chrome.legacyBackground = legacy;
        if (outcome === "failure") chrome.failKeySeq = order.length;
        const page = mountPage("#translate");
        const mod = await import(`../options/options.js?key-queue=${caseNo}`);
        await mod.startOptions();
        await flush();
        let release = () => {};
        chrome.holdNextWrite = new Promise((resolve) => {
          release = resolve;
        });
        for (const action of order) {
          if (action.kind === "remove") {
            const button = [...page.document.querySelectorAll("[data-key-slot='translate'] button")].find((node) => node.textContent === "移除密钥");
            button.click();
          } else {
            const input = page.document.querySelector("[data-key-slot='translate'] input");
            input.value = action.value;
            fire(input, "blur");
          }
        }
        await flush();
        release();
        await settle();
        const previous = order[order.length - 2];
        const last = order[order.length - 1];
        const produced = (action) => (action.kind === "remove" ? "" : action.value);
        const expected = outcome === "failure" ? produced(previous) : produced(last);
        const stored = legacy
          ? String(chrome.sync.settings.providers.openai.apiKey || "")
          : String(chrome.local.oiSecrets.providers.openai || "");
        assert.equal(stored, expected, `${legacy ? "old" : "new"} ${outcome} ${order.map((action) => action.kind).join(">")}`);
        const dropped = order.map(produced).filter((value) => value && value !== expected);
        const bag = JSON.stringify(legacy ? chrome.sync.settings : chrome.local);
        for (const value of dropped) assert.equal(bag.includes(value), false, value);
        const shown = page.document.querySelector("[data-key-slot='translate'] input").value;
        if (!expected) assert.equal(shown, "");
        else assert.equal(shown.includes(expected.slice(-4)), true, shown);
        const seq = Number(chrome.local.oiSecrets?.seq?.openai || 0);
        assert.equal(seq, outcome === "failure" ? order.length - 1 : order.length, `${legacy ? "old" : "new"} ${outcome} ${order.map((action) => action.kind).join(">")} seq ${seq}`);
      }
    }
  }
});

test("numbered and token names in a key-only file are not imported", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  const page = mountPage("#data");
  const { startOptions } = await import("../options/options.js?digit-key-import=1");
  await startOptions();
  await flush();
  chrome.sync.settings.pdfLayout.mode = "local";
  chrome.sync.settings.pdfLayout.localBaseUrl = "http://127.0.0.1:9999";
  chrome.sync.settings.pdfLayout.cloudModel = "glm-ocr";
  const saves = () => chrome.calls.filter((call) => call.type === "OI_SAVE_SETTINGS").length;
  const before = saves();
  async function load(settings) {
    const input = page.document.getElementById("importFile");
    const file = new File([JSON.stringify({ settings })], "keys.json", { type: "application/json" });
    Object.defineProperty(input, "files", { configurable: true, get: () => [file] });
    fire(input, "change");
    await flush();
  }
  await load({ apiKey2: "only-api-key-2" });
  assert.equal(page.document.getElementById("status").textContent, "文件里的 API 密钥已忽略，请在本机重新填写。");
  assert.notEqual(page.document.getElementById("status").textContent, "已导入");
  await load({ pdfLayout: { apiKey2: "only-layout-2" } });
  assert.equal(page.document.getElementById("status").textContent, "文件里的 API 密钥已忽略，请在本机重新填写。");
  await load({ jwt: "only-jwt", cookies: "only-cookies", sessionCookie: "only-session", pat: "only-pat" });
  assert.equal(page.document.getElementById("status").textContent, "文件里的 API 密钥已忽略，请在本机重新填写。");
  assert.equal(saves(), before);
  assert.equal(chrome.sync.settings.pdfLayout.mode, "local");
  assert.equal(chrome.sync.settings.pdfLayout.localBaseUrl, "http://127.0.0.1:9999");
  assert.equal(chrome.sync.settings.pdfLayout.cloudModel, "glm-ocr");
  const stored = JSON.stringify(chrome.sync.settings);
  for (const secret of ["only-api-key-2", "only-layout-2", "only-jwt", "only-cookies", "only-session", "only-pat"]) {
    assert.equal(stored.includes(secret), false, secret);
  }
});

test("missing-field attention is stored, and the translate badge shows when the failure is not a borrow", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  const page = mountPage("#translate");
  const { startOptions } = await import("../options/options.js?missing-field=1");
  await startOptions();
  await flush();
  const providerSelect = page.document.getElementById("provider");
  providerSelect.value = "deepl";
  fire(providerSelect, "change");
  await flush();
  page.document.getElementById("testConnection").click();
  await flush();
  assert.equal(page.document.querySelector("[data-badge='translate']").hidden, false);
  assert.equal(chrome.local.oiProviderAttention.deepl, true);
  assert.equal(JSON.stringify(chrome.local.oiProviderAttention).includes(OPENAI_KEY), false);
  assert.equal(chrome.sync.settings.oiProviderAttention, undefined);
  assert.equal(page.document.getElementById("translateBorrowHint"), null);
  const hints = [...page.document.querySelectorAll("#panel-translate p.hint")];
  assert.equal(hints.length, 1);
  assert.equal(hints[0].hidden, false);
  assert.match(hints[0].textContent, /只显示当前默认引擎的配置/);
  assert.equal(hints[0].textContent.includes("正在借用"), false);
  assert.equal(hints[0].textContent.includes("MyMemory"), false);
  const panel = page.document.getElementById("panel-translate").textContent;
  assert.equal(panel.includes("借用"), false);

  const refreshed = mountPage("#translate");
  await startOptions();
  await flush();
  assert.equal(refreshed.document.getElementById("provider").value, "deepl");
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, false);
  assert.equal(chrome.local.oiProviderAttention.deepl, true);
});

test("settings page keeps the original engine hint while borrowing, and an own engine does not copy the multimodal key", async () => {
  const mmKey = "sk-mm-borrow-hint";
  const chrome = installChrome({
    settings: {
      settingsVersion: SETTINGS_VERSION,
      provider: "openai",
      sourceLang: "auto",
      targetLang: "zh-CN",
      providers: { openai: { apiKey: "" } }
    },
    local: {
      formulaSettings: {
        multimodal: { provider: "kimi", apiKey: mmKey, model: "kimi-k2", baseUrl: "" }
      }
    }
  });
  const page = mountPage("#translate");
  const { startOptions } = await import("../options/options.js?borrow-hint=1");
  await startOptions();
  await flush();
  function engineHint() {
    const hints = [...page.document.querySelectorAll("#panel-translate p.hint")];
    assert.equal(hints.length, 1);
    return hints[0];
  }
  assert.equal(page.document.getElementById("translateBorrowHint"), null);
  assert.equal(page.document.querySelector("#panel-translate [aria-live]"), null);
  assert.equal(page.document.querySelector("#panel-translate .set-borrow"), null);
  const hint = engineHint();
  assert.equal(hint.hidden, false);
  assert.match(hint.textContent, /只显示当前默认引擎的配置/);
  assert.equal(hint.textContent.includes("正在借用"), false);
  assert.equal(hint.textContent.includes("单独设置"), false);
  assert.equal(hint.textContent.includes(mmKey), false);
  const panel = page.document.getElementById("panel-translate").textContent;
  assert.equal(panel.includes("借用"), false);
  assert.equal(page.document.querySelector("[data-badge='translate']").hidden, true);
  page.document.getElementById("testConnection").click();
  await flush();
  assert.equal(page.document.querySelector("[data-badge='translate']").hidden, false);
  assert.equal(chrome.local.oiProviderAttention.openai, true);
  assert.equal(engineHint().hidden, false);

  const provider = page.document.getElementById("provider");
  provider.value = "mymemory";
  fire(provider, "change");
  await flush();
  assert.match(engineHint().textContent, /只显示当前默认引擎的配置/);
  assert.equal(engineHint().hidden, false);

  provider.value = "openai";
  fire(provider, "change");
  await flush();
  assert.equal(page.document.getElementById("translateBorrowHint"), null);
  const key = page.document.querySelector("[data-key-slot='translate'] input");
  key.value = "sk-own-engine-key";
  fire(key, "blur");
  await flush();
  assert.match(engineHint().textContent, /只显示当前默认引擎的配置/);
  assert.equal(engineHint().hidden, false);
  const stored = JSON.stringify(chrome.sync.settings) + JSON.stringify(chrome.local.oiSecrets || {});
  assert.equal(stored.includes(mmKey), false);
  assert.equal(chrome.local.formulaSettings.multimodal.apiKey, mmKey);
});

function storedProviderKey(chrome, legacy) {
  if (legacy) return String(chrome.sync.settings.providers?.openai?.apiKey || "");
  return String(chrome.local.oiSecrets?.providers?.openai || "");
}

test("an equal provider seq cannot overwrite the key", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  await saveSettings({ providers: { openai: { apiKey: "sk-seq-ONE1" } } }, {}, { openai: 1 });
  await saveSettings({ providers: { openai: { apiKey: "sk-seq-SAME" } } }, {}, { openai: 1 });
  assert.equal(chrome.local.oiSecrets.providers.openai, "sk-seq-ONE1");
  await saveSettings({}, { providers: ["openai"] }, { openai: 1 });
  assert.equal(chrome.local.oiSecrets.providers.openai, "sk-seq-ONE1");
  await saveSettings({ providers: { openai: { apiKey: "sk-seq-TWO2" } } }, {}, { openai: 2 });
  assert.equal(chrome.local.oiSecrets.providers.openai, "sk-seq-TWO2");
  await saveSettings({}, { providers: ["openai"] }, { openai: 3 });
  assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), "");
});

test("a swallowed sync failure on the old background does not commit the local key", async () => {
  const chrome = installChrome({
    settings: savedSettings(),
    local: { oiSecrets: { providers: { openai: OPENAI_KEY }, pdfCloudApiKey: PDF_KEY, seq: {}, applied: {} } }
  });
  chrome.legacyBackground = true;
  chrome.failKeySeq = 1;
  const page = mountPage("#translate");
  const mod = await import("../options/options.js?legacy-swallow=1");
  await mod.startOptions();
  await flush();
  const key = page.document.querySelector("[data-key-slot='translate'] input");
  key.value = "sk-should-not-land";
  fire(key, "blur");
  await settle();
  assert.equal(chrome.sync.settings.providers.openai.apiKey, OPENAI_KEY);
  assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), OPENAI_KEY);
  assert.equal(Number(chrome.local.oiSecrets.seq?.openai || 0), 0);
  const shown = page.document.querySelector("[data-key-slot='translate'] input").value;
  assert.equal(shown.includes("should-not-land"), false);
  assert.match(page.document.getElementById("setToast").textContent, /没保存上/);
});

test("two settings pages and a reload keep the later key on both backgrounds", async () => {
  for (const legacy of [false, true]) {
    const label = legacy ? "old" : "new";
    const chrome = installChrome({ settings: savedSettings() });
    chrome.legacyBackground = legacy;
    const pageA = mountPage("#translate");
    const modA = await import(`../options/options.js?two-tabs=${label}-a`);
    await modA.startOptions();
    await flush();
    let release;
    chrome.holdNextWrite = new Promise((resolve) => {
      release = resolve;
    });
    const keyA = pageA.document.querySelector("[data-key-slot='translate'] input");
    keyA.value = "sk-tab-AAAA";
    fire(keyA, "blur");
    await flush();
    const pageB = mountPage("#translate");
    const modB = await import(`../options/options.js?two-tabs=${label}-b`);
    await modB.startOptions();
    await flush();
    const keyB = pageB.document.querySelector("[data-key-slot='translate'] input");
    keyB.value = "sk-tab-BBBB";
    fire(keyB, "blur");
    await flush();
    assert.equal(storedProviderKey(chrome, legacy), OPENAI_KEY, `${label} tabs waiting`);
    release();
    await settle();
    assert.equal(storedProviderKey(chrome, legacy), "sk-tab-BBBB", `${label} tabs`);
    assert.equal(pageB.document.querySelector("[data-key-slot='translate'] input").value.includes("BBBB"), true);
    assert.equal(JSON.stringify(chrome.sync.settings).includes("sk-tab-AAAA"), false);
    assert.equal(JSON.stringify(chrome.local).includes("sk-tab-AAAA"), false);

    const again = installChrome({ settings: savedSettings() });
    again.legacyBackground = legacy;
    const first = mountPage("#translate");
    const before = await import(`../options/options.js?reload=${label}-before`);
    await before.startOptions();
    await flush();
    let releaseReload;
    again.holdNextWrite = new Promise((resolve) => {
      releaseReload = resolve;
    });
    const stale = first.document.querySelector("[data-key-slot='translate'] input");
    stale.value = "sk-reload-AAAA";
    fire(stale, "blur");
    await flush();
    const reloaded = mountPage("#translate");
    const after = await import(`../options/options.js?reload=${label}-after`);
    await after.startOptions();
    await flush();
    const remove = [...reloaded.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "移除密钥");
    remove.click();
    await flush();
    assert.equal(storedProviderKey(again, legacy), OPENAI_KEY, `${label} reload waiting`);
    releaseReload();
    await settle();
    assert.equal(storedProviderKey(again, legacy), "", `${label} reload`);
    assert.equal(JSON.stringify(again.sync.settings).includes("sk-reload-AAAA"), false);
    assert.equal(JSON.stringify(again.local).includes("sk-reload-AAAA"), false);
    assert.ok(Number(again.local.oiSecrets?.seq?.openai || 0) >= 2, `${label} seq`);
    assert.equal(reloaded.document.querySelector("[data-key-slot='translate'] input").value, "");
  }
});

function useTestLocks() {
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { locks: sharedEngineLocks() }
  });
}

test("cross-engine saves keep both keys when their writes interleave", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  useTestLocks();
  await getSettings();
  let release;
  chrome.holdNextSecretWrite = new Promise((resolve) => {
    release = resolve;
  });
  const openai = saveSettings({ providers: { openai: { apiKey: "sk-openai-AAAA" } } }, {}, { openai: 1 });
  await flush();
  const claude = saveSettings({ providers: { claude: { apiKey: "sk-claude-BBBB" } } }, {}, { claude: 1 });
  await flush();
  release();
  await openai;
  await claude;
  await settle();
  assert.equal(chrome.local.oiSecrets.providers.openai, "sk-openai-AAAA");
  assert.equal(chrome.local.oiSecrets.providers.claude, "sk-claude-BBBB");
  assert.equal(Number(chrome.local.oiSecrets.seq.openai), 1);
  assert.equal(Number(chrome.local.oiSecrets.seq.claude), 1);
});

test("a failed engine save rolls back only that engine", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  useTestLocks();
  await getSettings();
  let release;
  chrome.holdNextSyncSet = new Promise((resolve) => {
    release = resolve;
  });
  const openai = saveSettings({ providers: { openai: { apiKey: "sk-openai-NOPE" } } }, {}, { openai: 1 });
  await flush();
  const claude = saveSettings({ providers: { claude: { apiKey: "sk-claude-KEEP" } } }, {}, { claude: 1 });
  await flush();
  chrome.failHeldSync = true;
  release();
  await openai;
  await claude;
  await settle();
  assert.equal(chrome.local.oiSecrets.providers.claude, "sk-claude-KEEP");
  assert.equal(Number(chrome.local.oiSecrets.seq.claude), 1);
  assert.notEqual(chrome.local.oiSecrets.providers.openai, "sk-openai-NOPE");
  assert.equal(JSON.stringify(chrome.local).includes("sk-openai-NOPE"), false);
  assert.equal(JSON.stringify(chrome.sync.settings).includes("sk-openai-NOPE"), false);
});

test("a failed openai page save does not drop a claude key written while it waited", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  const page = mountPage("#translate");
  const mod = await import("../options/options.js?cross-engine-page=1");
  await mod.startOptions();
  await flush();
  let release;
  chrome.holdNextSyncSet = new Promise((resolve) => {
    release = resolve;
  });
  const key = page.document.querySelector("[data-key-slot='translate'] input");
  key.value = "sk-openai-NOPE";
  fire(key, "blur");
  await flush();
  await saveSettings({ providers: { claude: { apiKey: "sk-claude-KEEP" } } }, {}, { claude: 1 });
  chrome.failHeldSync = true;
  release();
  await settle();
  assert.equal(chrome.local.oiSecrets.providers.claude, "sk-claude-KEEP");
  assert.equal(Number(chrome.local.oiSecrets.seq?.claude || 0), 1);
  assert.notEqual(String(chrome.local.oiSecrets.providers.openai || ""), "sk-openai-NOPE");
  assert.equal(JSON.stringify(chrome.local).includes("sk-openai-NOPE"), false);
  assert.equal(JSON.stringify(chrome.sync.settings).includes("sk-openai-NOPE"), false);
  assert.equal(page.document.querySelector("[data-key-slot='translate'] input").value.includes("NOPE"), false);
});

test("releasing the lock on unload lets a new page remove the key before a stale write lands", async () => {
  for (const legacy of [false, true]) {
    const label = legacy ? "old" : "new";
    const chrome = installChrome({ settings: savedSettings() });
    chrome.legacyBackground = legacy;
    const pageA = mountPage("#translate");
    const modA = await import(`../options/options.js?unload-lock=${label}-a`);
    await modA.startOptions();
    await flush();
    let releaseSync = () => {};
    chrome.holdNextSyncSet = new Promise((resolve) => {
      releaseSync = resolve;
    });
    const stale = pageA.document.querySelector("[data-key-slot='translate'] input");
    stale.value = "sk-stale-AAAA";
    fire(stale, "blur");
    await flush();
    pageA.window.dispatchEvent(new pageA.window.Event("pagehide"));
    releaseHeldEngineLocks();
    const pageB = mountPage("#translate");
    const modB = await import(`../options/options.js?unload-lock=${label}-b`);
    let outcome = "timeout";
    try {
      outcome = await Promise.race([
        (async () => {
          await modB.startOptions();
          await flush();
          const remove = [...pageB.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "移除密钥");
          remove.click();
          await settle();
          assert.equal(storedProviderKey(chrome, legacy), "", `${label} cleared while the stale write is held`);
          return "cleared";
        })(),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000))
      ]);
      assert.equal(outcome, "cleared", `${label} lock was not released on unload`);
      releaseSync();
      await settle();
      assert.equal(storedProviderKey(chrome, legacy), "", `${label} stale write resurrected the key`);
      assert.equal(JSON.stringify(chrome.sync.settings).includes("sk-stale-AAAA"), false, label);
      assert.equal(JSON.stringify(chrome.local).includes("sk-stale-AAAA"), false, label);
      assert.equal(pageB.document.querySelector("[data-key-slot='translate'] input").value, "");
      assert.equal(String(pageA.document.getElementById("setToast").textContent || "").trim(), "", `${label} unloaded page toasted`);
      assert.notEqual(storedProviderKey(chrome, legacy), OPENAI_KEY, `${label} unloaded page rolled the key back`);
    } finally {
      releaseSync();
      releaseHeldEngineLocks();
      await settle();
    }
  }
});

test("an old background that saved the key but missed the local commit is repaired on reload", async () => {
  const newer = "sk-sync-NEW1";
  const seeded = installChrome({
    settings: {
      ...savedSettings(),
      providers: {
        openai: { apiKey: newer, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
      }
    },
    local: {
      oiSecrets: {
        providers: { openai: OPENAI_KEY },
        pdfCloudApiKey: PDF_KEY,
        seq: { openai: 2 },
        applied: { openai: 1 },
        pending: { openai: { seq: 2, value: newer } }
      }
    }
  });
  seeded.legacyBackground = true;
  const reloaded = mountPage("#translate");
  const again = await import("../options/options.js?legacy-commit-miss=seed");
  await again.startOptions();
  await settle();
  assert.equal(String(seeded.local.oiSecrets.providers.openai || ""), newer);
  assert.equal(seeded.local.oiSecrets.pending?.openai, undefined);
  assert.equal(reloaded.document.querySelector("[data-key-slot='translate'] input").value.includes("NEW1"), true);
  const lang = reloaded.document.getElementById("targetLang");
  lang.value = "ja";
  fire(lang, "change");
  await settle();
  assert.equal(String(seeded.local.oiSecrets.providers.openai || ""), newer);
  assert.equal(reloaded.document.querySelector("[data-key-slot='translate'] input").value.includes("NEW1"), true);

  const chrome = installChrome({
    settings: savedSettings(),
    local: { oiSecrets: { providers: { openai: OPENAI_KEY }, pdfCloudApiKey: PDF_KEY, seq: {}, applied: {} } }
  });
  chrome.legacyBackground = true;
  const page = mountPage("#translate");
  const mod = await import("../options/options.js?legacy-commit-miss=live");
  await mod.startOptions();
  await flush();
  chrome.failNextKeyCommit = true;
  const key = page.document.querySelector("[data-key-slot='translate'] input");
  key.value = newer;
  fire(key, "blur");
  await settle();
  assert.equal(chrome.sync.settings.providers.openai.apiKey, newer);
  assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), newer);
  assert.equal(page.document.querySelector("[data-key-slot='translate'] input").value.includes("NEW1"), true);
});

test("reconcile keeps a tombstone and does not adopt a stale sync key", async () => {
  const { decideKeyReconcile } = await import("../lib/settings-secrets.js");
  assert.equal(typeof decideKeyReconcile, "function");
  const pendingHit = decideKeyReconcile({
    providers: { openai: OPENAI_KEY },
    seq: { openai: 2 },
    applied: { openai: 1 },
    pending: { openai: { seq: 2, value: "sk-sync-NEW1" } }
  }, "openai", "sk-sync-NEW1");
  assert.equal(pendingHit.action, "commit");
  assert.equal(pendingHit.value, "sk-sync-NEW1");
  const pendingClear = decideKeyReconcile({
    providers: { openai: "" },
    seq: { openai: 3 },
    applied: { openai: 2 },
    pending: { openai: { seq: 3, value: "", sent: true } }
  }, "openai", "sk-stale-AAAA");
  assert.equal(pendingClear.action, "clearSync");
  const tombstone = decideKeyReconcile({
    providers: { openai: "" },
    seq: { openai: 4 },
    applied: { openai: 4 },
    pending: {}
  }, "openai", "sk-stale-AAAA");
  assert.equal(tombstone.action, "clearSync");
  const blankSync = decideKeyReconcile({
    providers: { openai: "sk-local-KEEP" },
    seq: { openai: 2 },
    applied: { openai: 2 },
    pending: {}
  }, "openai", "");
  assert.equal(blankSync.action, "keep");
  const staleSync = decideKeyReconcile({
    providers: { openai: "sk-local-KEEP" },
    seq: { openai: 5 },
    applied: { openai: 5 },
    pending: {}
  }, "openai", OPENAI_KEY);
  assert.equal(staleSync.action, "writeSync");
  assert.equal(staleSync.value, "sk-local-KEEP");
  assert.equal(staleSync.seq, 5);
  const pendingSave = decideKeyReconcile({
    providers: { openai: "sk-local-AAAA" },
    seq: { openai: 4 },
    applied: { openai: 1 },
    pending: { openai: { seq: 4, value: "sk-pending-CCCC", sent: true } }
  }, "openai", "sk-sync-BBBB");
  assert.equal(pendingSave.action, "keep");
  assert.notEqual(pendingSave.action, "writeSync");
  const equalDevice = decideKeyReconcile({
    providers: { openai: "sk-equal-EEEE" },
    seq: { openai: 4 },
    applied: { openai: 4 },
    pending: {}
  }, "openai", "sk-sync-BBBB", 4);
  assert.equal(equalDevice.action, "keep");
  const olderDevice = decideKeyReconcile({
    providers: { openai: "sk-older-DDDD" },
    seq: { openai: 3 },
    applied: { openai: 3 },
    pending: {}
  }, "openai", "sk-sync-BBBB", 4);
  assert.equal(olderDevice.action, "keep");
  const newerDevice = decideKeyReconcile({
    providers: { openai: "sk-newer-CCCC" },
    seq: { openai: 6 },
    applied: { openai: 6 },
    pending: {}
  }, "openai", "sk-sync-BBBB", 4);
  assert.equal(newerDevice.action, "writeSync");
  assert.equal(newerDevice.value, "sk-newer-CCCC");
  assert.equal(newerDevice.seq, 6);
  const unsentClear = decideKeyReconcile({
    providers: { openai: OPENAI_KEY },
    seq: { openai: 2 },
    applied: { openai: 1 },
    pending: { openai: { seq: 2, value: "", sent: false } }
  }, "openai", "");
  assert.equal(unsentClear.action, "dropPending");
  assert.notEqual(unsentClear.action, "commit");
  const sentClear = decideKeyReconcile({
    providers: { openai: OPENAI_KEY },
    seq: { openai: 2 },
    applied: { openai: 1 },
    pending: { openai: { seq: 2, value: "", sent: true } }
  }, "openai", "");
  assert.equal(sentClear.action, "commit");
  assert.equal(sentClear.value, "");
});

test("a late stale key on the old background does not stay in sync after a newer key is confirmed", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  chrome.legacyBackground = true;
  const pageA = mountPage("#translate");
  const modA = await import("../options/options.js?stale-sync=a");
  await modA.startOptions();
  await flush();
  let releaseSync = () => {};
  chrome.holdNextSyncSet = new Promise((resolve) => {
    releaseSync = resolve;
  });
  const stale = pageA.document.querySelector("[data-key-slot='translate'] input");
  stale.value = "sk-stale-AAAA";
  fire(stale, "blur");
  await flush();
  pageA.window.dispatchEvent(new pageA.window.Event("pagehide"));
  releaseHeldEngineLocks();
  const pageB = mountPage("#translate");
  const modB = await import("../options/options.js?stale-sync=b");
  try {
    await modB.startOptions();
    await flush();
    const keyB = pageB.document.querySelector("[data-key-slot='translate'] input");
    keyB.value = "sk-keep-BBBB";
    fire(keyB, "blur");
    await settle();
    assert.equal(chrome.sync.settings.providers.openai.apiKey, "sk-keep-BBBB");
    assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), "sk-keep-BBBB");
    releaseSync();
    await settle();
    assert.equal(chrome.sync.settings.providers.openai.apiKey, "sk-keep-BBBB");
    assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), "sk-keep-BBBB");
    assert.equal(pageB.document.querySelector("[data-key-slot='translate'] input").value.includes("BBBB"), true);
    assert.equal(JSON.stringify(chrome.sync.settings).includes("sk-stale-AAAA"), false);
    const reopened = mountPage("#translate");
    const modC = await import("../options/options.js?stale-sync=c");
    await modC.startOptions();
    await settle();
    assert.equal(chrome.sync.settings.providers.openai.apiKey, "sk-keep-BBBB");
    assert.equal(reopened.document.querySelector("[data-key-slot='translate'] input").value.includes("BBBB"), true);
  } finally {
    releaseSync();
    releaseHeldEngineLocks();
    await settle();
  }
});

test("a failed save rolls the pdf cloud key back with the provider keys", async () => {
  const chrome = installChrome({ settings: savedSettings() });
  useTestLocks();
  await getSettings();
  let release;
  chrome.holdNextSyncSet = new Promise((resolve) => {
    release = resolve;
  });
  const saving = saveSettings({ pdfLayout: { cloudApiKey: "pdf-new-NOPE" } });
  await flush();
  const claude = saveSettings({ providers: { claude: { apiKey: "sk-claude-KEEP" } } }, {}, { claude: 1 });
  await flush();
  chrome.failHeldSync = true;
  release();
  const saved = await saving;
  await claude;
  assert.equal(saved.settingsSaved, false);
  assert.equal(String(chrome.local.oiSecrets.pdfCloudApiKey || ""), PDF_KEY);
  assert.equal(JSON.stringify(chrome.local).includes("pdf-new-NOPE"), false);
  assert.equal(chrome.local.oiSecrets.providers.claude, "sk-claude-KEEP");
});

test("a reserved removal that was never sent is not applied on the next open", async () => {
  const chrome = installChrome({
    settings: {
      ...savedSettings(),
      providers: {
        openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
      }
    },
    local: {
      oiSecrets: {
        providers: { openai: OPENAI_KEY },
        pdfCloudApiKey: PDF_KEY,
        seq: { openai: 2 },
        applied: { openai: 1 },
        pending: { openai: { seq: 2, value: "", sent: false } }
      }
    }
  });
  const page = mountPage("#translate");
  const mod = await import("../options/options.js?unsent-clear=1");
  await mod.startOptions();
  await settle();
  assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), OPENAI_KEY);
  assert.equal(chrome.local.oiSecrets.pending?.openai, undefined);
  assert.equal(page.document.querySelector("[data-key-slot='translate'] input").value.includes("f9a"), true);
});

test("a saved key does not toast failure, and a failed clear is retried on the same page", async () => {
  const newer = "sk-sync-NEW1";
  const chrome = installChrome({
    settings: savedSettings(),
    local: { oiSecrets: { providers: { openai: OPENAI_KEY }, pdfCloudApiKey: PDF_KEY, seq: {}, applied: {} } }
  });
  chrome.legacyBackground = true;
  const page = mountPage("#translate");
  const mod = await import("../options/options.js?toast-and-retry=1");
  await mod.startOptions();
  await flush();
  chrome.failNextKeyCommit = true;
  const key = page.document.querySelector("[data-key-slot='translate'] input");
  key.value = newer;
  fire(key, "blur");
  await settle();
  assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), newer);
  assert.equal(String(page.document.getElementById("setToast").textContent || "").includes("没保存上"), false);

  chrome.sync.settings.providers.openai.apiKey = "sk-stale-AAAA";
  chrome.local.oiSecrets.providers.openai = "";
  chrome.local.oiSecrets.applied = { openai: 3 };
  chrome.local.oiSecrets.seq = { openai: 3 };
  chrome.failClearTimes = 1;
  await globalThis.chrome.storage.local.set({ oiSecrets: chrome.local.oiSecrets });
  await settle();
  assert.equal(String(chrome.sync.settings.providers.openai.apiKey || ""), "");
});

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("seeded secret interleaving keeps each confirmed key for 200 trials", async () => {
  const { decideKeyReconcile } = await import("../lib/settings-secrets.js");
  for (let trial = 0; trial < 200; trial += 1) {
    const rand = mulberry32(0xA11CE + trial);
    const chrome = installChrome({
      settings: savedSettings(),
      local: {
        oiSecrets: {
          providers: { openai: OPENAI_KEY },
          pdfCloudApiKey: PDF_KEY,
          seq: { openai: 1 },
          applied: { openai: 1 },
          pending: {}
        }
      }
    });
    useTestLocks();
    await getSettings();
    let openai = OPENAI_KEY;
    let openaiSeq = 1;
    let claude = "";
    const steps = 3 + Math.floor(rand() * 3);
    for (let step = 0; step < steps; step += 1) {
      const kind = rand();
      if (kind < 0.45) {
        const key = `sk-o-${trial.toString(16)}-${step}`;
        openaiSeq += 1;
        const saved = await saveSettings({ providers: { openai: { apiKey: key } } }, {}, { openai: openaiSeq });
        if (saved.settingsSaved !== false) openai = key;
      } else if (kind < 0.7) {
        const key = `sk-c-${trial.toString(16)}-${step}`;
        const saved = await saveSettings({ providers: { claude: { apiKey: key } } }, {}, { claude: step + 1 });
        if (saved.settingsSaved !== false) claude = key;
      } else if (kind < 0.85) {
        const next = `pdf-${trial}-${step}`;
        const before = String(chrome.local.oiSecrets.pdfCloudApiKey || "");
        chrome.failNextSync = rand() < 0.5;
        const saved = await saveSettings({ pdfLayout: { mode: "cloud", cloudApiKey: next } });
        if (saved.settingsSaved === false) {
          assert.equal(String(chrome.local.oiSecrets.pdfCloudApiKey || ""), before, `trial ${trial} pdf rollback`);
        }
      } else {
        const planted = `sk-stale-${trial}`;
        chrome.sync.settings.providers.openai.apiKey = planted;
        chrome.local.oiSecrets.pending = {
          ...(chrome.local.oiSecrets.pending || {}),
          openai: { seq: openaiSeq + 1, value: "", sent: false }
        };
        const decision = decideKeyReconcile(chrome.local.oiSecrets, "openai", planted);
        assert.notEqual(decision.action, "commit", `trial ${trial} unsent clear`);
        assert.equal(decision.action, "writeSync", `trial ${trial} stale sync`);
        assert.equal(decision.value, openai, `trial ${trial} sync target`);
        delete chrome.local.oiSecrets.pending.openai;
      }
    }
    assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), openai, `trial ${trial} openai`);
    if (claude) assert.equal(chrome.local.oiSecrets.providers.claude, claude, `trial ${trial} claude`);
  }
});

test("two old-background tabs closed mid-save do not write the older key back", async () => {
  const appliedKey = "sk-local-AAAA";
  const chrome = installChrome({
    settings: {
      ...savedSettings(),
      providers: {
        openai: { apiKey: appliedKey, baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
      }
    },
    local: {
      oiSecrets: {
        providers: { openai: appliedKey },
        pdfCloudApiKey: PDF_KEY,
        seq: { openai: 1 },
        applied: { openai: 1 },
        pending: {}
      }
    }
  });
  chrome.legacyBackground = true;
  const pageB = mountPage("#translate");
  const modB = await import("../options/options.js?both-closed=b");
  await modB.startOptions();
  await flush();
  let releaseB = () => {};
  chrome.holdNextSyncSet = new Promise((resolve) => {
    releaseB = resolve;
  });
  const inputB = pageB.document.querySelector("[data-key-slot='translate'] input");
  inputB.value = "sk-sync-BBBB";
  fire(inputB, "blur");
  await flush();
  pageB.window.dispatchEvent(new pageB.window.Event("pagehide"));
  releaseHeldEngineLocks();
  const pageC = mountPage("#translate");
  const modC = await import("../options/options.js?both-closed=c");
  let releaseC = () => {};
  chrome.holdNextSyncSet = new Promise((resolve) => {
    releaseC = resolve;
  });
  try {
    await modC.startOptions();
    await flush();
    const inputC = pageC.document.querySelector("[data-key-slot='translate'] input");
    inputC.value = "sk-pending-CCCC";
    fire(inputC, "blur");
    await flush();
    pageC.window.dispatchEvent(new pageC.window.Event("pagehide"));
    releaseHeldEngineLocks();
    releaseB();
    await flush();
    const pageD = mountPage("#translate");
    const modD = await import("../options/options.js?both-closed=d");
    await modD.startOptions();
    await settle();
    assert.equal(chrome.sync.settings.providers.openai.apiKey, "sk-sync-BBBB");
    assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), appliedKey);
    assert.equal(chrome.calls.some((message) => message?.patch?.providers?.openai?.apiKey === appliedKey && Number(message?.keySeq?.openai) === Number(chrome.local.oiSecrets.pending?.openai?.seq)), false);
    releaseC();
    await settle();
    assert.equal(chrome.sync.settings.providers.openai.apiKey, "sk-pending-CCCC");
    assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), "sk-pending-CCCC");
  } finally {
    releaseB();
    releaseC();
    releaseHeldEngineLocks();
    await settle();
  }
});

test("two devices on the old background stop overwriting each other's key", async () => {
  const { decideKeyReconcile } = await import("../lib/settings-secrets.js");
  const deviceA = {
    providers: { openai: "sk-device-AAAA" },
    applied: { openai: 4 },
    seq: { openai: 4 },
    pending: {}
  };
  const deviceB = {
    providers: { openai: "sk-device-BBBB" },
    applied: { openai: 4 },
    seq: { openai: 4 },
    pending: {}
  };
  let syncKey = "sk-device-AAAA";
  let syncSeq;
  const apply = (bag) => {
    const decision = decideKeyReconcile(bag, "openai", syncKey, syncSeq);
    if (decision.action === "writeSync") {
      if (syncSeq != null) assert.ok(decision.seq > syncSeq);
      syncKey = decision.value;
      syncSeq = decision.seq;
    }
    return decision.action;
  };
  for (let round = 0; round < 6; round += 1) {
    apply(deviceA);
    apply(deviceB);
  }
  const settledKey = syncKey;
  const settledSeq = syncSeq;
  for (let round = 0; round < 4; round += 1) {
    assert.notEqual(apply(deviceA), "writeSync");
    assert.notEqual(apply(deviceB), "writeSync");
  }
  assert.equal(syncKey, settledKey);
  assert.equal(syncSeq, settledSeq);

  const chrome = installChrome({
    settings: {
      ...savedSettings(),
      providers: {
        openai: { apiKey: "sk-sync-BBBB", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" }
      }
    },
    local: {
      oiSecrets: {
        providers: { openai: "sk-local-AAAA" },
        pdfCloudApiKey: PDF_KEY,
        seq: { openai: 5 },
        applied: { openai: 5 },
        pending: {}
      }
    }
  });
  chrome.legacyBackground = true;
  const page = mountPage("#translate");
  const mod = await import("../options/options.js?two-devices=1");
  await mod.startOptions();
  await settle();
  assert.equal(chrome.sync.settings.providers.openai.apiKey, "sk-local-AAAA");
  assert.equal(Number(chrome.sync.settings.providers.openai.oiAppliedSeq), 5);
  chrome.local.oiSecrets.providers.openai = "sk-other-BBBB";
  chrome.local.oiSecrets.applied = { openai: 5 };
  chrome.local.oiSecrets.seq = { openai: 5 };
  await globalThis.chrome.storage.local.set({ oiSecrets: chrome.local.oiSecrets });
  await settle();
  assert.equal(chrome.sync.settings.providers.openai.apiKey, "sk-local-AAAA");
  assert.equal(Number(chrome.sync.settings.providers.openai.oiAppliedSeq), 5);
  chrome.local.oiSecrets.providers.openai = "sk-newer-CCCC";
  chrome.local.oiSecrets.applied = { openai: 6 };
  chrome.local.oiSecrets.seq = { openai: 6 };
  await globalThis.chrome.storage.local.set({ oiSecrets: chrome.local.oiSecrets });
  await settle();
  assert.equal(chrome.sync.settings.providers.openai.apiKey, "sk-newer-CCCC");
  assert.equal(Number(chrome.sync.settings.providers.openai.oiAppliedSeq), 6);
  assert.equal(page.document.querySelector("[data-key-slot='translate'] input").value.includes("CCCC"), true);
});

test("a higher pending seq defers a write the recorded sync seq would still allow", async () => {
  const { decideKeyReconcile } = await import("../lib/settings-secrets.js");
  const deferred = decideKeyReconcile({
    providers: { openai: "sk-applied-AAAA" },
    seq: { openai: 8 },
    applied: { openai: 5 },
    pending: { openai: { seq: 8, value: "sk-pending-HHHH", sent: false } }
  }, "openai", "sk-sync-BBBB", 2);
  assert.equal(deferred.action, "keep");
  assert.notEqual(deferred.value, "sk-applied-AAAA");
  assert.notEqual(deferred.seq, 8);
  const sent = decideKeyReconcile({
    providers: { openai: "sk-applied-AAAA" },
    seq: { openai: 8 },
    applied: { openai: 5 },
    pending: { openai: { seq: 8, value: "sk-pending-HHHH", sent: true } }
  }, "openai", "sk-sync-BBBB", 2);
  assert.equal(sent.action, "keep");
  assert.notEqual(sent.seq, 8);
});

test("run-together pat names are stripped and ordinary pat endings stay", async () => {
  const kept = prepareSettingsImport({
    settings: {
      leftpat: "keep-leftpat",
      wirecompat: "keep-wirecompat",
      browserCompat: "keep-browser-compat",
      cssCompat: "keep-css-compat"
    }
  });
  assert.equal(kept.settings.leftpat, "keep-leftpat");
  assert.equal(kept.settings.wirecompat, "keep-wirecompat");
  assert.equal(kept.settings.browserCompat, "keep-browser-compat");
  assert.equal(kept.settings.cssCompat, "keep-css-compat");
  for (const name of ["pats", "compatPat", "notAnApiKeyField", "xpat", "githubpat", "mypat"]) {
    const stripped = prepareSettingsImport({ settings: { [name]: "only-one" } });
    assert.equal(stripped.ignoredKeys, true, name);
    assert.equal(settingsImportHasChanges(stripped.settings), false, name);
  }
});

test("a queued repair does not send the old key after a higher pending appears", async () => {
  const chrome = installChrome({
    settings: savedSettings(),
    local: {
      oiSecrets: {
        providers: { openai: OPENAI_KEY },
        pdfCloudApiKey: PDF_KEY,
        seq: { openai: 1 },
        applied: { openai: 1 },
        pending: {}
      }
    }
  });
  const page = mountPage("#translate");
  const mod = await import("../options/options.js?repair-interrupt=1");
  await mod.startOptions();
  await flush();
  let releaseLock = () => {};
  const held = globalThis.navigator.locks.request("oi-secret-openai", () => new Promise((resolve) => {
    releaseLock = resolve;
  }));
  await flush();
  const planted = JSON.parse(JSON.stringify(chrome.sync.settings));
  planted.providers.openai.apiKey = "sk-sync-BBBB";
  delete planted.providers.openai.oiAppliedSeq;
  await globalThis.chrome.storage.sync.set({ settings: planted });
  await flush();
  const bag = JSON.parse(JSON.stringify(chrome.local.oiSecrets));
  bag.seq.openai = 4;
  bag.pending.openai = { seq: 4, value: "sk-pending-CCCC", sent: true };
  const before = chrome.calls.filter((message) => message?.type === "OI_SAVE_SETTINGS").length;
  await globalThis.chrome.storage.local.set({ oiSecrets: bag });
  await flush();
  releaseLock();
  await held;
  await settle();
  const saves = chrome.calls.slice(before).filter((message) => message?.type === "OI_SAVE_SETTINGS");
  assert.equal(saves.some((message) => message?.patch?.providers?.openai?.apiKey === OPENAI_KEY), false);
  assert.equal(saves.some((message) => Number(message?.keySeq?.openai) === 4 && message?.patch?.providers?.openai?.apiKey === OPENAI_KEY), false);
  assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), OPENAI_KEY);
  assert.equal(String(page.document.getElementById("setToast").textContent || "").trim(), "");
});

test("an in-flight save stamps its own seq and a closed page does not roll it back", async () => {
  const newer = "sk-stamp-NEW1";
  const chrome = installChrome({
    settings: savedSettings(),
    local: {
      oiSecrets: {
        providers: { openai: OPENAI_KEY },
        pdfCloudApiKey: PDF_KEY,
        seq: { openai: 1 },
        applied: { openai: 1 },
        pending: {}
      }
    }
  });
  const page = mountPage("#translate");
  const mod = await import("../options/options.js?stamp-interrupt=1");
  await mod.startOptions();
  await flush();
  let release = () => {};
  chrome.holdNextSyncSet = new Promise((resolve) => {
    release = resolve;
  });
  try {
    const input = page.document.querySelector("[data-key-slot='translate'] input");
    input.value = newer;
    fire(input, "blur");
    await flush();
    const stamped = chrome.calls.filter((message) => message?.type === "OI_SAVE_SETTINGS" && message?.patch?.providers?.openai?.apiKey === newer).at(-1);
    assert.ok(stamped);
    assert.equal(Number(stamped.keySeq.openai), Number(stamped.patch.providers.openai.oiAppliedSeq));
    assert.equal(Number(stamped.keySeq.openai), Number(chrome.local.oiSecrets.pending?.openai?.seq || chrome.local.oiSecrets.applied?.openai));
    assert.notEqual(stamped.patch.providers.openai.apiKey, OPENAI_KEY);
    page.window.dispatchEvent(new page.window.Event("pagehide"));
    release();
    await settle();
    assert.equal(String(page.document.getElementById("setToast").textContent || "").trim(), "");
    assert.equal(String(chrome.local.oiSecrets.providers.openai || ""), newer);
    assert.equal(String(chrome.sync.settings.providers.openai.apiKey || ""), "");
  } finally {
    release();
    releaseHeldEngineLocks();
    await settle();
  }
});

function focusTab(tab) {
  globalThis.document = tab.page.document;
  globalThis.window = tab.page.window;
}

function assertNewKeyStep(chrome, state, step) {
  const bag = chrome.local.oiSecrets || {};
  const applied = Number(bag.applied?.openai || 0);
  const localKey = String(bag.providers?.openai || "");
  const where = `seed ${state.seed} ${step}`;
  assert.ok(applied >= state.applied, `${where} applied ${applied} went down from ${state.applied}`);
  if (state.deletedAt > 0 && localKey && applied <= state.deletedAt) {
    assert.fail(`${where} deletion resurrected ${localKey}`);
  }
  const pending = bag.pending?.openai;
  if (pending && String(pending.value || "") !== "" && Number(pending.seq) > applied) {
    const labeled = chrome.calls.some((message) => message?.type === "OI_SAVE_SETTINGS"
      && message?.patch?.providers?.openai?.apiKey === localKey
      && localKey !== String(pending.value)
      && Number(message?.keySeq?.openai) === Number(pending.seq));
    assert.equal(labeled, false, `${where} old key labeled with pending seq`);
  }
  assert.equal(syncHasSecrets(chrome.sync.settings), false, `${where} key leaked into sync`);
  state.applied = applied;
  if (!localKey && applied > 0) state.deletedAt = applied;
  else if (localKey && applied > state.deletedAt) state.deletedAt = 0;
}

async function runNewBackgroundSeed(seed) {
  const rand = mulberry32(seed);
  const pool = ["save", "delete", "unload", "fail"];
  const tabCount = 2 + Math.floor(rand() * 3);
  const eventCount = 2 + Math.floor(rand() * 5);
  const events = [];
  for (let i = 0; i < eventCount; i += 1) events.push(pool[Math.floor(rand() * pool.length)]);
  const chrome = installChrome({
    settings: savedSettings(),
    local: {
      oiSecrets: {
        providers: { openai: OPENAI_KEY },
        pdfCloudApiKey: PDF_KEY,
        seq: { openai: 1 },
        applied: { openai: 1 },
        pending: {}
      }
    }
  });
  const state = { seed, applied: 1, deletedAt: 0 };
  const tabs = [];
  let serial = 0;
  async function openTab() {
    const page = mountPage("#translate");
    serial += 1;
    const mod = await import(`../options/options.js?nvseed=${seed}-t${serial}`);
    await mod.startOptions();
    await flush();
    const tab = { page, alive: true };
    tabs.push(tab);
    focusTab(tab);
    return tab;
  }
  const live = () => tabs.filter((tab) => tab.alive);
  function pickTab() {
    const open = live();
    if (!open.length) return null;
    return open[Math.floor(rand() * open.length)];
  }
  for (let i = 0; i < tabCount; i += 1) await openTab();
  assertNewKeyStep(chrome, state, "open");

  async function saveOn(tab, value) {
    const target = tab?.alive ? tab : (pickTab() || await openTab());
    focusTab(target);
    const input = target.page.document.querySelector("[data-key-slot='translate'] input");
    input.value = value;
    fire(input, "blur");
    await settle();
    return target;
  }

  let n = 0;
  for (const event of events) {
    n += 1;
    if (event === "save") {
      await saveOn(pickTab(), `sk-nv-${seed.toString(16)}-${n}-save`);
    } else if (event === "delete") {
      const tab = pickTab() || await openTab();
      focusTab(tab);
      const remove = [...tab.page.document.querySelectorAll("[data-key-slot='translate'] button")].find((button) => button.textContent === "移除密钥");
      if (remove) {
        remove.click();
        await settle();
      }
    } else if (event === "unload") {
      const tab = pickTab() || await openTab();
      focusTab(tab);
      let release = () => {};
      chrome.holdNextSyncSet = new Promise((resolve) => {
        release = resolve;
      });
      const input = tab.page.document.querySelector("[data-key-slot='translate'] input");
      input.value = `sk-nv-${seed.toString(16)}-${n}-hold`;
      fire(input, "blur");
      await flush();
      tab.page.window.dispatchEvent(new tab.page.window.Event("pagehide"));
      tab.alive = false;
      releaseHeldEngineLocks();
      const other = pickTab() || await openTab();
      focusTab(other);
      const second = other.page.document.querySelector("[data-key-slot='translate'] input");
      second.value = `sk-nv-${seed.toString(16)}-${n}-next`;
      fire(second, "blur");
      await flush();
      release();
      await settle();
    } else {
      const tab = pickTab() || await openTab();
      chrome.failSave = true;
      await saveOn(tab, `sk-nv-${seed.toString(16)}-${n}-fail`);
      chrome.failSave = false;
      await saveOn(tab.alive ? tab : pickTab(), `sk-nv-${seed.toString(16)}-${n}-retry`);
    }
    assertNewKeyStep(chrome, state, event);
  }
  releaseHeldEngineLocks();
  await settle();
  assertNewKeyStep(chrome, state, "idle");
  return `${tabCount}|${events.join(",")}`;
}

test("new background interleaving holds key invariants for 500 seeds", { timeout: 240000 }, async () => {
  const seen = new Set();
  for (let n = 0; n < 500; n += 1) {
    const seed = (0xA11CE + n) >>> 0;
    try {
      seen.add(await runNewBackgroundSeed(seed));
    } catch (error) {
      console.error(`failing seed ${seed}`);
      throw new Error(`failing seed ${seed}: ${error.message}`);
    }
  }
  assert.ok(seen.size >= 400, `only ${seen.size} distinct interleavings`);
});

test("about diag focus hash keeps eight pages", () => {
  const focus = parseSettingsHash("#about?focus=diag");
  assert.equal(focus.id, "about");
  assert.equal(focus.focus, "diag");
  assert.equal(focus.replace, "#about");
  assert.equal(SETTINGS_PAGES.length, 8);
});

test("about diagnostic panel matches the diagnostic states", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const previousCreate = globalThis.URL.createObjectURL;
  const hits = [];
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => {
    hits.push("fetch");
    throw new Error("offline");
  };
  try {
    const chrome = installChrome({ settings: savedSettings() });
    const page = mountPage("#about?focus=diag");
    const { document } = page;
    const blobs = [];
    globalThis.URL.createObjectURL = (blob) => {
      blobs.push(blob);
      return "blob:oi-diag";
    };
    const { startOptions, searchHits } = await import("../options/options.js?diag-ui=1");
    const started = startOptions();
    await flush();
    mock.timers.tick(160);
    await started;
    await flush();

    assert.equal(page.location.hash, "#about");
    assert.equal(document._focused?.id, "diagExport");
    const nav = [...document.querySelectorAll("[data-nav]")].map((tab) => tab.dataset.nav);
    assert.deepEqual(nav, ["translate", "mm", "web", "pdf", "notes", "labs", "data", "about"]);
    const diag = document.getElementById("diagGroup");
    assert.equal(diag.previousElementSibling.id, "diagHeading");
    assert.match(diag.previousElementSibling.className, /set-gh/);
    assert.equal(page.document.getElementById("aboutVersionHeading").textContent, "版本");
    assert.match(page.document.getElementById("aboutVersionHeading").className, /set-gh/);
    const titles = [...diag.querySelectorAll(".set-row > .set-copy > .set-title")].map((node) => node.textContent);
    assert.deepEqual(titles, ["导出诊断包", "清空日志"]);
    assert.equal(document.getElementById("diagInclude").textContent, "包含最近 7 天的运行记录、出错原因、版本和浏览器信息。");
    assert.equal(document.getElementById("diagExclude").textContent, "已去掉 API 密钥、网址里的 token 和论文正文。不会自动上传，导出后由你决定发给谁。");
    assert.equal(document.getElementById("diagStatusText").textContent, "最近 7 天没有记录");
    assert.equal(document.getElementById("diagExport").disabled, false);
    assert.equal(searchHits("诊断")[0]?.id, "diagGroup");
    assert.equal(searchHits("日志")[0]?.id, "diagGroup");
    assert.equal(searchHits("报告问题")[0]?.id, "diagGroup");
    const exported = searchHits("导出");
    assert.equal(exported.length, 1);
    assert.notEqual(exported[0].id, "diagGroup");

    const css = readFileSync(join(root, "options/options.css"), "utf8");
    const panelSrc = readFileSync(join(root, "options/diag-panel.js"), "utf8");
    const logSrc = readFileSync(join(root, "lib/diag-log.js"), "utf8");
    assert.equal(panelSrc.includes("showSaveFilePicker"), false);
    assert.equal(logSrc.includes("showSaveFilePicker"), false);
    assert.equal(diag.tagName, "DIV");
    assert.equal(diag.getAttribute("role"), "group");
    assert.equal(diag.getAttribute("aria-labelledby"), "diagHeading");
    assert.match(css, /\.diag-export\s*\{[^}]*white-space:\s*nowrap/);
    assert.match(css, /\.diag-export\s*\{[^}]*min-width:\s*8em/);
    assert.match(css, /\.diag-export\s*\{[^}]*color:\s*#fff/);
    assert.match(css, /\.diag-status\.is-warn\s*\{[^}]*background:\s*none/);
    assert.match(css, /@media \(max-width:\s*519px\)[\s\S]*\.diag-export\s*\{\s*width:\s*100%/);
    assert.match(css, /\.set-split button\s*\{\s*flex:\s*1 1 50%/);
    assert.match(css, /\.diag-export:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-focus\)/);
    const block = css.match(/body\.oi-settings\s*\{[^}]+\}/)[0];
    const tokens = Object.fromEntries([...block.matchAll(/--(oi-[\w-]+):\s*([^;]+);/g)].map((hit) => [hit[1], hit[2].trim()]));
    assert.ok(contrast("#ffffff", tokens["oi-accent"]) >= 4.5);
    assert.ok(contrast(tokens["oi-warn"], tokens["oi-panel"]) >= 4.5);

    const downloads = [];
    const origCreate = document.createElement.bind(document);
    document.createElement = (tag, options) => {
      const el = origCreate(tag, options);
      if (String(tag).toLowerCase() === "a") {
        const click = el.click.bind(el);
        el.click = () => {
          downloads.push({ download: el.download, href: String(el.href || "") });
          return click();
        };
      }
      return el;
    };
    const exportBtn = document.getElementById("diagExport");
    const before = hits.length;
    exportBtn.click();
    await flush();
    assert.equal(exportBtn.textContent, "导出诊断包");
    assert.match(document.getElementById("diagStatusText").textContent, /^✓ 已导出 open-immerse-diagnostics-0\.3\.0-\d{8}-\d{6}\.json$/);
    const exportedName = document.getElementById("diagStatusText").textContent.slice("✓ 已导出 ".length);
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0].download, exportedName);
    assert.match(exportedName, /^open-immerse-diagnostics-0\.3\.0-\d{8}-\d{6}\.json$/);
    assert.ok(downloads[0].href.includes("blob:oi-diag"));
    assert.equal(document._focused?.id, "diagExport");
    assert.equal(document.querySelector("[data-diag-retry]"), null);
    assert.equal(document.getElementById("diagStatus").classList.contains("is-warn"), false);
    assert.equal(blobs.length, 1);
    assert.ok(blobs[0].size > 0);
    const emptyPack = JSON.parse(await blobs[0].text());
    assert.equal(emptyPack.format, 1);
    assert.deepEqual(emptyPack.events, []);
    assert.equal(emptyPack.extVersion, "0.3.0");
    assert.equal(hits.length, before);

    await globalThis.chrome.runtime.sendMessage({
      type: "OI_DIAG_LOG",
      event: { type: "mm.error", code: "401", t: Date.now() }
    });
    let releasePack;
    const holdPack = new Promise((resolve) => {
      releasePack = resolve;
    });
    const origSend = globalThis.chrome.runtime.sendMessage.bind(globalThis.chrome.runtime);
    globalThis.chrome.runtime.sendMessage = async (message) => {
      if (message?.type === "OI_DIAG_EXPORT") await holdPack;
      return origSend(message);
    };
    exportBtn.click();
    await flush();
    assert.equal(exportBtn.textContent, "正在打包…");
    assert.equal(exportBtn.disabled, true);
    assert.equal(document.getElementById("diagClear").disabled, true);
    releasePack();
    await flush();
    assert.equal(exportBtn.textContent, "导出诊断包");
    assert.equal(exportBtn.disabled, false);
    const savedPack = JSON.parse(await blobs.at(-1).text());
    assert.equal(savedPack.events.length, 1);
    assert.equal(savedPack.events[0].code, "401");
    assert.match(document.getElementById("diagStatusText").textContent, /^✓ 已导出 open-immerse-diagnostics-0\.3\.0-\d{8}-\d{6}\.json$/);
    assert.equal(downloads.at(-1).download, document.getElementById("diagStatusText").textContent.slice("✓ 已导出 ".length));
    assert.ok(blobs.at(-1).size > 0);
    assert.equal(document.getElementById("diagStatus").classList.contains("is-warn"), false);
    assert.equal(document.getElementById("diagStatus").classList.contains("set-done"), true);
    assert.equal(document._focused?.id, "diagExport");

    globalThis.URL.createObjectURL = () => "";
    exportBtn.click();
    await flush();
    assert.equal(document.getElementById("diagStatusText").textContent, "没能导出：文件没保存下来，检查一下下载设置或磁盘空间。");
    assert.equal(document.getElementById("diagStatus").classList.contains("is-warn"), true);
    const retry = document.querySelector("[data-diag-retry]");
    assert.equal(retry.textContent, "再试一次");
    assert.equal(retry.classList.contains("diag-warn"), false);
    assert.equal(retry.classList.contains("diag-retry"), true);
    assert.equal(document._focused?.id, "diagExport");
    assert.match(css, /\.diag-retry\s*\{\s*margin-left:\s*8px/);
    assert.match(css, /\.diag-retry:hover\s*\{\s*text-decoration:\s*underline/);
    assert.match(css, /@media \(max-width:\s*519px\)[\s\S]*\.diag-confirm-label\s*\{\s*font-size:\s*13px/);
    assert.equal(diag.tagName, "DIV");
    assert.equal(diag.getAttribute("role"), "group");
    assert.equal(diag.getAttribute("aria-labelledby"), "diagHeading");

    const blobsBeforeAbort = blobs.length;
    const downloadsBeforeAbort = downloads.length;
    globalThis.URL.createObjectURL = () => {
      const error = new Error("cancel");
      error.name = "AbortError";
      throw error;
    };
    retry.click();
    await flush();
    assert.equal(document.getElementById("diagStatusText").textContent, "没能导出：文件没保存下来，检查一下下载设置或磁盘空间。");
    assert.equal(document.getElementById("diagStatus").classList.contains("is-warn"), true);
    assert.equal(document.querySelector("[data-diag-retry]").textContent, "再试一次");
    assert.equal(document._focused?.id, "diagExport");
    assert.equal(blobs.length, blobsBeforeAbort);
    assert.equal(downloads.length, downloadsBeforeAbort);

    const origGet = globalThis.chrome.storage.local.get.bind(globalThis.chrome.storage.local);
    globalThis.chrome.storage.local.get = async () => { throw new Error("unread"); };
    globalThis.URL.createObjectURL = (blob) => {
      blobs.push(blob);
      return "blob:oi-diag";
    };
    exportBtn.click();
    await flush();
    assert.equal(document.getElementById("diagStatusText").textContent, "暂时读不了日志，导出的包只含版本和环境信息。");
    assert.equal(document.getElementById("diagStatus").classList.contains("is-warn"), true);
    assert.equal(document.querySelector("[data-diag-retry]"), null);
    const unread = JSON.parse(await blobs.at(-1).text());
    assert.equal(unread.extVersion, "0.3.0");
    assert.deepEqual(unread.events, []);
    globalThis.chrome.storage.local.get = origGet;

    globalThis.chrome.runtime.sendMessage = async (message) => {
      if (message?.type === "OI_DIAG_EXPORT") return { ok: false, code: "serialize-failed" };
      return origSend(message);
    };
    exportBtn.click();
    await flush();
    assert.equal(document.getElementById("diagStatusText").textContent, "没能导出：打包时出错。");
    assert.equal(document.querySelector("[data-diag-retry]").textContent, "再试一次");
    const idleOrder = ["diagExport", "diagClear"];
    assert.deepEqual(
      [...diag.querySelectorAll("button")].map((button) => button.id).filter((id) => idleOrder.includes(id)),
      idleOrder
    );

    document.getElementById("diagClear").click();
    assert.equal(document.querySelector(".diag-confirm-label").textContent, "确定清空？");
    assert.equal(document.getElementById("diagClearConfirm").textContent, "清空");
    assert.equal(document.getElementById("diagClearCancel").textContent, "取消");
    const confirming = [...diag.querySelectorAll("button")].map((button) => button.id).filter(Boolean);
    assert.deepEqual(confirming, ["diagExport", "diagClearConfirm", "diagClearCancel"]);
    const escape = new page.window.Event("keydown", { bubbles: true });
    Object.defineProperty(escape, "key", { value: "Escape" });
    document.dispatchEvent(escape);
    assert.equal(document.getElementById("diagClear").textContent, "清空");
    assert.equal(document.getElementById("diagClearConfirm"), null);
    assert.equal(document._focused?.id, "diagClear");

    document.getElementById("diagClear").click();
    document.getElementById("diagClearCancel").click();
    assert.equal(document.getElementById("diagClear").textContent, "清空");
    assert.equal(document._focused?.id, "diagClear");

    document.getElementById("diagClear").click();
    mock.timers.tick(4999);
    assert.equal(document.getElementById("diagClearConfirm").textContent, "清空");
    mock.timers.tick(1);
    assert.equal(document.getElementById("diagClear").textContent, "清空");
    assert.equal(document._focused?.id, "diagClear");

    document.getElementById("diagClear").click();
    document.getElementById("diagClearConfirm").click();
    await flush();
    assert.equal(document.getElementById("diagStatusText").textContent, "已清空");
    assert.equal(document.getElementById("diagStatus").classList.contains("set-done"), true);
    assert.equal(document.getElementById("diagStatus").classList.contains("is-warn"), false);
    assert.equal(document._focused?.id, "diagClear");
    const events = chrome.local[ "diag.events" ];
    assert.deepEqual(events, []);
  } finally {
    globalThis.fetch = previousFetch;
    globalThis.URL.createObjectURL = previousCreate;
    mock.timers.reset();
  }
});
