import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL_SCHEMA, assignStableIds, unitIdFromMembers, verifyPageLabels } from "../lib/label-schema.js";
import { otherQueueMarks } from "../lib/review-actions.js";
import {
  assertOutDirOutsideRepo,
  createReviewServer,
  decodeManifestBytes,
  ensureManifestInRange,
  openManifestSession,
  manifestMergeIssues,
  parseManifestText,
  parseReviewArgs,
  setReviewPathTrace,
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
      assert.equal(pageText.includes(made.samePageUnitId), false);

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
          paperId: INSIDE,
          page: 1,
          unitId: made.kept.id,
          elementIds: [elementId],
          elements: [{ id: elementId, label: "text", confidence: 1, rule: "human", unitId: null, unitType: null, equationNumber: false }],
          reviewed: true
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
  assert.match(docs, /UTF-16LE/);
  assert.match(docs, /不要把清单文件和 out-dir 提交进仓库/);
  assert.match(docs, /会自动创建/);
  assert.match(docs, /未保存/);
  assert.match(docs, /计分时 mergedInto 条目按「与主条目同一公式」处理/);
  assert.match(docs, /编号最小/);
  assert.match(docs, /"mergedInto": 12/);
  assert.match(todo, /标注用复核工具的清单模式，结果写到仓库外目录，不进 labels\/reviewed。/);
  assert.match(todo, /复核工具默认模式仍把整个仓库当静态文件提供（只监听本机，沿用原行为）；标 held-out 必须用清单模式。/);
  const html = readFileSync(new URL("../tools/label-review/index.html", import.meta.url), "utf8");
  assert.match(html, /默认按复核集往下走/);
  assert.equal(html.includes("约 1000"), false);
  assert.match(review, /清单模式不用整页队列/);
  assert.match(review, /manifestPageView\(/);
  assert.match(review, /\/tools\/label-review\/runtime\/label-schema\.js/);
  const jump = review.slice(review.indexOf("async function jumpToQueueNumber"), review.indexOf("async function confirmUnit"));
  const missed = jump.slice(jump.indexOf("不在本次清单内"));
  assert.match(jump, /clearMissedQueueHighlight\(/);
  assert.match(missed, /clearMissedQueueHighlight\(/);
  const clearer = review.slice(review.indexOf("function clearMissedQueueHighlight"), review.indexOf("async function moveManifest"));
  assert.match(clearer, /showQueueCurrent = false/);
  assert.match(clearer, /renderQueue\(/);
  assert.match(review, /stepManifestPage\(/);
  assert.match(review, /这个元素不在当前条目里，未保存/);
  assert.match(review, /未保存/);
});

test("manifest text accepts a UTF-8 BOM and UTF-16LE", () => {
  assert.deepEqual(parseManifestText("\uFEFF#1\n#3\n"), [1, 3]);
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("#1\n#3\n", "utf8")]);
  assert.deepEqual(parseManifestText(decodeManifestBytes(utf8)), [1, 3]);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("#1\n#3\n", "utf16le")]);
  assert.deepEqual(parseManifestText(decodeManifestBytes(utf16)), [1, 3]);
});

test("manifest mode does not serve labels and a directory path is 404", async () => {
  const base = mkdtempSync(join(tmpdir(), "review-manifest-static-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-static-out-"));
  syntheticCorpus(base);
  mkdirSync(join(base, "a-directory"));
  const seen = [];
  setReviewPathTrace((path) => seen.push(path));
  try {
    await withServer({ root: base, manifestIndexes: [1, 3], outDir }, async (origin) => {
      seen.length = 0;
      const reviewed = await fetch(`${origin}/labels/reviewed/keep.txt`);
      const prelabel = await fetch(`${origin}/labels/prelabel/${INSIDE}/page-001.json`);
      const nested = await fetch(`${origin}/labels/reviewed/${INSIDE}/page-001.json`);
      const script = await fetch(`${origin}/scripts/label-review.mjs`);
      const runtime = await fetch(`${origin}/tools/label-review/runtime/label-schema.js`);
      const runtimeText = await runtime.text();
      assert.equal(reviewed.status, 404);
      assert.equal(await reviewed.text(), "not found");
      assert.equal(prelabel.status, 404);
      assert.equal(nested.status, 404);
      assert.equal(script.status, 404);
      assert.equal(runtime.status, 200);
      assert.match(runtimeText, /LABEL_SCHEMA/);
      const page = await fetch(`${origin}/api/page/${INSIDE}/1`);
      assert.equal(page.status, 200);
      const manifest = await (await fetch(`${origin}/api/manifest`)).json();
      assert.deepEqual(manifest.documents.map((doc) => doc.id), [INSIDE]);
      assert.equal(JSON.stringify(manifest).includes(OUTSIDE), false);
      assert.equal(JSON.stringify(manifest).includes(FIELD_OUT), false);
      const pdf = await fetch(`${origin}/api/pdf/${OUTSIDE}`);
      assert.equal(pdf.status, 404);
      assert.equal(await pdf.text(), JSON.stringify({ error: "不在本次清单内" }));
      const folder = await fetch(`${origin}/a-directory`);
      assert.equal(folder.status, 404);
      assert.equal(await folder.text(), "not found");
      assert.equal(seen.some((path) => path.includes(`${join("labels", "reviewed")}`)), false);
    });
    seen.length = 0;
    await withServer({ root: base }, async (origin) => {
      const folder = await fetch(`${origin}/a-directory`);
      assert.equal(folder.status, 404);
      assert.equal(await folder.text(), "not found");
    });
  } finally {
    setReviewPathTrace(null);
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("a page-queue wipe cannot replace a reviewed manifest item", async () => {
  const base = mkdtempSync(join(tmpdir(), "review-manifest-wipe-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-wipe-out-"));
  const made = syntheticCorpus(base);
  const elementId = made.kept.elementIds[0];
  const otherId = made.other.elementIds[0];
  try {
    await withServer({ root: base, manifestIndexes: [1, 3], outDir }, async (origin) => {
      const good = await fetch(`${origin}/api/item/1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueIndex: 1,
          paperId: INSIDE,
          page: 1,
          unitId: made.kept.id,
          elementIds: [elementId],
          elements: [{ id: elementId, label: "formula", confidence: 1, rule: "human", unitId: made.kept.id, unitType: "inline", equationNumber: false }],
          reviewed: true
        })
      });
      assert.equal(good.status, 200);
      const before = readFileSync(join(outDir, "1.json"), "utf8");
      const wipe = await fetch(`${origin}/api/item/1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queueIndex: 1, elementIds: [], elements: [], reviewed: false })
      });
      assert.equal(wipe.status, 400);
      const mismatch = await fetch(`${origin}/api/item/1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueIndex: 1,
          paperId: OUTSIDE,
          page: 2,
          unitId: made.samePageUnitId,
          elementIds: [],
          elements: [],
          reviewed: false
        })
      });
      assert.equal(mismatch.status, 400);
      assert.equal(readFileSync(join(outDir, "1.json"), "utf8"), before);
      assert.equal(JSON.parse(before).annotation.reviewed, true);
      assert.deepEqual(JSON.parse(before).annotation.elementIds, [elementId]);

      const mergedId = unitIdFromMembers([elementId, otherId]);
      const merged = await fetch(`${origin}/api/item/1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueIndex: 1,
          paperId: INSIDE,
          page: 1,
          unitId: made.kept.id,
          type: "display",
          equationNumber: false,
          elementIds: [elementId, otherId],
          elements: [
            { id: elementId, label: "formula", confidence: 1, rule: "human", unitId: mergedId, unitType: "display", equationNumber: false },
            { id: otherId, label: "formula", confidence: 1, rule: "human", unitId: mergedId, unitType: "display", equationNumber: false }
          ],
          reviewed: true
        })
      });
      assert.equal(merged.status, 200);
      const reloaded = await (await fetch(`${origin}/api/page/${INSIDE}/1`)).json();
      assert.deepEqual(verifyPageLabels(reloaded.page), []);
      assert.equal(JSON.stringify(reloaded).includes(made.samePageUnitId), false);
      const ids = reloaded.page.elements.map((element) => element.id).sort();
      assert.deepEqual(ids, [elementId, otherId].sort());
      assert.equal(reloaded.page.elements.every((element) => element.unitType === "display"), true);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

function reviewAssetUrls() {
  const source = readFileSync(new URL("../tools/label-review/review.js", import.meta.url), "utf8");
  const urls = [];
  for (const match of source.matchAll(/from\s+"([^"]+)"/g)) urls.push(match[1]);
  for (const match of source.matchAll(/workerSrc\s*=\s*"([^"]+)"/g)) urls.push(match[1]);
  assert.ok(urls.length >= 4);
  return urls;
}

test("default and manifest modes serve every module the review page imports", async () => {
  const urls = reviewAssetUrls();
  const base = mkdtempSync(join(tmpdir(), "review-manifest-assets-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-assets-out-"));
  syntheticCorpus(base);
  try {
    for (const options of [{ root: base }, { root: base, manifestIndexes: [1, 3], outDir }]) {
      await withServer(options, async (origin) => {
        for (const url of urls) {
          const response = await fetch(`${origin}${url}`);
          const body = Buffer.from(await response.arrayBuffer());
          assert.equal(response.status, 200, `${url} ${options.manifestIndexes ? "manifest" : "default"}`);
          assert.ok(body.length > 0);
        }
      });
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("manifest static files are an explicit list and ignore a symlink into labels", async () => {
  const base = mkdtempSync(join(tmpdir(), "review-manifest-link-root-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-link-out-"));
  syntheticCorpus(base);
  const pageDir = join(base, "tools/label-review");
  mkdirSync(pageDir, { recursive: true });
  cpSync(join(repo, "tools/label-review/index.html"), join(pageDir, "index.html"));
  cpSync(join(repo, "tools/label-review/review.css"), join(pageDir, "review.css"));
  writeFileSync(join(pageDir, "extra.js"), "extra-token");
  symlinkSync(join(base, "labels/reviewed/keep.txt"), join(pageDir, "review.js"));
  try {
    await withServer({ root: base, manifestIndexes: [1, 3], outDir }, async (origin) => {
      const page = await fetch(`${origin}/tools/label-review/index.html`);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /公式标注复核/);
      const style = await fetch(`${origin}/tools/label-review/review.css`);
      assert.equal(style.status, 200);
      const leaked = await fetch(`${origin}/tools/label-review/review.js`);
      const leakedText = await leaked.text();
      assert.equal(leaked.status, 404);
      assert.equal(leakedText, "not found");
      assert.equal(leakedText.includes(SENTINEL), false);
      const extra = await fetch(`${origin}/tools/label-review/extra.js`);
      assert.equal(extra.status, 404);
      assert.equal(await extra.text(), "not found");
    });
    await withServer({ root: base }, async (origin) => {
      const extra = await fetch(`${origin}/tools/label-review/extra.js`);
      assert.equal(extra.status, 200);
      assert.equal(await extra.text(), "extra-token");
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("a merge of two manifest items on one page is still there after restart", async () => {
  const base = mkdtempSync(join(tmpdir(), "review-manifest-merge-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-merge-out-"));
  const made = syntheticCorpus(base);
  const keptId = made.kept.elementIds[0];
  const otherId = made.other.elementIds[0];
  const mergedId = unitIdFromMembers([keptId, otherId]);
  const options = { root: base, manifestIndexes: [1, 3], outDir };
  try {
    await withServer(options, async (origin) => {
      const first = await fetch(`${origin}/api/item/3`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueIndex: 3,
          paperId: INSIDE,
          page: 1,
          unitId: made.other.id,
          elementIds: [otherId],
          elements: [{ id: otherId, label: "formula", confidence: 0.2, rule: "math-font", unitId: made.other.id, unitType: "display", equationNumber: false }],
          reviewed: true
        })
      });
      assert.equal(first.status, 200);
      const merged = await fetch(`${origin}/api/item/1`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queueIndex: 1,
          paperId: INSIDE,
          page: 1,
          unitId: made.kept.id,
          type: "display",
          elementIds: [keptId, otherId],
          elements: [
            { id: keptId, label: "formula", confidence: 1, rule: "human", unitId: mergedId, unitType: "display", equationNumber: false },
            { id: otherId, label: "formula", confidence: 1, rule: "human", unitId: mergedId, unitType: "display", equationNumber: false }
          ],
          reviewed: true
        })
      });
      assert.equal(merged.status, 200);
    });
    const absorbed = JSON.parse(readFileSync(join(outDir, "3.json"), "utf8"));
    assert.equal(absorbed.annotation.mergedInto, 1);
    assert.deepEqual(absorbed.annotation.elementIds, []);
    await withServer(options, async (origin) => {
      const reloaded = await (await fetch(`${origin}/api/page/${INSIDE}/1`)).json();
      assert.deepEqual(verifyPageLabels(reloaded.page), []);
      const other = reloaded.page.elements.find((element) => element.id === otherId);
      assert.equal(other.unitId, mergedId);
      assert.equal(other.unitType, "display");
      assert.equal(other.unitId === made.other.id, false);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("manifestMergeIssues flags a mergedInto that does not match the members", () => {
  const units = [
    { queueIndex: 3, paperId: "paper-trio-token", page: 1, elementIds: ["member-a"] },
    { queueIndex: 5, paperId: "paper-trio-token", page: 1, elementIds: ["member-b"] }
  ];
  const stale = {
    3: { annotation: { elementIds: ["member-a"], elements: [], reviewed: true } },
    5: { annotation: { elementIds: [], elements: [], reviewed: true, mergedInto: 3 } }
  };
  assert.ok(manifestMergeIssues(units, stale).length > 0);
  const sound = {
    3: { annotation: { elementIds: ["member-a", "member-b"], elements: [], reviewed: true } },
    5: { annotation: { elementIds: [], elements: [], reviewed: true, mergedInto: 3 } }
  };
  assert.deepEqual(manifestMergeIssues(units, sound), []);
});

function trioCorpus(dir) {
  const paper = "paper-trio-token";
  const fillerPaper = "paper-filler-token";
  const page = buildPage(paper, 1, [
    { key: "u3", char: "x", bbox: [0, 0, 10, 10], type: "inline", confidence: 0.22 },
    { key: "u5", char: "y", bbox: [20, 0, 30, 10], type: "inline", confidence: 0.32 },
    { key: "u7", char: "z", bbox: [40, 0, 50, 10], type: "display", confidence: 0.42 }
  ], "trio-page");
  const filler = buildPage(fillerPaper, 1, [
    { key: "f1", char: "f", bbox: [0, 0, 8, 8], type: "inline", confidence: 0.2 },
    { key: "f2", char: "g", bbox: [10, 0, 18, 8], type: "inline", confidence: 0.2 },
    { key: "f3", char: "h", bbox: [20, 0, 28, 8], type: "inline", confidence: 0.2 },
    { key: "f4", char: "i", bbox: [30, 0, 38, 8], type: "inline", confidence: 0.2 }
  ], "filler-page");
  const unitByKey = (source, key) => source.units.find((unit) => unit.key === key);
  const units = [
    queueUnit(fillerPaper, "field-filler-token", 1, unitByKey(filler, "f1")),
    queueUnit(fillerPaper, "field-filler-token", 1, unitByKey(filler, "f2")),
    queueUnit(paper, "field-trio-token", 1, unitByKey(page, "u3")),
    queueUnit(fillerPaper, "field-filler-token", 1, unitByKey(filler, "f3")),
    queueUnit(paper, "field-trio-token", 1, unitByKey(page, "u5")),
    queueUnit(fillerPaper, "field-filler-token", 1, unitByKey(filler, "f4")),
    queueUnit(paper, "field-trio-token", 1, unitByKey(page, "u7"))
  ];
  writeJson(join(dir, "labels/review-set.json"), { schema: "open-immerse.review-set/v1", units });
  writeJson(join(dir, "labels/prelabel", paper, "page-001.json"), page);
  writeJson(join(dir, "corpus/manifest.json"), { documents: [{ id: paper, field: "field-trio-token", pageCount: 1 }] });
  return { paper, page, units, u3: unitByKey(page, "u3"), u5: unitByKey(page, "u5"), u7: unitByKey(page, "u7") };
}

function trioQueueUnits(made) {
  return [
    { ...made.units[2], queueIndex: 3 },
    { ...made.units[4], queueIndex: 5 },
    { ...made.units[6], queueIndex: 7 }
  ];
}

function readOutRecords(outDir, indexes) {
  const records = {};
  for (const n of indexes) {
    const file = join(outDir, `${n}.json`);
    if (existsSync(file)) records[n] = JSON.parse(readFileSync(file, "utf8"));
  }
  return records;
}

function glyph(id, unitId, type, extra = {}) {
  return {
    id,
    label: "formula",
    confidence: 1,
    rule: "human",
    unitId,
    unitType: type,
    equationNumber: false,
    ...extra
  };
}

async function putItem(origin, queueIndex, unit, elements, reviewed = true) {
  return fetch(`${origin}/api/item/${queueIndex}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queueIndex,
      paperId: unit.paperId,
      page: unit.page,
      unitId: unit.unitId,
      elementIds: elements.map((element) => element.id),
      elements,
      reviewed
    })
  });
}

test("undoing a merge clears mergedInto and restoring one item does not leave an empty record", async () => {
  const base = mkdtempSync(join(tmpdir(), "review-manifest-undo-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-undo-out-"));
  const made = trioCorpus(base);
  const id3 = made.u3.elementIds[0];
  const id5 = made.u5.elementIds[0];
  const id7 = made.u7.elementIds[0];
  const options = { root: base, manifestIndexes: [3, 5, 7], outDir };
  try {
    await withServer(options, async (origin) => {
      const mergedId = unitIdFromMembers([id3, id5]);
      const merged = await putItem(origin, 5, made.units[4], [
        glyph(id3, mergedId, "inline"),
        glyph(id5, mergedId, "inline")
      ]);
      assert.equal(merged.status, 200);
      let records = readOutRecords(outDir, [3, 5, 7]);
      assert.equal(records[3].annotation.mergedInto, undefined);
      assert.deepEqual(records[3].annotation.elementIds, [id3, id5]);
      assert.equal(records[5].annotation.mergedInto, 3);
      assert.deepEqual(records[5].annotation.elementIds, []);
      assert.equal(records[5].annotation.reviewed, true);
      assert.equal(records[5].annotation.mergedInto === 5, false);
      assert.deepEqual(manifestMergeIssues(trioQueueUnits(made), records), []);
      const skip = await (await fetch(`${origin}/api/review-nav?from=3&move=unreviewed`)).json();
      assert.deepEqual(skip, { queueIndex: 7, end: false });

      const reverted = await putItem(origin, 3, made.units[2], [
        glyph(id3, made.u3.id, "inline", { confidence: 0.22, rule: "math-font" }),
        glyph(id5, made.u5.id, "inline", { confidence: 0.32, rule: "math-font" })
      ], false);
      assert.equal(reverted.status, 200);
      records = readOutRecords(outDir, [3, 5, 7]);
      assert.equal(records[5].annotation.mergedInto, undefined);
      assert.deepEqual(records[5].annotation.elementIds, [id5]);
      assert.deepEqual(records[3].annotation.elementIds, [id3]);
      assert.equal(records[3].annotation.mergedInto, undefined);
      assert.deepEqual(manifestMergeIssues(trioQueueUnits(made), records), []);

      const swallowed = unitIdFromMembers([id3, id5, id7]);
      const wide = await putItem(origin, 7, made.units[6], [
        glyph(id3, swallowed, "display"),
        glyph(id5, swallowed, "display"),
        glyph(id7, swallowed, "display")
      ]);
      assert.equal(wide.status, 200);
      records = readOutRecords(outDir, [3, 5, 7]);
      assert.equal(records[3].annotation.mergedInto, undefined);
      assert.deepEqual(records[3].annotation.elementIds, [id3, id5, id7]);
      assert.equal(records[5].annotation.mergedInto, 3);
      assert.equal(records[7].annotation.mergedInto, 3);
      assert.deepEqual(records[5].annotation.elementIds, []);
      assert.deepEqual(records[7].annotation.elementIds, []);
      assert.deepEqual(manifestMergeIssues(trioQueueUnits(made), records), []);

      const onlySelf = await putItem(origin, 3, made.units[2], [
        glyph(id3, made.u3.id, "inline")
      ]);
      assert.equal(onlySelf.status, 200);
      records = readOutRecords(outDir, [3, 5, 7]);
      assert.equal(records[3].annotation.mergedInto, undefined);
      assert.deepEqual(records[3].annotation.elementIds, [id3]);
      assert.equal(records[5].annotation.mergedInto, undefined);
      assert.deepEqual(records[5].annotation.elementIds, [id5, id7]);
      assert.equal(records[7].annotation.mergedInto, 5);
      assert.deepEqual(records[7].annotation.elementIds, []);
      assert.equal(records[7].annotation.mergedInto === 3, false);
      assert.deepEqual(manifestMergeIssues(trioQueueUnits(made), records), []);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("item saves reject cross-page and out-of-manifest element ids", async () => {
  const base = mkdtempSync(join(tmpdir(), "review-manifest-ids-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-ids-out-"));
  const made = syntheticCorpus(base);
  const textId = "text-glyph-token";
  const prelabel = join(base, "labels/prelabel", INSIDE, "page-001.json");
  const page = JSON.parse(readFileSync(prelabel, "utf8"));
  page.elements.push({
    id: textId,
    kind: "glyph",
    char: "t",
    font: "CMR10",
    bbox: [70, 0, 80, 10],
    label: "text",
    confidence: 1,
    rule: "human"
  });
  writeFileSync(prelabel, JSON.stringify(page));
  const keptId = made.kept.elementIds[0];
  const outsideId = made.outside.elements[0].id;
  const outsiderId = made.units[3].elementIds[0];
  try {
    await withServer({ root: base, manifestIndexes: [1, 3], outDir }, async (origin) => {
      const cross = await putItem(origin, 1, made.units[0], [
        glyph(keptId, made.kept.id, "inline"),
        glyph(outsideId, made.kept.id, "inline")
      ]);
      assert.equal(cross.status, 400);
      assert.equal(existsSync(join(outDir, "1.json")), false);
      const outsider = await putItem(origin, 1, made.units[0], [
        glyph(keptId, made.kept.id, "inline"),
        glyph(outsiderId, made.kept.id, "inline")
      ]);
      assert.equal(outsider.status, 400);
      assert.equal(existsSync(join(outDir, "1.json")), false);
      const text = await putItem(origin, 1, made.units[0], [
        glyph(keptId, made.kept.id, "inline"),
        { id: textId, label: "text", confidence: 1, rule: "human", unitId: null, unitType: null, equationNumber: false }
      ]);
      assert.equal(text.status, 200);
      const saved = readFileSync(join(outDir, "1.json"), "utf8");
      const record = JSON.parse(saved);
      assert.deepEqual(record.annotation.elementIds, [keptId, textId]);
      const again = await putItem(origin, 1, made.units[0], [
        glyph(keptId, made.kept.id, "inline"),
        glyph(outsideId, made.kept.id, "inline")
      ]);
      assert.equal(again.status, 400);
      assert.equal(readFileSync(join(outDir, "1.json"), "utf8"), saved);
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("a later merge still saves after another edit, and a split recalculates mergedInto", async () => {
  const review = readFileSync(new URL("../tools/label-review/review.js", import.meta.url), "utf8");
  const body = review.slice(review.indexOf("function itemBody"), review.indexOf("const SAVED_FIELDS"));
  assert.match(body, /const elements = \[\.\.\.\(page\?\.elements \|\| \[\]\)\];/);
  assert.match(body, /elementIds: elements\.map/);
  assert.match(review, /else if \(key === "s"\) split\(\)/);
  const base = mkdtempSync(join(tmpdir(), "review-manifest-split-"));
  const outDir = mkdtempSync(join(tmpdir(), "review-manifest-split-out-"));
  const made = trioCorpus(base);
  const id3 = made.u3.elementIds[0];
  const id5 = made.u5.elementIds[0];
  const id7 = made.u7.elementIds[0];
  try {
    await withServer({ root: base, manifestIndexes: [3, 5, 7], outDir }, async (origin) => {
      const edited = await putItem(origin, 5, made.units[4], [
        glyph(id5, made.u5.id, "inline", { confidence: 0.9, rule: "human" })
      ]);
      assert.equal(edited.status, 200);
      const mergedId = unitIdFromMembers([id3, id5]);
      const merged = await putItem(origin, 3, made.units[2], [
        glyph(id3, mergedId, "display"),
        glyph(id5, mergedId, "display", { confidence: 0.9, rule: "human" }),
        glyph(id7, made.u7.id, "display", { confidence: 0.42, rule: "math-font" })
      ]);
      assert.equal(merged.status, 200);
      let records = readOutRecords(outDir, [3, 5, 7]);
      assert.equal(records[5].annotation.mergedInto, 3);
      assert.equal(records[7].annotation.mergedInto, undefined);
      assert.deepEqual(records[7].annotation.elementIds, [id7]);
      const kept = records[3].annotation.elements.find((element) => element.id === id5);
      assert.equal(kept.rule, "human");
      assert.equal(kept.confidence, 0.9);
      assert.deepEqual(manifestMergeIssues(trioQueueUnits(made), records), []);

      const split = await putItem(origin, 3, made.units[2], [
        glyph(id3, made.u3.id, "inline"),
        glyph(id5, made.u5.id, "inline", { confidence: 0.9, rule: "human" }),
        glyph(id7, made.u7.id, "display", { confidence: 0.42, rule: "math-font" })
      ], false);
      assert.equal(split.status, 200);
      records = readOutRecords(outDir, [3, 5, 7]);
      assert.equal(records[5].annotation.mergedInto, undefined);
      assert.deepEqual(records[5].annotation.elementIds, [id5]);
      assert.equal(records[5].annotation.elements[0].rule, "human");
      assert.equal(records[3].annotation.mergedInto, undefined);
      assert.deepEqual(records[3].annotation.elementIds, [id3]);
      assert.deepEqual(manifestMergeIssues(trioQueueUnits(made), records), []);
      const reloaded = await (await fetch(`${origin}/api/page/${made.paper}/1`)).json();
      assert.deepEqual(verifyPageLabels(reloaded.page), []);
      const separated = reloaded.page.elements.find((element) => element.id === id5);
      assert.equal(separated.unitId, made.u5.id);
      assert.equal(separated.rule, "human");
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
