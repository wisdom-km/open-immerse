import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { getDocument, GlobalWorkerOptions } from "../../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../../lib/pdf-text-layer.js";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

export const ATTENTION_PDF = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
export const ATTENTION_PDF_SHA = "bdfaa68d8984f0dc02beaca527b76f207d99b666d31d1da728ee0728182df697";
export const SRC_V7 = join(root, "tests/fixtures/arxiv-src/1706.03762v7.tar.gz");
export const SRC_V1 = join(root, "tests/fixtures/arxiv-src/1706.03762v1.tar.gz");
export const SRC_V7_SHA = "2e7a7d9ee2520d22eb23dae0cb148e167be02a30d6cb3f11b1c67723194339c6";
export const SRC_V1_SHA = "377b47ecf3cd8638f7214184cc445cb378b37b5f0ddb42981b1ad288b3a1c03b";

export function requireFile(path, sha, hint) {
  if (!existsSync(path)) {
    throw new Error(`缺 ${path}：${hint} sha256 应为 ${sha}`);
  }
  const hash = createHash("sha256").update(readFileSync(path)).digest("hex");
  if (hash !== sha) throw new Error(`${path} sha256 ${hash}，应为 ${sha}`);
  return readFileSync(path);
}

export function loadKatex() {
  const katexPath = join(root, "pdf/vendor/katex/katex.min.js");
  const katexModule = new (require("module").Module)(katexPath);
  katexModule.filename = katexPath;
  katexModule.paths = require("module").Module._nodeModulePaths(dirname(katexPath));
  katexModule._compile(readFileSync(katexPath, "utf8"), katexPath);
  return katexModule.exports;
}

function glyphsOf(items, viewport) {
  const vw = Math.max(1, viewport.width);
  const vh = Math.max(1, viewport.height);
  return items.filter((item) => String(item.str || "").trim()).map((item) => {
    const transform = item.transform || [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const rect = viewport.convertToViewportRectangle([
      x, y, x + (Number(item.width) || 0), y + (Number(item.height) || 0)
    ]);
    const [x1, y1, x2, y2] = rect;
    return {
      str: String(item.str || ""),
      fontName: String(item.fontName || ""),
      bbox: [
        Math.min(x1, x2) / vw,
        Math.min(y1, y2) / vh,
        Math.max(x1, x2) / vw,
        Math.max(y1, y2) / vh
      ]
    };
  });
}

export async function loadAttentionPages() {
  requireFile(ATTENTION_PDF, ATTENTION_PDF_SHA, "把 Attention v7 PDF 放到 tests/fixtures/。");
  GlobalWorkerOptions.workerSrc = new URL("../../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;
  const bytes = readFileSync(ATTENTION_PDF);
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const pages = [];
  const items = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const viewport = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const built = textLayerToBlocks({
        items: content.items,
        viewport,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      pages.push({
        page: number,
        blocks: built.blocks,
        glyphs: glyphsOf(content.items, viewport)
      });
      items.push(content.items);
    }
  } finally {
    await doc.destroy();
  }
  return { pages, items };
}

export async function loadSource(path, sha, hint) {
  const { unpackSource } = await import("../../lib/arxiv-src-unpack.js");
  const bytes = requireFile(path, sha, hint);
  return unpackSource(bytes, { gunzip: (data) => gunzipSync(data) });
}

export async function parsePacked(packed, katex) {
  const { parseLatexSource } = await import("../../lib/latex-units.js");
  return parseLatexSource(packed.files, { katex });
}
