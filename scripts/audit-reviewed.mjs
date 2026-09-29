/**
 * Read-only audit of reviewed formula labels against the M1 rules.
 *
 *   node scripts/audit-reviewed.mjs [--limit N] [--out reports/audit.md]
 *
 * The queue is labels/review-set.json, the same list
 * scripts/review-set.mjs writes with buildReviewSet. Nothing here talks
 * to the review server, and nothing here writes labels/reviewed or
 * labels/prelabel. A missing reviewed page falls back to the prelabel
 * so a skipped unit can still be checked.
 *
 * Default window: every queue unit up to and including the last one
 * whose original unit id is in that page's reviewedUnitIds. --limit N
 * checks the first N queue units instead.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMathSymbolFont, pageColumnCut, proseTextWords, selectionForReviewUnit } from "../lib/review-actions.js";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");

// A text subscript is shorter than the other glyphs in its formula.
// 0.8 matches the merge guard: a 6pt "sites" under a 9pt operator.
const SUBSCRIPT_HEIGHT_RATIO = 0.8;

// Italic and bold-math symbol names (SVX, Ky, Up, dA) are not prose.
// *.I, *-It, Italic, and *.B. Longer than the old 3-letter product cutoff.
const ITALIC_SYMBOL_MAX_LETTERS = 4;

// A raised digit this much shorter than the line is a superscript, not an equation number.
const SUPERSCRIPT_HEIGHT_RATIO = 0.75;

// Two baselines farther apart than about 1.5 glyph heights are separate
// display lines. Fraction bars and tall delimiters tie clusters first.
const DISPLAY_LINE_GAP_RATIO = 1.5;

// Superscripts and subscripts stay on the base line when their centers
// are within about one glyph height of it.
const SAME_LINE_CENTER_RATIO = 0.85;

// A fraction bar is much flatter than a letter. One between two clusters
// means those clusters are one fraction, not two display lines.
const FRACTION_BAR_HEIGHT_RATIO = 0.25;

// Big braces and integrals are taller than a letter and narrower than
// they are tall. A cluster pair they cross is still one formula.
const TALL_GLYPH_HEIGHT_RATIO = 1.8;

// "Touching" for a missed merge: horizontal gap under about 0.3 glyph heights.
const TOUCH_GAP_RATIO = 0.3;

// Each side of a cross-line report needs several glyphs, so one stray
// subscript does not look like a second display line.
const MIN_GLYPHS_PER_LINE = 2;

// Short symbol runs such as ") = ln(1 +" can still belong to the formula.
// A longer text run is left to the prose check.
const SHORT_ATTACH_MAX_CHARS = 24;

const RULES = [
  ["R9", 1, "编号标记误用"],
  ["R8", 1, "公式和 units 对不上"],
  ["R1", 2, "公式单元里混进正文"],
  ["R4", 3, "看起来应是正文的公式"],
  ["R2", 4, "行间单元跨行"],
  ["R3", 5, "公式编号不在行间单元里"],
  ["R6", 6, "行间或行内类型不对"],
  ["R10", 7, "同一行漏合了公式"],
  ["R5", 8, "紧贴公式却没合并"],
  ["R7", 9, "标点归错了单元"],
  ["R0", 10, "队列里还没确认"]
];

const SEVERITY = new Map(RULES.map(([rule, severity]) => [rule, severity]));
const RULE_TITLE = new Map(RULES.map(([rule, , title]) => [rule, title]));

const MATH_ITALIC_FONT = /\.I(?:\+[^.]*)?$/i;
const AUDIT_SYMBOL_FONT = /-It|\.I(?:\+[^.]*)?$|Italic|\.B(?:\+[^.]*)?$/i;
const FULL_EQ_NUMBER = /^\(\d+(?:\.\d+)?[a-z]?\)$/;
const BARE_EQ_NUMBER = /^\d{1,3}(?:\.\d+)?[a-z]?$/;

function confirmKey(unit) {
  return `${unit.paperId}:${unit.page}:${unit.unitId}`;
}

export function selectAuditWindow(queue, confirmedKeys, limit) {
  const list = Array.isArray(queue) ? queue : [];
  const confirmed = confirmedKeys instanceof Set ? confirmedKeys : new Set(confirmedKeys || []);
  let end = list.length;
  if (Number.isInteger(limit) && limit >= 0) end = Math.min(limit, list.length);
  else {
    let last = -1;
    list.forEach((unit, index) => {
      if (confirmed.has(confirmKey(unit))) last = index;
    });
    end = last + 1;
  }
  return list.slice(0, end).map((unit, index) => ({
    unit,
    queueIndex: index + 1,
    confirmed: confirmed.has(confirmKey(unit))
  }));
}

function boxHeight(element) {
  const box = element?.bbox;
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.max(0, Number(box[3]) - Number(box[1]));
}

function boxWidth(element) {
  const box = element?.bbox;
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.max(0, Number(box[2]) - Number(box[0]));
}

function midY(element) {
  const box = element.bbox;
  return (Number(box[1]) + Number(box[3])) / 2;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function isLetterGlyph(element) {
  const kind = element?.kind || "glyph";
  return kind === "glyph" && boxWidth(element) > 0 && boxHeight(element) > 0.4;
}

function isMathItalicFont(font) {
  const name = String(font || "");
  return MATH_ITALIC_FONT.test(name) || /Italic/i.test(name);
}

function isBodyFont(font) {
  if (!font) return false;
  if (isMathSymbolFont(font)) return false;
  if (isMathItalicFont(font)) return false;
  return true;
}

function snap(element) {
  if (!element) return null;
  return {
    id: element.id || "",
    char: element.char ?? "",
    font: element.font || "",
    label: element.label || "",
    bbox: Array.isArray(element.bbox) ? element.bbox.slice(0, 4).map(Number) : []
  };
}

function unionBox(elements) {
  const boxes = elements.map((element) => element.bbox).filter((box) => Array.isArray(box) && box.length >= 4);
  if (!boxes.length) return [0, 0, 0, 0];
  return [
    Math.min(...boxes.map((box) => Number(box[0]))),
    Math.min(...boxes.map((box) => Number(box[1]))),
    Math.max(...boxes.map((box) => Number(box[2]))),
    Math.max(...boxes.map((box) => Number(box[3])))
  ];
}

function horizontalGap(a, b) {
  const left = Array.isArray(a) ? a : a.bbox;
  const right = Array.isArray(b) ? b : b.bbox;
  if (left[2] < right[0]) return right[0] - left[2];
  if (right[2] < left[0]) return left[0] - right[2];
  return 0;
}

function glyphHeight(elements) {
  const heights = elements.filter(isLetterGlyph).map(boxHeight);
  return median(heights) || 8;
}

function sameLine(element, box, height) {
  if (!element?.bbox || !box) return false;
  const mid = midY(element);
  const other = (Number(box[1]) + Number(box[3])) / 2;
  return Math.abs(mid - other) <= SAME_LINE_CENTER_RATIO * height;
}

/**
 * Words that are still prose inside a formula element. Math-symbol fonts,
 * operator names, ligature junk, subscripts, and short italic products
 * are not. The both-sides merge exception is not used here: inside an
 * already merged unit it would hide a real word.
 */
function isAuditSymbolFont(font) {
  return AUDIT_SYMBOL_FONT.test(String(font || ""));
}

function shortSymbolToken(char) {
  return String(char || "").trim().replace(/[,;:]$/, "");
}

const DISPLAY_CONNECTIVE = /^(?:where|and|with|for|if|or|let|then|when|of|to|by|as|a|an|the)$/i;

/** where / and / with, and the same one- or two-word connective beside a display row. */
function isDisplayConnective(element) {
  const words = proseTextWords(element?.char);
  return words.length > 0 && words.length <= 2 && words.every((word) => DISPLAY_CONNECTIVE.test(word));
}

function fontPointSize(font) {
  const sizes = [...String(font || "").matchAll(/(?:^|[^0-9])(\d{1,2})(?![0-9])/g)].map((match) => Number(match[1]));
  return sizes.find((size) => size >= 5 && size <= 14) || 0;
}

function isRomanTextFont(font) {
  const name = String(font || "");
  if (/italic|math|symbol|\.I\b|-It/i.test(name)) return false;
  return /roman|cmr\d|nimbusrom|minionpro-reg/i.test(name);
}

/**
 * A short roman token set in a smaller point size and shifted off the
 * neighbor's center is a sub/superscript (E_cm), not a prose word.
 */
function isSmallerRomanScript(element, members) {
  const size = fontPointSize(element?.font);
  const text = String(element?.char || "").trim();
  if (!size || !isRomanTextFont(element?.font) || text.length > 6 || !element?.bbox) return false;
  const neighbors = (members || []).filter((item) => item && item !== element && item.id !== element.id && isLetterGlyph(item) && fontPointSize(item.font) >= size + 1
    && horizontalGap(item.bbox, element.bbox) <= Math.max(boxHeight(item), 8));
  if (!neighbors.length) return false;
  const anchor = neighbors.slice().sort((a, b) => horizontalGap(a.bbox, element.bbox) - horizontalGap(b.bbox, element.bbox))[0];
  return Math.abs(midY(element) - midY(anchor)) >= 0.12 * boxHeight(anchor);
}

/** a.e. on, if, for all, et, and, and the same kind of ≤3-word qualifier. */
export function isShortFormulaQualifier(char) {
  const compact = String(char || "").trim().replace(/^[−–-]\s*/, "").replace(/\s+/g, " ");
  if (!compact) return false;
  if (compact.split(" ").length > 3) return false;
  return /^(?:a\.e\.(?: on)?|for all|if|et|and|i\.e\.|e\.g\.|etc\.)$/i.test(compact);
}

function isItalicSubscriptName(element) {
  if (!isAuditSymbolFont(element?.font)) return false;
  return /^(?:rise|decay)$/i.test(shortSymbolToken(element.char));
}

export function formulaProseWords(element, members) {
  if (!element || isMathSymbolFont(element.font)) return [];
  const words = proseTextWords(element.char);
  if (!words.length) return [];
  const token = shortSymbolToken(element.char);
  if (
    isAuditSymbolFont(element.font)
    && token.length <= ITALIC_SYMBOL_MAX_LETTERS
    && /^[A-Za-z]+$/.test(token)
  ) return [];
  if (isItalicSubscriptName(element)) return [];
  if (isShortFormulaQualifier(element.char)) return [];
  if (isSmallerRomanScript(element, members)) return [];
  const others = (members || []).filter((item) => item && item !== element && item.id !== element.id && isLetterGlyph(item));
  const mid = median(others.map(boxHeight));
  const height = boxHeight(element);
  if (mid > 0 && height > 0 && height < SUBSCRIPT_HEIGHT_RATIO * mid) return [];
  return words;
}

function clusterGlyphs(glyphs, height) {
  const sorted = glyphs.filter(isLetterGlyph).slice().sort((a, b) => midY(a) - midY(b) || a.bbox[0] - b.bbox[0]);
  const lines = [];
  for (const glyph of sorted) {
    const previous = lines[lines.length - 1];
    const overlap = previous
      ? Math.min(previous.bottom, glyph.bbox[3]) - Math.max(previous.top, glyph.bbox[1])
      : 0;
    const close = previous && (
      Math.abs(midY(glyph) - previous.mid) <= SAME_LINE_CENTER_RATIO * height
      || overlap >= 0.3 * Math.min(boxHeight(glyph), previous.bottom - previous.top)
    );
    if (!close) {
      lines.push({
        glyphs: [glyph],
        mid: midY(glyph),
        top: glyph.bbox[1],
        bottom: glyph.bbox[3]
      });
      continue;
    }
    previous.glyphs.push(glyph);
    previous.top = Math.min(previous.top, glyph.bbox[1]);
    previous.bottom = Math.max(previous.bottom, glyph.bbox[3]);
    previous.mid = median(previous.glyphs.map(midY));
  }
  return lines;
}

function isFractionBar(element, height) {
  const h = boxHeight(element);
  const w = boxWidth(element);
  const flat = h > 0 && h <= Math.max(1.2, FRACTION_BAR_HEIGHT_RATIO * height) && w >= Math.max(4, h * 3);
  if (!flat) return false;
  return element.kind === "path" || element.label === "other" || element.char === "" || element.char === "−" || element.char === "-";
}

function isTallDelimiter(element, height) {
  const h = boxHeight(element);
  const w = boxWidth(element);
  return h >= TALL_GLYPH_HEIGHT_RATIO * height && w > 0 && w < h;
}

function mergeLineGroups(lines, extras, height) {
  const parent = lines.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    return cursor;
  };
  const unite = (left, right) => {
    parent[find(left)] = find(right);
  };
  for (const extra of extras) {
    if (isTallDelimiter(extra, height)) {
      const hit = lines.map((line, index) => (extra.bbox[3] >= line.top - 1 && extra.bbox[1] <= line.bottom + 1 ? index : -1)).filter((index) => index >= 0);
      for (let i = 1; i < hit.length; i += 1) unite(hit[0], hit[i]);
    }
    if (isFractionBar(extra, height)) {
      const above = lines.filter((line) => line.bottom <= extra.bbox[1] + 1);
      const below = lines.filter((line) => line.top >= extra.bbox[3] - 1);
      const barLeft = extra.bbox[0];
      const barRight = extra.bbox[2];
      const covers = (line) => {
        const left = Math.min(...line.glyphs.map((glyph) => glyph.bbox[0]));
        const right = Math.max(...line.glyphs.map((glyph) => glyph.bbox[2]));
        return Math.min(barRight, right) - Math.max(barLeft, left) > 0;
      };
      const up = above.filter(covers).sort((a, b) => b.bottom - a.bottom)[0];
      const down = below.filter(covers).sort((a, b) => a.top - b.top)[0];
      if (up && down) unite(lines.indexOf(up), lines.indexOf(down));
    }
  }
  const groups = new Map();
  lines.forEach((line, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(line);
  });
  return [...groups.values()].map((group) => ({
    glyphs: group.flatMap((line) => line.glyphs),
    top: Math.min(...group.map((line) => line.top)),
    bottom: Math.max(...group.map((line) => line.bottom)),
    mid: median(group.flatMap((line) => line.glyphs.map(midY)))
  })).sort((a, b) => a.top - b.top);
}

export function displayLineGroups(members) {
  const glyphs = members.filter(isLetterGlyph);
  const height = glyphHeight(glyphs);
  const lines = clusterGlyphs(glyphs, height);
  const extras = members.filter((element) => isTallDelimiter(element, height) || isFractionBar(element, height));
  return { groups: mergeLineGroups(lines, extras, height), height };
}

function referenceGlyphHeight(glyphs) {
  const heights = glyphs.filter((glyph) => isLetterGlyph(glyph) && String(glyph.char || "").trim())
    .map(boxHeight)
    .filter((value) => value >= 4)
    .sort((a, b) => a - b);
  if (!heights.length) return glyphHeight(glyphs);
  const mid = median(heights);
  const capped = heights.filter((value) => value <= mid * 1.6);
  const sample = capped.length ? capped : heights;
  return sample[Math.min(sample.length - 1, Math.floor(sample.length * 0.85))] || mid;
}

/**
 * Display rows that each carry their own formula. A growing box glues the
 * next equation on, so rows are split on a frozen center. Fraction bars and
 * tall delimiters still join one formula. A lone (n) on its own row, a
 * fence, or a short subscript does not count as another formula.
 */
function separateDisplayRows(members) {
  const height = referenceGlyphHeight(members);
  const body = members.filter((glyph) => isLetterGlyph(glyph) && !isFencePiece(glyph) && boxHeight(glyph) >= 0.82 * height);
  const seeds = body.length ? body : members.filter((glyph) => isLetterGlyph(glyph) && !isFencePiece(glyph));
  const limit = Math.max(4, 0.5 * height);
  const lines = [];
  for (const glyph of seeds.slice().sort((a, b) => midY(a) - midY(b) || a.bbox[0] - b.bbox[0])) {
    const y = midY(glyph);
    const current = lines.find((line) => Math.abs(y - line.anchor) <= limit);
    if (!current) {
      lines.push({ glyphs: [glyph], anchor: y, top: glyph.bbox[1], bottom: glyph.bbox[3] });
      continue;
    }
    current.glyphs.push(glyph);
    current.top = Math.min(current.top, glyph.bbox[1]);
    current.bottom = Math.max(current.bottom, glyph.bbox[3]);
  }
  // A lone (n) sits between two formula rows and its box clips both.
  // It must not glue those rows into one formula.
  const formulaLines = lines.filter((line) => !isEquationNumberBlock(line.glyphs));
  const parent = formulaLines.map((_, index) => index);
  const find = (index) => {
    let cursor = index;
    while (parent[cursor] !== cursor) cursor = parent[cursor];
    return cursor;
  };
  const unite = (left, right) => {
    parent[find(left)] = find(right);
  };
  for (let left = 0; left < formulaLines.length; left += 1) {
    for (let right = left + 1; right < formulaLines.length; right += 1) {
      const overlap = Math.min(formulaLines[left].bottom, formulaLines[right].bottom) - Math.max(formulaLines[left].top, formulaLines[right].top);
      if (overlap > 0.5) unite(left, right);
    }
  }
  const overlapped = new Map();
  formulaLines.forEach((line, index) => {
    const root = find(index);
    const group = overlapped.get(root) || { glyphs: [], top: line.top, bottom: line.bottom };
    group.glyphs.push(...line.glyphs);
    group.top = Math.min(group.top, line.top);
    group.bottom = Math.max(group.bottom, line.bottom);
    overlapped.set(root, group);
  });
  const extras = members.filter((element) => isTallDelimiter(element, height) || isFractionBar(element, height));
  return mergeLineGroups([...overlapped.values()], extras, height).filter((group) => {
    const glyphs = group.glyphs.filter((glyph) => !isFencePiece(glyph));
    if (glyphs.length < MIN_GLYPHS_PER_LINE) return false;
    return !isEquationNumberBlock(glyphs);
  });
}

function operatorText(element) {
  const text = String(element?.char || "").trim();
  if (!text || [...text].length > 2) return "";
  return text;
}

// × · + − continue the same product or sum. = ≡ and other relations start a
// new line of the same formula only when the row above has no equation number.
function expressionOperator(element) {
  return /^[++\-−–—×✕⋅·∙∗*±∓⊕⊗⊖⊙∧∨∩∪∘]$/u.test(operatorText(element));
}

function equalityOperator(element) {
  return /^[=≡≈≠≤≥<>≃≅≍≔≕≜≝≐∼∽∝]$/u.test(operatorText(element));
}

function wrapBracketKind(element) {
  const text = String(element?.char || "");
  const point = text.codePointAt(0);
  // Only a square or curly bracket can tie two rows, and only as a matched
  // pair. Ordinary ( ) and ð Þ sit inside each row.
  if (/^[\[［]$/u.test(text)) return "square-open";
  if (/^[\]］]$/u.test(text)) return "square-close";
  if (text === "{") return "curly-open";
  if (text === "}") return "curly-close";
  // AdvP4C4E46 draws “[” / “]” as U+0014 / U+0015.
  if (isMathSymbolFont(element?.font) && point === 0x14) return "square-open";
  if (isMathSymbolFont(element?.font) && point === 0x15) return "square-close";
  return "";
}

function leftmostBodyGlyph(row) {
  const glyphs = (row?.glyphs || []).filter((glyph) => String(glyph.char || "").trim() && !isFencePiece(glyph));
  glyphs.sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
  return glyphs[0] || null;
}

function rowStartGlyph(members, row) {
  const pad = Math.max(3, (row.bottom - row.top) * 0.35);
  const glyphs = members.filter((glyph) => {
    if (!glyph?.bbox || !String(glyph.char || "").trim()) return false;
    const y = midY(glyph);
    return y >= row.top - pad && y <= row.bottom + pad;
  }).sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]);
  // The continuation is the first glyph. × and ≡ are math-symbol fences, but
  // they still count. A bracket before an interior = does not.
  return glyphs[0] || null;
}

function rowOwnsEquationNumber(row, hits) {
  return hits.some((hit) => {
    const y = midY(hit.token);
    return y >= row.top - 0.6 && y <= row.bottom + 0.6;
  });
}

function bracketSpansRows(members, rows) {
  if (rows.length !== 2) return false;
  const mid = (rows[0].bottom + rows[1].top) / 2;
  return ["square", "curly"].some((kind) => {
    const opens = members.filter((glyph) => glyph?.bbox && wrapBracketKind(glyph) === `${kind}-open` && midY(glyph) < mid + 1);
    const closes = members.filter((glyph) => glyph?.bbox && wrapBracketKind(glyph) === `${kind}-close` && midY(glyph) > mid - 1);
    return opens.some((open) => closes.some((close) => close.bbox[0] > open.bbox[0] + 8));
  });
}

function numbersLandOnDistinctRows(rows, hits, height) {
  if (hits.length < 2) return false;
  const owners = new Set();
  for (const hit of hits) {
    let best = null;
    let distance = Infinity;
    const y = midY(hit.token);
    for (const row of rows) {
      const center = (row.top + row.bottom) / 2;
      const gap = Math.abs(y - center);
      if (gap < distance) {
        distance = gap;
        best = row;
      }
    }
    if (best && distance <= 2.2 * height) owners.add(best);
  }
  return owners.size >= 2;
}

/**
 * One formula wrapped over two or more rows. A later row continues it when
 * that row starts with × · + −, or with = ≡ only if no earlier row already
 * ends in its own equation number, or when a bracket opens above and closes
 * here. Rows that each carry a number are separate formulas.
 */
function isWrappedChain(elements, members, height) {
  const rows = separateDisplayRows(members);
  if (rows.length < 2) return false;
  const hits = lineEndNumbers(elements, members, height);
  if (numbersLandOnDistinctRows(rows, hits, height)) return false;
  if (rows.every((row) => rowOwnsEquationNumber(row, hits))) return false;
  for (let index = 1; index < rows.length; index += 1) {
    const gap = rows[index].top - rows[index - 1].bottom;
    if (gap > 2.4 * (height || 8)) return false;
    if (bracketSpansRows(members, [rows[index - 1], rows[index]])) continue;
    const start = rowStartGlyph(members, rows[index]);
    if (expressionOperator(start)) continue;
    if (equalityOperator(start)) {
      const earlier = hits.some((hit) => midY(hit.token) <= rows[index - 1].bottom + Math.max(4, 0.8 * height));
      if (!earlier) continue;
    }
    return false;
  }
  return true;
}

// Split detection cannot use separateDisplayRows on the union: a tall integral
// whose box clips the next line by a point glues the two rows into one.
function continuesWrap(elements, upperMembers, lowerMembers, height) {
  const upperRows = separateDisplayRows(upperMembers);
  const lowerRows = separateDisplayRows(lowerMembers);
  if (!upperRows.length || !lowerRows.length) return false;
  const above = upperRows[upperRows.length - 1];
  const below = lowerRows[0];
  const gap = below.top - above.bottom;
  if (gap > 2.4 * (height || 8)) return false;
  const upperMid = (above.top + above.bottom) / 2;
  const lowerMid = (below.top + below.bottom) / 2;
  if (lowerMid - upperMid < Math.max(6, 0.7 * (height || 8))) return false;
  const combined = [...upperMembers, ...lowerMembers];
  const hits = lineEndNumbers(elements, combined, height);
  const pair = [above, below];
  if (numbersLandOnDistinctRows(pair, hits, height)) return false;
  if (pair.every((row) => rowOwnsEquationNumber(row, hits))) return false;
  if (bracketSpansRows(combined, pair)) return true;
  const start = rowStartGlyph(lowerMembers, below);
  if (expressionOperator(start)) return true;
  if (equalityOperator(start)) {
    // A lone one-line left-hand side joins the following ≡ or = row.
    // A display that is already several lines tall does not.
    const upperHeight = glyphHeight(upperMembers) || height || 8;
    const span = upperRows[upperRows.length - 1].bottom - upperRows[0].top;
    if (upperRows.length !== 1 || span > 2.2 * upperHeight) return false;
    const earlier = hits.some((hit) => midY(hit.token) <= above.bottom + Math.max(4, 0.8 * (height || 8)));
    return !earlier;
  }
  return false;
}

function extentInside(inner, outer) {
  return inner[0] >= outer[0] && inner[2] <= outer[2];
}

// separateDisplayRows drops a one-glyph row. A lone ≡ is still a formula
// sitting between two rows when the whole mark is narrower than 16pt.
function rowsBetweenCandidates(members) {
  const rows = separateDisplayRows(members);
  if (rows.length) return rows;
  const glyphs = members.filter((glyph) => glyph?.bbox && isLetterGlyph(glyph) && String(glyph.char || "").trim());
  if (glyphs.length !== 1) return rows;
  const box = rowSpanBox({ glyphs, top: glyphs[0].bbox[1], bottom: glyphs[0].bbox[3] });
  if (box[2] - box[0] >= 16) return rows;
  return [{ glyphs, top: glyphs[0].bbox[1], bottom: glyphs[0].bbox[3] }];
}

function rowSpanBox(row) {
  return [
    Math.min(...row.glyphs.map((glyph) => glyph.bbox[0])),
    row.top,
    Math.max(...row.glyphs.map((glyph) => glyph.bbox[2])),
    row.bottom
  ];
}

// Two formula rows of one display unit are one block only when nothing else's
// formula row sits between them. Merging the left-hand side into a later
// equation, skipping the block in the middle, is not a wrap.
function foreignRowBetween(page, unit, rowsById) {
  if (unit.type !== "display") return null;
  const rows = rowsById.get(unit.id) || [];
  if (rows.length < 2) return null;
  const members = membersOf(page, unit);
  for (let index = 1; index < rows.length; index += 1) {
    const above = rowSpanBox(rows[index - 1]);
    const below = rowSpanBox(rows[index]);
    for (const [otherId, otherRows] of rowsById) {
      if (otherId === unit.id) continue;
      for (const row of otherRows) {
        const mid = (row.top + row.bottom) / 2;
        if (mid <= above[3] + 1 || mid >= below[1] - 1) continue;
        const box = rowSpanBox(row);
        const width = box[2] - box[0];
        const overlapAbove = Math.min(above[2], box[2]) - Math.max(above[0], box[0]);
        const overlapBelow = Math.min(below[2], box[2]) - Math.max(below[0], box[0]);
        const narrowInside = width < 16 && extentInside(box, above) && extentInside(box, below);
        const wideOverlap = width >= 16 && overlapAbove >= 16 && overlapBelow >= 16;
        if (!narrowInside && !wideOverlap) continue;
        const sample = row.glyphs.find((glyph) => glyph?.bbox);
        if (!sample || !sameColumnGlyph(sample, members, page.elements || [])) continue;
        return { otherId, glyph: sample };
      }
    }
  }
  return null;
}

function equationNumberBetweenRows(elements, members, height) {
  const groups = separateDisplayRows(members);
  if (groups.length < 2) return false;
  return lineEndNumbers(elements, members, height).some((hit) => {
    const y = midY(hit.token);
    return groups.some((group, index) => {
      const next = groups[index + 1];
      return next && y > group.bottom + 1.2 && y < next.top - 1.2;
    });
  });
}

function displayIncludesProseLine(members, elements, height) {
  const body = members.filter((glyph) => isLetterGlyph(glyph) && glyph.label === "formula" && !isFencePiece(glyph) && boxHeight(glyph) >= 0.75 * height);
  const seeds = (body.length ? body : members.filter((glyph) => isLetterGlyph(glyph) && !isFencePiece(glyph))).slice().sort((a, b) => midY(a) - midY(b));
  const limit = Math.max(4, 0.45 * height);
  const rows = [];
  for (const glyph of seeds) {
    const y = midY(glyph);
    const current = rows.find((row) => Math.abs(y - row.y) <= limit);
    if (!current) {
      rows.push({ y, glyphs: [glyph] });
      continue;
    }
    current.glyphs.push(glyph);
    current.y = median(current.glyphs.map(midY));
  }
  for (const row of rows) {
    const left = Math.min(...row.glyphs.map((glyph) => glyph.bbox[0]));
    const right = Math.max(...row.glyphs.map((glyph) => glyph.bbox[2]));
    const prose = elements.filter((element) => {
      if (element.label !== "text" || !element.bbox || !proseTextWords(element.char).length) return false;
      if (Math.abs(midY(element) - row.y) > limit) return false;
      if (!sameColumnGlyph(element, members, elements)) return false;
      const gap = element.bbox[2] < left ? left - element.bbox[2] : element.bbox[0] > right ? element.bbox[0] - right : 0;
      return gap <= Math.max(36, 4 * height);
    });
    // A whole display equation can sit beside "where". Only a short run
    // tucked into a sentence (the next body row merged in) is this miss.
    if (row.glyphs.length > 4) continue;
    const sentence = prose.filter((element) => !isDisplayConnective(element) && proseTextWords(element.char).length >= 3);
    if (!sentence.length) continue;
    const tucked = sentence.some((element) => element.bbox[2] <= left && left - element.bbox[2] <= 12)
      && sentence.some((element) => element.bbox[0] >= right && element.bbox[0] - right <= 12);
    if (tucked) return sentence;
  }
  return null;
}

function looksLikeMeasure(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim().replace(/[.,]$/, "");
  if (!compact || compact.length > 48) return false;
  if (/^-?\d+(?:\.\d+)?\s*%$/.test(compact)) return true;
  if (/^-?\d+(?:\.\d+)?\s*(?:±|\+\/-)\s*-?\d+(?:\.\d+)?(?:\s*%|\s*[A-Za-zμµ℃°][A-Za-zμµ℃°0-9/^-]*)?$/.test(compact)) return true;
  if (/^-?\d+(?:\.\d+)?\s*[μµu]?[A-Za-z℃°][A-Za-zμµ℃°0-9/^-]*$/.test(compact)) return true;
  if (/^[A-Za-zμµ]{1,8}\^(?:\{)?-?\d+(?:\.\d+)?(?:\})?$/.test(compact)) return true;
  return false;
}

function looksLikeAuthorMark(members, pageNumber) {
  if (Number(pageNumber) !== 1) return false;
  const glyphs = members.filter(isLetterGlyph);
  const joined = glyphs.slice().sort((a, b) => a.bbox[0] - b.bbox[0]).map((element) => element.char || "").join("").replace(/\s+/g, "");
  if (/^[A-Z][\p{L}.'’-]*[¹²³⁴⁵⁶⁷⁸⁹⁰]+$/u.test(joined)) return true;
  const letters = glyphs.filter((element) => /\p{L}/u.test(element.char || ""));
  const digits = glyphs.filter((element) => /^[0-9¹²³⁴⁵⁶⁷⁸⁹⁰]+$/u.test(String(element.char || "").trim()));
  if (!letters.length || !digits.length) return false;
  const name = letters.slice().sort((a, b) => a.bbox[0] - b.bbox[0]).map((element) => element.char || "").join("");
  if (!/^[A-Z][\p{L}.'’-]*$/u.test(name)) return false;
  return median(digits.map(boxHeight)) < SUBSCRIPT_HEIGHT_RATIO * median(letters.map(boxHeight));
}

function readingText(members) {
  return members.filter(isLetterGlyph).slice().sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[1] - b.bbox[1]).map((element) => element.char || "").join("");
}

function isClosingDelimiter(element) {
  const text = String(element?.char || "").trim();
  if (/^[)\]）〕Þ]$/.test(text)) return true;
  return text.length === 1 && isMathSymbolFont(element.font);
}

function isOpeningDelimiter(element) {
  const text = String(element?.char || "").trim();
  return /^[(\[（〔ð]$/.test(text);
}

function isFencePiece(glyph) {
  const text = String(glyph?.char || "").replace(/\s+/g, "");
  if (!text) return true;
  if (isOpeningDelimiter(glyph) || isClosingDelimiter(glyph)) return true;
  return /^[{}()\[\]|]+$/.test(text);
}

function sharesBaseline(glyph, anchor, coreTop, coreBottom, limit) {
  if (Math.abs(midY(glyph) - anchor) > limit) return false;
  return overlapRatio(glyph, coreTop, coreBottom) >= 0.5;
}

function isOperatorOrBracket(element) {
  const text = String(element?.char || "").trim();
  if (!text || text.length > 3) return false;
  if (proseTextWords(text).length > 0) return false;
  return /^[=+\-−–×*<>≤≥≈≠()[\]{}]+$/.test(text) || isClosingDelimiter(element) || isOpeningDelimiter(element);
}

function isIgnoredAttachText(element) {
  const text = String(element?.char || "").trim();
  if (/^(?:=|,|\)|\(|\.|\[|\])/.test(text)) return true;
  if (/^[()[\]{}]+$/.test(text)) return true;
  if (element?.label === "text" && isBodyFont(element.font)) {
    if (/^\d+(?:\.\d+)+$/.test(text)) return true;
    if (/^[A-Za-z][A-Za-z0-9]*\s*\($/.test(text)) return true;
  }
  return false;
}

function isAttachableText(element) {
  if (!element || element.label !== "text") return false;
  const text = String(element.char || "").trim();
  if (!text || text.length > SHORT_ATTACH_MAX_CHARS) return false;
  if (isIgnoredAttachText(element)) return false;
  if (text === "," || text === "." || text === "，" || text === "。") return false;
  if (isMathItalicFont(element.font) && /^\p{L}$/u.test(text)) return true;
  if (isMathSymbolFont(element.font)) return true;
  if (isOperatorOrBracket(element)) return true;
  return proseTextWords(text).length === 0;
}

const ABBREVIATION_DOT = /(?:i\.i\.d|e\.g|i\.e|a\.e|etc)\.$/i;

function trailingAbbreviation(members, tail) {
  const mark = String(tail?.char || "").trim();
  if (mark !== "." && mark !== "。") return false;
  if (ABBREVIATION_DOT.test(mark)) return true;
  const left = members.filter(isLetterGlyph)
    .filter((glyph) => glyph !== tail && glyph.bbox[2] <= tail.bbox[0] + 1)
    .sort((a, b) => b.bbox[2] - a.bbox[2])
    .slice(0, 6)
    .reverse();
  const compact = `${left.map((glyph) => glyph.char || "").join("")}.`.replace(/\s+/g, "");
  return ABBREVIATION_DOT.test(compact);
}

function finding(entry, rule, extra) {
  return {
    severity: SEVERITY.get(rule),
    rule,
    title: RULE_TITLE.get(rule),
    queueIndex: entry.queueIndex,
    paperId: entry.unit.paperId,
    page: entry.unit.page,
    queueUnitId: entry.unit.unitId,
    currentUnitId: extra.currentUnitId || "",
    elements: (extra.elements || []).filter(Boolean).map(snap),
    suggestion: extra.suggestion
  };
}

function currentUnits(page, entry) {
  const elements = page?.elements || [];
  const selected = selectionForReviewUnit(elements, entry.unit.elementIds || [], entry.unit.unitId);
  const byId = new Map(elements.map((element) => [element.id, element]));
  const unitById = new Map((page?.units || []).map((unit) => [unit.id, unit]));
  const ids = selected.unitIds.length ? selected.unitIds : [];
  return {
    selected,
    units: ids.map((id) => unitById.get(id)).filter(Boolean),
    currentUnitId: ids.join(",")
  };
}

function membersOf(page, unit) {
  const byId = new Map((page.elements || []).map((element) => [element.id, element]));
  return (unit.elementIds || []).map((id) => byId.get(id)).filter(Boolean);
}

function auditUnitRules(entry, page, findings) {
  if (!entry.confirmed) {
    findings.push(finding(entry, "R0", {
      suggestion: "这条队列还没确认。打开它核对后按 Enter。故意用 j 或 k 跳过的可以忽略。"
    }));
  }
  if (!page) {
    findings.push(finding(entry, "R8", {
      suggestion: "这一页在 labels/reviewed 和 labels/prelabel 里都没有。先确认文件还在。"
    }));
    return;
  }
  const { units, currentUnitId } = currentUnits(page, entry);
  for (const unit of units) {
    const members = membersOf(page, unit);
    const height = glyphHeight(members);
    const box = unionBox(members);
    for (const element of members) {
      if (element.label !== "formula") continue;
      const words = formulaProseWords(element, members);
      if (!words.length) continue;
      findings.push(finding(entry, "R1", {
        currentUnitId: unit.id,
        elements: [element],
        suggestion: `公式里还有正文单词（${words.slice(0, 6).join("、")}）。把这个元素改回 text，或按 s 拆出去。`
      }));
    }
    if (unit.type === "display") {
      const { groups, height: lineHeight } = displayLineGroups(members);
      const rows = separateDisplayRows(members);
      const wrapped = isWrappedChain(page.elements || [], members, height);
      const farApart = !wrapped && groups.some((group, index) => {
        const previous = groups[index - 1];
        if (!previous) return false;
        return group.top - previous.bottom > DISPLAY_LINE_GAP_RATIO * lineHeight
          && group.glyphs.length >= MIN_GLYPHS_PER_LINE
          && previous.glyphs.length >= MIN_GLYPHS_PER_LINE;
      });
      const numberBetween = !wrapped && equationNumberBetweenRows(page.elements || [], members, height);
      const numberedRows = rows.filter((row) => rowOwnsEquationNumber(row, lineEndNumbers(page.elements || [], members, height)));
      const twoNumbers = numberedRows.length >= 2;
      const proseLine = displayIncludesProseLine(members, page.elements || [], height);
      if (farApart || numberBetween || twoNumbers || proseLine) {
        const sample = rows.length >= 2 ? rows : groups;
        const first = sample[0]?.glyphs?.[0] || members.find(isLetterGlyph);
        const second = (sample[1] || sample[0])?.glyphs?.[0] || first;
        findings.push(finding(entry, "R2", {
          currentUnitId: unit.id,
          elements: [first, second].filter(Boolean),
          suggestion: proseLine
            ? "这个行间单元并进了正文行里的公式。折行只包括以运算符续写的下一行，或同一对括号跨过的两行。正文句子旁边的公式按 s 拆出去。"
            : "这个行间单元跨了多行独立的式子。每一行各自按 d 成一个行间单元。以运算符续行的折行，或同一对括号跨过的两行，才是一个单元；两行各自带编号则不是。"
        }));
      }
    }
    const fonts = members.filter((element) => element.font);
    if (fonts.length && fonts.every((element) => isBodyFont(element.font))) {
      const text = readingText(members);
      if (looksLikeMeasure(text) || looksLikeAuthorMark(members, entry.unit.page)) {
        findings.push(finding(entry, "R4", {
          currentUnitId: unit.id,
          elements: members.filter(isLetterGlyph).slice(0, 6),
          suggestion: "整个单元都是正文字体，内容像数字加单位、± 区间、百分数、带上标的单位，或第 1 页作者角标。整单元改成 text。"
        }));
      }
    }
    const lineText = (page.elements || []).filter((element) => element.label === "text" && proseTextWords(element.char).length > 0 && sameLine(element, box, height));
    const leftProse = lineText.filter((element) => element.bbox[2] <= box[0] + 1);
    const rightProse = lineText.filter((element) => element.bbox[0] >= box[2] - 1);
    const numberedLine = lineEndNumbers(page.elements || [], members, height).length > 0;
    if (unit.type === "inline" && (( !lineText.length && members.filter(isLetterGlyph).length >= MIN_GLYPHS_PER_LINE) || numberedLine)) {
      findings.push(finding(entry, "R6", {
        currentUnitId: unit.id,
        elements: members.filter(isLetterGlyph).slice(0, 4),
        suggestion: numberedLine
          ? "这一行有行末编号，单元却标成行内。按 d 改成行间。同一基线上另一栏的句子，或编号旁边的单词，不算行内。"
          : "这一行没有正文，公式却是行内。独占一行的式子按 d 改成行间。"
      }));
    }
    const numbered = members.filter((element) => element.equationNumber === true);
    if (numbered.length) {
      const tooMany = numbered.length > 4 && numbered.length * 2 > members.length;
      const tokenIds = new Set(lineEndNumbers(page.elements || [], members, height).flatMap((hit) => hit.glyphs.map((glyph) => glyph.id)));
      const stray = numbered.filter((glyph) => !tokenIds.has(glyph.id));
      if (tooMany || stray.length) {
        findings.push(finding(entry, "R9", {
          currentUnitId: unit.id,
          elements: (stray.length ? stray : numbered).slice(0, 6),
          suggestion: "严重：这些字形被标成公式编号，但不像行末的短编号，或编号占了单元的大半。选中它们再按 e，取消错误标记。不要把整段式子标成编号。"
        }));
      }
    }
    const connectiveRow = [...leftProse, ...rightProse].every((element) => isDisplayConnective(element));
    if (unit.type === "display" && leftProse.length && rightProse.length && !numberedLine && !connectiveRow) {
      findings.push(finding(entry, "R6", {
        currentUnitId: unit.id,
        elements: [leftProse[0], rightProse[0]],
        suggestion: "左右都有正文单词，这个单元却是行间。写在句子中间的公式按 i 改成行内。"
      }));
    }
    const ordered = members.filter(isLetterGlyph).slice().sort((a, b) => a.bbox[2] - b.bbox[2]);
    const tail = ordered[ordered.length - 1];
    if (unit.type === "inline" && tail && /^[,.，。]$/.test(String(tail.char || "").trim()) && !trailingAbbreviation(members, tail)) {
      findings.push(finding(entry, "R7", {
        currentUnitId: unit.id,
        elements: [tail],
        suggestion: "行内公式末尾这个元素只有逗号或句号，应是正文。把它改成 text，不要留在公式里。缩写 i.i.d.、e.g.、i.e.、a.e.、etc. 结尾的点不算。"
      }));
    }
  }
}

function overlapRatio(glyph, top, bottom) {
  const overlap = Math.min(bottom, glyph.bbox[3]) - Math.max(top, glyph.bbox[1]);
  const denom = Math.min(boxHeight(glyph), Math.max(0.1, bottom - top));
  return denom > 0 ? overlap / denom : 0;
}

function equationLineClusters(elements, height) {
  const glyphs = elements.filter(isLetterGlyph);
  // Centers, not a growing box. A line just above can sit a few points
  // away and still overlap a tall fence; that must stay a separate row.
  const limit = Math.max(3, 0.35 * height);
  const band = Math.max(3, 0.45 * height);
  const body = glyphs.filter((glyph) => boxHeight(glyph) >= SUPERSCRIPT_HEIGHT_RATIO * height);
  const seeds = (body.length ? body : glyphs).slice().sort((a, b) => midY(a) - midY(b) || a.bbox[0] - b.bbox[0]);
  const lines = [];
  for (const glyph of seeds) {
    const y = midY(glyph);
    const current = lines[lines.length - 1];
    const coreTop = current ? current.anchor - band : glyph.bbox[1];
    const coreBottom = current ? current.anchor + band : glyph.bbox[3];
    const same = current && Math.abs(y - current.anchor) <= limit && overlapRatio(glyph, coreTop, coreBottom) >= 0.45;
    if (!same) {
      lines.push({ glyphs: [glyph], anchor: y, top: glyph.bbox[1], bottom: glyph.bbox[3] });
      continue;
    }
    current.glyphs.push(glyph);
    current.anchor = median(current.glyphs.map(midY));
    current.top = Math.min(current.top, glyph.bbox[1]);
    current.bottom = Math.max(current.bottom, glyph.bbox[3]);
  }
  const placed = new Set(lines.flatMap((line) => line.glyphs));
  for (const glyph of glyphs) {
    if (placed.has(glyph)) continue;
    let best = null;
    let bestDist = Infinity;
    for (const line of lines) {
      const dist = Math.abs(midY(glyph) - line.anchor);
      if (dist <= limit && overlapRatio(glyph, line.anchor - band, line.anchor + band) >= 0.45 && dist < bestDist) {
        best = line;
        bestDist = dist;
      }
    }
    if (!best) {
      lines.push({ glyphs: [glyph], anchor: midY(glyph), top: glyph.bbox[1], bottom: glyph.bbox[3] });
      continue;
    }
    best.glyphs.push(glyph);
    best.top = Math.min(best.top, glyph.bbox[1]);
    best.bottom = Math.max(best.bottom, glyph.bbox[3]);
  }
  return lines;
}

function isEquationNumberBlock(glyphs) {
  const visible = glyphs.filter((glyph) => String(glyph.char || "").trim());
  if (!visible.length || visible.length > 4) return false;
  const core = visible.filter((glyph) => !isOpeningDelimiter(glyph) && !isClosingDelimiter(glyph));
  const text = (core.length ? core : visible).map((glyph) => String(glyph.char || "").trim()).join("");
  return FULL_EQ_NUMBER.test(text) || BARE_EQ_NUMBER.test(text);
}

function columnGutters(glyphs, height) {
  const sorted = glyphs.filter(isLetterGlyph).slice().sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[2] - b.bbox[2]);
  const minGap = Math.max(32, 3.2 * height);
  const gaps = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const glyph = sorted[index];
    const width = glyph.bbox[0] - previous.bbox[2];
    if (width < minGap) continue;
    gaps.push({ x0: previous.bbox[2], x1: glyph.bbox[0], left: previous, right: glyph });
  }
  return gaps.filter((gap) => {
    if (!gap.left.unitId && !gap.right.unitId) return false;
    if (gap.left.unitId && gap.left.unitId === gap.right.unitId) return false;
    const next = gaps.find((item) => item.x0 > gap.x0 + 0.5);
    const block = sorted.filter((glyph) => glyph.bbox[0] >= gap.x1 - 0.5 && (!next || glyph.bbox[2] <= next.x0 + 0.5));
    return !isEquationNumberBlock(block);
  });
}

function splitColumns(glyphs, gutters) {
  if (!gutters.length) return [{ glyphs }];
  const cuts = gutters.map((gap) => gap.x1).sort((a, b) => a - b);
  const columns = [];
  let current = [];
  let cut = 0;
  const sorted = glyphs.slice().sort((a, b) => a.bbox[0] - b.bbox[0] || a.bbox[2] - b.bbox[2]);
  for (const glyph of sorted) {
    while (cut < cuts.length && glyph.bbox[0] >= cuts[cut] - 0.5) {
      if (current.length) columns.push({ glyphs: current });
      current = [];
      cut += 1;
    }
    current.push(glyph);
  }
  if (current.length) columns.push({ glyphs: current });
  return columns;
}

function isRaisedSmallDigit(element, cluster, height) {
  const text = String(element?.char || "").trim();
  if (!/^\d/.test(text)) return false;
  const others = (cluster?.glyphs || []).filter((glyph) => glyph.id !== element.id);
  const body = median(others.map(boxHeight)) || height;
  const h = boxHeight(element);
  if (!(h > 0 && body > 0 && h < SUPERSCRIPT_HEIGHT_RATIO * body)) return false;
  const baseline = median(others.map((glyph) => glyph.bbox[3]));
  if (!baseline) return false;
  return element.bbox[3] <= baseline - 0.15 * body;
}

export function isLeftMarginNumber(element, elements) {
  const text = String(element?.char || "").trim();
  if (!/^\(\d{1,3}\)$/.test(text) && !/^\d{1,3}$/.test(text)) return false;
  const prose = (elements || []).filter((item) => item?.label === "text" && String(item.char || "").trim().length > 12 && item.bbox);
  const column = prose.length ? median(prose.map((item) => item.bbox[0])) : 72;
  return element.bbox[2] < column - 12 && element.bbox[0] < 90;
}

function anchorOnLeft(members, cut) {
  const x = Math.min(...members.map((element) => element.bbox[0]));
  return cut == null || x < cut;
}

function gutterNumberGlyph(glyph, glyphs, cut) {
  if (cut == null || glyph.bbox[0] < cut || glyph.bbox[0] > cut + 16) return false;
  return glyphs.some((other) => other !== glyph && other.bbox[0] < cut && isOpeningDelimiter(other)
    && Math.abs(midY(other) - midY(glyph)) <= 6 && horizontalGap(other.bbox, glyph.bbox) <= 14);
}

function columnPiece(cluster, members, elements, height) {
  const ids = new Set(members.map((element) => element.id));
  const cut = pageColumnCut(elements);
  const onLeft = anchorOnLeft(members, cut);
  const sided = cluster.glyphs.filter((glyph) => {
    if (cut == null) return true;
    const left = glyph.bbox[0] < cut || gutterNumberGlyph(glyph, cluster.glyphs, cut);
    return left === onLeft;
  });
  // A single column has no gutter to cross. An 80pt gap inside one
  // equation (the two halves of W) is still the same line.
  const pieces = splitColumns(sided, cut == null ? [] : columnGutters(sided, height));
  return pieces.find((piece) => piece.glyphs.some((glyph) => ids.has(glyph.id))) || null;
}

function rightEdgeNumber(column, elements, height) {
  const band = column.glyphs.filter((glyph) => String(glyph.char || "").trim() && !(glyph.label === "text" && proseTextWords(glyph.char).length > 0));
  const sorted = band.slice().sort((a, b) => b.bbox[2] - a.bbox[2] || b.bbox[0] - a.bbox[0]);
  if (!sorted.length) return null;
  let token = sorted[0];
  const edge = token;
  const delimiters = [];
  if (isClosingDelimiter(token)) {
    delimiters.push(token);
    const inward = sorted.find((glyph) => glyph.bbox[2] <= token.bbox[0] + 1 && horizontalGap(glyph.bbox, token.bbox) <= height);
    if (!inward) return null;
    token = inward;
  }
  const text = String(token.char || "").trim();
  const full = FULL_EQ_NUMBER.test(text);
  const bare = BARE_EQ_NUMBER.test(text);
  if (!full && !bare) return null;
  if (token.bbox[2] < edge.bbox[2] - 1.5 && !isClosingDelimiter(edge)) return null;
  if (isRaisedSmallDigit(token, column, height) || isLeftMarginNumber(token, elements)) return null;
  const opening = sorted.find((glyph) => glyph !== token && glyph !== edge && glyph.bbox[2] <= token.bbox[0] + 1 && horizontalGap(glyph.bbox, token.bbox) <= height && isOpeningDelimiter(glyph));
  // A bare digit at the right of a fraction, or the 1 inside (l+1), is not
  // an equation number. The number is either one glyph "(5)" / "(2.50)",
  // or brackets / ðÞ wrapped tightly around the digits.
  if (!full) {
    if (!isClosingDelimiter(edge) || !opening) return null;
    const between = sorted.some((glyph) => {
      if (glyph === token || glyph === edge || glyph === opening) return false;
      if (glyph.bbox[0] < opening.bbox[2] - 1 || glyph.bbox[2] > token.bbox[0] + 1) return false;
      return !isOpeningDelimiter(glyph) && !isClosingDelimiter(glyph);
    });
    if (between) return null;
  }
  // f(3) sits against the function name. A line-end number has a gap.
  const anchor = opening || token;
  const left = sorted.filter((glyph) => glyph !== token && glyph !== edge && glyph !== opening && glyph.bbox[2] <= anchor.bbox[0] + 1)
    .sort((a, b) => b.bbox[2] - a.bbox[2])[0];
  if (left && horizontalGap(left.bbox, anchor.bbox) < 3 && /\p{L}/u.test(String(left.char || ""))) return null;
  return { token, glyphs: [opening, token, ...delimiters].filter(Boolean) };
}

function lineEndNumbers(elements, members, height) {
  const usable = members.filter((element) => element?.bbox);
  if (!usable.length) return [];
  const hits = [];
  for (const cluster of equationLineClusters(elements, height)) {
    const piece = columnPiece(cluster, usable, elements, height);
    if (!piece) continue;
    const number = rightEdgeNumber(piece, elements, height);
    if (number) hits.push({ ...number, column: piece.glyphs });
  }
  return hits;
}

function sameColumnGlyph(glyph, members, elements) {
  const cut = pageColumnCut(elements);
  if (cut == null) return true;
  const onLeft = anchorOnLeft(members, cut);
  const left = glyph.bbox[0] < cut || gutterNumberGlyph(glyph, elements, cut);
  return left === onLeft;
}

function onNumberRow(glyph, hit, height) {
  const y = midY(hit.token);
  const limit = Math.max(3, 0.35 * height);
  const band = Math.max(3, 0.45 * height);
  if (!isLetterGlyph(glyph) || Math.abs(midY(glyph) - y) > limit) return false;
  return overlapRatio(glyph, y - band, y + band) >= 0.45;
}

function rowFormulaBody(glyphs, hit, height) {
  const ids = new Set(hit.glyphs.map((glyph) => glyph.id));
  return glyphs.some((glyph) => !ids.has(glyph.id) && !isFencePiece(glyph) && onNumberRow(glyph, hit, height));
}

function orphanLineEndNumbers(elements, members, height, watchedIds) {
  const ids = new Set(members.map((element) => element.id));
  const watched = watchedIds instanceof Set ? watchedIds : new Set(watchedIds || []);
  const box = unionBox(members);
  const extras = elements.filter((element) => {
    if (!element?.bbox || ids.has(element.id) || !watched.has(element.id)) return false;
    if (!sameColumnGlyph(element, members, elements)) return false;
    if (!FULL_EQ_NUMBER.test(String(element.char || "").trim())) return false;
    const y = midY(element);
    if (y < box[1] - 1 || y > box[3] + Math.max(8, 1.05 * height)) return false;
    return element.bbox[0] >= box[2] - Math.max(72, 8 * height);
  });
  if (!extras.length) return [];
  return lineEndNumbers(elements, [...members, ...extras], height).filter((hit) => !ids.has(hit.token.id));
}

function displayUnitHasFormulaBody(page, unit, hit) {
  const ids = new Set((hit?.glyphs || []).map((glyph) => glyph.id));
  return membersOf(page, unit).some((glyph) => !ids.has(glyph.id) && glyph.label === "formula" && isLetterGlyph(glyph) && !isFencePiece(glyph) && boxHeight(glyph) >= 4);
}

function rowHasProse(members) {
  return members.some((element) => formulaProseWords(element, members).length > 0);
}

function unitSitsBetween(page, units, upper, lower, upperBox, lowerBox) {
  const top = upperBox[3];
  const bottom = lowerBox[1];
  if (bottom <= top + 2) return false;
  return units.some((unit) => {
    if (unit.id === upper.id || unit.id === lower.id) return false;
    const members = membersOf(page, unit).filter((element) => element.bbox);
    if (separateDisplayRows(members).length < 1) return false;
    const box = unionBox(members);
    const mid = (box[1] + box[3]) / 2;
    return mid > top + 1 && mid < bottom - 1;
  });
}

function numberOwnedByFormula(page, hit, height) {
  const owner = (page.units || []).find((unit) => unit.id === hit.token.unitId);
  if (!owner || owner.type !== "display") return false;
  return displayUnitHasFormulaBody(page, owner, hit) && rowFormulaBody(membersOf(page, owner), hit, height);
}

// A line-end (n) / ðnÞ that sits on this row but is text, or lives in a unit
// that has no formula beside it.
function detachedLineEndNumbers(page, members, height) {
  return lineEndNumbers(page.elements || [], members, height).filter((hit) => !numberOwnedByFormula(page, hit, height));
}

function splitWrappedPredecessor(page, lower, units, height) {
  const lowerMembers = membersOf(page, lower).filter((element) => element.bbox);
  if (separateDisplayRows(lowerMembers).length < 1) return null;
  const lowerBox = unionBox(lowerMembers);
  let best = null;
  let bestBottom = -Infinity;
  for (const upper of units) {
    if (upper.id === lower.id) continue;
    if (upper.type !== "display" && upper.type !== "inline") continue;
    const upperMembers = membersOf(page, upper).filter((element) => element.bbox);
    if (separateDisplayRows(upperMembers).length < 1) continue;
    // A lone left-hand side is often inline. A prose sentence is not.
    if (upper.type === "inline" && rowHasProse(upperMembers)) continue;
    const upperBox = unionBox(upperMembers);
    if ((upperBox[1] + upperBox[3]) / 2 >= (lowerBox[1] + lowerBox[3]) / 2) continue;
    const gap = lowerBox[1] - upperBox[3];
    if (gap > 2.4 * height) continue;
    const overlap = Math.min(upperBox[2], lowerBox[2]) - Math.max(upperBox[0], lowerBox[0]);
    if (overlap < 16) continue;
    if (unitSitsBetween(page, units, upper, lower, upperBox, lowerBox)) continue;
    if (!continuesWrap(page.elements || [], upperMembers, lowerMembers, height)) continue;
    if (upperBox[3] > bestBottom) {
      best = upper;
      bestBottom = upperBox[3];
    }
  }
  return best;
}

function auditPageRules(entries, page, findings, info) {
  if (!page) return;
  const elements = page.elements || [];
  const elementById = new Map(elements.map((element) => [element.id, element]));
  const unitById = new Map((page.units || []).map((unit) => [unit.id, unit]));
  const knownIds = new Set(elements.map((element) => element.id));
  const height = glyphHeight(elements);
  const host = entries[0];

  for (const element of elements) {
    if (element.label !== "formula") continue;
    const owner = entries.find((entry) => (entry.unit.elementIds || []).includes(element.id)) || host;
    if (!element.unitId || !unitById.has(element.unitId)) {
      findings.push(finding(owner, "R8", {
        currentUnitId: element.unitId || "",
        elements: [element],
        suggestion: "这个公式元素没有对得上的 unitId。不要手改编号，回到复核页重新合并。"
      }));
    }
  }
  for (const unit of page.units || []) {
    for (const id of unit.elementIds || []) {
      if (knownIds.has(id)) continue;
      const owner = entries.find((entry) => entry.unit.unitId === unit.id || (entry.unit.elementIds || []).includes(id)) || host;
      findings.push(finding(owner, "R8", {
        currentUnitId: unit.id,
        elements: [{ id, char: "", font: "", label: "", bbox: [] }],
        suggestion: `units 里的 ${id} 在元素列表中不存在。不要手改编号，用复核页导出的文件重新导入。`
      }));
    }
  }

  const seenNumbers = new Set();
  const seenMerges = new Set();
  for (const entry of entries) {
    for (const unit of currentUnits(page, entry).units) {
      const members = membersOf(page, unit).filter((element) => element.bbox);
      if (!members.length) continue;
      for (const hit of lineEndNumbers(elements, members, height)) {
        if (seenNumbers.has(hit.token.id)) continue;
        const tokenUnit = unitById.get(hit.token.unitId);
        const hostType = tokenUnit?.type || (hit.token.unitId === unit.id ? unit.type : "") || "";
        const inside = members.some((element) => element.id === hit.token.id);
        const owner = unitById.get(hit.token.unitId);
        const formulaHere = rowFormulaBody(members, hit, height);
        if (!inside && owner && rowFormulaBody(membersOf(page, owner), hit, height)) continue;
        const formulaElsewhere = rowFormulaBody(
          elements.filter((element) => element.unitId && element.unitId !== unit.id && element.label === "formula" && sameColumnGlyph(element, members, elements)),
          hit,
          height
        );
        const loneNumberRow = inside && hostType === "display" && !formulaHere && !formulaElsewhere && displayUnitHasFormulaBody(page, unit, hit);
        if (inside && hostType === "display" && formulaHere && hit.token.equationNumber !== true && hit.token.label === "formula") {
          seenNumbers.add(hit.token.id);
          info.push({ rule: "R3", queueIndex: entry.queueIndex });
          continue;
        }
        if ((inside && hostType === "display" && formulaHere) || loneNumberRow) {
          seenNumbers.add(hit.token.id);
          continue;
        }
        // ð4Þ on a Nature/PLOS page sits on the tall bracket, between the two
        // formula baselines, so it is not "on" either letter row. It still
        // belongs to this display when its box is inside the unit. A number
        // one line below the box does not.
        if (!inside && !formulaHere) {
          const span = unionBox(members);
          const y = midY(hit.token);
          const unitHeight = glyphHeight(members) || height;
          const inSpan = unit.type === "display"
            && y >= span[1] - 1
            && y <= span[3] + 1
            && hit.token.bbox[0] >= span[2] - Math.max(72, 8 * unitHeight)
            && sameColumnGlyph(hit.token, members, elements);
          if (!inSpan) continue;
        }
        seenNumbers.add(hit.token.id);
        const elsewhere = Boolean(hit.token.unitId) && !inside;
        findings.push(finding(entry, "R3", {
          currentUnitId: unit.id,
          elements: hit.glyphs,
          suggestion: hostType === "inline" && inside
            ? "行末编号在行内单元里。按 d 改成行间。"
            : elsewhere || (inside && formulaElsewhere)
              ? "行末编号落在别的单元里。框住本行式子和编号按 m 并成一个行间单元，再按 e 只标编号。"
              : "行末编号不在这一行的单元里。选中编号按 e，并进同一栏的行间单元。"
        }));
      }
      if (unit.type === "display") {
        for (const hit of orphanLineEndNumbers(elements, members, height, entry.unit.elementIds || [])) {
          if (seenNumbers.has(hit.token.id)) continue;
          const owner = unitById.get(hit.token.unitId);
          if (owner?.type === "display" && displayUnitHasFormulaBody(page, owner, hit)) continue;
          seenNumbers.add(hit.token.id);
          findings.push(finding(entry, "R3", {
            currentUnitId: unit.id,
            elements: hit.glyphs,
            suggestion: hit.token.unitId
              ? "行末编号落在别的单元里。框住本行式子和编号按 m 并成一个行间单元，再按 e 只标编号。"
              : "行末编号不在这一行的单元里。选中编号按 e，并进同一栏的行间单元。"
          }));
        }
      }
      const mergeHeight = glyphHeight(members) || height;
      const limit = Math.max(4, 0.55 * mergeHeight);
      // A full text line is about 14pt. Same-row stays inside one glyph height and never a whole line below.
      const sameRowLimit = Math.min(8, Math.max(4, 0.45 * mergeHeight));
      const body = members.filter((glyph) => isLetterGlyph(glyph) && boxHeight(glyph) >= SUPERSCRIPT_HEIGHT_RATIO * mergeHeight && !isFencePiece(glyph));
      const seeds = (body.length >= 2 ? body : members.filter((glyph) => isLetterGlyph(glyph) && !isFencePiece(glyph))).slice().sort((a, b) => midY(a) - midY(b));
      const baselines = [];
      for (const glyph of seeds) {
        const y = midY(glyph);
        const current = baselines[baselines.length - 1];
        if (!current || Math.abs(y - current.y) > limit) baselines.push({ y, glyphs: [glyph] });
        else {
          current.glyphs.push(glyph);
          current.y = median(current.glyphs.map(midY));
        }
      }
      const cut = pageColumnCut(elements);
      const onLeft = anchorOnLeft(members, cut);
      const numberIds = new Set(lineEndNumbers(elements, members, height).flatMap((hit) => hit.glyphs.map((glyph) => glyph.id)));
      const maxGap = Math.max(96, 8 * mergeHeight);
      for (const base of baselines) {
        if (base.glyphs.length < 2) continue;
        const coreGlyphs = base.glyphs.filter((glyph) => Math.abs(midY(glyph) - base.y) <= sameRowLimit);
        const core = coreGlyphs.length ? coreGlyphs : base.glyphs;
        const coreTop = Math.min(...core.map((glyph) => glyph.bbox[1]));
        const coreBottom = Math.max(...core.map((glyph) => glyph.bbox[3]));
        const band = elements.filter((glyph) => isLetterGlyph(glyph) && sharesBaseline(glyph, base.y, coreTop, coreBottom, sameRowLimit)
          && (cut == null || (glyph.bbox[0] < cut) === onLeft));
        if (band.some((glyph) => glyph.label === "text" && proseTextWords(glyph.char).length > 0)) continue;
        const nearText = elements.filter((glyph) => glyph.label === "text" && proseTextWords(glyph.char).length > 0 && glyph.bbox
          && Math.abs(midY(glyph) - base.y) <= Math.max(sameRowLimit, 0.95 * mergeHeight)
          && (cut == null || (glyph.bbox[0] < cut) === onLeft));
        if (nearText.length > 0) continue;
        const lineText = elements.filter((glyph) => glyph.label === "text" && isLetterGlyph(glyph)
          && Math.abs(midY(glyph) - base.y) <= Math.max(limit, 0.85 * mergeHeight) && String(glyph.char || "").trim());
        if (lineText.length >= 4) continue;
        const ours = band.filter((glyph) => glyph.unitId === unit.id);
        if (ours.length < 2) continue;
        const left = Math.min(...ours.map((glyph) => glyph.bbox[0]));
        const right = Math.max(...ours.map((glyph) => glyph.bbox[2]));
        const gapTo = (glyph) => (glyph.bbox[2] < left ? left - glyph.bbox[2] : glyph.bbox[0] > right ? glyph.bbox[0] - right : 0);
        const foreign = band.filter((glyph) => glyph.label === "formula" && glyph.unitId !== unit.id && !numberIds.has(glyph.id)
          && !isRaisedSmallDigit(glyph, { glyphs: band }, mergeHeight));
        const closeUnits = new Set(foreign.filter((glyph) => gapTo(glyph) <= maxGap).map((glyph) => glyph.unitId || glyph.id));
        const byUnit = new Map();
        for (const glyph of foreign) {
          const key = glyph.unitId || glyph.id;
          if (!closeUnits.has(key)) continue;
          const list = byUnit.get(key) || [];
          list.push(glyph);
          byUnit.set(key, list);
        }
        for (const [otherId, glyphs] of byUnit) {
          const opens = glyphs.filter((glyph) => isOpeningDelimiter(glyph));
          const closes = glyphs.filter((glyph) => isClosingDelimiter(glyph));
          const content = glyphs.filter((glyph) => !isOpeningDelimiter(glyph) && !isClosingDelimiter(glyph) && !isFencePiece(glyph));
          const splitBody = content.length >= 2 || content.some((glyph) => String(glyph.char || "").trim().length > 1);
          const splitPair = opens.length > 0 && closes.length > 0 && content.length === 0 && glyphs.length >= 2;
          if (!splitBody && !splitPair) continue;
          const otherLeft = Math.min(...glyphs.map((glyph) => glyph.bbox[0]));
          const otherRight = Math.max(...glyphs.map((glyph) => glyph.bbox[2]));
          const gapText = band.some((glyph) => {
            if (glyph.label !== "text" || !String(glyph.char || "").trim()) return false;
            const start = Math.min(right, otherRight);
            const end = Math.max(left, otherLeft);
            return glyph.bbox[0] >= start - 1 && glyph.bbox[2] <= end + 1;
          });
          if (gapText) continue;
          const key = `${entry.queueIndex}:${[unit.id, otherId].sort().join("|")}`;
          if (seenMerges.has(key)) continue;
          seenMerges.add(key);
          findings.push(finding(entry, "R10", {
            currentUnitId: unit.id,
            elements: glyphs.slice(0, 4),
            suggestion: "同一行同一栏还有别的公式，这一行没有正文。一行只能有一个单元。框住整行按 m。"
          }));
        }
      }
    }
    for (const id of entry.unit.elementIds || []) {
      if (seenNumbers.has(id)) continue;
      const element = elementById.get(id);
      if (!element?.bbox || !FULL_EQ_NUMBER.test(String(element.char || "").trim())) continue;
      const owner = unitById.get(element.unitId);
      if (owner?.type === "display" && displayUnitHasFormulaBody(page, owner, { glyphs: [element], token: element })) continue;
      const hit = lineEndNumbers(elements, [element], height).find((item) => item.token.id === element.id);
      if (!hit) continue;
      seenNumbers.add(element.id);
      findings.push(finding(entry, "R3", {
        currentUnitId: owner?.id || "",
        elements: hit.glyphs,
        suggestion: element.unitId
          ? "行末编号落在别的单元里。框住本行式子和编号按 m 并成一个行间单元，再按 e 只标编号。"
          : "行末编号不在这一行的单元里。选中编号按 e，并进同一栏的行间单元。"
      }));
    }
  }

  const splitSeen = new Set();
  const wrappedCandidates = (page.units || []).filter((unit) => (unit.elementIds || []).length && (unit.type === "display" || unit.type === "inline"));
  const displays = wrappedCandidates.filter((unit) => unit.type === "display");
  const entryFor = (unitId) => entries.find((item) => currentUnits(page, item).units.some((unit) => unit.id === unitId));
  for (const lower of displays) {
    const upper = splitWrappedPredecessor(page, lower, wrappedCandidates, height);
    if (!upper) continue;
    const key = [upper.id, lower.id].sort().join("|");
    if (splitSeen.has(key)) continue;
    splitSeen.add(key);
    const entry = entryFor(lower.id) || entryFor(upper.id);
    if (!entry) continue;
    const upperGlyph = membersOf(page, upper).find(isLetterGlyph);
    const lowerGlyph = membersOf(page, lower).find(isLetterGlyph);
    findings.push(finding(entry, "R2", {
      currentUnitId: `${upper.id},${lower.id}`,
      elements: [upperGlyph, lowerGlyph].filter(Boolean),
      suggestion: "这两行是同一个折行公式：下一行以运算符开头，或同一对括号在上一行打开、下一行闭合。框住两行按 m 并成一个行间单元。编号写在任一行都算这个单元的成员。"
    }));
    // The number of a wrapped formula may sit on the continuation row as text, outside either unit.
    for (const side of [upper, lower]) {
      for (const hit of detachedLineEndNumbers(page, membersOf(page, side), height)) {
        if (seenNumbers.has(hit.token.id)) continue;
        seenNumbers.add(hit.token.id);
        findings.push(finding(entry, "R3", {
          currentUnitId: `${upper.id},${lower.id}`,
          elements: hit.glyphs,
          suggestion: hit.token.unitId
            ? "行末编号落在别的单元里。框住本行式子和编号按 m 并成一个行间单元，再按 e 只标编号。"
            : "行末编号不在这一行的单元里。选中编号按 e，并进同一栏的行间单元。"
        }));
      }
    }
  }

  const rowsById = new Map(wrappedCandidates.map((unit) => [unit.id, rowsBetweenCandidates(membersOf(page, unit).filter((element) => element.bbox))]));
  for (const unit of displays) {
    const hit = foreignRowBetween(page, unit, rowsById);
    if (!hit) continue;
    const entry = entryFor(unit.id) || entryFor(hit.otherId);
    if (!entry) continue;
    const ownGlyph = membersOf(page, unit).find(isLetterGlyph);
    findings.push(finding(entry, "R2", {
      currentUnitId: unit.id,
      elements: [ownGlyph, hit.glyph].filter(Boolean),
      suggestion: "这个行间单元并进了不相邻的公式行，中间隔着别的单元。折行只包括紧挨着的下一行。把中间隔开的那一行按 s 拆出去。"
    }));
  }

  const formulaUnits = (page.units || []).filter((unit) => (unit.elementIds || []).length);
  const auditedIds = new Set(entries.flatMap((entry) => currentUnits(page, entry).units.map((unit) => unit.id)));
  const relevant = formulaUnits.filter((unit) => auditedIds.has(unit.id));
  for (const unit of relevant) {
    const members = membersOf(page, unit);
    const box = unionBox(members);
    const unitHeight = glyphHeight(members) || height;
    for (const element of elements) {
      if (!isAttachableText(element) || members.includes(element)) continue;
      if (!sameLine(element, box, unitHeight)) continue;
      if (horizontalGap(element.bbox, box) > TOUCH_GAP_RATIO * unitHeight) continue;
      const owner = entries.find((entry) => currentUnits(page, entry).units.some((item) => item.id === unit.id)) || host;
      findings.push(finding(owner, "R5", {
        currentUnitId: unit.id,
        elements: [element],
        suggestion: "这个元素紧贴已在队列里的公式，又像公式的一部分（斜体单字母、数学字体、运算符，或不含单词的短串）。框住后按 m。"
      }));
    }
  }
  const orderedUnits = relevant.map((unit) => ({ unit, box: unionBox(membersOf(page, unit)) })).sort((a, b) => a.box[0] - b.box[0]);
  for (let index = 1; index < orderedUnits.length; index += 1) {
    const left = orderedUnits[index - 1];
    const right = orderedUnits[index];
    if (!sameLine({ bbox: left.box }, right.box, height)) continue;
    const gap = horizontalGap(left.box, right.box);
    const between = elements.filter((element) => {
      if (!isLetterGlyph(element) && element.kind === "path") return false;
      const mid = (element.bbox[0] + element.bbox[2]) / 2;
      return mid > left.box[2] - 0.5 && mid < right.box[0] + 0.5 && sameLine(element, left.box, height);
    });
    const onlySymbols = between.length > 0 && between.every(isOperatorOrBracket);
    const touching = gap <= TOUCH_GAP_RATIO * height && between.length === 0;
    if (!onlySymbols && !touching) continue;
    const owner = entries.find((entry) => currentUnits(page, entry).units.some((unit) => unit.id === left.unit.id || unit.id === right.unit.id)) || host;
    findings.push(finding(owner, "R5", {
      currentUnitId: `${left.unit.id},${right.unit.id}`,
      elements: between.slice(0, 3),
      suggestion: "同一行两个公式单元紧贴，或中间只隔运算符、括号。它们多半该是一个单元。框住后按 m。"
    }));
  }
}

function dedupe(findings) {
  const seen = new Set();
  return findings.filter((item) => {
    const ids = item.elements.map((element) => element.id).join(",");
    const key = [item.rule, item.paperId, item.page, item.queueUnitId, item.currentUnitId, ids, item.suggestion].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function auditReviewed({ queue, loadPage, confirmedKeys, limit } = {}) {
  const window = selectAuditWindow(queue, confirmedKeys, limit);
  const findings = [];
  const info = [];
  const byPage = new Map();
  for (const entry of window) {
    const key = `${entry.unit.paperId}:${entry.unit.page}`;
    if (!byPage.has(key)) byPage.set(key, { page: loadPage ? loadPage(entry.unit.paperId, entry.unit.page) : null, entries: [] });
    byPage.get(key).entries.push(entry);
  }
  for (const { page, entries } of byPage.values()) {
    for (const entry of entries) auditUnitRules(entry, page, findings);
    auditPageRules(entries, page, findings, info);
  }
  const sorted = dedupe(findings).sort((a, b) => a.severity - b.severity || a.queueIndex - b.queueIndex || a.rule.localeCompare(b.rule));
  const counts = Object.fromEntries(RULES.map(([rule]) => [rule, sorted.filter((item) => item.rule === rule).length]));
  const confirmedCount = window.filter((entry) => entry.confirmed).length;
  return {
    window: {
      from: window[0]?.queueIndex || 0,
      to: window[window.length - 1]?.queueIndex || 0,
      size: window.length,
      confirmed: confirmedCount,
      skipped: window.length - confirmedCount,
      limit: Number.isInteger(limit) ? limit : null
    },
    counts,
    info: { R3: info.length },
    findings: sorted
  };
}

/** One line per queue index: rules and suggested actions, in index order. */
export function summarizeByQueueIndex(findings = []) {
  const groups = new Map();
  for (const item of findings) {
    const list = groups.get(item.queueIndex) || [];
    list.push(item);
    groups.set(item.queueIndex, list);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((queueIndex) => {
    const parts = groups.get(queueIndex).map((item) => `${item.rule} ${item.suggestion}`);
    return `- #${queueIndex}：${parts.join("；")}`;
  });
}

export function renderMarkdown(report) {
  const lines = [
    "# 复核审计",
    "",
    `窗口：队列 ${report.window.from || 0}–${report.window.to || 0}，共 ${report.window.size} 条，已确认 ${report.window.confirmed}，未确认 ${report.window.skipped}。`,
    `发现 ${report.findings.length} 条，按严重度排列。`,
    "",
    "## 汇总",
    "",
    "| 规则 | 含义 | 条数 |",
    "| --- | --- | --- |"
  ];
  for (const [rule, , title] of RULES) {
    lines.push(`| ${rule} | ${title} | ${report.counts[rule] || 0} |`);
  }
  const noted = report.info?.R3 || 0;
  if (noted) lines.push("", `信息：${noted} 个行末编号已经在行间单元里，只是 equationNumber 仍是 false。这不是错误，留给 M2 自动推导。`);
  lines.push("", "## 按序号汇总", "");
  const byIndex = summarizeByQueueIndex(report.findings);
  if (!byIndex.length) lines.push("没有发现。");
  else lines.push(...byIndex);
  lines.push("", "## 发现", "");
  if (!report.findings.length) lines.push("没有发现。");
  for (const item of report.findings) {
    lines.push(`### #${item.queueIndex} ${item.rule} · ${item.paperId} 第 ${item.page} 页`);
    lines.push("");
    lines.push(`- 队列 unitId：\`${item.queueUnitId}\``);
    lines.push(`- 当前 unitId：\`${item.currentUnitId || "（无）"}\``);
    lines.push(`- 建议：${item.suggestion}`);
    if (item.elements.length) {
      lines.push("- 元素：");
      for (const element of item.elements) {
        const box = element.bbox.length ? element.bbox.map((value) => Number(value).toFixed(2)).join(", ") : "无";
        lines.push(`  - \`${element.id}\` char=\`${element.char}\` font=\`${element.font}\` label=\`${element.label}\` bbox=[${box}]`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function pageFile(page) {
  return `page-${String(page).padStart(3, "0")}.json`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadAuditInputs(base = root) {
  const reviewPath = join(base, "labels/review-set.json");
  if (!existsSync(reviewPath)) {
    throw new Error("还没有 labels/review-set.json。先运行 node scripts/review-set.mjs");
  }
  const reviewSet = readJson(reviewPath);
  const cache = new Map();
  const loadPage = (paperId, page) => {
    const key = `${paperId}:${page}`;
    if (cache.has(key)) return cache.get(key);
    const reviewed = join(base, "labels/reviewed", paperId, pageFile(page));
    const prelabel = join(base, "labels/prelabel", paperId, pageFile(page));
    const path = existsSync(reviewed) ? reviewed : (existsSync(prelabel) ? prelabel : "");
    const data = path ? readJson(path) : null;
    cache.set(key, data);
    return data;
  };
  const confirmed = new Set();
  for (const unit of reviewSet.units || []) {
    const reviewed = join(base, "labels/reviewed", unit.paperId, pageFile(unit.page));
    if (!existsSync(reviewed)) continue;
    const key = `${unit.paperId}:${unit.page}`;
    if (!cache.has(key)) cache.set(key, readJson(reviewed));
    const ids = cache.get(key)?.reviewedUnitIds || [];
    if (ids.includes(unit.unitId)) confirmed.add(confirmKey(unit));
  }
  return { queue: reviewSet.units || [], loadPage, confirmed };
}

export function parseAuditArgs(argv) {
  let limit = null;
  let out = null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--limit") limit = Number(argv[++index]);
    else if (arg === "--out") out = argv[++index];
    else if (arg === "--help") return { help: true, limit, out };
  }
  if (limit != null && (!Number.isInteger(limit) || limit < 0)) throw new Error("--limit 要是非负整数");
  return { limit, out };
}

function main() {
  const args = parseAuditArgs(process.argv.slice(2));
  if (args.help) {
    console.log("node scripts/audit-reviewed.mjs [--limit N] [--out reports/audit.md]");
    return;
  }
  const inputs = loadAuditInputs(root);
  const report = auditReviewed({ ...inputs, confirmedKeys: inputs.confirmed, limit: args.limit });
  const markdown = renderMarkdown(report);
  if (!args.out) {
    process.stdout.write(markdown);
    console.log(JSON.stringify(report.counts));
    return;
  }
  const jsonPath = args.out.endsWith(".json") ? args.out : args.out.replace(/\.md$/i, "") + ".json";
  const mdPath = args.out.endsWith(".json") ? args.out.replace(/\.json$/i, ".md") : args.out;
  mkdirSync(dirname(mdPath), { recursive: true });
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(mdPath, markdown);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`${mdPath}`);
  console.log(`${jsonPath}`);
  console.log(JSON.stringify(report.counts));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
