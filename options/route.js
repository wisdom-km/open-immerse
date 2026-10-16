/** Eight settings pages and the old hash redirects. */

export const SETTINGS_PAGES = Object.freeze([
  { id: "translate", group: "常规", label: "翻译" },
  { id: "mm", group: "常规", label: "多模态 · OCR" },
  { id: "web", group: "阅读", label: "网页" },
  { id: "pdf", group: "阅读", label: "PDF 阅读" },
  { id: "notes", group: "阅读", label: "笔记" },
  { id: "labs", group: "更多", label: "功能与实验室" },
  { id: "data", group: "更多", label: "数据与隐私" },
  { id: "about", group: "更多", label: "关于" }
]);

const REDIRECTS = Object.freeze({
  engine: "translate",
  reading: "pdf",
  features: "web",
  advanced: "labs",
  ai: "mm",
  formula: "mm"
});

const FOCUS = new Set(["usage", "import", "export"]);

export function parseSettingsHash(hash) {
  const raw = String(hash || "").replace(/^#/, "");
  const cut = raw.indexOf("?");
  const idPart = (cut === -1 ? raw : raw.slice(0, cut)).trim();
  const query = cut === -1 ? "" : raw.slice(cut + 1);
  const params = new URLSearchParams(query);
  let id = idPart || "translate";
  let redirected = !idPart;
  if (Object.prototype.hasOwnProperty.call(REDIRECTS, id)) {
    id = REDIRECTS[id];
    redirected = true;
  }
  if (!SETTINGS_PAGES.some((page) => page.id === id)) {
    id = "translate";
    redirected = true;
  }
  const focusRaw = params.get("focus") || "";
  const focus = FOCUS.has(focusRaw) ? focusRaw : "";
  if (query) redirected = true;
  return { id, focus, redirected, replace: `#${id}` };
}
