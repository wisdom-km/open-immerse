/** Anchor-segmented alignment of LaTeX units to text-layer blocks. */

import { isTranslatableBlock } from "./pdf-blocks.js";
import { charsetEqual, latexToCharset, pdfTextCharset } from "./formula-charset.js";
import { plainLatexText, prepareFormulaLatex } from "./latex-units.js";

const DEFAULT_LIMITS = {
  ngram: 4,
  maxDpCells: 250000,
  blockRatio: 0.9,
  floatOverlap: 0.6,
  useSourceRatio: 0.85
};

const FLOW_KINDS = new Set(["title", "heading", "paragraph", "item"]);

export function alignSourceToBlocks({ units = [], pages = [], pagesBlocks, limits = {} } = {}) {
  const opts = { ...DEFAULT_LIMITS, ...limits };
  const pageList = normalizePages(pages.length ? pages : pagesBlocks || []);
  const baseHeap = heapUsed();
  let peakHeap = baseHeap;
  const note = () => {
    peakHeap = Math.max(peakHeap, heapUsed());
  };

  const srcWords = [];
  const formulas = [];
  const floats = [];
  for (const unit of units || []) {
    if (unit.kind === "bibliography") continue;
    if (unit.kind === "caption" || unit.kind === "footnote" || unit.kind === "author") {
      floats.push(unit);
      continue;
    }
    if (unit.kind === "display") {
      formulas.push(makeFormula(unit, "display", srcWords.length));
      continue;
    }
    if (!FLOW_KINDS.has(unit.kind)) continue;
    pushUnitWords(unit, srcWords, formulas);
  }
  for (const formula of formulas) {
    formula.before = lastAnchorBefore(srcWords, formula.at);
    formula.after = firstAnchorFrom(srcWords, formula.at);
  }

  const blocks = [];
  pageList.forEach((page) => {
    page.blocks.forEach((block, index) => {
      blocks.push({ ...block, page: page.page, order: blocks.length, localIndex: index, glyphs: page.glyphs });
    });
  });
  const translatable = blocks.filter((block) => isTranslatableBlock(block));
  const firstBlocks = translatable.filter((block) => block.label !== "caption");
  const pdfWords = [];
  for (const block of firstBlocks) {
    const tokens = tokenizeWords(block.text || "");
    tokens.forEach((token, index) => {
      pdfWords.push({ ...token, block, index, pdfIndex: pdfWords.length });
    });
  }

  const pairs = alignSequences(srcWords, pdfWords, opts, note);
  const srcMatch = new Map();
  const pdfMatch = new Set();
  for (const pair of pairs) {
    srcMatch.set(pair.si, pair.pi);
    pdfMatch.add(pair.pi);
  }

  const blockHits = new Map();
  const blockTotals = new Map();
  for (const word of pdfWords) {
    blockTotals.set(word.block.id, (blockTotals.get(word.block.id) || 0) + 1);
    if (pdfMatch.has(word.pdfIndex)) blockHits.set(word.block.id, (blockHits.get(word.block.id) || 0) + 1);
  }

  const usedBlocks = new Set();
  const floatMatches = matchFloats({
    floats,
    units,
    srcWords,
    srcMatch,
    translatable,
    blockHits,
    blockTotals,
    usedBlocks,
    opts
  });

  for (const match of floatMatches) {
    const tokens = tokenizeWords(match.block.text || "");
    const bag = countWords(match.words);
    tokens.forEach((token) => {
      const left = bag.get(token.word) || 0;
      if (!left) return;
      bag.set(token.word, left - 1);
      blockHits.set(match.block.id, (blockHits.get(match.block.id) || 0) + 1);
    });
    blockTotals.set(match.block.id, tokens.length);
  }

  const blockMatches = translatable.map((block) => {
    const total = blockTotals.get(block.id) || tokenizeWords(block.text || "").length;
    const matched = Math.min(total, blockHits.get(block.id) || 0);
    const ratio = total ? matched / total : 0;
    return { blockId: block.id, page: block.page, label: block.label, matched, total, ratio };
  });

  let matchedWords = 0;
  let totalWords = 0;
  let firstPassMatched = 0;
  for (const row of blockMatches) {
    matchedWords += row.matched;
    totalWords += row.total;
  }
  for (const word of pdfWords) {
    if (pdfMatch.has(word.pdfIndex)) firstPassMatched += 1;
  }
  const bodyWords = pdfWords.length;
  const bodyMatched = firstPassMatched;
  const wordRate = bodyWords ? bodyMatched / bodyWords : 0;
  const useSource = wordRate >= opts.useSourceRatio;
  const checked = checkFormulas(formulas, srcWords, srcMatch, blocks, pdfWords, opts.debug === true);
  const report = buildReport({
    units,
    blocks,
    blockMatches,
    floatMatches,
    checked,
    srcWords,
    srcMatch,
    formulas,
    pdfWords
  });
  note();
  return {
    useSource,
    reason: useSource ? "" : "alignment-below-85",
    blockMatches,
    formulas: checked.map((formula) => ({
      ...formula,
      pass: useSource && formula.pass
    })),
    stats: {
      translatableBlocks: blockMatches.length,
      blocksAt90: blockMatches.filter((row) => row.ratio >= opts.blockRatio).length,
      translatableWords: totalWords,
      matchedWords,
      bodyWords,
      bodyMatched,
      wordRate,
      peakHeapDelta: Math.max(0, peakHeap - baseHeap)
    },
    report
  };
}

function makeFormula(unit, kind, at) {
  return {
    unitId: unit.id,
    kind,
    latex: unit.latex || "",
    number: unit.number || null,
    katexOk: unit.katexOk,
    zone: unit.zone || "body",
    at,
    before: 0,
    after: 0
  };
}

function pushUnitWords(unit, srcWords, formulas) {
  const parts = unit.parts?.length ? unit.parts : [{ type: "text", text: unit.text || "" }];
  for (const part of parts) {
    if (part.type === "inline") {
      const at = srcWords.length;
      const words = tokenizeWords(plainLatexText(part.latex || ""));
      for (const token of words) srcWords.push({ ...token, unitId: unit.id, formulaId: part.id });
      formulas.push({
        unitId: part.id,
        kind: "inline",
        latex: part.latex || "",
        number: null,
        katexOk: part.katexOk,
        zone: part.zone || "body",
        at,
        before: lastAnchorBefore(srcWords, at),
        after: srcWords.length
      });
      continue;
    }
    for (const token of tokenizeWords(part.text || "")) {
      srcWords.push({ ...token, unitId: unit.id, formulaId: "" });
    }
  }
}

function lastAnchorBefore(words, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!words[i].formulaId) return i;
  }
  return -1;
}

function firstAnchorFrom(words, index) {
  for (let i = index; i < words.length; i += 1) {
    if (!words[i].formulaId) return i;
  }
  return words.length;
}

function normalizePages(pages) {
  return (pages || []).map((page, index) => ({
    page: Number(page.page || page.pageNumber || index + 1),
    blocks: page.blocks || [],
    glyphs: page.glyphs || []
  })).sort((a, b) => a.page - b.page);
}

function heapUsed() {
  return typeof process !== "undefined" && process.memoryUsage ? process.memoryUsage().heapUsed : 0;
}

export function tokenizeWords(text) {
  const masked = String(text || "")
    .replace(/⟦f\d+⟧/g, (token) => " ".repeat(token.length))
    .replace(/\[[0-9][0-9,\s–—-]*\]/g, (token) => " ".repeat(token.length));
  const words = [];
  let cur = "";
  let start = 0;
  const push = (end) => {
    if (!cur) return;
    words.push({ word: cur, start, end });
    cur = "";
  };
  for (let i = 0; i < masked.length; i += 1) {
    if (isHyphen(masked[i]) && masked[i] !== "\u00AD") {
      // $d_v$-dimensional keeps the word after a short formula prefix.
      // Longer pieces stay joined so a line-break hyphen still spells one word.
      if (cur.length > 0 && cur.length <= 3) push(i);
      continue;
    }
    const folded = foldChar(masked[i]);
    if (folded == null) continue;
    if (!folded) {
      push(i);
      continue;
    }
    if (!cur) start = i;
    cur += folded;
  }
  push(masked.length);
  return words;
}

function isHyphen(ch) {
  return /[\u00AD\u2010\u2011\u2012\u2013\u2014\u2015-]/.test(ch);
}

function foldChar(ch) {
  if (isHyphen(ch)) return null;
  if (/\s/.test(ch)) return "";
  let value = ch;
  if (value === "Ł" || value === "ł") value = "l";
  else if (value === "Ø" || value === "ø") value = "o";
  else if (value === "Đ" || value === "đ") value = "d";
  else if (value === "Æ" || value === "æ") value = "ae";
  else if (value === "Œ" || value === "œ") value = "oe";
  else if (value === "ß") value = "ss";
  value = value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const letters = value.replace(/[^a-z0-9]/g, "");
  return letters;
}

function alignSequences(srcWords, pdfWords, opts, note) {
  const n = Math.max(2, opts.ngram || 4);
  const anchors = uniqueAnchors(srcWords, pdfWords, n);
  const pairs = [];
  let s0 = 0;
  let p0 = 0;
  const cuts = anchors.concat([{ si: srcWords.length, pi: pdfWords.length, n: 0 }]);
  for (const cut of cuts) {
    pairs.push(...lcsRange(srcWords, pdfWords, s0, cut.si, p0, cut.pi, opts, note));
    for (let step = 0; step < cut.n; step += 1) {
      pairs.push({ si: cut.si + step, pi: cut.pi + step });
    }
    s0 = cut.si + cut.n;
    p0 = cut.pi + cut.n;
  }
  note();
  return pairs;
}

function uniqueAnchors(srcWords, pdfWords, n) {
  const srcMap = ngramIndex(srcWords, n);
  const pdfMap = ngramIndex(pdfWords, n);
  const found = [];
  for (const [key, srcAt] of srcMap) {
    if (srcAt.length !== 1) continue;
    const pdfAt = pdfMap.get(key);
    if (!pdfAt || pdfAt.length !== 1) continue;
    found.push({ si: srcAt[0], pi: pdfAt[0], n });
  }
  found.sort((a, b) => a.si - b.si || a.pi - b.pi);
  const kept = [];
  let lastS = -1;
  let lastP = -1;
  for (const item of found) {
    if (item.si < lastS + n || item.pi < lastP + n) continue;
    kept.push(item);
    lastS = item.si;
    lastP = item.pi;
  }
  return kept;
}

function ngramIndex(words, n) {
  const map = new Map();
  for (let i = 0; i + n <= words.length; i += 1) {
    const key = words.slice(i, i + n).map((word) => word.word).join("\u0000");
    const list = map.get(key);
    if (list) list.push(i);
    else map.set(key, [i]);
  }
  return map;
}

function lcsRange(srcWords, pdfWords, s0, s1, p0, p1, opts, note) {
  const a = srcWords.slice(s0, s1);
  const b = pdfWords.slice(p0, p1);
  if (!a.length || !b.length) return [];
  if (a.length * b.length > opts.maxDpCells) return greedyRange(a, b, s0, p0);
  const n = a.length;
  const m = b.length;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (a[i - 1].word === b[j - 1].word) dp[at(i, j)] = dp[at(i - 1, j - 1)] + 1;
      else dp[at(i, j)] = Math.max(dp[at(i - 1, j)], dp[at(i, j - 1)]);
    }
  }
  note();
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1].word === b[j - 1].word && dp[at(i, j)] === dp[at(i - 1, j - 1)] + 1) {
      pairs.push({ si: s0 + i - 1, pi: p0 + j - 1 });
      i -= 1;
      j -= 1;
    } else if (dp[at(i - 1, j)] >= dp[at(i, j - 1)]) i -= 1;
    else j -= 1;
  }
  pairs.reverse();
  return pairs;
}

function greedyRange(a, b, s0, p0) {
  const pairs = [];
  let j = 0;
  for (let i = 0; i < a.length; i += 1) {
    while (j < b.length && b[j].word !== a[i].word) j += 1;
    if (j >= b.length) break;
    pairs.push({ si: s0 + i, pi: p0 + j });
    j += 1;
  }
  return pairs;
}

function countWords(words) {
  const bag = new Map();
  for (const word of words) bag.set(word, (bag.get(word) || 0) + 1);
  return bag;
}

function wordList(unit) {
  const words = [];
  if (unit.kind === "caption") {
    const prefix = String(unit.text || "").split(":")[0];
    words.push(...tokenizeWords(prefix).map((token) => token.word));
  }
  if (unit.parts?.length) {
    for (const part of unit.parts) {
      const source = part.type === "inline" ? plainLatexText(part.latex || "") : part.text || "";
      words.push(...tokenizeWords(source).map((token) => token.word));
    }
    return words;
  }
  if (words.length) return words;
  return tokenizeWords(unit.text || "").map((token) => token.word);
}

function dice(a, b) {
  if (!a.length || !b.length) return 0;
  const bag = countWords(a);
  let hit = 0;
  for (const word of b) {
    const left = bag.get(word) || 0;
    if (!left) continue;
    bag.set(word, left - 1);
    hit += 1;
  }
  return (2 * hit) / (a.length + b.length);
}

function matchFloats({ floats, units, srcWords, srcMatch, translatable, blockHits, blockTotals, usedBlocks, opts }) {
  const pool = translatable.filter((block) => {
    const total = blockTotals.get(block.id) || 0;
    const hit = blockHits.get(block.id) || 0;
    const ratio = total ? hit / total : 0;
    return block.label === "caption" || ratio < opts.floatOverlap;
  });
  const extras = (units || []).filter((unit) => FLOW_KINDS.has(unit.kind) && coverage(unit, srcWords, srcMatch) < opts.floatOverlap);
  const queue = [...floats, ...extras];
  const matches = [];
  for (const unit of queue) {
    const words = wordList(unit);
    let best = null;
    let bestScore = opts.floatOverlap;
    for (const block of pool) {
      if (usedBlocks.has(block.id)) continue;
      const score = dice(words, tokenizeWords(block.text || "").map((token) => token.word));
      if (score >= bestScore) {
        bestScore = score;
        best = block;
      }
    }
    if (!best) continue;
    usedBlocks.add(best.id);
    matches.push({ unit, block: best, score: bestScore, words });
  }
  return matches;
}

function coverage(unit, srcWords, srcMatch) {
  const indexes = [];
  srcWords.forEach((word, index) => {
    if (word.unitId === unit.id && !word.formulaId) indexes.push(index);
  });
  if (!indexes.length) return 0;
  const hit = indexes.filter((index) => srcMatch.has(index)).length;
  return hit / indexes.length;
}

function checkFormulas(formulas, srcWords, srcMatch, blocks, pdfWords, debug = false) {
  const groups = groupFormulas(formulas, srcWords);
  const results = [];
  for (const group of groups) {
    const located = locateGroup(group, srcWords, srcMatch, pdfWords, blocks);
    const latex = group.map((formula) => formula.latex).join(" ");
    const prepared = prepareFormulaLatex(latex, group.some((formula) => formula.kind === "display"));
    const rendered = latexToCharset(prepared);
    const regionText = suppressUnsharedPunct(located.text, rendered.chars);
    const pdfChars = pdfTextCharset(regionText);
    const charsOk = !rendered.unknownCommands.length && charsetEqual(rendered, pdfChars);
    const displayBlock = (located.blocks || []).find((block) => block.label === "formula" && block.display !== false && block.display !== undefined
      ? block.display === true
      : block.label === "formula" && block.display === true);
    for (const formula of group) {
      const host = formula.kind === "display"
        ? (located.blocks || []).find((block) => block.label === "formula" && block.display === true) || displayBlock
        : (located.blocks || []).find((block) => block.label === "formula" && block.display === false) || null;
      const position = formula.kind === "display" ? Boolean(host) : located.position;
      const number = numberCheck(formula, host);
      const render = formula.katexOk !== false;
      const chars = position && charsOk;
      const row = {
        unitId: formula.unitId,
        kind: formula.kind,
        zone: formula.zone,
        latex: formula.latex,
        number: formula.number,
        page: host?.page || located.page || null,
        bid: host?.id || located.bid || "",
        checks: { position, chars, number, render },
        pass: position && chars && number && render
      };
      if (debug) {
        row.latex = formula.latex;
        row.groupLatex = latex;
        row.pdfText = regionText || "";
        row.onlyLatex = [...rendered.chars].filter((ch) => !pdfChars.chars.has(ch)).join("");
        row.onlyPdf = [...pdfChars.chars].filter((ch) => !rendered.chars.has(ch)).join("");
        row.unknown = rendered.unknownCommands;
        row.groupSize = group.length;
        row.anchor = located.anchor || "";
      }
      results.push(row);
    }
  }
  return results;
}

function groupFormulas(formulas, srcWords) {
  const groups = [];
  let current = [];
  const anchorBetween = (left, right) => {
    for (let i = left; i < right; i += 1) {
      if (srcWords[i] && !srcWords[i].formulaId) return true;
    }
    return false;
  };
  for (const formula of formulas) {
    const prev = current[current.length - 1];
    if (prev && anchorBetween(prev.at, formula.at)) {
      groups.push(current);
      current = [];
    }
    current.push(formula);
  }
  if (current.length) groups.push(current);
  return groups;
}

function locateGroup(group, srcWords, srcMatch, pdfWords, blocks) {
  const before = group[0].before;
  const after = group[group.length - 1].after;
  const left = before >= 0 ? srcMatch.get(before) : undefined;
  const right = after < srcWords.length ? srcMatch.get(after) : undefined;
  const anchor = `${srcWords[before]?.word || "∅"}→${left == null ? "miss" : srcWords[before]?.word}/${pdfWords[left]?.word}@${pdfWords[left]?.block?.id}:${pdfWords[left]?.index} | ${srcWords[after]?.word || "∅"}→${right == null ? "miss" : pdfWords[right]?.word}@${pdfWords[right]?.block?.id}:${pdfWords[right]?.index}`;
  if (left == null || right == null) return { position: false, text: "", blocks: [], anchor };
  const a = pdfWords[left];
  const b = pdfWords[right];
  if (!a || !b) return { position: false, text: "", blocks: [], anchor };
  if (a.block.id === b.block.id && b.index > a.index) {
    const slice = String(a.block.text || "").slice(a.end, b.start);
    const referenced = placeholdersInSlice(slice, a.block, blocks);
    return {
      position: formulaSignal(slice, referenced),
      text: charsetText(slice, referenced),
      blocks: referenced,
      page: a.block.page,
      bid: referenced[0]?.id || a.block.id,
      anchor
    };
  }
  const suffix = String(a.block.text || "").slice(a.end);
  const prefix = String(b.block.text || "").slice(0, b.start);
  const between = formulaBlocksInSpan(a, b, blocks);
  const referenced = dedupeBlocks([
    ...between,
    ...placeholdersInSlice(suffix, a.block, blocks),
    ...placeholdersInSlice(prefix, b.block, blocks)
  ]);
  const slice = `${suffix}\n${prefix}`;
  return {
    position: formulaSignal(slice, referenced),
    text: charsetText(slice, referenced),
    blocks: referenced,
    page: referenced[0]?.page || a.block.page,
    bid: referenced[0]?.id || "",
    anchor
  };
}

const NOISE_PUNCT = new Set([",", ".", ";", ":", "(", ")", "[", "]", "-"]);

function suppressUnsharedPunct(text, latexChars) {
  const stripped = String(text || "").replace(/\[[0-9][0-9,\s–—-]*\]/g, " ");
  let out = "";
  for (const ch of stripped) {
    if (NOISE_PUNCT.has(ch) && !latexChars.has(ch)) continue;
    out += ch;
  }
  return out;
}

function formulaSignal(slice, referenced) {
  if (referenced.length) return true;
  return /[A-Za-z0-9]/.test(String(slice || "").replace(/⟦f\d+⟧/g, " "));
}

function placeholdersInSlice(slice, host, blocks) {
  const tokens = [...String(slice || "").matchAll(/⟦f\d+⟧/g)].map((match) => match[0]);
  if (!tokens.length) return [];
  const wanted = new Set(tokens);
  return blocks.filter((block) => (host?.placeholders || []).some((entry) => wanted.has(entry.token) && entry.blockId === block.id));
}

function formulaBlocksInSpan(left, right, blocks) {
  return blocks.filter((block) => {
    if (block.label !== "formula") return false;
    if (block.order <= left.block.order || block.order >= right.block.order) return false;
    if (placeholderBeforeAnchor(left, block)) return false;
    if (placeholderAfterAnchor(right, block)) return false;
    return true;
  });
}

function placeholderBeforeAnchor(anchor, block) {
  if (block.inlineOf !== anchor.block.id) return false;
  const at = placeholderAt(anchor.block, block.id);
  return at >= 0 && at < anchor.end;
}

function placeholderAfterAnchor(anchor, block) {
  if (block.inlineOf !== anchor.block.id) return false;
  const at = placeholderAt(anchor.block, block.id);
  return at >= 0 && at >= anchor.start;
}

function placeholderAt(host, blockId) {
  const entry = (host.placeholders || []).find((item) => item.blockId === blockId);
  if (!entry) return -1;
  return String(host.text || "").indexOf(entry.token);
}

function dedupeBlocks(list) {
  const seen = new Set();
  const out = [];
  for (const block of list) {
    if (!block || seen.has(block.id)) continue;
    seen.add(block.id);
    out.push(block);
  }
  return out;
}

function charsetText(slice, formulaBlocks) {
  const prose = String(slice || "").replace(/⟦f\d+⟧/g, " ");
  const glyphs = [];
  for (const block of formulaBlocks || []) {
    const label = String(block.eqLabel || "");
    const inside = (block.glyphs || []).filter((glyph) => centerIn(glyph.bbox, block.bbox));
    const kept = label ? dropEdgeLabel(inside, label) : inside;
    for (const glyph of kept) glyphs.push(glyph.str || "");
  }
  const combined = `${prose} ${glyphs.join(" ")}`;
  const trimmed = combined.replace(/^[\s,.;:]+/, "").replace(/[\s,.;:]+$/, "");
  return trimmed.replace(/[_^{}~]/g, "");
}

function centerIn(glyphBox, blockBox) {
  if (!glyphBox || !blockBox || glyphBox.length < 4 || blockBox.length < 4) return false;
  const cx = (Number(glyphBox[0]) + Number(glyphBox[2])) / 2;
  const cy = (Number(glyphBox[1]) + Number(glyphBox[3])) / 2;
  return cx >= blockBox[0] && cx <= blockBox[2] && cy >= blockBox[1] && cy <= blockBox[3];
}

function dropEdgeLabel(glyphs, label) {
  const wanted = label.replace(/\s+/g, "");
  const ordered = glyphs.slice().sort((a, b) => (a.bbox?.[0] || 0) - (b.bbox?.[0] || 0));
  let acc = "";
  const drop = [];
  for (let i = ordered.length - 1; i >= 0 && acc.length < wanted.length + 2; i -= 1) {
    drop.push(ordered[i]);
    acc = `${ordered[i].str || ""}${acc}`.replace(/\s+/g, "");
    if (acc.endsWith(wanted) || acc === wanted) {
      const gone = new Set(drop);
      return ordered.filter((glyph) => !gone.has(glyph));
    }
  }
  return ordered;
}

function numberCheck(formula, block) {
  if (formula.kind !== "display") return true;
  const label = String(block?.eqLabel || "").replace(/[()]/g, "").trim();
  if (!formula.number) return !label;
  return label === String(formula.number);
}

function buildReport({ units, blocks, floatMatches, checked, srcWords, srcMatch, formulas, pdfWords }) {
  const issues = [];
  const textOf = (block) => tokenizeWords(block.text || "").map((token) => token.word);
  for (const unit of units || []) {
    if (unit.kind !== "heading" || !unit.section) continue;
    const words = tokenizeWords(unit.text || "").map((token) => token.word);
    const anywhere = blocks.some((block) => dice(words, textOf(block)) >= 0.45);
    if (anywhere) continue;
    const page = inferHeadingPage(unit, units, floatMatches, blocks);
    const figure = blocks.find((block) => block.page === page && block.label === "figure");
    if (!figure) continue;
    issues.push({
      kind: "heading-swallowed-by-figure",
      page,
      blockId: figure.id,
      heading: unit.title || unit.text
    });
  }
  for (const match of floatMatches) {
    if (match.unit.kind === "paragraph" && match.block.label === "caption") {
      issues.push({
        kind: "paragraph-labeled-caption",
        page: match.block.page,
        blockId: match.block.id,
        text: String(match.unit.text || "").slice(0, 160)
      });
    }
  }
  const swallowed = swallowedFormulaBlocks({ formulas, checked, srcWords, srcMatch, pdfWords, blocks });
  for (const block of swallowed) {
    issues.push({
      kind: "formula-swallowed-prose",
      page: block.page,
      blockId: block.id,
      text: "inline formula box swallowed neighboring prose"
    });
  }
  return { issues };
}

function inferHeadingPage(unit, units, floatMatches, blocks) {
  const index = units.indexOf(unit);
  for (let i = index + 1; i < units.length && i < index + 6; i += 1) {
    const next = units[i];
    const match = floatMatches.find((item) => item.unit === next);
    if (match) return match.block.page;
  }
  const words = tokenizeWords(unit.text || "").map((token) => token.word);
  let best = null;
  for (const block of blocks) {
    if (block.label === "figure" || block.label === "formula") continue;
    const score = dice(words, tokenizeWords(block.text || "").map((token) => token.word));
    if (!best || score > best.score) best = { score, page: block.page };
  }
  return best?.page || null;
}

function swallowedFormulaBlocks({ formulas, checked, srcWords, srcMatch, pdfWords, blocks }) {
  const missed = (formulas || []).filter((formula, index) => {
    const row = checked[index];
    return formula.kind === "inline" && formula.zone === "body" && row && !row.checks.position;
  });
  const found = new Map();
  for (let i = 0; i < missed.length; i += 1) {
    let j = i;
    while (j + 1 < missed.length && proseGap(srcWords, missed[j].after, missed[j + 1].at) <= 6
      && unmatchedWords(srcWords, srcMatch, missed[j].after, missed[j + 1].at).length) {
      j += 1;
    }
    if (j === i) continue;
    const left = nearestMatched(srcWords, srcMatch, missed[i].at, -1);
    const right = nearestMatched(srcWords, srcMatch, missed[j].after, 1);
    const a = left == null ? null : pdfWords[srcMatch.get(left)];
    const b = right == null ? null : pdfWords[srcMatch.get(right)];
    if (!a || !b || a.block.id !== b.block.id || b.index <= a.index) {
      i = j;
      continue;
    }
    const slice = String(a.block.text || "").slice(a.end, b.start);
    const hosts = placeholdersInSlice(slice, a.block, blocks);
    const gap = unmatchedWords(srcWords, srcMatch, missed[i].at, missed[j].after);
    const hidden = gap.filter((word) => !slice.toLowerCase().includes(word));
    if (hidden.length && hosts.length) {
      for (const host of hosts) found.set(host.id, host);
    }
    i = j;
  }
  return [...found.values()];
}

function proseGap(srcWords, from, to) {
  let count = 0;
  for (let i = from; i < to; i += 1) {
    if (srcWords[i] && !srcWords[i].formulaId) count += 1;
  }
  return count;
}

function unmatchedWords(srcWords, srcMatch, from, to) {
  const words = [];
  for (let i = from; i < to; i += 1) {
    const word = srcWords[i];
    if (!word || word.formulaId || srcMatch.has(i)) continue;
    words.push(word.word);
  }
  return words;
}

function nearestMatched(srcWords, srcMatch, index, dir) {
  for (let i = dir < 0 ? index - 1 : index; dir < 0 ? i >= 0 : i < srcWords.length; i += dir) {
    if (srcWords[i]?.formulaId) continue;
    if (srcMatch.has(i)) return i;
  }
  return null;
}
