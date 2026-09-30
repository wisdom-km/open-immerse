import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL_SCHEMA, assignStableIds, unitIdFromMembers, verifyPageLabels } from "../lib/label-schema.js";
import { otherQueueMarks } from "../lib/review-actions.js";
import {
  assertOutDirOutsideRepo,
  createReviewServer,
  ensureManifestInRange,
  openManifestSession,
  parseManifestText,
  parseReviewArgs,
  stepManifest,
  unitsForManifest
} from "../scripts/label-review.mjs";

const repo = fileURLToPath(new URL("..", import.meta.url));
const INSIDE = "paper-inside-token";
const OUTSIDE = "paper-outside-token";
const FIELD_IN = "field-inside-token";
const FIELD_OUT = "field-outside-token";
const SENTINEL = "reviewed-sentinel-token";

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

function buildPage(paperId, page, specs, note) {
  const identified = assignStableIds(specs.map((spec) => ({
    kind: "glyph",
    char: spec.char,
    font: "CMR10",
    bbox: spec.bbox,
    pathHash: "",
    label: "formula",
    unitType: spec.type,
    equationNumber: false,
    confidence: spec.confidence,
    rule: "math-font"
  })));
  const elements = [];
  const units = [];
  identified.forEach((element, index) => {
    const spec = specs[index];
    const id = unitIdFromMembers([element.id]);
    element.unitId = id;
    element.label = "formula";
    element.unitType = spec.type;
    element.equationNumber = false;
    elements.push(element);
    units.push({
      id,
      type: spec.type,
      equationNumber: false,
      confidence: spec.confidence,
      elementIds: [element.id],
      key: spec.key
    });
  });
  const pageData = {
    schema: LABEL_SCHEMA,
    paperId,
    page,
    pageWidth: 200,
    pageHeight: 100,
    source: "prelabel",
    note,
    elements,
    units
  };
  assert.deepEqual(verifyPageLabels(pageData), []);
  return pageData;
}

function queueUnit(paperId, field, page, unit) {
  return {
    paperId,
    field,
    sourceType: "publisher",
    page,
    unitId: unit.id,
    confidence: unit.confidence,
    type: unit.type,
    equationNumber: false,
    elementIds: unit.elementIds
  };
}

function fingerprint(dir) {
  if (!existsSync(dir)) return "missing";
  const rows = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else rows.push(`${relative(dir, full)}\n${readFileSync(full, "utf8")}`);
    }
  };
  walk(dir);
  return rows.join("\n---\n");
}

function syntheticCorpus(dir) {
  const inside = buildPage(INSIDE, 1, [
    { key: "a", char: "a", bbox: [0, 0, 10, 10], type: "inline", confidence: 0.21 },
    { key: "b", bbox: [20, 0, 30, 10], char: "b", type: "display", confidence: 0.41 },
    { key: "c", bbox: [40, 0, 50, 10], char: "c", type: "inline", confidence: 0.51 }
  ], "prelabel-marker");
  const outside = buildPage(OUTSIDE, 2, [
    { key: "d", char: "d", bbox: [0, 0, 10, 10], type: "display", confidence: 0.31 }
  ], "outside-page-marker");
  const byKey = (page, key) => page.units.find((unit) => unit.key === key);
  const units = [
    queueUnit(INSIDE, FIELD_IN, 1, byKey(inside, "a")),
    queueUnit(OUTSIDE, FIELD_OUT, 2, byKey(outside, "d")),
    queueUnit(INSIDE, FIELD_IN, 1, byKey(inside, "b")),
    queueUnit(INSIDE, FIELD_IN, 1, byKey(inside, "c"))
  ];
  writeJson(join(dir, "corpus/manifest.json"), {
    documents: [
      { id: INSIDE, field: FIELD_IN, pageCount: 1 },
      { id: OUTSIDE, field: FIELD_OUT, pageCount: 2 }
    ]
  });
  writeJson(join(dir, "labels/review-set.json"), {
    schema: "open-immerse.review-set/v1",
    units
  });
  writeJson(join(dir, "labels/prelabel", INSIDE, "page-001.json"), inside);
  writeJson(join(dir, "labels/prelabel", OUTSIDE, "page-002.json"), outside);
  writeJson(join(dir, "labels/reviewed/keep.txt"), { note: SENTINEL });
  return { inside, outside, units, samePageUnitId: byKey(inside, "c").id, kept: byKey(inside, "a"), other: byKey(inside, "b") };
}

async function withServer(options, fn) {
  const { server } = createReviewServer(options);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

function assertCliLine(args, pattern) {
  const result = spawnSync(process.execPath, [join(repo, "scripts/label-review.mjs"), ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 5000
  });
  assert.notEqual(result.status, 0);
  const lines = result.stderr.trim().split(/\n/).filter(Boolean);
  assert.equal(lines.length, 1, result.stderr);
  assert.match(lines[0], pattern);
  assert.equal(result.stderr.includes("at "), false);
  assert.equal(/[/\\]/.test(lines[0]), false);
}

test("manifest arguments must be given together and stay one line", () => {
  assert.deepEqual(parseReviewArgs([]), { manifest: null, outDir: null });
  assert.throws(() => parseReviewArgs(["--manifest", "batch.txt"]), /--manifest 和 --out-dir/);
  assert.throws(() => parseReviewArgs(["--out-dir", "D:\\review\\out"]), /--manifest 和 --out-dir/);
  assert.throws(() => parseReviewArgs(["--manifest"]), /--manifest 和 --out-dir/);
  assert.throws(() => parseReviewArgs(["--out-dir"]), /--manifest 和 --out-dir/);
  assert.deepEqual(parseReviewArgs(["--manifest", "batch.txt", "--out-dir", "D:\\review\\out"]), {
    manifest: "batch.txt",
    outDir: "D:\\review\\out"
  });
  assertCliLine(["--manifest", "batch.txt"], /--manifest 和 --out-dir/);
  assertCliLine(["--out-dir", "D:\\review\\out"], /--manifest 和 --out-dir/);
});

test("manifest text, range, and an in-repo output directory are rejected before the review set is read", () => {
  assert.deepEqual(parseManifestText("#1\n\n#3  \n"), [1, 3]);
  assert.throws(() => parseManifestText("\n\n"), /清单是空的/);
  assert.throws(() => parseManifestText("3\n"), /清单格式不对/);
  assert.throws(() => parseManifestText("#1\n#1\n"), /重复编号/);
  assert.throws(() => parseManifestText("#0\n"), /超出复核集范围/);
  assert.throws(() => ensureManifestInRange([1, 4], 3), /超出复核集范围/);

  const outside = mkdtempSync(join(tmpdir(), "review-manifest-out-"));
  const missing = join(outside, "nested", "items");
  try {
    assert.equal(existsSync(missing), false);
    const resolved = assertOutDirOutsideRepo(missing, repo);
    assert.equal(existsSync(missing), false);
    assert.equal(resolved.startsWith(realpathSync(outside)), true);

    let loaded = false;
    assert.throws(() => openManifestSession({
      manifestText: "#1\n",
      outDir: join(repo, "tmp-review-manifest-inside"),
      repoRoot: repo,
      loadLength: () => {
        loaded = true;
        return 4;
      }
    }), /仓库根目录之外/);
    assert.equal(loaded, false);
    assert.equal(existsSync(join(repo, "tmp-review-manifest-inside")), false);

    const insideDir = mkdtempSync(join(repo, "tmp-review-manifest-target-"));
    const link = join(tmpdir(), `review-manifest-link-${process.pid}`);
    symlinkSync(insideDir, link);
    try {
      assert.throws(() => assertOutDirOutsideRepo(link, repo), /仓库根目录之外/);
    } finally {
      unlinkSync(link);
      rmSync(insideDir, { recursive: true, force: true });
    }

    const realOut = mkdtempSync(join(tmpdir(), "review-manifest-real-"));
    const outLink = join(repo, "tmp-review-manifest-out-link");
    symlinkSync(realOut, outLink);
    try {
      assert.equal(assertOutDirOutsideRepo(outLink, repo), realpathSync(realOut));
    } finally {
      unlinkSync(outLink);
      rmSync(realOut, { recursive: true, force: true });
    }
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }

  const manifest = join(tmpdir(), `review-manifest-batch-${process.pid}.txt`);
  const linked = join(tmpdir(), `review-manifest-cli-link-${process.pid}`);
  const inside = mkdtempSync(join(repo, "tmp-review-manifest-cli-"));
  symlinkSync(inside, linked);
  try {
    writeFileSync(manifest, "#1\n\n#3  \n");
    assertCliLine(["--manifest", manifest, "--out-dir", inside], /仓库根目录之外/);
    assertCliLine(["--manifest", manifest, "--out-dir", linked], /仓库根目录之外/);
    assert.equal(existsSync(join(inside, "1.json")), false);
    writeFileSync(manifest, "\n");
    assertCliLine(["--manifest", manifest, "--out-dir", inside], /清单是空的/);
    writeFileSync(manifest, "#1\n#1\n");
    assertCliLine(["--manifest", manifest, "--out-dir", inside], /重复编号/);
  } finally {
    unlinkSync(linked);
    unlinkSync(manifest);
    rmSync(inside, { recursive: true, force: true });
  }
});

test("navigation stays on the manifest and same-page marks skip other units", () => {
  const indexes = [1, 3];
  assert.deepEqual(stepManifest(indexes, null, "first", []), { ok: true, queueIndex: 1, end: false });
  assert.deepEqual(stepManifest(indexes, 1, "next", []), { ok: true, queueIndex: 3, end: false });
  assert.deepEqual(stepManifest(indexes, 3, "next", []), { ok: true, queueIndex: 3, end: true });
  assert.deepEqual(stepManifest(indexes, 3, "prev", []), { ok: true, queueIndex: 1, end: false });
  assert.deepEqual(stepManifest(indexes, 1, "prev", []), { ok: true, queueIndex: 1, end: true });
  assert.equal(stepManifest(indexes, 2, "next", []).ok, false);
  assert.deepEqual(stepManifest(indexes, 1, "unreviewed", new Set([1])), { ok: true, queueIndex: 3, end: false });
  assert.deepEqual(stepManifest(indexes, 1, "first", new Set([1])), { ok: true, queueIndex: 3, end: false });

  const units = [
    { paperId: INSIDE, page: 1, unitId: "unit-a", elementIds: ["e-a"], type: "inline", confidence: 0.21, field: FIELD_IN },
    { paperId: OUTSIDE, page: 2, unitId: "unit-outside", elementIds: ["e-d"], type: "display", confidence: 0.31, field: FIELD_OUT },
    { paperId: INSIDE, page: 1, unitId: "unit-b", elementIds: ["e-b"], type: "display", confidence: 0.41, field: FIELD_IN },
    { paperId: INSIDE, page: 1, unitId: "unit-same-page", elementIds: ["e-c"], type: "inline", confidence: 0.51, field: FIELD_IN }
  ];
  const visible = unitsForManifest(units, indexes);
  assert.deepEqual(visible.map((unit) => unit.queueIndex), [1, 3]);
  assert.equal(JSON.stringify(visible).includes(OUTSIDE), false);
  assert.equal(JSON.stringify(visible).includes("unit-same-page"), false);
  const elements = [
    { id: "e-a", label: "formula", unitId: "unit-a", unitType: "inline", equationNumber: false, bbox: [0, 0, 8, 10] },
    { id: "e-b", label: "formula", unitId: "unit-b", unitType: "display", equationNumber: false, bbox: [20, 0, 28, 10] },
    { id: "e-c", label: "formula", unitId: "unit-same-page", unitType: "inline", equationNumber: false, bbox: [40, 0, 48, 10] }
  ];
  const marks = otherQueueMarks({
    units: visible,
    paperId: INSIDE,
    page: 1,
    elements,
    currentReviewUnitId: "unit-a"
  }).map((mark) => {
    const unit = visible.find((item) => item.unitId === mark.reviewUnitId);
    return { ...mark, queueNumber: unit.queueIndex };
  });
  assert.deepEqual(marks.map((mark) => mark.reviewUnitId), ["unit-b"]);
  assert.deepEqual(marks.map((mark) => mark.queueNumber), [3]);
});

test("manifest mode filters the queue, rejects other numbers, and writes outside the repo", async () => {
  const base = mkdtempSync(join(tmpdir(), "review-manifest-root-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-save-"));
  const made = syntheticCorpus(base);
  const reviewedDir = join(base, "labels/reviewed");
  const before = fingerprint(reviewedDir);
  try {
    await withServer({ root: base, manifestIndexes: [1, 3], outDir }, async (origin) => {
      const setResponse = await fetch(`${origin}/api/review-set`);
      const setText = await setResponse.text();
      const set = JSON.parse(setText);
      assert.equal(set.manifestMode, true);
      assert.deepEqual(set.units.map((unit) => unit.queueIndex), [1, 3]);
      assert.equal(setText.includes(OUTSIDE), false);
      assert.equal(setText.includes(FIELD_OUT), false);
      assert.equal(setText.includes(made.samePageUnitId), false);
      assert.equal(setText.includes(INSIDE), true);

      const status = await (await fetch(`${origin}/api/status`)).json();
      assert.equal(status.manifestMode, true);
      assert.equal(JSON.stringify(status).includes(OUTSIDE), false);
      assert.equal(JSON.stringify(status).includes(FIELD_OUT), false);
      assert.equal(status.reviewTarget, 2);
      assert.equal(status.reviewedUnits, 0);

      const missing = await fetch(`${origin}/api/review-unit/2`);
      const missingText = await missing.text();
      assert.equal(missing.status, 404);
      assert.equal(missingText, JSON.stringify({ error: "不在本次清单内" }));
      assert.equal(missingText.includes(OUTSIDE), false);

      const next = await (await fetch(`${origin}/api/review-nav?from=1&move=next`)).json();
      assert.deepEqual(next, { queueIndex: 3, end: false });
      const blocked = await fetch(`${origin}/api/review-nav?from=2&move=next`);
      assert.equal(blocked.status, 404);
      assert.equal(await blocked.text(), JSON.stringify({ error: "不在本次清单内" }));
      const end = await (await fetch(`${origin}/api/review-nav?from=3&move=next`)).json();
      assert.deepEqual(end, { queueIndex: 3, end: true });

      const outsidePage = await fetch(`${origin}/api/page/${OUTSIDE}/2`);
      assert.equal(outsidePage.status, 404);
      assert.equal(await outsidePage.text(), JSON.stringify({ error: "不在本次清单内" }));

      const pageResponse = await fetch(`${origin}/api/page/${INSIDE}/1`);
      const pageText = await pageResponse.text();
      assert.equal(pageResponse.status, 200);
      assert.equal(pageText.includes(SENTINEL), false);
      assert.equal(pageText.includes("prelabel-marker"), true);
      assert.equal(pageText.includes("outside-page-marker"), false);

      const pagePut = await fetch(`${origin}/api/page/${INSIDE}/1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: LABEL_SCHEMA, page: 1, elements: [], units: [] })
      });
      assert.equal(pagePut.status, 400);
      assert.equal(fingerprint(reviewedDir), before);

      const elementId = made.kept.elementIds[0];
      const saved = await fetch(`${origin}/api/item/1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueIndex: 1,
          elementIds: [elementId],
          elements: [{ id: elementId, label: "text", confidence: 1, rule: "human", unitId: null, unitType: null, equationNumber: false }],
          reviewed: true,
          paperId: OUTSIDE,
          unitId: made.samePageUnitId
        })
      });
      assert.equal(saved.status, 200);
      const record = JSON.parse(readFileSync(join(outDir, "1.json"), "utf8"));
      assert.equal(record.queueIndex, 1);
      assert.match(record.writtenAt, /^\d{4}-\d{2}-\d{2}T/);
      assert.equal(record.annotation.paperId, INSIDE);
      assert.equal(record.annotation.unitId, made.kept.id);
      assert.equal(record.annotation.reviewed, true);
      assert.deepEqual(record.annotation.elementIds, [elementId]);
      const recordText = JSON.stringify(record);
      assert.equal(recordText.includes(OUTSIDE), false);
      assert.equal(recordText.includes(made.samePageUnitId), false);
      assert.equal(existsSync(join(outDir, "2.json")), false);
      assert.equal(fingerprint(reviewedDir), before);

      const reloaded = await (await fetch(`${origin}/api/page/${INSIDE}/1`)).json();
      const edited = reloaded.page.elements.find((element) => element.id === elementId);
      assert.equal(edited.label, "text");
      assert.equal(reloaded.page.reviewedUnitIds.includes(made.kept.id), true);
      assert.equal(JSON.stringify(reloaded).includes(SENTINEL), false);

      const after = await (await fetch(`${origin}/api/status`)).json();
      assert.equal(after.reviewedUnits, 1);
      assert.equal(after.reviewTarget, 2);
      const unreviewed = await (await fetch(`${origin}/api/review-nav?from=1&move=unreviewed`)).json();
      assert.deepEqual(unreviewed, { queueIndex: 3, end: false });
      const first = await (await fetch(`${origin}/api/review-nav?move=first`)).json();
      assert.deepEqual(first, { queueIndex: 3, end: false });
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("without manifest flags the queue and reviewed writes stay on the old path", async () => {
  const base = mkdtempSync(join(tmpdir(), "review-manifest-legacy-"));
  const made = syntheticCorpus(base);
  try {
    await withServer({ root: base }, async (origin) => {
      const setText = await (await fetch(`${origin}/api/review-set`)).text();
      const set = JSON.parse(setText);
      assert.equal(set.manifestMode, undefined);
      assert.equal(set.units.length, 4);
      assert.equal(setText.includes(OUTSIDE), true);
      assert.equal(setText.includes(INSIDE), true);
      const status = await (await fetch(`${origin}/api/status`)).json();
      assert.equal(status.manifestMode, undefined);
      assert.equal(status.reviewTarget, 4);

      const odd = await fetch(`${origin}/api/review-unit/2`);
      assert.equal(odd.status, 404);
      assert.equal(await odd.text(), "not found");

      const page = made.inside;
      const put = await fetch(`${origin}/api/page/${INSIDE}/1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(page)
      });
      assert.equal(put.status, 200);
      const written = join(base, "labels/reviewed", INSIDE, "page-001.json");
      assert.equal(existsSync(written), true);
      assert.equal(JSON.parse(readFileSync(written, "utf8")).source, "reviewed");
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the review page and the label docs describe manifest mode", () => {
  const review = readFileSync(new URL("../tools/label-review/review.js", import.meta.url), "utf8");
  const docs = readFileSync(new URL("../docs/v1-m1-labels.md", import.meta.url), "utf8");
  const todo = readFileSync(new URL("../docs/owner-todo.md", import.meta.url), "utf8");
  assert.match(review, /清单模式：已标/);
  assert.match(review, /不在本次清单内/);
  assert.match(review, /\/api\/review-nav/);
  assert.match(review, /\/api\/review-unit\//);
  assert.match(review, /\/api\/item\//);
  assert.match(review, /moveManifest\(/);
  assert.match(review, /pageAllowed\(/);
  assert.match(review, /parseQueueQuery\(/);
  assert.match(review, /parseQueueJump\(/);
  assert.match(docs, /### 清单模式/);
  assert.match(docs, /--manifest/);
  assert.match(docs, /--out-dir/);
  assert.match(docs, /\$env:PORT=4174; node scripts\/label-review\.mjs --manifest D:\\review\\batch\.txt --out-dir D:\\review\\out/);
  assert.match(docs, /不在本次清单内/);
  assert.match(docs, /清单模式：已标 x \/ 共 y/);
  assert.match(todo, /标注用复核工具的清单模式，结果写到仓库外目录，不进 labels\/reviewed。/);
});
