/**
 * DPO multimodal A/B scaffold. arXiv 2305.18290v3, pages 3–5, 79 formulas.
 *
 * 用法 / Usage
 *   node tools/mm-dpo-reference.mjs --help
 *   node tools/mm-dpo-reference.mjs --template [--out dir]
 *   node tools/mm-dpo-reference.mjs --dry-run --fixture tests/fixtures/mm-dpo.json [--arm=tight,hi-res,paragraph]
 *   node tools/mm-dpo-reference.mjs --live --limit=15 --arm=tight
 *   node tools/mm-dpo-reference.mjs --live --full --arm=page
 *
 * 输入臂 / Arms
 *   tight       现有紧裁 PNG（cropPngFor）。默认，也是唯一默认臂。
 *   hi-res      高清裁图。F7W-1 未落地时不发送（占位）。
 *   paragraph   段落图 + 段落文字。F7W-3 未落地时不发送（占位）。
 *   page        整页对照。脚本专有，默认关。必须写 --arm=page。不发送整页 PDF。
 *               --arm=tight,hi-res,paragraph 不会打开整页。
 *
 * 环境变量 / Env（密钥只放这里，不要写进命令行、报告、仓库）
 *   MM_DPO_KIMI_API_KEY         Kimi K3，主力。不要加 Bearer。
 *   MM_DPO_KIMI_MODEL           默认 kimi-k3
 *   MM_DPO_KIMI_BASE_URL        可选，默认厂商预设
 *   MM_DPO_DEEPSEEK_API_KEY     DeepSeek V4.1 Flash，基线对照
 *   MM_DPO_DEEPSEEK_MODEL       默认 deepseek-v4.1-flash
 *   MM_DPO_DEEPSEEK_BASE_URL    可选，默认厂商预设
 *
 * 真跑 / Live
 *   只有 --live 会发请求。CI 不要加 --live。
 *   还必须 --limit=N（建议 15）或 --full（79 条，另批预算）。
 *   没有 PNG 紧裁时不发请求。文字层 PDF 只用来列出第 3–5 页公式。
 *   429 不重试，避免同一条公式扣两次。
 *   产品里的 DeepSeek 仍是「待实测」；这里的基线不改那条预设。
 *
 * 报告 / Report
 *   默认目录 oi-qa/f7-multimodal/runs/（不进扩展包，runs/ 不提交）。
 *   report.json + report.md。字段见计划 §5：LaTeX、核对、上屏方式、
 *   与参考一致?、耗时、token，以及「核对过但与参考不一致」的条数。
 *   PDF 夹具不入库：tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf
 *   用 scripts/ci/fetch-fixtures.sh 按 2305.18290v3 取。
 */

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  AB_CHANNELS,
  DPO_PAPER,
  attachReferences,
  channelsFromEnv,
  coverageOf,
  formulasFromFixture,
  reportToJson,
  reportToMarkdown,
  resolveArms,
  runAb,
  templateReport
} from "../lib/mm-dpo-ab.js";
import { multimodalTarget, sendVision } from "../lib/mm-client.js";
import { normalizeFormulaSettings } from "../lib/formula-settings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

export const DEFAULT_PDF = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");

export const USAGE = [
  "DPO 多模态 A/B 脚手架（arXiv 2305.18290v3，第 3–5 页，79 个公式参考）",
  "",
  "用法:",
  "  node tools/mm-dpo-reference.mjs --help",
  "  node tools/mm-dpo-reference.mjs --template [--out dir]",
  "  node tools/mm-dpo-reference.mjs --dry-run --fixture <file.json> [--arm=tight,hi-res,paragraph]",
  "  node tools/mm-dpo-reference.mjs --live --limit=15 --arm=tight",
  "  node tools/mm-dpo-reference.mjs --live --full --arm=page",
  "",
  "输入臂: tight（默认） / hi-res / paragraph / page",
  "  page 默认关，必须 --arm=page。不发送整页 PDF，也不进产品默认。",
  "  hi-res、paragraph 在对应产品路径落地前只占位，不拿紧裁冒充测量。",
  "  --placeholder-uses-tight 会用紧裁占位发送，报告里 measured=false，不参与推荐。",
  "",
  "环境变量（密钥不要写在命令行）:",
  ...AB_CHANNELS.flatMap((channel) => [
    `  ${channel.envKey}`,
    `  ${channel.envModel}（默认 ${channel.model}）`,
    `  ${channel.envBaseUrl}`
  ]),
  "",
  "只有 --live 会联网。CI 不要跑 --live。真跑还要 --limit=N 或 --full。",
  "没有 PNG 时不发请求。报告写到 oi-qa/f7-multimodal/runs/，不进扩展包。",
  `PDF 不入库。缺文件时用 scripts/ci/fetch-fixtures.sh 取 2305.18290v3。`,
  `参考条数 ${DPO_PAPER.formulaCount}，不是合入门槛。`
].join("\n");

const VALUE_FLAGS = ["--limit", "--arm", "--model", "--out", "--fixture", "--pdf", "--reference"];

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
    arms: [],
    armSet: false,
    models: [],
    modelSet: false,
    out: "",
    fixture: "",
    pdf: "",
    reference: "",
    placeholderUsesTight: false,
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
  }
  if (parsed.help) return parsed;
  if (parsed.template && parsed.live) parsed.errors.push("--template 不会发请求");
  if (parsed.live && parsed.dryRun) parsed.errors.push("--live 和 --dry-run 只能选一个");
  if (parsed.full && parsed.limit != null) parsed.errors.push("--full 和 --limit 只能选一个");
  if (parsed.live && !parsed.full && parsed.limit == null) {
    parsed.errors.push("真跑需要 --limit=N 或 --full。默认不跑满 79 条。");
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

export function createLiveTransport({ net } = {}) {
  return async function liveTransport(call) {
    const settings = normalizeFormulaSettings({
      multimodal: {
        provider: call.provider,
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
      net,
      retry: false
    });
  };
}

function missingModule(err) {
  return err?.code === "ERR_MODULE_NOT_FOUND"
    || /Cannot find module|Cannot find package/.test(String(err?.message || ""));
}

export async function loadOptionalVisionCrop() {
  try {
    const mod = await import("../lib/formula-vision-crop.js");
    return typeof mod.visionCropFor === "function" ? mod.visionCropFor : null;
  } catch (err) {
    if (missingModule(err)) return null;
    throw err;
  }
}

export async function loadPdfFormulas(pdfPath) {
  if (!existsSync(pdfPath)) {
    throw new Error(
      `缺少 DPO PDF：${pdfPath}。该文件不入库。用 scripts/ci/fetch-fixtures.sh 按 arXiv 2305.18290v3 取到 tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf。参考范围是第 ${DPO_PAPER.pages.join("、")} 页。`
    );
  }
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
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      if (!wanted.has(number)) continue;
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      attachFontRealNames(content.items, pdfPage.commonObjs);
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      collected.push({ page: number, blocks: built.blocks });
    }
  } finally {
    await doc.destroy();
  }
  return formulasFromBlocks(collected);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

async function loadFormulas(parsed) {
  let formulas;
  if (parsed.fixture) {
    formulas = formulasFromFixture(readJson(resolve(parsed.fixture)));
  } else {
    formulas = await loadPdfFormulas(parsed.pdf ? resolve(parsed.pdf) : DEFAULT_PDF);
  }
  if (parsed.reference) formulas = attachReferences(formulas, readJson(resolve(parsed.reference)));
  return formulas;
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
  let formulas;
  try {
    formulas = await loadFormulas(parsed);
  } catch (err) {
    stderr(err.message || String(err));
    return { code: 1, report: null, paths: null };
  }
  const sampled = parsed.full || parsed.limit == null ? formulas.slice() : formulas.slice(0, parsed.limit);
  const live = parsed.live === true;
  const transport = live ? (io.transport || createLiveTransport({ net: io.net })) : null;
  let katex = io.katex || null;
  if (live && !katex) katex = loadBundledKatex();
  const visionCropFor = io.visionCropFor === undefined ? await loadOptionalVisionCrop() : io.visionCropFor;
  const report = await runAb({
    formulas: sampled,
    arms,
    models: channels,
    send: live,
    transport,
    katex,
    visionCropFor,
    placeholderUsesTight: parsed.placeholderUsesTight,
    now: io.now,
    signal: io.signal,
    mode: live ? "live" : "dry-run",
    generatedAt: generatedAt || new Date().toISOString(),
    coverage: coverageOf(formulas, sampled.length)
  });
  const dir = parsed.out ? resolve(parsed.out) : stampDir(report.generatedAt);
  const paths = writeReport(dir, report);
  stdout(`${paths.jsonPath} sent=${report.summary.sent}`);
  return { code: 0, report, paths };
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
