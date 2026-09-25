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
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPageLabels } from "../lib/label-schema.js";
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

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function pagePath(dir, paperId, page) {
  return join(root, dir, paperId, `page-${String(page).padStart(3, "0")}.json`);
}

let prelabelIndex = null;

function loadPrelabelIndex() {
  const manifest = readJson(join(root, "corpus/manifest.json"));
  const pages = [];
  let formulaUnits = 0;
  for (const doc of manifest.documents) {
    for (let page = 1; page <= doc.pageCount; page += 1) {
      const pre = pagePath("labels/prelabel", doc.id, page);
      let uncertain = 0;
      if (existsSync(pre)) {
        const prelabel = readJson(pre);
        formulaUnits += prelabel.units?.length || 0;
        uncertain = (prelabel.elements || []).filter((element) => Number(element.confidence) < 0.75).length;
      }
      pages.push({ paperId: doc.id, page, field: doc.field, uncertain });
    }
  }
  prelabelIndex = { pages, formulaUnits };
}

function loadReviewSet() {
  const path = join(root, "labels/review-set.json");
  if (!existsSync(path)) return { units: [] };
  return readJson(path);
}

function status() {
  if (!prelabelIndex) loadPrelabelIndex();
  const queue = [];
  let reviewedPages = 0;
  const reviewedByPage = new Map();
  for (const entry of prelabelIndex.pages) {
    const reviewed = pagePath("labels/reviewed", entry.paperId, entry.page);
    let uncertain = entry.uncertain;
    if (existsSync(reviewed)) {
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

function staticPath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  if (!decoded.startsWith("/") || decoded.includes("\0")) return "";
  const full = normalize(join(root, decoded));
  if (full !== root && !full.startsWith(root + sep)) return "";
  return full;
}

function pdfFile(pdfDir, paperId) {
  if (!paperId || paperId.includes("..") || paperId.includes("/") || paperId.includes("\\")) return "";
  const file = join(pdfDir, `${paperId}.pdf`);
  if (!existsSync(file)) return "";
  return file;
}

/**
 * Local review server. PDF responses set Content-Length and always end.
 * `pdfPending()` is the number of PDF bodies still open; it must return to
 * 0 after each page open once the client reads or cancels the body.
 */
export function createReviewServer({ pdfDir = join(root, "corpus/pdfs") } = {}) {
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
      response.writeHead(302, { location: "/tools/label-review/index.html" });
      response.end();
      return;
    }
    if (url.pathname === "/api/manifest" && request.method === "GET") {
      send(response, 200, readFileSync(join(root, "corpus/manifest.json")));
      return;
    }
    if (url.pathname === "/api/status" && request.method === "GET") {
      send(response, 200, JSON.stringify(status()));
      return;
    }
    if (url.pathname === "/api/review-set" && request.method === "GET") {
      const path = join(root, "labels/review-set.json");
      if (!existsSync(path)) {
        send(response, 404, JSON.stringify({ error: "还没有复核集。先运行 node scripts/review-set.mjs" }));
        return;
      }
      send(response, 200, readFileSync(path));
      return;
    }
    const pageMatch = url.pathname.match(/^\/api\/page\/([^/]+)\/(\d+)$/);
    if (pageMatch && request.method === "GET") {
      const paperId = decodeURIComponent(pageMatch[1]);
      const page = Number(pageMatch[2]);
      const reviewed = pagePath("labels/reviewed", paperId, page);
      const pre = pagePath("labels/prelabel", paperId, page);
      if (!existsSync(pre)) {
        send(response, 404, JSON.stringify({ error: "还没有这一页的预标注" }));
        return;
      }
      send(response, 200, JSON.stringify({
        source: existsSync(reviewed) ? "reviewed" : "prelabel",
        page: readJson(existsSync(reviewed) ? reviewed : pre),
        prelabel: readJson(pre)
      }));
      return;
    }
    if (pageMatch && request.method === "PUT") {
      const paperId = decodeURIComponent(pageMatch[1]);
      const page = Number(pageMatch[2]);
      const data = JSON.parse(await readBody(request));
      const issues = verifyPageLabels(data);
      if (issues.length) {
        send(response, 400, JSON.stringify({ error: issues }));
        return;
      }
      data.source = "reviewed";
      const dest = pagePath("labels/reviewed", paperId, page);
      mkdirSync(join(root, "labels/reviewed", paperId), { recursive: true });
      writeFileSync(dest, JSON.stringify(data));
      send(response, 200, JSON.stringify({ ok: true }));
      return;
    }
    const pdfMatch = url.pathname.match(/^\/api\/pdf\/([^/]+)$/);
    if (pdfMatch && (request.method === "GET" || request.method === "HEAD")) {
      const paperId = decodeURIComponent(pdfMatch[1]);
      const file = pdfFile(pdfDir, paperId);
      if (!file) {
        send(response, 404, JSON.stringify({ error: "PDF 不在 corpus/pdfs。先运行 node scripts/corpus-fetch.mjs" }));
        return;
      }
      const size = statSync(file).size;
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
      const stream = createReadStream(file);
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
      const labelPath = existsSync(pagePath("labels/reviewed", paperId, page))
        ? pagePath("labels/reviewed", paperId, page)
        : pagePath("labels/prelabel", paperId, page);
      const files = await renderContactSheet({
        paperId,
        pageNumber: page,
        pdfPath: join(root, "corpus/pdfs", `${paperId}.pdf`),
        label: readJson(labelPath)
      });
      const items = files.map((file) => {
        const name = file.file.split(/[\\/]/).pop();
        return `<figure><img src="/labels/sheets/${paperId}/${name}" alt=""><figcaption>缺笔 ${file.missing} · 对齐 ${file.solid}</figcaption></figure>`;
      }).join("");
      send(response, 200, `<!DOCTYPE html><meta charset="utf-8"><title>接触图</title><style>body{font-family:sans-serif}img{max-width:100%;background:white}figure{margin:12px 0}</style><h1>${paperId} 第 ${page} 页</h1><p>从左到右：页面轮廓、基线 SVG、差异（红 = 页面有而 SVG 没有，蓝 = SVG 多出来的）。</p>${items}`, "text/html; charset=utf-8");
      return;
    }
    const file = staticPath(url.pathname);
    if (!file || !existsSync(file)) {
      send(response, 404, "not found", "text/plain; charset=utf-8");
      return;
    }
    response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(response);
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { server } = createReviewServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`复核页 http://127.0.0.1:${port}/`);
    console.log("在 Windows Chrome 打开上面的地址。改动会自动写到 labels/reviewed/。");
  });
}
