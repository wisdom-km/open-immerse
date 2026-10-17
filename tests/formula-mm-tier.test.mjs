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

import { handleFormulaCacheMessage, createIdbFormulaStore } from "../background/formula-cache.js";
import { IDBFactory } from "fake-indexeddb";
import { deliverAsk } from "../lib/ask-route.js";
import { createMessageFormulaStore } from "../lib/formula-cache-client.js";
import { createCallGate, createFormulaCache, createMemoryStore, tierRecordKey } from "../lib/formula-cache.js";
import { decideFormula } from "../lib/formula-chain.js";
import { cropHashOf, contractViolations, unitKeyOf } from "../lib/formula-contract.js";
import { cropPngFor } from "../lib/formula-crop-png.js";
import { classifyMmDecision, createMmLedger, mmPageStatsFor, beginMmPage, mmPageLedger } from "../lib/formula-mm-ledger.js";
import { verifyCandidate as verifyFromArbiter } from "../lib/formula-arbiter.js";
import { parseLatexCandidate, verifyCandidate } from "../lib/formula-verify.js";
import { publishRestampedBlocks, scheduleFormulaBlock } from "../lib/formula-schedule.js";
import {
  FORMULA_SWITCH_KEYS,
  formulaChainFlags,
  normalizeFormulaSettings
} from "../lib/formula-settings.js";
import {
  FORMULA_VISION_SYSTEM,
  MM_TIER_VERSION,
  formulaVisionText,
  mmConfigFingerprint,
  multimodalTier,
  runMultimodal
} from "../lib/formula-tiers/multimodal.js";
import { buildVisionRequest } from "../lib/mm-client.js";
import { redactHeaders } from "../lib/net/fetch.js";
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

function modelKey(settings, named = settings.multimodal.model) {
  return `${named}#${mmConfigFingerprint(settings)}`;
}

function wrapStore(inner, state) {
  return {
    kind: "memory",
    saved: state.saved,
    async getTier(key) {
      if (typeof state.onGet === "function") await state.onGet(key);
      return inner.getTier(key);
    },
    async putTier(key, record) {
      return inner.putTier(key, record);
    },
    async commitTier(key, record) {
      if (typeof state.onCommit === "function") await state.onCommit(key, record);
      if (state.boom) {
        state.boom = false;
        throw new Error("cache write interrupted");
      }
      const stored = await inner.commitTier(key, record);
      if (stored) state.saved.push({ ...structuredClone(record), key });
      return stored;
    },
    async deleteTier(key, decidedAt) {
      const removed = await inner.deleteTier(key, decidedAt);
      if (removed) {
        const index = state.saved.findIndex((row) => row.key === key && row.decidedAt === decidedAt);
        if (index >= 0) state.saved.splice(index, 1);
      }
      return removed;
    },
    async getDecision(key) {
      return inner.getDecision(key);
    },
    async putDecision(key, record) {
      if (state.boomDecision) {
        state.boomDecision = false;
        throw new Error("decision write interrupted");
      }
      const stored = await inner.putDecision(key, record);
      if (stored) {
        state.decisions = state.decisions || [];
        state.decisions.push({ ...structuredClone(record), key });
      }
      return stored;
    },
    async clearDoc(docHash) {
      return inner.clearDoc(docHash);
    },
    async clearAll() {
      state.saved.length = 0;
      if (state.decisions) state.decisions.length = 0;
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
  const longLatex = Array.from({ length: 1500 }, () => "x").join("+");
  assert.equal(parseLatexCandidate(longLatex).ok, true);
  assert.ok(parseLatexCandidate(longLatex).latex.length > 1000);
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
  assert.equal(stats.n, 0);
  assert.equal(stats.ready, 1);
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
  const layout = { blocks: [{ bid: "old" }] };
  let painted = 0;
  assert.equal(publishRestampedBlocks(layout, [{ bid: "new" }], true, () => {
    painted += 1;
  }), false);
  assert.equal(layout.blocks[0].bid, "old");
  assert.equal(painted, 0);
  assert.equal(publishRestampedBlocks(layout, [{ bid: "new" }], false, () => {
    painted += 1;
  }), true);
  assert.equal(layout.blocks[0].bid, "new");
  assert.equal(painted, 1);
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
  const named = modelKey(settings);
  const key = tierRecordKey(unit, { id: "multimodal", version: MM_TIER_VERSION }, named);
  assert.equal(key, `doc-cache:c1:multimodal:${MM_TIER_VERSION}:${named}:${cropHashOf(unit)}`);
  assert.equal(named.endsWith(mmConfigFingerprint(settings)), true);
  assert.equal(named.includes(SECRET), false);
  const row = await cache.store.getTier(key);
  assert.equal(row.result.latex, "x");
  assert.equal(row.result.meta.version, MM_TIER_VERSION);
  assert.equal(row.configFingerprint, mmConfigFingerprint(settings));
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

test("interrupt: a cache write that throws leaves neither the tier nor the decision", async () => {
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
  const key = tierRecordKey(unit, multimodalTier, modelKey(settings));
  assert.equal(await inner.getTier(key), null);
  assert.equal(await inner.getDecision("doc-half:half"), null);
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
  assert.equal((await inner.getDecision("doc-half:half")).decision.chosen.latex, "x");
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
    status: "reject",
    reason: "katex-error",
    latex: "\\href{https://evil.test}{x}",
    meta: { epoch: 9, version: "mm-1" }
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
  const settings = settingsFor("openai");
  const ledger = createMmLedger();
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
    mmLedger: ledger,
    sendVision: async () => {
      formulaStarted = true;
      await hold;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  for (let i = 0; i < 30 && !formulaStarted; i += 1) await Promise.resolve();
  assert.equal(formulaStarted, true);
  const before = JSON.stringify(ledger.stats());
  const asked = await deliverAsk({
    ok: true,
    via: "multimodal",
    provider: "openai",
    model: "gpt-5.6-luna",
    url: "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com"
  }, async () => {
    assert.equal(formulaStarted, true);
    return { ok: true, body: "ask-body" };
  });
  assert.equal(asked.ok, true);
  assert.equal(asked.body, "ask-body");
  assert.equal(JSON.stringify(ledger.stats()), before);
  release();
  const shown = await formula;
  assert.equal(shown.latexSource, "vlm");
  assert.equal(ledger.stats().ready, 1);
  assert.equal(ledger.stats().n, 0);
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

function cachedModel(settings) {
  return modelKey(settings);
}

test("a timeout is not cached and the next load sends again", async () => {
  const settings = settingsFor("openai");
  const cache = createFormulaCache(createMemoryStore());
  let sends = 0;
  const hooks = {
    ...formulaChainFlags(settings),
    docHash: "doc-timeout",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: settings.multimodal.model,
    sendVision: async () => {
      sends += 1;
      return { ok: false, error: { code: "timeout", status: 0, summary: "超时" } };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  };
  await scheduleFormulaBlock(formulaBlock({ bid: "to" }), hooks);
  await scheduleFormulaBlock(formulaBlock({ bid: "to" }), hooks);
  assert.equal(sends, 2);
});

test("a 401 is not reused after the key changes", async () => {
  let current = settingsFor("openai", { apiKey: SECRET });
  const cache = createFormulaCache(createMemoryStore());
  let sends = 0;
  const run = () => scheduleFormulaBlock(formulaBlock({ bid: "auth" }), {
    ...formulaChainFlags(current),
    docHash: "doc-auth",
    settings: current,
    readSettings: () => current,
    katex,
    cache,
    model: current.multimodal.model,
    sendVision: async () => {
      sends += 1;
      if (sends === 1) return { ok: false, error: { code: "401", status: 401, summary: `bad ${current.multimodal.apiKey}` } };
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  const first = await run();
  assert.equal(first.latexSource, undefined);
  current = settingsFor("openai", { apiKey: `${SECRET}-rotated` });
  const second = await run();
  assert.equal(sends, 2);
  assert.equal(second.latexSource, "vlm");
  const rows = [];
  assert.equal(JSON.stringify(second).includes(SECRET), false);
  void rows;
});

test("a cached success is not reused after the key changes", async () => {
  let current = settingsFor("openai", { apiKey: SECRET });
  const inner = createMemoryStore();
  const cache = createFormulaCache(inner);
  let sends = 0;
  const run = () => scheduleFormulaBlock(formulaBlock({ bid: "fp" }), {
    ...formulaChainFlags(current),
    docHash: "doc-fp",
    settings: current,
    readSettings: () => current,
    katex,
    cache,
    model: current.multimodal.model,
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  await run();
  await run();
  assert.equal(sends, 1);
  const firstKey = tierRecordKey({
    docHash: "doc-fp",
    bid: "fp",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  }, multimodalTier, cachedModel(current));
  current = settingsFor("openai", { apiKey: `${SECRET}-next` });
  await run();
  assert.equal(sends, 2);
  const secondKey = tierRecordKey({
    docHash: "doc-fp",
    bid: "fp",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  }, multimodalTier, cachedModel(current));
  assert.notEqual(firstKey, secondKey);
  assert.equal((await inner.getTier(firstKey)).result.latex, "x");
  assert.equal((await inner.getTier(secondKey)).result.latex, "x");
  assert.equal(JSON.stringify(await inner.getTier(firstKey)).includes(SECRET), false);
});

test("a vendor that cannot see images is cached and not asked again", async () => {
  const settings = settingsFor("openai");
  const cache = createFormulaCache(createMemoryStore());
  let sends = 0;
  const hooks = {
    ...formulaChainFlags(settings),
    docHash: "doc-nv",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: settings.multimodal.model,
    sendVision: async () => {
      sends += 1;
      return { ok: false, error: { code: "no-vision", status: 400, summary: "cannot see" } };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  };
  await scheduleFormulaBlock(formulaBlock({ bid: "nv" }), hooks);
  await scheduleFormulaBlock(formulaBlock({ bid: "nv" }), hooks);
  assert.equal(sends, 1);
});

test("a rejected href is not stored in the cache row", async () => {
  const settings = settingsFor("openai");
  const counts = {};
  const inner = createMemoryStore();
  const cache = createFormulaCache(inner);
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "href", text: "x" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-href",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    tiers: countingTiers(counts),
    model: settings.multimodal.model,
    sendVision: async () => ({ ok: true, text: "\\href{https://evil.test/a}{x}" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(counts.lastMm.reason, "unknown-command");
  assert.equal(counts.lastMm.latex, null);
  assert.equal(shown.latex, undefined);
  const key = tierRecordKey({
    docHash: "doc-href",
    bid: "href",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  }, multimodalTier, cachedModel(settings));
  const row = await inner.getTier(key);
  assert.equal(row.result.latex, null);
  assert.equal(JSON.stringify(row).includes("evil.test"), false);
});

test("guard: a settings change during the cache read does not commit or stamp vlm", async () => {
  let current = settingsFor("openai", { model: "gpt-5.6-luna" });
  const state = { saved: [], boom: false, gets: 0, commits: 0 };
  const inner = createMemoryStore();
  state.onGet = async () => {
    state.gets += 1;
    if (state.gets === 2) current = settingsFor("openai", { model: "gpt-5.4-mini" });
  };
  state.onCommit = async () => {
    state.commits += 1;
  };
  const cache = createFormulaCache(wrapStore(inner, state));
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "mid" }), {
    ...formulaChainFlags(current),
    docHash: "doc-mid",
    settings: current,
    readSettings: () => current,
    katex,
    cache,
    model: "gpt-5.6-luna",
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(state.commits, 0);
  assert.equal(shown.latexSource, undefined);
  assert.equal(state.saved.length, 0);
});

test("guard: a settings change during the commit rolls the row back", async () => {
  let current = settingsFor("openai");
  const state = { saved: [], boom: false };
  const inner = createMemoryStore();
  state.onCommit = async () => {
    current = settingsFor("openai", { apiKey: `${SECRET}-during-commit` });
  };
  const cache = createFormulaCache(wrapStore(inner, state));
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "roll" }), {
    ...formulaChainFlags(settingsFor("openai")),
    docHash: "doc-roll",
    settings: current,
    readSettings: () => current,
    katex,
    cache,
    model: current.multimodal.model,
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(shown.latexSource, undefined);
  assert.equal(state.saved.length, 0);
  const key = tierRecordKey({
    docHash: "doc-roll",
    bid: "roll",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  }, multimodalTier, cachedModel(settingsFor("openai")));
  assert.equal(await inner.getTier(key), null);
});

test("guard: meta.cache false is not stored", async () => {
  const cache = createFormulaCache(createMemoryStore());
  const key = "doc:cache-false:multimodal:mm-1:m:crop";
  const wrote = await cache.writeTier(key, {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "x",
    meta: { cache: false, version: "mm-1" }
  }, { docHash: "doc", model: "m" });
  assert.equal(wrote, false);
  assert.equal(await cache.store.getTier(key), null);
});

test("guard: an aborted decision is not stored", async () => {
  const store = createMemoryStore();
  const cache = createFormulaCache(store);
  const unit = { docHash: "doc", bid: "ab" };
  const chosen = {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "x",
    reason: "aborted",
    meta: { version: "mm-1" }
  };
  const wrote = await cache.rememberDecision(unit, { chosen }, { model: "m" });
  assert.equal(wrote, false);
  assert.equal(await store.getDecision("doc:ab"), null);
  const tierKey = "doc:ab:multimodal:mm-1:m:crop";
  assert.equal(await cache.writeTier(tierKey, chosen, { docHash: "doc", model: "m" }), false);
  assert.equal(await store.getTier(tierKey), null);
});

test("guard: a key echoed by the model is not stored", async () => {
  const echoed = "k9z";
  const settings = settingsFor("openai", { apiKey: echoed });
  const inner = createMemoryStore();
  const cache = createFormulaCache(inner);
  const counts = {};
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "echo", text: echoed }), {
    ...formulaChainFlags(settings),
    docHash: "doc-echo",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    tiers: countingTiers(counts),
    model: settings.multimodal.model,
    sendVision: async () => ({ ok: true, text: echoed }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(counts.lastMm.reason, "unreadable");
  assert.equal(counts.lastMm.latex, null);
  assert.equal(JSON.stringify(counts.lastMm).includes(echoed), false);
  assert.equal(shown.latex, undefined);
  const key = tierRecordKey({
    docHash: "doc-echo",
    bid: "echo",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  }, multimodalTier, cachedModel(settings));
  assert.equal(await inner.getTier(key), null);
});

test("guard: an http crop is not sent", async () => {
  const settings = settingsFor("openai");
  let sends = 0;
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "http" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-http",
    settings,
    readSettings: () => settings,
    katex,
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    cropPngFor: async () => ({ mime: "image/png", base64: "https://evil.test/a.png", w: 1, h: 1, hash: "abcdabcdabcd" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(sends, 0);
  assert.equal(shown.latexSource, undefined);
});

test("guard: sendVision receives a stillCurrent that fails after a settings change", async () => {
  let current = settingsFor("openai");
  const flags = formulaChainFlags(current);
  let saw = false;
  let before = false;
  let after = false;
  await runMultimodal(formulaBlock({ crop: { url: PNG_URL, pixels: PNG } }), {
    flags,
    settings: current,
    readSettings: () => current,
    katex,
    sendVision: async (req) => {
      saw = true;
      before = typeof req.stillCurrent === "function" && req.stillCurrent() === true;
      current = settingsFor("openai", { apiKey: `${SECRET}-other` });
      after = typeof req.stillCurrent === "function" && req.stillCurrent() === false;
      return { ok: true, text: "x" };
    }
  });
  assert.equal(saw, true);
  assert.equal(before, true);
  assert.equal(after, true);
});

test("a torn tier write does not leave a decision, and a torn decision drops the tier", async () => {
  const settings = settingsFor("openai");
  const state = { saved: [], boom: false, boomDecision: true };
  const inner = createMemoryStore();
  const cache = createFormulaCache(wrapStore(inner, state));
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "pair" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-pair",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: settings.multimodal.model,
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(shown.latexSource, "vlm");
  const key = tierRecordKey({
    docHash: "doc-pair",
    bid: "pair",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  }, multimodalTier, cachedModel(settings));
  assert.equal(await inner.getTier(key), null);
  assert.equal(await inner.getDecision("doc-pair:pair"), null);
});

test("two tabs cannot replace a verified row with a late reject", async () => {
  const real = createMemoryStore();
  let waits = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = {
    async getTier(key) {
      return real.getTier(key);
    },
    async commitTier(key, record) {
      waits += 1;
      if (waits === 1) await gate;
      return real.commitTier(key, record);
    },
    async deleteTier(key, decidedAt) {
      return real.deleteTier(key, decidedAt);
    },
    async getDecision(key) {
      return real.getDecision(key);
    },
    async putDecision(key, record) {
      return real.putDecision(key, record);
    }
  };
  const send = (message) => handleFormulaCacheMessage(message, slow);
  const cacheA = createFormulaCache(createMessageFormulaStore(send));
  const cacheB = createFormulaCache(createMessageFormulaStore(send));
  const key = "doc:tabs:multimodal:mm-1:m:crop";
  const reject = {
    tier: "multimodal",
    status: "reject",
    reason: "katex-error",
    meta: { epoch: 5, version: "mm-1" }
  };
  const verified = {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "x",
    meta: { epoch: 1, version: "mm-1" }
  };
  const pending = cacheA.writeTier(key, reject, { docHash: "doc", model: "m" });
  for (let i = 0; i < 20 && waits < 1; i += 1) await Promise.resolve();
  assert.equal(waits, 1);
  assert.equal(await cacheB.writeTier(key, verified, { docHash: "doc", model: "m" }), true);
  release();
  assert.equal(await pending, false);
  assert.equal((await real.getTier(key)).result.latex, "x");
});

test("two tabs cannot replace a verified row on indexedDB", async () => {
  const real = createIdbFormulaStore({ indexedDB: new IDBFactory() });
  let waits = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const slow = {
    async getTier(key) {
      return real.getTier(key);
    },
    async commitTier(key, record) {
      waits += 1;
      if (waits === 1) await gate;
      return real.commitTier(key, record);
    },
    async deleteTier(key, decidedAt) {
      return real.deleteTier(key, decidedAt);
    },
    async getDecision(key) {
      return real.getDecision(key);
    },
    async putDecision(key, record) {
      return real.putDecision(key, record);
    }
  };
  const cacheA = createFormulaCache(slow);
  const cacheB = createFormulaCache(slow);
  const key = "doc:idb-tabs:multimodal:mm-1:m:crop";
  const reject = {
    tier: "multimodal",
    status: "reject",
    reason: "katex-error",
    meta: { epoch: 5, version: "mm-1" }
  };
  const verified = {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "x",
    meta: { epoch: 1, version: "mm-1" }
  };
  const pending = cacheA.writeTier(key, reject, { docHash: "doc", model: "m" });
  for (let i = 0; i < 20 && waits < 1; i += 1) await Promise.resolve();
  assert.equal(waits, 1);
  assert.equal(await cacheB.writeTier(key, verified, { docHash: "doc", model: "m" }), true);
  release();
  assert.equal(await pending, false);
  assert.equal((await real.getTier(key)).result.latex, "x");
});

test("a rollback does not delete another tab's newer verified row", async () => {
  const real = createIdbFormulaStore({ indexedDB: new IDBFactory() });
  let tierKey = "";
  const store = {
    async getTier(key) {
      return real.getTier(key);
    },
    async commitTier(key, record) {
      tierKey = key;
      return real.commitTier(key, record);
    },
    async deleteTier(key, decidedAt) {
      return real.deleteTier(key, decidedAt);
    },
    async getDecision(key) {
      return real.getDecision(key);
    },
    async putDecision() {
      await real.commitTier(tierKey, {
        docHash: "doc-roll",
        decidedAt: Date.now() + 50,
        chainVersion: "f3-1",
        tier: "multimodal",
        model: "m",
        result: {
          tier: "multimodal",
          status: "ok",
          render: "katex",
          latex: "B",
          meta: { version: "mm-1", epoch: 3 }
        }
      });
      return false;
    }
  };
  const settings = settingsFor("openai");
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "rollrace", text: "x" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-roll",
    settings,
    readSettings: () => settings,
    katex,
    cache: createFormulaCache(store),
    model: "m",
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(shown.latexSource, "vlm");
  const row = await real.getTier(tierKey);
  assert.equal(row?.result?.latex, "B");
});

test("a live caller retries when the shared in-flight result is stale", async () => {
  const settings = settingsFor("openai");
  const gate = createCallGate();
  const run = gate.run.bind(gate);
  let joins = 0;
  gate.run = (key, fn, signal) => {
    if (gate.has(key)) joins += 1;
    return run(key, fn, signal);
  };
  const cache = createFormulaCache(createMemoryStore(), { gate });
  let sends = 0;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let firstStale = false;
  const hooks = {
    ...formulaChainFlags(settings),
    docHash: "doc-join",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: settings.multimodal.model,
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  };
  const first = scheduleFormulaBlock(formulaBlock({ bid: "join", text: "x" }), {
    ...hooks,
    isStale: () => firstStale,
    sendVision: async () => {
      sends += 1;
      firstStale = true;
      await hold;
      return { ok: true, text: "x" };
    }
  });
  for (let i = 0; i < 30 && sends < 1; i += 1) await Promise.resolve();
  assert.equal(sends, 1);
  const second = scheduleFormulaBlock(formulaBlock({ bid: "join", text: "x" }), {
    ...hooks,
    isStale: () => false,
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    }
  });
  for (let i = 0; i < 40 && joins < 1; i += 1) await Promise.resolve();
  assert.equal(joins, 1);
  release();
  const staleShown = await first;
  const liveShown = await second;
  assert.equal(staleShown.latexSource, undefined);
  assert.equal(liveShown.latex, "x");
  assert.equal(liveShown.latexSource, "vlm");
  assert.equal(sends, 2);
});

test("k from an in-flight request lands on the page ledger after it is replaced", async () => {
  const settings = settingsFor("openai");
  const first = beginMmPage(11);
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  let started = false;
  const job = scheduleFormulaBlock(formulaBlock({ bid: "pagek", text: "x" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-k",
    page: 11,
    settings,
    readSettings: () => settings,
    katex,
    mmLedger: first,
    sendVision: async () => {
      started = true;
      await hold;
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  for (let i = 0; i < 20 && !started; i += 1) await Promise.resolve();
  assert.equal(started, true);
  const second = beginMmPage(11);
  assert.notEqual(first, second);
  release();
  const shown = await job;
  assert.equal(shown.latexSource, "vlm");
  assert.equal(first.stats().k, 0);
  assert.equal(second.stats().k, 1);
  assert.equal(mmPageStatsFor(11).k, 1);
  const again = mmPageLedger(11);
  assert.equal(again, second);
  again.note("kept", { candidate: true, sent: 1 });
  assert.equal(mmPageStatsFor(11).k, 2);
});

test("guard: a stale read does not return the cached hit", async () => {
  const settings = settingsFor("openai");
  const model = cachedModel(settings);
  let stale = false;
  const inner = createMemoryStore();
  const state = {
    saved: [],
    onGet: () => {
      stale = true;
    }
  };
  const cache = createFormulaCache(wrapStore(inner, state));
  const unit = {
    docHash: "doc-stalehit",
    bid: "stalehit",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  };
  state.onGet = null;
  await cache.writeTier(tierRecordKey(unit, multimodalTier, model), {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "x",
    meta: { version: "mm-1" }
  }, { docHash: "doc-stalehit", model });
  state.onGet = () => {
    stale = true;
  };
  const result = await cache.loadTier(multimodalTier, unit, { model, isStale: () => stale });
  assert.equal(result.reason, "stale");
  assert.equal(result.latex ?? null, null);
});

test("guard: a settings change during the decision read is not stored", async () => {
  const store = createMemoryStore();
  let current = true;
  const wrapped = {
    async getTier(key) { return store.getTier(key); },
    async commitTier(key, record) { return store.commitTier(key, record); },
    async deleteTier(key, decidedAt) { return store.deleteTier(key, decidedAt); },
    async getDecision(key) {
      current = false;
      return store.getDecision(key);
    },
    async putDecision(key, record) { return store.putDecision(key, record); }
  };
  const cache = createFormulaCache(wrapped);
  const wrote = await cache.rememberDecision({ docHash: "doc", bid: "still" }, {
    chosen: {
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex: "x",
      meta: { version: "mm-1" }
    }
  }, { model: "m", stillCurrent: () => current });
  assert.equal(wrote, false);
  assert.equal(await store.getDecision("doc:still"), null);
});

test("a verified decision is not replaced on memory or indexedDB", async () => {
  const verified = {
    tier: "multimodal",
    docHash: "doc",
    decidedAt: 2,
    epoch: 2,
    decision: {
      chosen: { tier: "multimodal", status: "ok", render: "katex", latex: "x" }
    }
  };
  const reject = {
    tier: "multimodal",
    docHash: "doc",
    decidedAt: 9,
    epoch: 9,
    decision: {
      chosen: { tier: "multimodal", status: "reject", reason: "katex-error", render: null, latex: null }
    }
  };
  const memory = createMemoryStore();
  assert.equal(await memory.putDecision("doc:keep", verified), true);
  assert.equal(await memory.putDecision("doc:keep", reject), false);
  assert.equal((await memory.getDecision("doc:keep")).decision.chosen.latex, "x");
  const idb = createIdbFormulaStore({ indexedDB: new IDBFactory() });
  assert.equal(await idb.putDecision("doc:keep", verified), true);
  assert.equal(await idb.putDecision("doc:keep", reject), false);
  assert.equal((await idb.getDecision("doc:keep")).decision.chosen.latex, "x");
});

test("createMessageFormulaStore drops a failed commit and beginMmPage replaces the page", async () => {
  const broken = createMessageFormulaStore(async () => {
    throw new Error("sw down");
  });
  assert.equal(await broken.getTier("k"), null);
  assert.equal(await broken.commitTier("k", { tier: "multimodal", result: { tier: "multimodal" } }), false);
  assert.equal(await broken.putDecision("k", { tier: "multimodal" }), false);
  const quiet = createMessageFormulaStore(async () => ({ ok: false }));
  assert.equal(await quiet.commitTier("k", { tier: "multimodal" }), false);

  const first = beginMmPage(9);
  first.note("a", { candidate: true, ready: true, sent: 2 });
  const second = beginMmPage(9);
  assert.notEqual(first, second);
  assert.equal(mmPageStatsFor(9).m, 0);
  assert.equal(mmPageStatsFor(9).k, 0);
  assert.equal(first.stats().m, 1);
  second.note("b", { candidate: true, ready: true, painted: true, sent: 1 });
  assert.equal(mmPageStatsFor(9).ready, 1);
  assert.equal(mmPageStatsFor(9).n, 1);
  second.note("b", { candidate: true, ready: false, painted: false, sent: 0 });
  assert.equal(mmPageStatsFor(9).ready, 1);
  assert.equal(mmPageStatsFor(9).n, 1);
  assert.equal(mmPageStatsFor(99).m, 0);
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

const PAIRS = [
  ["read", "settings"],
  ["read", "page-turn"],
  ["read", "unload"],
  ["read", "multitab"],
  ["send", "settings"],
  ["send", "page-turn"],
  ["send", "unload"],
  ["send", "multitab"],
  ["send", "fail-retry"],
  ["write", "settings"],
  ["write", "page-turn"],
  ["write", "unload"],
  ["write", "cache-interrupt"],
  ["write", "multitab"],
  ["align", "arxiv"]
];

function askTarget() {
  return {
    ok: true,
    via: "multimodal",
    provider: "openai",
    model: "gpt-5.6-luna",
    url: "https://api.openai.com/v1/chat/completions",
    host: "api.openai.com"
  };
}

async function loggedVision(req, fallbackSecret) {
  const live = typeof req.readSecret === "function" ? String(await req.readSecret() || "") : fallbackSecret;
  const wire = buildVisionRequest(req.target || {}, {
    system: req.system,
    text: req.text,
    images: req.images,
    secret: live
  });
  const rawAuth = String(wire.headers?.Authorization || wire.headers?.["x-goog-api-key"] || "");
  if (!live || !rawAuth.includes(live)) throw new Error("vision auth header did not carry the key");
  return {
    headers: redactHeaders(wire.headers),
    target: req.target,
    text: req.text,
    image: req.images?.[0]
  };
}

async function assertWorld(world, seed, step) {
  const dump = JSON.stringify({
    saved: world.state.saved,
    decisions: world.state.decisions || [],
    requests: world.requests.map((row) => ({
      headers: row.headers,
      target: row.target,
      text: row.text,
      image: row.image
    })),
    blocks: world.blocks,
    stats: world.tabs.map((tab) => tab.ledger.stats())
  });
  assert.equal(dump.includes(world.secret), false, `seed ${seed} step ${step} inv1`);
  for (const row of world.requests) {
    const auth = row.headers?.Authorization || row.headers?.["x-goog-api-key"] || "";
    assert.equal(auth, "***", `seed ${seed} step ${step} auth`);
    assert.equal(JSON.stringify(row.headers || {}).includes(world.secret), false, `seed ${seed} step ${step} auth`);
    assert.equal(JSON.stringify(row.target || {}).includes(world.secret), false, `seed ${seed} step ${step} target`);
    assert.equal(row.image?.mime, "image/png");
    assert.equal(String(row.image?.base64 || "").startsWith("http"), false);
    assert.equal(String(row.image?.base64 || "").startsWith("data:"), false);
  }
  for (const row of world.state.saved) {
    assert.equal(row.key, `${row.unitKey}:${row.tier}:${MM_TIER_VERSION}:${row.model}:${row.cropHash}`, `seed ${seed} step ${step} inv4`);
    assert.equal(row.model.includes("#"), true, `seed ${seed} step ${step} fingerprint`);
    assert.equal(row.configFingerprint.length, 16);
    assert.equal(row.model.endsWith(`#${row.configFingerprint}`), true);
    assert.equal(row.result?.meta?.version, MM_TIER_VERSION);
    assert.notEqual(row.result?.reason, "aborted", `seed ${seed} aborted`);
    assert.notEqual(row.result?.reason, "stale", `seed ${seed} stale`);
    assert.notEqual(row.result?.reason, "timeout", `seed ${seed} timeout`);
    assert.equal(["401", "403", "429", "timeout"].includes(row.result?.meta?.visionCode), false);
    assert.equal(JSON.stringify(row).includes(world.secret), false);
  }
  for (const row of world.state.decisions || []) {
    assert.equal(JSON.stringify(row).includes(world.secret), false, `seed ${seed} decision`);
    if (row.decision?.chosen?.render === "katex") {
      assert.equal(row.decision.chosen.status, "ok");
    }
  }
  for (const row of world.state.saved) {
    if (row.result?.render === "katex" && row.result.latex) world.verified.set(row.key, row.result.latex);
  }
  for (const [key, latex] of world.verified) {
    const denied = await world.cache.writeTier(key, {
      tier: "multimodal",
      status: "reject",
      reason: "katex-error",
      meta: { epoch: 99, version: "mm-1" }
    }, { docHash: "probe", model: "probe" });
    assert.equal(denied, false, `seed ${seed} step ${step} inv5 write ${key}`);
    const row = await world.inner.getTier(key);
    assert.equal(row?.result?.latex, latex, `seed ${seed} step ${step} inv5 ${key}`);
    assert.equal(row?.result?.status, "ok");
    assert.equal(row?.result?.render, "katex");
  }
  for (const tab of world.tabs) {
    const stats = tab.ledger.stats();
    assert.equal(stats.n, 0, `seed ${seed} step ${step} painted`);
    assert.ok(stats.ready <= stats.m, `seed ${seed} ready/m`);
    assert.equal(stats.k, tab.accountedK, `seed ${seed} step ${step} k`);
  }
  assert.equal(world.askTouchedFormula, false, `seed ${seed} step ${step} inv6`);
}

async function runSeed(seed, cover) {
  const rng = mulberry32(seed);
  const secret = `sk-seed-${seed}-SECRET-KEY`;
  const state = { saved: [], decisions: [], boom: false, boomDecision: false };
  const inner = createMemoryStore();
  const cache = createFormulaCache(wrapStore(inner, state));
  const world = {
    secret,
    state,
    cache,
    inner,
    requests: [],
    blocks: [],
    verified: new Map(),
    askTouchedFormula: false,
    tabs: [0, 1].map((id) => ({
      id,
      ledger: createMmLedger(),
      stale: false,
      settings: settingsFor("openai", { apiKey: secret, model: "gpt-5.6-luna" }),
      accountedK: 0
    }))
  };
  const steps = seed === 1 ? PAIRS.length : 4;
  for (let step = 0; step < steps; step += 1) {
    const pair = seed === 1 ? PAIRS[step] : PAIRS[Math.floor(rng() * PAIRS.length)];
    await runStep(world, pair[0], pair[1], rng, seed, step, cover);
    await assertWorld(world, seed, step);
  }
}

async function runStep(world, stage, event, rng, seed, step, cover) {
  cover[`${stage}:${event}`] = (cover[`${stage}:${event}`] || 0) + 1;
  const tab = world.tabs[step % world.tabs.length];
  tab.stale = false;
  let resolveHold;
  const hold = new Promise((resolve) => {
    resolveHold = resolve;
  });
  const entered = { done: false };
  let markEntered;
  const enteredPromise = new Promise((resolve) => {
    markEntered = resolve;
  });
  let used = false;
  world.stage = stage;
  const pause = async () => {
    if (used || world.stage !== stage) return;
    used = true;
    entered.done = true;
    markEntered();
    await hold;
  };
  world.state.onGet = async () => {
    if (stage === "read") await pause();
  };
  world.state.onCommit = async () => {
    if (stage === "write") await pause();
  };
  const savedAtStart = world.state.saved.length;
  const beforeK = tab.ledger.stats().k;
  const controller = new AbortController();
  const bid = seed === 1 ? `s${seed}-t${tab.id}-n${step}` : `t${tab.id}-slot${step % 2}`;
  const fingerprintAtStart = mmConfigFingerprint(tab.settings);
  const counts = {};
  let fail = "";
  const job = scheduleFormulaBlock(formulaBlock({
    bid,
    id: bid,
    text: "x",
    display: rng() < 0.5
  }), {
    ...formulaChainFlags(tab.settings, { arxivEnabled: event === "arxiv" }),
    docHash: `doc-${tab.id}`,
    settings: tab.settings,
    readSettings: () => tab.settings,
    katex,
    cache: world.cache,
    mmLedger: tab.ledger,
    tiers: countingTiers(counts),
    signal: controller.signal,
    isStale: () => tab.stale,
    model: tab.settings.multimodal.model,
    sendVision: async (req) => {
      world.requests.push({
        step,
        bid,
        fingerprint: mmConfigFingerprint(tab.settings),
        ...(await loggedVision(req, world.secret))
      });
      if (stage === "send") await pause();
      if (controller.signal.aborted) {
        return { ok: false, error: { code: "aborted", status: 0, summary: "已中止" } };
      }
      if (fail) {
        const liveKey = tab.settings.multimodal.apiKey;
        return { ok: false, error: { code: fail, status: fail === "timeout" ? 0 : Number(fail), summary: `no ${liveKey}` } };
      }
      return { ok: true, text: "x" };
    },
    readAlignment: async () => {
      if (stage === "align") await pause();
      if (event !== "arxiv") return null;
      return {
        useSource: true,
        stats: { wordRate: 1 },
        formulas: [{
          bid,
          kind: "display",
          latex: "x",
          checks: { position: true, chars: true, number: true, render: true }
        }]
      };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  const which = await Promise.race([
    enteredPromise.then(() => "paused"),
    job.then(() => "finished")
  ]);
  if (which === "finished") {
    resolveHold();
    const shown = await job;
    world.stage = "off";
    world.blocks.push({ bid, latexSource: shown?.latexSource || "" });
    return;
  }
  assert.equal(which, "paused", `seed ${seed} ${stage}:${event} was not in flight`);
  world.formulaPhase = "inflight";
  const savedBeforeAsk = world.state.saved.length;
  const ledgerBeforeAsk = JSON.stringify(tab.ledger.stats());
  let askSawPhase = "";
  let askSawSaved = -1;
  let askSawLedger = "";
  const asked = await deliverAsk(askTarget(), async () => {
    await Promise.resolve();
    askSawPhase = world.formulaPhase;
    askSawSaved = world.state.saved.length;
    askSawLedger = JSON.stringify(tab.ledger.stats());
    return { ok: true, body: "ask-body" };
  });
  if (asked.body !== "ask-body" || askSawPhase !== "inflight" || askSawSaved !== savedBeforeAsk || askSawLedger !== ledgerBeforeAsk) {
    world.askTouchedFormula = true;
  }
  if (event === "page-turn") {
    tab.stale = true;
    tab.ledger.bump();
    tab.accountedK = 0;
  } else if (event === "settings") {
    const flip = tab.settings.multimodal.model === "gpt-5.6-luna";
    tab.settings = settingsFor(flip ? "qwen" : "openai", {
      apiKey: `${world.secret}-step-${step}`,
      model: flip ? "qwen3-vl-plus" : "gpt-5.6-luna"
    });
  } else if (event === "unload") {
    controller.abort();
    tab.stale = true;
  } else if (event === "fail-retry") {
    fail = "timeout";
  } else if (event === "cache-interrupt") {
    world.state.boom = true;
  } else if (event === "multitab") {
    const other = world.tabs[1 - tab.id];
    const savedStage = world.stage;
    world.stage = "off";
    await scheduleFormulaBlock(formulaBlock({
      bid: `s${seed}-other-${step}`,
      text: "x"
    }), {
      ...formulaChainFlags(other.settings),
      docHash: `doc-${other.id}`,
      settings: other.settings,
      readSettings: () => other.settings,
      katex,
      cache: world.cache,
      mmLedger: other.ledger,
      model: other.settings.multimodal.model,
      sendVision: async (req) => {
        world.requests.push({
          step,
          bid: `s${seed}-other-${step}`,
          fingerprint: mmConfigFingerprint(other.settings),
          ...(await loggedVision(req, world.secret))
        });
        return { ok: true, text: "x" };
      },
      withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
    });
    other.accountedK += 1;
    world.stage = savedStage;
  }
  resolveHold();
  const shown = await job;
  world.stage = "off";
  world.state.onGet = null;
  world.state.onCommit = null;
  world.state.boom = false;
  world.blocks.push({ bid, latexSource: shown?.latexSource || "" });
  const kDelta = tab.ledger.stats().k - beforeK;
  const voided = event === "settings" || event === "page-turn" || event === "unload";
  if (voided || event === "arxiv") {
    assert.notEqual(shown.latexSource, "vlm", `seed ${seed} ${stage}:${event} stamped`);
    assert.equal(world.state.saved.length, savedAtStart, `seed ${seed} void cached`);
  }
  if (event === "arxiv") {
    assert.equal(shown.latexSource, "arxiv-src", `seed ${seed} arxiv`);
    assert.equal(kDelta, 0);
    assert.equal(counts.self || 0, 0);
    assert.equal(counts.vector || 0, 0);
    return;
  }
  const sentHere = world.requests.filter((row) => row.step === step && row.bid === bid).length;
  if (event === "fail-retry") {
    if (sentHere === 0) {
      assert.equal(shown.latexSource, "vlm", `seed ${seed} reused hit`);
      assert.equal(kDelta, 0, `seed ${seed} reused k`);
    } else {
    assert.equal(kDelta, 1, `seed ${seed} timeout counted`);
    const beforeRetry = world.requests.length;
    const retry = await scheduleFormulaBlock(formulaBlock({ bid: `${bid}-retry-${step}`, text: "x" }), {
      ...formulaChainFlags(tab.settings),
      docHash: `doc-${tab.id}`,
      settings: tab.settings,
      readSettings: () => tab.settings,
      katex,
      cache: world.cache,
      mmLedger: tab.ledger,
      model: tab.settings.multimodal.model,
      sendVision: async (req) => {
        world.requests.push({
          step,
          bid: `${bid}-retry-${step}`,
          fingerprint: mmConfigFingerprint(tab.settings),
          ...(await loggedVision(req, world.secret))
        });
        return { ok: true, text: "x" };
      },
      withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
    });
    assert.equal(world.requests.length, beforeRetry + 1, `seed ${seed} retry sent`);
    assert.equal(retry.latexSource, "vlm");
    assert.equal(tab.ledger.stats().k - beforeK, 2, `seed ${seed} retry k`);
    tab.accountedK += 2;
    }
  } else if (event === "cache-interrupt") {
    if (sentHere === 0) {
      assert.equal(shown.latexSource, "vlm", `seed ${seed} reused hit`);
      assert.equal(kDelta, 0, `seed ${seed} reused k`);
    } else {
      assert.equal(shown.latexSource, "vlm");
      assert.equal(kDelta, 1, `seed ${seed} interrupt k`);
      tab.accountedK += 1;
      const key = tierRecordKey({
        docHash: `doc-${tab.id}`,
        bid,
        bbox: [0.1, 0.2, 0.4, 0.3],
        crop: { pixels: PNG }
      }, multimodalTier, cachedModel(tab.settings));
      assert.equal(await world.inner.getTier(key), null, `seed ${seed} torn tier`);
      assert.equal(await world.inner.getDecision(`doc-${tab.id}:${bid}`), null, `seed ${seed} torn decision`);
    }
  } else if (event === "multitab") {
    assert.equal(shown.latexSource, "vlm");
    if (sentHere === 0) assert.equal(kDelta, 0, `seed ${seed} reused k`);
    else {
      assert.equal(kDelta, 1, `seed ${seed} multitab k`);
      tab.accountedK += 1;
    }
  } else if (event === "settings") {
    assert.equal(kDelta, 0, `seed ${seed} settings k`);
    const oldReqs = world.requests.filter((row) => row.step === step && row.fingerprint === fingerprintAtStart && row.bid === bid);
    if (stage === "read") assert.equal(oldReqs.length, 0, `seed ${seed} read sent old`);
    else assert.equal(oldReqs.length, 1, `seed ${seed} in-flight old`);
    const nextBid = `${bid}-next-${step}`;
    const beforeNext = world.requests.length;
    await scheduleFormulaBlock(formulaBlock({ bid: nextBid, text: "x" }), {
      ...formulaChainFlags(tab.settings),
      docHash: `doc-${tab.id}`,
      settings: tab.settings,
      readSettings: () => tab.settings,
      katex,
      cache: world.cache,
      mmLedger: tab.ledger,
      model: tab.settings.multimodal.model,
      sendVision: async (req) => {
        world.requests.push({
          step,
          bid: nextBid,
          fingerprint: mmConfigFingerprint(tab.settings),
          ...(await loggedVision(req, world.secret))
        });
        return { ok: true, text: "x" };
      },
      withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
    });
    assert.equal(world.requests.length, beforeNext + 1, `seed ${seed} new key sent`);
    const follow = world.requests.find((row) => row.bid === nextBid);
    assert.notEqual(follow.fingerprint, fingerprintAtStart, `seed ${seed} inv3 fingerprint`);
    assert.equal(follow.fingerprint, mmConfigFingerprint(tab.settings));
    tab.accountedK += 1;
  } else if (event === "page-turn") {
    assert.equal(tab.ledger.stats().k, 0, `seed ${seed} page-turn k`);
    tab.accountedK = 0;
  } else {
    assert.equal(kDelta, 0, `seed ${seed} ${event} k`);
  }
  assert.equal(counts.self || 0, 0, `seed ${seed} self`);
  assert.equal(counts.vector || 0, 0, `seed ${seed} vector`);
  assert.equal(JSON.stringify(shown || {}).includes(world.secret), false, `seed ${seed} block`);
}

test("500 seeds pause inside read, send, and write", async () => {
  const cover = {};
  for (let seed = 1; seed <= 500; seed += 1) {
    try {
      await runSeed(seed, cover);
    } catch (err) {
      console.error(`mm-tier random failed seed=${seed}`);
      throw err;
    }
  }
  for (const [stage, event] of PAIRS) {
    assert.ok(cover[`${stage}:${event}`] > 0, `${stage}:${event}`);
  }
});
