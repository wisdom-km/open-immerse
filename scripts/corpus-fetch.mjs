/**
 * Download the M1 corpus and check content fingerprints.
 * PDFs go to corpus/pdfs/ and are gitignored.
 *
 *   node scripts/corpus-fetch.mjs
 *   node scripts/corpus-fetch.mjs --import <dir>
 *
 * Byte SHA-256 in the manifest is informational. Verification uses
 * contentFingerprint (page text and page size via pdf.js), so a publisher
 * download stamp in the Info dictionary or XMP does not fail the check.
 *
 * A publisher bot challenge is reported and skipped. This script does not
 * spoof headers, send cookies, or drive a browser.
 *
 * If tests/fixtures/DDPM_2006.11239.pdf is already on disk and its content
 * fingerprint matches 2006.11239, that file is accepted as the local copy.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const manifestPath = join(root, "corpus/manifest.json");
const pdfDir = join(root, "corpus/pdfs");
const ddpmFixture = join(root, "tests/fixtures/DDPM_2006.11239.pdf");

export const CHALLENGE_NOTE = "出版商的机器人检查拦住了这次下载。请用浏览器打开清单里的链接，手动保存 PDF，再运行 node scripts/corpus-fetch.mjs --import <目录>。";

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function classifyPayload(bytes, contentType = "") {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const head = buffer.subarray(0, 1200);
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const text = head.toString("latin1").toLowerCase();
  const type = String(contentType || "").toLowerCase();
  if (
    type.includes("html") ||
    text.includes("<html") ||
    text.includes("<!doctype") ||
    text.includes("client challenge") ||
    text.includes("just a moment") ||
    text.includes("idp.nature.com") ||
    text.includes("idp.springer.com")
  ) {
    return "blocked-by-challenge";
  }
  return "not-pdf";
}

function localOverride(doc) {
  if (doc.id === "2006.11239" && existsSync(ddpmFixture)) return ddpmFixture;
  return "";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(error) {
  if (error?.transient === true) return true;
  const message = String(error?.message || error || "");
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|ECONNREFUSED|UND_ERR|socket hang up|network/i.test(message);
}

async function defaultFingerprint(bytes) {
  const { contentFingerprint } = await import("./m1-pdf.mjs");
  return contentFingerprint(bytes);
}

async function downloadOnce(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "user-agent": "OpenImmerseM1/1.0" },
      redirect: "follow"
    });
  } catch (error) {
    const wrapped = new Error(error?.message || String(error));
    wrapped.transient = true;
    throw wrapped;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const kind = classifyPayload(bytes, response.headers.get("content-type") || "");
  if (kind === "blocked-by-challenge") return { kind, bytes, status: response.status };
  if (!response.ok) {
    const error = new Error(`下载失败 ${response.status} ${url}`);
    error.transient = response.status === 408 || response.status === 429 || response.status >= 500;
    throw error;
  }
  return { kind, bytes, status: response.status };
}

async function downloadWithRetry(url, fetchImpl, pause) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await downloadOnce(url, fetchImpl);
    } catch (error) {
      last = error;
      if (!isTransientError(error) || attempt === 3) break;
      await pause(400 * attempt);
    }
  }
  throw last;
}

function result(id, status, extra = {}) {
  return { id, status, note: extra.note || "", path: extra.path || "", hash: extra.hash || "", fingerprint: extra.fingerprint || "", cached: extra.cached === true };
}

async function acceptBytes(doc, bytes, dest, fingerprint) {
  const kind = classifyPayload(bytes);
  if (kind === "blocked-by-challenge") return result(doc.id, "blocked-by-challenge", { note: CHALLENGE_NOTE });
  if (kind !== "pdf") return result(doc.id, "network-error", { note: "响应不是 PDF" });
  let digest;
  try {
    digest = await fingerprint(bytes);
  } catch (error) {
    return result(doc.id, "hash-mismatch", { note: `无法读取 PDF：${error.message || error}` });
  }
  if (digest !== doc.contentFingerprint) {
    const hash = sha256Buffer(bytes);
    return result(doc.id, "hash-mismatch", { note: `内容指纹是 ${digest}，清单要求 ${doc.contentFingerprint}。字节 SHA-256 ${hash} 只作记录`, hash, fingerprint: digest });
  }
  const hash = sha256Buffer(bytes);
  const temp = `${dest}.part`;
  writeFileSync(temp, bytes);
  renameSync(temp, dest);
  return result(doc.id, "ok", { path: dest, hash, fingerprint: digest, note: `字节 SHA-256 ${hash}（不用于核对）` });
}

async function verifyFile(doc, path, fingerprint) {
  const bytes = readFileSync(path);
  const kind = classifyPayload(bytes);
  if (kind === "blocked-by-challenge") return result(doc.id, "blocked-by-challenge", { note: CHALLENGE_NOTE, path });
  if (kind !== "pdf") return result(doc.id, "network-error", { note: "本地文件不是 PDF", path });
  let digest;
  try {
    digest = await fingerprint(bytes);
  } catch (error) {
    return result(doc.id, "hash-mismatch", { note: `无法读取 PDF：${error.message || error}`, path });
  }
  const hash = sha256Buffer(bytes);
  if (digest !== doc.contentFingerprint) {
    return result(doc.id, "hash-mismatch", {
      path,
      hash,
      fingerprint: digest,
      note: `内容指纹是 ${digest}，清单要求 ${doc.contentFingerprint}。字节 SHA-256 ${hash} 只作记录`
    });
  }
  return result(doc.id, "ok", { path, hash, fingerprint: digest, cached: true, note: `字节 SHA-256 ${hash}（不用于核对）` });
}

export function formatSummary(results) {
  const rows = [["id", "status", "note"], ...results.map((row) => [row.id, row.status, row.note || ""])];
  const widths = [2, 6, 4].map((min, index) => Math.max(min, ...rows.map((row) => row[index].length)));
  return rows.map((row) => row.map((cell, index) => cell.padEnd(widths[index])).join("  ")).join("\n");
}

export async function fetchCorpus({
  manifest = manifestPath,
  dir = pdfDir,
  force = false,
  importDir = "",
  fetchImpl = globalThis.fetch,
  fingerprint = defaultFingerprint,
  pause = sleep
} = {}) {
  const corpus = JSON.parse(readFileSync(manifest, "utf8"));
  mkdirSync(dir, { recursive: true });
  const results = [];
  for (const doc of corpus.documents) {
    const dest = join(dir, `${doc.id}.pdf`);
    if (!doc.contentFingerprint) {
      results.push(result(doc.id, "hash-mismatch", { note: "清单缺少 contentFingerprint" }));
      continue;
    }
    if (importDir) {
      const source = join(importDir, `${doc.id}.pdf`);
      if (!existsSync(source)) {
        console.log(`${doc.id} 不在导入目录，跳过`);
        results.push(result(doc.id, "skipped", { note: "导入目录里没有这一篇，未下载" }));
        continue;
      }
      const imported = await verifyFile(doc, source, fingerprint);
      if (imported.status === "ok") {
        if (source !== dest) {
          writeFileSync(`${dest}.part`, readFileSync(source));
          renameSync(`${dest}.part`, dest);
        }
        imported.path = dest;
        imported.note = `已从 ${source} 导入。${imported.note}`;
        console.log(`${doc.id} imported`);
        results.push(imported);
        continue;
      }
      console.log(`${doc.id} ${imported.status}`);
      results.push(imported);
      continue;
    }
    if (!force && existsSync(dest)) {
      const verified = await verifyFile(doc, dest, fingerprint);
      console.log(`${doc.id} ${verified.status}${verified.cached ? " cached" : ""}`);
      results.push(verified);
      continue;
    }
    const override = localOverride(doc);
    if (!force && override) {
      const fixture = await verifyFile(doc, override, fingerprint);
      if (fixture.status === "ok") {
        writeFileSync(dest, readFileSync(override));
        fixture.path = dest;
        fixture.note = `使用 tests/fixtures/DDPM_2006.11239.pdf。${fixture.note}`;
        console.log(`${doc.id} fixture`);
        results.push(fixture);
        continue;
      }
    }
    try {
      const downloaded = await downloadWithRetry(doc.url, fetchImpl, pause);
      if (downloaded.kind === "blocked-by-challenge") {
        const row = result(doc.id, "blocked-by-challenge", { note: CHALLENGE_NOTE });
        console.log(`${doc.id} blocked-by-challenge`);
        results.push(row);
        continue;
      }
      const accepted = await acceptBytes(doc, downloaded.bytes, dest, fingerprint);
      console.log(`${doc.id} ${accepted.status}`);
      results.push(accepted);
    } catch (error) {
      const row = result(doc.id, "network-error", { note: error?.message || String(error) });
      console.log(`${doc.id} network-error`);
      results.push(row);
    }
  }
  const table = formatSummary(results);
  console.log(table);
  const ok = results.every((row) => row.status === "ok" || row.status === "skipped");
  return { results, ok };
}

function parseArgs(argv) {
  const parsed = { force: false, importDir: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--force") parsed.force = true;
    else if (arg === "--import") {
      parsed.importDir = argv[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const parsed = parseArgs(process.argv.slice(2));
  if (process.argv.includes("--import") && !parsed.importDir) {
    console.error("用法：node scripts/corpus-fetch.mjs --import <目录>");
    process.exitCode = 1;
  } else {
    fetchCorpus({ force: parsed.force, importDir: parsed.importDir }).then((outcome) => {
      if (!outcome.ok) process.exitCode = 1;
    }).catch((error) => {
      console.error(error.stack || error.message || error);
      process.exitCode = 1;
    });
  }
}
