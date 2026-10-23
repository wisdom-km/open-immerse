/**
 * F7W-2a DPO A/B scaffold. Fake transport only.
 *
 * 交付前刁钻自测:
 * 1. 并发 — 两次 runAb 同时跑，报告不串密钥、不串行号。
 * 2. 页面生命周期 — 开头已中止不发请求；请求中途中止丢掉 LaTeX，下一条不再发。
 * 3. 新旧版本兼容 — 夹具可以没有参考，多出来的字段不进报告。本模块无共享可变状态，不做 500 种子。
 * 4. 失败与回滚 — 一家抛错，另一家仍留下；抛错文本里的密钥不进报告。
 * 5. 边界输入 — 空臂、命令行密钥、整页默认关、非 PNG、超长段落、UNREADABLE。
 * 6. 交付要求 — 用法、环境变量、臂开关、报告字段、CI 不跑 --live。
 *
 * 不变量:
 * ① 密钥只来自调用方传入的环境，不进报告、URL 或日志；
 * ② 默认臂不含 page，page 不发送整页 PDF；
 * ③ 假传输之外没有 global fetch。
 */

import "./helpers/block-live-fetch.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createNet } from "../lib/net/fetch.js";
import { FORMULA_VISION_SYSTEM, MM_TIER_VERSION, formulaVisionText } from "../lib/formula-tiers/multimodal.js";
import {
  VISION_CROP_SCALE,
  VISION_INK_PAD_PX,
  visionCropFor,
  visionCropSpec,
  visionRasterPlan
} from "../lib/formula-vision-crop.js";
import {
  AB_CHANNELS,
  ARM_IDS,
  COST_RATES,
  DEFAULT_ARMS,
  D2_CLEAR_MARGIN,
  DPO_PAPER,
  CONTEXT_PROMPT_NOTE,
  PARAGRAPH_PROMPT_NOTE,
  PARAGRAPH_TEXT_MAX,
  PROBE_SIGNATURES,
  contextWindow,
  probeSignature,
  selectShortProbes,
  ROW_FIELDS,
  attachReferences,
  channelsFromEnv,
  chooseFormulas,
  clipParagraph,
  coverageOf,
  estimateCostUsd,
  formulasFromBlocks,
  formulasFromFixture,
  inputDecision,
  summarizeRows,
  canonicalizeLatex,
  latexCanonicalMatch,
  latexExactMatch,
  latexMatchesReference,
  recommend,
  reportToJson,
  reportToMarkdown,
  resolveArms,
  runAb,
  selectSample,
  templateReport
} from "../lib/mm-dpo-ab.js";
import { CROP_SCALE, rasterCropRect } from "../lib/pdf-blocks.js";
import { FORMULA_INK_PAD_PX, FORMULA_RUN_MIN_WIDTH, measureFormulaCrop } from "../lib/pdf-text-layer.js";
import { alignDetectedFormulas, sameSourceSpan } from "../tools/mm-dpo-build-reference.mjs";
import { extractShortCandidates } from "../tools/mm-dpo-probes.mjs";
import {
  TARGET_BOX_GAP,
  TARGET_BOX_PX,
  createMemoryCanvas,
  decodeRgbaPng,
  renderContextCrop,
  renderParagraphCrop,
  renderTightCrop,
  renderVisionCrop,
  seatTargetRect
} from "../tools/mm-dpo-vision.mjs";
import { parseCropDataUrl } from "../lib/formula-crop-png.js";
import {
  USAGE,
  createLiveTransport,
  loadPdfFormulas,
  main,
  openPdfSession,
  parseArgs
} from "../tools/mm-dpo-reference.mjs";
import { liveFetchViolations } from "./helpers/block-live-fetch.mjs";
import { loadKatex } from "./helpers/arxiv-paper.mjs";
import { createOwnedTemp } from "./helpers/owned-tmp.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const katex = loadKatex();
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const KIMI_KEY = "sk-kimi-lab-key-should-not-leak";
const DEEPSEEK_KEY = "sk-deepseek-lab-key-should-not-leak";
const read = (path) => readFileSync(join(root, path), "utf8");

after(() => {
  assert.equal(liveFetchViolations(), 0);
});

function dataUrl(png) {
  return `data:image/png;base64,${png}`;
}

function formula(partial = {}) {
  return {
    id: "p3-1",
    page: 3,
    index: 1,
    equationNumber: "(3)",
    display: true,
    pdfText: "x",
    glyphs: [],
    bbox: [0.1, 0.2, 0.3, 0.4],
    reference: "x",
    imageUrl: dataUrl(PNG),
    paragraphText: "",
    ...partial
  };
}

function channel(provider, secret, extra = {}) {
  const spec = AB_CHANNELS.find((item) => item.provider === provider);
  return {
    role: spec.role,
    provider: spec.provider,
    model: extra.model || spec.model,
    baseUrl: extra.baseUrl || "",
    envKey: spec.envKey,
    secret
  };
}

function clock() {
  let time = 0;
  return () => {
    time += 5;
    return time;
  };
}

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: (line) => out.push(String(line)),
    stderr: (line) => err.push(String(line))
  };
}

function assertRow(row) {
  for (const key of ROW_FIELDS) assert.equal(Object.hasOwn(row, key), true, key);
  assert.equal(JSON.stringify(row).includes(PNG), false);
  assert.equal(JSON.stringify(row).includes(PNG_B), false);
}

function harness(handler) {
  const seen = [];
  const net = createNet({
    log() {},
    random: () => 0,
    sleep(ms, signal) {
      if (ms < 1000) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const fail = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal?.aborted) {
          fail();
          return;
        }
        signal?.addEventListener("abort", fail, { once: true });
      });
    },
    transport(url, init) {
      const hit = { url, headers: { ...(init?.headers || {}) }, body: init?.body };
      seen.push(hit);
      return handler(hit, seen);
    }
  });
  return { seen, net };
}

function chat(text, usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }) {
  return {
    ok: true,
    status: 200,
    data: {
      choices: [{ message: { content: text } }],
      usage
    }
  };
}

test("default arms stay on the tight crop and page stays opt-in", () => {
  assert.deepEqual(ARM_IDS, ["tight", "hi-res", "paragraph", "context", "page"]);
  assert.deepEqual(DEFAULT_ARMS, ["tight"]);
  assert.equal(DEFAULT_ARMS.includes("page"), false);
  assert.equal(DEFAULT_ARMS.includes("context"), false);
  assert.deepEqual(resolveArms(null), ["tight"]);
  assert.deepEqual(resolveArms([]), ["tight"]);
  assert.deepEqual(resolveArms(["tight", "hi-res", "paragraph"]), ["tight", "hi-res", "paragraph"]);
  assert.equal(resolveArms(["tight", "hi-res", "paragraph"]).includes("page"), false);
  assert.deepEqual(resolveArms(["page"]), ["page"]);
  assert.deepEqual(resolveArms(["PAGE", "page", "Tight"]), ["page", "tight"]);
  assert.throws(() => resolveArms(["nope"]), { code: "unknown-arm" });
  assert.throws(() => resolveArms(["all"]), { code: "unknown-arm" });
  assert.deepEqual(DPO_PAPER.pages, [3, 4, 5]);
  assert.equal(DPO_PAPER.formulaCount, 79);
  assert.throws(() => {
    DPO_PAPER.pages.push(9);
  });
});

test("argv documents arms, refuses command-line keys, and blocks a bare live run", () => {
  assert.equal(parseArgs([]).help, true);
  assert.deepEqual(parseArgs(["--arm=page"]).arms, ["page"]);
  assert.deepEqual(parseArgs(["--arm", "page"]).arms, ["page"]);
  assert.equal(parseArgs(["--arm=tight,hi-res,paragraph"]).arms.includes("page"), false);
  assert.deepEqual(parseArgs(["--arm=tight, page"]).arms, ["tight", "page"]);
  assert.equal(parseArgs(["--api-key=sk-from-argv-not-allowed"]).errors.length > 0, true);
  assert.equal(parseArgs(["--key", "sk-from-argv-not-allowed"]).errors.length > 0, true);
  assert.equal(parseArgs(["--live"]).errors.some((line) => line.includes("--limit")), true);
  assert.equal(parseArgs(["--live", "--full", "--limit=15"]).errors.length > 0, true);
  assert.equal(parseArgs(["--limit=0"]).errors.length > 0, true);
  assert.equal(parseArgs(["--probe-short", "--sample=15"]).probeShort, true);
  assert.equal(parseArgs(["--sample=15"]).probeShort, false);
  assert.match(USAGE, /MM_DPO_KIMI_API_KEY/);
  assert.match(USAGE, /MM_DPO_DEEPSEEK_API_KEY/);
  assert.match(USAGE, /复用 MM_DPO_KIMI_API_KEY/);
  assert.match(USAGE, /--rescore/);
  assert.match(USAGE, /--arm=page/);
  assert.match(USAGE, /--live/);
  assert.match(USAGE, /79/);
  for (const arm of ARM_IDS) assert.match(USAGE, new RegExp(arm));
  const libCode = read("lib/mm-dpo-ab.js").replace(/\/\*[\s\S]*?\*\//g, "");
  const toolCode = read("tools/mm-dpo-reference.mjs").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(/sk-[A-Za-z0-9]{8,}/.test(toolCode), false);
  assert.equal(libCode.includes("process.env"), false);
});

test("channels come from env, and a Bearer prefix is not sent twice", () => {
  const channels = channelsFromEnv({
    MM_DPO_KIMI_API_KEY: `Bearer ${KIMI_KEY}`,
    MM_DPO_KIMI_MODEL: "kimi-custom",
    MM_DPO_DEEPSEEK_API_KEY: `  ${DEEPSEEK_KEY}  `
  });
  assert.equal(channels[0].secret, KIMI_KEY);
  assert.equal(channels[0].model, "kimi-custom");
  assert.equal(channels[0].role, "primary");
  assert.equal(channels[1].secret, DEEPSEEK_KEY);
  assert.equal(channels[1].model, "deepseek-v4.1-flash");
  assert.equal(channels[1].role, "baseline");
  const shared = channelsFromEnv({
    MM_DPO_KIMI_API_KEY: `Bearer ${KIMI_KEY}`,
    MM_DPO_DEEPSEEK_MODEL: "deepseek-v4.1-flash",
    MM_DPO_DEEPSEEK_BASE_URL: "https://ark.cn-beijing.volces.com/api/plan/v3"
  }, ["deepseek"]);
  assert.equal(shared[0].secret, KIMI_KEY);
  assert.equal(shared[0].model, "deepseek-v4.1-flash");
  assert.equal(shared[0].baseUrl, "https://ark.cn-beijing.volces.com/api/plan/v3");
  assert.equal(shared[0].envKey, "MM_DPO_DEEPSEEK_API_KEY");
  assert.equal(channelsFromEnv({}, ["deepseek"])[0].secret, "");
  assert.throws(() => channelsFromEnv({}, ["grok"]), { code: "unknown-model" });
  const only = channelsFromEnv({ MM_DPO_KIMI_API_KEY: KIMI_KEY }, ["kimi", "kimi"]);
  assert.equal(only.length, 1);
});

test("text-layer blocks become per-page formula indexes without copying the paragraph into the record id", () => {
  const formulas = formulasFromBlocks([
    {
      page: 3,
      blocks: [
        { id: "t", label: "text", text: "UNIQUE_PARAGRAPH_TEXT" },
        { id: "f1", label: "formula", sourceText: "PDF_TEXT_X", eqLabel: "(3)", display: true, imageUrl: dataUrl(PNG) },
        { id: "f2", label: "formula", sourceText: "PDF_TEXT_Y", display: false, inlineOf: "t" }
      ]
    },
    {
      page: 4,
      blocks: [{ id: "f3", label: "formula", sourceText: "z", eqLabel: "(4)" }]
    }
  ]);
  assert.deepEqual(formulas.map((item) => [item.page, item.index, item.id, item.display, item.pdfText]), [
    [3, 1, "f1", true, "PDF_TEXT_X"],
    [3, 2, "f2", false, "PDF_TEXT_Y"],
    [4, 1, "f3", true, "z"]
  ]);
  assert.equal(formulas[0].equationNumber, "(3)");
  const source = formulas.map((item) => ({ ...item }));
  const attached = attachReferences(formulas, {
    formulas: [
      { equationNumber: "(3)", page: 3, reference: "x+y" },
      { id: "f3", reference: "z" }
    ]
  });
  assert.equal(attached[0].reference, "x+y");
  assert.equal(attached[2].reference, "z");
  assert.equal(formulas[0].reference, null);
  attached[0].pdfText = "changed";
  assert.equal(source[0].pdfText, "PDF_TEXT_X");
  assert.throws(() => formulasFromFixture({ no: true }), { code: "bad-fixture" });
});

test("template carries the plan fields, the deepseek baseline, and a zero mismatch count", () => {
  const report = templateReport();
  assert.equal(report.schema, "open-immerse.mm-dpo-ab/v1");
  assert.equal(report.mode, "template");
  assert.equal(report.generatedAt, null);
  assert.equal(report.expectedFormulaCount, 79);
  assert.deepEqual(report.paper.pages, [3, 4, 5]);
  assert.equal(report.productSendsPage, false);
  assert.equal(report.writesPreset, false);
  assert.equal(report.rows.length, 0);
  assert.equal(report.summary.checkedButMismatch, 0);
  assert.equal(report.summary.recommended.writesPreset, false);
  assert.equal(report.summary.recommended.productDefault, false);
  assert.equal(report.summary.recommended.reason, "no-measured-rows");
  for (const key of ROW_FIELDS) assert.equal(Object.hasOwn(report.exampleRow, key), true, key);
  assert.equal(report.exampleRow.checkedButMismatch, true);
  assert.equal(report.exampleRow.example, true);
  const page = report.armGuide.find((arm) => arm.id === "page");
  const contextArm = report.armGuide.find((arm) => arm.id === "context");
  assert.equal(contextArm.default, false);
  assert.equal(contextArm.sendsPdf, false);
  assert.equal(report.vision.context, "script-only");
  assert.equal(page.default, false);
  assert.equal(page.sendsPdf, false);
  assert.equal(page.requiresFlag, "--arm=page");
  assert.equal(report.channels.some((item) => item.provider === "kimi" && item.model === "kimi-k3"), true);
  assert.equal(report.channels.some((item) => item.provider === "deepseek" && item.model === "deepseek-v4.1-flash"), true);
  assert.equal(report.summary.byArmModel.some((item) => item.provider === "deepseek" && item.sent === 0), true);
  const markdown = reportToMarkdown(report);
  assert.match(markdown, /核对过但与参考不一致：0/);
  assert.match(markdown, /上屏方式/);
  assert.match(markdown, /与参考一致/);
  assert.match(markdown, /耗时/);
  assert.match(markdown, /token/);
  assert.match(markdown, /--arm=page/);
  assert.equal(markdown.includes(KIMI_KEY), false);
  const jsonPath = join(root, "oi-qa/f7-multimodal/template.report.json");
  const mdPath = join(root, "oi-qa/f7-multimodal/template.report.md");
  assert.equal(readFileSync(jsonPath, "utf8"), reportToJson(report));
  assert.equal(readFileSync(mdPath, "utf8"), markdown);
});

test("a checked formula that disagrees with the reference is counted, and a failed check is not", async () => {
  const calls = [];
  const report = await runAb({
    formulas: [
      formula({ id: "p3-1", pdfText: "x", reference: "x^{2}" }),
      formula({ id: "p3-2", index: 2, pdfText: "y", reference: "y" }),
      formula({ id: "p3-3", index: 3, pdfText: "z", reference: "z" })
    ],
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY), channel("deepseek", "")],
    send: true,
    katex,
    now: clock(),
    transport: async (call) => {
      calls.push(call);
      if (call.id === "p3-1") return { ok: true, text: "x", usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
      if (call.id === "p3-2") return { ok: true, text: "y", usage: { promptTokenCount: 2, candidatesTokenCount: 2, totalTokenCount: 4 } };
      return { ok: true, text: "UNREADABLE" };
    }
  });
  assert.equal(calls.length, 3);
  assert.equal(calls.every((call) => call.provider === "kimi"), true);
  assert.equal(calls[0].text, formulaVisionText(formula()));
  assert.equal(calls[0].system, FORMULA_VISION_SYSTEM);
  assert.equal(calls[0].text.includes("PARA"), false);
  const mismatch = report.rows.find((row) => row.id === "p3-1");
  const match = report.rows.find((row) => row.id === "p3-2");
  const unread = report.rows.find((row) => row.id === "p3-3" && row.provider === "kimi");
  const empty = report.rows.find((row) => row.provider === "deepseek");
  for (const row of report.rows) assertRow(row);
  assert.equal(mismatch.verify.checked, true);
  assert.equal(mismatch.verify.pass, true);
  assert.equal(mismatch.paint, "katex");
  assert.equal(mismatch.matchesReference, false);
  assert.equal(mismatch.checkedButMismatch, true);
  assert.equal(mismatch.latencyMs, 5);
  assert.deepEqual(mismatch.tokens, { prompt: 4, completion: 1, total: 5 });
  assert.equal(match.checkedButMismatch, false);
  assert.equal(match.matchesReference, true);
  assert.deepEqual(match.tokens, { prompt: 2, completion: 2, total: 4 });
  assert.equal(unread.paint, "crop");
  assert.equal(unread.verify.checked, false);
  assert.equal(unread.latex, null);
  assert.equal(unread.checkedButMismatch, false);
  assert.equal(empty.sent, false);
  assert.equal(empty.errorCode, "empty-key");
  assert.equal(report.summary.checkedButMismatch, 1);
  assert.equal(report.summary.byArmModel.find((item) => item.provider === "deepseek").sent, 0);
  assert.equal(report.summary.recommended.arm, "tight");
  assert.equal(report.summary.recommended.provider, "kimi");
  assert.equal(report.summary.recommended.writesPreset, false);
  assert.equal(report.summary.recommended.provisional, true);
  assert.equal(JSON.stringify(report).includes(KIMI_KEY), false);
  assert.equal(JSON.stringify(report).includes("PDF_TEXT"), false);
});

test("whitespace still matches the reference, and a charset miss does not count as checked-but-mismatch", async () => {
  const report = await runAb({
    formulas: [
      formula({ id: "space", reference: "x ", pdfText: "x" }),
      formula({ id: "junk", reference: "x", pdfText: "x" })
    ],
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: clock(),
    transport: async (call) => ({ ok: true, text: call.id === "junk" ? "zzzz" : "x" })
  });
  const space = report.rows.find((row) => row.id === "space");
  const junk = report.rows.find((row) => row.id === "junk");
  assert.equal(space.matchesReference, true);
  assert.equal(space.checkedButMismatch, false);
  assert.equal(junk.verify.checked, true);
  assert.equal(junk.verify.pass, false);
  assert.equal(junk.paint, "crop");
  assert.equal(junk.checkedButMismatch, false);
  assert.equal(report.summary.checkedButMismatch, 0);
});

test("page never sends, hi-res and paragraph stay placeholders, and a tight placeholder is not a measurement", async () => {
  const calls = [];
  let hooks = 0;
  const long = `${"a".repeat(PARAGRAPH_TEXT_MAX)}TAIL_MARKER`;
  assert.equal(clipParagraph(long), "a".repeat(PARAGRAPH_TEXT_MAX));
  const pending = await runAb({
    formulas: [formula({ paragraphText: long, pdfBytes: "%PDF-1.7 SECRET_PDF", imageUrl: "https://example.com/a.png?token=SECRETURLTOKEN123" })],
    arms: ["tight", "hi-res", "paragraph", "page"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: () => {
      throw new Error("unstubbed arm should not be timed");
    },
    visionCropFor() {
      hooks += 1;
      return null;
    },
    transport: async (call) => {
      calls.push(call);
      return { ok: true, text: "x" };
    }
  });
  assert.equal(calls.length, 0);
  assert.equal(hooks, 2);
  assert.equal(pending.rows.find((row) => row.arm === "page").errorCode, "page-script-only");
  assert.equal(pending.rows.find((row) => row.arm === "page").paint, "none");
  assert.equal(pending.rows.find((row) => row.arm === "page").sent, false);
  assert.equal(pending.rows.find((row) => row.arm === "hi-res").errorCode, "pending-f7w-1");
  assert.equal(pending.rows.find((row) => row.arm === "paragraph").errorCode, "pending-f7w-3");
  assert.equal(pending.rows.find((row) => row.arm === "tight").errorCode, "no-crop");
  const body = JSON.stringify(pending);
  assert.equal(body.includes("SECRETURLTOKEN123"), false);
  assert.equal(body.includes("example.com"), false);
  assert.equal(body.includes("%PDF"), false);
  assert.equal(body.includes("TAIL_MARKER"), false);
  assert.equal(pending.productSendsPage, false);

  const hooked = [];
  const measured = await runAb({
    formulas: [formula({ paragraphText: long, reference: "x^{2}", pdfText: "x" })],
    arms: ["paragraph"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: clock(),
    visionCropFor(spec, opts) {
      hooked.push({ spec, opts });
      return {
        mime: "image/png",
        base64: PNG_B,
        paragraphText: long
      };
    },
    transport: async (call) => {
      calls.push(call);
      return { ok: true, text: "x" };
    }
  });
  assert.equal(hooked.length, 1);
  assert.equal(hooked[0].opts.mode, "paragraph");
  assert.equal(hooked[0].opts.page, false);
  assert.equal(hooked[0].spec.pdfBytes, undefined);
  assert.equal(hooked[0].spec.paragraphText, long);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].image.hash, parseCropDataUrl(dataUrl(PNG_B)).hash);
  assert.notEqual(calls[0].image.hash, parseCropDataUrl(dataUrl(PNG)).hash);
  assert.equal(calls[0].text.includes("TAIL_MARKER"), false);
  assert.equal(calls[0].text.length <= formulaVisionText(formula()).length + 1 + PARAGRAPH_TEXT_MAX, true);
  assert.match(calls[0].system, new RegExp(PARAGRAPH_PROMPT_NOTE));
  assert.equal(measured.rows[0].measured, true);
  assert.equal(measured.rows[0].checkedButMismatch, true);
  assert.equal(measured.summary.checkedButMismatch, 1);
  assert.equal(JSON.stringify(measured).includes("TAIL_MARKER"), false);

  calls.length = 0;
  const placeholder = await runAb({
    formulas: [formula({ paragraphText: long, reference: "x", pdfText: "x" })],
    arms: ["hi-res"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: clock(),
    placeholderUsesTight: true,
    transport: async (call) => {
      calls.push(call);
      return { ok: true, text: "x" };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].image.hash, parseCropDataUrl(dataUrl(PNG)).hash);
  assert.equal(calls[0].text.includes("TAIL_MARKER"), false);
  assert.equal(calls[0].system.includes(PARAGRAPH_PROMPT_NOTE), false);
  assert.equal(placeholder.rows[0].inputKind, "tight-placeholder");
  assert.equal(placeholder.rows[0].measured, false);
  assert.equal(placeholder.rows[0].placeholder, true);
  assert.equal(placeholder.summary.checkedButMismatch, 0);
  assert.equal(placeholder.summary.recommended.arm, null);
  assert.equal(placeholder.summary.recommended.reason, "no-measured-rows");
});

test("a non-png hook is refused and does not fall through to a send", async () => {
  let calls = 0;
  const report = await runAb({
    formulas: [formula()],
    arms: ["hi-res"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    transport: async () => {
      calls += 1;
      return { ok: true, text: "x" };
    },
    visionCropFor: async () => ({
      mime: "application/pdf",
      base64: Buffer.from("%PDF-1.7").toString("base64"),
      pdf: true
    })
  });
  assert.equal(calls, 0);
  assert.equal(report.rows[0].errorCode, "refused-non-png");
  assert.equal(JSON.stringify(report).includes("%PDF"), false);
});

test("page cannot win the product recommendation, and a faster baseline can beat kimi", () => {
  const pageWins = recommend([
    {
      arm: "page", provider: "kimi", model: "kimi-k3", role: "primary",
      measured: 2, sent: 2, verified: 2, referenceCompared: 2, matchesReference: 2, latencyMsTotal: 4
    },
    {
      arm: "tight", provider: "kimi", model: "kimi-k3", role: "primary",
      measured: 2, sent: 2, verified: 2, referenceCompared: 2, matchesReference: 1, latencyMsTotal: 20
    }
  ], { complete: true });
  assert.equal(pageWins.arm, "tight");
  assert.equal(pageWins.productDefault, false);
  assert.equal(pageWins.writesPreset, false);
  assert.equal(pageWins.provisional, false);
  assert.equal(pageWins.pageLab.scriptOnly, true);
  const onlyPage = recommend([
    {
      arm: "page", provider: "kimi", model: "kimi-k3", role: "primary",
      measured: 1, sent: 1, verified: 1, referenceCompared: 1, matchesReference: 1, latencyMsTotal: 1
    }
  ]);
  assert.equal(onlyPage.arm, null);
  assert.equal(onlyPage.reason, "no-measured-rows");
  assert.equal(onlyPage.pageLab.arm, "page");
  const faster = recommend([
    {
      arm: "tight", provider: "deepseek", model: "deepseek-v4.1-flash", role: "baseline",
      measured: 1, sent: 1, verified: 1, referenceCompared: 1, matchesReference: 1, latencyMsTotal: 10
    },
    {
      arm: "tight", provider: "kimi", model: "kimi-k3", role: "primary",
      measured: 1, sent: 1, verified: 1, referenceCompared: 1, matchesReference: 1, latencyMsTotal: 40
    }
  ]);
  assert.equal(faster.provider, "deepseek");
  const tied = recommend([
    {
      arm: "tight", provider: "deepseek", model: "deepseek-v4.1-flash", role: "baseline",
      measured: 1, sent: 1, verified: 1, referenceCompared: 1, matchesReference: 1, latencyMsTotal: 10
    },
    {
      arm: "tight", provider: "kimi", model: "kimi-k3", role: "primary",
      measured: 1, sent: 1, verified: 1, referenceCompared: 1, matchesReference: 1, latencyMsTotal: 10
    }
  ]);
  assert.equal(tied.provider, "kimi");
  const noReference = recommend([
    {
      arm: "tight", provider: "kimi", model: "kimi-k3", role: "primary",
      measured: 1, sent: 1, verified: 1, referenceCompared: 0, matchesReference: 0, latencyMsTotal: 10
    }
  ]);
  assert.equal(noReference.reason, "no-reference");
  assert.equal(noReference.arm, null);
});

test("parallel runs do not share secrets, and one thrown provider does not drop the other", async () => {
  const [left, right] = await Promise.all([
    runAb({
      formulas: [formula({ id: "left", pdfText: "x", reference: null })],
      arms: ["tight"],
      models: [channel("kimi", KIMI_KEY)],
      send: true,
      katex,
      now: clock(),
      transport: async () => ({ ok: true, text: KIMI_KEY })
    }),
    runAb({
      formulas: [formula({ id: "right", pdfText: "y", reference: "y" })],
      arms: ["tight"],
      models: [channel("deepseek", DEEPSEEK_KEY)],
      send: true,
      katex,
      now: clock(),
      transport: async () => ({ ok: true, text: "y" })
    })
  ]);
  assert.equal(left.rows[0].latex, null);
  assert.equal(left.rows[0].errorCode, "secret");
  assert.equal(right.rows[0].latex, "y");
  assert.equal(JSON.stringify(left).includes(KIMI_KEY), false);
  assert.equal(JSON.stringify(left).includes(DEEPSEEK_KEY), false);
  assert.equal(JSON.stringify(right).includes(KIMI_KEY), false);
  assert.equal(JSON.stringify(right).includes(DEEPSEEK_KEY), false);
  assert.notEqual(left.rows[0].id, right.rows[0].id);

  const mixed = await runAb({
    formulas: [formula()],
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY), channel("deepseek", DEEPSEEK_KEY)],
    send: true,
    katex,
    now: clock(),
    transport: async (call) => {
      if (call.provider === "kimi") throw new Error(`boom ${call.secret}`);
      return { ok: true, text: "x" };
    }
  });
  assert.equal(mixed.rows.find((row) => row.provider === "kimi").errorCode, "http");
  assert.equal(mixed.rows.find((row) => row.provider === "deepseek").verify.pass, true);
  assert.equal(JSON.stringify(mixed).includes(KIMI_KEY), false);
});

test("abort before the call sends nothing, and abort during the call drops the latex", async () => {
  const early = new AbortController();
  early.abort();
  let hooks = 0;
  let calls = 0;
  const before = await runAb({
    formulas: [formula(), formula({ id: "p3-2" })],
    arms: ["hi-res", "page"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    signal: early.signal,
    visionCropFor() {
      hooks += 1;
      return null;
    },
    transport: async () => {
      calls += 1;
      return { ok: true, text: "x" };
    }
  });
  assert.equal(hooks, 0);
  assert.equal(calls, 0);
  assert.equal(before.rows.every((row) => row.sent === false && row.latex === null && row.paint === "none"), true);

  const mid = new AbortController();
  calls = 0;
  const during = await runAb({
    formulas: [formula({ id: "first" }), formula({ id: "second", pdfText: "y", reference: "y" })],
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    signal: mid.signal,
    katex,
    now: clock(),
    transport: async () => {
      calls += 1;
      mid.abort();
      return { ok: true, text: "x", usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } };
    }
  });
  assert.equal(calls, 1);
  assert.equal(during.rows[0].latex, null);
  assert.equal(during.rows[0].paint, "none");
  assert.equal(during.rows[0].errorCode, "aborted");
  assert.equal(during.rows[0].sent, true);
  assert.deepEqual(during.rows[0].tokens, { prompt: 9, completion: 1, total: 10 });
  assert.equal(during.rows[1].sent, false);
  assert.equal(during.summary.verified, 0);
  assert.equal(JSON.stringify(during).includes(KIMI_KEY), false);
});

test("the live transport uses sendVision once, strips keys from the URL, and disables thinking", async () => {
  const box = harness(() => chat("x"));
  const report = await runAb({
    formulas: [formula({ legacy: true })],
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY, { baseUrl: `https://api.moonshot.cn/v1?api_key=${KIMI_KEY}` })],
    send: true,
    katex,
    now: clock(),
    transport: createLiveTransport({ net: box.net })
  });
  assert.equal(box.seen.length, 1);
  const url = new URL(box.seen[0].url);
  assert.equal(url.hostname, "api.moonshot.cn");
  assert.equal(url.pathname, "/v1/chat/completions");
  assert.equal(url.search, "");
  assert.equal(box.seen[0].url.includes(KIMI_KEY), false);
  const body = JSON.parse(box.seen[0].body);
  assert.equal(body.model, "kimi-k3");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.messages.some((message) => JSON.stringify(message).includes(KIMI_KEY)), false);
  const image = body.messages.at(-1).content.find((part) => part.type === "image_url");
  assert.match(image.image_url.url, /^data:image\/png;base64,/);
  assert.equal(image.image_url.url.includes("http"), false);
  assert.equal(box.seen[0].headers.Authorization, `Bearer ${KIMI_KEY}`);
  assert.equal(report.rows[0].latex, "x");
  assert.deepEqual(report.rows[0].tokens, { prompt: 3, completion: 2, total: 5 });
  assert.equal(Object.hasOwn(report.rows[0], "legacy"), false);
  assert.equal(JSON.stringify(report).includes(KIMI_KEY), false);

  const deepseek = harness(() => chat("x"));
  await createLiveTransport({ net: deepseek.net })({
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    baseUrl: "",
    system: "s",
    text: "独立公式",
    image: { mime: "image/png", base64: PNG },
    secret: DEEPSEEK_KEY
  });
  const deepBody = JSON.parse(deepseek.seen[0].body);
  assert.equal(deepBody.model, "deepseek-v4.1-flash");
  assert.deepEqual(deepBody.thinking, { type: "disabled" });
  assert.equal(deepBody.reasoning_effort, "minimal");
  assert.equal(new URL(deepseek.seen[0].url).hostname, "api.deepseek.com");
  assert.equal(deepseek.seen[0].body.includes(DEEPSEEK_KEY), false);

  const limited = harness(() => ({ ok: false, status: 429, data: { error: { message: `slow ${KIMI_KEY}` } } }));
  const denied = await createLiveTransport({ net: limited.net })({
    provider: "kimi",
    model: "kimi-k3",
    baseUrl: "",
    system: "s",
    text: "独立公式",
    image: { mime: "image/png", base64: PNG },
    secret: KIMI_KEY
  });
  assert.equal(limited.seen.length, 1);
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "429");
  assert.equal(JSON.stringify(denied).includes(KIMI_KEY), false);

  const evil = harness(() => chat("x"));
  const blocked = await runAb({
    formulas: [formula()],
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY, { baseUrl: `https://evil.example/v1?api_key=${KIMI_KEY}` })],
    send: true,
    katex,
    transport: createLiveTransport({ net: evil.net })
  });
  assert.equal(evil.seen.length, 0);
  assert.equal(blocked.rows[0].errorCode, "http");
  assert.equal(blocked.rows[0].paint, "crop");
  assert.equal(JSON.stringify(blocked).includes(KIMI_KEY), false);
  assert.equal(JSON.stringify(blocked).includes("evil.example"), false);
});

test("the CLI writes a template and a fake live report without touching the network", async (t) => {
  const dir = createOwnedTemp(t, "mm-dpo-");
  const logs = capture();
  const template = await main(["--template", "--out", dir], logs);
  assert.equal(template.code, 0);
  const saved = JSON.parse(readFileSync(template.paths.jsonPath, "utf8"));
  assert.equal(saved.mode, "template");
  assert.equal(saved.summary.checkedButMismatch, 0);
  assert.match(readFileSync(template.paths.mdPath, "utf8"), /核对过但与参考不一致：0/);

  const help = capture();
  const helped = await main(["--help", "--live", "--full"], {
    ...help,
    env: { MM_DPO_KIMI_API_KEY: KIMI_KEY },
    transport: async () => {
      throw new Error("help must not send");
    }
  });
  assert.equal(helped.code, 0);
  assert.match(help.out.join("\n"), /MM_DPO_DEEPSEEK_MODEL/);

  const missing = capture();
  const absent = await main(["--dry-run", "--pdf", join(dir, "missing.pdf")], missing);
  assert.equal(absent.code, 1);
  assert.match(missing.err.join("\n"), /2305\.18290/);
  assert.match(missing.err.join("\n"), /fetch-fixtures\.sh/);

  const bare = capture();
  const refused = await main(["--live", "--fixture", join(dir, "nope.json")], {
    ...bare,
    env: { MM_DPO_KIMI_API_KEY: KIMI_KEY }
  });
  assert.equal(refused.code, 2);
  assert.match(bare.err.join("\n"), /--limit/);

  const fixturePath = join(dir, "fixture.json");
  const referencePath = join(dir, "reference.json");
  const { writeFileSync } = await import("node:fs");
  writeFileSync(fixturePath, JSON.stringify({
    formulas: [
      formula({ id: "p3-1", pdfText: "x", reference: null, paragraphText: "PARA_SHOULD_STAY_OUT" }),
      formula({ id: "p4-1", page: 4, index: 1, pdfText: "y", reference: null, imageUrl: "" })
    ]
  }));
  writeFileSync(referencePath, JSON.stringify({
    formulas: [{ id: "p3-1", reference: "x^{2}" }]
  }));
  const emptyPath = join(dir, "empty.json");
  writeFileSync(emptyPath, JSON.stringify({
    formulas: [formula({ id: "p3-9", imageUrl: "", pdfText: "x" })]
  }));
  const liveLogs = capture();
  let sends = 0;
  const live = await main([
    "--live",
    "--limit=1",
    "--arm=tight",
    "--fixture", fixturePath,
    "--reference", referencePath,
    "--out", dir
  ], {
    ...liveLogs,
    env: { MM_DPO_KIMI_API_KEY: `Bearer ${KIMI_KEY}` },
    katex,
    now: clock(),
    generatedAt: "2026-10-23T00:00:00.000Z",
    visionCropFor: null,
    transport: async (call) => {
      sends += 1;
      assert.equal(call.secret, KIMI_KEY);
      assert.equal(call.text.includes("PARA_SHOULD_STAY_OUT"), false);
      return { ok: true, text: "x", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    }
  });
  assert.equal(live.code, 0);
  assert.equal(sends, 2);
  assert.equal(live.report.coverage.detected, 2);
  assert.equal(live.report.coverage.sampled, 1);
  assert.equal(live.report.coverage.complete, false);
  assert.equal(live.report.rows[0].checkedButMismatch, true);
  assert.equal(live.report.summary.byArmModel.some((item) => item.provider === "deepseek" && item.sent === 1), true);
  const written = readFileSync(live.paths.jsonPath, "utf8");
  assert.equal(written.includes(KIMI_KEY), false);
  assert.equal(written.includes("PARA_SHOULD_STAY_OUT"), false);
  assert.equal(written.includes(PNG), false);
  assert.match(readFileSync(live.paths.mdPath, "utf8"), /核对过但与参考不一致：2/);

  const noCrop = capture();
  const quiet = await main([
    "--live",
    "--limit=1",
    "--fixture", emptyPath,
    "--out", dir
  ], {
    ...noCrop,
    env: { MM_DPO_KIMI_API_KEY: KIMI_KEY },
    visionCropFor: null
  });
  assert.equal(quiet.code, 0);
  assert.equal(quiet.report.summary.sent, 0);
  assert.equal(quiet.report.rows[0].errorCode, "no-crop");
  const pageOnly = await main([
    "--live",
    "--full",
    "--arm=page",
    "--model=kimi",
    "--fixture", fixturePath,
    "--out", dir
  ], {
    env: { MM_DPO_KIMI_API_KEY: KIMI_KEY },
    stdout() {},
    stderr() {},
    visionCropFor: () => {
      throw new Error("page must not crop");
    },
    transport: async () => {
      throw new Error("page must not send");
    }
  });
  assert.equal(pageOnly.code, 0);
  assert.equal(pageOnly.report.arms.includes("page"), true);
  assert.equal(pageOnly.report.summary.sent, 0);
  assert.equal(pageOnly.report.rows.every((row) => row.arm === "page" && row.paint === "none"), true);
});

function memoryHooks() {
  return { createCanvas: createMemoryCanvas };
}

function fakePage(pageWidth, pageHeight, paint) {
  return {
    getViewport({ scale = 1, offsetX = 0, offsetY = 0 } = {}) {
      return {
        width: pageWidth * scale,
        height: pageHeight * scale,
        scale,
        offsetX,
        offsetY
      };
    },
    render({ canvasContext }) {
      paint(canvasContext);
      return { promise: Promise.resolve() };
    }
  };
}

function paintInset(ctx) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  const inset = 80;
  ctx.fillRect(inset, inset, Math.max(1, width - inset * 2), Math.max(1, height - inset * 2));
}

function catalog(perPage = 10) {
  const rows = [];
  let n = 0;
  for (const page of DPO_PAPER.pages) {
    for (let i = 0; i < perPage; i += 1) {
      n += 1;
      rows.push(formula({
        id: `p${page}-f${n}`,
        page,
        index: i + 1,
        display: i % 2 === 0,
        imageUrl: "",
        reference: "x"
      }));
    }
  }
  return rows;
}

test("hi-res uses the product vision crop, and paragraph adds a crop plus text", async () => {
  assert.equal(MM_TIER_VERSION, "mm-3");
  assert.equal(VISION_CROP_SCALE, 4);
  assert.deepEqual(DEFAULT_ARMS, ["tight"]);
  assert.equal(FORMULA_VISION_SYSTEM, "只输出这一个公式的 LaTeX，不加 $，不加解释；看不清就输出 UNREADABLE");
  assert.equal(FORMULA_VISION_SYSTEM.includes(PARAGRAPH_PROMPT_NOTE), false);
  const ignored = visionCropSpec({
    label: "formula",
    display: true,
    bbox: [0, 0, 1, 1],
    paragraph: { text: "the product prompt stays tight" }
  });
  assert.equal(ignored.mode, "tight");
  assert.equal(ignored.paragraph, null);
  assert.equal(ignored.scale, VISION_CROP_SCALE);

  const bbox = [0.1, 0.1, 0.9, 0.5];
  const page = fakePage(400, 200, paintInset);
  const seen = [];
  const render = (block, spec) => {
    seen.push({ block, spec });
    return renderVisionCrop(page, block, spec, memoryHooks());
  };
  const source = formula({
    id: "crop-1",
    bbox,
    display: true,
    pdfText: "x",
    reference: "x "
  });
  const dry = await runAb({
    formulas: [source],
    arms: ["hi-res"],
    models: [channel("kimi", KIMI_KEY)],
    send: false,
    renderVisionCrop: render
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].block.label, "formula");
  assert.equal(seen[0].spec.mode, "tight");
  assert.equal(seen[0].spec.paragraph, null);
  assert.equal(seen[0].spec.scale, VISION_CROP_SCALE);
  assert.equal(seen[0].spec.pad.namedPx, VISION_INK_PAD_PX.display);
  assert.deepEqual(seen[0].spec, visionCropSpec(seen[0].block, { scale: VISION_CROP_SCALE }));
  const directUrl = await renderVisionCrop(page, seen[0].block, visionCropSpec(seen[0].block), memoryHooks());
  const direct = parseCropDataUrl(directUrl);
  const product = await visionCropFor(seen[0].block, {
    scale: VISION_CROP_SCALE,
    renderVisionCrop: (block, spec) => renderVisionCrop(page, block, spec, memoryHooks())
  });
  const plan = visionRasterPlan({ bbox, pageWidth: 400, pageHeight: 200, scale: VISION_CROP_SCALE });
  assert.equal(product.meta.kind, "vision");
  assert.equal(product.meta.scale, VISION_CROP_SCALE);
  assert.equal(product.w, direct.w);
  assert.equal(product.h, direct.h);
  assert.ok(direct.w < plan.pixelWidth);
  assert.ok(direct.h < plan.pixelHeight);
  assert.equal(dry.rows[0].cropHash, product.hash);
  assert.equal(dry.rows[0].inputKind, "hi-res");
  assert.equal(dry.rows[0].placeholder, false);
  assert.equal(dry.rows[0].errorCode, "dry-run");
  assert.equal(dry.rows[0].sent, false);
  assert.equal(dry.summary.sent, 0);

  const calls = [];
  const live = await runAb({
    formulas: [source],
    arms: ["hi-res"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: clock(),
    renderVisionCrop: render,
    transport: async (call) => {
      calls.push(call);
      assert.equal(call.system, FORMULA_VISION_SYSTEM);
      assert.equal(call.system.includes(PARAGRAPH_PROMPT_NOTE), false);
      assert.match(call.image.base64, /^[A-Za-z0-9+/]+=*$/);
      assert.equal(call.image.base64.includes("http"), false);
      assert.equal(String(call.image.base64).includes("%PDF"), false);
      return { ok: true, text: "x", usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010 } };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].image.w, direct.w);
  assert.equal(calls[0].image.h, direct.h);
  assert.equal(live.rows[0].measured, true);
  assert.equal(live.rows[0].exactMatch, false);
  assert.equal(live.rows[0].matchesReference, true);
  assert.equal(latexExactMatch("x", "x "), false);
  assert.equal(latexMatchesReference("x", "x ", true), true);
  const priced = live.summary.byArmModel.find((item) => item.provider === "kimi");
  assert.equal(priced.estimatedCostUsd, estimateCostUsd("kimi", "kimi-k3", { prompt: 1000, completion: 10 }));
  assert.equal(priced.estimatedCostUsd, 0.00315);
  assert.equal(live.vision.tier, "mm-3");
  assert.equal(JSON.stringify(live).includes(KIMI_KEY), false);
  assert.equal(JSON.stringify(live).includes(calls[0].image.base64), false);

  const paragraphPage = fakePage(200, 100, (ctx) => {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.fillStyle = "#000000";
    ctx.fillRect(4, 4, 12, 8);
  });
  const paragraphBox = [0.05, 0.2, 0.8, 0.55];
  const paragraphFormula = formula({
    id: "para-1",
    display: false,
    inlineOf: "host",
    bbox: [0.2, 0.3, 0.35, 0.42],
    paragraphBbox: paragraphBox,
    paragraphText: "HOST_PARAGRAPH_CONTEXT",
    pdfText: "x",
    reference: "x"
  });
  const paragraphPlan = visionRasterPlan({
    bbox: paragraphBox,
    pageWidth: 200,
    pageHeight: 100,
    scale: VISION_CROP_SCALE
  });
  const paragraphPng = await renderParagraphCrop(paragraphPage, paragraphFormula, memoryHooks());
  assert.equal(paragraphPng.w, paragraphPlan.pixelWidth);
  assert.equal(paragraphPng.h, paragraphPlan.pixelHeight);
  assert.equal(paragraphPng.paragraphText, "HOST_PARAGRAPH_CONTEXT");
  assert.equal(paragraphPlan.scale, VISION_CROP_SCALE);
  let paragraphRenders = 0;
  let pageRenders = 0;
  const paragraphCalls = [];
  const paragraphReport = await runAb({
    formulas: [paragraphFormula],
    arms: ["paragraph", "page"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: clock(),
    renderParagraphCrop: async (item) => {
      paragraphRenders += 1;
      return renderParagraphCrop(paragraphPage, item, memoryHooks());
    },
    renderVisionCrop: async () => {
      pageRenders += 1;
      return "";
    },
    transport: async (call) => {
      paragraphCalls.push(call);
      return { ok: true, text: "x", usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
    }
  });
  assert.equal(paragraphRenders, 1);
  assert.equal(pageRenders, 0);
  assert.equal(paragraphCalls.length, 1);
  assert.equal(paragraphCalls[0].arm, "paragraph");
  assert.equal(paragraphCalls[0].text.includes("HOST_PARAGRAPH_CONTEXT"), true);
  assert.equal(paragraphCalls[0].system.startsWith(FORMULA_VISION_SYSTEM), true);
  assert.match(paragraphCalls[0].system, new RegExp(PARAGRAPH_PROMPT_NOTE));
  assert.equal(paragraphCalls[0].image.w, paragraphPlan.pixelWidth);
  assert.equal(paragraphCalls[0].image.h, paragraphPlan.pixelHeight);
  assert.equal(paragraphReport.rows.find((row) => row.arm === "paragraph").measured, true);
  assert.equal(paragraphReport.rows.find((row) => row.arm === "page").sent, false);
  assert.equal(paragraphReport.rows.find((row) => row.arm === "page").errorCode, "page-script-only");
  assert.equal(paragraphReport.productSendsPage, false);
  assert.equal(JSON.stringify(paragraphReport).includes("HOST_PARAGRAPH_CONTEXT"), false);
  assert.equal(JSON.stringify(paragraphReport).includes("%PDF"), false);
});

test("sample of 15 is deterministic and stratified across pages and kinds", () => {
  const rows = catalog(10);
  assert.equal(rows.length, 30);
  const first = selectSample(rows, 15);
  const second = selectSample(rows, 15);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.equal(first.length, 15);
  assert.equal(new Set(first.map((item) => item.page)).size, 3);
  assert.equal(first.some((item) => item.display === false), true);
  assert.equal(first.some((item) => item.display === true), true);
  const viaLimit = chooseFormulas(rows, { limit: 15 });
  const viaSample = chooseFormulas(rows, { sample: 15 });
  assert.deepEqual(viaLimit.ids, viaSample.ids);
  assert.equal(viaLimit.stratified, true);
  const locked = chooseFormulas(rows, { ids: ["p5-f21", "p3-f1"] });
  assert.deepEqual(locked.ids, ["p5-f21", "p3-f1"]);
  assert.equal(locked.locked, true);
  const full = chooseFormulas(rows, { full: true });
  assert.equal(full.stratified, false);
  assert.equal(full.ids.length, 30);

  const hosted = formulasFromBlocks([{
    page: 3,
    blocks: [
      { id: "above", label: "text", text: "ABOVE", bbox: [0.1, 0.05, 0.8, 0.12] },
      { id: "disp", label: "formula", display: true, bbox: [0.2, 0.14, 0.7, 0.22] },
      { id: "host", label: "text", sourceText: "HOST TEXT", bbox: [0.1, 0.4, 0.8, 0.55] },
      { id: "f", label: "formula", display: false, inlineOf: "host", bbox: [0.3, 0.42, 0.45, 0.5] },
      { id: "below", label: "text", text: "BELOW", bbox: [0.1, 0.7, 0.8, 0.9] }
    ]
  }]);
  assert.equal(hosted[0].id, "disp");
  assert.equal(hosted[0].paragraphText, "ABOVE");
  assert.ok(hosted[0].paragraphBbox[3] >= 0.22);
  assert.equal(hosted[1].id, "f");
  assert.equal(hosted[1].paragraphText, "HOST TEXT");
  assert.equal(hosted[1].paragraphBbox[0], 0.1);
  assert.ok(hosted[1].paragraphBbox[2] >= 0.45);

  const tied = inputDecision([
    { arm: "hi-res", provider: "kimi", model: "kimi-k3", role: "primary", referenceCompared: 15, matchesReference: 12 },
    { arm: "paragraph", provider: "kimi", model: "kimi-k3", role: "primary", referenceCompared: 15, matchesReference: 12 }
  ]);
  assert.equal(tied.suggestedArm, "hi-res");
  assert.equal(tied.clearlyBetter, false);
  assert.equal(tied.productDefault, false);
  assert.equal(tied.writesPreset, false);
  const better = inputDecision([
    { arm: "hi-res", provider: "kimi", model: "kimi-k3", role: "primary", referenceCompared: 15, matchesReference: 10 },
    { arm: "paragraph", provider: "kimi", model: "kimi-k3", role: "primary", referenceCompared: 15, matchesReference: 12 }
  ]);
  assert.equal(better.clearlyBetter, true);
  assert.equal(better.suggestedArm, "paragraph");
  assert.ok(better.paragraphNormalized >= better.hiResNormalized + D2_CLEAR_MARGIN);
  const short = inputDecision([
    { arm: "hi-res", provider: "kimi", model: "kimi-k3", role: "primary", referenceCompared: 100, matchesReference: 80 },
    { arm: "paragraph", provider: "kimi", model: "kimi-k3", role: "primary", referenceCompared: 100, matchesReference: 84 }
  ]);
  assert.equal(short.clearlyBetter, false);
  assert.equal(short.suggestedArm, "hi-res");
  assert.equal(COST_RATES[0].provider, "kimi");
  assert.equal(estimateCostUsd("deepseek", "deepseek-v4.1-flash", { prompt: 10, completion: 10 }), null);
});

test("dry-run samples without a network call, and a locked id list is what the report records", async (t) => {
  const before = liveFetchViolations();
  const dir = createOwnedTemp(t, "mm-dpo-sample-");
  const { writeFileSync } = await import("node:fs");
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify({ formulas: catalog(10) }));
  let sends = 0;
  const logs = capture();
  const sampled = await main([
    "--dry-run",
    "--sample=15",
    "--arm=tight,hi-res,paragraph,page",
    "--fixture", fixturePath,
    "--out", dir
  ], {
    ...logs,
    env: { MM_DPO_KIMI_API_KEY: KIMI_KEY },
    renderVisionCrop: async () => {
      throw new Error("dry-run still prepares crops, but this fixture has no page");
    },
    transport: async () => {
      sends += 1;
      throw new Error("dry-run must not send");
    }
  });
  assert.equal(sampled.code, 0);
  assert.equal(sends, 0);
  assert.equal(sampled.report.sample.stratified, true);
  assert.equal(sampled.report.sample.ids.length, 15);
  assert.deepEqual(sampled.report.sample.ids, selectSample(catalog(10), 15).map((item) => item.id));
  assert.equal(sampled.report.summary.sent, 0);
  assert.equal(sampled.report.rows.every((row) => row.sent === false), true);
  assert.equal(sampled.report.arms.includes("page"), true);
  assert.equal(liveFetchViolations(), before);

  const limitLogs = capture();
  const limited = await main([
    "--dry-run",
    "--limit=15",
    "--fixture", fixturePath,
    "--out", dir
  ], limitLogs);
  assert.deepEqual(limited.report.sample.ids, sampled.report.sample.ids);

  const lockPath = join(dir, "locked");
  const locked = await main([
    "--dry-run",
    "--ids=p4-f11,p3-f2",
    "--fixture", fixturePath,
    "--out", lockPath
  ], capture());
  assert.deepEqual(locked.report.sample.ids, ["p4-f11", "p3-f2"]);
  assert.equal(locked.report.sample.locked, true);
  assert.equal(liveFetchViolations(), before);
});

test("coverage stays incomplete off the 79-formula pages", async () => {
  const off = coverageOf([formula({ page: 9 })], 1);
  assert.equal(off.pagesMatch, false);
  assert.equal(off.complete, false);
  const partial = coverageOf(Array.from({ length: 79 }, (_, index) => formula({ id: `p3-${index}`, page: 3 })), 15);
  assert.equal(partial.pagesMatch, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.expected, 79);
  await assert.rejects(
    () => loadPdfFormulas(join(root, "tests/fixtures/missing-dpo.pdf")),
    /2305\.18290/
  );
});

const SAMPLED_REFERENCE_IDS = [
  "p3-b7", "p3-b8", "p3-b9", "p3-b12", "p3-b16", "p3-b22",
  "p4-b2", "p4-b3", "p4-b7", "p4-b9", "p4-b11", "p4-b16",
  "p5-b3", "p5-b4", "p5-b6"
];

test("DPO pages 3–5 detect 42 formula blocks after fonts load, in product order", async () => {
  const formulas = await loadPdfFormulas(join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf"));
  assert.equal(formulas.length, 42);
  const page3 = formulas.filter((item) => item.page === 3);
  assert.equal(page3.filter((item) => item.display === false).length, 10);
  assert.equal(page3.filter((item) => item.display !== false).length, 3);
  assert.equal(formulas.filter((item) => item.page === 4).length, 11);
  assert.equal(formulas.filter((item) => item.page === 5).length, 18);
  let lastPage = 0;
  for (const item of formulas) {
    assert.ok(item.page >= lastPage);
    lastPage = item.page;
  }
  assert.equal(formulas[0].id, "p3-b7");
  assert.equal(formulas.at(-1).page, 5);
});

test("the committed DPO reference covers the 15 sampled ids, and unaligned rows stay out of accuracy", async () => {
  const table = JSON.parse(readFileSync(join(root, "tests/fixtures/mm-dpo-reference.json"), "utf8"));
  assert.equal(table.arxiv, "2305.18290");
  assert.equal(table.version, "v3");
  assert.equal(table.pdfSha256, "92cb3a2b71362acda98a789b03d88688fd33cf5fcf13f81d2b1de30ee7d3b67a");
  assert.equal(table.detected, 42);
  assert.deepEqual(selectSample(table.formulas, 15).map((row) => row.id), SAMPLED_REFERENCE_IDS);
  assert.equal(table.legacy.detected, 37);
  assert.equal(table.legacy.formulas.length, 37);
  assert.match(table.legacy.note, /不能重放/);
  for (const id of SAMPLED_REFERENCE_IDS) {
    const row = table.formulas.find((item) => item.id === id);
    assert.ok(row, id);
    if (row.aligned) {
      assert.equal(row.confidence, "high");
      assert.equal(typeof row.reference, "string");
      assert.ok(row.reference.length > 0, id);
    } else {
      assert.equal(row.aligned, false);
      assert.equal(row.confidence, "none");
      assert.equal(row.reference, null);
    }
  }
  assert.equal(table.aligned, 30);
  assert.equal(table.unaligned, 12);
  assert.equal(table.probeCount, 10);
  assert.equal(table.probeAligned, 9);
  assert.equal(table.formulas.find((row) => row.id === "p3-b7").aligned, true);
  assert.equal(table.formulas.find((row) => row.id === "p3-b7").reference, String.raw`(y_1, y_2)\sim \pi`);
  assert.equal(table.formulas.find((row) => row.id === "p5-b17").reference.includes("\\log"), false);
  assert.match(table.formulas.find((row) => row.id === "p5-b17").reference, /arg\\,max/);
  assert.deepEqual(sameSourceSpan(table.formulas), []);
  assert.match(table.detectorNotes.join(" "), /p4-b7/);
  assert.equal(table.formulas.find((row) => row.id === "p3-b8").reason, "paragraph-fragment");
  assert.equal(table.formulas.find((row) => row.id === "p3-b8").reference, String.raw`(y \mid x)`);
  const garbled = table.formulas.find((row) => row.id === "p5-b6");
  assert.equal(garbled.aligned, false);
  assert.equal(garbled.reference, null);
  assert.equal(garbled.reason, "low-score");
  for (const row of table.formulas.filter((item) => item.aligned === false)) {
    assert.match(row.reason, /low-score|short-key|ambiguous|no-paragraph|no-inline|paragraph-tie|partial-block/);
  }
  assert.deepEqual(table.probes.map((row) => row.id), [
    "p3-s1", "p3-s2", "p3-s3", "p3-s4", "p3-s5",
    "p4-s1", "p4-s2", "p4-s3", "p4-s4", "p5-s1"
  ]);
  const attached = attachReferences([
    formula({ id: "p5-b6", reference: "LEAK", imageUrl: dataUrl(PNG) }),
    formula({ id: "p3-b9", reference: null, imageUrl: dataUrl(PNG), equationNumber: "(1)" }),
    formula({ id: "p3-s2", reference: "LEAK", imageUrl: dataUrl(PNG) })
  ], table);
  assert.equal(attached[0].reference, null);
  assert.equal(typeof attached[1].reference, "string");
  assert.equal(attached[2].reference, "y_w");
  const compared = await runAb({
    formulas: attached,
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: clock(),
    transport: async () => ({
      ok: true,
      text: "x",
      usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 }
    })
  });
  assert.equal(compared.rows[0].matchesReference, null);
  assert.equal(compared.rows[0].exactMatch, null);
  assert.equal(compared.rows[1].matchesReference, false);
  assert.equal(compared.rows[2].matchesReference, false);
  assert.equal(compared.summary.byArmModel[0].referenceCompared, 2);
  assert.equal(compared.references.unaligned.includes("p5-b6"), true);
  assert.equal(compared.references.unaligned.includes("p3-b9"), false);
  assert.match(reportToMarkdown(compared), /p5-b6/);
});

test("the CLI loads the committed reference when --reference is omitted", async (t) => {
  const dir = createOwnedTemp(t, "mm-dpo-ref-");
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify({
    formulas: [
      formula({ id: "p5-b6", reference: "LEAK", imageUrl: dataUrl(PNG) }),
      formula({ id: "p3-b9", reference: null, imageUrl: dataUrl(PNG) })
    ]
  }));
  const result = await main([
    "--dry-run",
    "--fixture", fixturePath,
    "--arm=tight",
    "--out", dir
  ], {
    env: { MM_DPO_KIMI_API_KEY: KIMI_KEY },
    stdout() {},
    stderr() {}
  });
  assert.equal(result.code, 0);
  assert.equal(result.report.references.aligned, 1);
  assert.deepEqual(result.report.references.unaligned, ["p5-b6"]);
  assert.match(readFileSync(result.paths.mdPath, "utf8"), /p5-b6/);
  assert.equal(readFileSync(result.paths.jsonPath, "utf8").includes("LEAK"), false);
});

test("the tight arm renders the product CROP_SCALE crop when the block has no image", async () => {
  assert.equal(CROP_SCALE, 2);
  assert.equal(FORMULA_INK_PAD_PX.inline, 4);
  assert.equal(FORMULA_INK_PAD_PX.display, 6);
  const pageWidth = 200;
  const pageHeight = 120;
  const bbox = [0.1, 0.1, 0.9, 0.7];
  const page = fakePage(pageWidth, pageHeight, paintInset);
  const rasterW = Math.max(1, Math.floor(pageWidth * CROP_SCALE));
  const rasterH = Math.max(1, Math.floor(pageHeight * CROP_SCALE));
  const probe = createMemoryCanvas(rasterW, rasterH);
  paintInset(probe.getContext("2d"));
  const image = probe.getContext("2d").getImageData(0, 0, rasterW, rasterH);
  const displayBox = measureFormulaCrop(bbox, image, { inline: false, protect: false }).bbox;
  const inlineBox = measureFormulaCrop(bbox, image, { inline: true, protect: false }).bbox;
  const displayRect = rasterCropRect(displayBox, rasterW, rasterH);
  const inlineRect = rasterCropRect(inlineBox, rasterW, rasterH);
  assert.notDeepEqual([displayRect.sw, displayRect.sh], [inlineRect.sw, inlineRect.sh]);
  const displayPng = await renderTightCrop(page, formula({
    id: "tight-display",
    display: true,
    bbox,
    imageUrl: ""
  }), memoryHooks());
  const inlinePage = fakePage(pageWidth, pageHeight, paintInset);
  const inlinePng = await renderTightCrop(inlinePage, formula({
    id: "tight-inline",
    display: false,
    inlineOf: "host",
    bbox,
    imageUrl: ""
  }), memoryHooks());
  assert.equal(displayPng.scale, CROP_SCALE);
  assert.equal(displayPng.w, displayRect.sw);
  assert.equal(displayPng.h, displayRect.sh);
  assert.equal(inlinePng.w, inlineRect.sw);
  assert.equal(inlinePng.h, inlineRect.sh);
  assert.ok(displayPng.w < rasterW);
  const calls = [];
  const live = await runAb({
    formulas: [formula({ id: "tight-pdf", display: true, bbox, imageUrl: "", reference: "x" })],
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: clock(),
    renderTightCrop: (item) => renderTightCrop(page, item, memoryHooks()),
    transport: async (call) => {
      calls.push(call);
      assert.match(call.image.base64, /^[A-Za-z0-9+/]+=*$/);
      return { ok: true, text: "x", usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].image.w, displayPng.w);
  assert.equal(calls[0].image.h, displayPng.h);
  assert.equal(live.rows[0].measured, true);
  assert.equal(live.rows[0].inputKind, "tight");
  assert.equal(live.rows[0].matchesReference, true);
  let skipped = 0;
  const kept = await runAb({
    formulas: [formula({ imageUrl: dataUrl(PNG) })],
    arms: ["tight"],
    models: [channel("kimi", KIMI_KEY)],
    send: false,
    renderTightCrop: async () => {
      skipped += 1;
      return null;
    }
  });
  assert.equal(skipped, 0);
  assert.equal(kept.rows[0].errorCode, "dry-run");
  assert.equal(kept.rows[0].cropHash.length > 0, true);
});

test("an Ark plan base URL is one chat/completions path, with base64 and thinking off", async () => {
  const box = harness(() => chat("x"));
  const base = `https://ark.cn-beijing.volces.com/api/plan/v3?api_key=${KIMI_KEY}`;
  const report = await runAb({
    formulas: [formula()],
    arms: ["tight"],
    models: channelsFromEnv({
      MM_DPO_KIMI_API_KEY: KIMI_KEY,
      MM_DPO_KIMI_MODEL: "kimi-k3",
      MM_DPO_KIMI_BASE_URL: base
    }, ["kimi"]),
    send: true,
    katex,
    now: clock(),
    transport: createLiveTransport({ net: box.net })
  });
  assert.equal(box.seen.length, 1);
  const url = new URL(box.seen[0].url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "ark.cn-beijing.volces.com");
  assert.equal(url.pathname, "/api/plan/v3/chat/completions");
  assert.equal(url.pathname.includes("/v1"), false);
  assert.equal(url.search, "");
  assert.equal(box.seen[0].url.includes(KIMI_KEY), false);
  const body = JSON.parse(box.seen[0].body);
  assert.equal(body.model, "kimi-k3");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  const image = body.messages.at(-1).content.find((part) => part.type === "image_url");
  assert.match(image.image_url.url, /^data:image\/png;base64,/);
  assert.equal(image.image_url.url.includes("http"), false);
  assert.equal(box.seen[0].headers.Authorization, `Bearer ${KIMI_KEY}`);
  assert.equal(report.rows[0].latex, "x");
  assert.equal(JSON.stringify(report).includes(KIMI_KEY), false);
  assert.equal(JSON.stringify(report).includes("ark.cn-beijing.volces.com"), false);
  assert.equal(typeof estimateCostUsd("kimi", "kimi-k3", { prompt: 10, completion: 2 }), "number");
  assert.equal(typeof estimateCostUsd("kimi", "ark-endpoint-id", { prompt: 10, completion: 2 }), "number");
  assert.equal(estimateCostUsd("deepseek", "deepseek-v4.1-flash", { prompt: 10, completion: 2 }), null);
  assert.equal(estimateCostUsd("kimi", "kimi-k3", null), null);
});

test("D2 treats a floating 5-point gap as clear, and an unknown kimi model still prices", () => {
  const edge = inputDecision([
    { arm: "hi-res", provider: "kimi", model: "kimi-k3", role: "primary", referenceCompared: 20, matchesReference: 16 },
    { arm: "paragraph", provider: "kimi", model: "kimi-k3", role: "primary", referenceCompared: 20, matchesReference: 17 }
  ]);
  assert.equal(17 / 20 >= 16 / 20 + D2_CLEAR_MARGIN, false);
  assert.equal(edge.clearlyBetter, true);
  assert.equal(edge.suggestedArm, "paragraph");
  assert.equal(edge.productDefault, false);
  const priced = estimateCostUsd("kimi", "not-a-listed-model", { prompt: 1_000_000, completion: 0 });
  assert.equal(priced, 3);
  assert.equal(estimateCostUsd("", "kimi-k3", { prompt: 10, completion: 10 }), null);
});

test("canonical scoring keeps exact match, and real DPO outputs only match when the symbols match", () => {
  const table = JSON.parse(read("tests/fixtures/mm-dpo-reference.json"));
  const referenceOf = (id) => table.formulas.find((row) => row.id === id).reference;
  const p3b9 = String.raw`p ^ { * } ( y _ { 1 } \succ y _ { 2 } \mid x ) = \frac { \exp \left( r ^ { * } ( x , y _ { 1 } ) \right) } { \exp \left( r ^ { * } ( x , y _ { 1 } ) \right) + \exp \left( r ^ { * } ( x , y _ { 2 } ) \right) } .`;
  const pStar = table.formulas.find((row) => String(row.reference || "").startsWith("p^*(y_1"));
  assert.equal(pStar.id, "p3-b12");
  assert.equal(latexCanonicalMatch(p3b9, pStar.reference), true);
  assert.equal(latexExactMatch(p3b9, pStar.reference), false);
  assert.equal(latexMatchesReference(p3b9, pStar.reference, true), false);
  assert.equal(latexCanonicalMatch(p3b9, table.legacy.formulas.find((row) => row.id === "p3-b9").reference), true);
  assert.equal(latexCanonicalMatch(String.raw`\pi_{\mathrm{refl}}`, String.raw`\pi_\text{ref}`), false);
  assert.equal(latexCanonicalMatch(String.raw`\pi_{\mathrm{ref}}`, String.raw`\pi_\text{ref}`), true);
  assert.equal(latexCanonicalMatch(String.raw`\pi_1`, String.raw`\pi_{ref}`), false);
  assert.equal(latexCanonicalMatch(String.raw`\pi_1`, referenceOf("p4-b9")), false);
  const otherEquation = String.raw`Z(x) = \sum _ { y } \pi _ { \mathrm { r e f } } ( y \mid x ) \exp \left( \frac { 1 } { \beta } r ( x , y ) \right)`;
  assert.equal(latexCanonicalMatch(otherEquation, referenceOf("p4-b9")), false);
  const preferenceInstead = String.raw`p^{*}(y_1 \succ y_2 \mid x) = \frac{1}{1 + \exp\left(\beta \log \frac{\pi^{*}(y_2 \mid x)}{\pi_{\mathrm{ref}}(y_2 \mid x)} - \beta \log \frac{\pi^{*}(y_1 \mid x)}{\pi_{\mathrm{ref}}(y_1 \mid x)}\right)}`;
  assert.equal(latexCanonicalMatch(preferenceInstead, referenceOf("p4-b11")), false);
  assert.equal(canonicalizeLatex(String.raw`{\cal L}`), canonicalizeLatex(String.raw`\mathcal{L}`));
  assert.equal(canonicalizeLatex(String.raw`\bigl(x\bigr)`), "(x)");
  assert.equal(canonicalizeLatex(String.raw`a = \\ -b`), "a=-b");
  assert.equal(latexCanonicalMatch(String.raw`x.\tag{2}\label{eq:x}`, "x"), true);
});

test("rescore recomputes a saved report without a network call or opening the PDF", async (t) => {
  const before = liveFetchViolations();
  const dir = createOwnedTemp(t, "mm-dpo-rescore-");
  const input = join(dir, "live.json");
  const p3b9 = String.raw`p ^ { * } ( y _ { 1 } \succ y _ { 2 } \mid x ) = \frac { \exp \left( r ^ { * } ( x , y _ { 1 } ) \right) } { \exp \left( r ^ { * } ( x , y _ { 1 } ) \right) + \exp \left( r ^ { * } ( x , y _ { 2 } ) \right) } .`;
  const saved = {
    schema: "open-immerse.mm-dpo-ab/v1",
    mode: "live",
    generatedAt: "2026-10-23T14:49:17.125Z",
    sample: { stratified: true, locked: false, requested: 2, ids: ["p3-b9", "p4-b9"] },
    arms: ["tight", "hi-res"],
    channels: [{ role: "primary", provider: "kimi", model: "kimi-k3", envKey: "MM_DPO_KIMI_API_KEY", hasKey: true }],
    coverage: { expected: 79, detected: 37, sampled: 2, pages: [3, 4, 5], pagesMatch: true, complete: false },
    rows: [
      {
        id: "p3-b9",
        arm: "tight",
        provider: "kimi",
        model: "kimi-k3",
        role: "primary",
        measured: true,
        sent: true,
        latex: p3b9,
        verify: { checked: true, pass: true },
        exactMatch: false,
        matchesReference: false
      },
      {
        id: "p4-b9",
        arm: "hi-res",
        provider: "kimi",
        model: "kimi-k3",
        role: "primary",
        measured: true,
        sent: true,
        latex: String.raw`\pi_{\mathrm{refl}}`,
        verify: { checked: true, pass: true },
        exactMatch: false,
        matchesReference: false
      }
    ]
  };
  const original = JSON.stringify(saved);
  writeFileSync(input, original);
  const out = join(dir, "out");
  const logs = capture();
  const result = await main([
    "--rescore", input,
    "--out", out,
    "--pdf", join(dir, "missing.pdf"),
    "--live"
  ], {
    ...logs,
    transport() {
      throw new Error("rescore must not send");
    }
  });
  assert.equal(result.code, 2);
  assert.match(logs.err.join("\n"), /--rescore/);
  assert.equal(readFileSync(input, "utf8"), original);

  const scored = await main(["--rescore", input, "--out", out], {
    stdout() {},
    stderr(line) {
      throw new Error(line);
    },
    transport() {
      throw new Error("rescore must not send");
    }
  });
  assert.equal(scored.code, 0);
  assert.equal(scored.report.mode, "rescore");
  assert.equal(scored.report.generatedAt, saved.generatedAt);
  assert.equal(scored.report.summary.sent, 2);
  const tight = scored.report.summary.byArmModel.find((group) => group.arm === "tight");
  const hi = scored.report.summary.byArmModel.find((group) => group.arm === "hi-res");
  assert.equal(tight.canonicalMatches, 1);
  assert.equal(tight.matchesReference, 0);
  assert.equal(tight.exactMatches, 0);
  assert.equal(hi.canonicalMatches, 0);
  assert.equal(scored.report.rows.find((row) => row.id === "p3-b9").canonicalMatch, true);
  assert.equal(scored.report.rows.find((row) => row.id === "p4-b9").canonicalMatch, false);
  assert.equal(readFileSync(input, "utf8"), original);
  const written = JSON.parse(readFileSync(scored.paths.jsonPath, "utf8"));
  assert.equal(written.mode, "rescore");
  assert.equal(written.rows.find((row) => row.id === "p3-b9").latex, p3b9);
  assert.equal(written.rows.find((row) => row.id === "p3-b9").canonicalMatch, true);
  const currentPath = join(dir, "current.json");
  const shifted = {
    ...saved,
    coverage: { ...saved.coverage, detected: 42 },
    rows: [saved.rows[0]]
  };
  writeFileSync(currentPath, JSON.stringify(shifted));
  const movedId = await main(["--rescore", currentPath, "--out", join(dir, "current")], {
    stdout() {},
    stderr(line) {
      throw new Error(line);
    }
  });
  assert.equal(movedId.report.rows[0].id, "p3-b9");
  assert.equal(movedId.report.rows[0].canonicalMatch, false);
  const pStar = JSON.parse(read("tests/fixtures/mm-dpo-reference.json")).formulas.find((row) => row.id === "p3-b12");
  writeFileSync(currentPath, JSON.stringify({
    ...shifted,
    rows: [{ ...saved.rows[0], reference: pStar.reference }]
  }));
  const byContent = await main(["--rescore", currentPath, "--out", join(dir, "content")], {
    stdout() {},
    stderr(line) {
      throw new Error(line);
    }
  });
  assert.equal(byContent.report.rows[0].canonicalMatch, true);
  const missing = await main(["--rescore", join(dir, "nope.json")], { stdout() {}, stderr() {} });
  assert.equal(missing.code, 1);
  assert.equal(liveFetchViolations(), before);
});

test("deepseek on the Ark plan base reuses the kimi key and the same request shape", async () => {
  const box = harness(() => chat("x"));
  const base = `https://ark.cn-beijing.volces.com/api/plan/v3?api_key=${KIMI_KEY}`;
  const channels = channelsFromEnv({
    MM_DPO_KIMI_API_KEY: KIMI_KEY,
    MM_DPO_DEEPSEEK_MODEL: "deepseek-v4.1-flash",
    MM_DPO_DEEPSEEK_BASE_URL: base
  }, ["deepseek"]);
  assert.equal(channels[0].secret, KIMI_KEY);
  const report = await runAb({
    formulas: [formula()],
    arms: ["tight"],
    models: channels,
    send: true,
    katex,
    now: clock(),
    transport: createLiveTransport({ net: box.net })
  });
  assert.equal(box.seen.length, 1);
  const url = new URL(box.seen[0].url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "ark.cn-beijing.volces.com");
  assert.equal(url.pathname, "/api/plan/v3/chat/completions");
  assert.equal(url.pathname.includes("/v1"), false);
  assert.equal(url.search, "");
  assert.equal(box.seen[0].url.includes(KIMI_KEY), false);
  const body = JSON.parse(box.seen[0].body);
  assert.equal(body.model, "deepseek-v4.1-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.reasoning_effort, undefined);
  const image = body.messages.at(-1).content.find((part) => part.type === "image_url");
  assert.match(image.image_url.url, /^data:image\/png;base64,/);
  assert.equal(image.image_url.url.includes("http"), false);
  assert.equal(box.seen[0].headers.Authorization, `Bearer ${KIMI_KEY}`);
  assert.equal(report.rows[0].provider, "deepseek");
  assert.equal(report.rows[0].model, "deepseek-v4.1-flash");
  assert.equal(JSON.stringify(report).includes(KIMI_KEY), false);
  assert.equal(JSON.stringify(report).includes("ark.cn-beijing.volces.com"), false);

  const own = harness(() => chat("x"));
  await createLiveTransport({ net: own.net })({
    provider: "deepseek",
    model: "deepseek-v4.1-flash",
    baseUrl: base,
    system: "s",
    text: "独立公式",
    image: { mime: "image/png", base64: PNG },
    secret: DEEPSEEK_KEY
  });
  assert.equal(own.seen[0].headers.Authorization, `Bearer ${DEEPSEEK_KEY}`);
  assert.equal(own.seen[0].url.includes(KIMI_KEY), false);
  assert.equal(own.seen[0].url.includes(DEEPSEEK_KEY), false);
  assert.equal(JSON.parse(own.seen[0].body).reasoning_effort, undefined);
});

test("the extension manifest and CI do not run the paid script", () => {
  const manifest = read("manifest.json");
  assert.equal(manifest.includes("oi-qa"), false);
  assert.equal(manifest.includes("mm-dpo"), false);
  const workflow = read(".github/workflows/test.yml");
  assert.equal(workflow.includes("mm-dpo-reference"), false);
  assert.equal(workflow.includes("--live"), false);
  const listed = read("scripts/ci/representative-tests.txt");
  assert.match(listed, /tests\/mm-dpo-ab\.test\.mjs/);
  assert.match(read(".gitignore"), /oi-qa\/f7-multimodal\/runs\//);
});

test("context crop draws the red box outside the glyphs, and paragraph does too", async () => {
  assert.equal(FORMULA_VISION_SYSTEM.includes(CONTEXT_PROMPT_NOTE), false);
  assert.equal(FORMULA_VISION_SYSTEM.includes(PARAGRAPH_PROMPT_NOTE), false);
  assert.equal(TARGET_BOX_PX, 3);
  const pageWidth = 200;
  const pageHeight = 400;
  const target = [0.4, 0.42, 0.55, 0.48];
  const column = [0.08, 0.1, 0.92, 0.9];
  const source = formula({
    id: "ctx-1",
    display: false,
    inlineOf: "host",
    bbox: target,
    layoutBbox: target,
    paragraphBbox: column,
    paragraphText: `NEIGHBOR ${"word ".repeat(80)}`,
    pdfText: "β",
    reference: "\\beta"
  });
  const windowBox = contextWindow(source);
  assert.ok(windowBox.bbox[0] <= target[0]);
  assert.ok(windowBox.bbox[2] >= target[2]);
  assert.ok(windowBox.bbox[0] >= column[0] - 1e-9);
  assert.ok(windowBox.bbox[2] <= column[2] + 1e-9);
  const yPad = target[1] - windowBox.bbox[1];
  assert.ok(yPad >= 0.01 && yPad <= 0.021);
  assert.ok(windowBox.bbox[3] - windowBox.bbox[1] < column[3] - column[1]);
  const display = contextWindow(formula({
    display: true,
    bbox: [0.2, 0.3, 0.8, 0.7],
    paragraphBbox: [0.1, 0.05, 0.9, 0.95]
  }));
  assert.ok(Math.abs((0.3 - display.bbox[1]) - 0.014) < 1e-9);
  assert.ok(display.bbox[3] - display.bbox[1] < 0.5);

  function expectedPixels(crop, box) {
    const scale = 4;
    const fullW = pageWidth * scale;
    const fullH = pageHeight * scale;
    const x = Math.round((box[0] - crop[0]) * fullW);
    const y = Math.round((box[1] - crop[1]) * fullH);
    const x2 = Math.round((box[2] - crop[0]) * fullW);
    const y2 = Math.round((box[3] - crop[1]) * fullH);
    return { x, y, w: x2 - x, h: y2 - y };
  }
  function positionedPage() {
    return {
      getViewport({ scale = 1, offsetX = 0, offsetY = 0 } = {}) {
        return { width: pageWidth * scale, height: pageHeight * scale, scale, offsetX, offsetY };
      },
      render({ canvasContext, viewport }) {
        canvasContext.fillStyle = "#ffffff";
        canvasContext.fillRect(0, 0, canvasContext.canvas.width, canvasContext.canvas.height);
        const x = target[0] * pageWidth * viewport.scale + viewport.offsetX;
        const y = target[1] * pageHeight * viewport.scale + viewport.offsetY;
        const w = (target[2] - target[0]) * pageWidth * viewport.scale;
        const h = (target[3] - target[1]) * pageHeight * viewport.scale;
        canvasContext.fillStyle = "#000000";
        canvasContext.fillRect(x, y, w, h);
        return { promise: Promise.resolve() };
      }
    };
  }
  function pixel(image, x, y) {
    const index = (y * image.width + x) * 4;
    return image.rgba.slice(index, index + 4);
  }
  function isRed(channels) {
    return channels[0] > 180 && channels[1] < 40 && channels[2] < 40 && channels[3] > 200;
  }
  function assertBox(png, crop, gap) {
    const image = decodeRgbaPng(png.base64);
    const rect = expectedPixels(crop, target);
    const midX = rect.x + Math.floor(rect.w / 2);
    const midY = rect.y + Math.floor(rect.h / 2);
    assert.equal(isRed(pixel(image, 0, 0)), false);
    assert.equal(isRed(pixel(image, midX, rect.y - gap - 2)), true);
    assert.equal(isRed(pixel(image, rect.x - gap - 2, midY)), true);
    if (gap > 0) {
      assert.equal(isRed(pixel(image, midX, rect.y - 1)), false);
      assert.equal(isRed(pixel(image, rect.x - 1, midY)), false);
    }
    let redInside = 0;
    let blackInside = 0;
    for (let py = rect.y + 2; py < rect.y + rect.h - 2; py += 1) {
      for (let px = rect.x + 2; px < rect.x + rect.w - 2; px += 1) {
        const channels = pixel(image, px, py);
        if (isRed(channels)) redInside += 1;
        if (channels[0] < 30 && channels[1] < 30 && channels[2] < 30 && channels[3] > 200) blackInside += 1;
      }
    }
    assert.equal(redInside, 0);
    assert.ok(blackInside > 0);
  }
  const page = positionedPage();
  const contextPng = await renderContextCrop(page, source, memoryHooks());
  assert.equal(contextPng.scale, 4);
  assert.equal(TARGET_BOX_GAP, 2);
  assertBox(contextPng, windowBox.bbox, TARGET_BOX_GAP);
  const paragraphPng = await renderParagraphCrop(page, source, memoryHooks());
  assertBox(paragraphPng, column, 0);
  const calls = [];
  const report = await runAb({
    formulas: [source],
    arms: ["context"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    katex,
    now: clock(),
    renderContextCrop: (item) => renderContextCrop(page, item, memoryHooks()),
    transport: async (call) => {
      calls.push(call);
      return { ok: true, text: "\\beta", usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } };
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].system.startsWith(FORMULA_VISION_SYSTEM), true);
  assert.match(calls[0].system, new RegExp(CONTEXT_PROMPT_NOTE));
  assert.equal(calls[0].text.includes("NEIGHBOR"), true);
  assert.ok(calls[0].text.length < 400);
  assert.equal(report.rows[0].measured, true);
  assert.equal(report.rows[0].inputKind, "context");
  assert.equal(report.summary.recommended.productDefault, false);
  assert.equal(report.writesPreset, false);
  const pendingCalls = [];
  const pending = await runAb({
    formulas: [source],
    arms: ["context"],
    models: [channel("kimi", KIMI_KEY)],
    send: true,
    now: clock(),
    transport: async () => {
      pendingCalls.push(1);
      return { ok: true, text: "x" };
    }
  });
  assert.equal(pendingCalls.length, 0);
  assert.equal(pending.rows[0].errorCode, "pending-context");
  assert.equal(pending.summary.sent, 0);
});

test("short probes stay under the 12pt gate and the pick is deterministic", () => {
  assert.equal(FORMULA_RUN_MIN_WIDTH, 12);
  assert.match(read("lib/pdf-text-layer.js"), /export const FORMULA_RUN_MIN_WIDTH = 12;/);
  assert.equal(probeSignature("πθ"), "pitheta");
  assert.equal(probeSignature("πSFT"), "pisft");
  assert.equal(probeSignature("π∗"), "star");
  assert.equal(probeSignature("rˆθ"), "hat");
  assert.equal(probeSignature("yw"), "yw");
  assert.equal(probeSignature("yl"), "yl");
  assert.equal(probeSignature("β"), "beta");
  assert.equal(probeSignature("π"), "bare");
  assert.equal(PROBE_SIGNATURES.includes("bare"), false);
  const betas = Array.from({ length: 8 }, (_, index) => ({
    id: `b${index}`,
    page: 4,
    signature: "beta",
    bbox: [0.1, 0.1 + index * 0.05, 0.12, 0.14 + index * 0.05],
    pdfText: "β"
  }));
  const yw = { id: "w", page: 3, signature: "yw", bbox: [0.2, 0.2, 0.24, 0.24], pdfText: "yw" };
  const first = selectShortProbes([...betas, yw], 3);
  const second = selectShortProbes([...betas, yw], 3);
  assert.deepEqual(first.map((item) => item.id), second.map((item) => item.id));
  assert.equal(first.filter((item) => item.signature === "yw").length, 1);
  assert.equal(first.filter((item) => item.signature === "beta").length, 2);

  const viewport = {
    width: 400,
    height: 100,
    convertToViewportRectangle(rect) { return rect.slice(); }
  };
  const text = (partial) => ({
    str: "y",
    x: 0,
    y: 40,
    width: 5,
    height: 10,
    fontName: "CMMI10",
    ...partial
  });
  const pages = [{
    page: 3,
    viewport,
    blocks: [{ id: "t1", label: "text", bbox: [0, 0.2, 1, 0.8], text: "where the reward model prefers one answer" }],
    items: [
      text({ str: "where", x: 0, width: 40, fontName: "NimbusRomNo9L-Reg" }),
      text({ str: "y", x: 50, width: 5 }),
      text({ str: "w", x: 55, width: 4, height: 6, y: 43, fontName: "CMMI7" }),
      text({ str: "and", x: 80, width: 20, fontName: "NimbusRomNo9L-Reg" }),
      text({ str: "β", x: 120, width: 6 }),
      text({ str: "a", x: 200, width: 6 }),
      text({ str: "b", x: 206, width: 6 }),
      text({ str: "c", x: 212, width: 6 }),
      text({ str: "π", x: 300, width: 6 })
    ]
  }];
  const covered = [{ page: 3, bbox: [0.74, 0.3, 0.82, 0.7], layoutBbox: [0.74, 0.3, 0.82, 0.7] }];
  const candidates = extractShortCandidates({ pages, formulas: covered });
  const again = extractShortCandidates({ pages, formulas: covered });
  assert.deepEqual(candidates.map((item) => item.pdfText), again.map((item) => item.pdfText));
  assert.deepEqual(candidates.map((item) => item.pdfText).sort(), ["yw", "β"]);
  assert.equal(candidates.some((item) => item.pdfText.includes("π")), false);
  assert.equal(candidates.some((item) => item.pdfText.includes("abc")), false);
});

test("alignment keeps a unique prefix and a parenthesized fragment, and leaves a garbled line", () => {
  const prose = "Reward Modelling Phase the SFT model is prompted with prompts to produce pairs of answers then human labelers prefer";
  const other = "where the reward is implicitly defined by the language model and the reference model in this section";
  const units = [
    {
      id: "p33",
      kind: "paragraph",
      text: prose,
      parts: [
        { type: "inline", id: "i26", latex: String.raw`(y_1, y_2)\sim \pi^\text{SFT}(y \mid x)` },
        { type: "inline", id: "i31", latex: "r^*(y, x)" },
        { type: "inline", id: "i32", latex: "p^*" }
      ]
    },
    {
      id: "p96",
      kind: "paragraph",
      text: other,
      parts: [
        { type: "inline", id: "i88", latex: String.raw`\hat{r}_\theta(x, y) = \beta \log \frac{\pi_\theta(y \mid x)}{\pi_\text{ref}(y \mid x)}` }
      ]
    },
    {
      id: "decoy",
      kind: "paragraph",
      text: "unrelated appendix about datasets hyperparameters and training curves only",
      parts: []
    }
  ];
  const rows = alignDetectedFormulas([
    { id: "cut", page: 3, display: false, pdfText: "(y1, y2) ∼ π", paragraphText: prose, equationNumber: null },
    { id: "frag", page: 3, display: false, pdfText: "(y | x)", paragraphText: prose, equationNumber: null },
    { id: "star", page: 3, display: false, pdfText: "p∗", paragraphText: prose, equationNumber: null },
    { id: "mess", page: 5, display: false, pdfText: "θ(x, y) = βlog ππrefθ((yy||xx))", paragraphText: other, equationNumber: null }
  ], units);
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  assert.equal(byId.cut.reason, "paragraph-prefix");
  assert.equal(byId.cut.reference, String.raw`(y_1, y_2)\sim \pi`);
  assert.equal(byId.cut.reference.includes("SFT"), false);
  assert.equal(byId.cut.reference.includes(byId.frag.reference), false);
  assert.equal(byId.frag.reference, String.raw`(y \mid x)`);
  assert.deepEqual(sameSourceSpan(rows), []);
  assert.equal(byId.star.reference, "p^*");
  assert.equal(byId.mess.aligned, false);
  assert.equal(byId.mess.reference, null);
  assert.equal(byId.mess.reason, "low-score");
});

test("DPO short probes match the committed set and do not move the 15-sample", async (t) => {
  const session = await openPdfSession(join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf"));
  t.after(() => session.close());
  const table = JSON.parse(readFileSync(join(root, "tests/fixtures/mm-dpo-reference.json"), "utf8"));
  assert.equal(session.formulas.length, 42);
  assert.deepEqual(session.probes.map((item) => item.id), table.probes.map((item) => item.id));
  assert.deepEqual(session.probes.map((item) => item.pdfText), table.probes.map((item) => item.pdfText));
  assert.deepEqual(selectSample(session.formulas, 15).map((item) => item.id), SAMPLED_REFERENCE_IDS);
  const again = session.probes.map((item) => `${item.id}:${item.pdfText}`);
  assert.deepEqual(again, table.probes.map((item) => `${item.id}:${item.pdfText}`));
});

test("--probe-short appends script probes without replacing the stratified sample", async (t) => {
  const dir = createOwnedTemp(t, "mm-dpo-probe-");
  const fixturePath = join(dir, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify({
    formulas: [formula({ id: "only-one", equationNumber: null, imageUrl: dataUrl(PNG), pdfText: "x" })],
    probes: [formula({ id: "probe-x", equationNumber: null, display: false, imageUrl: dataUrl(PNG), pdfText: "β" })]
  }));
  const withProbes = await main([
    "--dry-run",
    "--fixture", fixturePath,
    "--sample=15",
    "--probe-short",
    "--arm=tight",
    "--out", dir
  ], {
    env: { MM_DPO_KIMI_API_KEY: KIMI_KEY },
    stdout() {},
    stderr() {}
  });
  assert.equal(withProbes.code, 0);
  assert.deepEqual(withProbes.report.sample.ids, ["only-one", "probe-x"]);
  assert.equal(withProbes.report.summary.sent, 0);
  assert.equal(withProbes.report.coverage.detected, 1);
  const plain = await main([
    "--dry-run",
    "--fixture", fixturePath,
    "--sample=15",
    "--arm=tight",
    "--out", join(dir, "plain")
  ], {
    env: { MM_DPO_KIMI_API_KEY: KIMI_KEY },
    stdout() {},
    stderr() {}
  });
  assert.deepEqual(plain.report.sample.ids, ["only-one"]);
});

test("a prefix reference stops at the block and does not swallow the next block", () => {
  const prose = "the optimal policy under the reference model is written as the following expectation over the dataset";
  const units = [{
    id: "p-long",
    kind: "paragraph",
    text: prose,
    parts: [{
      type: "inline",
      id: "i110",
      latex: String.raw`\pi_\text{ref} = \operatorname{arg\,max}_{\pi}\mathbb{E}_{x, y_w \sim \mathcal{D}}\left[\log \pi(y_w \mid x)\right]`
    }]
  }];
  const rows = alignDetectedFormulas([
    {
      id: "head",
      page: 5,
      display: false,
      pdfText: "πref = arg maxπ Ex,yw∼D",
      paragraphText: prose,
      equationNumber: null
    },
    {
      id: "tail",
      page: 5,
      display: false,
      pdfText: "π(yw | x)]",
      paragraphText: prose,
      equationNumber: null
    }
  ], units);
  const head = rows.find((row) => row.id === "head");
  const tail = rows.find((row) => row.id === "tail");
  assert.equal(head.reason, "paragraph-prefix");
  assert.equal(head.reference.includes("\\log"), false);
  assert.match(head.reference, /mathcal\{D\}/);
  assert.equal(tail.aligned, false);
  assert.equal(head.reference.includes("\\pi(y_w \\mid x)"), false);
  assert.deepEqual(sameSourceSpan(rows), []);
});

test("context is the suggested input only when it clears the hi-res margin", () => {
  const kimi = (arm, compared, hits, probeCompared = 0, probeHits = 0) => ({
    arm,
    provider: "kimi",
    model: "kimi-k3",
    role: "primary",
    referenceCompared: compared,
    canonicalMatches: hits,
    probeReferenceCompared: probeCompared,
    probeCanonicalMatches: probeHits
  });
  const close = inputDecision([
    kimi("hi-res", 20, 16, 10, 6),
    kimi("paragraph", 20, 16, 10, 6),
    kimi("context", 20, 16, 10, 6)
  ]);
  assert.equal(close.contextEligible, false);
  assert.equal(close.suggestedArm, "hi-res");
  assert.equal(close.productDefault, false);
  const overall = inputDecision([
    kimi("hi-res", 20, 14, 10, 5),
    kimi("paragraph", 20, 14, 10, 5),
    kimi("context", 20, 16, 10, 5)
  ]);
  assert.equal(overall.contextEligible, true);
  assert.equal(overall.suggestedArm, "context");
  assert.ok(overall.contextNormalized >= overall.hiResNormalized + D2_CLEAR_MARGIN);
  const probes = inputDecision([
    kimi("hi-res", 20, 16, 10, 4),
    kimi("paragraph", 20, 16, 10, 4),
    kimi("context", 20, 16, 10, 6)
  ]);
  assert.equal(probes.contextNormalized, probes.hiResNormalized);
  assert.equal(probes.contextEligible, true);
  assert.equal(probes.suggestedArm, "context");
  const counted = summarizeRows([
    { id: "p3-b7", arm: "hi-res", provider: "kimi", model: "kimi-k3", measured: true, canonicalMatch: true, sent: false },
    { id: "p3-s1", arm: "hi-res", provider: "kimi", model: "kimi-k3", measured: true, canonicalMatch: false, sent: false },
    { id: "p3-b7", arm: "context", provider: "kimi", model: "kimi-k3", measured: true, canonicalMatch: true, sent: false },
    { id: "p3-s1", arm: "context", provider: "kimi", model: "kimi-k3", measured: true, canonicalMatch: true, sent: false }
  ], ["hi-res", "context"], [{ provider: "kimi", model: "kimi-k3", role: "primary" }]);
  const fromRows = inputDecision(counted);
  assert.equal(fromRows.suggestedArm, "context");
  assert.equal(fromRows.contextProbeNormalized, 1);
  assert.equal(fromRows.hiResProbeNormalized, 0);
});

test("paragraph seating keeps an interior line and leaves the neighbor outside the stroke", () => {
  const width = 120;
  const height = 90;
  const rgba = new Uint8ClampedArray(width * height * 4);
  rgba.fill(255);
  const ink = (x0, x1, y0, y1) => {
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const index = (y * width + x) * 4;
        rgba[index] = 0;
        rgba[index + 1] = 0;
        rgba[index + 2] = 0;
        rgba[index + 3] = 255;
      }
    }
  };
  ink(10, 100, 8, 18);
  ink(10, 100, 40, 58);
  ink(10, 100, 70, 82);
  const seated = seatTargetRect(
    { width, height, rgba },
    { x: 12, y: 14, w: 80, h: 60 }
  );
  assert.ok(seated.y > 18);
  assert.ok(seated.y + seated.h < 70);
  assert.ok(seated.y <= 40);
  assert.ok(seated.y + seated.h >= 59);
});

test("context window stays put, and the paragraph box is fully inside its crop", async (t) => {
  const session = await openPdfSession(join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf"));
  t.after(() => session.close());
  const p3b7 = session.formulas.find((item) => item.id === "p3-b7");
  const frozen = contextWindow(p3b7);
  assert.deepEqual(frozen.bbox, [
    0.2728055555555555,
    0.5473482323232323,
    0.5207168006535947,
    0.5907444444444445
  ]);
  const { createCanvas, loadImage } = await import("@napi-rs/canvas");
  async function rgbaOf(png) {
    const image = await loadImage(Buffer.from(png.base64, "base64"));
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const packed = context.getImageData(0, 0, image.width, image.height);
    return { width: image.width, height: image.height, data: packed.data };
  }
  function redBounds(image) {
    let minX = image.width;
    let minY = image.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        const index = (y * image.width + x) * 4;
        const red = image.data[index] > 180 && image.data[index + 1] < 50 && image.data[index + 2] < 50;
        if (!red) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    return { minX, minY, maxX, maxY };
  }
  function dark(image, x, y) {
    const index = (y * image.width + x) * 4;
    return image.data[index] < 96 && image.data[index + 1] < 96 && image.data[index + 2] < 96;
  }
  const contextPng = await session.renderContextCrop(p3b7);
  assert.equal(contextPng.w, 607);
  assert.equal(contextPng.h, 137);
  const contextImage = await rgbaOf(contextPng);
  const contextBox = redBounds(contextImage);
  assert.ok(contextBox.minY > 2 && contextBox.maxY < contextImage.height - 2);
  const mid = Math.floor((contextBox.minX + contextBox.maxX) / 2);
  let gapRows = 1000;
  for (const x of [mid - 24, mid, mid + 24]) {
    if (x <= contextBox.minX + 2 || x >= contextBox.maxX - 2) continue;
    let rows = 0;
    for (let y = contextBox.maxY - TARGET_BOX_PX; y >= 1; y -= 1) {
      if (dark(contextImage, x, y)) break;
      rows += 1;
    }
    if (rows < gapRows) gapRows = rows;
  }
  assert.ok(gapRows >= TARGET_BOX_GAP);
  for (const id of ["p3-b12", "p3-b16", "p3-b22", "p4-b7", "p4-b11", "p4-b16"]) {
    const formula = session.formulas.find((item) => item.id === id);
    const png = await session.renderParagraphCrop(formula);
    const image = await rgbaOf(png);
    const box = redBounds(image);
    assert.ok(box.minX > 1 && box.minY > 1, id);
    assert.ok(box.maxX < image.width - 2 && box.maxY < image.height - 2, id);
    let struck = 0;
    for (let y = box.minY; y <= box.minY + 2; y += 1) {
      for (let x = Math.max(0, box.minX - 8); x < box.minX; x += 1) {
        if (dark(image, x, y)) struck += 1;
      }
    }
    assert.equal(struck, 0, id);
    let gapAbove = 0;
    const sampleX = Math.min(box.maxX - 8, box.minX + Math.floor((box.maxX - box.minX) * 0.35));
    for (let y = box.minY - 1; y >= 0; y -= 1) {
      if (dark(image, sampleX, y)) break;
      gapAbove += 1;
      if (gapAbove > 12) break;
    }
    assert.ok(gapAbove >= 1, id);
    if (id === "p4-b7") assert.ok(box.maxY - box.minY > 140);
  }
});
