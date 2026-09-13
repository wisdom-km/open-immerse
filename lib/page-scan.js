import {
  ARTICLE_CHROME_SELECTOR,
  HARD_SKIP_SELECTOR,
  PAGE_TOP_NAV_SELECTOR,
  PRIMARY_TITLE_SKIP_ANCESTOR,
  classLooksChrome,
  isAlwaysBanned,
  isChromeMetaText,
  isInMetaRail,
  pickPreset
} from "./site-presets.js";

export const BLOCK_SELECTOR = "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd";
export const MAIN_SELECTOR = "main, article, [role='main'], [role='article']";
export const SKIP_SELECTOR =
  "script, style, noscript, textarea, pre, code, kbd, samp, svg, canvas, [contenteditable], .oi-translation, .oi-toast, .oi-selection-card, .oi-fab";
export const MIN_LEN = 2;

export function collectNodes(root, settings = {}, ctx = {}) {
  const body = root?.body || root;
  if (!body?.querySelectorAll) return [];
  const scope = settings.translateScope || "article";
  const hostname = ctx.hostname || "";
  const innerWidth = ctx.innerWidth || 800;
  const nodes = [...body.querySelectorAll(BLOCK_SELECTOR)].filter((el) =>
    shouldCollectNode(el, settings, { hostname, innerWidth, scope, root: body })
  );
  return nodes.sort((a, b) => {
    const diff = contentRank(a, { root: body }) - contentRank(b, { root: body });
    if (diff) return diff;
    const pos = a.compareDocumentPosition?.(b) || 0;
    if (pos & 4) return -1;
    if (pos & 2) return 1;
    return 0;
  });
}

export function isPrimaryTitleCandidate(el) {
  if (!el || String(el.tagName || "").toUpperCase() !== "H1") return false;
  return !el.closest?.(PRIMARY_TITLE_SKIP_ANCESTOR);
}

export function isPrimaryTitle(el, ctx = {}) {
  if (!isPrimaryTitleCandidate(el)) return false;
  const root = ctx.document || ctx.root?.body || ctx.root;
  if (root?.querySelectorAll) {
    const all = [...root.querySelectorAll("h1")].filter(isPrimaryTitleCandidate);
    const inMain = all.find((node) => node.closest?.(MAIN_SELECTOR));
    return (inMain || all[0]) === el;
  }
  return true;
}

export function shouldSkipScopedChrome(el, scope = "article", ctx = {}) {
  if (!el) return true;
  if (scope === "page") return Boolean(el.closest?.(PAGE_TOP_NAV_SELECTOR));
  if (isAlwaysBanned(el, ctx.hostname)) return true;
  if (isInMetaRail(el, getText)) return true;
  if (classLooksChrome(el) && !el.closest?.(MAIN_SELECTOR)) return true;
  if (isSideColumn(el, ctx.innerWidth)) return true;
  if (isChromeCluster(el)) return true;
  if (el.closest?.(ARTICLE_CHROME_SELECTOR)) return true;
  return false;
}

export function shouldCollectNode(el, settings = {}, ctx = {}) {
  const scope = ctx.scope || settings.translateScope || "article";
  if (!el) return false;
  if (el.closest?.(SKIP_SELECTOR)) return false;
  if (el.querySelector?.(".oi-translation")) return false;
  if (el.nextElementSibling?.classList?.contains("oi-translation")) return false;
  if (settings.skipCode && el.closest?.("pre, code")) return false;
  const primaryTitle = isPrimaryTitle(el, ctx);
  if (!primaryTitle && shouldSkipScopedChrome(el, scope, ctx)) return false;
  const text = getText(el);
  if (text.length < MIN_LEN) return false;
  if (/^[\d\s.,:;!?()[\]{}\-_/\\]+$/.test(text)) return false;
  if (!primaryTitle && isChromeMetaText(text)) return false;
  if (!isMostlyVisible(el)) return false;
  return true;
}

export function getText(el) {
  if (!el) return "";
  if (typeof el.cloneNode !== "function") return String(el.textContent || "").replace(/\s+/g, " ").trim();
  const clone = el.cloneNode(true);
  clone.querySelectorAll?.(".oi-translation, script, style, noscript").forEach((node) => node.remove());
  return (clone.innerText || clone.textContent || "").replace(/\s+/g, " ").trim();
}

export function shouldInline(el) {
  if (!el) return false;
  if (el.tagName === "A" || el.tagName === "BUTTON") return true;
  if (el.closest?.("nav, aside, header, [role='navigation']")) return true;
  const rect = el.getBoundingClientRect?.();
  return Boolean(rect && rect.width > 0 && rect.width < 240 && isSideColumn(el));
}

export function isSideColumn(el, innerWidth) {
  const rect = el?.getBoundingClientRect?.();
  if (!rect) return false;
  const vw = Math.max(innerWidth || 0, 800);
  if (rect.width < 4) return false;
  if (rect.right < vw * 0.28 && rect.width < vw * 0.38) return true;
  if (rect.left > vw * 0.58 && rect.width < vw * 0.45) return true;
  return false;
}

export function isChromeCluster(el) {
  const cluster = el?.closest?.("li, [class*='details_item'], [class*='details_list']");
  if (!cluster) return false;
  return isChromeMetaText(getText(el)) || isChromeMetaText(getText(cluster));
}

export function contentRank(el, ctx = {}) {
  if (isPrimaryTitle(el, ctx)) return 0;
  if (el?.closest?.(MAIN_SELECTOR) && !el.closest?.("nav, header, aside, footer")) return 0;
  if (isSideColumn(el) || el?.closest?.(ARTICLE_CHROME_SELECTOR) || el?.closest?.(HARD_SKIP_SELECTOR)) return 2;
  return 1;
}

export function isMostlyVisible(el) {
  const rect = el?.getBoundingClientRect?.();
  if (!rect || rect.width < 4 || rect.height < 4) return false;
  if (typeof getComputedStyle !== "function") return true;
  const style = getComputedStyle(el);
  return !(style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0);
}

export function preferAppendInside(el) {
  if (!el) return false;
  if (["LI", "TD", "TH", "DT", "DD"].includes(el.tagName)) return true;
  const parent = el.parentElement;
  if (!parent || typeof getComputedStyle !== "function") return false;
  const display = getComputedStyle(parent).display || "";
  return display.includes("grid") || display.includes("flex");
}

export { pickPreset, HARD_SKIP_SELECTOR };
