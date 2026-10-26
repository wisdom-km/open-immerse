/**
 * Ask-AI model choice. There is no Ask settings page.
 * A configured multimodal card wins. A failed multimodal call does not
 * fall through to the translation model.
 */

import { getProvider, providers } from "./providers.js";
import {
  ARK_PLAN_BASE_URL,
  multimodalProvider,
  multimodalReady,
  normalizeFormulaSettings
} from "./formula-settings.js";

const COMPAT_BASE = {
  openai: "https://api.openai.com/v1",
  kimi: "https://api.moonshot.cn/v1",
  minimax: "https://api.minimax.cn/v1",
  grok: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  doubao: ARK_PLAN_BASE_URL
};

export const ASK_EMPTY = "未配置模型";
export const ASK_SETTINGS_HASH = "#mm";
export const ASK_ALSO_LINE = "问 AI 也用这个模型；没配时用翻译的文字模型。";
export const ASK_TRANSLATION_LINE = "没配多模态模型时，问 AI 也用这个模型。";
export const ASK_PRIVACY = "会把单个公式或图的裁图发给你选的服务；问 AI 时还会发送你的问题和引用的段落。按该服务的价格计费，不上传整页 PDF。密钥只存在本机（chrome.storage.local），不随浏览器同步。";

function trimBase(value, fallback) {
  const text = String(value || fallback || "").trim().replace(/\/$/, "");
  return text;
}

function compatTarget(providerId, cfg, via) {
  const base = trimBase(cfg.baseUrl, COMPAT_BASE[providerId]);
  return {
    ok: true,
    via,
    provider: providerId,
    model: String(cfg.model || ""),
    url: base ? `${base}/chat/completions` : "",
    host: hostOf(base)
  };
}

function hostOf(base) {
  try {
    return base ? new URL(base).host : "";
  } catch {
    return "";
  }
}

function translationTarget(settings) {
  const id = String(settings?.provider || "").trim();
  if (!providers[id]) {
    return { ok: false, via: "none", message: ASK_EMPTY, href: `options/options.html${ASK_SETTINGS_HASH}` };
  }
  const provider = getProvider(id);
  if (!provider || provider.kind !== "llm") {
    return { ok: false, via: "none", message: ASK_EMPTY, href: `options/options.html${ASK_SETTINGS_HASH}` };
  }
  const cfg = settings?.providers?.[provider.id] || {};
  if (provider.id === "gemini") {
    const model = String(cfg.model || "gemini-2.0-flash");
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    return { ok: true, via: "translation", provider: "gemini", model, url, host: "generativelanguage.googleapis.com" };
  }
  if (provider.id === "claude") {
    return {
      ok: true,
      via: "translation",
      provider: "claude",
      model: String(cfg.model || "claude-3-5-haiku-latest"),
      url: "https://api.anthropic.com/v1/messages",
      host: "api.anthropic.com"
    };
  }
  if (provider.id === "azure") {
    const endpoint = trimBase(cfg.endpoint, "");
    const deployment = String(cfg.deployment || "");
    const version = String(cfg.apiVersion || "2024-10-21");
    const url = endpoint
      ? `${endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(version)}`
      : "";
    return {
      ok: true,
      via: "translation",
      provider: "azure",
      model: deployment,
      url,
      host: endpoint ? new URL(endpoint).host : ""
    };
  }
  return compatTarget(provider.id, cfg, "translation");
}

export function resolveAskTarget(settings, formulaSettings) {
  const stored = normalizeFormulaSettings(formulaSettings);
  if (multimodalReady(stored)) {
    const spec = multimodalProvider(stored.multimodal.provider);
    const cfg = {
      baseUrl: stored.multimodal.baseUrl,
      model: stored.multimodal.model
    };
    if (spec?.id === "gemini") {
      const model = cfg.model || "gemini-2.0-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      return { ok: true, via: "multimodal", provider: "gemini", model, url, host: "generativelanguage.googleapis.com" };
    }
  return compatTarget(spec.id, cfg, "multimodal");
}
  return translationTarget(settings || {});
}

/**
 * Send one ask request. Multimodal failure stays on that error.
 * `send` is injected so tests never touch the network.
 */
export async function deliverAsk(target, send) {
  if (!target?.ok) {
    return {
      ok: false,
      fallback: false,
      message: target?.message || ASK_EMPTY,
      href: target?.href || `options/options.html${ASK_SETTINGS_HASH}`
    };
  }
  try {
    const res = await send({
      url: target.url,
      host: target.host,
      model: target.model,
      provider: target.provider,
      via: target.via
    });
    if (!res || res.ok === false) {
      if (target.via === "multimodal") {
        return {
          ok: false,
          fallback: false,
          message: "多模态调用失败",
          href: `options/options.html${ASK_SETTINGS_HASH}`
        };
      }
      return { ok: false, fallback: false, message: String(res?.error || "调用失败") };
    }
    return { ok: true, via: target.via, provider: target.provider, model: target.model, body: res.body };
  } catch (err) {
    if (target.via === "multimodal") {
      return {
        ok: false,
        fallback: false,
        message: "多模态调用失败",
        href: `options/options.html${ASK_SETTINGS_HASH}`
      };
    }
    return { ok: false, fallback: false, message: String(err?.message || err) };
  }
}

export function renderAskNotice(host, target) {
  host.replaceChildren();
  if (target?.ok) return host;
  const title = document.createElement("p");
  title.textContent = ASK_EMPTY;
  const link = document.createElement("a");
  link.href = target?.href || `options/options.html${ASK_SETTINGS_HASH}`;
  link.textContent = "去设置";
  host.append(title, link);
  return host;
}
