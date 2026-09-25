import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheMatches, formatTiming, renderReport, runChecks } from "../scripts/baseline-checks.mjs";
import { PRELABEL_VERSION } from "../lib/prelabel.js";

test("the baseline cache key includes the PDF fingerprint and prelabel version", () => {
  const doc = { contentFingerprint: "abc" };
  assert.equal(cacheMatches({ prelabelVersion: PRELABEL_VERSION, contentFingerprint: "abc" }, doc), true);
  assert.equal(cacheMatches({ prelabelVersion: "old", contentFingerprint: "abc" }, doc), false);
  assert.equal(cacheMatches({ prelabelVersion: PRELABEL_VERSION, contentFingerprint: "other" }, doc), false);
  assert.equal(cacheMatches({ id: "paper" }, doc), false);
});

test("the tracked report has no timing columns", () => {
  const markdown = renderReport({ documents: [] }, [{
    id: "paper",
    field: "ai",
    sourceType: "publisher-typeset",
    pages: 2,
    units: 4,
    missing: 3,
    solid: 1,
    neighbours: 0,
    conflicts: 0,
    correct: 1,
    jaccard: 1,
    emptySvgs: 0,
    baselineBlocks: 2,
    prelabelFallback: 1,
    recordMs: 999,
    buildMs: 888,
    svgBytes: 2048
  }], ["gone"]);
  assert.equal(markdown.includes("record ms"), false);
  assert.equal(markdown.includes("build ms"), false);
  assert.match(markdown, /corpus\/pdfs\/gone\.pdf/);
  assert.match(markdown, /\| paper \|/);
  const timing = formatTiming([{ id: "paper", recordMs: 10, buildMs: 20, pages: 2 }]);
  assert.match(timing, /record ms\/page/);
  assert.match(timing, /paper  5\.000  10\.000/);
});

test("a default run skips missing PDFs and does not rewrite the tracked baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "baseline-"));
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify({
    documents: [{ id: "missing-paper", field: "ai", sourceType: "publisher-typeset", title: "Missing" }]
  }));
  const tracked = new URL("../docs/v1-m1-baseline.md", import.meta.url);
  const before = readFileSync(tracked);
  const source = readFileSync(new URL("../scripts/baseline-checks.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("fetchCorpus"), false);
  const outcome = await runChecks({
    manifestPath,
    pdfDir: join(dir, "pdfs"),
    cacheDir: join(dir, "cache"),
    reportPath: join(dir, "report.md"),
    summaryPath: join(dir, "summary.json")
  });
  assert.deepEqual(outcome.missing, ["missing-paper"]);
  assert.equal(outcome.rows.length, 0);
  const report = readFileSync(join(dir, "report.md"), "utf8");
  assert.match(report, /missing-paper/);
  assert.equal(report.includes("record ms"), false);
  assert.deepEqual(readFileSync(tracked), before);
});
