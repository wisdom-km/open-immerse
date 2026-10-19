/**
 * Answer text for the ask panel.
 * A small Markdown subset plus KaTeX: paragraphs, **bold**, lists,
 * inline code, and fenced code. Headings, emphasis, links, and images
 * stay as escaped characters. Raw HTML is escaped.
 * Math uses KaTeX with trust:false. A parse failure, an untrusted command
 * (\href, \url, \htmlClass, \htmlId, \htmlStyle, \htmlData), HTML that could
 * run a script, or a formula past the count or length cap is replaced with
 * the original characters. Dollars inside code are not math.
 * The scan stays on the source. Private-use characters are ordinary text:
 * PDF text already contains U+E000, so they are not used as placeholders.
 */

const UNSAFE_COMMAND = /\\(?:href|url|htmlClass|htmlId|htmlStyle|htmlData)\b/;

/** Enough for a normal answer. Past this, the rest is escaped text. */
export const ASK_MATH_MAX_FORMULAS = 30;
export const ASK_MATH_MAX_TEX = 4000;

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

function takeMath(raw, tex, display, engine, budget) {
  const body = String(tex ?? "");
  if (budget.formulas >= ASK_MATH_MAX_FORMULAS || budget.texChars + body.length > ASK_MATH_MAX_TEX) {
    return escapeAskText(raw);
  }
  budget.formulas += 1;
  budget.texChars += body.length;
  return renderMath(raw, body, display, engine);
}

function atLineStart(text, index) {
  return index === 0 || text[index - 1] === "\n";
}

function openFence(text, index) {
  if (!atLineStart(text, index)) return null;
  const match = /^( {0,3})(`{3,})([^`\n]*)(?:\n|$)/.exec(text.slice(index));
  if (!match) return null;
  return { marks: match[2].length, contentAt: index + match[0].length };
}

function closeFence(text, contentAt, marks) {
  let index = contentAt;
  while (index <= text.length) {
    const lineEnd = text.indexOf("\n", index);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const line = text.slice(index, end);
    const ticks = /^( {0,3})(`{3,})[ \t]*$/.exec(line);
    if (ticks && ticks[2].length >= marks) {
      const contentEnd = index > contentAt && text[index - 1] === "\n" ? index - 1 : index;
      return { end: contentEnd, next: lineEnd === -1 ? text.length : lineEnd + 1 };
    }
    if (lineEnd === -1) return { end: text.length, next: text.length };
    index = lineEnd + 1;
  }
  return { end: text.length, next: text.length };
}

function findNextFence(text, from) {
  let newline = text.indexOf("\n", from);
  while (newline !== -1) {
    const lineStart = newline + 1;
    if (openFence(text, lineStart)) return lineStart;
    newline = text.indexOf("\n", lineStart);
  }
  return text.length;
}

function renderCode(text) {
  return `<pre><code>${escapeAskText(text)}</code></pre>`;
}

/** Next `$$` that is not inside a same-line inline code span. -1 if none. */
function nextDisplay(text, from) {
  let index = from;
  while (index < text.length) {
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index + 1 && !text.slice(index + 1, close).includes("\n")) {
        index = close + 1;
        continue;
      }
    }
    if (text.startsWith("$$", index)) return index;
    index += 1;
  }
  return -1;
}

function splitDisplay(text) {
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    const at = nextDisplay(text, cursor);
    if (at === -1) {
      parts.push(text.slice(cursor));
      break;
    }
    const close = nextDisplay(text, at + 2);
    if (close === -1 || close <= at + 2) {
      parts.push(text.slice(cursor, at + 2));
      cursor = at + 2;
      continue;
    }
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push({ raw: text.slice(at, close + 2), tex: text.slice(at + 2, close) });
    cursor = close + 2;
  }
  return parts;
}

function inlineHtml(text, engine, budget) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    if (text[index] === "`") {
      const close = text.indexOf("`", index + 1);
      if (close > index + 1 && !text.slice(index + 1, close).includes("\n")) {
        out += `<code>${escapeAskText(text.slice(index + 1, close))}</code>`;
        index = close + 1;
        continue;
      }
    }
    if (text.startsWith("**", index)) {
      const close = text.indexOf("**", index + 2);
      if (close !== -1) {
        out += `<strong>${inlineHtml(text.slice(index + 2, close), engine, budget)}</strong>`;
        index = close + 2;
        continue;
      }
    }
    if (text[index] === "$") {
      const close = text.indexOf("$", index + 1);
      if (close > index + 1 && !text.slice(index + 1, close).includes("\n")) {
        out += takeMath(text.slice(index, close + 1), text.slice(index + 1, close), false, engine, budget);
        index = close + 1;
        continue;
      }
    }
    if (text[index] === "\n") {
      out += "<br>";
      index += 1;
      continue;
    }
    let next = index + 1;
    while (
      next < text.length
      && text[next] !== "`"
      && text[next] !== "$"
      && text[next] !== "\n"
      && !text.startsWith("**", next)
    ) next += 1;
    out += escapeAskText(text.slice(index, next));
    index = next;
  }
  return out;
}

function renderParagraph(part, engine, budget) {
  if (!String(part || "").trim()) return "";
  const lines = String(part).split("\n");
  const filled = lines.filter((line) => line.trim());
  if (filled.length && filled.every((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line))) {
    const ordered = /^\s*(\d+)\./.exec(filled[0]);
    const start = ordered && /^\d{1,6}$/.test(ordered[1]) ? Number(ordered[1]) : 0;
    const open = ordered ? (start > 1 ? `<ol start="${start}">` : "<ol>") : "<ul>";
    const close = ordered ? "</ol>" : "</ul>";
    const body = filled.map((line) => {
      const item = line.replace(/^\s*(?:[-*]|\d+\.)\s+/, "");
      return `<li>${inlineHtml(item, engine, budget)}</li>`;
    }).join("");
    return open + body + close;
  }
  return `<p>${inlineHtml(part, engine, budget)}</p>`;
}

function renderText(text, engine, budget) {
  return String(text).split(/\n{2,}/).map((part) => renderParagraph(part, engine, budget)).join("");
}

function renderProse(text, engine, budget) {
  return splitDisplay(text).map((part) => (
    typeof part === "string"
      ? renderText(part, engine, budget)
      : takeMath(part.raw, part.tex, true, engine, budget)
  )).join("");
}

function renderSegments(text, engine, budget) {
  let html = "";
  let index = 0;
  while (index < text.length) {
    if (atLineStart(text, index)) {
      const fence = openFence(text, index);
      if (fence) {
        const closed = closeFence(text, fence.contentAt, fence.marks);
        html += renderCode(text.slice(fence.contentAt, closed.end));
        index = closed.next;
        continue;
      }
    }
    const next = findNextFence(text, index);
    html += renderProse(text.slice(index, next), engine, budget);
    index = next;
  }
  return html;
}

export function renderAskAnswer(source, katex = globalThis.katex) {
  const engine = katex?.renderToString ? katex : null;
  const budget = { formulas: 0, texChars: 0 };
  return renderSegments(String(source ?? "").replace(/\r\n/g, "\n"), engine, budget);
}
