import { DEFAULT_FEATURES } from "./features.js";

export const SETTINGS_VERSION = 7;

export const DEFAULT_SETTINGS = {
  provider: "mymemory",
  sourceLang: "auto",
  targetLang: "zh-CN",
  enabled: false,
  autoOnNewPages: false,
  hoverEnabled: false,
  showFab: true,
  fabCorner: "bottom-right",
  fabPos: null,
  subtitleEnabled: false,
  settingsVersion: SETTINGS_VERSION,
  features: { ...DEFAULT_FEATURES },
  batchSize: 8,
  translateLimit: "title_lead",
  concurrency: 3,
  translationStyle: "under",
  translateScope: "article",
  twoStepPolish: false, // Advanced「先信后润」; default off; missing → false
  fontScale: 0.95,
  color: "",
  skipCode: true,
  siteRules: [],
  providers: {
    mymemory: { email: "" },
    microsoft: { apiKey: "", region: "eastasia", endpoint: "https://api.cognitive.microsofttranslator.com" },
    deepl: { apiKey: "", plan: "free" },
    google: { apiKey: "" },
    openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", prompt: "" },
    kimi: { apiKey: "", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.5", endpoint: "cn", prompt: "" },
    minimax: { apiKey: "", baseUrl: "https://api.minimax.cn/v1", model: "MiniMax-M2.5", endpoint: "cn", prompt: "" },
    grok: { apiKey: "", baseUrl: "https://api.x.ai/v1", model: "grok-4-fast", prompt: "" },
    openrouter: {
      apiKey: "",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "openrouter/free",
      referer: "https://github.com/wisdom-km/open-immerse",
      appTitle: "Open Immerse",
      prompt: ""
    },
    gemini: { apiKey: "", model: "gemini-2.0-flash", prompt: "" },
    claude: { apiKey: "", model: "claude-3-5-haiku-latest", prompt: "" },
    azure: { endpoint: "", apiKey: "", deployment: "", apiVersion: "2024-10-21", prompt: "" },
    custom: {
      url: "",
      method: "POST",
      headersJson: "{}",
      bodyTemplate: '{"text":{{textsJson}},"source":"{{sourceLang}}","target":"{{targetLang}}"}',
      responsePath: ""
    }
  }
};

export function migrateSettings(merged, stored = {}) {
  const next = { ...merged };
  let changed = false;
  const version = stored.settingsVersion || 0;
  const legacyPage = stored.translateScope === "page" && stored.articleScopeMigrated !== true;
  if (version < SETTINGS_VERSION || legacyPage) {
    next.settingsVersion = SETTINGS_VERSION;
    if (version < 7) next.translateLimit = "title_lead";
    next.translateScope = "article";
    next.articleScopeMigrated = true;
    next.features = { ...DEFAULT_FEATURES, ...(stored.features || {}) };
    if (stored.subtitleEnabled !== true) {
      next.features.youtube = next.features.youtube === true;
      next.features.x = next.features.x === true;
      next.subtitleEnabled = false;
    }
    changed = true;
  }
  if (
    next.translateLimit === "preview" ||
    next.translateLimit === 2 ||
    next.translateLimit === "2" ||
    next.translateLimit === "lead"
  ) {
    next.translateLimit = "title_lead";
    changed = true;
  }
  return { settings: next, changed };
}

export async function getSettings() {
  let stored = {};
  try {
    const bag = await chrome.storage.sync.get("settings");
    stored = bag?.settings && typeof bag.settings === "object" ? bag.settings : {};
  } catch (err) {
    console.error("Open Immerse: storage.sync.get failed", err);
  }
  const merged = merge(DEFAULT_SETTINGS, stored);
  let settings = merged;
  let changed = false;
  try {
    const migrated = migrateSettings(merged, stored);
    settings = migrated.settings;
    changed = migrated.changed;
  } catch (err) {
    console.error("Open Immerse: settings migration failed", err);
    settings = { ...DEFAULT_SETTINGS, translateScope: "article", settingsVersion: SETTINGS_VERSION };
  }
  if (changed) {
    try {
      await chrome.storage.sync.set({ settings });
    } catch (err) {
      console.error("Open Immerse: settings migration writeback failed", err);
    }
  }
  return settings;
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = merge(current, patch);
  try {
    await chrome.storage.sync.set({ settings: next });
  } catch (err) {
    console.error("Open Immerse: storage.sync.set failed", err);
  }
  return next;
}

export function matchSiteRule(hostname, rules = []) {
  const host = String(hostname || "").replace(/^www\./, "");
  return (
    rules.find((rule) => {
      const target = String(rule.host || "").replace(/^www\./, "").trim();
      if (!target) return false;
      return host === target || host.endsWith("." + target);
    }) || null
  );
}

function merge(base, patch) {
  const out = { ...base, ...patch };
  if (base.providers || patch.providers) {
    out.providers = { ...base.providers };
    const incoming = patch.providers || {};
    for (const [id, cfg] of Object.entries(incoming)) {
      out.providers[id] = { ...(base.providers?.[id] || {}), ...cfg };
    }
  }
  out.features = { ...DEFAULT_FEATURES, ...(base.features || {}), ...(patch.features || {}) };
  if (patch.siteRules) out.siteRules = patch.siteRules;
  return out;
}
