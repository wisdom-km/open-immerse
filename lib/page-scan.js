import {
  ARTICLE_CHROME_SELECTOR,
  HARD_SKIP_SELECTOR,
  PAGE_CHROME_SELECTOR,
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
    const diff = contentRank(a, { root: body, scope }) - contentRank(b, { root: body, scope });
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

export function looksLikeArticleTitle(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (value.length < 16) return false;
  const words = value.split(" ").filter(Boolean);
  return value.length >= 24 || words.length >= 4;
}

export function isTinyChrome(el) {
  if (!el) return false;
  const text = getText(el);
  if (["NAV", "FOOTER", "HEADER"].includes(el.parentElement?.tagName)) return text.length < 24;
  if (el.tagName === "A" || el.closest?.("nav, aside, [role='navigation']")) {
    if (looksLikeArticleTitle(text)) return false;
    return text.length < 48;
  }
  return false;
}

export function isPureNavBar(el, ctx = {}) {
  const nav = el?.closest?.("nav, [role='navigation']");
  if (!nav) return false;
  if (inSideRail(el, ctx) || inSideRail(nav, ctx)) return false;
  return true;
}

export const SIDE_RAIL_SELECTOR =
  "aside, [role='complementary'], [data-docs-sidebar], [data-left-nav], [data-left-nav-container], [data-content-page-toc-rail], [data-docs-toc-rail]";
export const SIDE_RAIL_LABEL_SELECTOR =
  ":scope > a, :scope > button, :scope > [role='link'], :scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > p";
export const SIDE_RAIL_TITLE_SELECTOR =
  "[class*='title-container'], [class*='nav-title'], [class*='nav-link-text'], [class*='label-container'], [class*='sidebar-label']";

/** aside / complementary / known rail attrs / geometric left-right rail. */
export function inSideRail(el, ctx = {}) {
  if (!el) return false;
  if (el.closest?.(SIDE_RAIL_SELECTOR)) return true;
  if (isSideColumn(el, ctx.innerWidth)) return true;
  let node = el.parentElement;
  for (let i = 0; i < 6 && node; i++) {
    const tag = String(node.tagName || "").toUpperCase();
    if (["MAIN", "BODY", "HTML"].includes(tag)) break;
    if (node.closest?.(SIDE_RAIL_SELECTOR)) return true;
    if (isSideColumn(node, ctx.innerWidth)) return true;
    node = node.parentElement;
  }
  return false;
}

/** Prefer the label/link cell so grid chevron columns do not shrink the translation. */
export function looksLikeSideRailTitleHost(el) {
  const cls = typeof el?.className === "string" ? el.className : String(el?.className?.baseVal || "");
  return /title-container|nav-title|nav-link-text|label-container|sidebar-label/i.test(cls);
}

export function pickSideRailMountHost(el) {
  if (!el) return el;
  if (looksLikeSideRailTitleHost(el)) return el;
  const named = el.querySelector?.(SIDE_RAIL_TITLE_SELECTOR) || el.closest?.(SIDE_RAIL_TITLE_SELECTOR);
  if (named && !named.classList?.contains("oi-translation")) return named;
  const tag = String(el.tagName || "").toUpperCase();
  if (["LI", "DT", "DD"].includes(tag)) {
    const label = el.querySelector?.(SIDE_RAIL_LABEL_SELECTOR);
    if (label && !label.classList?.contains("oi-translation")) return label;
  }
  return el;
}

export function pickPrimaryTitle(list, ctx = {}) {
  const all = (list || []).filter(isPrimaryTitleCandidate);
  const inMain = all.find((node) => node.closest?.(MAIN_SELECTOR));
  if (inMain) return inMain;
  const substantial = all.filter((node) => looksLikeArticleTitle(getText(node)));
  if (!substantial.length) return null;
  const docTitle = String(ctx.documentTitle || ctx.document?.title || "").toLowerCase();
  const named = substantial.find((node) => {
    const slice = getText(node).toLowerCase().slice(0, 40);
    return docTitle && slice && docTitle.includes(slice);
  });
  if (named) return named;
  return substantial.slice().sort((a, b) => {
    const ra = a.getBoundingClientRect?.() || { width: 0, height: 0 };
    const rb = b.getBoundingClientRect?.() || { width: 0, height: 0 };
    return rb.width * rb.height - ra.width * ra.height;
  })[0];
}

export function isPrimaryTitle(el, ctx = {}) {
  const scope = ctx.scope || "article";
  if (!isPrimaryTitleCandidate(el)) return false;
  if (scope !== "page") return Boolean(el.closest?.(MAIN_SELECTOR));
  const root = ctx.document || ctx.root?.body || ctx.root;
  if (root?.querySelectorAll) {
    return pickPrimaryTitle([...root.querySelectorAll("h1")], ctx) === el;
  }
  return pickPrimaryTitle([el], ctx) === el;
}

export function shouldSkipScopedChrome(el, scope = "article", ctx = {}) {
  if (!el) return true;
  if (scope === "page") {
    if (el.closest?.(PAGE_CHROME_SELECTOR)) return true;
    if (isPureNavBar(el, ctx) && !inSideRail(el, ctx)) return true;
    if (inSideRail(el, ctx)) return false;
    if (isTinyChrome(el)) return true;
    return false;
  }
  if (isAlwaysBanned(el, ctx.hostname)) return true;
  if (isInMetaRail(el, getText)) return true;
  if (classLooksChrome(el) && !el.closest?.(MAIN_SELECTOR)) return true;
  if (isSideColumn(el, ctx.innerWidth)) return true;
  if (isChromeCluster(el)) return true;
  if (el.closest?.(ARTICLE_CHROME_SELECTOR)) return true;
  if (isTinyChrome(el)) return true;
  return false;
}

export function shouldCollectNode(el, settings = {}, ctx = {}) {
  const scope = ctx.scope || settings.translateScope || "article";
  if (!el) return false;
  if (el.closest?.(SKIP_SELECTOR)) return false;
  if (glossForSource(el)) return false;
  if (hasNestedCollectible(el)) return false;
  if (settings.skipCode && el.closest?.("pre, code")) return false;
  const primaryTitle = isPrimaryTitle(el, { ...ctx, scope });
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

export function hasNestedCollectible(el) {
  return Boolean(el?.querySelector?.(BLOCK_SELECTOR));
}

export function shouldInline(el, ctx = {}) {
  if (!el) return false;
  if (inSideRail(el, ctx)) return false;
  if (el.tagName === "A" || el.tagName === "BUTTON") return true;
  if (el.closest?.("nav, header, [role='navigation']")) return true;
  return false;
}

/**
 * Side-rail KEEP mounts always force block stack (source above, translation below).
 * `{ mode: "block" }` overrides nav/aside inline heuristics.
 */
export function planTranslationMount(el, ctx = {}, opts = {}) {
  const forceBlock = opts.mode === "block" || Boolean(el && inSideRail(el, ctx));
  const inline = !forceBlock && shouldInline(el, ctx);
  const heading = /^H[1-3]$/.test(String(el?.tagName || "").toUpperCase());
  let className = "oi-translation";
  if (inline) className = "oi-translation oi-inline";
  else if (heading) className = "oi-translation oi-after-heading";
  if (forceBlock && !inline) className += " oi-side-rail";
  const tableCell = ["TD", "TH"].includes(String(el?.tagName || "").toUpperCase());
  const listLike = ["LI", "TD", "TH", "DT", "DD"].includes(String(el?.tagName || "").toUpperCase());
  const placement = inline || tableCell || forceBlock || (!forceBlock && listLike) ? "append" : "afterend";
  return {
    inline: Boolean(inline),
    forceBlock: Boolean(forceBlock),
    className,
    tagName: inline ? "SPAN" : "DIV",
    placement,
    host: forceBlock ? pickSideRailMountHost(el) : el
  };
}

export function translationClassName(el, ctx = {}, opts = {}) {
  return planTranslationMount(el, ctx, opts).className;
}

export function placeTranslationNode(source, node, plan) {
  if (!source || !node || !plan) return node;
  const host = plan.host || source;
  if (plan.placement === "append" && host.appendChild) {
    host.appendChild(node);
    return node;
  }
  if (host.insertAdjacentElement) {
    host.insertAdjacentElement("afterend", node);
    return node;
  }
  host.parentElement?.insertBefore?.(node, host.nextElementSibling || null);
  return node;
}

let railSeq = 0;

function attr(el, name) {
  if (!el) return "";
  const fromGet = el.getAttribute?.(name);
  if (fromGet) return String(fromGet);
  if (name === "data-oi-rail-id") return String(el.dataset?.oiRailId || "");
  if (name === "data-oi-for") return String(el.dataset?.oiFor || "");
  if (name === "data-oi-src-hash") return String(el.dataset?.oiSrcHash || "");
  return "";
}

export function normalizeSourceText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

/** Fingerprint of the visible source label. Recycled virtual-list rows keep the element, not this key. */
export function sourceTextHash(text) {
  const s = normalizeSourceText(text);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function setAttr(el, name, value) {
  if (!el) return;
  if (typeof el.setAttribute === "function") el.setAttribute(name, value);
  else if (el.dataset) {
    if (name === "data-oi-rail-id") el.dataset.oiRailId = value;
    else if (name === "data-oi-for") el.dataset.oiFor = value;
    else if (name === "data-oi-src-hash") el.dataset.oiSrcHash = value;
  }
}

export function recycleScrollerItemView(source) {
  let node = source;
  for (let i = 0; i < 10 && node; i++) {
    const cls = typeof node.className === "string" ? node.className : String(node.className?.baseVal || "");
    if (/vue-recycle-scroller__item-view/.test(cls)) return node;
    const tag = String(node.tagName || "").toUpperCase();
    if (["UL", "OL", "NAV", "ASIDE", "MAIN", "BODY", "HTML"].includes(tag)) break;
    node = node.parentElement;
  }
  return null;
}

function collectGlossFromRoot(root, out) {
  if (!root) return;
  const push = (node) => {
    if (node?.classList?.contains("oi-translation") && !out.includes(node)) out.push(node);
  };
  push(root.nextElementSibling);
  if (typeof root.querySelectorAll === "function") {
    const list = root.querySelectorAll(".oi-translation");
    if (list && typeof list.forEach === "function") list.forEach(push);
    else if (Array.isArray(list)) list.forEach(push);
  }
  const kids = root.children;
  if (kids) {
    const arr = typeof kids.length === "number" ? Array.from(kids) : [];
    arr.forEach(push);
  }
}

export function collectMountedGloss(source) {
  const out = [];
  if (!source) return out;
  const host = pickSideRailMountHost(source);
  collectGlossFromRoot(source, out);
  if (host && host !== source) collectGlossFromRoot(host, out);
  collectGlossFromRoot(recycleScrollerItemView(source), out);
  return out;
}

/**
 * Stamp rail-id + live label hash on the collected node, the mount host
 * (title-container), and the translation's actual parent after layout.
 */
export function stampRailMountKeys(source, translation) {
  const host = pickSideRailMountHost(source);
  const id = ensureRailId(source);
  const liveHash = sourceTextHash(getText(source));
  const targets = [source, host];
  if (translation?.parentElement) targets.push(translation.parentElement);
  targets.forEach((el) => {
    if (!el) return;
    setAttr(el, "data-oi-rail-id", id);
    setAttr(el, "data-oi-src-hash", liveHash);
  });
  if (translation) {
    setAttr(translation, "data-oi-for", id);
    setAttr(translation, "data-oi-src-hash", liveHash);
  }
  return { host, id, liveHash };
}

export function rebindLiveSourceHash(source, translation) {
  return stampRailMountKeys(source, translation).liveHash;
}

function detachGlossNode(node) {
  if (!node) return;
  if (typeof node.remove === "function") node.remove();
  else {
    const parent = node.parentElement;
    const kids = parent?.children;
    if (Array.isArray(kids)) {
      const i = kids.indexOf(node);
      if (i >= 0) kids.splice(i, 1);
    }
    node.parentElement = null;
  }
}

/**
 * Virtual-list reuse: same row DOM, new label. If any leftover gloss does not
 * match the live label, strip ALL .oi-translation on that row before remount.
 */
function glossIsStale(node, liveHash, railId) {
  const nodeHash = attr(node, "data-oi-src-hash");
  const forId = attr(node, "data-oi-for");
  if (nodeHash !== liveHash) return true;
  if (railId && forId && forId !== railId) return true;
  return false;
}

export function detachStaleRailGloss(source) {
  if (!source) return [];
  const host = pickSideRailMountHost(source);
  const liveHash = sourceTextHash(getText(source));
  const railId = attr(source, "data-oi-rail-id") || attr(host, "data-oi-rail-id");
  const nodes = collectMountedGloss(source);
  if (railId) {
    const view = recycleScrollerItemView(source) || host || source;
    const extras = view?.querySelectorAll?.(".oi-translation") || [];
    if (extras && typeof extras.forEach === "function") {
      extras.forEach((node) => {
        if (attr(node, "data-oi-for") === railId && !nodes.includes(node)) nodes.push(node);
      });
    }
  }
  const stale = nodes.some((node) => glossIsStale(node, liveHash, railId));
  const removed = [];
  if (stale) {
    nodes.forEach((node) => {
      detachGlossNode(node);
      removed.push(node);
    });
  }
  stampRailMountKeys(source);
  return removed;
}

export function glossForSource(source) {
  if (!source) return null;
  detachStaleRailGloss(source);
  const hash = sourceTextHash(getText(source));
  return collectMountedGloss(source).find((node) => attr(node, "data-oi-src-hash") === hash) || null;
}

/** Stable side-rail id on the source node. Mount keys translations with data-oi-for. */
export function ensureRailId(el) {
  if (!el) return "";
  const existing = attr(el, "data-oi-rail-id");
  if (existing) return existing;
  railSeq += 1;
  const id = `oi-rail-${railSeq}`;
  if (typeof el.setAttribute === "function") el.setAttribute("data-oi-rail-id", id);
  else if (el.dataset) el.dataset.oiRailId = id;
  return id;
}

/**
 * Pair each translation to its live source label (element + text hash).
 * Rail id is only a mount handle — it survives vue-recycle-scroller reuse
 * and must not look up the previous item's gloss.
 */
export function pairGlossBySource(sources, translations, keep) {
  const list = Array.isArray(sources) ? sources : [];
  const texts = Array.isArray(translations) ? translations : [];
  const bySource = new Map();
  const byHash = new Map();
  list.forEach((el, i) => {
    if (!el) return;
    const text = texts[i] == null ? "" : String(texts[i]);
    ensureRailId(el);
    const srcHash = rebindLiveSourceHash(el);
    bySource.set(el, text);
    if (srcHash) byHash.set(srcHash, text);
  });
  const targets = Array.isArray(keep) ? keep : list;
  return targets.map((el) => {
    const id = attr(el, "data-oi-rail-id");
    const srcHash = rebindLiveSourceHash(el);
    let text = "";
    if (bySource.has(el)) text = bySource.get(el);
    else if (srcHash && byHash.has(srcHash)) text = byHash.get(srcHash);
    return { source: el, text, key: id, srcHash };
  });
}

/** Mount KEEP pairs as SIDEBAR-BILINGUAL-STACK blocks keyed to the source. */
export function mountPairedGloss(sources, translations, keep, ctx = {}, opts = {}) {
  const pairs = pairGlossBySource(sources, translations, keep);
  const mounted = [];
  for (const pair of pairs) {
    const { source, text, key, srcHash } = pair;
    if (!source) continue;
    detachStaleRailGloss(source);
    if (!text) continue;
    const plan = planTranslationMount(source, ctx, opts);
    const node = opts.createNode?.(plan, pair) || {
      className: plan.className,
      textContent: text,
      dataset: { oiFor: key, oiSrcHash: srcHash },
      attributes: { "data-oi-for": key, "data-oi-src-hash": srcHash },
      setAttribute(name, value) {
        this.attributes[name] = value;
        if (name === "data-oi-for") this.dataset.oiFor = value;
        if (name === "data-oi-src-hash") this.dataset.oiSrcHash = value;
      },
      getAttribute(name) {
        return this.attributes[name] || "";
      },
      classList: {
        contains(name) {
          return String(this.className).split(/\s+/).includes(name);
        }
      }
    };
    if (typeof node.setAttribute === "function") {
      node.setAttribute("data-oi-for", key);
      if (srcHash) node.setAttribute("data-oi-src-hash", srcHash);
    }
    if (text && node.textContent == null) node.textContent = text;
    placeTranslationNode(source, node, plan);
    stampRailMountKeys(source, node);
    mounted.push({ ...pair, node, plan });
  }
  return mounted;
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
