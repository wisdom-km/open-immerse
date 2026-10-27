/**
 * Per-paragraph check of a multimodal page against the text layer.
 * Pure. Does not fetch, log, or read secrets.
 *
 * Display rules (approved 2026-10-27):
 * - fill ⟨⋯⟩ from the model when both sides of the gap are found
 * - put a text-layer sentence back when the model dropped it (flag restored)
 * - numbers follow the text layer, unless that spot still has ⟨⋯⟩ (then the model)
 * - model-only prose is kept and flagged mm-only; figure text and chrome are not
 */

import { GLYPH_GAP_MARK } from "./pdf-glyph-sanitize.js";
import { placeholderTokens } from "./pdf-blocks.js";

export const MM_SENTENCE_DISTANCE = 0.3;

const MARK = GLYPH_GAP_MARK;
const NUM_RE = /\[\s*\d+(?:\s*,\s*\d+)*\s*\]|\d+(?:\.\d+)?(?:\s?(?:%|℃|°C|mg|kg|g|mm|cm|km|nm|μm|um|mL|ml|Hz|kHz|MHz|ms|min|bp|kb))?/gi;

export function normalizeParaText(text) {
  return String(text || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function sentences(text) {
  const normalized = normalizeParaText(text);
  if (!normalized) return [];
  const parts = normalized.split(/(?<=[.!?。！？])\s+/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : [normalized];
}

function levenshtein(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const row = new Array(right.length + 1);
  for (let j = 0; j <= right.length; j += 1) row[j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const tmp = row[j];
      const cost = left.charCodeAt(i - 1) === right.charCodeAt(j - 1) ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = tmp;
    }
  }
  return row[right.length];
}

export function sentenceDistance(a, b) {
  const left = normalizeParaText(a).toLowerCase();
  const right = normalizeParaText(b).toLowerCase();
  if (!left && !right) return 0;
  if (!left || !right) return 1;
  if (left === right) return 0;
  return levenshtein(left.slice(0, 400), right.slice(0, 400)) / Math.max(left.length, right.length);
}

function sentenceFound(sentence, haystack) {
  const target = normalizeParaText(sentence);
  if (!target) return true;
  const host = normalizeParaText(haystack);
  if (host.includes(target)) return true;
  return sentences(host).some((part) => sentenceDistance(target, part) <= MM_SENTENCE_DISTANCE);
}

function iou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 4 || b.length < 4) return 0;
  const x0 = Math.max(a[0], b[0]);
  const y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[2], b[2]);
  const y1 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union > 0 ? inter / union : 0;
}

function alignScore(textBlock, mmBlock) {
  const overlap = iou(textBlock?.bbox, mmBlock?.bbox);
  const text = 1 - sentenceDistance(textBlock?.text || "", mmBlock?.text || "");
  return overlap * 2 + text;
}

function alignMany(textBlocks, mmBlocks) {
  const byMm = new Map();
  const usedText = new Set();
  const usedMm = new Set();
  const scores = [];
  textBlocks.forEach((textBlock, textIndex) => {
    mmBlocks.forEach((mmBlock, mmIndex) => {
      scores.push({ textIndex, mmIndex, score: alignScore(textBlock, mmBlock) });
    });
  });
  scores.sort((a, b) => b.score - a.score);
  for (const row of scores) {
    if (row.score < 0.45) continue;
    if (usedText.has(row.textIndex)) continue;
    usedText.add(row.textIndex);
    usedMm.add(row.mmIndex);
    if (!byMm.has(row.mmIndex)) byMm.set(row.mmIndex, []);
    byMm.get(row.mmIndex).push(row.textIndex);
  }
  return { byMm, usedText, usedMm };
}

function blockTop(block) {
  const box = block?.bbox;
  if (!Array.isArray(box) || box.length < 4) return null;
  return Math.min(box[1], box[3]);
}

function blockLeft(block) {
  const box = block?.bbox;
  if (!Array.isArray(box) || box.length < 2) return 0;
  return Math.min(box[0], box[2]);
}

/** Insert by position. A block without a box stays where the caller is, never forced to the end. */
export function insertBlockByPosition(blocks, block) {
  const list = blocks || [];
  const top = blockTop(block);
  if (top == null) {
    list.push(block);
    return list;
  }
  const left = blockLeft(block);
  let at = list.findIndex((item) => {
    const itemTop = blockTop(item);
    if (itemTop == null) return false;
    if (Math.abs(itemTop - top) > 0.02) return itemTop > top;
    return blockLeft(item) > left;
  });
  if (at < 0) at = list.length;
  list.splice(at, 0, block);
  return list;
}

function extractNums(text) {
  return [...String(text || "").matchAll(NUM_RE)].map((hit) => hit[0]);
}

function gapCount(text) {
  return String(text || "").split(MARK).length - 1;
}

/**
 * A gap is filled when its left and right context both sit in the model text
 * with a short span between them. The displayed characters are the model's.
 */
export function countFilledGaps(textLayer, model) {
  const source = String(textLayer || "");
  const host = String(model || "");
  const gaps = gapCount(source);
  if (!gaps) return { gaps: 0, filled: 0 };
  let filled = 0;
  const pieces = source.split(MARK);
  for (let i = 0; i < pieces.length - 1; i += 1) {
    const left = normalizeParaText(pieces[i]).slice(-12);
    const right = normalizeParaText(pieces[i + 1]).slice(0, 12);
    if (left.length < 2 || right.length < 2) continue;
    const at = host.indexOf(left);
    if (at < 0) continue;
    const after = host.indexOf(right, at + left.length);
    if (after < 0) continue;
    const middle = host.slice(at + left.length, after);
    if (middle.length <= 12 && !middle.includes(MARK)) filled += 1;
  }
  return { gaps, filled };
}

function applyTextLayerNumbers(model, textLayer) {
  const modelNums = extractNums(model);
  const layerNums = extractNums(textLayer);
  const layerSentences = sentences(textLayer);
  const gapOwns = layerNums.map((token) => {
    const home = layerSentences.find((sentence) => sentence.includes(token));
    return Boolean(home && home.includes(MARK));
  });
  if (modelNums.join("|") === layerNums.join("|")) {
    return { text: model, mismatch: false, pairs: [] };
  }
  if (layerNums.length && gapOwns.every(Boolean)) {
    return { text: model, mismatch: false, pairs: [] };
  }
  const pairs = [];
  let index = 0;
  const next = model.replace(NUM_RE, (token) => {
    const clean = token.replace(/\s+/g, "");
    const replacement = layerNums[index];
    const fromLayer = replacement == null ? token : replacement;
    const layerClean = String(fromLayer).replace(/\s+/g, "");
    if (layerClean !== clean && !gapOwns[index]) pairs.push({ text: fromLayer, model: token });
    index += 1;
    return fromLayer;
  });
  if (layerNums.length > modelNums.length) {
    const extra = layerNums.slice(modelNums.length);
    extra.forEach((token) => pairs.push({ text: token, model: "" }));
  }
  return { text: next, mismatch: pairs.length > 0, pairs };
}

function restorePlaceholders(model, textLayer) {
  const missing = placeholderTokens(textLayer).map((entry) => entry.token).filter((token) => !model.includes(token));
  if (!missing.length) return model;
  return `${model}${model && !model.endsWith(" ") ? " " : ""}${missing.join("")}`;
}

function pushFlag(block, flag) {
  const flags = new Set(block.flags || []);
  if (block.flag) flags.add(block.flag);
  flags.add(flag);
  const priority = ["num-mismatch", "restored", "mm-only"];
  const list = priority.filter((item) => flags.has(item));
  block.flags = list;
  block.flag = list[0] || "";
}

const VISUAL = new Set(["figure", "table"]);
const PERIPHERAL = new Set(["header", "footer", "footnote", "page-number"]);

/** Header, footer, and footnote stay untranslated even when the label drifted to text or the other way. */
export function peripheralKind(block) {
  const label = String(block?.label || "");
  const role = String(block?.role || "");
  if (PERIPHERAL.has(label)) return label;
  if (PERIPHERAL.has(role)) return role;
  return "";
}

function markPeripheral(block, kind) {
  block.label = kind;
  block.skipTranslate = true;
  if (kind === "footnote") block.role = "footnote";
  delete block.flag;
  delete block.flags;
  delete block.markDetail;
}

/**
 * @returns {{ blocks: Array, stats: { gapsIn: number, gapsFilled: number, restored: number, numMismatch: number, mmOnly: number } }}
 */
export function reconcilePage(mmBlocks, textBlocks) {
  const text = (textBlocks || []).filter(Boolean);
  const mm = (mmBlocks || []).map((block) => ({ ...block }));
  const { byMm, usedMm } = alignMany(text, mm);
  const stats = { gapsIn: 0, gapsFilled: 0, restored: 0, numMismatch: 0, mmOnly: 0 };
  const consumedText = new Set();

  for (const [mmIndex, textIndexes] of byMm) {
    const block = mm[mmIndex];
    const sources = textIndexes.map((index) => text[index]);
    sources.forEach((source, index) => consumedText.add(textIndexes[index]));
    const source = sources[0];
    if (sources.length === 1) {
      if (source.id) block.id = source.id;
      if (source.bid) block.bid = source.bid;
    }
    if (!block.bbox && source.bbox) block.bbox = source.bbox;
    const kind = sources.map(peripheralKind).find(Boolean) || peripheralKind(block);
    if (kind) {
      markPeripheral(block, kind);
      continue;
    }
    if (block.label === "formula" || block.label === "figure" || block.label === "table") continue;
    const layerText = sources.map((item) => item.text || "").join(" ");
    const gaps = countFilledGaps(layerText, block.text || "");
    stats.gapsIn += gaps.gaps;
    stats.gapsFilled += gaps.filled;
    const numbers = applyTextLayerNumbers(block.text || "", layerText);
    block.text = restorePlaceholders(numbers.text, layerText);
    if (numbers.mismatch) {
      pushFlag(block, "num-mismatch");
      block.markDetail = { ...(block.markDetail || {}), nums: numbers.pairs };
      stats.numMismatch += numbers.pairs.length;
    }
    const dropped = sources.flatMap((item) => sentences(item.text).filter((sentence) => !sentenceFound(sentence, block.text)));
    if (dropped.length) {
      block.text = `${block.text}${block.text ? " " : ""}${dropped.join(" ")}`.trim();
      pushFlag(block, "restored");
      stats.restored += dropped.length;
    }
  }

  mm.forEach((block, index) => {
    if (usedMm.has(index)) return;
    const kind = peripheralKind(block);
    if (kind) {
      markPeripheral(block, kind);
      return;
    }
    if (VISUAL.has(block.label)) return;
    if (!String(block.text || "").trim()) return;
    pushFlag(block, "mm-only");
    stats.mmOnly += 1;
  });

  text.forEach((source, index) => {
    if (consumedText.has(index)) return;
    if (peripheralKind(source)) return;
    if (!String(source.text || "").trim()) return;
    if (source.label === "formula" || source.label === "figure" || source.label === "table") return;
    const gaps = gapCount(source.text);
    stats.gapsIn += gaps;
    stats.restored += sentences(source.text).length || 1;
    insertBlockByPosition(mm, {
      ...source,
      flag: "restored",
      flags: ["restored"]
    });
  });

  return { blocks: mm, stats };
}

/**
 * How far the multimodal order wanders from the text-layer order.
 * Matched ids are compared. A large inversion count means the page should
 * keep the geometric order instead.
 */
export function readingOrderOff(mmBlocks, textBlocks) {
  const text = (textBlocks || []).filter((block) => block && !peripheralKind(block));
  const indexOf = new Map(text.map((block, index) => [String(block.id || ""), index]));
  const seen = [];
  for (const block of mmBlocks || []) {
    const id = String(block?.id || "");
    if (!indexOf.has(id) || seen.includes(indexOf.get(id))) continue;
    seen.push(indexOf.get(id));
  }
  if (seen.length < 4) return false;
  let inversions = 0;
  for (let i = 0; i < seen.length; i += 1) {
    for (let j = i + 1; j < seen.length; j += 1) {
      if (seen[i] > seen[j]) inversions += 1;
    }
  }
  const pairs = (seen.length * (seen.length - 1)) / 2;
  return inversions > 2 && inversions / pairs > 0.15;
}
