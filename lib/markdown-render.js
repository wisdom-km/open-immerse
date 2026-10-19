/**
 * Shared Markdown for Ask AI and notes.
 * markdown-it (globalThis.markdownit, vendored UMD) renders CommonMark plus
 * the tables and strikethrough in that build. Task lists are a core rule here.
 * Raw HTML stays text (html:false) and the result is whitelist-sanitized.
 * Images are not loaded. Links are http, https, or mailto, and open in a new
 * tab. Math is masked before parse so a display formula stays inside its list
 * item, and a `$$` or `$` without a partner stays text. Dollars inside code
 * are not math. KaTeX runs with trust:false; a failure or an untrusted command
 * is the original characters. Private-use characters are ordinary text.
 */

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

const UNSAFE_COMMAND = /\\(?:href|url|htmlClass|htmlId|htmlStyle|htmlData)\b/;

const ALLOWED_TAGS = new Set([
  "p", "br", "hr", "strong", "em", "s", "del", "code", "pre",
  "ul", "ol", "li", "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  "table", "thead", "tbody", "tr", "th", "td",
  "a", "input", "span"
]);

let parser = null;
let parserFactory = null;

export function escapeAskText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function texIsDisplayable(tex) {
  return !UNSAFE_COMMAND.test(String(tex || ""));
}

/**
 * KaTeX's own HTML, and only that. Structural tags may carry attributes
 * (`<span class="katex">`, `aria-hidden`, sizing style). A script, an image,
 * a link, an event handler, or the error color is not displayable.
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

function markdownFactory() {
  const factory = globalThis.markdownit;
  if (typeof factory !== "function") return null;
  if (parser && parserFactory === factory) return parser;
  parserFactory = factory;
  const md = factory({
    html: false,
    xhtmlOut: false,
    breaks: true,
    linkify: true,
    typographer: false
  });
  md.validateLink = (url) => safeUrl(url) !== "";
  installTaskLists(md);
  md.renderer.rules.image = (tokens, idx) => renderImageToken(tokens[idx]);
  const open = md.renderer.rules.link_open
    || ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const href = String(token.attrGet("href") || "");
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer nofollow");
    if (href) token.attrSet("title", href);
    return open(tokens, idx, options, env, self);
  };
  parser = md;
  return parser;
}

/** Options and the image rule, so a test can see html:false before sanitizing. */
export function markdownItSetup() {
  const md = markdownFactory();
  if (!md) return null;
  return { html: md.options.html === true, imageRule: md.renderer.rules.image };
}

function renderImageToken(token) {
  const alt = String(token?.content || "");
  const label = escapeAskText(alt ? `图片：${alt}` : "图片：");
  const src = safeUrl(token?.attrGet?.("src") || "");
  if (!src) return label;
  const href = attrEscape(src);
  return `<a href="${href}" title="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
}

function installTaskLists(md) {
  md.core.ruler.after("inline", "oi_task_list", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i += 1) {
      const token = tokens[i];
      if (token.type !== "inline" || !token.content) continue;
      let prev = i - 1;
      while (prev >= 0 && tokens[prev].type === "paragraph_open") prev -= 1;
      if (prev < 0 || tokens[prev].type !== "list_item_open") continue;
      const match = /^\[([ xX])\][ \t]+/.exec(token.content);
      if (!match) continue;
      const rest = token.content.slice(match[0].length);
      token.content = rest;
      token.children = [];
      state.md.inline.parse(rest, state.md, state.env, token.children);
      const box = new state.Token("oi_checkbox", "", 0);
      box.meta = { checked: match[1].toLowerCase() === "x" };
      token.children.unshift(box);
    }
  });
  md.renderer.rules.oi_checkbox = (tokens, idx) => {
    const checked = tokens[idx].meta?.checked === true;
    return `<input type="checkbox" disabled${checked ? " checked" : ""}>`;
  };
}

function safeUrl(value) {
  const raw = String(value || "").trim();
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return "";
  const lower = raw.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
    return raw;
  }
  return "";
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
      return lineEnd === -1 ? text.length : lineEnd + 1;
    }
    if (lineEnd === -1) return text.length;
    index = lineEnd + 1;
  }
  return text.length;
}

/** Fenced code. Inline code is skipped in the math scan, unless a `$` pair wraps it. */
function fenceRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    if (atLineStart(text, index)) {
      const fence = openFence(text, index);
      if (fence) {
        const next = closeFence(text, fence.contentAt, fence.marks);
        if (next > index) ranges.push([index, next]);
        index = next > index ? next : index + 1;
        continue;
      }
    }
    index += 1;
  }
  return ranges;
}

function inlineCodeEnd(text, index) {
  if (text[index] !== "`") return -1;
  const close = text.indexOf("`", index + 1);
  if (close > index + 1 && !text.slice(index + 1, close).includes("\n")) return close + 1;
  return -1;
}

function rangeEndAt(ranges, index) {
  for (let i = 0; i < ranges.length; i += 1) {
    const [start, end] = ranges[i];
    if (index < start) return index;
    if (index < end) return end;
  }
  return index;
}

function overlapsRange(ranges, start, end) {
  for (let i = 0; i < ranges.length; i += 1) {
    const [from, to] = ranges[i];
    if (to <= start) continue;
    if (from >= end) return false;
    return true;
  }
  return false;
}

function findDisplayClose(text, from, ranges) {
  let index = from;
  while (index < text.length) {
    const skip = rangeEndAt(ranges, index);
    if (skip > index) {
      index = skip;
      continue;
    }
    if (text.startsWith("$$", index)) return index;
    index += 1;
  }
  return -1;
}

function markerFor(text) {
  let marker = "OIMATH";
  let guard = 0;
  while (text.includes(marker) && guard < 8) {
    marker += "X";
    guard += 1;
  }
  if (text.includes(marker)) return "";
  return marker;
}

function isListLine(line) {
  return /^\s*(?:[-*+]|\d{1,9}[.)])(?:\s|$)/.test(line);
}

/**
 * A display formula that follows a list item is pulled onto that item.
 * A blank line between them does not end the list.
 */
function foldDisplay(text, start, end, token) {
  let cursor = start;
  while (cursor > 0 && (text[cursor - 1] === " " || text[cursor - 1] === "\t" || text[cursor - 1] === "\n")) {
    cursor -= 1;
  }
  if (cursor === 0) return `${token}${text.slice(end)}`;
  const lineStart = text.lastIndexOf("\n", cursor - 1) + 1;
  const line = text.slice(lineStart, cursor);
  if (!isListLine(line)) return text.slice(0, start) + token + text.slice(end);
  return `${text.slice(0, cursor)} ${token}${text.slice(end)}`;
}

function readDestination(text, start) {
  let index = start;
  while (index < text.length && (text[index] === " " || text[index] === "\t" || text[index] === "\n")) index += 1;
  if (index >= text.length) return null;
  if (text[index] === "<") {
    const close = text.indexOf(">", index + 1);
    if (close === -1 || text.slice(index, close).includes("\n")) return null;
    return [index, close + 1];
  }
  let depth = 0;
  let cursor = index;
  for (; cursor < text.length; cursor += 1) {
    const ch = text[cursor];
    if (ch === "\\") {
      cursor += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n") break;
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  if (cursor === index) return null;
  return [index, cursor];
}

/** Link destinations and bare URLs. Dollars inside them stay characters, not math. */
function linkDestinationRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "<") {
      const close = text.indexOf(">", index + 1);
      const inner = close === -1 ? "" : text.slice(index + 1, close).trim();
      if (close !== -1 && /^(https?:|mailto:)/i.test(inner) && !inner.includes("\n")) {
        ranges.push([index, close + 1]);
        index = close + 1;
        continue;
      }
    }
    if (text[index] === "]" && text[index + 1] === "(") {
      const dest = readDestination(text, index + 2);
      if (dest) {
        ranges.push(dest);
        index = dest[1];
        continue;
      }
    }
    const prev = index === 0 ? "" : text[index - 1];
    if ((index === 0 || /[\s(<]/.test(prev)) && /^(https?:\/\/|mailto:)/i.test(text.slice(index))) {
      const match = /^(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)/i.exec(text.slice(index));
      if (match) {
        ranges.push([index, index + match[0].length]);
        index += match[0].length;
        continue;
      }
    }
    index += 1;
  }
  return ranges;
}

function mergeRanges(ranges) {
  const sorted = ranges.filter((range) => range[1] > range[0]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

function maskMath(text) {
  const ranges = mergeRanges([...fenceRanges(text), ...linkDestinationRanges(text)]);
  const marker = markerFor(text);
  const slots = [];
  if (!marker) return { text, slots, marker: "" };
  let index = 0;
  while (index < text.length) {
    const skip = rangeEndAt(ranges, index);
    if (skip > index) {
      index = skip;
      continue;
    }
    const codeEnd = inlineCodeEnd(text, index);
    if (codeEnd !== -1) {
      index = codeEnd;
      continue;
    }
    if (text.startsWith("$$", index)) {
      const close = findDisplayClose(text, index + 2, ranges);
      if (close === -1 || overlapsRange(ranges, index, close + 2)) {
        index += 2;
        continue;
      }
      const tex = text.slice(index + 2, close);
      if (!tex.trim()) {
        index += 2;
        continue;
      }
      slots.push({ start: index, end: close + 2, tex, display: true });
      index = close + 2;
      continue;
    }
    if (text[index] === "$") {
      const close = text.indexOf("$", index + 1);
      const span = close === -1 ? "" : text.slice(index + 1, close);
      if (close === -1 || !span || span.includes("\n") || overlapsRange(ranges, index, close + 1)) {
        index += 1;
        continue;
      }
      slots.push({ start: index, end: close + 1, tex: span, display: false });
      index = close + 1;
      continue;
    }
    index += 1;
  }
  let masked = text;
  for (let n = slots.length - 1; n >= 0; n -= 1) {
    const slot = slots[n];
    const token = `${marker}${n}END`;
    slot.token = token;
    masked = slot.display
      ? foldDisplay(masked, slot.start, slot.end, token)
      : masked.slice(0, slot.start) + token + masked.slice(slot.end);
  }
  return { text: masked, slots, marker };
}

function renderMath(slot, engine, budget) {
  const raw = slot.display ? `$$${slot.tex}$$` : `$${slot.tex}$`;
  const body = String(slot.tex || "");
  const over = budget.formulas >= ASK_MATH_MAX_FORMULAS || budget.texChars + body.length > ASK_MATH_MAX_TEX;
  const displayable = texIsDisplayable(body);
  if (over || !displayable) return escapeAskText(raw);
  if (!engine) {
    budget.formulas += 1;
    budget.texChars += body.length;
    const tex = escapeAskText(body);
    return `<span class="oi-note-math" data-display="${slot.display ? "1" : "0"}" data-tex="${tex}">${tex}</span>`;
  }
  let html = "";
  try {
    html = engine.renderToString(body, { ...ASK_KATEX_OPTIONS, displayMode: slot.display === true });
  } catch {
    return escapeAskText(raw);
  }
  if (!katexHtmlIsSafe(html)) return escapeAskText(raw);
  budget.formulas += 1;
  budget.texChars += body.length;
  return html;
}

function replaceMarkers(text, slots, marker, engine, budget) {
  const pattern = new RegExp(`${marker}(\\d+)END`, "g");
  return text.replace(pattern, (token, index) => {
    const slot = slots[Number(index)];
    if (!slot || slot.token !== token) return escapeAskText(token);
    return renderMath(slot, engine, budget);
  });
}

/**
 * Expand math only in text. Attribute values are copied unchanged, and this
 * runs before the sanitizer so nothing rewrites a href afterwards.
 */
function restoreMathInText(html, slots, marker, engine, budget) {
  if (!marker || !slots.length) return html;
  let out = "";
  let index = 0;
  while (index < html.length) {
    if (html[index] === "<") {
      const start = index;
      index += 1;
      let quote = "";
      while (index < html.length) {
        const ch = html[index];
        if (quote) {
          if (ch === quote) quote = "";
          index += 1;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          index += 1;
          continue;
        }
        if (ch === ">") {
          index += 1;
          break;
        }
        index += 1;
      }
      out += html.slice(start, index);
      continue;
    }
    const next = html.indexOf("<", index);
    const end = next === -1 ? html.length : next;
    out += replaceMarkers(html.slice(index, end), slots, marker, engine, budget);
    index = end;
  }
  return out;
}

function fallbackHtml(source, slots, marker, engine, budget) {
  const escaped = escapeAskText(source);
  const blocks = escaped.split(/\n{2,}/).map((block) => {
    const body = block.replace(/\n/g, "<br>");
    return body.trim() ? `<p>${body}</p>` : "";
  }).join("");
  return sanitizeMarkdownHtml(restoreMathInText(blocks, slots, marker, engine, budget));
}

function attrEscape(value) {
  return escapeAskText(value).replace(/'/g, "&#39;");
}

function decodeHtmlAttr(value) {
  return String(value)
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeAttr(name, attr, value) {
  const key = String(attr || "").toLowerCase();
  if (!key || key.startsWith("on") || key === "src" || key === "srcdoc") return "";
  if (name === "ol" && key === "start" && /^\d{1,6}$/.test(value)) return `start="${value}"`;
  if ((name === "th" || name === "td") && key === "style" && /^text-align:\s*(left|center|right)$/i.test(value.trim())) {
    const align = /left|center|right/i.exec(value)[0].toLowerCase();
    return `style="text-align:${align}"`;
  }
  if (name === "code" && key === "class" && /^language-[A-Za-z0-9_+-]+$/.test(value)) {
    return `class="${attrEscape(value)}"`;
  }
  if (name === "a" && key === "href") {
    const href = safeUrl(decodeHtmlAttr(value));
    return href ? `href="${attrEscape(href)}"` : "";
  }
  if (name === "a" && key === "title") {
    const title = decodeHtmlAttr(value);
    if (!title || /[\u0000-\u001f\u007f]/.test(title)) return "";
    return `title="${attrEscape(title)}"`;
  }
  if (name === "input" && (key === "type" || key === "disabled" || key === "checked")) return key;
  return "";
}

function readAttributes(raw) {
  const found = [];
  let index = 0;
  while (index < raw.length) {
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    if (index >= raw.length) break;
    if (!/[A-Za-z_:]/.test(raw[index])) {
      index += 1;
      continue;
    }
    const nameAt = index;
    while (index < raw.length && /[A-Za-z0-9_:-]/.test(raw[index])) index += 1;
    const attr = raw.slice(nameAt, index);
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
    let value = "";
    let bare = true;
    if (raw[index] === "=") {
      bare = false;
      index += 1;
      while (index < raw.length && /\s/.test(raw[index])) index += 1;
      if (raw[index] === '"' || raw[index] === "'") {
        const quote = raw[index];
        index += 1;
        const valueAt = index;
        while (index < raw.length && raw[index] !== quote) index += 1;
        value = raw.slice(valueAt, index);
        if (raw[index] === quote) index += 1;
      } else {
        const valueAt = index;
        while (index < raw.length && !/[\s>]/.test(raw[index])) index += 1;
        value = raw.slice(valueAt, index);
      }
    }
    found.push({ attr, value, bare });
  }
  return found;
}

/**
 * Whitelist sanitizer. Structural tags keep safe attributes (`ol start`,
 * alignment, link href, code class). Anything else, including a tag that
 * never closes, is escaped text. The index always moves forward.
 */
export function sanitizeMarkdownHtml(html) {
  const src = String(html || "");
  let out = "";
  let index = 0;
  while (index < src.length) {
    const lt = src.indexOf("<", index);
    if (lt === -1) {
      out += src.slice(index);
      break;
    }
    out += src.slice(index, lt);
    const tag = readTag(src, lt);
    if (!tag) {
      out += "&lt;";
      index = lt + 1;
      continue;
    }
    out += tag.html;
    index = tag.end;
  }
  return out;
}

function readTag(src, start) {
  const limit = Math.min(src.length, start + 4000);
  let index = start + 1;
  if (index >= src.length) return null;
  let closing = false;
  if (src[index] === "/") {
    closing = true;
    index += 1;
  }
  if (index >= limit || !/[A-Za-z]/.test(src[index])) return null;
  const nameAt = index;
  while (index < limit && /[A-Za-z0-9]/.test(src[index])) index += 1;
  const name = src.slice(nameAt, index).toLowerCase();
  let quote = "";
  let end = -1;
  for (let cursor = index; cursor < limit; cursor += 1) {
    const ch = src[cursor];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ">") {
      end = cursor + 1;
      break;
    }
  }
  if (end === -1) return null;
  if (!ALLOWED_TAGS.has(name)) return { end, html: escapeAskText(src.slice(start, end)) };
  if (closing) return { end, html: `</${name}>` };
  const attrs = readAttributes(src.slice(index, end - 1).replace(/\/\s*$/, ""));
  if (name === "input") {
    const type = attrs.find((item) => item.attr.toLowerCase() === "type");
    if (type && type.value.toLowerCase() !== "checkbox") {
      return { end, html: escapeAskText(src.slice(start, end)) };
    }
    const checked = attrs.some((item) => item.attr.toLowerCase() === "checked");
    return { end, html: `<input type="checkbox" disabled${checked ? " checked" : ""}>` };
  }
  if (name === "br" || name === "hr") return { end, html: `<${name}>` };
  if (name === "span") return { end, html: spanHtml(src.slice(start, end), attrs) };
  const kept = [];
  let href = "";
  let title = "";
  for (const item of attrs) {
    const safe = safeAttr(name, item.attr, item.value);
    if (!safe) continue;
    const key = item.attr.toLowerCase();
    if (name === "a" && key === "href") href = safe;
    else if (name === "a" && key === "title") title = safe;
    else if (!safe.startsWith("type") && safe !== "disabled" && safe !== "checked") kept.push(safe);
  }
  if (name === "a") {
    if (!href) return { end, html: escapeAskText(src.slice(start, end)) };
    const titled = title ? ` ${title}` : "";
    return { end, html: `<a ${href}${titled} target="_blank" rel="noopener noreferrer nofollow">` };
  }
  const suffix = kept.length ? ` ${kept.join(" ")}` : "";
  return { end, html: `<${name}${suffix}>` };
}

function renderWithMarkdown(source, engine, budget) {
  const md = markdownFactory();
  const masked = maskMath(source);
  if (!md) return fallbackHtml(masked.text, masked.slots, masked.marker, engine, budget);
  let html = "";
  try {
    html = md.render(masked.text);
  } catch {
    return fallbackHtml(masked.text, masked.slots, masked.marker, engine, budget);
  }
  const withMath = restoreMathInText(html, masked.slots, masked.marker, engine, budget);
  return sanitizeMarkdownHtml(withMath);
}

function spanHtml(raw, attrs) {
  const kept = [];
  for (const item of attrs) {
    const key = item.attr.toLowerCase();
    if (key === "class" && /^[A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*$/.test(item.value)) {
      kept.push(`class="${attrEscape(item.value)}"`);
    } else if (key === "style" && item.value && !/url\s*\(|expression|javascript|@import/i.test(item.value)) {
      kept.push(`style="${attrEscape(item.value)}"`);
    } else if (key === "aria-hidden" && /^(true|false)$/.test(item.value.toLowerCase())) {
      kept.push(`aria-hidden="${item.value.toLowerCase()}"`);
    }
  }
  if (!kept.some((part) => part.startsWith("class="))) return escapeAskText(raw);
  return `<span ${kept.join(" ")}>`;
}

export function renderMarkdown(source, katex) {
  const engine = katex?.renderToString ? katex : null;
  const budget = { formulas: 0, texChars: 0 };
  const text = String(source ?? "").replace(/\r\n/g, "\n");
  return renderWithMarkdown(text, engine, budget);
}

export function renderAskAnswer(source, katex = globalThis.katex) {
  return renderMarkdown(source, katex);
}
