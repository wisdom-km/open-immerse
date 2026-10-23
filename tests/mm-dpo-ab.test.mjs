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
import { readFileSync } from "node:fs";
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
  PARAGRAPH_PROMPT_NOTE,
  PARAGRAPH_TEXT_MAX,
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
import { createMemoryCanvas, renderParagraphCrop, renderVisionCrop } from "../tools/mm-dpo-vision.mjs";
import { parseCropDataUrl } from "../lib/formula-crop-png.js";
import {
  USAGE,
  createLiveTransport,
  loadOptionalVisionCrop,
  loadPdfFormulas,
  main,
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
  assert.deepEqual(ARM_IDS, ["tight", "hi-res", "paragraph", "page"]);
  assert.deepEqual(DEFAULT_ARMS, ["tight"]);
  assert.equal(DEFAULT_ARMS.includes("page"), false);
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
  assert.match(USAGE, /MM_DPO_KIMI_API_KEY/);
  assert.match(USAGE, /MM_DPO_DEEPSEEK_API_KEY/);
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
  assert.equal(sends, 1);
  assert.equal(live.report.coverage.detected, 2);
  assert.equal(live.report.coverage.sampled, 1);
  assert.equal(live.report.coverage.complete, false);
  assert.equal(live.report.rows[0].checkedButMismatch, true);
  assert.equal(live.report.summary.byArmModel.some((item) => item.provider === "deepseek" && item.sent === 0), true);
  const written = readFileSync(live.paths.jsonPath, "utf8");
  assert.equal(written.includes(KIMI_KEY), false);
  assert.equal(written.includes("PARA_SHOULD_STAY_OUT"), false);
  assert.equal(written.includes(PNG), false);
  assert.match(readFileSync(live.paths.mdPath, "utf8"), /核对过但与参考不一致：1/);

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

test("coverage stays incomplete off the 79-formula pages, and the optional vision hook is absent or a function", async () => {
  const off = coverageOf([formula({ page: 9 })], 1);
  assert.equal(off.pagesMatch, false);
  assert.equal(off.complete, false);
  const partial = coverageOf(Array.from({ length: 79 }, (_, index) => formula({ id: `p3-${index}`, page: 3 })), 15);
  assert.equal(partial.pagesMatch, true);
  assert.equal(partial.complete, false);
  assert.equal(partial.expected, 79);
  const hook = await loadOptionalVisionCrop();
  assert.equal(hook === null || typeof hook === "function", true);
  await assert.rejects(
    () => loadPdfFormulas(join(root, "tests/fixtures/missing-dpo.pdf")),
    /2305\.18290/
  );
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
