/**
 * Ask-AI presentation on top of lib/ask-route.js.
 * Routing stays in resolveAskTarget. This file only names chips,
 * errors, and which storage keys must refresh the chip.
 * A multimodal failure never becomes a translation target here.
 */

import { ASK_EMPTY, ASK_SETTINGS_HASH, resolveAskTarget } from "./ask-route.js";
import { providers } from "./providers.js";

export const ASK_CONTEXT_NEARBY = 2;
export const ASK_WAIT_HINT_MS = 8000;
export const ASK_TIMEOUT_MS = 60000;
export const ASK_CONFIRM_KEY = "ask.confirmSend";
export const ASK_ACTION_ICON_MAX = 279;

export const ASK_SETTINGS_HREF = `options/options.html${ASK_SETTINGS_HASH}`;
export const ASK_TRANSLATE_HREF = "options/options.html#translate";

const TOAST_TO_TRANSLATION = "问 AI 改用翻译模型";
const TOAST_TO_MULTIMODAL = "问 AI 改用多模态模型";

export function askTarget(settings, formulaSettings) {
  return resolveAskTarget(settings, formulaSettings);
}

export function askChipModel(target) {
  if (!target?.ok) return { visible: false, text: "", dot: "off", via: "none" };
  if (target.via === "multimodal") {
    return { visible: true, text: `多模态 · ${target.model}`, dot: "ok", via: "multimodal", host: target.host || "", model: target.model || "" };
  }
  return { visible: true, text: `翻译模型 · ${target.model}`, dot: "ok", via: "translation", host: target.host || "", model: target.model || "" };
}

export function askRouteInputsChanged(changes, area) {
  if (!changes || typeof changes !== "object") return false;
  const name = String(area || "");
  if (name === "local") return Boolean(changes.formulaSettings || changes.oiSecrets || changes[ASK_CONFIRM_KEY]);
  if (name === "sync") return Boolean(changes.settings);
  return Boolean(changes.formulaSettings || changes.settings || changes.oiSecrets);
}

export function askRouteToast(previous, next) {
  const from = previous?.ok ? previous.via : "none";
  const to = next?.ok ? next.via : "none";
  if (from === to) return "";
  if (to === "translation" && from === "multimodal") return TOAST_TO_TRANSLATION;
  if (to === "multimodal" && from !== "multimodal") return TOAST_TO_MULTIMODAL;
  return "";
}

export function askActionsUseIcons(contentWidth) {
  const width = Number(contentWidth);
  return Number.isFinite(width) && width > 0 && width < 280;
}

export function engineBlurb(settings) {
  const id = String(settings?.provider || "");
  const provider = id && providers[id] ? providers[id] : null;
  if (!provider) return { name: "未选择", kindLabel: "机器翻译" };
  if (provider.kind === "custom") return { name: provider.name, kindLabel: "自定义引擎" };
  if (provider.kind === "llm") return { name: provider.name, kindLabel: "大模型" };
  return { name: provider.name, kindLabel: "机器翻译" };
}

export function unconfiguredModel(settings, target) {
  const engine = engineBlurb(settings);
  return {
    title: ASK_EMPTY,
    body: `问 AI 用多模态模型；没配时用翻译的大模型（仅 kind=llm）。现在用的是 ${engine.name}（${engine.kindLabel}），没法回答问题。`,
    settingsHref: target?.href || ASK_SETTINGS_HREF,
    translateHref: ASK_TRANSLATE_HREF
  };
}

/**
 * Panel copy for a failed turn. `fallback` is always false.
 * Multimodal errors keep the 「多模态模型调用失败」 prefix and a settings link.
 */
export function askErrorModel({ via, status, host, timeout = false, offline = false, visionRejected = false } = {}) {
  const code = Number(status) || 0;
  const multimodal = via === "multimodal";
  if (visionRejected) {
    return {
      text: "这个模型不能看图，公式改为文字后重试？",
      retry: false,
      textRetry: true,
      settings: true,
      fallback: false
    };
  }
  let specific = "";
  if (offline) specific = "网络断开";
  else if (timeout) specific = `${host || "服务"} 60 秒没有回应`;
  else if (code === 401 || code === 403) specific = `密钥无效或没有权限（${code}）`;
  else if (code === 429) specific = "请求太频繁或额度用完（429）";
  else specific = code ? `调用失败（${code}）` : "调用失败";

  if (multimodal) {
    const text = specific.startsWith("多模态")
      ? specific
      : `多模态模型调用失败（${code || "错误"}） · ${specific}`;
    return {
      text,
      retry: true,
      textRetry: false,
      settings: true,
      fallback: false
    };
  }
  const settings = code === 401 || code === 403;
  return { text: specific, retry: true, textRetry: false, settings, fallback: false };
}

export function askPreviewLine({ citation, host = "" } = {}) {
  const parts = ["问题"];
  if (citation) parts.push("引用");
  parts.push("附近 2 段");
  const tail = host ? ` → ${host}` : "";
  return `将发送：${parts.join(" · ")}${tail}`;
}
