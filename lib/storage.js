export const DEFAULT_SETTINGS = {
  provider: "mymemory",
  sourceLang: "auto",
  targetLang: "zh-CN",
  enabled: false,
  hoverEnabled: false,
  batchSize: 8,
  concurrency: 3,
  translationStyle: "under",
  fontScale: 0.95,
  color: "",
  skipCode: true,
  providers: {
    mymemory: { email: "" },
    microsoft: { apiKey: "", region: "eastasia", endpoint: "https://api.cognitive.microsofttranslator.com" },
    deepl: { apiKey: "", plan: "free" },
    google: { apiKey: "" },
    openai: {
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini",
      prompt: ""
    },
    gemini: { apiKey: "", model: "gemini-2.0-flash", prompt: "" },
    claude: { apiKey: "", model: "claude-3-5-haiku-latest", prompt: "" },
    azure: { endpoint: "", apiKey: "", deployment: "", apiVersion: "2024-10-21", prompt: "" },
    baidu: { appid: "", secret: "" },
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

function merge(base, patch) {
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
