import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { glyphUncheckable, verifyCandidate } from "../lib/formula-arbiter.js";
import { decideFormula } from "../lib/formula-chain.js";
import {
  CHAIN_VERSION,
  REASONS,
  STATUSES,
  TIER_ORDER,
  contractViolations,
  cropHashOf,
  tierCacheKey,
  tierResult,
  unitKeyOf
} from "../lib/formula-contract.js";
import { canRenderLatex, renderLatexInto, renderLatexMarkup } from "../lib/formula-katex.js";
import { judgeCrop } from "../lib/formula-tiers/crop.js";
import { createDefaultTiers } from "../lib/formula-tiers/index.js";
import { loadKatex } from "./helpers/arxiv-paper.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const katex = loadKatex();

function solidImage(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  data.fill(255);
  if (paint) paint(data, width, height);
  else {
    data[0] = 0;
    data[1] = 0;
    data[2] = 0;
  }
  return { width, height, data };
}

function goodCrop(extra = {}) {
  return {
    pixelSize: { width: 40, height: 20 },
    cssSize: { width: 20, height: 10 },
    dpr: 1,
    image: solidImage(40, 20),
    url: "data:image/png;base64,ok",
    ...extra
  };
}

function blurryCrop() {
  return goodCrop({
    pixelSize: { width: 10, height: 10 },
    cssSize: { width: 20, height: 20 },
    dpr: 2,
    image: solidImage(10, 10)
  });
}

function unit(extra = {}) {
  return {
    docHash: "doc",
    bid: "b1-p3-formulaabc1234",
    page: 3,
    bbox: [0.1, 0.2, 0.4, 0.28],
    display: extra.display ?? true,
    pdfText: "",
    glyphs: [],
    equationNumber: null,
    crop: goodCrop(),
    ...extra
  };
}

function baseTiers(overrides = {}) {
  return { ...createDefaultTiers(), ...overrides };
}

function spyTiers(tiers, counts) {
  const wrapped = {};
  for (const [id, tier] of Object.entries(tiers)) {
    wrapped[id] = {
      ...tier,
      available(ctx) {
        return tier.available(ctx);
      },
      async run(value, ctx, opts) {
        counts[id] = (counts[id] || 0) + 1;
        return tier.run(value, ctx, opts);
      }
    };
  }
  return wrapped;
}

function count(counts, id) {
  return counts[id] || 0;
}

function candidate(id, body, { available = true, reason = "not-configured" } = {}) {
  return {
    id,
    version: "fake",
    kind: "candidate",
    available() {
      return available;
    },
    unavailableReason() {
      return reason;
    },
    async run(value, ctx, opts) {
      return body(value, ctx, opts);
    }
  };
}

function providerOk(id, latex) {
  return candidate(id, async () => tierResult({
    tier: id,
    status: "ok",
    render: "katex",
    latex,
    confidence: null
  }));
}

test("F3-01 visit order is arXiv, multimodal, OCR, self, vector, crop, placeholder", async () => {
  for (const display of [true, false]) {
    const calls = [];
    const fake = (id, kind, available, body) => ({
      id,
      version: "fake",
      kind,
      available() {
        calls.push(`${id}:available`);
        return available;
      },
      async run() {
        calls.push(`${id}:run`);
        return body();
      }
    });
    const tiers = {
      arxiv: fake("arxiv", "source", true, () => tierResult({ tier: "arxiv", status: "reject", reason: "no-source", confidence: 0 })),
      multimodal: fake("multimodal", "candidate", true, () => tierResult({ tier: "multimodal", status: "skip", reason: "not-configured" })),
      ocr: fake("ocr", "candidate", true, () => tierResult({ tier: "ocr", status: "skip", reason: "not-configured" })),
      self: fake("self", "fallback", true, () => tierResult({ tier: "self", status: "reject", reason: "not-located", confidence: 0 })),
      vector: fake("vector", "fallback", true, () => tierResult({ tier: "vector", status: "skip", reason: "not-implemented" })),
      crop: fake("crop", "fallback", true, () => tierResult({
        tier: "crop",
        status: "reject",
        render: "image",
        reason: "crop-blurry",
        image: { url: "blob:crop", surface: "png", pixelSize: { width: 1, height: 1 } }
      })),
      placeholder: fake("placeholder", "terminal", true, () => tierResult({
        tier: "placeholder",
        status: "ok",
        render: "placeholder",
        confidence: null,
        meta: { page: 3, bbox: [0, 0, 1, 1] }
      }))
    };
    const decision = await decideFormula(unit({ display }), {
      katex,
      tiers,
      flags: { arxivEnabled: true, placeholderEnabled: true }
    });
    assert.deepEqual(calls.filter((item) => item.endsWith(":run")).map((item) => item.split(":")[0]), [...TIER_ORDER]);
    assert.deepEqual(decision.trace.map((item) => item.tier), [...TIER_ORDER]);
    assert.equal(decision.chosen.tier, "placeholder");
    assert.equal(decision.forcedCrop, false);
  }
});

test("F3-02 arXiv success stops the chain and skips arbitration", async () => {
  let arbitrated = 0;
  const counts = {};
  const tiers = spyTiers(baseTiers({
    arxiv: {
      ...createDefaultTiers().arxiv,
      async run() {
        return tierResult({
          tier: "arxiv",
          status: "ok",
          render: "katex",
          latex: "x",
          confidence: 1
        });
      }
    }
  }), counts);
  const decision = await decideFormula(unit(), {
    katex,
    tiers,
    flags: { arxivEnabled: true, placeholderEnabled: true },
    pixelJudge: async () => {
      arbitrated += 1;
      return { decided: false };
    },
    readAlignment: async () => {
      throw new Error("alignment should be read inside the tier, not by later tiers");
    }
  });
  assert.equal(decision.chosen.tier, "arxiv");
  assert.equal(decision.chosen.render, "katex");
  assert.equal(decision.forcedCrop, false);
  assert.equal(arbitrated, 0);
  for (const id of ["multimodal", "ocr", "self", "vector", "crop", "placeholder"]) {
    assert.equal(count(counts, id), 0, id);
  }
});

test("F3-03 no candidates walks self, vector skip, then crop", async () => {
  const counts = {};
  let reads = 0;
  const tiers = spyTiers(createDefaultTiers(), counts);
  const decision = await decideFormula(unit({ pdfText: "Attention" }), {
    katex,
    tiers,
    readAlignment: async () => {
      reads += 1;
      return null;
    }
  });
  assert.equal(reads, 0);
  assert.equal(count(counts, "arxiv"), 0);
  assert.equal(count(counts, "multimodal"), 0);
  assert.equal(count(counts, "ocr"), 0);
  assert.equal(count(counts, "self"), 1);
  assert.equal(count(counts, "vector"), 1);
  assert.equal(count(counts, "crop"), 1);
  const trace = decision.trace;
  assert.equal(trace.find((item) => item.tier === "multimodal").reason, "not-configured");
  assert.equal(trace.find((item) => item.tier === "ocr").reason, "not-configured");
  assert.equal(trace.find((item) => item.tier === "self").status, "reject");
  const vector = trace.find((item) => item.tier === "vector");
  assert.equal(vector.status, "skip");
  assert.equal(vector.reason, "not-implemented");
  assert.equal(decision.chosen.tier, "crop");
  assert.equal(decision.chosen.render, "image");
  assert.equal(decision.forcedCrop, false);
  const order = trace.map((item) => item.tier);
  assert.deepEqual(order, ["arxiv", "multimodal", "ocr", "self", "vector", "crop"]);
});

test("plaintext relation is the self tier and stops before vector", async () => {
  const counts = {};
  const tiers = spyTiers(createDefaultTiers(), counts);
  const decision = await decideFormula(unit({ pdfText: "N = 6", display: false }), { katex, tiers });
  assert.equal(decision.chosen.tier, "self");
  assert.equal(decision.chosen.render, "unicode");
  assert.equal(decision.chosen.text, "N = 6");
  assert.equal(decision.chosen.confidence, 1);
  assert.equal(count(counts, "vector"), 0);
  assert.equal(count(counts, "crop"), 0);
  const dropped = await decideFormula(unit({ pdfText: "d_k = 64" }), { katex, tiers: spyTiers(createDefaultTiers(), {}) });
  assert.equal(dropped.chosen.tier, "crop");
});

test("F3-04 one multimodal provider that fails the check goes straight to crop", async () => {
  const counts = {};
  const tiers = spyTiers(baseTiers({
    multimodal: providerOk("multimodal", "\\beta")
  }), counts);
  const decision = await decideFormula(unit({ pdfText: "α" }), { katex, tiers });
  assert.equal(decision.forcedCrop, true);
  assert.equal(decision.forcedReason, "single-provider-reject");
  assert.equal(decision.chosen.tier, "crop");
  assert.equal(decision.chosen.render, "image");
  assert.equal(count(counts, "self"), 0);
  assert.equal(count(counts, "vector"), 0);
  assert.equal(decision.trace.find((item) => item.tier === "multimodal").reason, "charset-mismatch");
});

test("F3-05 one OCR provider that fails the check goes straight to crop", async () => {
  const counts = {};
  const tiers = spyTiers(baseTiers({
    ocr: providerOk("ocr", "\\beta")
  }), counts);
  const decision = await decideFormula(unit({ pdfText: "α" }), { katex, tiers });
  assert.equal(decision.forcedCrop, true);
  assert.equal(decision.forcedReason, "single-provider-reject");
  assert.equal(decision.chosen.tier, "crop");
  assert.equal(count(counts, "self"), 0);
  assert.equal(count(counts, "vector"), 0);
});

test("F3-06 a charset match that KaTeX rejects is forced to crop", async () => {
  const counts = {};
  const tiers = spyTiers(baseTiers({
    multimodal: providerOk("multimodal", "\\frac{1}{")
  }), counts);
  const decision = await decideFormula(unit({ pdfText: "1" }), { katex, tiers });
  assert.equal(decision.forcedCrop, true);
  assert.equal(decision.forcedReason, "katex-error");
  assert.equal(decision.chosen.tier, "crop");
  assert.equal(decision.trace.find((item) => item.tier === "multimodal").reason, "katex-error");
  assert.equal(count(counts, "self"), 0);
  assert.equal(count(counts, "vector"), 0);
});

test("unknown commands and uncheckable glyphs are single-provider rejects", async () => {
  const unknown = await decideFormula(unit({ pdfText: "1" }), {
    katex,
    tiers: baseTiers({ multimodal: providerOk("multimodal", "\\foo{1}") })
  });
  assert.equal(unknown.forcedReason, "single-provider-reject");
  assert.equal(unknown.trace.find((item) => item.tier === "multimodal").reason, "unknown-command");

  const hidden = await decideFormula(unit({
    pdfText: "x",
    glyphs: [{ ch: "\uE000", fontName: "AdvPi1" }]
  }), {
    katex,
    tiers: baseTiers({ multimodal: providerOk("multimodal", "x") })
  });
  assert.equal(hidden.trace.find((item) => item.tier === "multimodal").reason, "uncheckable-glyph");
  assert.equal(glyphUncheckable({ ch: "", fontName: "AdvFoo" }), true);
  assert.equal(glyphUncheckable({ ch: "x", fontName: "CMMI10" }), false);
});

test("F3-07 the text layer picks the only matching provider", async () => {
  const decision = await decideFormula(unit({ pdfText: "α" }), {
    katex,
    tiers: baseTiers({
      multimodal: providerOk("multimodal", "\\alpha"),
      ocr: providerOk("ocr", "\\beta")
    })
  });
  assert.equal(decision.chosen.tier, "multimodal");
  assert.equal(decision.chosen.latex, "\\alpha");
  assert.equal(decision.chosen.render, "katex");
  assert.equal(decision.forcedCrop, false);
  assert.equal(decision.chosen.checks.charset.pass, true);
});

test("both providers match the text layer and agree", async () => {
  const decision = await decideFormula(unit({ pdfText: "α" }), {
    katex,
    tiers: baseTiers({
      multimodal: providerOk("multimodal", "\\alpha"),
      ocr: providerOk("ocr", "\\alpha")
    })
  });
  assert.equal(decision.chosen.render, "katex");
  assert.equal(decision.chosen.latex, "\\alpha");
  assert.equal(decision.forcedCrop, false);
});

test("F3-08 when the text layer cannot choose, identical LaTeX is used", async () => {
  const decision = await decideFormula(unit({ pdfText: "zzz" }), {
    katex,
    tiers: baseTiers({
      multimodal: providerOk("multimodal", "x+1"),
      ocr: providerOk("ocr", "x + 1")
    })
  });
  assert.equal(decision.forcedCrop, false);
  assert.equal(decision.chosen.render, "katex");
  assert.equal(decision.chosen.latex.replace(/\s+/g, ""), "x+1");
});

test("F3-09 disagreement the pixel stub cannot settle goes straight to crop", async () => {
  let pixels = 0;
  const counts = {};
  const tiers = spyTiers(baseTiers({
    multimodal: providerOk("multimodal", "x+1"),
    ocr: providerOk("ocr", "y+2")
  }), counts);
  const decision = await decideFormula(unit({ pdfText: "zzz" }), {
    katex,
    tiers,
    pixelJudge: async () => {
      pixels += 1;
      return { decided: false };
    }
  });
  assert.equal(pixels, 1);
  assert.equal(decision.forcedCrop, true);
  assert.equal(decision.forcedReason, "arbiter-undecided");
  assert.equal(decision.chosen.tier, "crop");
  assert.equal(count(counts, "self"), 0);
  assert.equal(count(counts, "vector"), 0);
});

test("F3-10 a pixel judge that picks B is adopted without changing the arbiter", async () => {
  const decision = await decideFormula(unit({ pdfText: "zzz" }), {
    katex,
    tiers: baseTiers({
      multimodal: providerOk("multimodal", "x+1"),
      ocr: providerOk("ocr", "y+2")
    }),
    pixelJudge: async () => ({ decided: true, tier: "ocr" })
  });
  assert.equal(decision.chosen.tier, "ocr");
  assert.equal(decision.chosen.latex, "y+2");
  assert.equal(decision.forcedCrop, false);
});

test("one provider call failure is handled as a single provider", async () => {
  const counts = {};
  const passTiers = spyTiers(baseTiers({
    multimodal: providerOk("multimodal", "\\alpha"),
    ocr: candidate("ocr", async () => tierResult({ tier: "ocr", status: "error", reason: "timeout" }))
  }), counts);
  const passed = await decideFormula(unit({ pdfText: "α" }), { katex, tiers: passTiers });
  assert.equal(passed.chosen.tier, "multimodal");
  assert.equal(passed.chosen.latex, "\\alpha");
  assert.equal(passed.forcedCrop, false);
  assert.equal(count(counts, "self"), 0);
  assert.equal(count(counts, "vector"), 0);

  const failCounts = {};
  const failTiers = spyTiers(baseTiers({
    multimodal: candidate("multimodal", async () => tierResult({ tier: "multimodal", status: "error", reason: "http" })),
    ocr: providerOk("ocr", "\\gamma")
  }), failCounts);
  const failed = await decideFormula(unit({ pdfText: "α" }), { katex, tiers: failTiers });
  assert.equal(failed.forcedCrop, true);
  assert.equal(failed.forcedReason, "single-provider-reject");
  assert.equal(failed.chosen.tier, "crop");
  assert.equal(count(failCounts, "self"), 0);
  assert.equal(count(failCounts, "vector"), 0);

  const bothCounts = {};
  const both = await decideFormula(unit({ pdfText: "α" }), {
    katex,
    tiers: spyTiers(baseTiers({
      multimodal: candidate("multimodal", async () => tierResult({ tier: "multimodal", status: "error", reason: "cooldown" })),
      ocr: candidate("ocr", async () => tierResult({ tier: "ocr", status: "error", reason: "timeout" }))
    }), bothCounts)
  });
  assert.equal(both.chosen.tier, "crop");
  assert.equal(both.forcedCrop, true);
  assert.equal(count(bothCounts, "self"), 0);
  assert.equal(count(bothCounts, "vector"), 0);
});

test("F3-11 crop criteria on a synthetic canvas", () => {
  const blurry = judgeCrop({
    image: solidImage(10, 10),
    pixelSize: { width: 10, height: 10 },
    cssSize: { width: 20, height: 20 },
    dpr: 2
  });
  assert.equal(blurry.pass, false);
  assert.equal(blurry.reason, "crop-blurry");

  const blank = judgeCrop({
    image: solidImage(40, 20, () => {}),
    pixelSize: { width: 40, height: 20 },
    cssSize: { width: 20, height: 10 },
    dpr: 1
  });
  assert.equal(blank.reason, "crop-blank");

  const width = 20;
  const height = 5;
  const foreign = new Uint8Array(width * height);
  const neighbor = judgeCrop({
    image: solidImage(width, height, (data) => {
      for (let i = 0; i < 100; i += 1) {
        const offset = i * 4;
        data[offset] = 0;
        data[offset + 1] = 0;
        data[offset + 2] = 0;
        if (i < 6) foreign[i] = 1;
      }
    }),
    pixelSize: { width, height },
    cssSize: { width: 10, height: 5 },
    dpr: 1,
    foreignMask: foreign
  });
  assert.equal(neighbor.reason, "crop-neighbor-ink");

  const edgeMask = new Uint8Array(width * height);
  for (let i = 0; i < 5; i += 1) edgeMask[i] = 1;
  const edge = judgeCrop({
    image: solidImage(width, height, (data) => {
      for (let i = 0; i < 100; i += 1) {
        data[i * 4] = 0;
        data[i * 4 + 1] = 0;
        data[i * 4 + 2] = 0;
      }
    }),
    pixelSize: { width, height },
    cssSize: { width: 10, height: 5 },
    dpr: 1,
    foreignMask: edgeMask
  });
  assert.equal(edge.pass, true);
  assert.equal(edge.checks.neighborInk.ratio, 0.05);
});

test("F3-12 failed crop uses the placeholder switch", async () => {
  const sample = unit({ crop: blurryCrop(), page: 4, bbox: [0.2, 0.3, 0.5, 0.4] });
  const on = await decideFormula(sample, {
    katex,
    flags: { placeholderEnabled: true }
  });
  assert.equal(on.chosen.tier, "placeholder");
  assert.equal(on.chosen.render, "placeholder");
  assert.equal(on.chosen.confidence, null);
  assert.equal(on.chosen.meta.page, 4);
  assert.deepEqual(on.chosen.meta.bbox, [0.2, 0.3, 0.5, 0.4]);
  assert.equal(on.forcedCrop, false);

  const off = await decideFormula(sample, { katex, flags: { placeholderEnabled: false } });
  assert.equal(off.chosen.tier, "crop");
  assert.equal(off.chosen.render, "image");
  assert.equal(off.trace.some((item) => item.reason === "crop-blurry"), true);
});

test("forced crop that fails its criteria still follows the placeholder switch", async () => {
  const counts = {};
  const tiers = spyTiers(baseTiers({
    multimodal: providerOk("multimodal", "\\beta")
  }), counts);
  const sample = unit({ pdfText: "α", crop: blurryCrop(), page: 2, bbox: [0.1, 0.1, 0.2, 0.2] });
  const on = await decideFormula(sample, { katex, tiers, flags: { placeholderEnabled: true } });
  assert.equal(on.forcedCrop, true);
  assert.equal(on.forcedReason, "single-provider-reject");
  assert.equal(on.chosen.tier, "placeholder");
  assert.equal(on.chosen.meta.page, 2);
  assert.deepEqual(on.chosen.meta.bbox, [0.1, 0.1, 0.2, 0.2]);
  assert.equal(count(counts, "self"), 0);
  assert.equal(count(counts, "vector"), 0);

  const offCounts = {};
  const off = await decideFormula(sample, {
    katex,
    tiers: spyTiers(baseTiers({ multimodal: providerOk("multimodal", "\\beta") }), offCounts),
    flags: { placeholderEnabled: false }
  });
  assert.equal(off.forcedCrop, true);
  assert.equal(off.chosen.tier, "crop");
  assert.equal(off.chosen.render, "image");
  assert.equal(count(offCounts, "self"), 0);
  assert.equal(count(offCounts, "vector"), 0);
});

test("F3-13 redraw failure stays on the crop tier as png", async () => {
  let surfaces = [];
  const quiet = await decideFormula(unit(), {
    katex,
    withRasterCrop: async () => {
      surfaces.push("png");
      return { imageUrl: "data:image/png;base64,ccc", surface: "png" };
    }
  });
  assert.equal(quiet.chosen.tier, "crop");
  assert.equal(quiet.chosen.image.surface, "png");
  assert.equal(quiet.chosen.meta.badge, undefined);
  assert.equal(quiet.trace.filter((item) => item.tier === "crop").length, 1);

  const thrown = await decideFormula(unit(), {
    katex,
    withRasterCrop: async () => {
      throw new Error("redraw failed");
    }
  });
  assert.equal(thrown.chosen.tier, "crop");
  assert.equal(thrown.chosen.image.surface, "png");
  assert.equal(thrown.chosen.meta.badge, undefined);

  const sharp = await decideFormula(unit(), {
    katex,
    withRasterCrop: async () => ({ imageUrl: "data:image/png;base64,ddd", surface: "redraw" })
  });
  assert.equal(sharp.chosen.image.surface, "redraw");
  assert.equal(sharp.chosen.tier, "crop");
  assert.equal(surfaces.length, 1);
});

test("F3-14 stubs and a fake provider share one result contract", async () => {
  const tiers = createDefaultTiers();
  assert.equal(tiers.multimodal.available(), false);
  assert.equal(tiers.ocr.available(), false);
  const fake = candidate("multimodal", async () => tierResult({
    tier: "multimodal",
    status: "error",
    reason: "http"
  }));
  for (const result of [
    await tiers.multimodal.run(),
    await tiers.ocr.run(),
    await fake.run()
  ]) {
    assert.deepEqual(contractViolations(result), []);
    assert.ok(STATUSES.includes(result.status));
    if (result.status !== "ok") assert.ok(REASONS.includes(result.reason));
  }
  assert.equal((await tiers.multimodal.run()).reason, "not-configured");
  assert.equal((await tiers.vector.run()).reason, "not-implemented");

  const key = tierCacheKey({
    unitKey: unitKeyOf(unit()),
    tier: "ocr",
    version: "stub-0",
    model: "m1",
    cropHash: "abc"
  });
  assert.equal(key.includes(CHAIN_VERSION), false);
  assert.notEqual(key, tierCacheKey({ unitKey: unitKeyOf(unit()), tier: "ocr", version: "stub-1", model: "m1", cropHash: "abc" }));
  assert.notEqual(key, tierCacheKey({ unitKey: unitKeyOf(unit()), tier: "ocr", version: "stub-0", model: "m2", cropHash: "abc" }));
  assert.notEqual(key, tierCacheKey({ unitKey: unitKeyOf(unit()), tier: "ocr", version: "stub-0", model: "m1", cropHash: "def" }));
  const coarse = cropHashOf({ bbox: [0, 0, 0.001, 0.002] });
  const sameCell = cropHashOf({ bbox: [0, 0, 0.002, 0.001] });
  const nextCell = cropHashOf({ bbox: [0, 0, 0.006, 0.002] });
  assert.equal(coarse, sameCell);
  assert.notEqual(coarse, nextCell);
  assert.notEqual(
    cropHashOf({ bbox: [0, 0, 1, 1], crop: { pixels: "aaa" } }),
    cropHashOf({ bbox: [0, 0, 1, 1], crop: { pixels: "bbb" } })
  );
});

test("F3-16 alignment under 85% is doc-align-low for every formula", async () => {
  const alignment = {
    useSource: false,
    stats: { wordRate: 0.84 },
    formulas: [
      {
        unitId: "d1",
        bid: "p1-b1",
        kind: "display",
        latex: "x",
        checks: { position: true, chars: true, number: true, render: true }
      },
      {
        unitId: "i1",
        bid: "p1-b2",
        kind: "inline",
        latex: "y",
        checks: { position: true, chars: true, number: true, render: true }
      }
    ]
  };
  const ctx = {
    katex,
    flags: { arxivEnabled: true },
    readAlignment: async () => alignment
  };
  const display = await decideFormula(unit({ bid: "p1-b1", display: true, sourceUnitId: "d1" }), ctx);
  const inline = await decideFormula(unit({ bid: "p1-b2", display: false, sourceUnitId: "i1" }), ctx);
  assert.equal(display.chosen.tier === "arxiv" || display.trace[0].tier === "arxiv", true);
  assert.equal(display.trace[0].reason, "doc-align-low");
  assert.equal(inline.trace[0].reason, "doc-align-low");
  assert.notEqual(display.chosen.tier, "arxiv");
  assert.notEqual(inline.chosen.tier, "arxiv");
});

test("candidates run together, and a slow candidate upgrades a crop preview", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started = 0;
  let bothStarted;
  const opened = new Promise((resolve) => {
    bothStarted = resolve;
  });
  const wait = async (id, latex) => {
    started += 1;
    if (started === 2) bothStarted();
    await gate;
    return tierResult({ tier: id, status: "ok", render: "katex", latex });
  };
  const upgrades = [];
  const pending = decideFormula(unit({ pdfText: "α" }), {
    katex,
    tiers: baseTiers({
      multimodal: candidate("multimodal", () => wait("multimodal", "\\alpha")),
      ocr: candidate("ocr", () => wait("ocr", "\\beta"))
    }),
    onUpgrade(decision) {
      upgrades.push(decision.chosen.tier);
    }
  });
  await Promise.race([
    opened,
    new Promise((_, reject) => setTimeout(() => reject(new Error("providers did not start together")), 300))
  ]);
  assert.equal(started, 2);
  assert.equal(upgrades[0], "crop");
  release();
  const decision = await pending;
  assert.equal(decision.chosen.tier, "multimodal");
  assert.equal(upgrades.at(-1), "multimodal");
});

test("an aborted signal does not run later tiers", async () => {
  const counts = {};
  const decision = await decideFormula(unit(), {
    katex,
    tiers: spyTiers(createDefaultTiers(), counts),
    flags: { arxivEnabled: true }
  }, { signal: AbortSignal.abort() });
  assert.equal(decision.chosen.reason, "aborted");
  assert.equal(count(counts, "arxiv"), 0);
  assert.equal(count(counts, "multimodal"), 0);
  assert.equal(count(counts, "self"), 0);
});

test("F3-17 KaTeX rendering stays untrusted and does not use innerHTML", () => {
  const src = readFileSync(join(root, "lib/formula-katex.js"), "utf8");
  assert.equal(src.includes("innerHTML"), false);
  assert.match(src, /throwOnError:\s*true/);
  assert.match(src, /trust:\s*false/);
  assert.match(src, /strict:\s*"ignore"/);
  for (const latex of [
    "\\href{https://evil.test}{y}",
    "\\url{https://evil.test}",
    "\\htmlClass{a}{x}",
    "\\htmlId{a}{x}",
    "\\htmlStyle{color:red}{x}",
    "\\htmlData{a=b}{x}",
    "\\includegraphics{a.png}"
  ]) {
    assert.equal(canRenderLatex(latex, false, katex).pass, false, latex);
  }
  assert.equal(canRenderLatex("\\alpha+\\beta", true, katex).pass, true);
  installMiniDom();
  for (const latex of ["<script>alert(1)</script>", '"><img onerror=alert(1)>']) {
    const html = renderLatexMarkup(latex, false, katex);
    assert.equal(/<script[\s>/]/i.test(html), false, latex);
    assert.equal(/<img[\s>/]/i.test(html), false, latex);
    const node = makeNode();
    if (canRenderLatex(latex, false, katex).pass) renderLatexInto(node, latex, false, katex);
    assert.equal(hasTag(node, "SCRIPT"), false);
    assert.equal(hasTag(node, "IMG"), false);
  }
  const verdict = verifyCandidate("\\alpha", { pdfText: "α", display: false }, katex);
  assert.equal(verdict.pass, true);
});

test("F3-15 arXiv tier reads the stored Attention alignment", async () => {
  const {
    ATTENTION_PDF_SHA,
    SRC_V1,
    SRC_V1_SHA,
    SRC_V7,
    SRC_V7_SHA,
    loadAttentionPages,
    loadSource,
    parsePacked
  } = await import("./helpers/arxiv-paper.mjs");
  const { alignSourceToBlocks } = await import("../lib/source-align.js");
  const paper = await loadAttentionPages();
  const packedV7 = await loadSource(SRC_V7, SRC_V7_SHA, "从 https://arxiv.org/src/1706.03762v7 下载到 tests/fixtures/arxiv-src/。");
  const packedV1 = await loadSource(SRC_V1, SRC_V1_SHA, "从 https://arxiv.org/src/1706.03762v1 下载到 tests/fixtures/arxiv-src/。");
  const v7 = await parsePacked(packedV7, katex);
  const v1 = await parsePacked(packedV1, katex);
  const alignedV7 = alignSourceToBlocks({ units: v7.units, pages: paper.pages });
  const alignedV1 = alignSourceToBlocks({ units: v1.units, pages: paper.pages });

  async function runRow(alignment, row, version) {
    return decideFormula({
      docHash: ATTENTION_PDF_SHA,
      bid: row.bid || row.unitId,
      sourceUnitId: row.unitId,
      page: row.page || 1,
      bbox: [0, 0, 0.2, 0.05],
      display: row.kind === "display",
      pdfText: "",
      equationNumber: row.number,
      crop: goodCrop()
    }, {
      katex,
      flags: { arxivEnabled: true },
      arxivId: "1706.03762",
      arxivVersion: version,
      readAlignment: async (query) => {
        assert.equal(query.pdfSha256, ATTENTION_PDF_SHA);
        assert.equal(query.id, "1706.03762");
        return alignment;
      }
    });
  }

  const displays = alignedV7.formulas.filter((row) => row.kind === "display");
  assert.equal(displays.length, 5);
  let displayOk = 0;
  for (const row of displays) {
    const decision = await runRow(alignedV7, row, "v7");
    if (decision.chosen.tier === "arxiv" && decision.chosen.status === "ok") displayOk += 1;
  }
  assert.equal(displayOk, 5);

  const inlines = alignedV7.formulas.filter((row) => row.kind === "inline" && row.zone === "body");
  assert.equal(inlines.length, 87);
  let inlineOk = 0;
  for (const row of inlines) {
    const decision = await runRow(alignedV7, row, "v7");
    if (decision.chosen.tier === "arxiv" && decision.chosen.status === "ok") inlineOk += 1;
  }
  assert.ok(inlineOk >= 83, String(inlineOk));

  const v1Displays = alignedV1.formulas.filter((row) => row.kind === "display");
  const multi = v1Displays.find((row) => /MultiHead/.test(row.latex));
  assert.ok(multi);
  const multiDecision = await runRow(alignedV1, multi, "v1");
  assert.equal(multiDecision.trace[0].tier, "arxiv");
  assert.equal(multiDecision.trace[0].reason, "charset-mismatch");
  assert.notEqual(multiDecision.chosen.tier, "arxiv");

  const extras = v1Displays.filter((row) => row.checks.position === false);
  assert.ok(extras.length >= 1);
  const adopted = [];
  for (const row of v1Displays) {
    const decision = await runRow(alignedV1, row, "v1");
    if (decision.chosen.tier === "arxiv") adopted.push(decision.chosen.latex);
  }
  for (const extra of extras) {
    const decision = await runRow(alignedV1, extra, "v1");
    assert.notEqual(decision.chosen.tier, "arxiv");
    assert.equal(decision.trace[0].reason, "not-located");
    assert.equal(adopted.includes(extra.latex), false);
  }
});

function installMiniDom() {
  class Node {
    constructor() {
      this.childNodes = [];
      this.style = {};
      this.attributes = {};
      this.className = "";
      this.nodeType = 1;
    }

    appendChild(child) {
      this.childNodes.push(child);
      return child;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
    }
  }
  class Element extends Node {
    constructor(tag) {
      super();
      this.tagName = String(tag || "").toUpperCase();
    }
  }
  class Fragment extends Node {
    constructor() {
      super();
      this.nodeType = 11;
    }
  }
  globalThis.document = {
    createElement(tag) {
      return new Element(tag);
    },
    createElementNS(_ns, tag) {
      return new Element(tag);
    },
    createTextNode(text) {
      return { nodeType: 3, text: String(text ?? ""), childNodes: [] };
    },
    createDocumentFragment() {
      return new Fragment();
    }
  };
}

function makeNode() {
  const node = {
    childNodes: [],
    style: {},
    get firstChild() {
      return this.childNodes[0] || null;
    },
    appendChild(child) {
      this.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      return child;
    },
    set textContent(value) {
      this._text = value;
      if (!value) this.childNodes.length = 0;
    },
    get textContent() {
      return this._text || "";
    }
  };
  return node;
}

function hasTag(node, tag) {
  if (!node) return false;
  if (String(node.tagName || "").toUpperCase() === tag) return true;
  for (const child of node.childNodes || []) {
    if (hasTag(child, tag)) return true;
  }
  return false;
}
