import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { handleFormulaCacheMessage, createIdbFormulaStore } from "../background/formula-cache.js";
import {
  FORMULA_DB,
  createFormulaCache,
  createMemoryStore,
  decideFormulaCached,
  tierRecordKey
} from "../lib/formula-cache.js";
import { CHAIN_VERSION, tierResult } from "../lib/formula-contract.js";
import { formulaArxivSourceEnabled, setFormulaArxivSourceEnabled } from "../lib/formula-flags.js";
import { scheduleFormulaBlock } from "../lib/formula-schedule.js";
import { createDefaultTiers } from "../lib/formula-tiers/index.js";
import { cacheableLayout } from "../lib/pdf-layout-client.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function unit(extra = {}) {
  return {
    docHash: "doc-a",
    bid: "b1-p1-formulaabc1234",
    page: 1,
    bbox: [0.1, 0.2, 0.4, 0.28],
    display: true,
    pdfText: "α",
    glyphs: [],
    equationNumber: null,
    crop: {
      pixelSize: { width: 40, height: 20 },
      cssSize: { width: 20, height: 10 },
      dpr: 1,
      url: "data:image/png;base64,ok"
    },
    ...extra
  };
}

function provider(id, version, run) {
  return {
    id,
    version,
    kind: "candidate",
    available() {
      return true;
    },
    unavailableReason() {
      return "not-configured";
    },
    run
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function installFormulaIdb() {
  const names = new Set();
  const tables = new Map();
  let opens = 0;
  const table = (dbName, storeName) => {
    if (!tables.has(dbName)) tables.set(dbName, new Map());
    const dbTables = tables.get(dbName);
    if (!dbTables.has(storeName)) dbTables.set(storeName, new Map());
    return dbTables.get(storeName);
  };
  const indexedDB = {
    databases() {
      return Promise.resolve([...names].map((name) => ({ name, version: 1 })));
    },
    open(name) {
      opens += 1;
      const request = {};
      const storeNames = new Set(tables.get(name)?.keys() || []);
      const db = {
        objectStoreNames: {
          contains(storeName) {
            return storeNames.has(storeName);
          }
        },
        createObjectStore(storeName) {
          storeNames.add(storeName);
          table(name, storeName);
          return { createIndex() {} };
        },
        transaction(storeName) {
          const bucket = table(name, storeName);
          const store = {
            get(key) {
              const req = { result: bucket.has(key) ? bucket.get(key) : undefined };
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
            put(value, key) {
              bucket.set(key, value);
              const req = { result: key };
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
            delete(key) {
              bucket.delete(key);
              const req = { result: undefined };
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
            getAll() {
              const req = { result: [...bucket.values()] };
              queueMicrotask(() => req.onsuccess?.());
              return req;
            },
            index() {
              return {
                getAll(docHash) {
                  const req = {
                    result: [...bucket.values()].filter((row) => row?.docHash === docHash)
                  };
                  queueMicrotask(() => req.onsuccess?.());
                  return req;
                }
              };
            }
          };
          return { objectStore() { return store; } };
        },
        close() {}
      };
      queueMicrotask(() => {
        const fresh = !names.has(name);
        names.add(name);
        request.result = db;
        if (fresh) request.onupgradeneeded?.({ oldVersion: 0 });
        request.onsuccess?.();
      });
      return request;
    }
  };
  return { indexedDB, opens: () => opens, names };
}

test("F3-18 tier cache hits, misses, and clearDoc", async () => {
  let calls = 0;
  const tier = provider("multimodal", "v1", async () => {
    calls += 1;
    await delay(15);
    return tierResult({
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex: "x",
      confidence: 1,
      image: { url: "data:image/png;base64,aaaa", surface: "png" }
    });
  });
  const store = createMemoryStore();
  const cache = createFormulaCache(store);
  const sample = unit();
  const ctx = {
    cache,
    model: "m1",
    tiers: { ...createDefaultTiers(), multimodal: tier }
  };
  await decideFormulaCached(sample, ctx);
  await decideFormulaCached(sample, ctx);
  assert.equal(calls, 1);
  const key = tierRecordKey(sample, tier, "m1");
  const row = await store.getTier(key);
  assert.equal(row.chainVersion, CHAIN_VERSION);
  assert.equal(row.result.image.url, undefined);
  assert.equal(row.result.latex, "x");

  tier.version = "v2";
  await decideFormulaCached(sample, ctx);
  assert.equal(calls, 2);

  await decideFormulaCached(sample, { ...ctx, model: "m2" });
  assert.equal(calls, 3);

  await decideFormulaCached(unit({ bbox: [0.1, 0.2, 0.9, 0.8] }), ctx);
  assert.equal(calls, 4);

  const staleKey = tierRecordKey(sample, { id: "multimodal", version: "v2" }, "m1");
  await store.putTier(staleKey, {
    ...(await store.getTier(staleKey)),
    chainVersion: "not-this-chain"
  });
  await decideFormulaCached(sample, ctx);
  assert.equal(calls, 5);

  const other = unit({ docHash: "doc-b", bid: "b2" });
  await decideFormulaCached(other, ctx);
  assert.equal(calls, 6);
  const otherKey = tierRecordKey(other, tier, "m1");
  await store.clearDoc("doc-a");
  assert.equal(await store.getTier(tierRecordKey(sample, tier, "m1")), null);
  assert.ok(await store.getTier(otherKey));
  await decideFormulaCached(sample, ctx);
  assert.equal(calls, 7);
  await decideFormulaCached(other, ctx);
  assert.equal(calls, 7);

  const limited = createMemoryStore({ docLimit: 2, byteLimit: 50 * 1024 * 1024 });
  let clock = 1;
  const limitedCache = createFormulaCache(limited, { now: () => clock });
  for (const bid of ["a", "b", "c"]) {
    clock += 1;
    await limitedCache.writeTier(`doc-a:k-${bid}`, tierResult({
      tier: "ocr",
      status: "ok",
      render: "katex",
      latex: bid
    }), { docHash: "doc-a" });
  }
  assert.equal(await limited.getTier("doc-a:k-a"), null);
  assert.ok(await limited.getTier("doc-a:k-c"));
});

test("F3-18 IndexedDB oi-formula is created only when a candidate result is stored", async () => {
  const fake = installFormulaIdb();
  const store = createIdbFormulaStore({ indexedDB: fake.indexedDB, docLimit: 2 });
  assert.equal(await store.getTier("missing"), null);
  assert.equal(await store.getDecision("missing"), null);
  assert.equal(fake.opens(), 0);
  assert.equal(fake.names.has(FORMULA_DB), false);
  assert.equal(await store.putTier("crop-key", {
    tier: "crop",
    docHash: "doc-a",
    decidedAt: 1,
    result: tierResult({ tier: "crop", status: "ok", render: "image" })
  }), false);
  assert.equal(fake.opens(), 0);

  const quiet = await handleFormulaCacheMessage({
    type: "OI_FORMULA_CACHE",
    action: "put",
    key: "self-key",
    value: { tier: "self", docHash: "doc-a", result: { tier: "self", status: "ok" } }
  }, store);
  assert.equal(quiet.stored, false);
  assert.equal(fake.names.has(FORMULA_DB), false);

  const sample = unit();
  let crops = 0;
  await scheduleFormulaBlock({
    label: "formula",
    id: "f",
    bid: sample.bid,
    bbox: sample.bbox,
    text: "softmax(QK^T)",
    display: true
  }, {
    cache: createFormulaCache(store),
    docHash: sample.docHash,
    page: 1,
    arxivEnabled: false,
    withRasterCrop: async (block) => {
      crops += 1;
      return { ...block, imageUrl: "data:image/png;base64,abc", surface: "redraw" };
    }
  });
  assert.equal(crops, 1);
  assert.equal(fake.opens(), 0);

  const saved = await handleFormulaCacheMessage({
    action: "put",
    key: "mm-1",
    value: {
      tier: "multimodal",
      docHash: "doc-a",
      decidedAt: 1,
      chainVersion: CHAIN_VERSION,
      result: tierResult({
        tier: "multimodal",
        status: "ok",
        render: "katex",
        latex: "y",
        image: { url: "data:image/png;base64,bbbb", surface: "png" }
      })
    }
  }, store);
  assert.equal(saved.stored, true);
  assert.equal(fake.names.has(FORMULA_DB), true);
  const got = await handleFormulaCacheMessage({ action: "get", key: "mm-1" }, store);
  assert.equal(got.value.result.latex, "y");
  assert.equal(got.value.result.image.url, undefined);

  await store.putTier("mm-2", {
    tier: "multimodal",
    docHash: "doc-a",
    decidedAt: 2,
    result: tierResult({ tier: "multimodal", status: "ok", render: "katex", latex: "z" })
  });
  await store.putTier("ocr-b", {
    tier: "ocr",
    docHash: "doc-b",
    decidedAt: 3,
    result: tierResult({ tier: "ocr", status: "ok", render: "katex", latex: "w" })
  });
  await store.putDecision("doc-a:bid", {
    tier: "multimodal",
    docHash: "doc-a",
    decidedAt: 4,
    decision: { chosen: { tier: "multimodal", status: "ok", render: "katex" } }
  });
  await handleFormulaCacheMessage({ action: "clearDoc", docHash: "doc-a" }, store);
  assert.equal((await store.getTier("mm-1")), null);
  assert.equal((await store.getDecision("doc-a:bid")), null);
  assert.equal((await store.getTier("ocr-b")).result.latex, "w");
  await handleFormulaCacheMessage({ action: "clearAll" }, store);
  assert.equal(await store.getTier("ocr-b"), null);
  assert.equal(await handleFormulaCacheMessage({ action: "nope" }, store).then((res) => res.ok), false);
});

test("F3-19 one in-flight call per key, and abort or stale does not write or upgrade", async () => {
  let calls = 0;
  const tier = provider("multimodal", "v1", async () => {
    calls += 1;
    await delay(20);
    return tierResult({
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex: "x",
      confidence: 1
    });
  });
  const store = createMemoryStore();
  const cache = createFormulaCache(store);
  const tiers = { ...createDefaultTiers(), multimodal: tier };
  const sample = unit();
  await Promise.all([
    decideFormulaCached(sample, { cache, tiers, model: "m" }),
    decideFormulaCached(sample, { cache, tiers, model: "m" })
  ]);
  assert.equal(calls, 1);

  const abortUnit = unit({ bid: "abort-me" });
  const controller = new AbortController();
  let abortedCalls = 0;
  const aborting = provider("ocr", "v1", async () => {
    abortedCalls += 1;
    controller.abort();
    return tierResult({
      tier: "ocr",
      status: "ok",
      render: "katex",
      latex: "y",
      confidence: 1
    });
  });
  const abortStore = createMemoryStore();
  const abortCache = createFormulaCache(abortStore);
  await abortCache.loadTier(aborting, abortUnit, { model: "m" }, { signal: controller.signal });
  assert.equal(abortedCalls, 1);
  assert.equal(await abortStore.getTier(tierRecordKey(abortUnit, aborting, "m")), null);

  const already = new AbortController();
  already.abort();
  let upgrades = 0;
  await decideFormulaCached(unit({ bid: "already-aborted" }), {
    cache: createFormulaCache(createMemoryStore()),
    model: "m",
    tiers: { ...createDefaultTiers(), ocr: aborting },
    onUpgrade: () => {
      upgrades += 1;
    }
  }, { signal: already.signal });
  assert.equal(upgrades, 0);
  assert.equal(abortedCalls, 1);

  let stale = false;
  let staleCalls = 0;
  const staleTier = provider("multimodal", "v9", async () => {
    staleCalls += 1;
    stale = true;
    return tierResult({
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex: "z",
      confidence: 1
    });
  });
  const staleStore = createMemoryStore();
  const staleCache = createFormulaCache(staleStore);
  const staleUnit = unit({ bid: "stale-me" });
  await staleCache.loadTier(staleTier, staleUnit, { model: "m", isStale: () => stale }, {});
  assert.equal(staleCalls, 1);
  assert.equal(await staleStore.getTier(tierRecordKey(staleUnit, staleTier, "m")), null);

  let earlyUpgrades = 0;
  await decideFormulaCached(unit({ bid: "early-stale" }), {
    cache: createFormulaCache(createMemoryStore()),
    isStale: () => true,
    onUpgrade: () => {
      earlyUpgrades += 1;
    }
  });
  assert.equal(earlyUpgrades, 0);
});

test("shared in-flight abort cancels only when every caller has aborted", async () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  let calls = 0;
  let sawAborted = false;
  let release;
  const hold = new Promise((resolve) => {
    release = resolve;
  });
  const tier = provider("multimodal", "vShare", async (_unit, _ctx, opts) => {
    calls += 1;
    await hold;
    sawAborted = opts?.signal?.aborted === true;
    if (opts?.signal?.aborted) {
      return tierResult({ tier: "multimodal", status: "reject", reason: "aborted", confidence: 0 });
    }
    return tierResult({
      tier: "multimodal",
      status: "ok",
      render: "katex",
      latex: "kept",
      confidence: 1
    });
  });
  const store = createMemoryStore();
  const cache = createFormulaCache(store);
  const sample = unit({ bid: "share-abort" });
  const first = new AbortController();
  const second = new AbortController();
  const firstRun = cache.loadTier(tier, sample, { model: "m" }, { signal: first.signal });
  await flush();
  const secondRun = cache.loadTier(tier, sample, { model: "m" }, { signal: second.signal });
  await flush();
  first.abort();
  release();
  const [left, right] = await Promise.all([firstRun, secondRun]);
  assert.equal(calls, 1);
  assert.equal(sawAborted, false);
  assert.equal(left.status, "ok");
  assert.equal(right.latex, "kept");
  assert.equal((await store.getTier(tierRecordKey(sample, tier, "m"))).result.latex, "kept");

  let bothCalls = 0;
  let bothAborted = false;
  let releaseBoth;
  const bothHold = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  const bothTier = provider("ocr", "vBoth", async (_unit, _ctx, opts) => {
    bothCalls += 1;
    await bothHold;
    bothAborted = opts?.signal?.aborted === true;
    return tierResult({
      tier: "ocr",
      status: bothAborted ? "reject" : "ok",
      reason: bothAborted ? "aborted" : null,
      render: bothAborted ? null : "katex",
      latex: bothAborted ? null : "nope",
      confidence: bothAborted ? 0 : 1
    });
  });
  const bothStore = createMemoryStore();
  const bothCache = createFormulaCache(bothStore);
  const bothUnit = unit({ bid: "both-abort" });
  const leftCtl = new AbortController();
  const rightCtl = new AbortController();
  const leftRun = bothCache.loadTier(bothTier, bothUnit, { model: "m" }, { signal: leftCtl.signal });
  await flush();
  const rightRun = bothCache.loadTier(bothTier, bothUnit, { model: "m" }, { signal: rightCtl.signal });
  await flush();
  leftCtl.abort();
  rightCtl.abort();
  releaseBoth();
  const both = await Promise.all([leftRun, rightRun]);
  assert.equal(bothCalls, 1);
  assert.equal(bothAborted, true);
  assert.equal(both[0].reason, "aborted");
  assert.equal(both[1].reason, "aborted");
  assert.equal(await bothStore.getTier(tierRecordKey(bothUnit, bothTier, "m")), null);
});

test("tier 0 viewer flag defaults off", () => {
  const before = formulaArxivSourceEnabled();
  try {
    setFormulaArxivSourceEnabled(false);
    assert.equal(formulaArxivSourceEnabled(), false);
    assert.equal(setFormulaArxivSourceEnabled(true), true);
    assert.equal(formulaArxivSourceEnabled(), true);
  } finally {
    setFormulaArxivSourceEnabled(before);
  }
});

test("F3-21 and F3-22 default formula scheduling keeps the crop and does not call out", async () => {
  const viewer = read("pdf/viewer.js");
  const chainFiles = [
    "lib/formula-schedule.js",
    "lib/formula-cache.js",
    "lib/formula-flags.js",
    "background/formula-cache.js"
  ];
  for (const file of chainFiles) {
    const src = read(file);
    assert.equal(src.includes("arxiv.org"), false, file);
    assert.equal(/\bfetch\s*\(/.test(src), false, file);
  }
  const wired = viewer.slice(
    viewer.indexOf("async function readCachedArxivAlignment"),
    viewer.indexOf("function cropImage")
  );
  assert.match(wired, /action:\s*"read-alignment"/);
  assert.match(wired, /formulaArxivSourceEnabled\(\)/);
  assert.match(wired, /arxivOn \? detectArxivId/);
  assert.match(wired, /block\?\.label !== "formula"/);
  assert.match(wired, /scheduleFormulaBlock/);
  assert.match(wired, /withRasterCrop/);
  assert.doesNotMatch(wired, /arxivEnabled:\s*true/);
  assert.doesNotMatch(wired, /arxiv\.org/);
  assert.doesNotMatch(wired, /\bfetch\s*\(/);
  assert.doesNotMatch(wired, /katex\.render|renderLatexInto|renderLatexMarkup/);
  const sw = read("background/service-worker.js");
  assert.match(sw, /import \{ handleFormulaCacheMessage \} from "\.\/formula-cache\.js";/);
  assert.match(sw, /case "OI_FORMULA_CACHE":/);
  assert.match(sw, /return handleFormulaCacheMessage\(message\);/);
  assert.equal(sw.includes("handleArxivSourceMessage.formula"), false);
  assert.equal(/\bimport\s*\(/.test(sw), false);
  assert.equal(read("background/arxiv-source.js").includes("formula-cache"), false);

  let reads = 0;
  let crops = 0;
  const block = {
    label: "formula",
    id: "f1",
    bid: "b1",
    bbox: [0.2, 0.3, 0.5, 0.4],
    layoutBbox: [0.2, 0.3, 0.5, 0.42],
    text: "softmax(QK^T / sqrt(d_k))",
    display: true
  };
  const shown = await scheduleFormulaBlock(block, {
    arxivEnabled: false,
    docHash: "doc",
    page: 3,
    readAlignment: async () => {
      reads += 1;
      return { formulas: [] };
    },
    withRasterCrop: async (item) => {
      crops += 1;
      return {
        ...item,
        bbox: [0.21, 0.31, 0.49, 0.39],
        imageUrl: "data:image/png;base64,abc",
        surface: "redraw"
      };
    }
  });
  assert.equal(reads, 0);
  assert.equal(crops, 1);
  assert.equal(shown.imageUrl, "data:image/png;base64,abc");
  assert.equal(shown.surface, "redraw");
  assert.deepEqual(shown.bbox, [0.21, 0.31, 0.49, 0.39]);
  assert.deepEqual(shown.layoutBbox, block.layoutBbox);
  assert.equal(shown.formulaTier, "crop");
  assert.equal(block.imageUrl, undefined);

  const relation = await scheduleFormulaBlock({
    ...block,
    bid: "b2",
    text: "N = 6"
  }, {
    arxivEnabled: false,
    withRasterCrop: async (item) => ({
      ...item,
      imageUrl: "data:image/png;base64,rel",
      surface: "png"
    })
  });
  assert.equal(relation.imageUrl, "data:image/png;base64,rel");
  assert.equal(relation.surface, "png");
  assert.equal(relation.formulaTier, "crop");

  let flagged = 0;
  const flaggedShown = await scheduleFormulaBlock(block, {
    arxivEnabled: true,
    arxivId: "1706.03762",
    readAlignment: async () => {
      flagged += 1;
      return null;
    },
    withRasterCrop: async (item) => ({
      ...item,
      imageUrl: "data:image/png;base64,abc",
      surface: "png"
    })
  });
  assert.equal(flagged, 1);
  assert.equal(flaggedShown.imageUrl, "data:image/png;base64,abc");
  assert.equal(flaggedShown.formulaTier, "crop");
});

test("viewer does not write formulas with innerHTML", () => {
  const viewer = read("pdf/viewer.js");
  assert.equal(viewer.includes("innerHTML"), false);
  assert.equal(viewer.includes("insertAdjacentHTML"), false);
  assert.equal(viewer.includes("outerHTML"), false);
  assert.equal(viewer.includes("renderLatexMarkup"), false);
  assert.match(viewer, /function renderFormulaNode/);
  assert.match(viewer, /只用于非回退链展示/);
  assert.match(viewer, /data-oi-tier/);
  const stored = cacheableLayout({
    page: 1,
    blocks: [{ id: "f", label: "formula", formulaTier: "crop", imageUrl: "data:image/png;base64,aa" }]
  });
  assert.equal(stored.blocks[0].formulaTier, undefined);
  assert.equal(stored.blocks[0].imageUrl, undefined);
});

test("F3-23 D0 sentences replaced the old formula wording", () => {
  const readme = read("README.md");
  const readmeEn = read("README.en.md");
  const contrib = read("CONTRIBUTING.md");
  const sentence = "公式可来自核对过的 LaTeX（KaTeX）渲染，判不出时显示原页裁图";
  assert.equal(readme.includes(sentence), true);
  assert.equal(contrib.includes(sentence), true);
  assert.match(readmeEn, /formulas may be rendered from verified LaTeX \(KaTeX\); when that cannot be decided, the original-page crop is shown/i);
  assert.equal(readme.includes("公式画面不来自 LaTeX 渲染"), false);
  assert.equal(contrib.includes("画面不来自 LaTeX 渲染"), false);
  assert.equal(/formula images do not come from LaTeX/i.test(readmeEn), false);
  assert.match(read("lib/features.js"), /公式可来自核对过的 LaTeX（KaTeX）渲染，判不出时显示原页裁图/);
});

test("F3-25 new formula files do not reference sealed inputs", () => {
  const needles = ["held-" + "out", "prelabel-" + "judgments.json", "sealed " + "corpus"];
  const files = [
    "lib/formula-flags.js",
    "lib/formula-cache.js",
    "lib/formula-schedule.js",
    "lib/formula-katex.js",
    "background/formula-cache.js",
    "pdf/viewer.js",
    "background/service-worker.js",
    "tests/formula-viewer.test.mjs"
  ];
  for (const file of files) {
    const src = read(file);
    for (const needle of needles) {
      assert.equal(src.includes(needle), false, `${file} ${needle}`);
    }
  }
});
