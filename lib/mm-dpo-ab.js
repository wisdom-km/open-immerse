/**
 * Lab report for the DPO multimodal A/B (arXiv 2305.18290v3, pages 3–5,
 * 79 formulas). Pure: no network, no process.env, no cache writes.
 *
 * The CLI in tools/mm-dpo-reference.mjs is the only entry that can send.
 * Tight crops use cropPngFor when a PNG is already attached. A text-layer
 * PDF block has no imageUrl, so the CLI renders the product tight crop
 * (measureFormulaCrop at CROP_SCALE, inline pad 4 / display pad 6).
 * Hi-res calls the product visionCropFor path (mm-3 renderVisionCrop).
 * The paragraph arm is a script-only crop of
 * the paragraph box at that same scale, plus the paragraph text. It does not
 * change the product prompt or the product default. The page arm stays
 * opt-in and never attaches a PDF.
 */

import { cropPngFor, parseCropDataUrl } from "./formula-crop-png.js";
import { formulaUnitFromBlock } from "./formula-schedule.js";
import { VISION_CROP_SCALE, visionCropFor } from "./formula-vision-crop.js";
import { FORMULA_VISION_SYSTEM, MM_TIER_VERSION, formulaVisionText } from "./formula-tiers/multimodal.js";
import { normalizeLatex, parseLatexCandidate, verifyCandidate } from "./formula-verify.js";

export const REPORT_SCHEMA = "open-immerse.mm-dpo-ab/v1";

export const DPO_PAPER = Object.freeze({
  arxiv: "2305.18290",
  version: "v3",
  pages: Object.freeze([3, 4, 5]),
  formulaCount: 79
});

export const ARM_IDS = Object.freeze(["tight", "hi-res", "paragraph", "page"]);
export const DEFAULT_ARMS = Object.freeze(["tight"]);
export const PARAGRAPH_TEXT_MAX = 1200;
export const PARAGRAPH_PROMPT_NOTE = "图中已标出目标公式，文字为所在段落上下文";

export const ROW_FIELDS = Object.freeze([
  "id",
  "page",
  "index",
  "arm",
  "provider",
  "model",
  "latex",
  "verify",
  "paint",
  "exactMatch",
  "matchesReference",
  "canonicalMatch",
  "latencyMs",
  "tokens",
  "checkedButMismatch"
]);

/** Paragraph must beat hi-res by this much on Kimi K3 before D2 suggests it. */
export const D2_CLEAR_MARGIN = 0.05;
/** Absorbs a binary 0.05 that lands one ulp under the margin. */
const D2_RATE_EPSILON = 1e-9;

/**
 * Moonshot list price for kimi-k3, cache-miss input, USD per 1M tokens.
 * A rough estimate for the report, not an invoice. DeepSeek stays unpriced.
 */
export const COST_RATES = Object.freeze([
  Object.freeze({
    provider: "kimi",
    model: "kimi-k3",
    promptUsdPerMillion: 3,
    completionUsdPerMillion: 15,
    note: "kimi-k3 公开标价估算（缓存未命中）。火山方舟通道沿用此数，不是账单。"
  })
]);

export const ARM_GUIDE = Object.freeze([
  Object.freeze({
    id: "tight",
    default: true,
    sendsPdf: false,
    note: "紧裁 PNG。已有图走 cropPngFor；文字层 PDF 用 measureFormulaCrop（CROP_SCALE 2，行内 pad 4、独立 pad 6）。默认臂。"
  }),
  Object.freeze({
    id: "hi-res",
    default: false,
    sendsPdf: false,
    note: "产品高清裁图（visionCropFor / renderVisionCrop，mm-3，scale 4）。没有页面渲染时不发送。"
  }),
  Object.freeze({
    id: "paragraph",
    default: false,
    sendsPdf: false,
    note: "脚本实验：段落区域按同一高清倍率出图，并附上段落文字。不改产品默认，也不改产品提示词。"
  }),
  Object.freeze({
    id: "page",
    default: false,
    sendsPdf: false,
    requiresFlag: "--arm=page",
    note: "整页对照，只在脚本里。默认关。不发送整页 PDF，也不能成为产品默认。"
  })
]);

export const AB_CHANNELS = Object.freeze([
  Object.freeze({
    role: "primary",
    provider: "kimi",
    model: "kimi-k3",
    envKey: "MM_DPO_KIMI_API_KEY",
    envModel: "MM_DPO_KIMI_MODEL",
    envBaseUrl: "MM_DPO_KIMI_BASE_URL"
  }),
  Object.freeze({
    role: "baseline",
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    envKey: "MM_DPO_DEEPSEEK_API_KEY",
    envModel: "MM_DPO_DEEPSEEK_MODEL",
    envBaseUrl: "MM_DPO_DEEPSEEK_BASE_URL"
  })
]);

export const FIELD_GUIDE = Object.freeze({
  latex: "模型给出的公式 LaTeX。没有可核对的候选时为 null。",
  verify: "第二层核对（字符集 + KaTeX）。pass 为真才算核对过。",
  paint: "上屏方式：katex（核对通过）/ crop（核对不过、UNREADABLE 或调用失败，静默裁图）/ none（未发送）。",
  exactMatch: "与参考 LaTeX 逐字一致。缺参考或没有候选时为 null。",
  matchesReference: "去掉空白后是否一致。缺参考或没有候选时为 null。",
  canonicalMatch: "规范形是否一致（D2 用这个）。单符号花括号、字体命令、定界符尺寸、对齐外壳和句末标点不算差别。不同符号仍然不同。缺参考或没有候选时为 null。",
  latencyMs: "这一次模型请求的耗时（毫秒）。未发送为 0。",
  tokens: "token：prompt / completion / total。没有用量时为 null。",
  checkedButMismatch: "核对通过，但规范形与参考不一致。汇总字段是这个标志的条数。"
});

const PENDING_REASON = Object.freeze({
  "hi-res": "pending-f7w-1",
  paragraph: "pending-f7w-3",
  page: "page-script-only"
});

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function resolveArms(requested) {
  if (requested == null) return DEFAULT_ARMS.slice();
  const list = Array.isArray(requested) ? requested : [requested];
  if (!list.length) return DEFAULT_ARMS.slice();
  const out = [];
  for (const raw of list) {
    const id = String(raw ?? "").trim().toLowerCase();
    if (!id) continue;
    if (!ARM_IDS.includes(id)) throw fail("unknown-arm", `未知输入臂：${raw}`);
    if (!out.includes(id)) out.push(id);
  }
  return out.length ? out : DEFAULT_ARMS.slice();
}

export function bareKey(value) {
  const trimmed = String(value ?? "").trim();
  const match = /^(?:bearer|token)\s+/i.exec(trimmed);
  return match ? trimmed.slice(match[0].length).trim() : trimmed;
}

/**
 * DeepSeek on Ark has no separate key. An unset MM_DPO_DEEPSEEK_API_KEY
 * reuses MM_DPO_KIMI_API_KEY. A set DeepSeek key always wins.
 */
function channelSecret(env, spec) {
  const own = bareKey(env?.[spec.envKey]);
  if (own || spec.provider !== "deepseek") return own;
  return bareKey(env?.MM_DPO_KIMI_API_KEY);
}

export function channelsFromEnv(env = {}, selected) {
  const wanted = selected?.length ? selected : AB_CHANNELS.map((channel) => channel.provider);
  const out = [];
  for (const name of wanted) {
    const id = String(name ?? "").trim().toLowerCase();
    const spec = AB_CHANNELS.find((channel) => channel.provider === id);
    if (!spec) throw fail("unknown-model", `未知模型通道：${name}`);
    if (out.some((channel) => channel.provider === spec.provider)) continue;
    const model = String(env[spec.envModel] || "").trim() || spec.model;
    out.push({
      role: spec.role,
      provider: spec.provider,
      model,
      baseUrl: String(env[spec.envBaseUrl] || "").trim(),
      envKey: spec.envKey,
      secret: channelSecret(env, spec)
    });
  }
  return out;
}

export function publicChannel(channel) {
  return {
    role: channel?.role || "",
    provider: channel?.provider || "",
    model: channel?.model || "",
    envKey: channel?.envKey || "",
    hasKey: Boolean(bareKey(channel?.secret))
  };
}

export function clipParagraph(text) {
  const chars = Array.from(String(text ?? ""));
  if (chars.length <= PARAGRAPH_TEXT_MAX) return chars.join("");
  return chars.slice(0, PARAGRAPH_TEXT_MAX).join("");
}

export function latexExactMatch(latex, reference) {
  if (reference == null || String(reference).trim() === "") return null;
  if (latex == null || String(latex).trim() === "") return null;
  return String(latex) === String(reference);
}

export function latexMatchesReference(latex, reference, display = false) {
  if (reference == null || String(reference).trim() === "") return null;
  if (latex == null || String(latex).trim() === "") return null;
  return normalizeLatex(latex, display) === normalizeLatex(reference, display);
}

const MATH_WRAPPERS = "aligned|align\\*?|equation\\*?|gather\\*?|multline\\*?|displaymath|eqnarray\\*?|flalign\\*?";

function readGroup(src, open) {
  if (src[open] !== "{") return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return { inner: src.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

function readCommand(src, at) {
  if (src[at] !== "\\") return null;
  let i = at + 1;
  if (i >= src.length) return null;
  if (!/[A-Za-z]/.test(src[i])) return { name: src[i], end: i + 1 };
  while (i < src.length && /[A-Za-z]/.test(src[i])) i += 1;
  return { name: src.slice(at + 1, i), end: i };
}

function skipSpace(src, at) {
  let i = at;
  while (i < src.length && /[ \t\r\n]/.test(src[i])) i += 1;
  return i;
}

/** {\cal L} and \cal{L} become \mathcal{L}. */
function rewriteCal(src) {
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === "{") {
      const group = readGroup(src, i);
      const inner = group ? group.inner : "";
      const cal = group ? inner.match(/^\s*\\cal\s*\{([^{}]*)\}\s*$/) || inner.match(/^\s*\\cal\s+(\\[A-Za-z]+|[^\s{}])\s*$/) : null;
      if (cal) {
        out += `\\mathcal{${cal[1].replace(/\s+/g, "")}}`;
        i = group.end - 1;
        continue;
      }
    }
    const command = readCommand(src, i);
    if (command?.name === "cal") {
      const at = skipSpace(src, command.end);
      if (src[at] === "{") {
        const group = readGroup(src, at);
        if (group) {
          out += `\\mathcal{${group.inner.replace(/\s+/g, "")}}`;
          i = group.end - 1;
          continue;
        }
      }
    }
    out += src[i];
  }
  return out;
}

/** \text and \textrm fold into \mathrm. The argument stays, including different letters. */
function rewriteTextFonts(src) {
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    const command = readCommand(src, i);
    if (command && (command.name === "text" || command.name === "textrm")) {
      const at = skipSpace(src, command.end);
      if (src[at] === "{") {
        const group = readGroup(src, at);
        if (group) {
          out += `\\mathrm{${rewriteTextFonts(group.inner)}}`;
          i = group.end - 1;
          continue;
        }
      }
    }
    out += src[i];
  }
  return out;
}

/**
 * One math atom: a character, a command, or a command plus one brace group.
 * _{1} and _{\mathrm{ref}} can drop their braces. _{ref} and \pi_1 stay put.
 */
function atomText(inner) {
  const text = String(inner || "").replace(/\s+/g, "");
  if (!text) return null;
  if (/^\\[A-Za-z]+$/.test(text)) return text;
  if (/^\\[A-Za-z]+\{[^{}]*\}$/.test(text)) return text;
  if ([...text].length === 1) return text;
  return null;
}

function unwrapScriptAtoms(src) {
  let out = "";
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "_" || ch === "^") {
      const at = skipSpace(src, i + 1);
      if (src[at] === "{") {
        const group = readGroup(src, at);
        const atom = group ? atomText(group.inner) : null;
        if (atom) {
          out += ch + atom;
          i = group.end - 1;
          continue;
        }
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Scoring form. Exact match stays on the raw string.
 * Equivalent commands and packaging collapse; different symbols do not.
 */
export function canonicalizeLatex(latex) {
  let src = String(latex ?? "");
  src = src.replace(/\\label\{[^{}]*\}/g, "");
  src = src.replace(/\\tag\*?\{[^{}]*\}/g, "");
  src = src.replace(/\\nonumber\b/g, "");
  src = src.replace(/\\displaystyle\b/g, "");
  src = rewriteCal(src);
  src = rewriteTextFonts(src);
  src = src.replace(/\\[,;!]/g, "");
  src = src.replace(/\\(?:qquad|quad)\b/g, "");
  src = src.replace(/~/g, "");
  // `\\ ` is an alignment break plus a space. Consume it before the `\ ` spacer,
  // or one backslash is left behind (`=\-`).
  src = src.replace(/\\\\(?:[ \t])?/g, "");
  src = src.replace(/\\ /g, "");
  src = src.replace(/\\(?:left|right)\./g, "");
  src = src.replace(/\\(?:biggl|biggr|Biggl|Biggr|bigl|bigr|Bigl|Bigr|bigg|Bigg|big|Big|left|right)\b/g, "");
  src = src.replace(/\\mid\b/g, "|");
  src = src.replace(new RegExp(`\\\\begin\\{(?:${MATH_WRAPPERS})\\}`, "g"), "");
  src = src.replace(new RegExp(`\\\\end\\{(?:${MATH_WRAPPERS})\\}`, "g"), "");
  src = src.replace(/&/g, "");
  let prev = "";
  while (src !== prev) {
    prev = src;
    src = unwrapScriptAtoms(src);
  }
  src = src.replace(/\s+/g, "");
  src = src.replace(/[.,]+$/g, "");
  return src;
}

export function latexCanonicalMatch(latex, reference) {
  if (reference == null || String(reference).trim() === "") return null;
  if (latex == null || String(latex).trim() === "") return null;
  return canonicalizeLatex(latex) === canonicalizeLatex(reference);
}

export function costRateFor(provider, model) {
  const name = String(provider || "").trim().toLowerCase();
  const modelName = String(model || "").trim().toLowerCase();
  const exact = COST_RATES.find((rate) => rate.provider === name && rate.model === modelName);
  if (exact) return exact;
  if (name !== "kimi") return null;
  const base = COST_RATES.find((rate) => rate.provider === "kimi");
  if (!base) return null;
  return {
    provider: "kimi",
    model: modelName || base.model,
    promptUsdPerMillion: base.promptUsdPerMillion,
    completionUsdPerMillion: base.completionUsdPerMillion,
    fallback: true,
    note: "未知模型名沿用 kimi-k3 标价估算，不是账单。"
  };
}

export function estimateCostUsd(provider, model, tokens) {
  const rate = costRateFor(provider, model);
  if (!rate || !tokens) return null;
  const prompt = Number(tokens.prompt);
  const completion = Number(tokens.completion);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion)) return null;
  const usd = (prompt * rate.promptUsdPerMillion + completion * rate.completionUsdPerMillion) / 1_000_000;
  return Math.round(usd * 1e8) / 1e8;
}

export function tokensOf(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = finiteNum(usage.prompt ?? usage.prompt_tokens ?? usage.promptTokenCount);
  const completion = finiteNum(usage.completion ?? usage.completion_tokens ?? usage.candidatesTokenCount);
  let total = finiteNum(usage.total ?? usage.total_tokens ?? usage.totalTokenCount);
  if (total == null && prompt != null && completion != null) total = prompt + completion;
  if (prompt == null && completion == null && total == null) return null;
  return { prompt, completion, total };
}

function finiteNum(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

const TEXT_LABELS = new Set(["text", "heading", "caption", "title"]);

function boxCopy(value) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const box = value.slice(0, 4).map((n) => Number(n));
  if (box.some((n) => !Number.isFinite(n))) return null;
  if (!(box[2] > box[0]) || !(box[3] > box[1])) return null;
  return box;
}

function boxesCopy(value) {
  if (!Array.isArray(value)) return [];
  return value.map((box) => boxCopy(box)).filter(Boolean);
}

function unionBox(left, right) {
  const a = boxCopy(left);
  const b = boxCopy(right);
  if (!a) return b;
  if (!b) return a;
  return [
    Math.min(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[2], b[2]),
    Math.max(a[3], b[3])
  ];
}

function blockText(block) {
  return String(block?.sourceText || block?.text || "");
}

/**
 * Paragraph box and text already on the page blocks.
 * Inline formulas use their host. Display formulas use the overlapping
 * text block, or the nearest one, and the box grows to include the formula.
 */
export function paragraphGeometry(formulaBlock, blocks) {
  const list = Array.isArray(blocks) ? blocks : [];
  const own = boxCopy(formulaBlock?.bbox);
  const host = formulaBlock?.inlineOf
    ? list.find((block) => block?.id === formulaBlock.inlineOf)
    : null;
  const holder = host || list.find((block) =>
    (block?.placeholders || []).some((entry) => entry?.blockId === formulaBlock?.id)
  );
  if (holder && boxCopy(holder.bbox)) {
    return {
      id: String(holder.id || ""),
      text: blockText(holder),
      bbox: unionBox(holder.bbox, own)
    };
  }
  let best = null;
  let bestScore = Infinity;
  for (const block of list) {
    if (!TEXT_LABELS.has(block?.label) || !boxCopy(block.bbox)) continue;
    if (!blockText(block)) continue;
    if (!own) continue;
    const overlaps = block.bbox[1] <= own[3] && block.bbox[3] >= own[1]
      && block.bbox[0] <= own[2] && block.bbox[2] >= own[0];
    const vertical = Math.min(
      Math.abs(block.bbox[3] - own[1]),
      Math.abs(block.bbox[1] - own[3])
    );
    const score = overlaps ? -1 : vertical;
    if (score < bestScore) {
      bestScore = score;
      best = block;
    }
  }
  if (!best) return { id: "", text: "", bbox: own };
  return {
    id: String(best.id || ""),
    text: blockText(best),
    bbox: unionBox(best.bbox, own)
  };
}

export function formulasFromBlocks(pages) {
  const formulas = [];
  for (const entry of Array.isArray(pages) ? pages : []) {
    const page = Number(entry?.page);
    const blocks = entry?.blocks || [];
    let index = 0;
    for (const block of blocks) {
      if (block?.label !== "formula") continue;
      index += 1;
      const unit = formulaUnitFromBlock(block, { docHash: "2305.18290v3", page });
      const paragraph = paragraphGeometry(block, blocks);
      formulas.push(formulaRecord({
        id: block.id || `p${page}-${index}`,
        page,
        index,
        equationNumber: unit.equationNumber,
        display: unit.display !== false,
        pdfText: unit.pdfText || "",
        glyphs: unit.glyphs || [],
        bbox: unit.bbox,
        layoutBbox: block.layoutBbox || unit.bbox,
        glyphBoxes: block.glyphBoxes || [],
        maskBoxes: block.maskBoxes || [],
        seedBoxes: block.seedBoxes || [],
        inlineOf: block.inlineOf || "",
        formulaInkProtect: block.formulaInkProtect === true,
        reference: block.reference || null,
        imageUrl: block.imageUrl || "",
        paragraphText: block.paragraphText || paragraph.text,
        paragraphBbox: block.paragraphBbox || paragraph.bbox
      }));
    }
  }
  return formulas;
}

export function formulasFromFixture(data) {
  if (Array.isArray(data?.formulas)) {
    return data.formulas.map((formula, index) => formulaRecord({
      id: formula?.id || `f${index + 1}`,
      page: Number(formula?.page),
      index: Number(formula?.index) || index + 1,
      equationNumber: formula?.equationNumber || null,
      display: formula?.display !== false,
      pdfText: formula?.pdfText || "",
      glyphs: formula?.glyphs || [],
      bbox: formula?.bbox || null,
      layoutBbox: formula?.layoutBbox || formula?.bbox || null,
      glyphBoxes: formula?.glyphBoxes || [],
      maskBoxes: formula?.maskBoxes || [],
      seedBoxes: formula?.seedBoxes || [],
      inlineOf: formula?.inlineOf || "",
      formulaInkProtect: formula?.formulaInkProtect === true,
      reference: formula?.reference || null,
      imageUrl: formula?.imageUrl || "",
      paragraphText: formula?.paragraphText || "",
      paragraphBbox: formula?.paragraphBbox || null
    }));
  }
  if (Array.isArray(data?.pages)) return formulasFromBlocks(data.pages);
  if (Array.isArray(data)) return formulasFromBlocks(data);
  throw fail("bad-fixture", "夹具需要 formulas 或 pages");
}

function formulaRecord(formula) {
  return {
    id: String(formula.id),
    page: formula.page,
    index: formula.index,
    equationNumber: formula.equationNumber || null,
    display: formula.display !== false,
    pdfText: String(formula.pdfText || ""),
    glyphs: Array.isArray(formula.glyphs) ? formula.glyphs : [],
    bbox: boxCopy(formula.bbox),
    layoutBbox: boxCopy(formula.layoutBbox) || boxCopy(formula.bbox),
    glyphBoxes: boxesCopy(formula.glyphBoxes),
    maskBoxes: boxesCopy(formula.maskBoxes),
    seedBoxes: boxesCopy(formula.seedBoxes),
    inlineOf: formula.inlineOf ? String(formula.inlineOf) : "",
    formulaInkProtect: formula.formulaInkProtect === true,
    reference: formula.reference ? String(formula.reference) : null,
    imageUrl: typeof formula.imageUrl === "string" ? formula.imageUrl : "",
    paragraphText: typeof formula.paragraphText === "string" ? formula.paragraphText : "",
    paragraphBbox: boxCopy(formula.paragraphBbox)
  };
}

function stratumKey(formula) {
  const page = Number(formula?.page);
  const pageText = Number.isFinite(page) ? String(page).padStart(4, "0") : "9999";
  const kind = formula?.display === false ? "inline" : "display";
  return `${pageText}:${kind}`;
}

/**
 * Deterministic stratified sample. Round-robin over page × inline/display,
 * then restored to document order so a rerun of the same list picks the same ids.
 */
export function selectSample(formulas, count) {
  const list = Array.isArray(formulas) ? formulas : [];
  const wanted = Number(count);
  if (!Number.isFinite(wanted) || wanted >= list.length) return list.slice();
  if (wanted <= 0) return [];
  const strata = new Map();
  for (const formula of list) {
    const key = stratumKey(formula);
    if (!strata.has(key)) strata.set(key, []);
    strata.get(key).push(formula);
  }
  const keys = [...strata.keys()].sort();
  const cursors = new Map(keys.map((key) => [key, 0]));
  const picked = [];
  while (picked.length < wanted) {
    let moved = false;
    for (const key of keys) {
      const bucket = strata.get(key);
      const cursor = cursors.get(key);
      if (cursor >= bucket.length) continue;
      picked.push(bucket[cursor]);
      cursors.set(key, cursor + 1);
      moved = true;
      if (picked.length >= wanted) break;
    }
    if (!moved) break;
  }
  const ids = new Set(picked.map((formula) => formula.id));
  const seen = new Set();
  const out = [];
  for (const formula of list) {
    if (!ids.has(formula.id) || seen.has(formula.id)) continue;
    seen.add(formula.id);
    out.push(formula);
  }
  return out;
}

export function selectByIds(formulas, ids) {
  const list = Array.isArray(formulas) ? formulas : [];
  const byId = new Map(list.map((formula) => [formula.id, formula]));
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(ids) ? ids : []) {
    const key = String(id || "").trim();
    if (!key || seen.has(key) || !byId.has(key)) continue;
    seen.add(key);
    out.push(byId.get(key));
  }
  return out;
}

export function chooseFormulas(formulas, { limit = null, sample = null, ids = null, full = false } = {}) {
  const list = Array.isArray(formulas) ? formulas : [];
  if (Array.isArray(ids) && ids.length) {
    const chosen = selectByIds(list, ids);
    return {
      formulas: chosen,
      stratified: false,
      locked: true,
      requested: ids.length,
      ids: chosen.map((formula) => formula.id)
    };
  }
  if (full || (limit == null && sample == null)) {
    return {
      formulas: list.slice(),
      stratified: false,
      locked: false,
      requested: null,
      ids: list.map((formula) => formula.id)
    };
  }
  const count = sample ?? limit;
  const chosen = selectSample(list, count);
  return {
    formulas: chosen,
    stratified: true,
    locked: false,
    requested: count,
    ids: chosen.map((formula) => formula.id)
  };
}

export function attachReferences(formulas, table) {
  const rows = Array.isArray(table) ? table : (table?.formulas || []);
  const byId = new Map();
  const byEq = new Map();
  for (const row of rows) {
    const dropped = row?.aligned === false;
    const latex = dropped ? null : (row?.reference ?? row?.latex ?? null);
    const value = latex ? String(latex) : null;
    if (row?.id) byId.set(String(row.id), value);
    if (!dropped && row?.equationNumber && value) byEq.set(`${row.page}:${row.equationNumber}`, value);
  }
  return formulas.map((formula) => {
    const eqKey = `${formula.page}:${formula.equationNumber}`;
    let reference = formula.reference ?? null;
    if (byId.has(formula.id)) reference = byId.get(formula.id);
    else if (byEq.has(eqKey)) reference = byEq.get(eqKey);
    return { ...formula, reference: reference || null };
  });
}

export function coverageOf(formulas, sampledCount = formulas?.length || 0) {
  const list = Array.isArray(formulas) ? formulas : [];
  const pages = [...new Set(list.map((formula) => formula.page))];
  const pagesMatch = list.length > 0 && pages.every((page) => DPO_PAPER.pages.includes(page));
  const detected = list.length;
  const sampled = Number(sampledCount) || 0;
  return {
    expected: DPO_PAPER.formulaCount,
    detected,
    sampled,
    pages,
    pagesMatch,
    complete: pagesMatch
      && detected === DPO_PAPER.formulaCount
      && sampled === DPO_PAPER.formulaCount
  };
}

function cropSpec(formula) {
  return {
    id: formula.id,
    page: formula.page,
    index: formula.index,
    display: formula.display !== false,
    bbox: formula.bbox || null,
    equationNumber: formula.equationNumber || null,
    imageUrl: formula.imageUrl || ""
  };
}

function pngFromHook(cropped) {
  if (!cropped || typeof cropped !== "object") return null;
  if (cropped.pdf || cropped.pagePdf) return null;
  const mime = String(cropped.mime || "image/png").toLowerCase();
  if (mime !== "image/png") return null;
  if (cropped.base64) return parseCropDataUrl(`data:image/png;base64,${cropped.base64}`);
  return parseCropDataUrl(cropped.url || cropped.imageUrl || "");
}

function inputResult(partial) {
  return {
    ready: false,
    measured: false,
    placeholder: false,
    inputKind: "none",
    reason: "",
    image: null,
    system: "",
    text: "",
    ...partial
  };
}

async function tightInput(formula, options = {}) {
  const fromUrl = await cropPngFor({ imageUrl: formula.imageUrl || "" });
  if (fromUrl) {
    return inputResult({
      ready: true,
      measured: true,
      inputKind: "tight",
      image: fromUrl,
      system: FORMULA_VISION_SYSTEM,
      text: formulaVisionText(formula)
    });
  }
  if (typeof options.renderTightCrop === "function") {
    let cropped = null;
    try {
      cropped = await options.renderTightCrop(formula);
    } catch {
      return inputResult({ inputKind: "tight", reason: "tight-crop-failed" });
    }
    const png = pngFromHook(cropped);
    if (!png) return inputResult({ inputKind: "tight", reason: "no-crop" });
    return inputResult({
      ready: true,
      measured: true,
      inputKind: "tight",
      image: png,
      system: FORMULA_VISION_SYSTEM,
      text: formulaVisionText(formula)
    });
  }
  return inputResult({
    inputKind: "tight",
    reason: "no-crop"
  });
}

async function hookedInput(arm, formula, visionCropFor) {
  const spec = cropSpec(formula);
  if (arm === "paragraph") spec.paragraphText = formula.paragraphText || "";
  let cropped = null;
  try {
    cropped = await visionCropFor(spec, { mode: arm, page: false });
  } catch {
    return inputResult({
      inputKind: arm,
      placeholder: true,
      reason: "vision-crop-failed"
    });
  }
  if (!cropped) return null;
  const png = pngFromHook(cropped);
  if (!png) {
    return inputResult({
      inputKind: arm,
      placeholder: true,
      reason: "refused-non-png"
    });
  }
  const paragraph = arm === "paragraph"
    ? clipParagraph(cropped.paragraphText || formula.paragraphText || "")
    : "";
  const system = arm === "paragraph"
    ? `${FORMULA_VISION_SYSTEM}\n${PARAGRAPH_PROMPT_NOTE}`
    : FORMULA_VISION_SYSTEM;
  const text = paragraph ? `${formulaVisionText(formula)}\n${paragraph}` : formulaVisionText(formula);
  return inputResult({
    ready: true,
    measured: true,
    inputKind: arm,
    image: png,
    system,
    text
  });
}

function visionBlock(formula) {
  return {
    id: formula.id,
    label: "formula",
    page: formula.page,
    display: formula.display !== false,
    inlineOf: formula.inlineOf || "",
    formulaInkProtect: formula.formulaInkProtect === true,
    bbox: formula.layoutBbox || formula.bbox || null,
    layoutBbox: formula.layoutBbox || formula.bbox || null,
    glyphBoxes: formula.glyphBoxes || [],
    maskBoxes: formula.maskBoxes || [],
    seedBoxes: formula.seedBoxes || []
  };
}

async function tightPlaceholder(arm, formula) {
  const png = await cropPngFor({ imageUrl: formula.imageUrl || "" });
  if (!png) return null;
  return inputResult({
    ready: true,
    measured: false,
    placeholder: true,
    inputKind: "tight-placeholder",
    reason: PENDING_REASON[arm],
    image: png,
    system: FORMULA_VISION_SYSTEM,
    text: formulaVisionText(formula)
  });
}

function pendingInput(arm) {
  return inputResult({
    inputKind: arm,
    placeholder: true,
    reason: PENDING_REASON[arm] || "unknown-arm"
  });
}

async function hiResInput(formula, options) {
  if (typeof options.visionCropFor === "function") {
    const hooked = await hookedInput("hi-res", formula, options.visionCropFor);
    if (hooked) return hooked;
  }
  if (typeof options.renderVisionCrop === "function") {
    const block = visionBlock(formula);
    let png = null;
    try {
      png = await visionCropFor(block, {
        scale: VISION_CROP_SCALE,
        renderVisionCrop: (item, spec) => options.renderVisionCrop(item, spec)
      });
    } catch {
      png = null;
    }
    if (png?.meta?.kind === "vision" && png.mime === "image/png" && png.base64 && !/^https?:/i.test(png.base64)) {
      return inputResult({
        ready: true,
        measured: true,
        inputKind: "hi-res",
        image: png,
        system: FORMULA_VISION_SYSTEM,
        text: formulaVisionText(formula)
      });
    }
  }
  if (options.placeholderUsesTight === true) {
    const placeholder = await tightPlaceholder("hi-res", formula);
    if (placeholder) return placeholder;
  }
  return pendingInput("hi-res");
}

function paragraphPrompt(formula, paragraph) {
  const system = `${FORMULA_VISION_SYSTEM}\n${PARAGRAPH_PROMPT_NOTE}`;
  const text = paragraph
    ? `${formulaVisionText(formula)}\n${paragraph}`
    : formulaVisionText(formula);
  return { system, text };
}

async function paragraphInput(formula, options) {
  if (typeof options.visionCropFor === "function") {
    const hooked = await hookedInput("paragraph", formula, options.visionCropFor);
    if (hooked) return hooked;
  }
  if (typeof options.renderParagraphCrop === "function") {
    let cropped = null;
    try {
      cropped = await options.renderParagraphCrop(formula);
    } catch {
      return inputResult({
        inputKind: "paragraph",
        placeholder: true,
        reason: "paragraph-crop-failed"
      });
    }
    const png = pngFromHook(cropped);
    if (!png) {
      return inputResult({
        inputKind: "paragraph",
        placeholder: true,
        reason: cropped ? "refused-non-png" : "paragraph-crop-failed"
      });
    }
    const paragraph = clipParagraph(cropped?.paragraphText || formula.paragraphText || "");
    if (!paragraph) {
      return inputResult({
        inputKind: "paragraph",
        placeholder: true,
        reason: "no-paragraph-text",
        image: png
      });
    }
    const prompt = paragraphPrompt(formula, paragraph);
    return inputResult({
      ready: true,
      measured: true,
      inputKind: "paragraph",
      image: png,
      system: prompt.system,
      text: prompt.text
    });
  }
  if (options.placeholderUsesTight === true) {
    const placeholder = await tightPlaceholder("paragraph", formula);
    if (placeholder) return placeholder;
  }
  return pendingInput("paragraph");
}

async function prepareInput(arm, formula, options) {
  if (arm === "page") {
    return inputResult({
      inputKind: "page-stub",
      placeholder: true,
      reason: PENDING_REASON.page
    });
  }
  if (arm === "tight") return tightInput(formula, options);
  if (arm === "hi-res") return hiResInput(formula, options);
  if (arm === "paragraph") return paragraphInput(formula, options);
  return inputResult({ reason: "unknown-arm" });
}

function verifyShape(reason, extra = {}) {
  return {
    checked: extra.checked === true,
    pass: extra.pass === true,
    reason: reason ?? null,
    jaccard: extra.jaccard ?? null
  };
}

function blankRow(formula, arm, channel) {
  return {
    id: formula.id,
    page: formula.page,
    index: formula.index,
    arm,
    provider: channel.provider,
    model: channel.model,
    latex: null,
    verify: verifyShape(null),
    paint: "none",
    exactMatch: null,
    matchesReference: null,
    canonicalMatch: null,
    latencyMs: 0,
    tokens: null,
    checkedButMismatch: false,
    role: channel.role || "",
    equationNumber: formula.equationNumber || null,
    inputKind: "none",
    placeholder: false,
    measured: false,
    sent: false,
    errorCode: "",
    cropHash: ""
  };
}

function knownSecrets(channels) {
  const out = [];
  for (const channel of channels) {
    const key = bareKey(channel?.secret);
    if (key.length >= 6 && !out.includes(key)) out.push(key);
  }
  return out.sort((a, b) => b.length - a.length);
}

function redact(text, secrets) {
  let raw = String(text ?? "");
  for (const secret of secrets) raw = raw.split(secret).join("***");
  return raw;
}

function hasSecret(text, secrets) {
  const raw = String(text ?? "");
  return secrets.some((secret) => raw.includes(secret));
}

function abortedRow(formula, arm, channel, input) {
  const row = blankRow(formula, arm, channel);
  row.inputKind = input?.inputKind || (arm === "page" ? "page-stub" : arm);
  row.placeholder = input?.placeholder === true || arm !== "tight";
  row.cropHash = input?.image?.hash || "";
  row.errorCode = "aborted";
  row.verify = verifyShape("aborted");
  return applyReference(row, formula);
}

function applyReference(row, formula) {
  row.exactMatch = latexExactMatch(row.latex, formula.reference);
  row.matchesReference = latexMatchesReference(row.latex, formula.reference, formula.display !== false);
  row.canonicalMatch = latexCanonicalMatch(row.latex, formula.reference);
  row.checkedButMismatch = row.verify.pass === true && row.canonicalMatch === false;
  return row;
}

function elapsed(now, start) {
  const end = Number(now());
  const began = Number(start);
  if (!Number.isFinite(end) || !Number.isFinite(began)) return 0;
  return Math.max(0, end - began);
}

async function oneCall(formula, arm, channel, input, options, secrets) {
  const row = blankRow(formula, arm, channel);
  row.inputKind = input.inputKind;
  row.placeholder = input.placeholder === true;
  row.cropHash = input.image?.hash || "";
  const secret = bareKey(channel.secret);
  if (!input.ready) {
    row.verify = verifyShape(input.reason);
    row.errorCode = input.reason || "";
    return applyReference(row, formula);
  }
  if (!secret) {
    row.verify = verifyShape("empty-key");
    row.errorCode = "empty-key";
    return applyReference(row, formula);
  }
  if (options.send !== true) {
    row.verify = verifyShape("dry-run");
    row.errorCode = "dry-run";
    return applyReference(row, formula);
  }
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const start = now();
  let response;
  try {
    response = await options.transport({
      id: formula.id,
      page: formula.page,
      index: formula.index,
      arm,
      provider: channel.provider,
      model: channel.model,
      system: input.system,
      text: input.text,
      image: {
        mime: input.image.mime,
        base64: input.image.base64,
        w: input.image.w,
        h: input.image.h,
        hash: input.image.hash
      },
      baseUrl: channel.baseUrl || "",
      secret,
      signal: options.signal
    });
  } catch {
    response = { ok: false, error: { code: options.signal?.aborted ? "aborted" : "http" } };
  }
  row.latencyMs = elapsed(now, start);
  if (options.signal?.aborted) {
    row.sent = true;
    row.measured = false;
    row.paint = "none";
    row.latex = null;
    row.tokens = tokensOf(response?.usage);
    row.errorCode = "aborted";
    row.verify = verifyShape("aborted");
    return applyReference(row, formula);
  }
  row.sent = true;
  row.measured = input.measured === true;
  row.tokens = tokensOf(response?.usage);
  if (!response || response.ok !== true) {
    row.errorCode = String(response?.error?.code || "http");
    row.paint = "crop";
    row.verify = verifyShape(row.errorCode);
    return applyReference(row, formula);
  }
  if (hasSecret(response.text, secrets)) {
    row.errorCode = "secret";
    row.paint = "crop";
    row.verify = verifyShape("unreadable");
    return applyReference(row, formula);
  }
  const parsed = parseLatexCandidate(redact(response.text, secrets));
  if (!parsed.ok) {
    row.errorCode = parsed.reason || "unreadable";
    row.paint = "crop";
    row.verify = verifyShape(row.errorCode);
    return applyReference(row, formula);
  }
  row.latex = redact(parsed.latex, secrets);
  const verdict = verifyCandidate(row.latex, {
    pdfText: formula.pdfText || "",
    glyphs: formula.glyphs || [],
    display: formula.display !== false,
    equationNumber: formula.equationNumber || null
  }, options.katex);
  const jaccard = verdict?.checks?.charset?.jaccard;
  row.verify = verifyShape(verdict.reason, {
    checked: true,
    pass: verdict.pass === true,
    jaccard: typeof jaccard === "number" ? jaccard : null
  });
  row.paint = verdict.pass === true ? "katex" : "crop";
  row.errorCode = verdict.pass === true ? "" : (verdict.reason || "charset-mismatch");
  return applyReference(row, formula);
}

function groupKey(arm, provider, model) {
  return `${arm}\0${provider}\0${model}`;
}

function blankGroup(arm, channel) {
  return {
    arm,
    provider: channel.provider,
    model: channel.model,
    role: channel.role || "",
    rows: 0,
    sent: 0,
    measured: 0,
    verified: 0,
    referenceCompared: 0,
    matchesReference: 0,
    canonicalMatches: 0,
    exactMatches: 0,
    checkedButMismatch: 0,
    failures: 0,
    latencyMsTotal: 0,
    latencyMsMean: 0,
    promptTokens: 0,
    completionTokens: 0,
    tokensTotal: 0,
    pricedRows: 0,
    estimatedCostUsd: null
  };
}

export function summarizeRows(rows, arms, channels) {
  const groups = new Map();
  const ensure = (arm, channel) => {
    const key = groupKey(arm, channel.provider, channel.model);
    if (!groups.has(key)) groups.set(key, blankGroup(arm, channel));
    return groups.get(key);
  };
  for (const arm of arms) {
    for (const channel of channels) ensure(arm, channel);
  }
  for (const row of rows) {
    const group = ensure(row.arm, row);
    group.rows += 1;
    if (row.sent) {
      group.sent += 1;
      group.latencyMsTotal += Number(row.latencyMs) || 0;
      group.tokensTotal += Number(row.tokens?.total) || 0;
      if (Number.isFinite(row.tokens?.prompt) && Number.isFinite(row.tokens?.completion)) {
        group.promptTokens += row.tokens.prompt;
        group.completionTokens += row.tokens.completion;
        group.pricedRows += 1;
      }
      if (row.latex == null) group.failures += 1;
    }
    if (row.measured) group.measured += 1;
    if (row.measured && row.verify?.pass === true) group.verified += 1;
    if (row.measured && row.canonicalMatch !== null) {
      group.referenceCompared += 1;
      if (row.matchesReference === true) group.matchesReference += 1;
      if (row.canonicalMatch === true) group.canonicalMatches += 1;
      if (row.exactMatch === true) group.exactMatches += 1;
    }
    if (row.measured && row.checkedButMismatch === true) group.checkedButMismatch += 1;
  }
  for (const group of groups.values()) {
    group.latencyMsMean = group.sent ? group.latencyMsTotal / group.sent : 0;
    group.estimatedCostUsd = group.pricedRows > 0
      ? estimateCostUsd(group.provider, group.model, {
        prompt: group.promptTokens,
        completion: group.completionTokens
      })
      : null;
  }
  return [...groups.values()];
}

export function inputDecision(groups) {
  const list = Array.isArray(groups) ? groups : [];
  const pick = (arm) => list.find((group) =>
    group.arm === arm && group.provider === "kimi" && (group.model === "kimi-k3" || group.role === "primary")
  );
  const hi = pick("hi-res");
  const paragraph = pick("paragraph");
  const result = {
    id: "D2",
    rule: "paragraph 只有在 Kimi K3 上规范形准确率明显高于 hi-res 时才作为建议默认；否则建议 hi-res。本报告不改产品默认。",
    margin: D2_CLEAR_MARGIN,
    clearlyBetter: null,
    suggestedArm: null,
    hiResNormalized: null,
    paragraphNormalized: null,
    productDefault: false,
    writesPreset: false
  };
  if (!hi || !paragraph || !(hi.referenceCompared > 0) || !(paragraph.referenceCompared > 0)) return result;
  const hiRate = accuracyCount(hi) / hi.referenceCompared;
  const paragraphRate = accuracyCount(paragraph) / paragraph.referenceCompared;
  result.hiResNormalized = hiRate;
  result.paragraphNormalized = paragraphRate;
  result.clearlyBetter = (paragraphRate - hiRate) + D2_RATE_EPSILON >= D2_CLEAR_MARGIN;
  result.suggestedArm = result.clearlyBetter ? "paragraph" : "hi-res";
  return result;
}

function accuracyCount(group) {
  if (Number.isFinite(Number(group?.canonicalMatches))) return Number(group.canonicalMatches);
  return Number(group?.matchesReference) || 0;
}

function rateOf(group) {
  if (!group.referenceCompared) return null;
  return accuracyCount(group) / group.referenceCompared;
}

function pickGroup(groups, pageOnly) {
  let best = null;
  for (const group of groups) {
    const isPage = group.arm === "page";
    if (pageOnly !== isPage) continue;
    if (!(group.measured > 0)) continue;
    const rate = rateOf(group);
    if (rate == null) continue;
    const verifiedRate = group.sent ? group.verified / group.sent : 0;
    const latency = group.sent ? group.latencyMsTotal / group.sent : Number.POSITIVE_INFINITY;
    const candidate = { group, rate, verifiedRate, latency };
    if (!best || better(candidate, best)) best = candidate;
  }
  return best;
}

function better(next, prev) {
  if (next.rate !== prev.rate) return next.rate > prev.rate;
  if (next.verifiedRate !== prev.verifiedRate) return next.verifiedRate > prev.verifiedRate;
  if (next.latency !== prev.latency) return next.latency < prev.latency;
  return next.group.role === "primary" && prev.group.role !== "primary";
}

export function recommend(groups, { complete = false } = {}) {
  const product = pickGroup(groups, false);
  const page = pickGroup(groups, true);
  const result = {
    arm: null,
    provider: null,
    model: null,
    reason: "no-measured-rows",
    provisional: complete !== true,
    productDefault: false,
    writesPreset: false,
    note: "本脚手架不改设置预置，也不因分数挡合入。整页臂不能成为产品默认。",
    pageLab: null
  };
  if (page) {
    result.pageLab = {
      arm: "page",
      provider: page.group.provider,
      model: page.group.model,
      scriptOnly: true
    };
  }
  const measuredProduct = groups.some((group) => group.arm !== "page" && group.measured > 0);
  if (!product) {
    if (measuredProduct) result.reason = "no-reference";
    return result;
  }
  result.arm = product.group.arm;
  result.provider = product.group.provider;
  result.model = product.group.model;
  result.reason = "highest-reference-match";
  return result;
}

function referenceSummary(formulas) {
  const list = Array.isArray(formulas) ? formulas : [];
  const unaligned = list.filter((formula) => !formula.reference).map((formula) => formula.id);
  return { aligned: list.length - unaligned.length, unaligned };
}

function exampleRow() {
  return {
    id: "example",
    page: 3,
    index: 1,
    arm: "tight",
    provider: "kimi",
    model: "kimi-k3",
    latex: "x",
    verify: verifyShape(null, { checked: true, pass: true, jaccard: 1 }),
    paint: "katex",
    exactMatch: false,
    matchesReference: false,
    canonicalMatch: false,
    latencyMs: 0,
    tokens: { prompt: 0, completion: 0, total: 0 },
    checkedButMismatch: true,
    example: true
  };
}

export function buildReport({
  mode = "dry-run",
  generatedAt = null,
  formulas = [],
  arms = DEFAULT_ARMS,
  channels = [],
  rows = [],
  coverage = null,
  sample = null,
  includeExample = false
} = {}) {
  const armList = arms.slice();
  const publicChannels = channels.map(publicChannel);
  const byArmModel = summarizeRows(rows, armList, channels);
  const covered = coverage || coverageOf(formulas, rows.length ? new Set(rows.map((row) => row.id)).size : 0);
  const summary = {
    checkedButMismatch: rows.filter((row) => row.measured && row.checkedButMismatch === true).length,
    sent: rows.filter((row) => row.sent === true).length,
    failures: rows.filter((row) => row.sent === true && row.latex == null).length,
    verified: rows.filter((row) => row.measured && row.verify?.pass === true).length,
    byArmModel,
    recommended: recommend(byArmModel, { complete: covered.complete === true }),
    inputDecision: inputDecision(byArmModel)
  };
  const report = {
    schema: REPORT_SCHEMA,
    mode,
    generatedAt,
    paper: {
      arxiv: DPO_PAPER.arxiv,
      version: DPO_PAPER.version,
      pages: DPO_PAPER.pages.slice()
    },
    expectedFormulaCount: DPO_PAPER.formulaCount,
    productSendsPage: false,
    writesPreset: false,
    vision: {
      tier: MM_TIER_VERSION,
      scale: VISION_CROP_SCALE,
      tight: "measureFormulaCrop",
      hiRes: "visionCropFor",
      paragraph: "script-only"
    },
    sample: sample || { stratified: false, locked: false, requested: null, ids: [] },
    references: referenceSummary(formulas),
    costRates: COST_RATES.map((rate) => ({ ...rate })),
    coverage: covered,
    arms: armList,
    armGuide: ARM_GUIDE.map((item) => ({ ...item })),
    channels: publicChannels,
    fieldGuide: { ...FIELD_GUIDE },
    rowFields: ROW_FIELDS.slice(),
    rows,
    summary
  };
  if (includeExample) report.exampleRow = exampleRow();
  return report;
}

function referenceById(table) {
  const rows = Array.isArray(table) ? table : (table?.formulas || []);
  const byId = new Map();
  for (const row of rows) {
    if (row?.id) byId.set(String(row.id), row);
  }
  return byId;
}

function referenceOf(row) {
  if (!row || row.aligned === false) return null;
  const latex = row.reference ?? row.latex ?? null;
  return latex ? String(latex) : null;
}

function storedReference(row) {
  const latex = row?.reference;
  return typeof latex === "string" && latex.trim() ? latex : null;
}

/**
 * The 2026-10-23 report stored the pre-font-load ids. Those page-3 numbers
 * now name different blocks. When the report's detected count is that
 * generation, score against the reference content saved under legacy.
 */
function referenceTableFor(report, table) {
  const legacy = table?.legacy;
  const detected = Number(report?.coverage?.detected);
  if (legacy && detected === Number(legacy.detected) && Array.isArray(legacy.formulas)) {
    return { formulas: legacy.formulas };
  }
  return table;
}

/**
 * Recompute exact / whitespace / canonical scores from a saved report.
 * Uses the reference table already on disk. Does not send or open a PDF.
 * A report that stored its own reference string is scored on that content.
 */
export function rescoreReport(report, table) {
  const source = report && typeof report === "object" ? report : {};
  const byId = referenceById(referenceTableFor(source, table));
  const rows = (Array.isArray(source.rows) ? source.rows : []).map((row) => {
    const known = byId.get(String(row?.id || ""));
    const reference = storedReference(row) || referenceOf(known);
    const display = known?.display !== false;
    const next = { ...row };
    next.exactMatch = latexExactMatch(row?.latex, reference);
    next.matchesReference = latexMatchesReference(row?.latex, reference, display);
    next.canonicalMatch = latexCanonicalMatch(row?.latex, reference);
    next.checkedButMismatch = next.verify?.pass === true && next.canonicalMatch === false;
    return next;
  });
  const sampleIds = source.sample?.ids?.length
    ? source.sample.ids
    : [...new Set(rows.map((row) => row.id))];
  const formulas = sampleIds.map((id) => ({
    id,
    reference: referenceOf(byId.get(String(id)))
  }));
  const channels = (source.channels || []).map((channel) => ({
    ...channel,
    secret: channel?.hasKey ? "present" : ""
  }));
  return buildReport({
    mode: "rescore",
    generatedAt: source.generatedAt ?? null,
    formulas,
    arms: source.arms || [],
    channels,
    rows,
    coverage: source.coverage || null,
    sample: source.sample || null
  });
}

export async function runAb(options = {}) {
  const formulas = Array.isArray(options.formulas) ? options.formulas : [];
  const arms = resolveArms(options.arms);
  const channels = Array.isArray(options.models) ? options.models : [];
  if (options.send === true && typeof options.transport !== "function") {
    throw fail("no-transport", "真跑需要传输层");
  }
  const secrets = knownSecrets(channels);
  const rows = [];
  for (const formula of formulas) {
    for (const arm of arms) {
      if (options.signal?.aborted) {
        for (const channel of channels) rows.push(abortedRow(formula, arm, channel));
        continue;
      }
      const input = await prepareInput(arm, formula, options);
      for (const channel of channels) {
        if (options.signal?.aborted) {
          rows.push(abortedRow(formula, arm, channel, input));
          continue;
        }
        rows.push(await oneCall(formula, arm, channel, input, options, secrets));
      }
    }
  }
  return buildReport({
    mode: options.mode || (options.send === true ? "live" : "dry-run"),
    generatedAt: options.generatedAt ?? null,
    formulas,
    arms,
    channels,
    rows,
    coverage: options.coverage || coverageOf(formulas, formulas.length),
    sample: options.sample || null,
    includeExample: options.includeExample === true
  });
}

export function templateReport() {
  return buildReport({
    mode: "template",
    generatedAt: null,
    formulas: [],
    arms: DEFAULT_ARMS.slice(),
    channels: AB_CHANNELS.map((channel) => ({ ...channel, secret: "" })),
    rows: [],
    coverage: coverageOf([], 0),
    includeExample: true
  });
}

function cell(value) {
  return String(value ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function tokenText(tokens) {
  if (!tokens) return "—";
  return `${tokens.prompt ?? "—"}/${tokens.completion ?? "—"}/${tokens.total ?? "—"}`;
}

function paintText(paint) {
  if (paint === "katex") return "katex（核对通过，上屏 KaTeX）";
  if (paint === "crop") return "crop（核对不过或调用失败，静默裁图）";
  return "none（未发送，不上屏）";
}

function matchText(value) {
  if (value === true) return "true";
  if (value === false) return "false";
  return "null";
}

export function reportToMarkdown(report) {
  const lines = [
    "# DPO 多模态 A/B 报告",
    "",
    `schema: \`${report.schema}\` · mode: \`${report.mode}\``,
    "",
    `论文 arXiv ${report.paper.arxiv}${report.paper.version}，页 ${report.paper.pages.join("、")}。参考公式数 ${report.expectedFormulaCount}（不是合入门槛）。`,
    "",
    "整页臂默认关闭，必须 `--arm=page`。脚本不发送整页 PDF。本报告不进扩展包，也不改设置预置。",
    "",
    `高清裁图：tier \`${report.vision?.tier || ""}\`，scale ${report.vision?.scale ?? "—"}，路径 ${report.vision?.hiRes || "—"}。段落臂是脚本实验。`,
    "",
    "## 字段",
    "",
    "| 计划 §5 | JSON |",
    "| --- | --- |",
    "| LaTeX | `latex` |",
    "| 核对 | `verify` |",
    "| 上屏方式 | `paint` |",
    "| 与参考一致? | `matchesReference`（只去空白）/ `canonicalMatch`（规范形，D2 用这个） |",
    "| 耗时 | `latencyMs` |",
    "| token | `tokens` |",
    `| 核对过但与参考不一致 | \`checkedButMismatch\`（汇总 ${report.summary.checkedButMismatch}） |`,
    "",
    `核对过但与参考不一致：${report.summary.checkedButMismatch}`,
    ""
  ];
  lines.push("## 输入臂", "");
  for (const arm of report.armGuide || []) {
    const flag = arm.requiresFlag ? `，需要 \`${arm.requiresFlag}\`` : "";
    lines.push(`- \`${arm.id}\`${arm.default ? "（默认）" : ""}${flag}：${arm.note}`);
  }
  lines.push("", "## 通道", "");
  for (const channel of report.channels || []) {
    lines.push(`- ${channel.role} \`${channel.provider}\` / \`${channel.model}\` · ${channel.envKey} · hasKey=${channel.hasKey}`);
  }
  const sample = report.sample || { ids: [] };
  lines.push("", "## 样本", "");
  lines.push(`stratified=${sample.stratified === true} locked=${sample.locked === true} requested=${sample.requested ?? "—"} count=${(sample.ids || []).length}`);
  lines.push((sample.ids || []).length ? (sample.ids || []).join(", ") : "（无）");
  const refs = report.references || { aligned: 0, unaligned: [] };
  const missed = refs.unaligned || [];
  lines.push("", "## 参考", "");
  lines.push(`对齐 ${refs.aligned ?? 0}。未对齐 ${missed.length}（不计入准确率）：${missed.length ? missed.join(", ") : "（无）"}`);
  lines.push("", "## 估价", "");
  for (const rate of report.costRates || []) {
    lines.push(`- \`${rate.provider}\` / \`${rate.model}\`：输入 $${rate.promptUsdPerMillion}/百万，输出 $${rate.completionUsdPerMillion}/百万。${rate.note}`);
  }
  lines.push("", `失败（已发送但没有 LaTeX）：${report.summary.failures ?? 0}`, "");
  lines.push("## 分臂汇总", "");
  lines.push("| arm | provider | model | sent | verified | 逐字一致 | 去空白 | 规范形 | 核对过但与参考不一致 | 失败 | 耗时合计 | token 合计 | 估算美元 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const group of report.summary.byArmModel || []) {
    const cost = group.estimatedCostUsd == null ? "—" : group.estimatedCostUsd;
    const canonical = group.canonicalMatches ?? 0;
    lines.push(`| ${cell(group.arm)} | ${cell(group.provider)} | ${cell(group.model)} | ${group.sent} | ${group.verified} | ${group.exactMatches}/${group.referenceCompared} | ${group.matchesReference}/${group.referenceCompared} | ${canonical}/${group.referenceCompared} | ${group.checkedButMismatch} | ${group.failures} | ${group.latencyMsTotal} | ${group.tokensTotal} | ${cost} |`);
  }
  const recommended = report.summary.recommended || {};
  lines.push(
    "",
    "## 推荐",
    "",
    `arm=${recommended.arm || "—"} provider=${recommended.provider || "—"} model=${recommended.model || "—"} reason=${recommended.reason}`,
    "",
    recommended.note || "",
    "",
    `writesPreset=${recommended.writesPreset} productDefault=${recommended.productDefault} provisional=${recommended.provisional}`,
    ""
  );
  const decision = report.summary.inputDecision || {};
  lines.push(
    "## D2",
    "",
    decision.rule || "",
    "",
    `suggestedArm=${decision.suggestedArm || "—"} clearlyBetter=${decision.clearlyBetter ?? "null"} hi-res=${decision.hiResNormalized ?? "—"} paragraph=${decision.paragraphNormalized ?? "—"}`,
    "",
    `writesPreset=${decision.writesPreset} productDefault=${decision.productDefault}`,
    ""
  );
  if (recommended.pageLab) {
    lines.push(`整页实验室对照（不是产品默认）：${recommended.pageLab.provider} / ${recommended.pageLab.model}`, "");
  }
  if (report.exampleRow) {
    lines.push("## 示例", "", "示例不计入汇总。", "", ...rowLines(report.exampleRow), "");
  }
  lines.push("## 逐条", "");
  if (!report.rows?.length) lines.push("（无）", "");
  for (const row of report.rows || []) lines.push(...rowLines(row), "");
  return `${lines.join("\n")}\n`;
}

function rowLines(row) {
  return [
    `### ${row.id} · ${row.arm} · ${row.provider}/${row.model}`,
    "",
    `- LaTeX: ${row.latex == null ? "—" : `\`${cell(row.latex)}\``}`,
    `- 核对: checked=${row.verify?.checked} pass=${row.verify?.pass} reason=${row.verify?.reason || "—"} jaccard=${row.verify?.jaccard ?? "—"}`,
    `- 上屏方式: ${paintText(row.paint)}`,
    `- 与参考一致（逐字）: ${matchText(row.exactMatch)}`,
    `- 与参考一致（去空白）: ${matchText(row.matchesReference)}`,
    `- 与参考一致（规范形）: ${matchText(row.canonicalMatch)}`,
    `- 耗时: ${row.latencyMs} ms`,
    `- token: ${tokenText(row.tokens)}`,
    `- 核对过但与参考不一致: ${row.checkedButMismatch === true}`
  ];
}

export function reportToJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
