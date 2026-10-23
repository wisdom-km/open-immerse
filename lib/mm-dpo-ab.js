/**
 * Lab report for the DPO multimodal A/B (arXiv 2305.18290v3, pages 3–5,
 * 79 formulas). Pure: no network, no process.env, no cache writes.
 *
 * The CLI in tools/mm-dpo-reference.mjs is the only entry that can send.
 * Tight crops go through the existing cropPngFor path. Hi-res and paragraph
 * stay placeholders until a visionCropFor hook exists (F7W-1 / F7W-3).
 * The page arm is script-only, off unless named, and never attaches a PDF.
 */

import { cropPngFor, parseCropDataUrl } from "./formula-crop-png.js";
import { formulaUnitFromBlock } from "./formula-schedule.js";
import { FORMULA_VISION_SYSTEM, formulaVisionText } from "./formula-tiers/multimodal.js";
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
  "matchesReference",
  "latencyMs",
  "tokens",
  "checkedButMismatch"
]);

export const ARM_GUIDE = Object.freeze([
  Object.freeze({
    id: "tight",
    default: true,
    sendsPdf: false,
    note: "现有紧裁 PNG，走 cropPngFor。默认臂。"
  }),
  Object.freeze({
    id: "hi-res",
    default: false,
    sendsPdf: false,
    pending: "F7W-1",
    note: "高清裁图。产品路径未落地时不发送，除非另接 visionCropFor。"
  }),
  Object.freeze({
    id: "paragraph",
    default: false,
    sendsPdf: false,
    pending: "F7W-3",
    note: "段落图加段落文字。产品路径未落地时不发送。"
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
  matchesReference: "与参考 LaTeX 归一化后是否一致。缺参考或没有候选时为 null。",
  latencyMs: "这一次模型请求的耗时（毫秒）。未发送为 0。",
  tokens: "token：prompt / completion / total。没有用量时为 null。",
  checkedButMismatch: "核对通过，但与参考不一致。汇总字段是这个标志的条数。"
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
      secret: bareKey(env[spec.envKey])
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

export function latexMatchesReference(latex, reference, display = false) {
  if (reference == null || String(reference).trim() === "") return null;
  if (latex == null || String(latex).trim() === "") return null;
  return normalizeLatex(latex, display) === normalizeLatex(reference, display);
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

export function formulasFromBlocks(pages) {
  const formulas = [];
  for (const entry of Array.isArray(pages) ? pages : []) {
    const page = Number(entry?.page);
    let index = 0;
    for (const block of entry?.blocks || []) {
      if (block?.label !== "formula") continue;
      index += 1;
      const unit = formulaUnitFromBlock(block, { docHash: "2305.18290v3", page });
      formulas.push(formulaRecord({
        id: block.id || `p${page}-${index}`,
        page,
        index,
        equationNumber: unit.equationNumber,
        display: unit.display !== false,
        pdfText: unit.pdfText || "",
        glyphs: unit.glyphs || [],
        bbox: unit.bbox,
        reference: block.reference || null,
        imageUrl: block.imageUrl || "",
        paragraphText: block.paragraphText || ""
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
      reference: formula?.reference || null,
      imageUrl: formula?.imageUrl || "",
      paragraphText: formula?.paragraphText || ""
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
    bbox: formula.bbox || null,
    reference: formula.reference ? String(formula.reference) : null,
    imageUrl: typeof formula.imageUrl === "string" ? formula.imageUrl : "",
    paragraphText: typeof formula.paragraphText === "string" ? formula.paragraphText : ""
  };
}

export function attachReferences(formulas, table) {
  const rows = Array.isArray(table) ? table : (table?.formulas || []);
  const byId = new Map();
  const byEq = new Map();
  for (const row of rows) {
    const latex = row?.reference ?? row?.latex ?? null;
    const value = latex ? String(latex) : null;
    if (row?.id) byId.set(String(row.id), value);
    if (row?.equationNumber) byEq.set(`${row.page}:${row.equationNumber}`, value);
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

async function tightInput(formula) {
  const png = await cropPngFor({ imageUrl: formula.imageUrl || "" });
  if (!png) {
    return inputResult({
      inputKind: "tight",
      reason: "no-crop"
    });
  }
  return inputResult({
    ready: true,
    measured: true,
    inputKind: "tight",
    image: png,
    system: FORMULA_VISION_SYSTEM,
    text: formulaVisionText(formula)
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

async function prepareInput(arm, formula, options) {
  if (arm === "page") {
    return inputResult({
      inputKind: "page-stub",
      placeholder: true,
      reason: PENDING_REASON.page
    });
  }
  if (arm === "tight") return tightInput(formula);
  if (arm !== "hi-res" && arm !== "paragraph") {
    return inputResult({ reason: "unknown-arm" });
  }
  if (typeof options.visionCropFor === "function") {
    const hooked = await hookedInput(arm, formula, options.visionCropFor);
    if (hooked) return hooked;
  }
  if (options.placeholderUsesTight === true) {
    const png = await cropPngFor({ imageUrl: formula.imageUrl || "" });
    if (png) {
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
  }
  return inputResult({
    inputKind: arm,
    placeholder: true,
    reason: PENDING_REASON[arm]
  });
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
    matchesReference: null,
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
  row.matchesReference = latexMatchesReference(row.latex, formula.reference, formula.display !== false);
  row.checkedButMismatch = row.verify.pass === true && row.matchesReference === false;
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
    checkedButMismatch: 0,
    latencyMsTotal: 0,
    tokensTotal: 0
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
    }
    if (row.measured) group.measured += 1;
    if (row.measured && row.verify?.pass === true) group.verified += 1;
    if (row.measured && row.matchesReference !== null) {
      group.referenceCompared += 1;
      if (row.matchesReference === true) group.matchesReference += 1;
    }
    if (row.measured && row.checkedButMismatch === true) group.checkedButMismatch += 1;
  }
  return [...groups.values()];
}

function rateOf(group) {
  if (!group.referenceCompared) return null;
  return group.matchesReference / group.referenceCompared;
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
    matchesReference: false,
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
  includeExample = false
} = {}) {
  const armList = arms.slice();
  const publicChannels = channels.map(publicChannel);
  const byArmModel = summarizeRows(rows, armList, channels);
  const covered = coverage || coverageOf(formulas, rows.length ? new Set(rows.map((row) => row.id)).size : 0);
  const summary = {
    checkedButMismatch: rows.filter((row) => row.measured && row.checkedButMismatch === true).length,
    sent: rows.filter((row) => row.sent === true).length,
    verified: rows.filter((row) => row.measured && row.verify?.pass === true).length,
    byArmModel,
    recommended: recommend(byArmModel, { complete: covered.complete === true })
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
    "## 字段",
    "",
    "| 计划 §5 | JSON |",
    "| --- | --- |",
    "| LaTeX | `latex` |",
    "| 核对 | `verify` |",
    "| 上屏方式 | `paint` |",
    "| 与参考一致? | `matchesReference` |",
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
  lines.push("", "## 分臂汇总", "");
  lines.push("| arm | provider | model | sent | verified | 与参考一致 | 核对过但与参考不一致 | 耗时合计 | token 合计 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const group of report.summary.byArmModel || []) {
    lines.push(`| ${cell(group.arm)} | ${cell(group.provider)} | ${cell(group.model)} | ${group.sent} | ${group.verified} | ${group.matchesReference}/${group.referenceCompared} | ${group.checkedButMismatch} | ${group.latencyMsTotal} | ${group.tokensTotal} |`);
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
    `- 与参考一致: ${matchText(row.matchesReference)}`,
    `- 耗时: ${row.latencyMs} ms`,
    `- token: ${tokenText(row.tokens)}`,
    `- 核对过但与参考不一致: ${row.checkedButMismatch === true}`
  ];
}

export function reportToJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}
