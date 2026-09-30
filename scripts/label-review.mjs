/**
 * Local review page for formula labels. Not product UI.
 *
 *   node scripts/corpus-fetch.mjs
 *   node scripts/corpus-prelabel.mjs
 *   node scripts/label-review.mjs
 *
 * Then open the printed URL in Chrome. The default queue is
 * labels/review-set.json. Confirmed units are stored in
 * labels/reviewed/<paper>/page-NNN.json and can be committed.
 *
 * Manifest mode keeps that path unchanged unless both flags are set:
 *
 *   node scripts/label-review.mjs --manifest batch.txt --out-dir D:\review\out
 *
 * The queue, navigation, and page marks stay inside the manifest.
 * Each saved item is out-dir/<N>.json. labels/reviewed/ is not read or written.
 */
import { createReadStream as openReadStream, existsSync as pathExists, lstatSync as pathLstat, mkdirSync as makeDir, readFileSync as readFile, realpathSync as realPath, statSync as pathStat, writeFileSync as writeFile } from "node:fs";
import { createServer } from "node:http";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPageLabels } from "../lib/label-schema.js";
import { rebuildFormulaUnits } from "../lib/review-actions.js";
import { renderContactSheet } from "./contact-sheet.mjs";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const port = Number(process.env.PORT || 4173);
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

let reviewPathTrace = null;

/** Test hook. Records every filesystem path this module is about to touch. */
export function setReviewPathTrace(listener) {
  reviewPathTrace = typeof listener === "function" ? listener : null;
}

function notePath(path) {
  if (reviewPathTrace && path != null) reviewPathTrace(String(path));
}

function tracedExists(path) {
  notePath(path);
  return pathExists(path);
}

function tracedRead(path, encoding) {
  notePath(path);
  return encoding === undefined ? readFile(path) : readFile(path, encoding);
}

function tracedStat(path) {
  notePath(path);
  return pathStat(path);
}

function tracedMkdir(path, options) {
  notePath(path);
  return makeDir(path, options);
}

function tracedWrite(path, data) {
  notePath(path);
  return writeFile(path, data);
}

function tracedRealpath(path) {
  notePath(path);
  return realPath(path);
}

function tracedLstat(path) {
  notePath(path);
  return pathLstat(path);
}

function tracedStream(path) {
  notePath(path);
  return openReadStream(path);
}

function readJson(path) {
  return JSON.parse(tracedRead(path, "utf8"));
}

function pagePath(base, dir, paperId, page) {
  return join(base, dir, paperId, `page-${String(page).padStart(3, "0")}.json`);
}

const MANIFEST_PAIR = "清单模式要同时给出 --manifest 和 --out-dir";
const OUTSIDE_MANIFEST = "不在本次清单内";
const OUTSIDE_REPO = "输出目录必须在仓库根目录之外";

export function parseReviewArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  let manifest = null;
  let outDir = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== "--manifest" && arg !== "--out-dir") continue;
    const value = args[index + 1];
    if (value == null || String(value).startsWith("--")) throw new Error(MANIFEST_PAIR);
    if (arg === "--manifest") manifest = value;
    else outDir = value;
    index += 1;
  }
  if ((manifest == null) !== (outDir == null)) throw new Error(MANIFEST_PAIR);
  return { manifest, outDir };
}

/**
 * Manifest bytes from PowerShell 5.1 `>` / `Out-File` (UTF-16LE plus BOM)
 * or UTF-8 with an optional BOM.
 */
export function decodeManifestBytes(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes.subarray(2).toString("utf16le");
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  return bytes.toString("utf8");
}

/** One `#N` per line. Blank lines and trailing whitespace are allowed. */
export function parseManifestText(text) {
  let source = String(text ?? "");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const lines = source.split(/\r?\n/);
  const seen = new Set();
  const indexes = [];
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed === "") continue;
    const match = /^#(\d+)$/.exec(trimmed);
    if (!match) throw new Error("清单格式不对：每行要是 # 加编号");
    const n = Number(match[1]);
    if (!Number.isInteger(n) || n < 1) throw new Error("清单编号超出复核集范围");
    if (seen.has(n)) throw new Error("清单里有重复编号");
    seen.add(n);
    indexes.push(n);
  }
  if (!indexes.length) throw new Error("清单是空的");
  return indexes;
}

export function ensureManifestInRange(indexes, length) {
  const total = Number(length);
  if (!Number.isInteger(total) || total < 1) throw new Error("清单编号超出复核集范围");
  for (const n of indexes) {
    if (!Number.isInteger(n) || n < 1 || n > total) throw new Error("清单编号超出复核集范围");
  }
  return indexes;
}

function realizePath(target) {
  const abs = resolve(target);
  if (tracedExists(abs)) return tracedRealpath(abs);
  const parent = dirname(abs);
  if (parent === abs) return abs;
  return join(realizePath(parent), basename(abs));
}

function pathIsInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assertOutDirOutsideRepo(outDir, repoRoot) {
  if (typeof outDir !== "string" || outDir.trim() === "") throw new Error(OUTSIDE_REPO);
  const repoReal = tracedRealpath(repoRoot);
  const abs = resolve(outDir);
  const realOut = realizePath(abs);
  if (tracedExists(abs) && !tracedStat(realOut).isDirectory()) throw new Error("输出目录必须是目录");
  if (pathIsInside(repoReal, realOut)) throw new Error(OUTSIDE_REPO);
  return realOut;
}

/**
 * Parse the manifest and resolve the output directory before the review
 * set is opened. `loadLength` must not run when the directory is rejected.
 */
export function openManifestSession({ manifestText, outDir, repoRoot, loadLength }) {
  const indexes = parseManifestText(manifestText);
  const resolvedOut = assertOutDirOutsideRepo(outDir, repoRoot);
  const length = loadLength();
  ensureManifestInRange(indexes, length);
  return { indexes, outDir: resolvedOut };
}

export function unitsForManifest(units, indexes) {
  const list = Array.isArray(units) ? units : [];
  const out = [];
  for (const n of indexes || []) {
    const unit = list[n - 1];
    if (!unit) continue;
    out.push({ ...unit, queueIndex: n });
  }
  return out;
}

export function stepManifest(indexes, from, move, reviewed) {
  const list = Array.isArray(indexes) ? indexes : [];
  const done = reviewed instanceof Set ? reviewed : new Set(reviewed || []);
  if (!list.length) return { ok: false, error: OUTSIDE_MANIFEST };
  if (move === "first") {
    const pending = list.find((n) => !done.has(n));
    return { ok: true, queueIndex: pending == null ? list[0] : pending, end: false };
  }
  const origin = Number(from);
  const pos = list.indexOf(origin);
  if (!Number.isInteger(origin) || pos < 0) return { ok: false, error: OUTSIDE_MANIFEST };
  if (move === "prev") {
    if (pos === 0) return { ok: true, queueIndex: list[0], end: true };
    return { ok: true, queueIndex: list[pos - 1], end: false };
  }
  if (move === "next") {
    if (pos + 1 >= list.length) return { ok: true, queueIndex: list[pos], end: true };
    return { ok: true, queueIndex: list[pos + 1], end: false };
  }
  if (move === "unreviewed") {
    const pending = list.slice(pos + 1).find((n) => !done.has(n));
    if (pending == null) return { ok: true, queueIndex: list[pos], end: true };
    return { ok: true, queueIndex: pending, end: false };
  }
  return { ok: false, error: OUTSIDE_MANIFEST };
}

function reviewSetLength(base) {
  const path = join(base, "labels/review-set.json");
  if (!tracedExists(path)) throw new Error("找不到复核集");
  try {
    const data = JSON.parse(tracedRead(path, "utf8"));
    if (!Array.isArray(data?.units)) throw new Error("复核集读取失败");
    return data.units.length;
  } catch (error) {
    if (error instanceof Error && error.message === "复核集读取失败") throw error;
    throw new Error("复核集读取失败");
  }
}

function manifestCovers(units, paperId, page) {
  return units.some((unit) => unit.paperId === paperId && Number(unit.page) === Number(page));
}

const LABEL_FIELDS = ["label", "confidence", "rule", "unitId", "unitType", "equationNumber"];

function send(response, statusCode, body, type = "application/json; charset=utf-8") {
  response.writeHead(statusCode, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

const REVIEW_RUNTIME = {
  "/tools/label-review/runtime/label-schema.js": join(root, "lib/label-schema.js"),
  "/tools/label-review/runtime/sha256.js": join(root, "lib/sha256.js"),
  "/tools/label-review/runtime/review-actions.js": join(root, "lib/review-actions.js"),
  "/tools/label-review/runtime/pdf.min.mjs": join(root, "pdf/vendor/pdf.min.mjs"),
  "/tools/label-review/runtime/pdf.worker.min.mjs": join(root, "pdf/vendor/pdf.worker.min.mjs")
};

function requestPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(urlPath || "").split("?")[0]);
  } catch {
    return "";
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) return "";
  if (decoded.split("/").includes("..")) return "";
  return decoded;
}

function staticPath(base, urlPath) {
  const decoded = requestPath(urlPath);
  if (!decoded) return "";
  const full = normalize(join(base, decoded));
  if (full !== base && !full.startsWith(base + sep)) return "";
  return full;
}

const REVIEW_FRONTEND = new Set([
  "/tools/label-review/index.html",
  "/tools/label-review/review.js",
  "/tools/label-review/review.css"
]);

function fileInsideDir(file, dir) {
  try {
    const listed = tracedLstat(file);
    if (!listed.isFile() && !listed.isSymbolicLink()) return "";
    const realFile = tracedRealpath(file);
    const realDir = tracedRealpath(dir);
    if (!pathIsInside(realDir, realFile)) return "";
    if (!tracedStat(realFile).isFile()) return "";
    return realFile;
  } catch {
    return "";
  }
}

function runtimeStaticTarget(urlPath) {
  const decoded = requestPath(urlPath);
  const expected = Object.prototype.hasOwnProperty.call(REVIEW_RUNTIME, decoded) ? REVIEW_RUNTIME[decoded] : "";
  if (!expected) return "";
  return fileInsideDir(expected, dirname(expected));
}

function manifestFrontendTarget(base, urlPath) {
  const decoded = requestPath(urlPath);
  if (!REVIEW_FRONTEND.has(decoded)) return "";
  const full = staticPath(base, decoded);
  if (!full) return "";
  return fileInsideDir(full, join(base, "tools/label-review"));
}

function sendStatic(response, file) {
  if (!file) {
    send(response, 404, "not found", "text/plain; charset=utf-8");
    return;
  }
  let info;
  try {
    info = tracedStat(file);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR" || error.code === "EISDIR")) {
      send(response, 404, "not found", "text/plain; charset=utf-8");
      return;
    }
    throw error;
  }
  if (!info.isFile()) {
    send(response, 404, "not found", "text/plain; charset=utf-8");
    return;
  }
  response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
  const stream = tracedStream(file);
  stream.on("error", (error) => {
    stream.destroy();
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const missing = error && (error.code === "EISDIR" || error.code === "ENOENT" || error.code === "ENOTDIR");
    send(response, missing ? 404 : 500, missing ? "not found" : JSON.stringify({ error: error.message || String(error) }), missing ? "text/plain; charset=utf-8" : "application/json; charset=utf-8");
  });
  stream.pipe(response);
}

function pdfFile(pdfDir, paperId) {
  if (!paperId || paperId.includes("..") || paperId.includes("/") || paperId.includes("\\")) return "";
  const file = join(pdfDir, `${paperId}.pdf`);
  if (!tracedExists(file)) return "";
  return file;
}

/**
 * Local review server. PDF responses set Content-Length and always end.
 * `pdfPending()` is the number of PDF bodies still open; it must return to
 * 0 after each page open once the client reads or cancels the body.
 */
export function createReviewServer({ pdfDir, root: baseOverride, manifestIndexes = null, outDir = "" } = {}) {
  const base = baseOverride || root;
  const pdfRoot = pdfDir || join(base, "corpus/pdfs");
  const manifestMode = Array.isArray(manifestIndexes);
  const indexes = manifestMode ? manifestIndexes.map((n) => Number(n)) : [];
  let prelabelIndex = null;
  let reviewCache = null;

  function loadReviewSet() {
    if (reviewCache) return reviewCache;
    const path = join(base, "labels/review-set.json");
    reviewCache = tracedExists(path) ? readJson(path) : { units: [] };
    return reviewCache;
  }

  function manifestUnits() {
    return unitsForManifest(loadReviewSet().units || [], indexes);
  }

  function reviewedIndexSet() {
    const done = new Set();
    if (!manifestMode) return done;
    for (const n of indexes) {
      const file = join(outDir, `${n}.json`);
      if (!tracedExists(file)) continue;
      try {
        const data = readJson(file);
        if (data?.annotation?.reviewed === true) done.add(n);
      } catch {
        continue;
      }
    }
    return done;
  }

  function loadPrelabelIndex() {
    const manifest = readJson(join(base, "corpus/manifest.json"));
    const pages = [];
    let formulaUnits = 0;
    for (const doc of manifest.documents) {
      for (let page = 1; page <= doc.pageCount; page += 1) {
        const pre = pagePath(base, "labels/prelabel", doc.id, page);
        let uncertain = 0;
        if (tracedExists(pre)) {
          const prelabel = readJson(pre);
          formulaUnits += prelabel.units?.length || 0;
          uncertain = (prelabel.elements || []).filter((element) => Number(element.confidence) < 0.75).length;
        }
        pages.push({ paperId: doc.id, page, field: doc.field, uncertain });
      }
    }
    prelabelIndex = { pages, formulaUnits };
  }

  function legacyStatus() {
    if (!prelabelIndex) loadPrelabelIndex();
    const queue = [];
    let reviewedPages = 0;
    const reviewedByPage = new Map();
    for (const entry of prelabelIndex.pages) {
      const reviewed = pagePath(base, "labels/reviewed", entry.paperId, entry.page);
      let uncertain = entry.uncertain;
      if (tracedExists(reviewed)) {
        reviewedPages += 1;
        const data = readJson(reviewed);
        uncertain = (data.elements || []).filter((element) => Number(element.confidence) < 0.75).length;
        reviewedByPage.set(`${entry.paperId}:${entry.page}`, data.reviewedUnitIds || []);
      }
      if (uncertain > 0) queue.push({ paperId: entry.paperId, page: entry.page, uncertain, field: entry.field });
    }
    queue.sort((a, b) => b.uncertain - a.uncertain || a.paperId.localeCompare(b.paperId) || a.page - b.page);
    const reviewSet = loadReviewSet();
    const reviewedKeys = [];
    for (const unit of reviewSet.units || []) {
      const ids = reviewedByPage.get(`${unit.paperId}:${unit.page}`) || [];
      if (ids.includes(unit.unitId)) reviewedKeys.push(`${unit.paperId}:${unit.page}:${unit.unitId}`);
    }
    return {
      pages: prelabelIndex.pages.length,
      reviewedPages,
      formulaUnits: prelabelIndex.formulaUnits,
      queue,
      reviewTarget: (reviewSet.units || []).length,
      reviewedUnits: reviewedKeys.length,
      reviewedKeys
    };
  }

  function manifestStatus() {
    const units = manifestUnits();
    const done = reviewedIndexSet();
    const reviewedKeys = [];
    const pages = new Map();
    for (const unit of units) {
      if (done.has(unit.queueIndex)) reviewedKeys.push(`${unit.paperId}:${unit.page}:${unit.unitId}`);
      const key = `${unit.paperId}:${unit.page}`;
      if (pages.has(key)) continue;
      const pre = pagePath(base, "labels/prelabel", unit.paperId, unit.page);
      let uncertain = 0;
      if (tracedExists(pre)) {
        const visible = presentManifestPage(readJson(pre), unit.paperId, unit.page).page;
        uncertain = (visible.elements || []).filter((element) => Number(element.confidence) < 0.75).length;
      }
      pages.set(key, { paperId: unit.paperId, page: unit.page, uncertain, field: unit.field });
    }
    const queue = [...pages.values()];
    queue.sort((a, b) => b.uncertain - a.uncertain || a.paperId.localeCompare(b.paperId) || a.page - b.page);
    const reviewedPages = new Set(units.filter((unit) => done.has(unit.queueIndex)).map((unit) => `${unit.paperId}:${unit.page}`)).size;
    return {
      manifestMode: true,
      pages: queue.length,
      reviewedPages,
      formulaUnits: 0,
      queue,
      reviewTarget: units.length,
      reviewedUnits: reviewedKeys.length,
      reviewedKeys
    };
  }

  function readManifestRecord(queueIndex) {
    const file = join(outDir, `${queueIndex}.json`);
    if (!tracedExists(file)) return null;
    try {
      return readJson(file);
    } catch {
      return null;
    }
  }

  function writeManifestRecord(queueIndex, annotation, writtenAt) {
    const record = { queueIndex, writtenAt, annotation };
    tracedMkdir(outDir, { recursive: true });
    tracedWrite(join(outDir, `${queueIndex}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }

  function markAbsorbedUnits(unit, elementIds, writtenAt) {
    const claimed = new Set(elementIds.map(String));
    for (const other of manifestUnits()) {
      if (other.queueIndex === unit.queueIndex) continue;
      if (other.paperId !== unit.paperId || Number(other.page) !== Number(unit.page)) continue;
      const saved = readManifestRecord(other.queueIndex);
      const owned = new Set((other.elementIds || []).map(String));
      for (const id of saved?.annotation?.elementIds || []) owned.add(String(id));
      for (const element of saved?.annotation?.elements || []) {
        if (element?.id) owned.add(String(element.id));
      }
      if (![...owned].some((id) => claimed.has(id))) continue;
      writeManifestRecord(other.queueIndex, {
        paperId: other.paperId,
        page: other.page,
        unitId: other.unitId,
        type: other.type,
        equationNumber: other.equationNumber === true,
        elementIds: [],
        elements: [],
        reviewed: saved?.annotation?.reviewed === true,
        mergedInto: unit.queueIndex
      }, writtenAt);
    }
  }

  function overlayManifestPage(prelabel, paperId, page) {
    const pageData = structuredClone(prelabel);
    const byId = new Map((pageData.elements || []).map((element) => [element.id, element]));
    const reviewedIds = [];
    let applied = false;
    const records = [];
    for (const unit of manifestUnits()) {
      if (unit.paperId !== paperId || Number(unit.page) !== Number(page)) continue;
      const saved = readManifestRecord(unit.queueIndex);
      if (!saved) continue;
      records.push({ unit, saved, writtenAt: String(saved.writtenAt || "") });
    }
    records.sort((a, b) => {
      const time = a.writtenAt.localeCompare(b.writtenAt);
      if (time !== 0) return time;
      const aLive = a.saved?.annotation?.mergedInto == null ? 1 : 0;
      const bLive = b.saved?.annotation?.mergedInto == null ? 1 : 0;
      return aLive - bLive;
    });
    for (const { unit, saved } of records) {
      const annotation = saved.annotation || {};
      if (annotation.reviewed === true && unit.unitId) reviewedIds.push(unit.unitId);
      if (annotation.mergedInto != null) continue;
      applied = true;
      for (const element of annotation.elements || []) {
        const target = element?.id ? byId.get(element.id) : null;
        if (!target) continue;
        for (const field of LABEL_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(element, field)) target[field] = element[field];
        }
      }
    }
    if (reviewedIds.length) pageData.reviewedUnitIds = reviewedIds;
    return { page: pageData, applied };
  }

  function restrictManifestPage(pageData, paperId, page) {
    const onPage = manifestUnits().filter((unit) => unit.paperId === paperId && Number(unit.page) === Number(page));
    const seeds = new Set();
    const savedIds = new Set();
    for (const unit of onPage) {
      for (const id of unit.elementIds || []) seeds.add(String(id));
      const saved = readManifestRecord(unit.queueIndex);
      if (!saved || saved.annotation?.mergedInto != null) continue;
      for (const id of saved.annotation?.elementIds || []) savedIds.add(String(id));
      for (const element of saved.annotation?.elements || []) {
        if (element?.id) savedIds.add(String(element.id));
      }
    }
    const live = new Set();
    for (const element of pageData.elements || []) {
      if (!element?.unitId) continue;
      if (seeds.has(String(element.id)) || savedIds.has(String(element.id))) live.add(element.unitId);
    }
    pageData.elements = (pageData.elements || []).filter((element) => {
      if (!element) return false;
      const id = String(element.id);
      if (seeds.has(id) || savedIds.has(id)) return true;
      if (element.unitId && live.has(element.unitId)) return true;
      return !element.unitId && element.label !== "formula";
    });
    pageData.units = rebuildFormulaUnits(pageData.elements);
    if (Array.isArray(pageData.reviewedUnitIds)) {
      const kept = new Set(onPage.map((unit) => unit.unitId));
      pageData.reviewedUnitIds = pageData.reviewedUnitIds.filter((id) => kept.has(id));
      if (!pageData.reviewedUnitIds.length) delete pageData.reviewedUnitIds;
    }
    return pageData;
  }

  function presentManifestPage(prelabel, paperId, page) {
    const overlaid = overlayManifestPage(prelabel, paperId, page);
    return {
      source: overlaid.applied ? "manifest" : "prelabel",
      page: restrictManifestPage(overlaid.page, paperId, page),
      prelabel: restrictManifestPage(structuredClone(prelabel), paperId, page)
    };
  }

  function labelForSheet(paperId, page) {
    if (manifestMode) {
      if (!manifestCovers(manifestUnits(), paperId, page)) return "";
      const pre = pagePath(base, "labels/prelabel", paperId, page);
      if (!tracedExists(pre)) return "";
      return presentManifestPage(readJson(pre), paperId, page).page;
    }
    const reviewed = pagePath(base, "labels/reviewed", paperId, page);
    const pre = pagePath(base, "labels/prelabel", paperId, page);
    if (tracedExists(reviewed)) return readJson(reviewed);
    if (tracedExists(pre)) return readJson(pre);
    return "";
  }

  let pendingPdf = 0;
  let maxPendingPdf = 0;
  const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`);
    if (url.pathname === "/favicon.ico") {
      response.writeHead(204, { "cache-control": "public, max-age=86400" });
      response.end();
      return;
    }
    if (url.pathname === "/") {
      response.writeHead(302, { location: `/tools/label-review/index.html${url.search}` });
      response.end();
      return;
    }
    if (url.pathname === "/api/manifest" && request.method === "GET") {
      const raw = tracedRead(join(base, "corpus/manifest.json"));
      if (!manifestMode) {
        send(response, 200, raw);
        return;
      }
      const data = JSON.parse(raw.toString("utf8"));
      const papers = new Set(manifestUnits().map((unit) => unit.paperId));
      const documents = (Array.isArray(data?.documents) ? data.documents : []).filter((doc) => papers.has(doc?.id));
      send(response, 200, JSON.stringify({ documents }));
      return;
    }
    if (url.pathname === "/api/status" && request.method === "GET") {
      send(response, 200, JSON.stringify(manifestMode ? manifestStatus() : legacyStatus()));
      return;
    }
    if (url.pathname === "/api/review-set" && request.method === "GET") {
      const path = join(base, "labels/review-set.json");
      if (!tracedExists(path)) {
        send(response, 404, JSON.stringify({ error: "还没有复核集。先运行 node scripts/review-set.mjs" }));
        return;
      }
      if (!manifestMode) {
        send(response, 200, tracedRead(path));
        return;
      }
      const set = readJson(path);
      send(response, 200, JSON.stringify({
        schema: set.schema,
        manifestMode: true,
        units: manifestUnits()
      }));
      return;
    }
    if (manifestMode && url.pathname === "/api/review-nav" && request.method === "GET") {
      const move = url.searchParams.get("move") || "";
      const fromText = url.searchParams.get("from");
      let from = null;
      if (fromText != null && fromText !== "") {
        if (!/^\d+$/.test(fromText)) {
          send(response, 404, JSON.stringify({ error: OUTSIDE_MANIFEST }));
          return;
        }
        from = Number(fromText);
      }
      const step = stepManifest(indexes, from, move, reviewedIndexSet());
      if (!step.ok) {
        send(response, 404, JSON.stringify({ error: OUTSIDE_MANIFEST }));
        return;
      }
      send(response, 200, JSON.stringify({ queueIndex: step.queueIndex, end: step.end === true }));
      return;
    }
    const unitMatch = url.pathname.match(/^\/api\/review-unit\/(\d+)$/);
    if (manifestMode && unitMatch && request.method === "GET") {
      const n = Number(unitMatch[1]);
      const unit = manifestUnits().find((item) => item.queueIndex === n);
      if (!unit) {
        send(response, 404, JSON.stringify({ error: OUTSIDE_MANIFEST }));
        return;
      }
      send(response, 200, JSON.stringify(unit));
      return;
    }
    const itemMatch = url.pathname.match(/^\/api\/item\/(\d+)$/);
    if (manifestMode && itemMatch && request.method === "PUT") {
      const raw = await readBody(request);
      const n = Number(itemMatch[1]);
      const unit = manifestUnits().find((item) => item.queueIndex === n);
      if (!unit) {
        send(response, 404, JSON.stringify({ error: OUTSIDE_MANIFEST }));
        return;
      }
      let body;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        send(response, 400, JSON.stringify({ error: "标注格式不对" }));
        return;
      }
      if (body?.queueIndex != null && Number(body.queueIndex) !== n) {
        send(response, 400, JSON.stringify({ error: "标注格式不对" }));
        return;
      }
      if (body?.paperId !== unit.paperId || Number(body?.page) !== Number(unit.page) || body?.unitId !== unit.unitId) {
        send(response, 400, JSON.stringify({ error: "标注和这一条对不上" }));
        return;
      }
      if (!Array.isArray(body?.elementIds) || body.elementIds.length === 0) {
        send(response, 400, JSON.stringify({ error: "标注格式不对" }));
        return;
      }
      const elementIds = body.elementIds.map(String);
      const idSet = new Set(elementIds);
      const elements = (Array.isArray(body?.elements) ? body.elements : [])
        .filter((element) => element && idSet.has(String(element.id)))
        .map((element) => {
          const copy = { id: String(element.id) };
          for (const field of LABEL_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(element, field)) copy[field] = element[field];
          }
          return copy;
        });
      const record = {
        queueIndex: n,
        writtenAt: new Date().toISOString(),
        annotation: {
          paperId: unit.paperId,
          page: unit.page,
          unitId: unit.unitId,
          type: body?.type === "display" || body?.type === "inline" ? body.type : unit.type,
          equationNumber: body?.equationNumber === true,
          elementIds,
          elements,
          reviewed: body?.reviewed === true
        }
      };
      writeManifestRecord(n, record.annotation, record.writtenAt);
      markAbsorbedUnits(unit, elementIds, record.writtenAt);
      send(response, 200, JSON.stringify({ ok: true }));
      return;
    }
    const pageMatch = url.pathname.match(/^\/api\/page\/([^/]+)\/(\d+)$/);
    if (pageMatch && request.method === "GET") {
      const paperId = decodeURIComponent(pageMatch[1]);
      const page = Number(pageMatch[2]);
      if (manifestMode && !manifestCovers(manifestUnits(), paperId, page)) {
        send(response, 404, JSON.stringify({ error: OUTSIDE_MANIFEST }));
        return;
      }
      const pre = pagePath(base, "labels/prelabel", paperId, page);
      if (!tracedExists(pre)) {
        send(response, 404, JSON.stringify({ error: "还没有这一页的预标注" }));
        return;
      }
      const prelabel = readJson(pre);
      if (manifestMode) {
        send(response, 200, JSON.stringify(presentManifestPage(prelabel, paperId, page)));
        return;
      }
      const reviewed = pagePath(base, "labels/reviewed", paperId, page);
      send(response, 200, JSON.stringify({
        source: tracedExists(reviewed) ? "reviewed" : "prelabel",
        page: readJson(tracedExists(reviewed) ? reviewed : pre),
        prelabel
      }));
      return;
    }
    if (pageMatch && request.method === "PUT") {
      const raw = await readBody(request);
      if (manifestMode) {
        send(response, 400, JSON.stringify({ error: "清单模式不写复核稿" }));
        return;
      }
      const paperId = decodeURIComponent(pageMatch[1]);
      const page = Number(pageMatch[2]);
      const data = JSON.parse(raw);
      const issues = verifyPageLabels(data);
      if (issues.length) {
        send(response, 400, JSON.stringify({ error: issues }));
        return;
      }
      data.source = "reviewed";
      const dest = pagePath(base, "labels/reviewed", paperId, page);
      tracedMkdir(join(base, "labels/reviewed", paperId), { recursive: true });
      tracedWrite(dest, JSON.stringify(data));
      send(response, 200, JSON.stringify({ ok: true }));
      return;
    }
    const pdfMatch = url.pathname.match(/^\/api\/pdf\/([^/]+)$/);
    if (pdfMatch && (request.method === "GET" || request.method === "HEAD")) {
      const paperId = decodeURIComponent(pdfMatch[1]);
      if (manifestMode && !manifestUnits().some((unit) => unit.paperId === paperId)) {
        send(response, 404, JSON.stringify({ error: OUTSIDE_MANIFEST }));
        return;
      }
      const file = pdfFile(pdfRoot, paperId);
      if (!file) {
        send(response, 404, JSON.stringify({ error: "PDF 不在 corpus/pdfs。先运行 node scripts/corpus-fetch.mjs" }));
        return;
      }
      const size = tracedStat(file).size;
      const headers = {
        "content-type": "application/pdf",
        "content-length": String(size),
        "cache-control": "no-store"
      };
      if (request.method === "HEAD") {
        response.writeHead(200, headers);
        response.end();
        return;
      }
      pendingPdf += 1;
      if (pendingPdf > maxPendingPdf) maxPendingPdf = pendingPdf;
      response.writeHead(200, headers);
      const stream = tracedStream(file);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        pendingPdf = Math.max(0, pendingPdf - 1);
      };
      response.on("finish", finish);
      response.on("close", () => {
        stream.destroy();
        finish();
      });
      stream.on("error", () => {
        stream.destroy();
        if (!response.writableEnded) response.destroy();
        finish();
      });
      stream.pipe(response);
      return;
    }
    const sheetMatch = url.pathname.match(/^\/api\/sheet\/([^/]+)\/(\d+)$/);
    if (sheetMatch && request.method === "GET") {
      const paperId = decodeURIComponent(sheetMatch[1]);
      const page = Number(sheetMatch[2]);
      if (manifestMode && !manifestCovers(manifestUnits(), paperId, page)) {
        send(response, 404, JSON.stringify({ error: OUTSIDE_MANIFEST }));
        return;
      }
      const label = labelForSheet(paperId, page);
      if (!label) {
        send(response, 404, JSON.stringify({ error: manifestMode ? OUTSIDE_MANIFEST : "还没有这一页的预标注" }));
        return;
      }
      const files = await renderContactSheet({
        paperId,
        pageNumber: page,
        pdfPath: join(base, "corpus/pdfs", `${paperId}.pdf`),
        label
      });
      const items = files.map((file) => {
        const name = file.file.split(/[\\/]/).pop();
        return `<figure><img src="/labels/sheets/${paperId}/${name}" alt=""><figcaption>缺笔 ${file.missing} · 对齐 ${file.solid}</figcaption></figure>`;
      }).join("");
      send(response, 200, `<!DOCTYPE html><meta charset="utf-8"><title>接触图</title><style>body{font-family:sans-serif}img{max-width:100%;background:white}figure{margin:12px 0}</style><h1>${paperId} 第 ${page} 页</h1><p>从左到右：页面轮廓、基线 SVG、差异（红 = 页面有而 SVG 没有，蓝 = SVG 多出来的）。</p>${items}`, "text/html; charset=utf-8");
      return;
    }
    const runtimeFile = runtimeStaticTarget(url.pathname);
    if (runtimeFile) {
      sendStatic(response, runtimeFile);
      return;
    }
    const file = manifestMode ? manifestFrontendTarget(base, url.pathname) : staticPath(base, url.pathname);
    sendStatic(response, file);
  } catch (error) {
    send(response, 500, JSON.stringify({ error: error.message || String(error) }));
  }
  });
  return {
    server,
    pdfPending: () => pendingPdf,
    maxPdfPending: () => maxPendingPdf
  };
}

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.split("\n")[0]);
  process.exit(1);
}

function readManifestFile(file) {
  try {
    return decodeManifestBytes(tracedRead(file));
  } catch {
    throw new Error("找不到清单文件");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let args;
  try {
    args = parseReviewArgs(process.argv.slice(2));
  } catch (error) {
    fail(error);
  }
  let session = null;
  if (args.manifest) {
    try {
      session = openManifestSession({
        manifestText: readManifestFile(args.manifest),
        outDir: args.outDir,
        repoRoot: root,
        loadLength: () => reviewSetLength(root)
      });
    } catch (error) {
      fail(error);
    }
    try {
      tracedMkdir(session.outDir, { recursive: true });
    } catch {
      fail(new Error("输出目录无法创建"));
    }
  }
  const { server } = session
    ? createReviewServer({ manifestIndexes: session.indexes, outDir: session.outDir })
    : createReviewServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`复核页 http://127.0.0.1:${port}/`);
    if (session) console.log("清单模式。标注写到仓库外的目录，不会改 labels/reviewed/。");
    else console.log("在 Windows Chrome 打开上面的地址。改动会自动写到 labels/reviewed/。");
  });
}
