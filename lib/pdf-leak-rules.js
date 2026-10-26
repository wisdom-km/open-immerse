/**
 * Deterministic leak counter for the journal text-layer surface.
 * Same patterns as rubric v3 (a)(b)(c) plus R2 invisible characters.
 * No model calls. Superscripts and end-of-line hyphens are not leaks.
 */

import {
  INVISIBLE_RE,
  isDecorativeText,
  remainingLigatureHoles
} from "./pdf-glyph-sanitize.js";
import {
  isDoiOnlyLine,
  isIssnOnlyLine,
  isMetadataLine,
  isOpenAccessLine,
  isSectionHeadingLine,
  normalizeChromeText
} from "./pdf-journal-chrome.js";

const SLOT_RE = /（公式槽待对齐）|（引用待对齐）|槽待对齐|⟦f\d+⟧/g;
const PLOS_RULE_RE = /a1{4,}/gi;
const RADICAL_RE = /p(?:\uFB00|\uFB01|\uFB02|\uFB03|\u0305|\u203E)+/gu;
const QUARTER_EQ_RE = /[=+\-*/^<>≤≥≠]\s*¼|¼\s*[=+\-*/^<>≤≥≠]/g;
const THORN_RE = /[þÞ]/g;
const TOFU_RE = /[\uFFFD\uE000-\uF8FF]+/g;
const PAGE_NUM_RE = /^(?:[-–—]\s*)?\d{1,4}(?:\s*[-–—])?$/;
const DOT_RULE_RE = /(?:^|\s)(?:[.\u00B7\u2022\u2027\u2219]){8,}(?=\s|$)/g;

function push(examples, type, match) {
  if (examples.length >= 12) return;
  examples.push({ type, match: String(match).slice(0, 80) });
}

function countMatches(text, re, type, bucket, examples) {
  re.lastIndex = 0;
  for (const match of String(text || "").matchAll(re)) {
    bucket[type] += 1;
    push(examples, type, match[0]);
  }
}

/** User-visible blocks. Header and footer labels are already out of the flow. */
export function readingSurfaceText(page) {
  const blocks = Array.isArray(page) ? page : (page?.blocks || []);
  const lines = [];
  for (const block of blocks || []) {
    if (!block || block.label === "header" || block.label === "footer") continue;
    const text = String(block.sourceText || block.text || "").trim();
    if (!text) continue;
    lines.push(text);
  }
  return lines.join("\n");
}

export function countLeaks(text) {
  const counts = { a: 0, b: 0, c: 0, r2: 0 };
  const examples = [];
  const value = String(text || "");
  countMatches(value, SLOT_RE, "a", counts, examples);
  countMatches(value, PLOS_RULE_RE, "b", counts, examples);
  countMatches(value, DOT_RULE_RE, "b", counts, examples);
  for (const line of value.split(/\n+/)) {
    if (!isDecorativeText(line)) continue;
    if (/a1{4,}/i.test(line) || /(?:[.\u00B7\u2022\u2027\u2219]){8,}/.test(line)) continue;
    counts.b += 1;
    push(examples, "b", line.trim());
  }
  countMatches(value, THORN_RE, "c", counts, examples);
  countMatches(value, RADICAL_RE, "c", counts, examples);
  countMatches(value, QUARTER_EQ_RE, "c", counts, examples);
  countMatches(value, TOFU_RE, "c", counts, examples);
  for (const hole of remainingLigatureHoles(value)) {
    counts.c += 1;
    push(examples, "c", hole);
  }
  countMatches(value, INVISIBLE_RE, "r2", counts, examples);
  const total = counts.a + counts.b + counts.c + counts.r2;
  return { total, counts, examples };
}

/** Chrome that is still inside the reading surface. Not part of the leak bar. */
export function countNoise(text) {
  let total = 0;
  const examples = [];
  for (const line of String(text || "").split(/\n+/)) {
    const t = normalizeChromeText(line);
    if (!t) continue;
    if (isSectionHeadingLine(t)) continue;
    const pageNumber = PAGE_NUM_RE.test(t);
    const meta = isMetadataLine(t) || isOpenAccessLine(t) || isDoiOnlyLine(t) || isIssnOnlyLine(t);
    if (!pageNumber && !meta) continue;
    if (isDecorativeText(t)) continue;
    total += 1;
    if (examples.length < 12) examples.push(t.slice(0, 80));
  }
  return { total, examples };
}
