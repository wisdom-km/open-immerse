/**
 * Runtime borrow of 「多模态 · OCR」 for translation.
 * Nothing here writes storage. The API key stays on the request object only.
 *
 * v1 copy that may still change lives in TRANSLATE_BORROW_COPY:
 * the hint link, and whether the popup engine line includes the model.
 */

import {
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

export const TRANSLATE_BORROW_COPY = Object.freeze({
  /** Hint link. Focuses #provider on this page. */
  setupLink: "单独设置",
  fallbackLink: "设置引擎",
  hintBorrowPrefix: "未单独配置，正在借用「多模态 · OCR」的",
  hintBorrowSuffix: "翻译",
  hintFallback: "未配置翻译服务，正在使用免费的 MyMemory",
  popupEnginePrefix: "引擎：",
  popupBorrowSuffix: "（借用）",
  popupTitlePrefix: "借用「多模态 · OCR」：",
  /** Popup engine row includes the model. Set false to drop it. */
  popupShowsModel: true,
  modelMax: 16,
  modelHead: 12,
  ellipsis: "…"
});

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

export function truncateBorrowModel(model) {
  const text = String(model || "");
  if (text.length <= TRANSLATE_BORROW_COPY.modelMax) return text;
  return `${text.slice(0, TRANSLATE_BORROW_COPY.modelHead)}${TRANSLATE_BORROW_COPY.ellipsis}`;
}

export function formatBorrowedEngine(description) {
  const copy = TRANSLATE_BORROW_COPY;
  const model = copy.popupShowsModel ? truncateBorrowModel(description?.model) : "";
  const main = model
    ? `${copy.popupEnginePrefix}${description.shortName} · ${model}`
    : `${copy.popupEnginePrefix}${description.shortName}`;
  return {
    main,
    suffix: copy.popupBorrowSuffix,
    text: `${main}${copy.popupBorrowSuffix}`,
    title: `${copy.popupTitlePrefix}${description.vendorLabel} · ${description.model}`
  };
}

/** Display state. Never includes the API key. */
export function describeTranslateBorrow(settings, formula) {
  const own = resolveOutboundProvider(settings || {});
  if (!own.fallback) return { mode: "own", borrowed: false, outbound: own };
  const card = readCard(formula);
  if (!card) return { mode: "fallback", borrowed: false, outbound: own };
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
 * Own configured engine wins, including an explicit MyMemory choice.
 * Borrowed calls use runtimeConfig and must not be written back.
 */
export function resolveTranslateOutbound(settings = {}, formula) {
  const own = resolveOutboundProvider(settings || {});
  if (!own.fallback) {
    return { ...own, borrowed: false, mode: "own", adapterId: own.providerId };
  }
  const card = readCard(formula);
  if (!card) return { ...own, borrowed: false, mode: "fallback", adapterId: own.providerId };
  return {
    providerId: `mm:${card.vendorId}`,
    provider: getProvider(card.adapterId),
    adapterId: card.adapterId,
    fallback: false,
    notice: "",
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

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** B/C hint. A leaves the node empty and hidden. */
export function paintBorrowHint(hintNode, engineHintNode, description) {
  if (!hintNode) return;
  const own = !description || description.mode === "own";
  if (engineHintNode) engineHintNode.hidden = !own;
  hintNode.hidden = own;
  clearNode(hintNode);
  if (own) return;
  const doc = hintNode.ownerDocument;
  const copy = TRANSLATE_BORROW_COPY;
  if (description.mode === "borrow") {
    const main = el(doc, "span", "set-borrow-main");
    main.append(
      el(doc, "span", "set-borrow-lead", `${copy.hintBorrowPrefix} `),
      (() => {
        const who = el(doc, "span", "set-borrow-who");
        const vendor = el(doc, "span", "set-borrow-vendor", description.shortName);
        if (description.vendorLabel && description.vendorLabel !== description.shortName) {
          vendor.title = description.vendorLabel;
        }
        const model = el(doc, "span", "set-borrow-model", description.model);
        model.title = description.model;
        who.append(vendor, el(doc, "span", "set-borrow-dot", " · "), model);
        return who;
      })(),
      el(doc, "span", "set-borrow-tail", ` ${copy.hintBorrowSuffix} · `)
    );
    const link = el(doc, "button", "set-inline", copy.setupLink);
    link.type = "button";
    link.dataset.borrowFocus = "provider";
    hintNode.append(main, link);
    return;
  }
  const main = el(doc, "span", "set-borrow-main");
  main.append(el(doc, "span", "set-borrow-lead", `${copy.hintFallback} · `));
  const link = el(doc, "button", "set-inline", copy.fallbackLink);
  link.type = "button";
  link.dataset.borrowFocus = "provider";
  hintNode.append(main, link);
}

export function focusBorrowTarget(doc) {
  const select = doc?.getElementById?.("provider");
  select?.focus?.();
  return select || null;
}
