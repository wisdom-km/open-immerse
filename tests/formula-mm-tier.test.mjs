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
 * ④ 缓存命中的记录属于当前 model + cropHash + mm-2；
 * ⑤ 已经核对通过的公式不会被更旧的结果降级，也不会被更早采样的已核对行盖掉。
 *    仍存活调用者的已核对决策，其 tier 行 latex 与该决策一致；被换掉的已核对行留在
 *    存储行的 prev 链上，过期回滚只摘掉自己或恢复链上最近一个仍在的行，不丢行，
 *    也不让更旧的行盖住更新的已提交行。
 * ⑥ 问 AI 不和公式队列互相等待，也不改对方的状态；
 * ⑦ 只接了多模态这一家时，核对不过或调用失败不会去跑自研算法或矢量重绘。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FORMULA_DB, handleFormulaCacheMessage, createIdbFormulaStore } from "../background/formula-cache.js";
import { IDBFactory } from "fake-indexeddb";
import { deliverAsk } from "../lib/ask-route.js";
import { createMessageFormulaStore } from "../lib/formula-cache-client.js";
import { createCallGate, createFormulaCache, createMemoryStore, tierRecordKey } from "../lib/formula-cache.js";
import { decideFormula } from "../lib/formula-chain.js";
import { CHAIN_VERSION, cropHashOf, contractViolations, unitKeyOf } from "../lib/formula-contract.js";
import { cropPngFor } from "../lib/formula-crop-png.js";
import { classifyMmDecision, createMmLedger, mmPageStatsFor, beginMmPage, mmPageLedger, resetMmPages } from "../lib/formula-mm-ledger.js";
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
      if (stored) {
        const copy = { ...record };
        delete copy.displacedTier;
        state.saved.push({ ...structuredClone(copy), key });
      }
      return stored;
    },
    async rollbackTier(key, writeId, displaced) {
      const rolled = typeof inner.rollbackTier === "function"
        ? await inner.rollbackTier(key, writeId, displaced)
        : false;
      if (rolled) {
        const kept = await inner.getTier(key);
        const next = [];
        let seen = false;
        for (const row of state.saved) {
          if (row.key !== key) {
            next.push(row);
            continue;
          }
          if (kept && row.writeId === kept.writeId && !seen) {
            next.push(row);
            seen = true;
          }
        }
        if (kept && !seen) next.push({ ...structuredClone(kept) });
        state.saved = next;
      }
      return rolled;
    },
    async deleteTier(key, writeId) {
      const removed = await inner.deleteTier(key, writeId);
      if (removed) {
        const index = state.saved.findIndex((row) => row.key === key && row.writeId === writeId);
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

test("cache hits use mm-2 plus the model and do not send again", async () => {
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

test("a verified mm-1 row is not adopted", async () => {
  assert.equal(MM_TIER_VERSION, "mm-2");
  assert.equal(CHAIN_VERSION, "f3-1");
  const settings = settingsFor("openai", { model: "gpt-5.6-luna" });
  const cache = createFormulaCache(createMemoryStore());
  const named = modelKey(settings);
  const unit = {
    docHash: "doc-old",
    bid: "old1",
    bbox: [0.1, 0.2, 0.4, 0.3],
    crop: { pixels: PNG }
  };
  const oldKey = tierRecordKey(unit, { id: "multimodal", version: "mm-1" }, named);
  const liveKey = tierRecordKey(unit, { id: "multimodal", version: MM_TIER_VERSION }, named);
  assert.notEqual(oldKey, liveKey);
  const wrote = await cache.writeTier(oldKey, {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "\\quad",
    confidence: 1,
    checks: {},
    reason: null,
    meta: { version: "mm-1", latexSource: "vlm" }
  }, {
    docHash: unit.docHash,
    unitKey: unitKeyOf(unit),
    cropHash: cropHashOf(unit),
    model: named
  });
  assert.equal(wrote, true);
  let sends = 0;
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "old1", id: "old1" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-old",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: "gpt-5.6-luna",
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    cropPngFor: async () => ({ mime: "image/png", base64: PNG }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(sends, 1);
  assert.notEqual(shown.latex, "\\quad");
  assert.equal((await cache.store.getTier(oldKey)).result.latex, "\\quad");
});

test("an uncheckable text layer does not call the model", async () => {
  const settings = settingsFor("openai");
  let sends = 0;
  const result = await runMultimodal({
    pdfText: "\u0012\u0013",
    display: true,
    glyphs: [],
    equationNumber: null,
    crop: { url: PNG_URL }
  }, {
    flags: formulaChainFlags(settings),
    settings,
    readSettings: () => settings,
    katex,
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    },
    cropPngFor: async () => ({ mime: "image/png", base64: PNG })
  });
  assert.equal(sends, 0);
  assert.equal(result.reason, "uncheckable-glyph");
  assert.equal(result.status, "reject");
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
    async rollbackTier(key, writeId, displaced) {
      return real.rollbackTier(key, writeId, displaced);
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

test("a same-tab rollback does not delete the other caller's newer verified row", async () => {
  const settings = settingsFor("openai");
  async function overlap(real, pixelsA, pixelsB, label) {
    const same = pixelsA === pixelsB;
    let commits = 0;
    let bKey = "";
    let bWriteId = null;
    const seenAt = [];
    const seenId = [];
    let releaseSecond;
    const secondCommit = new Promise((resolve) => {
      releaseSecond = resolve;
    });
    let aStale = false;
    let decisions = 0;
    const gate = createCallGate();
    const run = gate.run.bind(gate);
    let joins = 0;
    gate.run = (key, fn, signal) => {
      if (gate.has(key)) joins += 1;
      return run(key, fn, signal);
    };
    let releaseLoads;
    const loadsSeen = new Promise((resolve) => {
      releaseLoads = resolve;
    });
    let openLoads;
    const loadsHold = new Promise((resolve) => {
      openLoads = resolve;
    });
    let loadReads = 0;
    const store = {
      async getTier(key) {
        loadReads += 1;
        if (loadReads === 2) releaseLoads();
        if (loadReads <= 2) await loadsHold;
        return real.getTier(key);
      },
      async commitTier(key, record) {
        const stored = await real.commitTier(key, record);
        commits += 1;
        seenAt.push(record.decidedAt);
        seenId.push(record.writeId);
        if (commits === 2) {
          bKey = key;
          bWriteId = record.writeId;
          releaseSecond();
        }
        return stored;
      },
      async deleteTier(key, writeId) {
        return real.deleteTier(key, writeId);
      },
      async rollbackTier(key, writeId, displaced) {
        return real.rollbackTier(key, writeId, displaced);
      },
      async getDecision(key) {
        decisions += 1;
        if (decisions === 1) {
          await secondCommit;
          aStale = true;
        }
        return real.getDecision(key);
      },
      async putDecision(key, record) {
        return real.putDecision(key, record);
      }
    };
    const cache = createFormulaCache(store, { now: () => 1000, gate });
    let sends = 0;
    let releaseSend;
    const sendHold = new Promise((resolve) => {
      releaseSend = resolve;
    });
    const call = (pixels, stale) => scheduleFormulaBlock(formulaBlock({ bid: "same", text: "x" }), {
      ...formulaChainFlags(settings),
      docHash: "doc-same",
      settings,
      readSettings: () => settings,
      katex,
      cache,
      model: "m",
      isStale: stale,
      cropPngFor: async () => ({ mime: "image/png", base64: pixels, w: 1, h: 1, hash: pixels }),
      sendVision: async () => {
        sends += 1;
        if (!same) {
          if (sends === 2) releaseSend();
          await sendHold;
        } else if (sends === 1) {
          for (let i = 0; i < 40 && joins < 1; i += 1) await Promise.resolve();
          assert.equal(joins, 1, `${label} joined`);
        }
        return { ok: true, text: "x" };
      },
      withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
    });
    const first = call(pixelsA, () => aStale);
    const second = call(pixelsB, () => false);
    for (let i = 0; i < 40 && loadReads < 2; i += 1) await Promise.resolve();
    assert.equal(loadReads, 2, `${label} both read`);
    openLoads();
    if (!same) {
      for (let i = 0; i < 40 && sends < 2; i += 1) await Promise.resolve();
      assert.equal(sends, 2, `${label} both sent`);
      releaseSend();
    }
    const [shownA, shownB] = await Promise.all([first, second]);
    assert.equal(shownB.latexSource, "vlm", `${label} other verified`);
    assert.equal(shownA.latexSource, undefined, `${label} caller went stale`);
    assert.ok(bKey, `${label} other committed`);
    assert.deepEqual(seenAt, [1000, 1000], `${label} same millisecond`);
    assert.equal(typeof seenId[0], "string", `${label} write id`);
    assert.notEqual(seenId[0], seenId[1], `${label} distinct write id`);
    const row = await real.getTier(bKey);
    assert.equal(row?.writeId, bWriteId, `${label} write id`);
    assert.equal(row?.decidedAt, 1000, `${label} decidedAt`);
    assert.equal(row?.result?.latex, "x", `${label} latex`);
  }
  await overlap(createMemoryStore(), "crop-same", "crop-same", "memory same crop");
  await overlap(createMemoryStore(), "crop-a", "crop-b", "memory other crop");
  await overlap(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "crop-same", "crop-same", "idb same crop");
  await overlap(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "crop-a", "crop-b", "idb other crop");
});

function verifiedTierRecord(latex, extra = {}) {
  return {
    docHash: extra.docHash || "doc",
    unitKey: extra.unitKey || "doc:b",
    decidedAt: extra.decidedAt ?? 1000,
    writeId: extra.writeId,
    chainVersion: "f3-1",
    tier: "multimodal",
    model: extra.model || "m",
    result: {
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex,
      meta: { version: "mm-1", epoch: extra.epoch ?? 1 }
    }
  };
}

test("rollback of a later verified write restores the row it replaced", async () => {
  async function restore(real, label) {
    const key = `doc:restore:${label}`;
    const older = verifiedTierRecord("x", { writeId: "tab:1", unitKey: "doc:restore" });
    const newer = verifiedTierRecord("x", { writeId: "tab:2", unitKey: "doc:restore" });
    assert.equal(await real.commitTier(key, older), true, label);
    assert.equal(await real.commitTier(key, newer), true, label);
    assert.equal(newer.displacedTier?.writeId, "tab:1", label);
    assert.equal(await real.rollbackTier(key, "tab:2", newer.displacedTier), true, label);
    const row = await real.getTier(key);
    assert.equal(row?.writeId, "tab:1", label);
    assert.equal(row?.result?.latex, "x", label);
  }
  await restore(createMemoryStore(), "memory");
  await restore(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
  const memory = createMemoryStore();
  const remote = createMessageFormulaStore((message) => handleFormulaCacheMessage(message, memory));
  const key = "doc:restore:message";
  const older = verifiedTierRecord("x", { writeId: "tab:1", unitKey: "doc:restore" });
  const newer = verifiedTierRecord("x", { writeId: "tab:2", unitKey: "doc:restore" });
  assert.equal(await remote.commitTier(key, older), true);
  assert.equal(await remote.commitTier(key, newer), true);
  assert.equal(newer.displacedTier?.writeId, "tab:1");
  assert.equal(await remote.rollbackTier(key, newer.writeId, newer.displacedTier), true);
  assert.equal((await memory.getTier(key))?.writeId, "tab:1");
});

test("a stale later commit restores the live caller's verified row", async () => {
  const settings = settingsFor("openai");
  const other = await import("../lib/formula-cache.js?realm=b");
  async function swapped(real, createOther, skew, label) {
    const shown = await runOverlappedPair(real, {
      settings,
      createCache: createFormulaCache,
      createOther,
      staleWho: 1,
      swap: false,
      skew,
      docHash: `doc-swap-${label}`,
      label
    });
    assert.equal(shown.live.latexSource, "vlm", `${label} live`);
    assert.equal(shown.stale.latexSource, undefined, `${label} stale`);
    assert.equal(shown.decision?.decision?.chosen?.latex, "x", `${label} decision`);
    assert.equal(shown.row?.result?.latex, "x", `${label} tier`);
    assert.equal(shown.row?.writeId, shown.liveWriteId, `${label} restored id`);
  }
  await swapped(createMemoryStore(), null, 0, "memory same ms");
  await swapped(createIdbFormulaStore({ indexedDB: new IDBFactory() }), null, 0, "idb same ms");
  await swapped(createMemoryStore(), other.createFormulaCache, 0, "memory cross nonce");
  await swapped(createMemoryStore(), other.createFormulaCache, 1, "memory cross nonce +1ms");
  await swapped(createIdbFormulaStore({ indexedDB: new IDBFactory() }), other.createFormulaCache, 0, "idb cross nonce");
  await swapped(createIdbFormulaStore({ indexedDB: new IDBFactory() }), other.createFormulaCache, 1, "idb cross nonce +1ms");
});

async function runOverlappedPair(real, options) {
  const {
    settings,
    createCache,
    createOther = null,
    staleWho,
    swap,
    skew,
    docHash,
    label
  } = options;
  const callers = [
    { index: 0, stale: false, shown: null },
    { index: 1, stale: false, shown: null }
  ];
  let reads = 0;
  let releaseLoads;
  const loadsSeen = new Promise((resolve) => {
    releaseLoads = resolve;
  });
  let openLoads;
  const loadsHold = new Promise((resolve) => {
    openLoads = resolve;
  });
  let commits = 0;
  let liveWriteId = null;
  let tierKey = "";
  let releaseFirst;
  const firstHeld = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let resolveBoth;
  const bothCommitted = new Promise((resolve) => {
    resolveBoth = resolve;
  });
  const gate = createCallGate();
  function face(caller) {
    return {
      async getTier(key) {
        reads += 1;
        if (reads === 2) releaseLoads();
        if (reads <= 2) await loadsHold;
        return real.getTier(key);
      },
      async commitTier(key, record) {
        const arrival = commits;
        commits += 1;
        tierKey = key;
        if (caller.index !== staleWho) liveWriteId = record.writeId;
        if (commits === 2) {
          resolveBoth();
          releaseFirst();
        }
        if (arrival === 0 && swap) await firstHeld;
        return real.commitTier(key, record);
      },
      async rollbackTier(key, writeId, displaced) {
        return real.rollbackTier(key, writeId, displaced);
      },
      async deleteTier(key, writeId) {
        return real.deleteTier(key, writeId);
      },
      async getDecision(key) {
        if (caller.index === staleWho) {
          await bothCommitted;
          caller.stale = true;
        }
        return real.getDecision(key);
      },
      async putDecision(key, record) {
        return real.putDecision(key, record);
      }
    };
  }
  const nowA = () => 1000;
  const nowB = () => 1000 + skew;
  const cacheA = createCache(face(callers[0]), { now: nowA, gate });
  const cacheB = (createOther || createCache)(face(callers[1]), { now: nowB, gate });
  const caches = [cacheA, cacheB];
  let sends = 0;
  const call = (caller) => scheduleFormulaBlock(formulaBlock({ bid: "pair", text: "x" }), {
    ...formulaChainFlags(settings),
    docHash,
    settings,
    readSettings: () => settings,
    katex,
    cache: caches[caller.index],
    model: "m",
    isStale: () => caller.stale,
    cropPngFor: async () => ({ mime: "image/png", base64: "crop-same", w: 1, h: 1, hash: "crop-same" }),
    sendVision: async () => {
      sends += 1;
      if (sends === 1) {
        for (let i = 0; i < 40 && sends < 1; i += 1) await Promise.resolve();
      }
      return { ok: true, text: "x" };
    },
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  const first = call(callers[0]);
  const second = call(callers[1]);
  for (let i = 0; i < 40 && reads < 2; i += 1) await Promise.resolve();
  assert.equal(reads, 2, `${label} both read`);
  openLoads();
  const [shownA, shownB] = await Promise.all([first, second]);
  callers[0].shown = shownA;
  callers[1].shown = shownB;
  return {
    live: callers[staleWho === 0 ? 1 : 0].shown,
    stale: callers[staleWho].shown,
    decision: await real.getDecision(`${docHash}:pair`),
    row: tierKey ? await real.getTier(tierKey) : null,
    liveWriteId,
    sends
  };
}

test("an earlier verified sample cannot overwrite a newer one", async () => {
  async function race(real, label) {
    let held = 0;
    let release;
    const hold = new Promise((resolve) => {
      release = resolve;
    });
    const store = {
      async getTier(key) {
        held += 1;
        if (held === 1) await hold;
        return real.getTier(key);
      },
      async commitTier(key, record) {
        return real.commitTier(key, record);
      },
      async deleteTier(key, writeId) {
        return real.deleteTier(key, writeId);
      }
    };
    const cache = createFormulaCache(store, { now: () => 1000 });
    const key = `doc:early:${label}`;
    const verified = (latex) => ({
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex,
      meta: { version: "mm-1", epoch: 1 }
    });
    const first = cache.writeTier(key, verified("A"), { docHash: "doc", model: "m" });
    for (let i = 0; i < 20 && held < 1; i += 1) await Promise.resolve();
    assert.equal(held, 1, `${label} held`);
    assert.equal(await cache.writeTier(key, verified("B"), { docHash: "doc", model: "m" }), true, label);
    release();
    assert.equal(await first, false, `${label} earlier sample`);
    const row = await real.getTier(key);
    assert.equal(row?.result?.latex, "B", label);
    assert.equal(row?.decidedAt, 1000, label);
    assert.equal(typeof row?.writeId, "string", label);
  }
  await race(createMemoryStore(), "memory");
  await race(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
});

test("a verified row committed during deleteTier's read survives", async () => {
  const factory = new IDBFactory();
  const real = createIdbFormulaStore({ indexedDB: factory });
  const key = "doc:delwin:multimodal:mm-1:m:crop";
  const older = {
    docHash: "doc",
    decidedAt: 1010,
    writeId: 1,
    chainVersion: "f3-1",
    tier: "multimodal",
    model: "m",
    result: {
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex: "A",
      meta: { version: "mm-1", epoch: 1 }
    }
  };
  assert.equal(await real.commitTier(key, older), true);
  const opener = factory.open(FORMULA_DB, 1);
  const dbB = await new Promise((resolve, reject) => {
    opener.onsuccess = () => resolve(opener.result);
    opener.onerror = () => reject(opener.error);
  });
  const probe = dbB.transaction("tierResults", "readonly");
  const proto = Object.getPrototypeOf(probe.objectStore("tierResults"));
  await new Promise((resolve) => {
    probe.oncomplete = resolve;
  });
  const newer = {
    ...older,
    key,
    decidedAt: 2000,
    writeId: 2,
    result: { ...older.result, latex: "B", meta: { version: "mm-1", epoch: 2 } }
  };
  let armed = false;
  let landed;
  const original = proto.get;
  proto.get = function patchedGet(query) {
    const request = original.call(this, query);
    if (!armed && this.name === "tierResults" && query === key) {
      armed = true;
      request.addEventListener("success", () => {
        const tx = dbB.transaction("tierResults", "readwrite");
        tx.objectStore("tierResults").put(newer, key);
        landed = new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve(true);
          tx.onabort = () => reject(tx.error || new Error("b aborted"));
          tx.onerror = () => reject(tx.error || new Error("b failed"));
        });
      });
    }
    return request;
  };
  try {
    await real.deleteTier(key, 1);
    assert.equal(armed, true);
    await landed;
    const row = await real.getTier(key);
    assert.equal(row?.result?.latex, "B");
    assert.equal(row?.writeId, 2);
    assert.equal(row?.decidedAt, 2000);
  } finally {
    proto.get = original;
    dbB.close();
  }
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

test("live joiners share one retry after a stale shared result", async () => {
  const settings = settingsFor("openai");
  async function joiners(count) {
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
      docHash: "doc-joiners",
      settings,
      readSettings: () => settings,
      katex,
      cache,
      model: settings.multimodal.model,
      withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
    };
    const first = scheduleFormulaBlock(formulaBlock({ bid: "joiners", text: "x" }), {
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
    assert.equal(sends, 1, `${count} started`);
    const rest = [];
    for (let n = 0; n < count; n += 1) {
      rest.push(scheduleFormulaBlock(formulaBlock({ bid: "joiners", text: "x" }), {
        ...hooks,
        isStale: () => false,
        sendVision: async () => {
          sends += 1;
          return { ok: true, text: "x" };
        }
      }));
    }
    for (let i = 0; i < 50 && joins < count; i += 1) await Promise.resolve();
    assert.equal(joins, count, `${count} joined`);
    release();
    const staleShown = await first;
    const shown = await Promise.all(rest);
    assert.equal(staleShown.latexSource, undefined, `${count} stale`);
    for (const block of shown) {
      assert.equal(block.latex, "x", `${count} latex`);
      assert.equal(block.latexSource, "vlm", `${count} source`);
    }
    assert.equal(sends, 2, `${count} sends`);
  }
  await joiners(1);
  await joiners(2);
  await joiners(3);
});

test("a live waiter takes over when the retry initiator goes stale", async () => {
  const settings = settingsFor("openai");
  const gate = createCallGate();
  const run = gate.run.bind(gate);
  let joins = 0;
  gate.run = (key, fn, signal) => {
    if (gate.has(key)) joins += 1;
    return run(key, fn, signal);
  };
  const cache = createFormulaCache(createMemoryStore(), { gate, now: () => 1000 });
  let sends = 0;
  let releaseA;
  const holdA = new Promise((resolve) => {
    releaseA = resolve;
  });
  let aStale = false;
  let bStale = false;
  const hooks = {
    ...formulaChainFlags(settings),
    docHash: "doc-takeover",
    settings,
    readSettings: () => settings,
    katex,
    cache,
    model: settings.multimodal.model,
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  };
  const first = scheduleFormulaBlock(formulaBlock({ bid: "takeover", text: "x" }), {
    ...hooks,
    isStale: () => aStale,
    sendVision: async () => {
      sends += 1;
      aStale = true;
      await holdA;
      return { ok: true, text: "x" };
    }
  });
  for (let i = 0; i < 30 && sends < 1; i += 1) await Promise.resolve();
  assert.equal(sends, 1);
  const second = scheduleFormulaBlock(formulaBlock({ bid: "takeover", text: "x" }), {
    ...hooks,
    isStale: () => bStale,
    sendVision: async () => {
      sends += 1;
      assert.equal(sends, 2, "retry owner");
      for (let i = 0; i < 40 && joins < 3; i += 1) await Promise.resolve();
      assert.equal(joins, 3, "waiter joined the retry");
      bStale = true;
      return { ok: true, text: "x" };
    }
  });
  for (let i = 0; i < 40 && joins < 1; i += 1) await Promise.resolve();
  assert.equal(joins, 1, "retry initiator joined");
  const third = scheduleFormulaBlock(formulaBlock({ bid: "takeover", text: "x" }), {
    ...hooks,
    isStale: () => false,
    sendVision: async () => {
      sends += 1;
      return { ok: true, text: "x" };
    }
  });
  for (let i = 0; i < 40 && joins < 2; i += 1) await Promise.resolve();
  assert.equal(joins, 2, "waiter joined the first call");
  releaseA();
  const shownA = await first;
  const shownB = await second;
  const shownC = await third;
  assert.equal(shownA.latexSource, undefined);
  assert.equal(shownB.latexSource, undefined);
  assert.equal(shownC.latex, "x");
  assert.equal(shownC.latexSource, "vlm");
  assert.equal(sends, 3);
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

test("a new document starts from an empty page ledger", () => {
  resetMmPages();
  const first = mmPageLedger(1);
  first.note("a", { candidate: true, ready: true, sent: 1 });
  first.note("b", { candidate: true, ready: true, sent: 1 });
  first.note("c", { candidate: true, sent: 1 });
  assert.equal(mmPageStatsFor(1).m, 3);
  assert.equal(mmPageStatsFor(1).ready, 2);
  assert.equal(mmPageStatsFor(1).k, 3);
  resetMmPages();
  const second = mmPageLedger(1);
  assert.notEqual(second, first);
  second.note("d", { candidate: true, sent: 1 });
  assert.equal(mmPageStatsFor(1).m, 1);
  assert.equal(mmPageStatsFor(1).ready, 0);
  assert.equal(mmPageStatsFor(1).k, 1);
  resetMmPages();
});

function sourceBetween(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, start);
  return source.slice(from, to);
}

test("viewer restamp, crop, and adoptDoc stay wired to the page lifetime", () => {
  const viewer = read("pdf/viewer.js");
  const restamp = sourceBetween(viewer, "async function restampArxivPage", "async function copyArxivLatex");
  const crop = sourceBetween(viewer, "async function cropLayoutBlocks", "function readFormulaCropImage");
  const adoptAt = viewer.indexOf("async function adoptDoc");
  const adopt = viewer.slice(adoptAt, adoptAt + 400);
  const firstAwait = viewer.indexOf("await ", adoptAt);
  const abortAt = viewer.indexOf("abortInflightLayouts();", adoptAt);
  assert.match(restamp, /const mmLedger = mmPageLedger\(pageNumber\)/);
  assert.equal(restamp.includes("beginMmPage"), false);
  assert.match(restamp, /isStale:\s*\(\)\s*=>\s*restampFormulaStale\(/);
  assert.match(restamp, /publishRestampedBlocks\(\s*layout,\s*next,\s*restampFormulaStale\(/);
  assert.match(crop, /const mmLedger = mmPageLedger\(pageNumber\)/);
  assert.equal(crop.includes("beginMmPage"), false);
  assert.equal(adopt.includes("resetMmPages()"), false);
  assert.ok(abortAt > firstAwait);
  assert.equal(viewer.slice(adoptAt, abortAt).includes("resetMmPages()"), false);
  assert.match(viewer.slice(abortAt, abortAt + 80), /^abortInflightLayouts\(\);\n  resetMmPages\(\);/);
});

test("deleteTier removes only the matching write id", async () => {
  const store = createMemoryStore();
  const key = "doc:memdel:multimodal:mm-1:m:crop";
  assert.equal(await store.commitTier(key, {
    docHash: "doc",
    decidedAt: 1000,
    writeId: 1,
    chainVersion: "f3-1",
    tier: "multimodal",
    model: "m",
    result: {
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex: "A",
      meta: { version: "mm-1", epoch: 1 }
    }
  }), true);
  assert.equal(await store.deleteTier(key, 2), false);
  assert.equal((await store.getTier(key)).writeId, 1);
  assert.equal((await store.getTier(key)).result.latex, "A");
  const remote = createMessageFormulaStore((message) => handleFormulaCacheMessage(message, store));
  assert.equal(await remote.deleteTier(key, 2), false);
  assert.equal((await store.getTier(key)).result.latex, "A");
  assert.equal(await remote.deleteTier(key, 1), true);
  assert.equal(await store.getTier(key), null);
});

test("an older cross-nonce sample cannot replace a newer verified row", async () => {
  async function older(real, label) {
    const key = `doc:wo2:${label}`;
    assert.equal(await real.commitTier(key, verifiedTierRecord("x", { writeId: "tab1:1", decidedAt: 2000 })), true, label);
    assert.equal(await real.commitTier(key, verifiedTierRecord("y", { writeId: "tab2:9", decidedAt: 1999 })), false, label);
    assert.equal((await real.getTier(key))?.result?.latex, "x", label);
    assert.equal(await real.commitTier(key, verifiedTierRecord("z", { writeId: "tab1:4", decidedAt: 1500 })), false, `${label} clock back`);
    assert.equal((await real.getTier(key))?.writeId, "tab1:1", `${label} clock back`);
  }
  await older(createMemoryStore(), "memory");
  await older(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
});

test("a newer cross-nonce sample replaces a verified row even when its serial is lower", async () => {
  async function newer(real, label) {
    const key = `doc:wo4:${label}`;
    assert.equal(await real.commitTier(key, verifiedTierRecord("x", { writeId: "tab1:5", decidedAt: 1000 })), true, label);
    assert.equal(await real.commitTier(key, verifiedTierRecord("y", { writeId: "tab2:1", decidedAt: 1001 })), true, label);
    const row = await real.getTier(key);
    assert.equal(row?.writeId, "tab2:1", label);
    assert.equal(row?.result?.latex, "y", label);
    assert.equal(row?.decidedAt, 1001, label);
  }
  await newer(createMemoryStore(), "memory");
  await newer(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
});

test("deleteTier does not remove a row that has no write id", async () => {
  async function legacy(real, label) {
    const key = `doc:legacy:${label}`;
    const row = verifiedTierRecord("x", { decidedAt: 1000 });
    delete row.writeId;
    assert.equal(await real.commitTier(key, row), true, label);
    assert.equal(await real.deleteTier(key, undefined), false, label);
    assert.equal(await real.deleteTier(key), false, label);
    assert.equal((await real.getTier(key))?.result?.latex, "x", label);
  }
  await legacy(createMemoryStore(), "memory");
  await legacy(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
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

test("guard: going stale during putDecision refuses the decision and rolls the tier back", async () => {
  const settings = settingsFor("openai");
  const real = createMemoryStore();
  let current = true;
  const direct = {
    async getTier(key) { return real.getTier(key); },
    async commitTier(key, record) { return real.commitTier(key, record); },
    async deleteTier(key, writeId) { return real.deleteTier(key, writeId); },
    async getDecision(key) { return real.getDecision(key); },
    async putDecision(key, record) {
      const stored = await real.putDecision(key, record);
      current = false;
      return stored;
    }
  };
  const cache = createFormulaCache(direct, { now: () => 1000 });
  const wrote = await cache.rememberDecision({ docHash: "doc", bid: "after" }, {
    chosen: {
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex: "x",
      meta: { version: "mm-1" }
    }
  }, { model: "m", stillCurrent: () => current });
  assert.equal(wrote, false);
  assert.equal((await real.getDecision("doc:after"))?.decision?.chosen?.latex, "x");

  const scheduled = createMemoryStore();
  let stale = false;
  let tierKey = "";
  const store = {
    async getTier(key) { return scheduled.getTier(key); },
    async commitTier(key, record) {
      tierKey = key;
      return scheduled.commitTier(key, record);
    },
    async deleteTier(key, writeId) { return scheduled.deleteTier(key, writeId); },
    async rollbackTier(key, writeId, displaced) { return scheduled.rollbackTier(key, writeId, displaced); },
    async getDecision(key) { return scheduled.getDecision(key); },
    async putDecision(key, record) {
      const stored = await scheduled.putDecision(key, record);
      stale = true;
      return stored;
    }
  };
  const shown = await scheduleFormulaBlock(formulaBlock({ bid: "afterput", text: "x" }), {
    ...formulaChainFlags(settings),
    docHash: "doc-after",
    settings,
    readSettings: () => settings,
    katex,
    cache: createFormulaCache(store, { now: () => 1000 }),
    model: settings.multimodal.model,
    isStale: () => stale,
    sendVision: async () => ({ ok: true, text: "x" }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  assert.equal(shown.latexSource, undefined);
  assert.ok(tierKey);
  assert.equal(await scheduled.getTier(tierKey), null);
  assert.equal((await scheduled.getDecision("doc-after:afterput"))?.decision?.chosen?.latex, "x");
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
  const seenWrite = new Set();
  for (const row of world.state.saved) {
    assert.equal(typeof row.writeId, "string", `seed ${seed} step ${step} write id`);
    assert.equal(seenWrite.has(row.writeId), false, `seed ${seed} step ${step} duplicate write id`);
    seenWrite.add(row.writeId);
    assert.equal(row.decidedAt, 1000, `seed ${seed} step ${step} colliding clock`);
  }
  const checkedLive = new Set();
  for (const row of world.state.saved) {
    if (checkedLive.has(row.key)) continue;
    checkedLive.add(row.key);
    const live = await world.inner.getTier(row.key);
    if (!live?.writeId) continue;
    assert.equal(await world.inner.deleteTier(row.key, `${live.writeId}:other`), false, `seed ${seed} step ${step} other write id`);
    assert.equal((await world.inner.getTier(row.key))?.writeId, live.writeId, `seed ${seed} step ${step} write id kept`);
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
  const cache = createFormulaCache(wrapStore(inner, state), { now: () => 1000 });
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
  cover[`${stage}:${event}`] = (cover[`${stage}:${event}`] || 0) + 1;
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

test("500 seeds keep a live verified decision paired with its tier row", async () => {
  const other = await import("../lib/formula-cache.js?realm=pair");
  const idb = createIdbFormulaStore({ indexedDB: new IDBFactory() });
  const settings = settingsFor("openai");
  const cover = {
    memory: 0,
    idb: 0,
    same: 0,
    cross: 0,
    ms: 0,
    plus: 0,
    minus: 0,
    staleFirst: 0,
    staleSecond: 0,
    swap: 0,
    natural: 0
  };
  let paired = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const rng = mulberry32(seed);
    const useIdb = rng() < 0.5;
    const cross = rng() < 0.5;
    const skewPick = rng();
    const skew = skewPick < 0.34 ? 0 : skewPick < 0.67 ? 1 : -1;
    const staleWho = rng() < 0.5 ? 0 : 1;
    const swap = rng() < 0.5;
    const real = useIdb ? idb : createMemoryStore();
    const label = `seed ${seed}`;
    try {
      const shown = await runOverlappedPair(real, {
        settings,
        createCache: createFormulaCache,
        createOther: cross ? other.createFormulaCache : null,
        staleWho,
        swap,
        skew,
        docHash: `doc-pair-${seed}-${useIdb ? "idb" : "mem"}`,
        label
      });
      const chosen = shown.decision?.decision?.chosen;
      const verified = chosen?.status === "ok" && chosen.render === "katex" && chosen.latex;
      if (verified) {
        paired += 1;
        assert.ok(shown.row, `${label} live decision missing tier`);
        assert.equal(shown.row.result?.latex, chosen.latex, `${label} latex`);
        assert.equal(shown.row.result?.status, "ok", `${label} status`);
        assert.equal(shown.row.result?.render, "katex", `${label} render`);
      }
      if (shown.live?.latexSource === "vlm" && verified) {
        assert.ok(shown.row, `${label} surviving caller missing tier`);
      }
      cover[useIdb ? "idb" : "memory"] += 1;
      cover[cross ? "cross" : "same"] += 1;
      cover[skew === 0 ? "ms" : skew === 1 ? "plus" : "minus"] += 1;
      cover[staleWho === 0 ? "staleFirst" : "staleSecond"] += 1;
      cover[swap ? "swap" : "natural"] += 1;
    } catch (err) {
      console.error(`mm-tier pair failed seed=${seed} idb=${useIdb} cross=${cross} skew=${skew} staleWho=${staleWho} swap=${swap}`);
      throw err;
    }
  }
  for (const [key, count] of Object.entries(cover)) {
    assert.ok(count > 0, key);
  }
  assert.ok(paired > 100, `paired decisions ${paired}`);
});

const CHAIN_LATEX = ["x+y", "y+x", "x+y+x"];

function cloningFormulaSend(store) {
  return async (message) => {
    const req = structuredClone(message);
    const res = await handleFormulaCacheMessage(req, store);
    return res == null ? null : structuredClone(res);
  };
}

function chainRecord(latex, extra) {
  return verifiedTierRecord(latex, extra);
}

test("three writers restore the live verified latex in both rollback orders", async () => {
  const other = await import("../lib/formula-cache.js?realm=chain");
  const cases = [];
  for (const backend of ["memory", "idb", "message"]) {
    for (const rollbackOrder of [[1, 2], [2, 1]]) {
      cases.push({ backend, rollbackOrder, cross: false });
    }
  }
  cases.push({ backend: "memory", rollbackOrder: [1, 2], cross: true });
  cases.push({ backend: "idb", rollbackOrder: [2, 1], cross: true });
  cases.push({ backend: "message", rollbackOrder: [1, 2], cross: true });
  for (const item of cases) {
    const label = `${item.backend} ${item.rollbackOrder.join(">")}${item.cross ? " cross" : ""}`;
    await runThreeWriters({
      ...item,
      createOther: other.createFormulaCache,
      label
    });
  }
});

async function runThreeWriters({ backend, rollbackOrder, cross, createOther, label }) {
  const real = backend === "memory"
    ? createMemoryStore()
    : createIdbFormulaStore({ indexedDB: new IDBFactory() });
  const settings = settingsFor("openai");
  const docHash = `doc-trio-${label.replace(/\W+/g, "-")}`;
  let reads = 0;
  let releaseReads;
  const threeReads = new Promise((resolve) => {
    releaseReads = resolve;
  });
  let openReads;
  const readsHold = new Promise((resolve) => {
    openReads = resolve;
  });
  const seenRead = [false, false, false];
  let arrived = 0;
  let releaseArrived;
  const allArrived = new Promise((resolve) => {
    releaseArrived = resolve;
  });
  const commitTurn = [0, 1, 2].map(() => {
    let go;
    const gate = new Promise((resolve) => {
      go = resolve;
    });
    return { gate, go };
  });
  let committed = 0;
  let releaseCommitted;
  const allCommitted = new Promise((resolve) => {
    releaseCommitted = resolve;
  });
  const rollbackTurn = [0, 1, 2].map(() => {
    let go;
    const gate = new Promise((resolve) => {
      go = resolve;
    });
    return { gate, go };
  });
  const writeIds = [null, null, null];
  let tierKey = "";
  const stale = [false, false, false];
  const sw = {
    async getTier(key) {
      return real.getTier(key);
    },
    async commitTier(key, record) {
      const index = CHAIN_LATEX.indexOf(record?.result?.latex);
      assert.ok(index >= 0, `${label} latex`);
      tierKey = key;
      arrived += 1;
      if (arrived === 3) releaseArrived();
      await allArrived;
      await commitTurn[index].gate;
      const ok = await real.commitTier(key, record);
      if (ok) writeIds[index] = record.writeId;
      committed += 1;
      if (committed === 3) releaseCommitted();
      if (index < 2) commitTurn[index + 1].go();
      return ok;
    },
    async rollbackTier(key, writeId, displaced) {
      return real.rollbackTier(key, writeId, displaced);
    },
    async deleteTier(key, writeId) {
      return real.deleteTier(key, writeId);
    },
    async getDecision(key) {
      return real.getDecision(key);
    },
    async putDecision(key, record) {
      return real.putDecision(key, record);
    }
  };
  const surface = backend === "message"
    ? createMessageFormulaStore(cloningFormulaSend(sw))
    : sw;
  function face(index) {
    const factory = cross && index !== 0 ? createOther : createFormulaCache;
    const store = {
      async getTier(key) {
        if (!seenRead[index]) {
          seenRead[index] = true;
          reads += 1;
          if (reads === 3) releaseReads();
          await readsHold;
        }
        return surface.getTier(key);
      },
      async commitTier(key, record) {
        return surface.commitTier(key, record);
      },
      async rollbackTier(key, writeId, displaced) {
        return surface.rollbackTier(key, writeId, displaced);
      },
      async deleteTier(key, writeId) {
        return surface.deleteTier(key, writeId);
      },
      async getDecision(key) {
        if (index !== 0) {
          await allCommitted;
          await rollbackTurn[index].gate;
          stale[index] = true;
        }
        return surface.getDecision(key);
      },
      async putDecision(key, record) {
        return surface.putDecision(key, record);
      }
    };
    return factory(store, { now: () => 1000, gate: createCallGate() });
  }
  const caches = [0, 1, 2].map((index) => face(index));
  const call = (index) => scheduleFormulaBlock(formulaBlock({ bid: "trio", text: "x+y" }), {
    ...formulaChainFlags(settings),
    docHash,
    settings,
    readSettings: () => settings,
    katex,
    cache: caches[index],
    model: "m",
    isStale: () => stale[index],
    cropPngFor: async () => ({ mime: "image/png", base64: "trio", w: 1, h: 1, hash: "trio" }),
    sendVision: async () => ({ ok: true, text: CHAIN_LATEX[index] }),
    withRasterCrop: async (item) => ({ ...item, imageUrl: PNG_URL, surface: "png" })
  });
  const jobs = [];
  jobs[0] = call(0);
  for (let i = 0; i < 60 && reads < 1; i += 1) await Promise.resolve();
  assert.equal(reads, 1, `${label} first read`);
  jobs[1] = call(1);
  for (let i = 0; i < 60 && reads < 2; i += 1) await Promise.resolve();
  assert.equal(reads, 2, `${label} second read`);
  jobs[2] = call(2);
  for (let i = 0; i < 60 && reads < 3; i += 1) await Promise.resolve();
  assert.equal(reads, 3, `${label} third read`);
  openReads();
  for (let i = 0; i < 80 && arrived < 3; i += 1) await Promise.resolve();
  assert.equal(arrived, 3, `${label} commits arrived`);
  commitTurn[0].go();
  await allCommitted;
  assert.equal(writeIds[0] != null && writeIds[1] != null && writeIds[2] != null, true, `${label} all stored`);
  const midway = [];
  for (const index of rollbackOrder) {
    rollbackTurn[index].go();
    await jobs[index];
    const row = await real.getTier(tierKey);
    midway.push(row?.result?.latex ?? null);
  }
  const live = await jobs[0];
  const row = await real.getTier(tierKey);
  const decision = await real.getDecision(`${docHash}:trio`);
  const expectedMid = rollbackOrder[0] === 1
    ? [CHAIN_LATEX[2], CHAIN_LATEX[0]]
    : [CHAIN_LATEX[1], CHAIN_LATEX[0]];
  assert.deepEqual(midway, expectedMid, `${label} midway`);
  assert.equal(live.latexSource, "vlm", `${label} live`);
  assert.equal(row?.result?.latex, CHAIN_LATEX[0], `${label} tier`);
  assert.equal(row?.writeId, writeIds[0], `${label} write id`);
  assert.equal(decision?.decision?.chosen?.latex, CHAIN_LATEX[0], `${label} decision`);
  assert.notEqual(row?.result?.latex, CHAIN_LATEX[1], `${label} not the middle row`);
}

test("two stale writers do not resurrect the one who already rolled back", async () => {
  async function both(real, label) {
    const key = `doc:both-stale:${label}`;
    const first = chainRecord("x+y", { writeId: "a:1", decidedAt: 1000 });
    const second = chainRecord("y+x", { writeId: "b:1", decidedAt: 1000 });
    assert.equal(await real.commitTier(key, first), true, label);
    assert.equal(await real.commitTier(key, second), true, label);
    assert.equal(await real.rollbackTier(key, "a:1", first), true, `${label} splice`);
    assert.equal((await real.getTier(key))?.writeId, "b:1", `${label} current stays`);
    assert.equal(await real.rollbackTier(key, "b:1", second), true, `${label} current`);
    assert.equal(await real.getTier(key), null, `${label} nobody left`);

    const third = chainRecord("x+y", { writeId: "a:2", decidedAt: 1000 });
    const fourth = chainRecord("y+x", { writeId: "b:2", decidedAt: 1000 });
    assert.equal(await real.commitTier(key, third), true, label);
    assert.equal(await real.commitTier(key, fourth), true, label);
    assert.equal(await real.rollbackTier(key, "b:2", fourth), true, `${label} restore`);
    assert.equal((await real.getTier(key))?.writeId, "a:2", `${label} restored`);
    assert.equal(await real.rollbackTier(key, "a:2", third), true, `${label} follow`);
    assert.equal(await real.getTier(key), null, `${label} other order`);
  }
  await both(createMemoryStore(), "memory");
  await both(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
  const memory = createMemoryStore();
  await both(createMessageFormulaStore(cloningFormulaSend(memory)), "message");
});

test("a legacy verified row without writeId is restored when the replacement rolls back", async () => {
  async function legacy(real, label) {
    const key = `doc:legacy-chain:${label}`;
    const row = chainRecord("x+y", { decidedAt: 1000 });
    delete row.writeId;
    const next = chainRecord("y+x", { writeId: "w:1", decidedAt: 1001 });
    assert.equal(await real.commitTier(key, row), true, label);
    assert.equal(await real.commitTier(key, next), true, label);
    assert.equal(next.displacedTier?.result?.latex, "x+y", label);
    assert.equal(next.displacedTier?.writeId ?? null, null, label);
    assert.equal(await real.rollbackTier(key, "w:1", next.displacedTier), true, label);
    const restored = await real.getTier(key);
    assert.equal(restored?.result?.latex, "x+y", label);
    assert.equal(restored?.writeId ?? null, null, label);
  }
  await legacy(createMemoryStore(), "memory");
  await legacy(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
  const memory = createMemoryStore();
  await legacy(createMessageFormulaStore(cloningFormulaSend(memory)), "message");
});

test("a chain longer than the cap is not stored and the current row stays", async () => {
  async function cap(real, label) {
    const key = `doc:cap:${label}`;
    const first = chainRecord("x+y", { writeId: "w:1", decidedAt: 1000 });
    first.prev = [{ writeId: "fake", result: { status: "ok", render: "katex", latex: "nope", tier: "multimodal" } }];
    assert.equal(await real.commitTier(key, first), true, label);
    assert.equal((await real.getTier(key))?.prev, undefined, `${label} client prev`);
    let current = "w:1";
    for (let i = 2; i <= 9; i += 1) {
      const row = chainRecord(`y+x${i}`, { writeId: `w:${i}`, decidedAt: 1000 + i });
      assert.equal(await real.commitTier(key, row), true, `${label} ${i}`);
      current = row.writeId;
    }
    const stored = await real.getTier(key);
    assert.equal(stored?.writeId, current, label);
    assert.equal(stored?.prev?.length, 8, label);
    const overflow = chainRecord("x+y+x", { writeId: "w:10", decidedAt: 1020 });
    assert.equal(await real.commitTier(key, overflow), false, label);
    assert.equal(overflow.displacedTier ?? null, null, `${label} not displaced`);
    const after = await real.getTier(key);
    assert.equal(after?.writeId, current, `${label} stays`);
    assert.equal(after?.prev?.length, 8, `${label} chain stays`);
  }
  await cap(createMemoryStore(), "memory");
  await cap(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
});

test("a commit that goes stale inside commitTier passes the displaced row and restores it", async () => {
  async function interrupt(real, label) {
    const key = `doc:rs10:${label}`;
    let armed = false;
    let seen = null;
    const store = {
      async getTier(id) {
        return real.getTier(id);
      },
      async commitTier(id, record) {
        const ok = await real.commitTier(id, record);
        if (record?.result?.latex === "y+x") armed = true;
        return ok;
      },
      async rollbackTier(id, writeId, displaced) {
        seen = displaced;
        return real.rollbackTier(id, writeId, displaced);
      }
    };
    const cache = createFormulaCache(store, { now: () => 1000 });
    const verified = (latex) => ({
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex,
      meta: { version: "mm-1", epoch: 1 }
    });
    assert.equal(await cache.writeTier(key, verified("x+y"), {
      docHash: "doc",
      model: "m",
      stillCurrent: () => true
    }), true, label);
    assert.equal(await cache.writeTier(key, verified("y+x"), {
      docHash: "doc",
      model: "m",
      stillCurrent: () => !armed
    }), false, label);
    assert.equal(seen?.result?.latex, "x+y", `${label} displaced`);
    assert.equal((await real.getTier(key))?.result?.latex, "x+y", `${label} restored`);
  }
  await interrupt(createMemoryStore(), "memory");
  await interrupt(createIdbFormulaStore({ indexedDB: new IDBFactory() }), "idb");
});

test("a verified row committed during rollbackTier's read survives", async () => {
  const factory = new IDBFactory();
  const real = createIdbFormulaStore({ indexedDB: factory });
  const key = "doc:rollwin:multimodal:mm-1:m:crop";
  const older = chainRecord("x+y", { writeId: "a", decidedAt: 1000 });
  const current = chainRecord("y+x", { writeId: "b", decidedAt: 1001 });
  assert.equal(await real.commitTier(key, older), true);
  assert.equal(await real.commitTier(key, current), true);
  const seeded = await real.getTier(key);
  assert.equal(seeded?.writeId, "b");
  assert.equal(seeded?.prev?.[0]?.writeId, "a");
  const opener = factory.open(FORMULA_DB, 1);
  const dbB = await new Promise((resolve, reject) => {
    opener.onsuccess = () => resolve(opener.result);
    opener.onerror = () => reject(opener.error);
  });
  const probe = dbB.transaction("tierResults", "readonly");
  const proto = Object.getPrototypeOf(probe.objectStore("tierResults"));
  await new Promise((resolve) => {
    probe.oncomplete = resolve;
  });
  const newer = chainRecord("x+y+x", { writeId: "c", decidedAt: 2000 });
  newer.key = key;
  let armed = false;
  let landed;
  const original = proto.get;
  proto.get = function patchedGet(query) {
    const request = original.call(this, query);
    if (!armed && this.name === "tierResults" && query === key) {
      armed = true;
      request.addEventListener("success", () => {
        const tx = dbB.transaction("tierResults", "readwrite");
        tx.objectStore("tierResults").put(newer, key);
        landed = new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve(true);
          tx.onabort = () => reject(tx.error || new Error("b aborted"));
          tx.onerror = () => reject(tx.error || new Error("b failed"));
        });
      });
    }
    return request;
  };
  try {
    assert.equal(await real.rollbackTier(key, "b", current.displacedTier), true);
    assert.equal(armed, true);
    await landed;
    const row = await real.getTier(key);
    assert.equal(row?.result?.latex, "x+y+x");
    assert.equal(row?.writeId, "c");
    assert.equal(row?.decidedAt, 2000);
  } finally {
    proto.get = original;
    dbB.close();
  }
});

test("a store without rollbackTier does not delete on rollback", async () => {
  const real = createMemoryStore();
  let deleted = 0;
  let armed = false;
  const store = {
    async getTier(key) {
      return real.getTier(key);
    },
    async commitTier(key, record) {
      const ok = await real.commitTier(key, record);
      armed = true;
      return ok;
    },
    async deleteTier(key, writeId) {
      deleted += 1;
      return real.deleteTier(key, writeId);
    }
  };
  const cache = createFormulaCache(store, { now: () => 1000 });
  const key = "doc:noroll:multimodal:mm-1:m:crop";
  assert.equal(await cache.writeTier(key, {
    tier: "multimodal",
    status: "ok",
    render: "katex",
    latex: "x+y",
    meta: { version: "mm-1", epoch: 1 }
  }, {
    docHash: "doc",
    model: "m",
    stillCurrent: () => !armed
  }), false);
  assert.equal(deleted, 0);
  assert.equal((await real.getTier(key))?.result?.latex, "x+y");
});

test("rollback rejects a displaced row whose key does not match", async () => {
  const memory = createMemoryStore();
  const key = "doc:keycheck:a";
  const older = chainRecord("x+y", { writeId: "tab:1", decidedAt: 1000 });
  const newer = chainRecord("y+x", { writeId: "tab:2", decidedAt: 1001 });
  assert.equal(await memory.commitTier(key, older), true);
  assert.equal(await memory.commitTier(key, newer), true);
  const mismatched = await handleFormulaCacheMessage({
    action: "rollback",
    key,
    writeId: "tab:2",
    displaced: {
      key: "doc:other",
      writeId: "tab:1",
      result: { tier: "multimodal", status: "ok", render: "katex", latex: "x+y" }
    }
  }, memory);
  assert.equal(mismatched.rolled, false);
  assert.equal((await memory.getTier(key))?.writeId, "tab:2");
  const nested = await handleFormulaCacheMessage({
    action: "rollback",
    key,
    writeId: "tab:2",
    displaced: {
      key,
      writeId: "tab:1",
      prev: [{
        key: "doc:other",
        writeId: "tab:1",
        result: { tier: "multimodal", status: "ok", render: "katex", latex: "x+y" }
      }]
    }
  }, memory);
  assert.equal(nested.rolled, false);
  assert.equal((await memory.getTier(key))?.result?.latex, "y+x");
  assert.equal(await memory.rollbackTier(key, "tab:2", null), true);
  assert.equal((await memory.getTier(key))?.writeId, "tab:1");
});

function shuffleChain(rand, items) {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const swap = copy[i];
    copy[i] = copy[j];
    copy[j] = swap;
  }
  return copy;
}

function checkChainStep(row, remaining, decision, where) {
  if (!remaining.length) {
    assert.equal(row, null, where);
    assert.equal(decision, null, where);
    return;
  }
  const latest = remaining[remaining.length - 1];
  const older = remaining.slice(0, -1).reverse();
  assert.equal(row?.writeId, latest.writeId, where);
  assert.equal(row?.result?.latex, latest.latex, where);
  const prev = Array.isArray(row?.prev) ? row.prev : [];
  assert.equal(prev.length, older.length, `${where} depth`);
  for (let i = 0; i < older.length; i += 1) {
    assert.equal(prev[i]?.writeId, older[i].writeId, `${where} prev`);
    assert.equal(prev[i]?.result?.latex, older[i].latex, `${where} prev latex`);
  }
  const present = new Set([row.writeId, ...prev.map((entry) => entry?.writeId)]);
  for (const writer of remaining) {
    assert.equal(present.has(writer.writeId), true, `${where} lost ${writer.writeId}`);
  }
  if (!latest.stale) {
    assert.equal(decision, latest.latex, `${where} decision`);
    assert.equal(row.result.latex, decision, `${where} pair`);
  }
}

test("500 seeds keep a verified chain consistent for two to four writers", async () => {
  const formulas = ["x+y+z", "y+z+x", "z+x+y", "x+z+y"];
  const cover = {
    memory: 0,
    idb: 0,
    message: 0,
    same: 0,
    cross: 0,
    w2: 0,
    w3: 0,
    w4: 0,
    earliest: 0,
    later: 0,
    allStale: 0,
    skew0: 0,
    skew1: 0
  };
  let paired = 0;
  for (let seed = 1; seed <= 500; seed += 1) {
    const rand = mulberry32(seed);
    const n = 2 + (Math.floor(seed / 12) % 3);
    const backend = ["memory", "idb", "message"][seed % 3];
    const cross = Math.floor(seed / 3) % 2 === 1;
    const skew = Math.floor(seed / 6) % 2;
    const force = seed % 4;
    const identities = Array.from({ length: n }, (_, index) => index);
    let commitOrder;
    if (force === 0) commitOrder = [0, ...shuffleChain(rand, identities.filter((index) => index !== 0))];
    else if (force === 1) commitOrder = [...shuffleChain(rand, identities.filter((index) => index !== n - 1)), n - 1];
    else commitOrder = shuffleChain(rand, identities);
    const stale = new Set();
    if (force === 0) identities.forEach((index) => { if (index !== 0) stale.add(index); });
    else if (force === 1) identities.forEach((index) => { if (index !== n - 1) stale.add(index); });
    else if (force === 2) identities.forEach((index) => stale.add(index));
    else identities.forEach((index) => { if (rand() < 0.5) stale.add(index); });
    const rollbackOrder = shuffleChain(rand, [...stale]);
    const writers = identities.map((index) => ({
      index,
      latex: formulas[index],
      writeId: cross ? `r${index}:${index + 1}` : `same:${index + 1}`,
      decidedAt: 1000 + index * skew,
      stale: stale.has(index)
    }));
    const where = `seed=${seed} ${backend} n=${n} cross=${cross} skew=${skew}`;
    try {
      const real = backend === "memory"
        ? createMemoryStore()
        : createIdbFormulaStore({ indexedDB: new IDBFactory() });
      const store = backend === "message"
        ? createMessageFormulaStore(cloningFormulaSend(real))
        : real;
      const key = `doc:chain:${seed}`;
      const remaining = [];
      let decision = null;
      for (const index of commitOrder) {
        const writer = writers[index];
        const before = (await store.getTier(key))?.writeId ?? null;
        const ok = await store.commitTier(key, chainRecord(writer.latex, {
          writeId: writer.writeId,
          decidedAt: writer.decidedAt,
          docHash: "doc-chain"
        }));
        if (!ok) {
          assert.equal((await store.getTier(key))?.writeId ?? null, before, `${where} refused`);
        } else {
          remaining.push(writer);
          if (!writer.stale) decision = writer.latex;
        }
        checkChainStep(await store.getTier(key), remaining, decision, `${where} commit ${writer.writeId}`);
      }
      const committed = remaining.slice();
      for (const index of rollbackOrder) {
        const writer = writers[index];
        const at = remaining.findIndex((item) => item.writeId === writer.writeId);
        const rolled = await store.rollbackTier(key, writer.writeId, null);
        if (at >= 0) remaining.splice(at, 1);
        assert.equal(rolled, at >= 0, `${where} rollback ${writer.writeId}`);
        checkChainStep(await store.getTier(key), remaining, decision, `${where} rollback ${writer.writeId}`);
      }
      const row = await store.getTier(key);
      const survivors = remaining.filter((writer) => !writer.stale);
      if (!survivors.length) {
        assert.equal(row, null, `${where} final`);
        assert.equal(decision, null, `${where} final decision`);
      } else {
        const last = survivors[survivors.length - 1];
        assert.equal(row?.result?.latex, last.latex, `${where} final latex`);
        assert.equal(row?.writeId, last.writeId, `${where} final id`);
        assert.equal(decision, last.latex, `${where} final decision`);
        paired += 1;
        if (committed[0]?.writeId === last.writeId) cover.earliest += 1;
        if (committed.findIndex((writer) => writer.writeId === last.writeId) > 0) cover.later += 1;
      }
      if (!survivors.length) cover.allStale += 1;
      cover[backend] += 1;
      cover[cross ? "cross" : "same"] += 1;
      cover[`w${n}`] += 1;
      cover[skew === 0 ? "skew0" : "skew1"] += 1;
    } catch (err) {
      console.error(`mm-tier chain failed seed=${seed} backend=${backend} writers=${n} cross=${cross} skew=${skew} force=${force} commit=${commitOrder.join(",")} rollback=${rollbackOrder.join(",")} stale=${[...stale].join(",")}`);
      throw err;
    }
  }
  for (const [name, count] of Object.entries(cover)) {
    assert.ok(count > 0, name);
  }
  assert.ok(paired > 100, `paired decisions ${paired}`);
});

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
