/**
 * Script-only short inline probes for the DPO pages.
 *
 * The product inline gate (FORMULA_RUN_MIN_WIDTH) is not changed. This pass
 * keeps math the gate drops when the run is narrower than 12pt and still has
 * a subscript, a superscript, or a math symbol. Detected formula boxes are
 * left alone.
 */

import { paragraphGeometry, probeSignature, selectShortProbes } from "../lib/mm-dpo-ab.js";
import { fontNameForFormula, isMathFontName } from "../lib/pdf-mirror.js";
import { FORMULA_RUN_MIN_WIDTH, FORMULA_SCRIPT_RATIO } from "../lib/pdf-text-layer.js";

const GREEK = /[πθβϕφσρλμνωαγδεΠΣΔΩ]/;
const SYMBOL = /[∼≻∑∫√∞±×÷∈⊂⊆∗*ˆ̂^_=<>≤≥∥|]/;
const MATH_TOKEN = /^(SFT|DPO|ref|KL)$/;
const BASE = /[A-Za-zπθβϕφσρλμνωαγδε]/;

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  if (!sorted.length) return 10;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function normalizeItem(item) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const x = Number.isFinite(Number(item?.x)) ? Number(item.x) : Number(transform[4]) || 0;
  const y = Number.isFinite(Number(item?.y)) ? Number(item.y) : Number(transform[5]) || 0;
  const width = Number(item?.width) || 0;
  const height = Number(item?.height) || 0;
  const str = String(item?.str || "");
  if (!str.trim() || !(width > 0) || !(height > 0)) return null;
  return { str, x, y, width, height, font: fontNameForFormula(item) };
}

function itemFraction(item, viewport) {
  const rect = viewport.convertToViewportRectangle([
    item.x,
    item.y,
    item.x + item.width,
    item.y + item.height
  ]);
  const width = Math.max(1, Number(viewport.width) || 1);
  const height = Math.max(1, Number(viewport.height) || 1);
  const [x1, y1, x2, y2] = rect;
  return [
    clamp01(Math.min(x1, x2) / width),
    clamp01(Math.min(y1, y2) / height),
    clamp01(Math.max(x1, x2) / width),
    clamp01(Math.max(y1, y2) / height)
  ];
}

function unionBox(boxes) {
  if (!boxes.length) return null;
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3]))
  ];
}

function centerInside(box, page, formulas) {
  const cx = (box[0] + box[2]) / 2;
  const cy = (box[1] + box[3]) / 2;
  return formulas.some((formula) => {
    if (Number(formula?.page) !== page) return false;
    const host = formula.layoutBbox || formula.bbox;
    if (!host) return false;
    return cx >= host[0] && cx <= host[2] && cy >= host[1] && cy <= host[3];
  });
}

function xGap(left, right) {
  return right.x - (left.x + left.width);
}

function xNear(left, right) {
  const pad = 2;
  return left.x < right.x + right.width + pad && right.x < left.x + left.width + pad;
}

function isBreaker(item) {
  const text = item.str.trim();
  if (!text) return true;
  if (MATH_TOKEN.test(text)) return false;
  if (GREEK.test(text) || SYMBOL.test(text)) return false;
  if (isMathFontName(item.font) && text.length <= 3) return false;
  if (/^[0-9]+$/.test(text)) return false;
  if (/^[()\[\]]+$/.test(text)) return false;
  if (/^[,]$/.test(text)) return false;
  if (/^[.。]$/.test(text)) return true;
  if (/[\u4e00-\u9fff]/.test(text)) return true;
  if (/[A-Za-z]{3,}/.test(text)) return true;
  return text.length > 4;
}

function isSeed(item) {
  const text = item.str.trim();
  if (GREEK.test(text) || SYMBOL.test(text)) return true;
  if (isMathFontName(item.font) && text.length <= 2 && !/^[()\[\],.;]$/.test(text)) return true;
  return false;
}

function keepRun(run, bodyH) {
  if (!run.length) return false;
  const ordered = run.slice().sort((a, b) => a.x - b.x);
  const text = ordered.map((item) => item.str.trim()).join("");
  if (!BASE.test(text)) return false;
  if (/^[∗*ˆ̂^]+$/.test(text)) return false;
  const math = ordered.filter((item) => !MATH_TOKEN.test(item.str.trim()));
  const span = math.length ? math : ordered;
  const mathWidth = span[span.length - 1].x + span[span.length - 1].width - span[0].x;
  const total = ordered[ordered.length - 1].x + ordered[ordered.length - 1].width - ordered[0].x;
  if (!(mathWidth > 0) || mathWidth >= FORMULA_RUN_MIN_WIDTH) return false;
  if (total >= 28) return false;
  const hasScript = ordered.some((item) => item.height < bodyH * FORMULA_SCRIPT_RATIO - 0.05);
  const hasGreek = ordered.some((item) => GREEK.test(item.str));
  const hasSymbol = ordered.some((item) => SYMBOL.test(item.str) || /CMSY|CMEX|MSAM|MSBM/i.test(item.font));
  if (!hasScript && !hasGreek && !hasSymbol) return false;
  return true;
}

function clusterLines(items, bodyH) {
  const bodyCut = bodyH * FORMULA_SCRIPT_RATIO;
  const body = items.filter((item) => item.height >= bodyCut);
  const scripts = items.filter((item) => item.height < bodyCut);
  const lines = [];
  for (const item of body.slice().sort((a, b) => b.y - a.y || a.x - b.x)) {
    let line = lines.find((entry) => Math.abs(entry.y - item.y) <= 1.6);
    if (!line) {
      line = { y: item.y, items: [] };
      lines.push(line);
    }
    line.items.push(item);
  }
  for (const script of scripts) {
    let best = null;
    let bestDy = Infinity;
    for (const host of body) {
      if (!xNear(script, host)) continue;
      const dy = Math.abs(script.y - host.y);
      if (dy < bestDy && dy < bodyH * 1.5) {
        bestDy = dy;
        best = host;
      }
    }
    if (!best) continue;
    const line = lines.find((entry) => entry.items.includes(best));
    if (line) line.items.push(script);
  }
  return lines;
}

function runsOnLine(line, page, formulas, viewport, bodyH) {
  const items = line.items.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const runs = [];
  let current = [];
  const flush = () => {
    if (keepRun(current, bodyH)) runs.push(current.slice());
    current = [];
  };
  for (const item of items) {
    const box = itemFraction(item, viewport);
    if (centerInside(box, page, formulas)) {
      const last = current[current.length - 1];
      const extend = last
        && current.length < 4
        && isSeed(item)
        && xGap(last, item) <= 4
        && !isBreaker(item);
      if (extend) current.push(item);
      flush();
      continue;
    }
    if (!current.length) {
      if (isSeed(item)) current.push(item);
      continue;
    }
    const last = current[current.length - 1];
    const paren = /^[(\[]/.test(item.str.trim());
    if (paren || isBreaker(item) || xGap(last, item) > 4 || current.length >= 5) {
      flush();
      if (!paren && isSeed(item)) current.push(item);
      continue;
    }
    current.push(item);
  }
  flush();
  return runs;
}

function probeFromRun(run, page, viewport, blocks) {
  const ordered = run.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const boxes = ordered.map((item) => itemFraction(item, viewport));
  const bbox = unionBox(boxes);
  if (!bbox) return null;
  const pdfText = ordered.map((item) => item.str.trim()).join("");
  const paragraph = paragraphGeometry({ id: "probe", bbox }, blocks);
  return {
    page,
    display: false,
    pdfText,
    signature: probeSignature(pdfText),
    bbox,
    layoutBbox: bbox.slice(),
    paragraphText: paragraph.text || "",
    paragraphBbox: paragraph.bbox || bbox.slice(),
    glyphs: [],
    glyphBoxes: [],
    maskBoxes: [],
    seedBoxes: [],
    inlineOf: "",
    formulaInkProtect: false,
    reference: null,
    imageUrl: "",
    equationNumber: null,
    probe: true
  };
}

/**
 * Every short inline that the 12pt gate would skip. Ids are assigned later,
 * after the deterministic 10-item pick, so the sample of the 42 blocks stays put.
 */
export function extractShortCandidates({ pages, formulas } = {}) {
  const found = [];
  const hosts = Array.isArray(formulas) ? formulas : [];
  for (const entry of Array.isArray(pages) ? pages : []) {
    const page = Number(entry?.page);
    const viewport = entry?.viewport;
    if (!viewport || typeof viewport.convertToViewportRectangle !== "function") continue;
    const items = (Array.isArray(entry.items) ? entry.items : []).map(normalizeItem).filter(Boolean);
    const heights = items.map((item) => item.height).filter((height) => height >= 8);
    const bodyH = median(heights);
    for (const line of clusterLines(items, bodyH)) {
      for (const run of runsOnLine(line, page, hosts, viewport, bodyH)) {
        const probe = probeFromRun(run, page, viewport, entry.blocks || []);
        if (!probe) continue;
        const first = itemFraction(run.slice().sort((a, b) => a.x - b.x)[0], viewport);
        if (centerInside(first, page, hosts)) continue;
        found.push(probe);
      }
    }
  }
  return found;
}

/** The ~10 probes appended by --probe-short. Reading order, contiguous ids per page. */
export function shortProbeFormulas({ pages, formulas, limit } = {}) {
  const selected = selectShortProbes(extractShortCandidates({ pages, formulas }), limit);
  const counters = new Map();
  return selected.map((item) => {
    const n = (counters.get(item.page) || 0) + 1;
    counters.set(item.page, n);
    return { ...item, id: `p${item.page}-s${n}`, index: n };
  });
}
