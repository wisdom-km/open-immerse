import { DEFAULT_FEATURES } from "./features.js";

export const DEFAULT_SETTINGS = {
  provider: "mymemory",
  sourceLang: "auto",
  targetLang: "zh-CN",
  enabled: false,
  autoOnNewPages: false,
  hoverEnabled: false,
  showFab: true,
  subtitleEnabled: false,
  features: { ...DEFAULT_FEATURES },
  batchSize: 8,
  concurrency: 3,
  translationStyle: "under",
  translateScope: "page",
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

export async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return merge(DEFAULT_SETTINGS, stored.settings || {});
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = merge(current, patch);
  await chrome.storage.sync.set({ settings: next });
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
