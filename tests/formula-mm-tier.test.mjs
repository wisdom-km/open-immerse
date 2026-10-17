/**
 * F7-PR3 multimodal tier.
 *
 * 交付前刁钻自测:
 * 1. 并发 — 两个标签页共用一个公式缓存，各写各的账本。
 * 2. 页面生命周期 — 翻页、卸载、请求中途中止。过期结果不写缓存、不上屏字段。
 * 3. 新旧版本兼容 — 不适用（Wisdom 决定不做旧后台兼容）。
 * 4. 失败与回滚 — 核对不过、UNREADABLE、401/429/超时都退回裁图；缓存写到一半不影响这次决定。
 * 5. 边界输入 — 空、多段、代码块、`$`、超长、密钥混进模型输出、非 PNG、网址。
 * 6. 交付要求 — 先有这些断言。合入前全绿。
 *
 * 不变量（随机测试每一步都查）:
 * ① key 不出现在缓存、trace、账本、请求体摘要里；
 * ② 中止或过期的结果不写缓存，块上也不留下 vlm；
 * ③ 关开关、移除密钥、换厂商或模型之后，不为旧配置再发请求，在途结果作废；
 * ④ 缓存命中的记录属于当前 model + cropHash + mm-1；
 * ⑤ 已经核对通过的公式不会被更旧的结果降级；
 * ⑥ 问 AI 不和公式队列互相等待，也不改对方的状态；
 * ⑦ 只接了多模态这一家时，核对不过或调用失败不会去跑自研算法或矢量重绘。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createFormulaCache, createMemoryStore, tierRecordKey } from "../lib/formula-cache.js";
import { decideFormula } from "../lib/formula-chain.js";
import { cropHashOf, contractViolations, unitKeyOf } from "../lib/formula-contract.js";
import { cropPngFor } from "../lib/formula-crop-png.js";
import { classifyMmDecision, createMmLedger, mmPageStatsFor, beginMmPage } from "../lib/formula-mm-ledger.js";
import { verifyCandidate as verifyFromArbiter } from "../lib/formula-arbiter.js";
import { parseLatexCandidate, verifyCandidate } from "../lib/formula-verify.js";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import {
  FORMULA_SWITCH_KEYS,
  formulaChainFlags,
  normalizeFormulaSettings
} from "../lib/formula-settings.js";
import {
  FORMULA_VISION_SYSTEM,
  MM_TIER_VERSION,
  formulaVisionText,
  multimodalTier,
  runMultimodal
} from "../lib/formula-tiers/multimodal.js";
import { createDefaultTiers } from "../lib/formula-tiers/index.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const katex = loadKatex();

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG_URL = `data:image/png;base64,${PNG}`;
const SECRET = "sk-mm-tier-secret-do-not-store-778899";

function settingsFor(provider, { enabled = true, apiKey = SECRET, model = "gpt-5.6-luna" } = {}) {
  return normalizeFormulaSettings({
    [FORMULA_SWITCH_KEYS.tier2]: enabled,
    multimodal: { provider, apiKey, model }
  });
}

function formulaBlock(extra = {}) {
  return {
    label: "formula",
    id: extra.id || "f1",
    bid: extra.bid || "b1",
    bbox: extra.bbox || [0.1, 0.2, 0.4, 0.3],
    text: extra.text ?? "x",
    display: extra.display !== false,
    sourceUnitId: extra.sourceUnitId || "",
    ...extra
  };
}

function countingTiers(counts) {
  const base = createDefaultTiers();
  const wrapped = {};
  for (const [id, tier] of Object.entries(base)) {
    wrapped[id] = {
      ...tier,
      available(ctx) {
        return tier.available(ctx);
      },
      async run(unit, ctx, opts) {
        counts[id] = (counts[id] || 0) + 1;
        const result = await tier.run(unit, ctx, opts);
        if (id === "multimodal") counts.lastMm = result;
        return result;
      }
    };
  }
  return wrapped;
}

function wrapStore(inner, state) {
  return {
    kind: "memory",
    saved: state.saved,
    async getTier(key) {
      return inner.getTier(key);
    },
    async putTier(key, record) {
      if (state.boom) {
        state.boom = false;
        throw new Error("cache write interrupted");
      }
      const stored = await inner.putTier(key, record);
      if (stored) state.saved.push({ ...structuredClone(record), key });
      return stored;
    },
    async getDecision(key) {
      return inner.getDecision(key);
    },
    async putDecision(key, record) {
      return inner.putDecision(key, record);
    },
    async clearDoc(docHash) {
      return inner.clearDoc(docHash);
    },
    async clearAll() {
      state.saved.length = 0;
      return inner.clearAll();
    }
  };
}

test("parseLatexCandidate keeps one formula and rejects the rest", () => {
  assert.equal(parseLatexCandidate("x^2").latex, "x^2");
  assert.equal(parseLatexCandidate("  $x^2$  ").latex, "x^2");
  assert.equal(parseLatexCandidate("$$x+1$$").latex, "x+1");
  assert.equal(parseLatexCandidate("\\(a_b\\)").latex, "a_b");
  assert.equal(parseLatexCandidate("\\[E=mc^2\\]").latex, "E=mc^2");
  assert.equal(parseLatexCandidate("```latex\nx\n```").latex, "x");
  assert.equal(parseLatexCandidate("LaTeX:\n```tex\nx\n```").latex, "x");
  assert.equal(parseLatexCandidate("\\begin{aligned}\nx \\\\\n y\n\\end{aligned}").ok, true);
  assert.equal(parseLatexCandidate("").reason, "empty");
  assert.equal(parseLatexCandidate("   ").reason, "empty");
  assert.equal(parseLatexCandidate("UNREADABLE").reason, "unreadable");
  assert.equal(parseLatexCandidate("unreadable").reason, "unreadable");
  assert.equal(parseLatexCandidate("$x$ and $y$").reason, "multi");
  assert.equal(parseLatexCandidate("```latex\nx\n```\n```latex\ny\n```").reason, "multi");
  assert.equal(parseLatexCandidate("公式是 $x$ 另一行").reason, "multi");
  assert.equal(parseLatexCandidate("the formula is x").reason, "multi");
  assert.equal(parseLatexCandidate("x\n\ny").reason, "multi");
  assert.equal(parseLatexCandidate(`${"x".repeat(20)} + ${"y".repeat(20)}`).ok, true);
  assert.equal(parseLatexCandidate("UNREADABLE because it is blurry").reason, "multi");
  assert.equal(verifyFromArbiter, verifyCandidate);
});

test("cropPngFor returns one PNG data payload and never fetches a url", async () => {
  let reads = 0;
  const png = await cropPngFor({ imageUrl: PNG_URL });
  assert.equal(png.mime, "image/png");
  assert.equal(png.base64, PNG);
  assert.equal(png.w, 1);
  assert.equal(png.h, 1);
  assert.equal(png.hash.length, 12);
  assert.equal(png.base64.startsWith("data:"), false);
  const refused = await cropPngFor({ imageUrl: "https://example.test/a.png" }, {
    readCropImage() {
      reads += 1;
      return { url: PNG_URL };
    }
  });
  assert.equal(refused, null);
  assert.equal(reads, 0);
  assert.equal(await cropPngFor({ imageUrl: "data:image/png;base64,abc" }), null);
  assert.equal(await cropPngFor({ imageUrl: "data:image/jpeg;base64," + PNG }), null);
  let late = false;
  const stale = await cropPngFor({ imageUrl: "blob:crop" }, {
    isStale: () => late,
    async readCropImage() {
      late = true;
      return { url: PNG_URL };
    }
  });
  assert.equal(stale, null);
});

test("an unconfigured provider or vision:false sends nothing", async () => {
  const seen = [];
  const sendVision = async () => {
    seen.push("send");
    return { ok: true, text: "x" };
  };
  const net = {
    async fetch() {
      seen.push("net");
      return { ok: true, status: 200, data: { choices: [{ message: { content: "x" } }] } };
    }
  };
  const deepseek = settingsFor("deepseek", { model: "deepseek-flash" });
  assert.equal(formulaChainFlags(deepseek).multimodalEnabled, false);
  assert.equal(multimodalTier.available({
    flags: { multimodalEnabled: true, multimodalConfigured: true },
    settings: deepseek
  }), false);
  const blocked = await runMultimodal(formulaBlock(), {
    flags: { multimodalEnabled: true, multimodalConfigured: true },
    settings: deepseek,
    sendVision,
    net
  });
  assert.equal(blocked.status, "skip");
  assert.equal(blocked.reason, "not-configured");
  const bare = await runMultimodal(formulaBlock(), {
    flags: { multimodalEnabled: true },
    sendVision,
    net
  });
  assert.equal(bare.reason, "not-configured");
  const off = await runMultimodal(formulaBlock(), {
    flags: { multimodalEnabled: false, multimodalConfigured: true },
    settings: settingsFor("openai", { enabled: false }),
    sendVision
  });
  assert.equal(off.reason, "disabled");
  assert.deepEqual(seen, []);
  assert.deepEqual(contractViolations(blocked), []);
});

test("a verified crop becomes vlm data and the reader still shows the crop", async () => {
  const seen = [];
  const settings = settingsFor("openai");
  const flags = formulaChainFlags(settings);
  const ledger = createMmLedger();
  const shown = await scheduleFormulaBlock(formulaBlock({ display: true, text: "x" }), {
    ...flags,
    docHash: "doc",
    page: 2,
    settings,
    readSettings: () => settings,
    katex,
    mmLedger: ledger,
    sendVision: async (req) => {
      seen.push(req);
      assert.equal(req.purpose, "multimodal");
      assert.equal(req.system, FORMULA_VISION_SYSTEM);
      assert.equal(req.text, formulaVisionText({ display: true }));
      assert.equal(req.images.length, 1);
      assert.equal(req.images[0].mime, "image/png");
      assert.equal(req.images[0].base64, PNG);
      assert.equal(JSON.stringify(req.target || {}).includes(SECRET), false);
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(seen.length, 1);
  assert.equal(shown.latex, "x");
  assert.equal(shown.latexSource, "vlm");
  assert.equal(shown.verified, true);
  assert.equal(shown.formulaTier, "crop");
  assert.equal(shown.formulaReason, undefined);
  const stats = ledger.stats();
  assert.equal(stats.m, 1);
  assert.equal(stats.n, 1);
  assert.equal(stats.k, 1);
  const inlineSeen = [];
  const inline = await scheduleFormulaBlock(formulaBlock({ bid: "in", display: false, text: "x", inlineOf: "p" }), {
    ...flags,
    docHash: "doc",
    settings,
    readSettings: () => settings,
    katex,
    mmLedger: createMmLedger(),
    sendVision: async (req) => {
      inlineSeen.push(req.text);
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.deepEqual(inlineSeen, ["行内公式"]);
  assert.equal(inline.latexSource, "vlm");
  assert.equal(read("pdf/viewer.js").includes("oi-vlm-mark"), false);
  assert.equal(read("pdf/viewer.js").includes("oi-mm-chip"), false);
});

test("tier 0 does not send and stays out of the denominator", async () => {
  let sends = 0;
  const settings = settingsFor("openai");
  const flags = formulaChainFlags(settings);
  const ledger = createMmLedger();
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "src", text: "x" }), {
    ...flags,
    arxivEnabled: true,
    docHash: "doc",
    settings,
    readSettings: () => settings,
    katex,
    mmLedger: ledger,
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    readAlignment: async () => ({
      useSource: true,
      stats: { wordRate: 1 },
      formulas: [{
        unitId: "u",
        bid: "src",
        kind: "display",
        latex: "x",
        checks: { position: true, chars: true, number: true, render: true }
      }]
    }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(sends, 0);
  assert.equal(shown.latexSource, "arxiv-src");
  assert.equal(ledger.stats().m, 0);
  assert.equal(ledger.stats().k, 0);
  const page = beginMmPage(4);
  page.note("only-candidate", { candidate: true, shown: false, sent: 0 });
  assert.equal(mmPageStatsFor(4).m, 1);
  assert.equal(classifyMmDecision({
    chosen: { tier: "arxiv", status: "ok", render: "katex", latex: "x" },
    trace: [
      { tier: "arxiv", status: "ok" },
      { tier: "multimodal", status: "ok", render: "katex" }
    ]
  }, { sent: 1 }).candidate, false);
});

test("a failed check or a call failure falls back to the crop and skips self and vector", async () => {
  const settings = settingsFor("openai");
  const flags = formulaChainFlags(settings);
  const cases = [
    { text: "UNREADABLE", reason: "unreadable" },
    { text: "$x$ and $y$", reason: "unreadable" },
    { text: "\\beta", pdf: "α", reason: "charset-mismatch" },
    { text: "\\frac{1}{", pdf: "1", reason: "katex-error" },
    { error: { code: "401", status: 401, summary: `bad ${SECRET}` } },
    { error: { code: "429", status: 429, summary: "slow" } },
    { error: { code: "timeout", status: 0, summary: "超时" } }
  ];
  for (const item of cases) {
    const counts = {};
    const ledger = createMmLedger();
    const shown = await scheduleFormulaBlock(formulaBlock({ text: item.pdf || "x", bid: item.reason || item.error.code }), {
      ...flags,
      docHash: "doc",
      settings,
      readSettings: () => settings,
      katex,
      tiers: countingTiers(counts),
      mmLedger: ledger,
      sendVision: async () => (item.error
        ? { ok: false, error: item.error }
        : { ok: true, text: item.text }),
      withRasterCrop: async (block) => ({ ...block, imageUrl: PNG_URL, surface: "png" })
    });
    assert.equal(counts.self || 0, 0, item.reason || item.error.code);
    assert.equal(counts.vector || 0, 0, item.reason || item.error.code);
    assert.equal(shown.latexSource, undefined);
    assert.equal(shown.formulaTier, "crop");
    assert.equal(JSON.stringify(shown).includes(SECRET), false);
    assert.equal(JSON.stringify(ledger.stats()).includes(SECRET), false);
    assert.equal(ledger.stats().m, 1);
    assert.equal(ledger.stats().n, 0);
    assert.equal(ledger.stats().k, 1);
    if (item.reason) assert.equal(counts.lastMm.reason, item.reason);
  }
});

test("cache hits use mm-1 plus the model and do not send again", async () => {
  const settings = settingsFor("openai", { model: "gpt-5.6-luna" });
  const flags = formulaChainFlags(settings);
  const state = { saved: [], boom: false };
  const cache = createFormulaCache(wrapStore(createMemoryStore(), state));
  let sends = 0;
  const hooks = {
    ...flags,
    docHash: "doc-cache",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: "gpt-5.6-luna",
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  };
  await scheduleFormulaBlock(formulaBlock({ bid: "c1" }), hooks);
  await scheduleFormulaBlock(formulaBlock({ bid: "c1" }), hooks);
  assert.equal(sends, 1);
  const unit = {
    docHash: "doc-cache",
    bid: "c1",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  };
  const key = tierRecordKey(unit, { id: "multimodal", version: MM_TIER_VERSION }, "gpt-5.6-luna");
  assert.equal(key.includes(`:multimodal:${MM_TIER_VERSION}:gpt-5.6-luna:`), true);
  assert.equal(key.includes(cropHashOf(unit)), true);
  const row = await cache.store.getTier(key);
  assert.equal(row.result.latex, "x");
  assert.equal(row.result.meta.version, MM_TIER_VERSION);
  assert.equal(JSON.stringify(row).includes(SECRET), false);
  assert.equal(JSON.stringify(row).includes(PNG), false);
  const other = settingsFor("openai", { model: "gpt-5.4-mini" });
  await scheduleFormulaBlock(formulaBlock({ bid: "c1" }), {
    ...hooks,
    ...formulaChainFlags(other),
    settings: other,
    readSettings: () => other,
    model: "gpt-5.4-mini"
  });
  assert.equal(sends, 2);
  const staleKey = tierRecordKey(unit, { id: "multimodal", version: "stub-0" }, "gpt-5.6-luna");
  assert.equal(await cache.store.getTier(staleKey), null);
});

test("interrupt: after settings are read, a removed key sends nothing and writes nothing", async () => {
  let current = settingsFor("openai");
  const state = { saved: [], boom: false };
  const cache = createFormulaCache(wrapStore(createMemoryStore(), state));
  let sends = 0;
  const shown = await scheduleFormulaBlock(formulaBlock(), {
    ...formulaChainFlags(current),
    docHash: "doc",
    settings: current,
    readSettings: () => current,
    katex,
    cache,
    onCheckpoint(name) {
      if (name === "after-settings") current = settingsFor("openai", { apiKey: "" });
    },
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(sends, 0);
  assert.equal(state.saved.length, 0);
  assert.equal(shown.latexSource, undefined);
});

test("interrupt: before send, an abort does not call the model or write the cache", async () => {
  const state = { saved: [], boom: false };
  const cache = createFormulaCache(wrapStore(createMemoryStore(), state));
  const settings = settingsFor("openai");
  let sends = 0;
  const controller = new AbortController();
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "pre" }), {
    ...formulaChainFlags(settings),
    docHash: "doc",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    signal: controller.signal,
    onCheckpoint(name) {
      if (name === "before-send") controller.abort();
    },
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(sends, 0);
  assert.equal(state.saved.length, 0);
  assert.equal(shown.latexSource, undefined);
});

test("interrupt: after the response, a settings change voids the result", async () => {
  let current = settingsFor("openai", { model: "gpt-5.6-luna" });
  const state = { saved: [], boom: false };
  const cache = createFormulaCache(wrapStore(createMemoryStore(), state));
  const ledger = createMmLedger();
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "late" }), {
    ...formulaChainFlags(current),
    docHash: "doc",
    settings: current,
    readSettings: () => current,
    katex,
    cache,
    mmLedger: ledger,
    model: "gpt-5.6-luna",
    onCheckpoint(name) {
      if (name === "after-response") current = settingsFor("openai", { model: "gpt-5.4-mini" });
    },
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(shown.latexSource, undefined);
  assert.equal(state.saved.length, 0);
  assert.equal(ledger.stats().k, 0);
  assert.equal(ledger.stats().n, 0);
});

test("interrupt: before return, going stale drops the katex fields", async () => {
  const settings = settingsFor("openai");
  let stale = false;
  const state = { saved: [], boom: false };
  const ledger = createMmLedger();
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "ret" }), {
    ...formulaChainFlags(settings),
    docHash: "doc",
    settings,
    readSettings: () => settings,
    katex,
    cache: createFormulaCache(wrapStore(createMemoryStore(), state)),
    mmLedger: ledger,
    isStale: () => stale,
    onCheckpoint(name) {
      if (name === "before-return") stale = true;
    },
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(shown.latex, undefined);
  assert.equal(shown.latexSource, undefined);
  assert.equal(state.saved.length, 0);
  assert.equal(ledger.stats().n, 0);
});

test("interrupt: a cache write that throws keeps the decision and leaves no partial row", async () => {
  const settings = settingsFor("openai");
  const state = { saved: [], boom: true };
  const inner = createMemoryStore();
  const cache = createFormulaCache(wrapStore(inner, state));
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "half" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-half",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: "gpt-5.6-luna",
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(shown.latexSource, "vlm");
  assert.equal(state.saved.length, 0);
  const unit = { docHash: "doc-half", bid: "half", bbox: [0.1, 0.2, 0.4, 0.3], crop: { pixels: PNG } };
  const key = tierRecordKey(unit, multimodalTier, "gpt-5.6-luna");
  assert.equal(await inner.getTier(key), null);
  let sends = 0;
  await scheduleFormulaBlock(formulaBlock({ bid: "half" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-half",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: "gpt-5.6-luna",
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(sends, 1);
  assert.equal((await inner.getTier(key)).result.latex, "x");
});

test("interrupt: before stamp, a page turn does not leave vlm on the block", async () => {
  const settings = settingsFor("openai");
  const ledger = createMmLedger();
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "stamp" }), {
    ...formulaChainFlags(settings),
    docHash: "doc",
    settings,
    readSettings: () => settings,
    katex,
    mmLedger: ledger,
    onCheckpoint(name) {
      if (name === "before-stamp") ledger.bump();
    },
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(shown.latexSource, undefined);
  assert.equal(shown.verified, undefined);
  assert.equal(ledger.stats().n, 0);
});

test("a newer verified row is not replaced by an older failure", async () => {
  const store = createMemoryStore();
  const cache = createFormulaCache(store);
  const unit = { docHash: "doc", bid: "keep", bbox: [0, 0, 1, 1], crop: { pixels: "p" } };
  const tier = { id: "multimodal", version: "mm-1" };
  await cache.writeTier(tierRecordKey(unit, tier, "m"), {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "x",
    meta: { epoch: 2, version: "mm-1" }
  }, { docHash: "doc", model: "m" });
  const wrote = await cache.writeTier(tierRecordKey(unit, tier, "m"), {
    tier: "multimodal",
    status: "error",
    reason: "http",
    meta: { epoch: 1 }
  }, { docHash: "doc", model: "m" });
  assert.equal(wrote, false);
  assert.equal((await store.getTier(tierRecordKey(unit, tier, "m"))).result.latex, "x");
  const olderKatex = await cache.writeTier(tierRecordKey(unit, tier, "m"), {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "y",
    meta: { epoch: 1, version: "mm-1" }
  }, { docHash: "doc", model: "m" });
  assert.equal(olderKatex, false);
  assert.equal((await store.getTier(tierRecordKey(unit, tier, "m"))).result.latex, "x");
});

test("ask and formula calls do not wait on each other", async () => {
  const ask = { marker: "ask-queue", runs: 0 };
  const settings = settingsFor("openai");
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let formulaStarted = false;
  const formula = scheduleFormulaBlock(formulaBlock({ bid: "ask" }), {
    ...formulaChainFlags(settings),
    docHash: "doc",
    settings,
    readSettings: () => settings,
    katex,
    ask,
    sendVision: async () => {
      formulaStarted = true;
      await hold;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  for (let i = 0; i < 30 && !formulaStarted; i += 1) await Promise.resolve();
  assert.equal(formulaStarted, true);
  ask.runs += 1;
  assert.equal(ask.marker, "ask-queue");
  release();
  const shown = await formula;
  assert.equal(shown.latexSource, "vlm");
  assert.equal(ask.runs, 1);
  assert.equal(ask.marker, "ask-queue");
});

test("one joined multimodal failure never reaches self, even through decideFormula", async () => {
  const counts = {};
  const settings = settingsFor("openai");
  const decision = await decideFormula(formulaBlock({
    docHash: "doc",
    bid: "one",
    text: "x",
    crop: { url: PNG_URL, pixels: PNG }
  }), {
    flags: formulaChainFlags(settings),
    settings,
    readSettings: () => settings,
    katex,
    tiers: countingTiers(counts),
    sendVision: async () => ({ ok: true, text: "UNREADABLE" })
  });
  assert.equal(decision.forcedCrop, true);
  assert.equal(decision.trace.some((item) => item.tier === "self"), false);
  assert.equal(decision.trace.some((item) => item.tier === "vector"), false);
  assert.equal(counts.self || 0, 0);
  assert.equal(counts.vector || 0, 0);
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EVENTS = ["multitab", "page-turn", "settings", "unload", "fail-retry", "cache-interrupt", "arxiv"];

function assertWorld(world, seed, step) {
  const dump = JSON.stringify({
    saved: world.state.saved,
    requests: world.requests.map((row) => ({
      model: row.model,
      gen: row.gen,
      text: row.text,
      image: row.image
    })),
    stats: world.tabs.map((tab) => tab.ledger.stats()),
    ask: world.ask
  });
  assert.equal(dump.includes(world.secret), false, `seed ${seed} step ${step} key`);
  for (const row of world.state.saved) {
    assert.notEqual(row.result?.reason, "aborted", `seed ${seed} aborted cached`);
    assert.notEqual(row.result?.reason, "stale", `seed ${seed} stale cached`);
    assert.equal(String(row.key || "").includes(":mm-1:"), true, `seed ${seed} key ${row.key}`);
    assert.equal(JSON.stringify(row).includes(world.secret), false, `seed ${seed} row`);
  }
  for (const row of world.requests) {
    assert.equal(row.image?.mime, "image/png");
    assert.equal(String(row.image?.base64 || "").startsWith("http"), false);
    assert.equal(String(row.image?.base64 || "").startsWith("data:"), false);
    assert.equal(JSON.stringify(row).includes(world.secret), false, `seed ${seed} request`);
  }
  assert.equal(world.ask.marker, "ask-queue", `seed ${seed} ask`);
  for (const tab of world.tabs) {
    const stats = tab.ledger.stats();
    assert.ok(stats.n <= stats.m, `seed ${seed} n/m`);
    assert.ok(stats.k >= 0, `seed ${seed} k`);
  }
  if (world.lastJoined && world.lastJoined.status !== "skip") {
    assert.equal(world.deltaSelf, 0, `seed ${seed} self`);
    assert.equal(world.deltaVector, 0, `seed ${seed} vector`);
  }
}

async function runSeed(seed, cover) {
  const rng = mulberry32(seed);
  const secret = `sk-seed-${seed}-SECRET-KEY`;
  const state = { saved: [], boom: false };
  const store = wrapStore(createMemoryStore(), state);
  const cache = createFormulaCache(store);
  const ask = { marker: "ask-queue", runs: 0 };
  const world = {
    secret,
    state,
    cache,
    ask,
    requests: [],
    generation: 1,
    tabs: [],
    counts: {},
    lastJoined: null,
    deltaSelf: 0,
    deltaVector: 0
  };
  for (let id = 0; id < 2; id += 1) {
    world.tabs.push({
      id,
      ledger: createMmLedger(),
      stale: false,
      settings: settingsFor("openai", { apiKey: secret, model: "gpt-5.6-luna" }),
      gen: 1
    });
  }
  const steps = 8;
  for (let step = 0; step < steps; step += 1) {
    const name = step < EVENTS.length && seed === 1 ? EVENTS[step] : EVENTS[Math.floor(rng() * EVENTS.length)];
    cover[name] = (cover[name] || 0) + 1;
    const tab = world.tabs[Math.floor(rng() * world.tabs.length)];
    await runEvent(world, tab, name, rng, seed, step);
    assertWorld(world, seed, step);
  }
}

async function runEvent(world, tab, name, rng, seed, step) {
  if (name !== "page-turn") tab.stale = false;
  world.counts.lastMm = null;
  if (name === "settings") {
    tab.settings = settingsFor(rng() < 0.5 ? "openai" : "qwen", {
      apiKey: rng() < 0.3 ? "" : world.secret,
      model: rng() < 0.5 ? "gpt-5.6-luna" : "qwen3-vl-plus",
      enabled: rng() < 0.2 ? false : true
    });
    if (tab.settings.multimodal.provider === "qwen" && !tab.settings.multimodal.model) {
      tab.settings = settingsFor("qwen", { apiKey: world.secret, model: "qwen3-vl-plus" });
    }
    world.generation += 1;
    tab.gen = world.generation;
    tab.stale = false;
  }
  if (name === "page-turn") {
    tab.stale = true;
    tab.ledger.bump();
  }
  if (name === "cache-interrupt") world.state.boom = true;
  const beforeSelf = world.counts.self || 0;
  const beforeVector = world.counts.vector || 0;
  const fail = name === "fail-retry" ? ["401", "429", "timeout"][Math.floor(rng() * 3)] : "";
  const controller = new AbortController();
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const generation = tab.gen;
  const modelAtStart = tab.settings.multimodal.model;
  const flags = formulaChainFlags(tab.settings, { arxivEnabled: name === "arxiv" });
  const job = scheduleFormulaBlock(formulaBlock({
    bid: `s${seed}-t${tab.id}`,
    id: `s${seed}-t${tab.id}`,
    text: "x",
    display: rng() < 0.5
  }), {
    ...flags,
    docHash: `doc-${tab.id}`,
    settings: tab.settings,
    readSettings: () => tab.settings,
    katex,
    cache: world.cache,
    mmLedger: tab.ledger,
    tiers: countingTiers(world.counts),
    signal: controller.signal,
    isStale: () => tab.stale,
    model: modelAtStart,
    sendVision: async (req) => {
      const image = req.images?.[0];
      const accepted = generation === world.generation && !controller.signal.aborted && !tab.stale
        && tab.settings.multimodal.model === modelAtStart
        && formulaChainFlags(tab.settings).multimodalEnabled === true;
      world.requests.push({
        model: req.target?.model,
        gen: generation,
        text: req.text,
        image,
        accepted
      });
      await hold;
      if (controller.signal.aborted || tab.stale || generation !== world.generation) {
        return { ok: false, error: { code: "aborted", status: 0, summary: "已中止" } };
      }
      if (fail) return { ok: false, error: { code: fail, status: fail === "timeout" ? 0 : Number(fail), summary: `no ${world.secret}` } };
      return { ok: true, text: "x" };
    },
    readAlignment: async () => (name === "arxiv" ? {
      useSource: true,
      stats: { wordRate: 1 },
      formulas: [{
        bid: `s${seed}-t${tab.id}`,
        kind: "display",
        latex: "x",
        checks: { position: true, chars: true, number: true, render: true }
      }]
    } : null),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  if (name === "page-turn") tab.ledger.bump();
  if (name === "settings") {
    tab.settings = settingsFor("openai", { apiKey: world.secret, model: "gpt-5.4-mini" });
    world.generation += 1;
    tab.gen = world.generation;
  }
  if (name === "unload") controller.abort();
  if (name === "multitab") {
    world.ask.runs += 1;
  }
  release();
  const shown = await job;
  world.state.boom = false;
  world.lastJoined = world.counts.lastMm || null;
  world.deltaSelf = (world.counts.self || 0) - beforeSelf;
  world.deltaVector = (world.counts.vector || 0) - beforeVector;
  if (shown?.latexSource === "vlm") {
    const prev = world.verifiedEpoch?.get?.(shown.bid) || 0;
    const epoch = tab.ledger.epoch;
    if (prev && epoch < prev) {
      assert.fail(`seed ${seed} step ${step} downgraded ${shown.bid}`);
    }
    if (!world.verifiedEpoch) world.verifiedEpoch = new Map();
    world.verifiedEpoch.set(shown.bid, Math.max(prev, epoch));
  }
  if (name === "fail-retry") {
    const retry = await scheduleFormulaBlock(formulaBlock({
      bid: `s${seed}-t${tab.id}-retry`,
      text: "x"
    }), {
      ...formulaChainFlags(tab.settings),
      docHash: `doc-retry-${tab.id}`,
      settings: tab.settings,
      readSettings: () => tab.settings,
      katex,
      cache: world.cache,
      mmLedger: tab.ledger,
      tiers: countingTiers(world.counts),
      isStale: () => false,
      model: tab.settings.multimodal.model,
      sendVision: async (req) => {
        world.requests.push({
          model: req.target?.model,
          gen: world.generation,
          text: req.text,
          image: req.images?.[0],
          accepted: true
        });
        return { ok: true, text: "x" };
      },
      withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
    });
    if (formulaChainFlags(tab.settings).multimodalEnabled) {
      assert.equal(retry.latexSource === "vlm" || retry.formulaTier === "crop", true);
    }
    assert.equal(JSON.stringify(retry).includes(world.secret), false);
  }
  assert.equal(JSON.stringify(shown || {}).includes(world.secret), false, `seed ${seed} block`);
  void step;
}

test("500 seeds cover tabs, paging, settings, unload, retry, and a torn cache write", async () => {
  const cover = {};
  for (let seed = 1; seed <= 500; seed += 1) {
    try {
      await runSeed(seed, cover);
    } catch (err) {
      console.error(`mm-tier random failed seed=${seed}`);
      throw err;
    }
  }
  for (const name of EVENTS) {
    assert.ok(cover[name] > 0, name);
  }
});
