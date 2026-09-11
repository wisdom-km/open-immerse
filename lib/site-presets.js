export const HARD_SKIP_SELECTOR = [
  "[data-aside-rail]",
  "[data-aside-track]",
  "[data-rail]",
  "[class*='marginalia']",
  "[class*='hero_blog_post_details']",
  ".hero_blog_post_details",
  ".hero_blog_post_details_list",
  ".hero_blog_post_details_item",
  ".hero_blog_post_details_content",
  "[class*='blog_post_details']",
  "[class*='details_list']",
  "[class*='details_item']",
  "aside",
  "[role='complementary']"
].join(", ");

export const GENERIC_NAV_SELECTOR = [
  "nav",
  "header",
  "[role='navigation']",
  "[role='banner']",
  "[role='menu']",
  "[role='menubar']"
].join(", ");

export const ARTICLE_CHROME_SELECTOR = [
  "aside",
  "footer",
  "[role='complementary']",
  "[role='contentinfo']"
].join(", ");

export const GENERIC_SKIP_SELECTOR = [GENERIC_NAV_SELECTOR, ARTICLE_CHROME_SELECTOR, HARD_SKIP_SELECTOR].join(", ");

export const CHROME_CLASS_RE =
  /(^|[\s_-])(nav|navbar|header|footer|sidebar|menubar|megamenu|cookie|consent|banner|marginalia|toc)([\s_-]|$)/i;

export const CHROME_META_RE =
  /^(category|product|date|author(?:\(s\))?|share|reading time|copy link|\d+\s*min\b)/i;

export const SITE_PRESETS = [
  {
    id: "claude",
    test: /(^|\.)claude\.com$/,
    main: [".u-rich-text-blog", ".blog_post_content_wrap", ".hero_blog_post_content"],
    skip: [
      ".nav_component",
      ".nav_desktop_layout",
      ".nav_mobile_layout",
      ".hero_blog_post_details",
      ".hero_blog_post_details_list",
      ".blog_post_marginalia",
      ".blog_post_marginalia_wrap",
      ".marginalia_rail",
      ".blog_related_section_wrap",
      "[data-aside-rail]",
      "[data-aside-track]"
    ]
  }
];

export function pickPreset(hostname) {
  const host = String(hostname || "").replace(/^www\./, "");
  return SITE_PRESETS.find((preset) => preset.test.test(host)) || null;
}

export function classLooksChrome(elOrClass) {
  const raw = typeof elOrClass === "string" ? elOrClass : elOrClass?.className || "";
  const cls = typeof raw === "string" ? raw : String(raw);
  return CHROME_CLASS_RE.test(cls);
}

export function isChromeMetaText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value || value.length >= 80) return false;
  return CHROME_META_RE.test(value);
}

export function matchesSelector(el, selector) {
  if (!el || !selector) return false;
  try {
    return Boolean(el.matches?.(selector) || el.closest?.(selector));
  } catch {
    return false;
  }
}

export function matchesPresetSkip(el, preset) {
  if (!el || !preset) return false;
  return (preset.skip || []).some((selector) => matchesSelector(el, selector));
}

export function isAlwaysBanned(el, hostname) {
  if (!el) return false;
  if (matchesSelector(el, HARD_SKIP_SELECTOR)) return true;
  if (matchesSelector(el, GENERIC_NAV_SELECTOR)) return true;
  if (matchesSelector(el, "aside, [role='complementary']")) return true;
  if (matchesPresetSkip(el, pickPreset(hostname))) return true;
  return isInMetaRail(el);
}

export function isInMetaRail(el, getTextFn) {
  const textOf = getTextFn || ((node) => String(node?.textContent || "").replace(/\s+/g, " ").trim());
  if (!el) return false;
  if (matchesSelector(el, HARD_SKIP_SELECTOR)) return true;
  if (matchesSelector(el, "aside, [role='complementary']")) return true;
  let node = el;
  for (let i = 0; i < 8 && node; i++) {
    const cls = typeof node.className === "string" ? node.className : String(node.className || "");
    if (/hero_blog_post_details|blog_post_details|details_list|details_item|marginalia|aside-rail|aside_rail/i.test(cls)) return true;
    node = node.parentElement;
  }
  const cluster = el.closest?.("li, dt, dd, [class*='details'], [class*='marginalia']");
  if (cluster) {
    const t = textOf(cluster);
    if (t.length > 0 && t.length < 160 && CHROME_META_RE.test(t)) return true;
  }
  return isChromeMetaText(textOf(el));
}
