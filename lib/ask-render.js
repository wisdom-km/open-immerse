/**
 * Answer text for the ask panel.
 * Math goes through KaTeX with trust:false. A parse failure, an untrusted
 * command (\href, \url, \htmlClass, \htmlId, \htmlStyle, \htmlData), or any
 * HTML that could run a script is replaced with the original characters.
 * The surrounding prose is escaped. Nothing in the returned string is the
 * model's markup.
 */

const UNSAFE_COMMAND = /\\(?:href|url|htmlClass|htmlId|htmlStyle|htmlData)\b/;

export const ASK_KATEX_OPTIONS = Object.freeze({
  throwOnError: false,
  trust: false,
  strict: "ignore",
  errorColor: "#e10091",
  output: "html",
  maxSize: 20,
  maxExpand: 1000
});

export function escapeAskText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** True when the TeX source does not ask KaTeX to build a link or HTML node. */
export function texIsDisplayable(tex) {
  return !UNSAFE_COMMAND.test(String(tex || ""));
}

/**
 * KaTeX's own HTML, and only that. Error-color output still contains the
 * rejected command, so it is not displayable. A stub that returns a script,
 * an event handler, or a link is not displayable either.
 */
export function katexHtmlIsSafe(html) {
  const text = String(html || "");
  if (!text.includes("katex")) return false;
  if (/<\s*(?:script|iframe|object|embed|link|meta|form|img|video|audio|style)\b/i.test(text)) return false;
  if (/<\s*a\b/i.test(text)) return false;
  if (/javascript\s*:/i.test(text)) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false;
  if (/#e10091/i.test(text)) return false;
  return true;
}

function renderMath(raw, tex, display, engine) {
  if (!engine || !texIsDisplayable(tex)) return escapeAskText(raw);
  let html = "";
  try {
    html = engine.renderToString(String(tex), { ...ASK_KATEX_OPTIONS, displayMode: display });
  } catch {
    return escapeAskText(raw);
  }
  if (!katexHtmlIsSafe(html)) return escapeAskText(raw);
  return html;
}

export function renderAskAnswer(source, katex = globalThis.katex) {
  const raw = String(source ?? "");
  const engine = katex?.renderToString ? katex : null;
  const parts = [];
  const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
  let cursor = 0;
  let match = re.exec(raw);
  while (match) {
    parts.push(escapeAskText(raw.slice(cursor, match.index)));
    const tex = match[1] != null ? match[1] : match[2];
    parts.push(renderMath(match[0], tex, match[1] != null, engine));
    cursor = match.index + match[0].length;
    match = re.exec(raw);
  }
  parts.push(escapeAskText(raw.slice(cursor)));
  return parts.join("");
}
