import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
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

const engineLocks = new Map();

function sharedEngineLocks() {
  return {
    request(name, options, callback) {
      if (typeof options === "function") {
        callback = options;
        options = {};
      }
      const prev = engineLocks.get(name) || Promise.resolve();
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      engineLocks.set(name, prev.then(() => gate, () => gate));
      return prev.then(() => callback({ name, mode: "exclusive" }), () => callback({ name, mode: "exclusive" })).finally(() => release());
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
        return { ok: false };
      }
    },
    storage: {
      sync: area(sync, "sync"),
      local: area(local, "local"),
      onChanged: {
        addListener(fn) {
          listeners.push(fn);
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
  const touched = execFileSync("git", ["log", "--first-parent", "--no-merges", "e4f464d..HEAD", "--", "ui/tokens.css", "pdf", "lib/notes-prefs.js", "lib/reader-notes-local.js"], { encoding: "utf8" });
  assert.equal(touched.trim(), "");
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
    assert.equal(page.document.querySelector("[data-feat='pdf']").checked, true);
    assert.equal(page.document.getElementById("mmPdfBanner").hidden, true);

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
  assert.match(sw, /options\.providerId = settings\.provider/);
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
  for (const name of ["apiKey2", "api2Key", "password2", "token2", "auth2", "clientSecret2", "jwt", "sessionCookie", "pat", "aPiKeY", "encryptionKey", "aws_access_key_id"]) {
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
  const exported = settingsForExport({ apiKey2: "export-api-2", jwt: "export-jwt", accessKey: "keep-access", keyCode: "keep-keycode" });
  assert.equal(JSON.stringify(exported).includes("export-api-2"), false);
  assert.equal(JSON.stringify(exported).includes("export-jwt"), false);
  assert.equal(exported.accessKey, "keep-access");
  assert.equal(exported.keyCode, "keep-keycode");
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

test("missing-field 需处理 badge survives refresh", async () => {
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

  const refreshed = mountPage("#translate");
  await startOptions();
  await flush();
  assert.equal(refreshed.document.getElementById("provider").value, "deepl");
  assert.equal(refreshed.document.querySelector("[data-badge='translate']").hidden, false);
  assert.equal(chrome.local.oiProviderAttention.deepl, true);
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
