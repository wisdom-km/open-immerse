/**
 * Download the M1 corpus and check SHA-256.
 * PDFs go to corpus/pdfs/ and are gitignored.
 *
 *   node scripts/corpus-fetch.mjs
 *
 * If tests/fixtures/DDPM_2006.11239.pdf is already on disk and its hash
 * matches 2006.11239, that file is accepted as the local copy.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const manifestPath = join(root, "corpus/manifest.json");
const pdfDir = join(root, "corpus/pdfs");
const ddpmFixture = join(root, "tests/fixtures/DDPM_2006.11239.pdf");

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

function localOverride(doc) {
  if (doc.id === "2006.11239" && existsSync(ddpmFixture)) return ddpmFixture;
  return "";
}

async function download(url) {
  const response = await fetch(url, {
    headers: { "user-agent": "OpenImmerseM1/1.0" },
    redirect: "follow"
  });
  if (!response.ok) throw new Error(`下载失败 ${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchCorpus({ manifest = manifestPath, dir = pdfDir, force = false } = {}) {
  const corpus = JSON.parse(readFileSync(manifest, "utf8"));
  mkdirSync(dir, { recursive: true });
  const results = [];
  for (const doc of corpus.documents) {
    const dest = join(dir, `${doc.id}.pdf`);
    const override = localOverride(doc);
    if (!force && existsSync(dest)) {
      const hash = await sha256File(dest);
      if (hash !== doc.sha256) throw new Error(`${doc.id} 本地文件哈希是 ${hash}，清单要求 ${doc.sha256}`);
      console.log(`${doc.id} 已存在 ${hash}`);
      results.push({ id: doc.id, path: dest, hash, cached: true });
      continue;
    }
    if (override) {
      const hash = await sha256File(override);
      if (hash !== doc.sha256) throw new Error(`${doc.id} 夹具 ${override} 哈希是 ${hash}，清单要求 ${doc.sha256}`);
      writeFileSync(dest, readFileSync(override));
      console.log(`${doc.id} 使用 tests/fixtures/DDPM_2006.11239.pdf ${hash}`);
      results.push({ id: doc.id, path: dest, hash, cached: true });
      continue;
    }
    const bytes = await download(doc.url);
    const hash = sha256Buffer(bytes);
    if (hash !== doc.sha256) throw new Error(`${doc.id} 下载哈希是 ${hash}，清单要求 ${doc.sha256}`);
    if (!bytes.slice(0, 5).equals(Buffer.from("%PDF-"))) throw new Error(`${doc.id} 不是 PDF`);
    const temp = `${dest}.part`;
    writeFileSync(temp, bytes);
    renameSync(temp, dest);
    console.log(`${doc.id} ${hash} ${bytes.length} bytes`);
    results.push({ id: doc.id, path: dest, hash, cached: false });
  }
  return results;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  fetchCorpus({ force: process.argv.includes("--force") }).catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
