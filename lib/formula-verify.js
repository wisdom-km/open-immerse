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

/**
 * Parentheses and punctuation only, including a private-use delimiter glyph
 * with no letters or digits (the lone DDPM/DPO brackets). Math operators,
 * letters, and digits still go to the model. Equation numbers are not
 * stripped here, so "(2)" stays a real formula.
 */
export function punctuationOnlyFormula(unit) {
  if (!Object.hasOwn(unit || {}, "pdfText")) return false;
  const mapped = String(unit.pdfText).replace(/[\u0012-\u0015]/g, (ch) => CMEX_BRACE.get(ch) || "");
  const compact = mapped.replace(/[\u0000-\u001F\u007F-\u009F]/g, "").replace(/\s+/g, "");
  if (!compact) return false;
  return /^[\p{P}\p{Co}]+$/u.test(compact);
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

export function verifyCandidate(latex, unit, katex) {
  const prepared = preparePdfComparisonText(unit?.pdfText || "", unit?.equationNumber);
  const cleaned = stripTrailingVisionPunct(latex, prepared);
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
