/**
 * Runtime borrow of 「多模态 · OCR」 for translation.
 * Nothing here writes storage. The API key stays on the request object only.
 * Borrowing is invisible: no settings hint, no popup suffix, no warning.
 */

import {
  NO_ENGINE,
  getProvider,
  isProviderConfigured,
  providers,
  resolveOutboundProvider
} from "./providers.js";
import {
  fixedVendorHostMismatch,
  httpBaseUrl,
  multimodalProvider,
  normalizeFormulaSettings
} from "./formula-settings.js";

const VENDOR_SHORT = Object.freeze({
  openai: "OpenAI",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  doubao: "豆包",
  kimi: "Kimi",
  grok: "Grok",
  qwen: "千问",
  custom: "自定义"
});

function adapterIdFor(spec) {
  if (!spec) return "";
  if (spec.shape === "gemini" || spec.id === "gemini") return "gemini";
  if (spec.id === "openai" || spec.id === "kimi" || spec.id === "grok") return spec.id;
  if (spec.shape === "openai") return "openai";
  return "";
}

function readCard(formula) {
  const stored = normalizeFormulaSettings(formula);
  const mm = stored.multimodal;
  const spec = multimodalProvider(mm.provider);
  if (!spec) return null;
  const apiKey = String(mm.apiKey || "").trim();
  const model = String(mm.model || "").trim();
  if (!apiKey || !model) return null;
  if (fixedVendorHostMismatch(stored)) return null;
  const storedBase = String(mm.baseUrl || "").trim();
  if (spec.baseUrlRequired && !httpBaseUrl(storedBase)) return null;
  const baseUrl = storedBase || String(spec.baseUrl || "").trim();
  if (!baseUrl) return null;
  if (spec.id === "custom" && !httpBaseUrl(baseUrl)) return null;
  const adapterId = adapterIdFor(spec);
  if (!adapterId || !providers[adapterId]) return null;
  return {
    vendorId: spec.id,
    vendorLabel: spec.label,
    shortName: VENDOR_SHORT[spec.id] || spec.label,
    model,
    baseUrl,
    adapterId,
    apiKey
  };
}

function ownReady(own) {
  return Boolean(own?.provider) && own.code !== NO_ENGINE;
}

/** Display state. Never includes the API key. */
export function describeTranslateBorrow(settings, formula) {
  const own = resolveOutboundProvider(settings || {});
  if (ownReady(own)) return { mode: "own", borrowed: false, outbound: own };
  const card = readCard(formula);
  if (!card) return { mode: "none", borrowed: false, outbound: own };
  return {
    mode: "borrow",
    borrowed: true,
    vendorId: card.vendorId,
    vendorLabel: card.vendorLabel,
    shortName: card.shortName,
    model: card.model,
    baseUrl: card.baseUrl
  };
}

/**
 * Translation outbound with borrow in front of resolveOutboundProvider.
 * A selected engine wins, including MyMemory. An empty provider borrows
 * when a multimodal card is ready. Borrowed calls use runtimeConfig only.
 */
export function resolveTranslateOutbound(settings = {}, formula) {
  const own = resolveOutboundProvider(settings);
  if (ownReady(own)) {
    return { ...own, borrowed: false, mode: "own", adapterId: own.providerId };
  }
  const card = readCard(formula);
  if (!card) return { ...own, borrowed: false, mode: "none", adapterId: "", code: NO_ENGINE };
  return {
    providerId: `mm:${card.vendorId}`,
    provider: getProvider(card.adapterId),
    adapterId: card.adapterId,
    fallback: false,
    notice: "",
    code: "",
    borrowed: true,
    mode: "borrow",
    vendorId: card.vendorId,
    vendorLabel: card.vendorLabel,
    shortName: card.shortName,
    model: card.model,
    baseUrl: card.baseUrl,
    runtimeConfig: {
      apiKey: card.apiKey,
      model: card.model,
      baseUrl: card.baseUrl
    }
  };
}

export function ownTranslateConfigured(settings) {
  const requested = String(settings?.provider || "").trim();
  if (!requested || !providers[requested]) return false;
  const selected = getProvider(requested);
  const cfg = settings?.providers?.[requested] || {};
  return isProviderConfigured(selected, cfg);
}
