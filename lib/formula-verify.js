/**
 * Second-layer check shared by the multimodal tier and, later, OCR.
 * Pure: parse the model text, then the same charset and KaTeX gate the
 * arbiter already used. No network, no cache, no key.
 */

import { charsetJaccard, latexToCharset, pdfTextCharset } from "./formula-charset.js";
import { canRenderLatex } from "./formula-katex.js";
import { JACCARD_MIN } from "./formula-contract.js";
import { prepareFormulaLatex } from "./latex-units.js";

export function normalizeLatex(latex, display = false) {
  return prepareFormulaLatex(latex, display).replace(/\s+/g, "");
}

export function glyphUncheckable(glyph) {
  const ch = String(glyph?.ch ?? glyph?.str ?? "");
  const font = String(glyph?.fontName || "");
  const trimmed = ch.trim();
  if (/^Adv/i.test(font) && (!trimmed || trimmed === ".notdef")) return true;
  return hasPrivateUse(ch);
}

function hasPrivateUse(text) {
  for (const part of String(text || "")) {
    const cp = part.codePointAt(0);
    if (cp >= 0xE000 && cp <= 0xF8FF) return true;
    if (cp >= 0xF0000 && cp <= 0xFFFFD) return true;
    if (cp >= 0x100000 && cp <= 0x10FFFD) return true;
  }
  return false;
}

const CONTROL_CHAR = /[\u0000-\u001F\u007F-\u009F]/;
// pdf.js emits these when a CMEX delimiter has no ToUnicode map.
const CMEX_BRACE = new Map([
  ["\u0012", "["],
  ["\u0013", "]"],
  ["\u0014", "["],
  ["\u0015", "]"]
]);
// After the control characters are removed, fewer than this many checkable
// characters means the text layer lost the glyphs. DPO's thinnest such
// formula still has 12, so 4 does not reject a real formula.
export const MIN_CHECKABLE_AFTER_CONTROL = 4;

function edgeNumberPattern(equationNumber) {
  const label = String(equationNumber || "").replace(/\s+/g, "");
  if (label && /\d/.test(label)) return label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return "\\((?:\\d+(?:\\.\\d+)*|[A-Z]\\d+|\\d+[a-z])\\)";
}

/** Drop a separated equation number at either edge. Interior parentheses stay. */
export function stripEdgeEquationNumber(text, equationNumber) {
  const body = String(text || "");
  const piece = edgeNumberPattern(equationNumber);
  const labeled = String(equationNumber || "").replace(/\s+/g, "");
  const end = new RegExp(`\\s*${piece}\\s*$`);
  if (end.test(body)) return body.replace(end, "").trim();
  if (labeled && /\d/.test(labeled)) {
    const start = new RegExp(`^\\s*[.,]?\\s*${piece}`);
    if (start.test(body)) return body.replace(start, "").trim();
  }
  return body.trim();
}

/**
 * Text the charset comparison actually sees.
 * CMEX brace codes become brackets, other C0/C1 controls drop, then the
 * edge equation number drops. The stored pdfText is unchanged.
 */
export function preparePdfComparisonText(text, equationNumber) {
  const mapped = String(text || "").replace(/[\u0012-\u0015]/g, (ch) => CMEX_BRACE.get(ch) || "");
  const stripped = mapped.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return stripEdgeEquationNumber(stripped, equationNumber);
}

/**
 * The source cannot be checked. Device units keep glyphs empty, so private-use
 * characters are read from pdfText. A control-stripped source that is too short
 * is the same outcome: do not ask the model.
 */
export function pdfSourceUncheckable(unit) {
  const raw = String(unit?.pdfText || "");
  if (hasPrivateUse(raw)) return true;
  if ((unit?.glyphs || []).some(glyphUncheckable)) return true;
  if (!CONTROL_CHAR.test(raw)) return false;
  const prepared = preparePdfComparisonText(raw, unit?.equationNumber);
  return pdfTextCharset(prepared).chars.size < MIN_CHECKABLE_AFTER_CONTROL;
}

// Sentence punctuation. Operators and primes are not in this set: "-" "−"
// "‖" "*" "/" "′" "'" "!" "·" "〈" still go to the model.
const SENTENCE_PUNCT = new Set([".", ",", ";", ":", "?", "…", "。", "，", "、", "；", "：", "？"]);

// Lone delimiters in DDPM and DPO land in this CM private-use block
// (U+F8EE, U+F8F9). Other private-use glyphs are not delimiters: a CMEX
// face often stores ∑ ∫ ⨁ there, and those are not skipped here.
const PUA_BRACKET_MIN = 0xF8EB;
const PUA_BRACKET_MAX = 0xF8FE;

function isSkippedDelimiter(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= PUA_BRACKET_MIN && cp <= PUA_BRACKET_MAX) return true;
  if ("()[]{}".includes(ch)) return true;
  return SENTENCE_PUNCT.has(ch);
}

/**
 * Parentheses, sentence punctuation, and the known private-use bracket
 * block only. A lone DDPM/DPO bracket is in that block. Math operators,
 * primes, and any other private-use glyph still go on to the vision gate.
 * Equation numbers are not stripped here, so "(2)" stays a real formula.
 */
export function punctuationOnlyFormula(unit) {
  if (!Object.hasOwn(unit || {}, "pdfText")) return false;
  const mapped = String(unit.pdfText).replace(/[\u0012-\u0015]/g, (ch) => CMEX_BRACE.get(ch) || "");
  const compact = mapped.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\s+/g, "");
  if (!compact) return false;
  for (const ch of compact) {
    if (!isSkippedDelimiter(ch)) return false;
  }
  return true;
}

/** No request: nothing checkable, or the source is uncheckable. */
export function visionSkipped(unit) {
  // A block that has not been turned into a unit has no pdfText. Callers that
  // pass that block still send; an empty unit source does not.
  if (!Object.hasOwn(unit || {}, "pdfText")) return false;
  const prepared = preparePdfComparisonText(unit.pdfText, unit?.equationNumber);
  if (pdfTextCharset(prepared).chars.size === 0) return true;
  return pdfSourceUncheckable(unit);
}

/**
 * A model often copies the sentence period or comma after the formula.
 * Drop a trailing `.` `,` `;` when the text layer does not end with it.
 * A period that belongs to the formula (the layer has it too) stays.
 * `\,` is a command, not sentence punctuation.
 */
export function stripTrailingVisionPunct(latex, pdfText) {
  let body = String(latex || "").trim();
  const pdf = String(pdfText || "").trim();
  while (body.length && /[.,;]/.test(body.at(-1))) {
    if (body.at(-2) === "\\") break;
    if (pdf.endsWith(body.at(-1))) break;
    body = body.slice(0, -1).trimEnd();
  }
  return body;
}

function boxOf(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const box = value.slice(0, 4).map((n) => Number(n));
  if (box.some((n) => !Number.isFinite(n))) return null;
  if (!(box[2] > box[0]) || !(box[3] > box[1])) return null;
  return box;
}

function centerInside(box, host) {
  const x = (box[0] + box[2]) / 2;
  const y = (box[1] + box[3]) / 2;
  return x >= host[0] && x <= host[2] && y >= host[1] && y <= host[3];
}

/** A neighbour has to sit against the formula, not several words away. */
const TIGHT_NEIGHBOUR_GAP = 0.02;

function sameBaseline(box, host) {
  const height = box[3] - box[1];
  if (!(height > 0)) return false;
  const overlap = Math.min(box[3], host[3]) - Math.max(box[1], host[1]);
  if (!(overlap > height * 0.5)) return false;
  const mid = (box[1] + box[3]) / 2;
  return mid > host[1] && mid < host[3];
}

function horizontalGap(box, host) {
  if (box[2] <= host[0]) return host[0] - box[2];
  if (box[0] >= host[2]) return box[0] - host[2];
  return 0;
}

function shortWords(text) {
  const found = [];
  for (const word of String(text || "").split(/[^A-Za-z]+/)) {
    if (/^[A-Za-z]{1,3}$/.test(word)) found.push(word);
  }
  return found;
}

/**
 * 1–3 letter words pressed against the formula on its own baseline.
 * Only the nearest word on the left and the nearest word on the right.
 * A line above or below does not qualify, and neither does a glyph whose
 * center sits in another formula. Letters inside this formula are not listed.
 */
export function neighbourEdgeLetters(items, formula, extras = {}) {
  const host = boxOf(formula?.layoutBbox) || boxOf(formula?.bbox);
  if (!host) return [];
  const others = (Array.isArray(extras?.formulaBoxes) ? extras.formulaBoxes : [])
    .map((box) => boxOf(box))
    .filter(Boolean);
  let left = null;
  let right = null;
  for (const item of items || []) {
    const box = boxOf(item?.bbox || item?.box);
    const text = String(item?.str || "");
    if (!box || !text.trim()) continue;
    if (centerInside(box, host)) continue;
    if (others.some((other) => centerInside(box, other))) continue;
    if (!sameBaseline(box, host)) continue;
    const gap = horizontalGap(box, host);
    if (!(gap >= 0) || gap > TIGHT_NEIGHBOUR_GAP) continue;
    const side = box[2] <= host[0] ? "left" : box[0] >= host[2] ? "right" : "";
    if (!side) continue;
    const current = side === "left" ? left : right;
    if (current && current.gap <= gap) continue;
    const next = { gap, text };
    if (side === "left") left = next;
    else right = next;
  }
  return [...new Set([...shortWords(left?.text), ...shortWords(right?.text)])];
}

function neighbourSet(letters) {
  const set = new Set();
  for (const raw of letters || []) {
    const word = String(raw || "").trim();
    if (/^[A-Za-z]{1,3}$/.test(word)) set.add(word);
  }
  return set;
}

function peelEdge(body, letters) {
  const leadCmd = body.match(/^\\(?:mathrm|text)\{([A-Za-z]{1,3})\}\s*/);
  if (leadCmd && letters.has(leadCmd[1])) return body.slice(leadCmd[0].length);
  const trailCmd = body.match(/\s*\\(?:mathrm|text)\{([A-Za-z]{1,3})\}$/);
  if (trailCmd && letters.has(trailCmd[1])) return body.slice(0, body.length - trailCmd[0].length);
  const lead = body.match(/^([A-Za-z]{1,3})(?:\s+|\\ )+/);
  if (lead && letters.has(lead[1])) return body.slice(lead[0].length);
  const trail = body.match(/(?:\s+|\\ )+([A-Za-z]{1,3})$/);
  if (trail && letters.has(trail[1])) return body.slice(0, body.length - trail[0].length);
  return body;
}

/**
 * Drop leading or trailing neighbour-word letters (plain or \\mathrm / \\text).
 * A letter that is not in `letters` stays, so a real variable is not peeled.
 */
export function stripNeighbourEdgeLetters(latex, letters) {
  const allowed = neighbourSet(letters);
  let body = String(latex || "").trim();
  if (!allowed.size) return body;
  for (let guard = 0; guard < 6; guard += 1) {
    const next = peelEdge(body, allowed).trim();
    if (next === body) break;
    body = next;
  }
  return body;
}

function sourceHasLetters(pdfText, token) {
  return token && String(pdfText || "").includes(token);
}

function sourceOverlap(latex, pdfText) {
  const prepared = preparePdfComparisonText(pdfText);
  return charsetJaccard(latexToCharset(latex), pdfTextCharset(prepared));
}

/**
 * C2 safety net. No extra model call.
 * A letter is peeled only when it is a confirmed neighbour, it does not
 * occur in the formula's own text, the peeled string still renders, and
 * the charset overlap with that text is strictly higher than before.
 * Otherwise the original string is kept.
 */
export function applyNeighbourSafetyNet(latex, letters, display = false, katex, pdfText = "") {
  const original = String(latex || "").trim();
  const prepared = preparePdfComparisonText(pdfText);
  const allowed = [];
  for (const word of letters || []) {
    const token = String(word || "").trim();
    if (!/^[A-Za-z]{1,3}$/.test(token)) continue;
    if (sourceHasLetters(prepared, token)) continue;
    allowed.push(token);
  }
  const stripped = stripNeighbourEdgeLetters(original, allowed);
  if (!stripped || stripped === original) return original;
  if (!canRenderLatex(stripped, display, katex).pass) return original;
  if (!(sourceOverlap(stripped, prepared) > sourceOverlap(original, prepared))) return original;
  return stripped;
}

export function verifyCandidate(latex, unit, katex) {
  const prepared = preparePdfComparisonText(unit?.pdfText || "", unit?.equationNumber);
  const punctuated = stripTrailingVisionPunct(latex, prepared);
  const cleaned = applyNeighbourSafetyNet(
    punctuated,
    unit?.neighbourLetters,
    Boolean(unit?.display),
    katex,
    prepared
  );
  const rendered = latexToCharset(cleaned);
  const pdf = pdfTextCharset(prepared);
  const unknown = rendered.unknownCommands || [];
  const uncheckable = pdfSourceUncheckable(unit);
  const answerEmpty = unknown.length === 0 && rendered.chars.size === 0;
  const sourceEmpty = pdf.chars.size === 0;
  const jaccard = charsetJaccard(rendered, pdf);
  const katexCheck = canRenderLatex(cleaned, Boolean(unit?.display), katex);
  const matchesCharset = !unknown.length && !uncheckable && !answerEmpty && !sourceEmpty && jaccard >= JACCARD_MIN;
  const checks = {
    charset: {
      pass: matchesCharset,
      jaccard,
      missingCommands: unknown.slice()
    },
    katex: { pass: katexCheck.pass, error: katexCheck.error }
  };
  let reason = null;
  let confidence = jaccard;
  if (unknown.length) {
    reason = "unknown-command";
    confidence = 0;
  } else if (answerEmpty) {
    reason = "charset-mismatch";
    confidence = 0;
  } else if (uncheckable || sourceEmpty) {
    reason = "uncheckable-glyph";
    confidence = 0;
  } else if (!matchesCharset) {
    reason = "charset-mismatch";
  } else if (!katexCheck.pass) {
    reason = "katex-error";
    confidence = 0;
  }
  return {
    pass: !reason,
    reason,
    confidence,
    checks,
    matchesCharset,
    latex: cleaned
  };
}

function failParse(reason) {
  return { ok: false, latex: null, reason };
}

function isLabel(text) {
  return /^(?:latex|tex|公式)?\s*[:：]?\s*$/i.test(String(text || "").trim());
}

function hasProse(body) {
  if (/[\u4e00-\u9fff]/.test(body)) return true;
  if (/\bunreadable\b/i.test(body)) return true;
  return /\b(?:the|this|formula|here|output|answer|sorry|because|blurry)\b/i.test(body);
}

/**
 * One math span. `\$` is literal. Unclosed delimiters are not spans.
 * @returns {{start: number, end: number, latex: string}[]}
 */
export function findMathSpans(body) {
  const text = String(body || "");
  const spans = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && text[i + 1] === "$") {
      i += 2;
      continue;
    }
    if (text.startsWith("$$", i) || text.startsWith("\\[", i) || text.startsWith("\\(", i)) {
      const open = text.startsWith("$$", i) ? "$$" : text.slice(i, i + 2);
      const close = open === "$$" ? "$$" : open === "\\[" ? "\\]" : "\\)";
      const end = text.indexOf(close, i + open.length);
      if (end < 0) break;
      spans.push({
        start: i,
        end: end + close.length,
        latex: text.slice(i + open.length, end)
      });
      i = end + close.length;
      continue;
    }
    if (text[i] === "$") {
      let end = i + 1;
      while (end < text.length) {
        if (text[end] === "\\") {
          end += 2;
          continue;
        }
        if (text[end] === "$") break;
        end += 1;
      }
      if (end >= text.length || text[end] !== "$") break;
      spans.push({ start: i, end: end + 1, latex: text.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return spans;
}

/**
 * Keep a single LaTeX formula.
 * Strips one fence and one wrapping `$` / `$$` / `\(` / `\[`.
 * `UNREADABLE`, empty text, prose, or more than one formula is rejected.
 * Reasons: `empty`, `unreadable`, `multi`.
 */
export function parseLatexCandidate(text) {
  const raw = String(text ?? "").replace(/\r\n/g, "\n").trim();
  if (!raw) return failParse("empty");
  if (/^unreadable$/i.test(raw)) return failParse("unreadable");

  const fenceRe = /```([a-z]*)\n?([\s\S]*?)```/gi;
  const fences = [...raw.matchAll(fenceRe)];
  if (fences.length > 1) return failParse("multi");
  let body = raw;
  if (fences.length === 1) {
    const outside = raw.replace(/```([a-z]*)\n?([\s\S]*?)```/i, "").trim();
    if (outside && !isLabel(outside)) return failParse("multi");
    body = String(fences[0][2] || "").trim();
  }
  if (!body) return failParse("empty");
  if (/^unreadable$/i.test(body)) return failParse("unreadable");

  const spans = findMathSpans(body);
  if (spans.length > 1) return failParse("multi");
  if (spans.length === 1) {
    const outside = `${body.slice(0, spans[0].start)}${body.slice(spans[0].end)}`.trim();
    if (outside && !isLabel(outside)) return failParse("multi");
    body = spans[0].latex.trim();
  }
  if (!body) return failParse("empty");
  if (/^unreadable$/i.test(body)) return failParse("unreadable");
  if (hasProse(body)) return failParse("multi");
  if (/\n\s*\n/.test(body) && !/\\begin\{/.test(body)) return failParse("multi");
  const lines = body.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 1 && !/\\begin\{/.test(body)) return failParse("multi");
  return { ok: true, latex: body, reason: null };
}
