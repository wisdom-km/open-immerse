/**
 * Candidate arbitration. arXiv source never reaches this module.
 * Steps: text-layer referee, normalized agreement, pixel / image pick, else undecided.
 * The pixel step is a stub until F7.
 */

import { charsetJaccard, latexToCharset, pdfTextCharset } from "./formula-charset.js";
import { canRenderLatex } from "./formula-katex.js";
import { JACCARD_MIN, tierResult } from "./formula-contract.js";
import { prepareFormulaLatex } from "./latex-units.js";

export function normalizeLatex(latex, display = false) {
  return prepareFormulaLatex(latex, display).replace(/\s+/g, "");
}

export function glyphUncheckable(glyph) {
  const ch = String(glyph?.ch ?? glyph?.str ?? "");
  const font = String(glyph?.fontName || "");
  const trimmed = ch.trim();
  if (/^Adv/i.test(font) && (!trimmed || trimmed === ".notdef")) return true;
  for (const part of ch) {
    const cp = part.codePointAt(0);
    if (cp >= 0xE000 && cp <= 0xF8FF) return true;
    if (cp >= 0xF0000 && cp <= 0xFFFFD) return true;
    if (cp >= 0x100000 && cp <= 0x10FFFD) return true;
  }
  return false;
}

export function verifyCandidate(latex, unit, katex) {
  const rendered = latexToCharset(latex);
  const unknown = rendered.unknownCommands || [];
  const uncheckable = (unit?.glyphs || []).some(glyphUncheckable);
  const jaccard = charsetJaccard(rendered, pdfTextCharset(unit?.pdfText || ""));
  const katexCheck = canRenderLatex(latex, Boolean(unit?.display), katex);
  const matchesCharset = !unknown.length && !uncheckable && jaccard >= JACCARD_MIN;
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
  } else if (uncheckable) {
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
    matchesCharset
  };
}

export async function defaultPixelJudge() {
  return { decided: false };
}

function adopt(side, verdict) {
  return tierResult({
    ...side,
    status: "ok",
    render: "katex",
    latex: side.latex,
    confidence: verdict.confidence,
    checks: verdict.checks,
    reason: null,
    meta: { ...(side.meta || {}), cached: false }
  });
}

function pickSide(pixel, left, right) {
  const id = pixel?.tier || pixel?.pick;
  if (id == null) return null;
  const token = String(id);
  if (token === right?.tier || token === "right" || token === "b" || token === "B") return right;
  if (token === left?.tier || token === "left" || token === "a" || token === "A") return left;
  return null;
}

/**
 * @returns {{decided: boolean, chosen?: object, reason?: string, step: string}}
 */
export async function arbitrateCandidates({ left, right, unit, katex, pixelJudge } = {}) {
  const lv = verifyCandidate(left?.latex, unit, katex);
  const rv = verifyCandidate(right?.latex, unit, katex);
  const same = normalizeLatex(left?.latex, unit?.display) === normalizeLatex(right?.latex, unit?.display);

  if (lv.matchesCharset && !rv.matchesCharset && lv.pass) {
    return { decided: true, chosen: adopt(left, lv), step: "charset" };
  }
  if (rv.matchesCharset && !lv.matchesCharset && rv.pass) {
    return { decided: true, chosen: adopt(right, rv), step: "charset" };
  }
  if (lv.matchesCharset && rv.matchesCharset && same && (lv.pass || rv.pass)) {
    const side = lv.pass ? left : right;
    const verdict = lv.pass ? lv : rv;
    return { decided: true, chosen: adopt(side, verdict), step: "charset" };
  }
  if (same && (lv.checks.katex.pass || rv.checks.katex.pass)) {
    const side = lv.checks.katex.pass ? left : right;
    const verdict = lv.checks.katex.pass ? lv : rv;
    return { decided: true, chosen: adopt(side, verdict), step: "agree" };
  }
  const judge = pixelJudge || defaultPixelJudge;
  const pixel = await judge({ unit, left, right });
  if (pixel?.decided) {
    const side = pickSide(pixel, left, right);
    const verdict = side === left ? lv : side === right ? rv : null;
    if (side && verdict?.checks?.katex?.pass) {
      return { decided: true, chosen: adopt(side, { ...verdict, confidence: verdict.confidence }), step: "pixel" };
    }
  }
  return { decided: false, reason: "arbiter-undecided", step: "undecided" };
}
