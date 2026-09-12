import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DOCUMENTS_COPY, isPlainTextFile, progressStatus, splitSegments } from "../lib/documents-ui.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(root, "documents/documents.html"), "utf8");
const css = readFileSync(join(root, "documents/documents.css"), "utf8");
const src = readFileSync(join(root, "documents/documents.js"), "utf8");
const tokens = readFileSync(join(root, "ui/tokens.css"), "utf8");
const learningHtml = readFileSync(join(root, "learning/learning.html"), "utf8");
const learningCss = readFileSync(join(root, "learning/learning.css"), "utf8");

test("D1 empty translate asks to paste or pick a file", () => {
  assert.equal(DOCUMENTS_COPY.emptyTranslate, "请先粘贴或选择文件");
  assert.match(src, /DOCUMENTS_COPY\.emptyTranslate/);
  assert.match(src, /source\.value\.trim\(\)/);
});

test("D2 progress copy is 正在翻译第 k / n 段", () => {
  assert.equal(progressStatus(2, 5), "正在翻译第 2 / 5 段");
  assert.match(src, /progressStatus\(/);
});

test("D3 done copy allows in-place edit then export", () => {
  assert.equal(DOCUMENTS_COPY.done, "完成。可直接改译文后导出。");
  assert.match(src, /DOCUMENTS_COPY\.done/);
});

test("D4 PDF / layout files ask to paste body", () => {
  assert.equal(DOCUMENTS_COPY.layoutUnsupported, "暂不解析排版，请粘贴正文。");
  assert.equal(isPlainTextFile("notes.pdf"), false);
  assert.equal(isPlainTextFile("notes.docx"), false);
  assert.equal(isPlainTextFile("book.epub"), false);
  assert.equal(isPlainTextFile("notes.txt"), true);
  assert.match(src, /DOCUMENTS_COPY\.layoutUnsupported/);
});

test("D5 empty results copy and no modal overlay", () => {
  assert.equal(DOCUMENTS_COPY.emptyOut, "译文会出现在这里。");
  assert.match(html, /class="empty-out">译文会出现在这里。</);
  assert.equal(html.includes("<dialog"), false);
  assert.equal(/modal|fullscreen|overlay/.test(html), false);
  assert.equal(/modal|fullscreen|overlay/.test(css), false);
  assert.equal(/modal|fullscreen|overlay/.test(src), false);
});

test("D6 button hierarchy: Primary / Secondary / Ghost — not three solid accent", () => {
  assert.match(html, /id="run"[^>]*class="btn-primary">开始翻译</);
  assert.match(html, /id="export"[^>]*class="btn-secondary"[^>]*disabled>导出 HTML</);
  assert.match(html, /id="stop"[^>]*class="btn-ghost"[^>]*disabled>停止</);
  assert.match(css, /\.btn-primary[^}]*background:\s*var\(--oi-accent\)/);
  assert.match(css, /\.btn-secondary[^}]*background:\s*transparent/);
  assert.match(css, /\.btn-ghost[^}]*background:\s*transparent/);
  assert.match(css, /button\s*\{[^}]*background:\s*transparent/);
  assert.equal(/button\s*\{[^}]*background:\s*var\(--oi-accent\)/.test(css), false);
});

test("shell matches learning: Dual Line, 文档翻译, 720 page, tokens", () => {
  assert.equal(DOCUMENTS_COPY.title, "文档翻译");
  assert.match(html, /<title>文档翻译<\/title>/);
  assert.match(html, /<h1>文档翻译<\/h1>/);
  assert.match(html, /class="mark"/);
  assert.match(html, /ui\/tokens\.css/);
  assert.match(learningHtml, /class="mark"/);
  assert.match(css, /max-width:\s*720px/);
  assert.match(css, /padding:\s*40px 24px 80px/);
  assert.match(css, /font:\s*15px\/1\.6 var\(--oi-font\)/);
  assert.match(learningCss, /max-width:\s*720px/);
  assert.match(tokens, /--oi-focus:\s*var\(--oi-accent\)/);
  assert.equal(/沉浸译|Open Immerse/.test(html), false);
  assert.equal(html.includes("完整排版保留"), false);
});

test("lead, pick button, textarea, pair columns, fail retry", () => {
  assert.equal(DOCUMENTS_COPY.lead, "TXT / Markdown / HTML 可直读。PDF / DOCX / EPUB 请粘贴正文。");
  assert.match(html, /TXT \/ Markdown \/ HTML 可直读。PDF \/ DOCX \/ EPUB 请粘贴正文。/);
  assert.match(html, /id="pick"[^>]*class="btn-secondary">选择文件</);
  assert.match(html, /id="file"[^>]*hidden/);
  assert.match(html, /accept="\.txt,\.md,\.html,\.htm,\.pdf,\.docx,\.epub"/);
  assert.match(html, /PDF \/ DOCX \/ EPUB 暂不解析排版，请粘贴正文/);
  assert.match(html, /placeholder="粘贴要翻译的正文，空行分段"/);
  assert.match(css, /textarea[^}]*min-height:\s*140px/);
  assert.match(css, /textarea[^}]*border-radius:\s*8px/);
  assert.match(css, /textarea[^}]*padding:\s*14px/);
  assert.match(css, /\.btn-primary[^}]*padding:\s*8px 14px/);
  assert.match(css, /\.btn-primary[^}]*min-height:\s*36px/);
  assert.match(css, /\.btn-primary[^}]*border-radius:\s*8px/);
  assert.match(css, /\.btn-primary[^}]*font-weight:\s*600/);
  assert.match(css, /\.pair[^}]*border-radius:\s*12px/);
  assert.match(css, /@media \(min-width:\s*720px\)\s*\{\s*\.pair\s*\{[^}]*grid-template-columns:\s*1fr 1fr/);
  assert.equal(DOCUMENTS_COPY.segmentFail, "本段失败");
  assert.equal(DOCUMENTS_COPY.retry, "重试");
  assert.match(src, /DOCUMENTS_COPY\.segmentFail/);
  assert.match(src, /className = "btn-ghost"/);
  assert.match(src, /contentEditable = "true"/);
});

test("documents.js keeps batch translate / HTML export and wires Stop", () => {
  assert.match(src, /OI_TRANSLATE_BATCH/);
  assert.match(src, /const size = 6/);
  assert.match(src, /open-immerse-bilingual\.html/);
  assert.match(src, /import\s*\{[^}]*escapeHtml[^}]*\}\s*from\s*["']\.\.\/lib\/html\.js["']/);
  assert.match(src, /stopBtn/);
  assert.match(src, /aborted = true/);
  assert.equal(src.includes("function escapeHtml"), false);
  assert.deepEqual(splitSegments("Hello world.\n\nSecond paragraph here."), [
    "Hello world.",
    "Second paragraph here."
  ]);
});

test("documents two-step applies draft progress then replaces in place", () => {
  assert.equal(DOCUMENTS_COPY.translating, "翻译中…");
  assert.equal(DOCUMENTS_COPY.polishing, "润色中…");
  assert.match(src, /OI_TRANSLATE_PROGRESS/);
  assert.match(src, /DOCUMENTS_COPY\.translating/);
  assert.match(src, /DOCUMENTS_COPY\.polishing/);
  assert.match(src, /applyDocumentProgress/);
  assert.match(src, /message\.phase !== "draft"/);
  assert.match(src, /if \(pairIndex < pairs\.length\) pairs\[pairIndex\] = pair;/);
});
