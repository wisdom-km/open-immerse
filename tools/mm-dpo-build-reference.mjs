/**
 * Build the committed DPO reference table from arXiv 2305.18290v3.
 *
 * The test PDF is that version (sha256 pinned below). This script downloads
 * the matching e-print when the tarball is absent, unpacks it with the
 * product source reader, detects formula blocks on pages 3–5, and keeps a
 * reference only when one source formula is the unique high-confidence match.
 * Everything else is unaligned and stays out of accuracy.
 *
 *   node tools/mm-dpo-build-reference.mjs
 *   node tools/mm-dpo-build-reference.mjs --pdf <file> --source <tarball> --out <json>
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { unpackSource } from "../lib/arxiv-src-unpack.js";
import { equationLabelDigits } from "../lib/formula-arxiv-gate.js";
import { parseLatexSource, prepareFormulaLatex } from "../lib/latex-units.js";
import { DPO_PAPER } from "../lib/mm-dpo-ab.js";
import { openPdfSession } from "./mm-dpo-reference.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const REFERENCE_SCHEMA = "open-immerse.mm-dpo-reference/v1";
export const DPO_PDF_SHA256 = "92cb3a2b71362acda98a789b03d88688fd33cf5fcf13f81d2b1de30ee7d3b67a";
export const DPO_SOURCE_SHA256 = "750054a6d13d9f79559d6defbfa68432e2a8c8959f0b7e7e37c622c1740653cc";
export const DPO_PDF_URL = "https://arxiv.org/pdf/2305.18290v3";
export const DPO_SOURCE_URL = "https://arxiv.org/e-print/2305.18290v3";
export const DEFAULT_REFERENCE_OUT = join(root, "tests/fixtures/mm-dpo-reference.json");
export const DEFAULT_PDF = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
export const DEFAULT_SOURCE = join(root, "tests/fixtures/arxiv-src/2305.18290v3.tar.gz");

const PARAGRAPH_SCORE = 0.55;
const PARAGRAPH_GAP = 0.15;
const INLINE_SCORE = 0.92;
const INLINE_COVER = 0.85;
const INLINE_COVER_GAP = 0.2;
const EXACT_KEY_MIN = 2;
const PREFIX_KEY_MIN = 8;
const PREFIX_SUFFIX_MAX = 8;
const FRAGMENT_KEY_MAX = 12;
const DISPLAY_LCS = 0.7;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function starKey(src) {
  const marked = String(src || "")
    .replace(/\^\s*\{?\s*(?:\\(?:ast|star)|[*∗])\s*\}?/g, "star")
    .replace(/∗/g, "star");
  return mathKey(marked);
}

function mathKey(src) {
  let text = String(src || "");
  const map = {
    "∗": "*", "ϕ": "phi", "φ": "phi", "θ": "theta", "π": "pi", "β": "beta",
    "σ": "sigma", "∼": "sim", "≻": "succ", "−": "-", "–": "-", "∇": "nabla",
    "∑": "sum", "ˆ": "", "̂": ""
  };
  text = text.replace(/[∗ϕφθπβσ∼≻−–∇∑ˆ̂]/g, (ch) => map[ch] ?? "");
  text = text.replace(/\\(?:text|mathrm|textrm|mathbf|mathit|operatorname|mbox|mathbb|mathcal|textbf)\{([^{}]*)\}/g, "$1");
  text = text.replace(/\\(?:left|right|bigl|bigr|Bigl|Bigr|biggl|biggr|big|Big|mid|cdot)\b/g, "");
  text = text.replace(/\\(?:label|ref|eqref|cite\w*|tag|underbrace|overbrace)\*?\{[^}]*\}/g, "");
  text = text.replace(/\\nonumber\b/g, "");
  text = text.replace(/\\(?:hat|widehat|tilde|bar)\{?\\?([A-Za-z])\}?/g, "$1");
  text = text.replace(/\\([a-zA-Z]+)/g, "$1");
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function lcsLength(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  if (!a || !b) return 0;
  let prev = new Uint16Array(b.length + 1);
  let cur = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1]);
    }
    const swap = prev;
    prev = cur;
    cur = swap;
    cur.fill(0);
  }
  return prev[b.length];
}

function words(src) {
  return String(src || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((word) => word.length > 2);
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function unwrapGroup(src) {
  const text = String(src || "").trim();
  if (!text.startsWith("{") || !text.endsWith("}")) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i === text.length - 1 ? text.slice(1, -1).trim() : text;
    }
  }
  return text;
}

export function referenceLatex(latex, display) {
  const prepared = prepareFormulaLatex(String(latex || ""), display === true).trim();
  return display ? prepared : unwrapGroup(prepared);
}

function sourceCatalog(units) {
  const displays = [];
  for (const unit of units) {
    if (unit?.kind !== "display") continue;
    const latex = referenceLatex(unit.latex, true);
    displays.push({
      id: unit.id,
      number: unit.number == null ? "" : String(unit.number),
      latex,
      key: mathKey(latex)
    });
  }
  return { displays };
}

function matchParagraph(formula, units) {
  const mine = words(formula?.paragraphText);
  if (mine.length < 4) return null;
  const ranked = units
    .filter((unit) => unit?.text)
    .map((unit) => ({ unit, score: jaccard(mine, words(unit.text)) }))
    .sort((a, b) => b.score - a.score);
  const top = ranked[0];
  const second = ranked[1];
  if (!top || top.score < PARAGRAPH_SCORE) return null;
  if (top.score - (second?.score || 0) < PARAGRAPH_GAP) return null;
  return top.unit;
}

function adjacentDisplay(paragraph, units, displays) {
  const index = units.findIndex((unit) => unit.id === paragraph.id);
  if (index < 0) return null;
  for (let i = index - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (unit.kind === "display") return displays.find((item) => item.id === unit.id) || null;
    if (unit.kind === "paragraph" || unit.kind === "heading") return null;
  }
  return null;
}

function inlineCandidates(paragraph) {
  return (paragraph?.parts || [])
    .filter((part) => part?.type === "inline" && part.latex)
    .map((part) => {
      const latex = referenceLatex(part.latex, false);
      return { id: part.id, latex, key: mathKey(latex) };
    });
}

function scorePair(pdfKey, sourceKey) {
  if (!pdfKey || !sourceKey) return { score: 0, cover: 0 };
  const shared = lcsLength(pdfKey, sourceKey);
  return {
    score: shared / Math.min(pdfKey.length, sourceKey.length),
    cover: shared / Math.max(pdfKey.length, sourceKey.length)
  };
}

function blankRow(formula) {
  return {
    id: formula.id,
    page: formula.page,
    display: formula.display !== false,
    equationNumber: formula.equationNumber || null,
    aligned: false,
    confidence: "none",
    reason: "unaligned",
    sourceId: "",
    reference: null
  };
}

function parenSpans(latex) {
  const text = String(latex || "");
  const spans = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === ")" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        spans.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return spans;
}

function relationMarks(src) {
  const text = String(src || "");
  return {
    mid: /\\mid|\|/.test(text),
    comma: /,/.test(text)
  };
}

function sameRelations(pdf, span) {
  const left = relationMarks(pdf);
  const right = relationMarks(span);
  return left.mid === right.mid && left.comma === right.comma;
}

function fragmentCandidates(paragraph) {
  const out = [];
  for (const item of inlineCandidates(paragraph)) {
    for (const span of parenSpans(item.latex)) {
      const key = mathKey(span);
      if (key.length < EXACT_KEY_MIN || key === item.key || key.length > FRAGMENT_KEY_MAX) continue;
      out.push({
        id: `${item.id}#${key}`,
        latex: referenceLatex(span, false),
        key
      });
    }
  }
  return out;
}

function missReason(formula, paragraph, key, scored) {
  if (!paragraph) return words(formula?.paragraphText).length < 4 ? "no-paragraph" : "paragraph-tie";
  if (formula.display !== false) return key.length < 12 ? "short-key" : "low-score";
  if (key.length < EXACT_KEY_MIN) return "short-key";
  if (!scored.length) return "no-inline";
  return "low-score";
}

function claim(row, source, reason) {
  row.aligned = true;
  row.confidence = "high";
  row.reason = reason;
  row.sourceId = source.id;
  row.reference = source.latex;
}

/**
 * Align detected blocks to parsed source units.
 * A row is aligned only when one source formula wins cleanly.
 * @param {object[]} formulas
 * @param {object[]} units parseLatexSource().units
 */
export function alignDetectedFormulas(formulas, units) {
  const list = Array.isArray(formulas) ? formulas : [];
  const sourceUnits = Array.isArray(units) ? units : [];
  const { displays } = sourceCatalog(sourceUnits);
  const rows = list.map((formula) => {
    const row = blankRow(formula);
    const digits = equationLabelDigits(formula.equationNumber);
    if (formula.display !== false && digits) {
      const numbered = displays.filter((item) => item.number === digits);
      if (numbered.length === 1) {
        claim(row, numbered[0], "equation-number");
        return row;
      }
    }
    const paragraph = matchParagraph(formula, sourceUnits);
    let key = mathKey(formula.pdfText);
    let starMode = false;
    if (formula.display === false && key.length < EXACT_KEY_MIN && /[*∗]/.test(String(formula.pdfText || ""))) {
      const starred = starKey(formula.pdfText);
      if (starred.length >= EXACT_KEY_MIN) {
        key = starred;
        starMode = true;
      }
    }
    if (formula.display !== false && paragraph && key.length >= 12) {
      const neighbor = adjacentDisplay(paragraph, sourceUnits, displays);
      if (neighbor) {
        const fit = scorePair(key, neighbor.key);
        if (fit.score >= DISPLAY_LCS) {
          claim(row, neighbor, "adjacent-display");
          return row;
        }
      }
    }
    if (formula.display === false && paragraph && key.length >= EXACT_KEY_MIN) {
      const pool = inlineCandidates(paragraph).map((item) => (
        starMode ? { ...item, key: starKey(item.latex) } : item
      ));
      const scored = pool
        .map((item) => ({ item, ...scorePair(key, item.key) }))
        .sort((a, b) => b.cover - a.cover || b.score - a.score);
      const best = scored[0];
      const next = scored[1];
      const exact = scored.filter((item) => item.item.key === key);
      const longEnough = best
        && best.score >= INLINE_SCORE
        && best.cover >= INLINE_COVER
        && key.length >= 8
        && best.cover - (next?.cover || 0) >= INLINE_COVER_GAP;
      const exactUnique = exact.length === 1
        && exact[0].item.key.length >= EXACT_KEY_MIN
        && exact[0].cover >= 0.99
        && (next?.cover || 0) <= exact[0].cover - INLINE_COVER_GAP;
      const fragments = fragmentCandidates(paragraph).filter((item) =>
        item.key === mathKey(formula.pdfText) && sameRelations(formula.pdfText, item.latex));
      const prefixed = key.length >= PREFIX_KEY_MIN
        ? pool.filter((item) =>
          item.key.startsWith(key)
          && item.key.length > key.length
          && item.key.length - key.length <= PREFIX_SUFFIX_MAX)
        : [];
      if (longEnough) claim(row, best.item, "paragraph-inline");
      else if (exactUnique) claim(row, exact[0].item, "paragraph-inline");
      else if (exact.length > 1) row.reason = "ambiguous";
      else if (fragments.length === 1) claim(row, fragments[0], "paragraph-fragment");
      else if (fragments.length > 1) row.reason = "ambiguous";
      else if (prefixed.length === 1) claim(row, prefixed[0], "paragraph-prefix");
      else if (prefixed.length > 1) row.reason = "ambiguous";
      else row.reason = missReason(formula, paragraph, key, scored);
      return row;
    }
    row.reason = missReason(formula, paragraph, key, []);
    return row;
  });
  const claimed = new Map();
  for (const row of rows) {
    if (!row.aligned || !row.sourceId) continue;
    if (!claimed.has(row.sourceId)) claimed.set(row.sourceId, []);
    claimed.get(row.sourceId).push(row);
  }
  for (const group of claimed.values()) {
    if (group.length < 2) continue;
    for (const row of group) {
      row.aligned = false;
      row.confidence = "none";
      row.reason = "ambiguous";
      row.sourceId = "";
      row.reference = null;
    }
  }
  return rows;
}

/**
 * The 2026-10-23 live report used ids from a detection pass that read font
 * names before the operator list (37 blocks). Those page-3 ids are not the
 * same blocks anymore. Rescore still scores that report from this copy.
 */
export function legacyDetection(previous) {
  if (previous?.legacy?.formulas?.length) return previous.legacy;
  if (previous?.detected !== 37 || !Array.isArray(previous.formulas)) return null;
  return {
    detected: 37,
    note: "2026-10-23 的报告在字体加载前检出 37 块。这些 id 不能重放。coverage.detected 为 37 时，--rescore 用这里记下的参考内容。",
    formulas: previous.formulas
  };
}

export function referenceDocument(formulas, rows, meta = {}) {
  const aligned = rows.filter((row) => row.aligned && row.reference).length;
  const document = {
    schema: REFERENCE_SCHEMA,
    arxiv: DPO_PAPER.arxiv,
    version: DPO_PAPER.version,
    pdfSha256: meta.pdfSha256 || DPO_PDF_SHA256,
    sourceUrl: DPO_SOURCE_URL,
    sourceSha256: meta.sourceSha256 || DPO_SOURCE_SHA256,
    pages: DPO_PAPER.pages.slice(),
    detected: formulas.length,
    aligned,
    unaligned: rows.length - aligned,
    formulas: rows.map((row) => ({
      id: row.id,
      page: row.page,
      display: row.display === true,
      equationNumber: row.equationNumber,
      aligned: row.aligned === true,
      confidence: row.aligned ? "high" : "none",
      reason: row.reason,
      sourceId: row.aligned ? row.sourceId : "",
      reference: row.aligned ? row.reference : null
    }))
  };
  if (meta.legacy?.formulas?.length) document.legacy = meta.legacy;
  if (Array.isArray(meta.probes)) {
    document.probes = meta.probes;
    document.probeCount = meta.probes.length;
    document.probeAligned = meta.probes.filter((row) => row.aligned && row.reference).length;
    document.probeNote = "脚本短公式探针，不是产品检出。FORMULA_RUN_MIN_WIDTH 仍是 12。";
  }
  return document;
}

async function download(url, dest, expect) {
  if (existsSync(dest)) {
    const actual = sha256(readFileSync(dest));
    if (actual !== expect) {
      throw new Error(`已有文件哈希不符 ${dest}：${actual}，期望 ${expect}`);
    }
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`下载失败 ${url}：${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== expect) throw new Error(`下载哈希不符 ${url}：${actual}，期望 ${expect}`);
  writeFileSync(dest, bytes);
}

export async function buildReference({ pdfPath = DEFAULT_PDF, sourcePath = DEFAULT_SOURCE, legacy = null } = {}) {
  await download(DPO_PDF_URL, pdfPath, DPO_PDF_SHA256);
  await download(DPO_SOURCE_URL, sourcePath, DPO_SOURCE_SHA256);
  const sourceBytes = readFileSync(sourcePath);
  const unpacked = await unpackSource(sourceBytes, { gunzip: async (bytes) => gunzipSync(bytes) });
  if (!unpacked.files?.length) throw new Error(`源码包没有 tex：${unpacked.reason || unpacked.kind}`);
  const parsed = parseLatexSource(unpacked.files);
  if (!parsed.supported) throw new Error("源码没有单一主 tex");
  const session = await openPdfSession(pdfPath);
  try {
    const rows = alignDetectedFormulas(session.formulas, parsed.units);
    const probeRows = alignDetectedFormulas(session.probes || [], parsed.units);
    const probes = (session.probes || []).map((probe) => {
      const row = probeRows.find((item) => item.id === probe.id) || {};
      return {
        id: probe.id,
        page: probe.page,
        display: false,
        pdfText: probe.pdfText,
        signature: probe.signature,
        aligned: row.aligned === true,
        confidence: row.aligned ? "high" : "none",
        reason: row.reason || "low-score",
        sourceId: row.aligned ? row.sourceId : "",
        reference: row.aligned ? row.reference : null
      };
    });
    return referenceDocument(session.formulas, rows, {
      pdfSha256: sha256(readFileSync(pdfPath)),
      sourceSha256: sha256(sourceBytes),
      legacy,
      probes
    });
  } finally {
    await session.close();
  }
}

function argValue(argv, name) {
  const inline = argv.find((arg) => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0) return argv[index + 1] || "";
  return "";
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log("用法: node tools/mm-dpo-build-reference.mjs [--pdf file] [--source file] [--out file]");
    return;
  }
  const pdfPath = argValue(argv, "--pdf") || DEFAULT_PDF;
  const sourcePath = argValue(argv, "--source") || DEFAULT_SOURCE;
  const outPath = argValue(argv, "--out") || DEFAULT_REFERENCE_OUT;
  let previous = null;
  if (existsSync(outPath)) {
    try {
      previous = JSON.parse(readFileSync(outPath, "utf8"));
    } catch {
      previous = null;
    }
  }
  const document = await buildReference({
    pdfPath,
    sourcePath,
    legacy: legacyDetection(previous)
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
  const marked = document.formulas.filter((row) => row.aligned === false).map((row) => `${row.id}:${row.reason}`);
  console.log(`${outPath} detected=${document.detected} aligned=${document.aligned} unaligned=${document.unaligned} probes=${document.probeCount} probeAligned=${document.probeAligned}`);
  if (marked.length) console.log(`unaligned: ${marked.join(", ")}`);
  const probeMiss = (document.probes || []).filter((row) => row.aligned === false).map((row) => `${row.id}:${row.reason}:${row.pdfText}`);
  if (probeMiss.length) console.log(`probe unaligned: ${probeMiss.join(" | ")}`);
}

function invokedDirectly() {
  const called = process.argv[1];
  if (!called) return false;
  return fileURLToPath(import.meta.url) === join(process.cwd(), called) || fileURLToPath(import.meta.url) === called;
}

if (invokedDirectly()) {
  main().catch((err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  });
}
