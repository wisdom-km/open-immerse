/**
 * DPO multimodal A/B scaffold. arXiv 2305.18290v3, pages 3–5, 79 formulas.
 *
 * 用法 / Usage
 *   node tools/mm-dpo-reference.mjs --help
 *   node tools/mm-dpo-reference.mjs --template [--out dir]
 *   node tools/mm-dpo-reference.mjs --dry-run --fixture tests/fixtures/mm-dpo.json [--arm=tight,hi-res,paragraph]
 *   node tools/mm-dpo-reference.mjs --live --limit=15 --arm=tight,hi-res,paragraph --model=kimi
 *   node tools/mm-dpo-reference.mjs --live --sample=15 --arm=tight,hi-res,paragraph --model=kimi
 *   node tools/mm-dpo-reference.mjs --live --full --arm=page
 *
 * 输入臂 / Arms
 *   tight       紧裁 PNG。已有图走 cropPngFor；文字层 PDF 用 measureFormulaCrop
 *               （CROP_SCALE 2，行内 pad 4、独立 pad 6）。默认臂。
 *   hi-res      产品高清裁图（visionCropFor / renderVisionCrop，mm-3）。measured。
 *   paragraph   脚本实验：段落区域按同一高清倍率出图，红框标出目标，并附段落文字。
 *               measured。不改产品默认，也不改产品提示词。
 *   context     脚本实验：高清倍率下裁目标公式，上下约一行、左右几个词，红框标出目标。
 *               不进默认臂。--probe-short 另附 12pt 门槛漏掉的短公式，不改产品门槛。
 *   page        整页对照。脚本专有，默认关。必须写 --arm=page。不发送整页 PDF。
 *               --arm=tight,hi-res,paragraph 不会打开整页。
 *
 * 环境变量 / Env（密钥只放这里，不要写进命令行、报告、仓库）
 *   MM_DPO_KIMI_API_KEY         Kimi K3，主力。不要加 Bearer。
 *   MM_DPO_KIMI_MODEL           默认 kimi-k3。火山方舟也用 kimi-k3。
 *   MM_DPO_KIMI_BASE_URL        可选。火山方舟：https://ark.cn-beijing.volces.com/api/plan/v3
 *                               脚本把它当成产品的「自定义兼容端点」，地址是
 *                               base + /chat/completions，不再加 /v1。密钥不进 URL。
 *   MM_DPO_DEEPSEEK_API_KEY     DeepSeek V4.1 Flash，基线对照。
 *                               未设置时复用 MM_DPO_KIMI_API_KEY（同一把火山方舟密钥）。
 *                               设了自己的密钥就用自己的，不会回落到 Kimi。
 *   MM_DPO_DEEPSEEK_MODEL       默认 deepseek-v4.1-flash
 *   MM_DPO_DEEPSEEK_BASE_URL    可选。火山方舟与 Kimi 相同：
 *                               https://ark.cn-beijing.volces.com/api/plan/v3
 *                               请求形状也相同：base + /chat/completions，base64 PNG，
 *                               thinking.type=disabled，不送 reasoning_effort。
 *
 * 真跑 / Live
 *   只有 --live 会发请求。CI 不要加 --live。
 *   默认 --reference 是 tests/fixtures/mm-dpo-reference.json。
 *   未对齐的行 reference 为空，不计入准确率，并写在报告里。
 *   还必须 --limit=N、--sample=N（建议 15，分层且可复现）或 --full（检出的全部，不再抽样）。
 *   --limit 与 --sample 都按页 × 行内/独立分层抽取，报告里记下 id，同一清单再跑是同一批。
 *   没有 PNG 时不发请求。文字层 PDF 只用来列出第 3–5 页公式并裁图，不整页上传。
 *   429 不重试，避免同一条公式扣两次。
 *   产品里的 DeepSeek 仍是「待实测」；这里的基线不改那条预设。
 *
 * 报告 / Report
 *   默认目录 oi-qa/f7-multimodal/runs/（不进扩展包，runs/ 不提交）。
 *   report.json + report.md。字段见计划 §5：LaTeX、核对、上屏方式、
 *   与参考一致?（去空白 / 规范形）、耗时、token，以及「核对过但与参考不一致」的条数。
 *   D2 用规范形准确率。--rescore=<report.json> 用磁盘上的输出重算，不联网、不开 PDF。
 *   PDF 夹具不入库：tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf
 *   用 scripts/ci/fetch-fixtures.sh 按 2305.18290v3 取。
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  AB_CHANNELS,
  DPO_PAPER,
  attachReferences,
  channelsFromEnv,
  chooseFormulas,
  coverageOf,
  formulasFromBlocks,
  formulasFromFixture,
  reportToJson,
  reportToMarkdown,
  rescoreReport,
  resolveArms,
  runAb,
  templateReport
} from "../lib/mm-dpo-ab.js";
import { renderContextCrop, renderParagraphCrop, renderTightCrop, renderVisionCrop, visionCanvasAvailable } from "./mm-dpo-vision.mjs";
import { shortProbeFormulas } from "./mm-dpo-probes.mjs";
import { multimodalTarget, sendVision } from "../lib/mm-client.js";
import { fixedVendorHostMismatch, normalizeFormulaSettings } from "../lib/formula-settings.js";
import { currentNet } from "../lib/net/fetch.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export const DEFAULT_PDF = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
export const DEFAULT_REFERENCE = join(root, "tests/fixtures/mm-dpo-reference.json");

export const USAGE = [
  "DPO 多模态 A/B 脚手架（arXiv 2305.18290v3，第 3–5 页，79 个公式参考）",
  "",
  "用法:",
  "  node tools/mm-dpo-reference.mjs --help",
  "  node tools/mm-dpo-reference.mjs --template [--out dir]",
  "  node tools/mm-dpo-reference.mjs --dry-run --fixture <file.json> [--arm=tight,hi-res,paragraph]",
  "  MM_DPO_KIMI_MODEL=kimi-k3 MM_DPO_KIMI_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \\",
  "    node tools/mm-dpo-reference.mjs --live --limit=15 --arm=tight,hi-res,paragraph --model=kimi",
  "  node tools/mm-dpo-reference.mjs --live --sample=15 --arm=tight,hi-res,paragraph,context --model=kimi",
  "  MM_DPO_KIMI_MODEL=kimi-k3 MM_DPO_KIMI_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \\",
  "    node tools/mm-dpo-reference.mjs --live --sample=15 --probe-short --arm=hi-res,context,paragraph --model=kimi",
  "  node tools/mm-dpo-reference.mjs --live --full --arm=page",
  "  node tools/mm-dpo-reference.mjs --rescore <report.json> [--reference <file.json>] [--out dir]",
  "  MM_DPO_KIMI_MODEL=kimi-k3 MM_DPO_KIMI_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \\",
  "  MM_DPO_DEEPSEEK_MODEL=deepseek-v4.1-flash MM_DPO_DEEPSEEK_BASE_URL=https://ark.cn-beijing.volces.com/api/plan/v3 \\",
  "    node tools/mm-dpo-reference.mjs --live --full --arm=hi-res --model=kimi,deepseek",
  "",
  "输入臂: tight（默认） / hi-res / paragraph / context / page",
  "  tight：已有图走 cropPngFor；文字层 PDF 用 measureFormulaCrop（CROP_SCALE 2）。",
  "  默认参考：tests/fixtures/mm-dpo-reference.json。未对齐的行不计入准确率。",
  "  火山方舟 Base URL 走产品「自定义兼容端点」：base + /chat/completions，不再加 /v1。",
  "  DeepSeek 走同一套方舟地址。未设置 MM_DPO_DEEPSEEK_API_KEY 时复用 MM_DPO_KIMI_API_KEY。",
  "  --rescore 只重算已有报告的逐字 / 去空白 / 规范形，不发请求，也不打开 PDF。",
  "  2026-10-23 那次报告的 id 是字体加载前的 37 块，第 3 页块号已经变了，不能 --ids 重放。",
  "  那次报告 coverage.detected 为 37，--rescore 仍用当时记下的参考内容。",
  "  page 默认关，必须 --arm=page。不发送整页 PDF，也不进产品默认。",
  "  hi-res 走产品 visionCropFor / renderVisionCrop（mm-3）。没有页面时不发送。",
  "  paragraph 只在本脚本里：段落区域按同一高清倍率出图，红框标出目标，并附段落文字。",
  "  context 只在本脚本里：目标上下约一行、左右几个词，红框标出目标。不进默认臂。",
  "  --probe-short 另抽约 10 条产品 12pt 行内门槛漏掉、但带上下标或数学符号的短公式。不改产品门槛。",
  "  --placeholder-uses-tight 会用紧裁占位发送，报告里 measured=false，不参与推荐。",
  "  --limit=N 与 --sample=N 是同一套分层抽样（行内 + 独立，多页）。报告记下 id。",
  "  --ids=id1,id2 按报告里的 id 重放，不再重新抽样。",
  "  hi-res / paragraph 画 PDF 需要 devDependency @napi-rs/canvas（仓库根目录 npm ci）。",
  "",
  "环境变量（密钥不要写在命令行）:",
  ...AB_CHANNELS.flatMap((channel) => [
    `  ${channel.envKey}`,
    `  ${channel.envModel}（默认 ${channel.model}）`,
    `  ${channel.envBaseUrl}`
  ]),
  "",
  "只有 --live 会联网。CI 不要跑 --live。真跑还要 --limit=N、--sample=N 或 --full。",
  "没有 PNG 时不发请求。报告写到 oi-qa/f7-multimodal/runs/，不进扩展包。",
  `PDF 不入库。缺文件时用 scripts/ci/fetch-fixtures.sh 取 2305.18290v3。`,
  `参考条数 ${DPO_PAPER.formulaCount}，不是合入门槛。`
].join("\n");

const VALUE_FLAGS = ["--limit", "--sample", "--ids", "--arm", "--model", "--out", "--fixture", "--pdf", "--reference", "--rescore"];

function splitFlag(arg) {
  for (const name of VALUE_FLAGS) {
    if (arg === name) return { flag: name, value: null };
    if (arg.startsWith(`${name}=`)) return { flag: name, value: arg.slice(name.length + 1) };
  }
  return null;
}

export function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const parsed = {
    help: args.length === 0,
    template: false,
    dryRun: false,
    live: false,
    full: false,
    limit: null,
    sample: null,
    ids: [],
    arms: [],
    armSet: false,
    models: [],
    modelSet: false,
    out: "",
    fixture: "",
    pdf: "",
    reference: "",
    rescore: "",
    placeholderUsesTight: false,
    probeShort: false,
    errors: []
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i]);
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--template") {
      parsed.template = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--live") {
      parsed.live = true;
      continue;
    }
    if (arg === "--full") {
      parsed.full = true;
      continue;
    }
    if (arg === "--placeholder-uses-tight") {
      parsed.placeholderUsesTight = true;
      continue;
    }
    if (arg === "--probe-short") {
      parsed.probeShort = true;
      continue;
    }
    if (arg === "--api-key" || arg.startsWith("--api-key=") || arg === "--key" || arg.startsWith("--key=")) {
      parsed.errors.push("密钥只能放环境变量，不能写在命令行");
      continue;
    }
    const pair = splitFlag(arg);
    if (!pair) {
      parsed.errors.push(`未知参数：${arg}`);
      continue;
    }
    let value = pair.value;
    if (value == null) {
      const next = args[i + 1];
      if (next == null || String(next).startsWith("--")) {
        parsed.errors.push(`${pair.flag} 缺少值`);
        continue;
      }
      value = String(next);
      i += 1;
    }
    if (pair.flag === "--limit") {
      if (!/^[1-9]\d*$/.test(value)) parsed.errors.push("--limit 需要正整数");
      else parsed.limit = Number(value);
    } else if (pair.flag === "--sample") {
      if (!/^[1-9]\d*$/.test(value)) parsed.errors.push("--sample 需要正整数");
      else parsed.sample = Number(value);
    } else if (pair.flag === "--ids") {
      for (const part of value.split(",")) {
        const id = part.trim();
        if (!id) parsed.errors.push("--ids 是空的");
        else parsed.ids.push(id);
      }
    } else if (pair.flag === "--arm") {
      parsed.armSet = true;
      for (const part of value.split(",")) {
        const id = part.trim().toLowerCase();
        if (!id) parsed.errors.push("--arm 是空的");
        else parsed.arms.push(id);
      }
    } else if (pair.flag === "--model") {
      parsed.modelSet = true;
      for (const part of value.split(",")) {
        const id = part.trim().toLowerCase();
        if (!id) parsed.errors.push("--model 是空的");
        else parsed.models.push(id);
      }
    } else if (pair.flag === "--out") parsed.out = value;
    else if (pair.flag === "--fixture") parsed.fixture = value;
    else if (pair.flag === "--pdf") parsed.pdf = value;
    else if (pair.flag === "--reference") parsed.reference = value;
    else if (pair.flag === "--rescore") {
      if (!value.trim()) parsed.errors.push("--rescore 缺少报告路径");
      else parsed.rescore = value;
    }
  }
  if (parsed.help) return parsed;
  if (parsed.rescore && (parsed.live || parsed.dryRun || parsed.template)) {
    parsed.errors.push("--rescore 不发请求，也不能和 --live / --dry-run / --template 一起用");
  }
  if (parsed.template && parsed.live) parsed.errors.push("--template 不会发请求");
  if (parsed.live && parsed.dryRun) parsed.errors.push("--live 和 --dry-run 只能选一个");
  if (parsed.full && (parsed.limit != null || parsed.sample != null || parsed.ids.length)) {
    parsed.errors.push("--full 和 --limit / --sample / --ids 只能选一个");
  }
  if (parsed.limit != null && parsed.sample != null) parsed.errors.push("--limit 和 --sample 只能选一个");
  if (parsed.ids.length && (parsed.limit != null || parsed.sample != null)) {
    parsed.errors.push("--ids 不再抽样，不能和 --limit / --sample 一起用");
  }
  if (parsed.live && !parsed.full && parsed.limit == null && parsed.sample == null && !parsed.ids.length) {
    parsed.errors.push("真跑需要 --limit=N、--sample=N 或 --full。默认不跑满 79 条。");
  }
  return parsed;
}

export function loadBundledKatex() {
  const katexPath = join(root, "pdf/vendor/katex/katex.min.js");
  const katexModule = new (require("module").Module)(katexPath);
  katexModule.filename = katexPath;
  katexModule.paths = require("module").Module._nodeModulePaths(dirname(katexPath));
  katexModule._compile(readFileSync(katexPath, "utf8"), katexPath);
  return katexModule.exports;
}

function httpsHost(base) {
  try {
    const url = new URL(String(base || "").trim());
    if (url.protocol !== "https:") return "";
    return url.hostname.toLowerCase();
  } catch {
    return "";
  }
}

function arkBase(base) {
  const host = httpsHost(base);
  return host === "ark.cn-beijing.volces.com" || host.endsWith(".volces.com") || host.endsWith(".volcengine.com");
}

/**
 * A fixed vendor only accepts its own host. An Ark override is the product's
 * custom OpenAI-compatible endpoint, so Moonshot's host check does not apply.
 * Any other host stays on the named provider and is still refused.
 */
export function liveProviderFor(call) {
  const base = String(call?.baseUrl || "").trim();
  if (!base || !arkBase(base)) return String(call?.provider || "");
  const mismatch = fixedVendorHostMismatch({
    multimodal: { provider: call?.provider, baseUrl: base, apiKey: "x" }
  });
  return mismatch ? "custom" : String(call?.provider || "");
}

function omitReasoningEffort(net) {
  const base = net || currentNet();
  return {
    fetch(request) {
      const json = request?.json;
      if (!json || typeof json !== "object" || !Object.prototype.hasOwnProperty.call(json, "reasoning_effort")) {
        return base.fetch(request);
      }
      const next = { ...json };
      delete next.reasoning_effort;
      return base.fetch({ ...request, json: next });
    }
  };
}

export function createLiveTransport({ net } = {}) {
  return async function liveTransport(call) {
    const settings = normalizeFormulaSettings({
      multimodal: {
        provider: liveProviderFor(call),
        model: call.model,
        baseUrl: call.baseUrl || "",
        apiKey: ""
      }
    });
    const target = multimodalTarget(settings);
    return sendVision({
      target,
      system: call.system,
      text: call.text,
      images: call.image ? [{ mime: "image/png", base64: call.image.base64 }] : [],
      secret: call.secret,
      signal: call.signal,
      net: arkBase(call.baseUrl) ? omitReasoningEffort(net) : net,
      retry: false
    });
  };
}

function missingPdf(pdfPath) {
  return new Error(
    `缺少 DPO PDF：${pdfPath}。该文件不入库。用 scripts/ci/fetch-fixtures.sh 按 arXiv 2305.18290v3 取到 tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf。参考范围是第 ${DPO_PAPER.pages.join("、")} 页。`
  );
}

export async function openPdfSession(pdfPath) {
  if (!existsSync(pdfPath)) throw missingPdf(pdfPath);
  const { getDocument, GlobalWorkerOptions } = await import("../pdf/vendor/pdf.min.mjs");
  const { textLayerToBlocks } = await import("../lib/pdf-text-layer.js");
  const { attachFontRealNames } = await import("../lib/pdf-mirror.js");
  GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const doc = await getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const wanted = new Set(DPO_PAPER.pages);
  const collected = [];
  const pages = new Map();
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      if (!wanted.has(number)) continue;
      const pdfPage = await doc.getPage(number);
      pages.set(number, pdfPage);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      // Operator list loads font objects into commonObjs. Reading names first
      // leaves every math font unresolved, so CMMI/CMSY spans stay in the sentence.
      // pdf/viewer.js loads the operator list, then attachFontRealNames.
      const ops = await pdfPage.getOperatorList();
      attachFontRealNames(content.items, pdfPage.commonObjs);
      const built = textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      collected.push({
        page: number,
        blocks: built.blocks,
        items: content.items,
        viewport
      });
    }
  } catch (err) {
    await doc.destroy();
    throw err;
  }
  const formulas = formulasFromBlocks(collected);
  const probes = shortProbeFormulas({ pages: collected, formulas });
  return {
    formulas,
    probes,
    renderVisionCrop(block, spec) {
      return renderVisionCrop(pages.get(Number(block?.page)), block, spec);
    },
    renderTightCrop(formula) {
      return renderTightCrop(pages.get(Number(formula?.page)), formula);
    },
    renderParagraphCrop(formula) {
      return renderParagraphCrop(pages.get(Number(formula?.page)), formula);
    },
    renderContextCrop(formula) {
      return renderContextCrop(pages.get(Number(formula?.page)), formula);
    },
    async close() {
      pages.clear();
      await doc.destroy();
    }
  };
}

export async function loadPdfFormulas(pdfPath) {
  if (!existsSync(pdfPath)) throw missingPdf(pdfPath);
  const session = await openPdfSession(pdfPath);
  try {
    return session.formulas;
  } finally {
    await session.close();
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function referenceFile(parsed) {
  if (parsed.reference) return resolve(parsed.reference);
  return DEFAULT_REFERENCE;
}

function applyReferenceFile(formulas, parsed) {
  const path = referenceFile(parsed);
  if (!existsSync(path)) {
    if (parsed.reference) throw new Error(`缺少参考：${path}`);
    return formulas;
  }
  return attachReferences(formulas, readJson(path));
}

async function loadFormulas(parsed) {
  if (parsed.fixture) {
    const data = readJson(resolve(parsed.fixture));
    const formulas = applyReferenceFile(formulasFromFixture(data), parsed);
    const probes = Array.isArray(data?.probes)
      ? applyReferenceFile(formulasFromFixture({ formulas: data.probes }), parsed)
      : [];
    return { formulas, probes, session: null };
  }
  const session = await openPdfSession(parsed.pdf ? resolve(parsed.pdf) : DEFAULT_PDF);
  session.formulas = applyReferenceFile(session.formulas, parsed);
  session.probes = applyReferenceFile(session.probes || [], parsed);
  return { formulas: session.formulas, probes: session.probes, session };
}

export function writeReport(dir, report) {
  mkdirSync(dir, { recursive: true });
  const base = report.mode === "template" ? "template.report" : "report";
  const jsonPath = join(dir, `${base}.json`);
  const mdPath = join(dir, `${base}.md`);
  writeFileSync(jsonPath, reportToJson(report));
  writeFileSync(mdPath, reportToMarkdown(report));
  return { jsonPath, mdPath };
}

function stampDir(iso) {
  const stamp = String(iso || new Date().toISOString()).replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(root, "oi-qa", "f7-multimodal", "runs", stamp);
}

function rescoreDir(parsed, inputPath) {
  const dir = parsed.out
    ? resolve(parsed.out)
    : join(dirname(inputPath), `${basename(inputPath, ".json")}.rescore`);
  if (resolve(join(dir, "report.json")) === resolve(inputPath)) {
    throw new Error("--out 会盖住原来的报告，换一个目录");
  }
  return dir;
}

export function rescoreFromFile(parsed) {
  const inputPath = resolve(parsed.rescore);
  if (!existsSync(inputPath)) throw new Error(`缺少报告：${inputPath}`);
  const referencePath = referenceFile(parsed);
  if (!existsSync(referencePath)) throw new Error(`缺少参考：${referencePath}`);
  let report;
  let table;
  try {
    report = readJson(inputPath);
    table = readJson(referencePath);
  } catch (err) {
    throw new Error(`报告或参考不是 JSON：${err.message || err}`);
  }
  if (!report || report.schema !== "open-immerse.mm-dpo-ab/v1" || !Array.isArray(report.rows)) {
    throw new Error(`不是 A/B 报告：${inputPath}`);
  }
  return { report: rescoreReport(report, table), dir: rescoreDir(parsed, inputPath) };
}

export async function main(argv = [], io = {}) {
  const stdout = io.stdout || ((line) => console.log(line));
  const stderr = io.stderr || ((line) => console.error(line));
  const env = io.env || process.env;
  const parsed = parseArgs(argv);
  if (parsed.errors.length) {
    stderr(parsed.errors.join("\n"));
    return { code: 2, report: null, paths: null };
  }
  if (parsed.help) {
    stdout(USAGE);
    return { code: 0, report: null, paths: null };
  }
  const generatedAt = io.generatedAt ?? null;
  if (parsed.template) {
    const report = templateReport();
    const dir = parsed.out
      ? resolve(parsed.out)
      : join(root, "oi-qa", "f7-multimodal", "runs", "template");
    const paths = writeReport(dir, report);
    stdout(paths.jsonPath);
    return { code: 0, report, paths };
  }
  if (parsed.rescore) {
    let scored;
    try {
      scored = rescoreFromFile(parsed);
    } catch (err) {
      stderr(err.message || String(err));
      return { code: 1, report: null, paths: null };
    }
    const paths = writeReport(scored.dir, scored.report);
    const scoredArms = scored.report.summary.byArmModel
      .map((group) => `${group.arm}/${group.provider} canonical=${group.canonicalMatches}/${group.referenceCompared}`)
      .join(" ");
    stdout(`${paths.jsonPath} ${scoredArms}`.trim());
    return { code: 0, report: scored.report, paths };
  }
  let arms;
  let channels;
  try {
    arms = parsed.armSet ? resolveArms(parsed.arms) : resolveArms(null);
    channels = channelsFromEnv(env, parsed.modelSet ? parsed.models : null);
  } catch (err) {
    stderr(err.message || String(err));
    return { code: 2, report: null, paths: null };
  }
  if (parsed.live && channels.every((channel) => !channel.secret)) {
    stderr(`真跑至少需要一个环境变量密钥：${AB_CHANNELS.map((channel) => channel.envKey).join("、")}`);
    return { code: 2, report: null, paths: null };
  }
  const pdfPath = parsed.pdf ? resolve(parsed.pdf) : DEFAULT_PDF;
  const tightNeeds = arms.includes("tight") && io.renderTightCrop === undefined;
  const hiNeeds = arms.includes("hi-res") && io.renderVisionCrop === undefined;
  const paragraphNeeds = arms.includes("paragraph") && io.renderParagraphCrop === undefined;
  const contextNeeds = arms.includes("context") && io.renderContextCrop === undefined;
  if (!parsed.fixture && existsSync(pdfPath) && (tightNeeds || hiNeeds || paragraphNeeds || contextNeeds) && !visionCanvasAvailable()) {
    stderr("裁图需要 @napi-rs/canvas。在仓库根目录运行 npm ci。");
    return { code: 1, report: null, paths: null };
  }
  let loaded;
  try {
    loaded = await loadFormulas(parsed);
  } catch (err) {
    stderr(err.message || String(err));
    return { code: 1, report: null, paths: null };
  }
  try {
    const formulas = loaded.formulas;
    const chosen = chooseFormulas(formulas, {
      full: parsed.full,
      limit: parsed.limit,
      sample: parsed.sample,
      ids: parsed.ids
    });
    const probePool = loaded.probes || [];
    let sampled = chosen.formulas;
    let probeIds = [];
    if (parsed.probeShort && !parsed.ids.length) {
      probeIds = probePool.map((item) => item.id);
      sampled = [...sampled, ...probePool];
    } else if (parsed.ids.length && probePool.length) {
      const have = new Set(sampled.map((item) => item.id));
      const extra = probePool.filter((item) => parsed.ids.includes(item.id) && !have.has(item.id));
      if (extra.length) sampled = [...sampled, ...extra];
    }
    if (parsed.ids.length && sampled.length !== parsed.ids.length) {
      stderr(`--ids 里有报告清单中找不到的公式（要 ${parsed.ids.length}，找到 ${sampled.length}）`);
      return { code: 1, report: null, paths: null };
    }
    const live = parsed.live === true;
    const transport = live ? (io.transport || createLiveTransport({ net: io.net })) : null;
    let katex = io.katex || null;
    if (live && !katex) katex = loadBundledKatex();
    const visionCropFor = io.visionCropFor === undefined ? null : io.visionCropFor;
    const renderTight = io.renderTightCrop === undefined
      ? (loaded.session?.renderTightCrop || null)
      : io.renderTightCrop;
    const renderVision = io.renderVisionCrop === undefined
      ? (loaded.session?.renderVisionCrop || null)
      : io.renderVisionCrop;
    const renderParagraph = io.renderParagraphCrop === undefined
      ? (loaded.session?.renderParagraphCrop || null)
      : io.renderParagraphCrop;
    const renderContext = io.renderContextCrop === undefined
      ? (loaded.session?.renderContextCrop || null)
      : io.renderContextCrop;
    const report = await runAb({
      formulas: sampled,
      arms,
      models: channels,
      send: live,
      transport,
      katex,
      visionCropFor,
      renderTightCrop: renderTight,
      renderVisionCrop: renderVision,
      renderParagraphCrop: renderParagraph,
      renderContextCrop: renderContext,
      placeholderUsesTight: parsed.placeholderUsesTight,
      now: io.now,
      signal: io.signal,
      mode: live ? "live" : "dry-run",
      generatedAt: generatedAt || new Date().toISOString(),
      coverage: coverageOf(formulas, sampled.length),
      sample: {
        stratified: chosen.stratified,
        locked: chosen.locked,
        requested: chosen.requested,
        ids: sampled.map((item) => item.id),
        ...(probeIds.length ? { probes: probeIds } : {})
      }
    });
    const dir = parsed.out ? resolve(parsed.out) : stampDir(report.generatedAt);
    const paths = writeReport(dir, report);
    stdout(`${paths.jsonPath} sent=${report.summary.sent}`);
    return { code: 0, report, paths };
  } finally {
    await loaded.session?.close?.();
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(entry)).href;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main(process.argv.slice(2)).then((result) => {
    process.exitCode = result?.code || 0;
  }, (err) => {
    console.error(err?.message || err);
    process.exitCode = 1;
  });
}
