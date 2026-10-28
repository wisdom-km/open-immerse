import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHTML } from "linkedom";

import { getProvider, isProviderConfigured } from "../lib/providers.js";
import { POPUP_PAGE_WAIT_MS, withTimeout } from "../popup/popup-ready.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("popup IA is page-only: Dual Line, 沉浸译, no feature toggles or youtube", () => {
  const html = readFileSync(join(root, "popup/popup.html"), "utf8");
  assert.match(html, /<h1>沉浸译<\/h1>/);
  assert.match(html, /Open Immerse/);
  assert.match(html, /class="mark"/);
  assert.match(html, /class="intent-card"/);
  assert.match(html, /id="translatePage"[^>]*>翻译此页</);
  assert.match(html, /id="restorePage"[^>]*>恢复原文</);
  assert.match(html, />本站自动</);
  assert.match(html, /value="article">仅正文</);
  assert.match(html, /value="page">全页面</);
  assert.match(html, /<details class="more">/);
  assert.match(html, />更多</);
  assert.match(html, /本次额度/);
  assert.match(html, /value="title_lead">仅标题\+开头/);
  assert.match(html, /id="translateLimit"/);
  assert.match(html, /class="lang-row"/);
  assert.match(html, /id="engineLink"/);
  assert.match(html, /id="engineUnsetName">未设置/);
  assert.match(html, /id="engineSetup"[^>]*>去设置/);
  assert.match(html, /id="engineNote"/);
  assert.equal(html.includes("未配置引擎"), false);
  assert.match(html, /id="openOptions">设置</);
  assert.match(html, /id="openLearning">学习</);
  assert.match(html, /id="openDocs">文档</);
  assert.match(html, /id="openPdf"[^>]*class="btn-secondary"[^>]*>打开 PDF</);
  assert.match(html, /id="pdfEntry" hidden/);
  assert.doesNotMatch(html, /id="openPdfPage"|id="openPdfSep"/);
  assert.equal(html.includes("featureList"), false);
  assert.equal(/youtube|YouTube/i.test(html), false);
  assert.equal(html.includes("hamburger"), false);
  assert.equal(html.includes("twoStepPolish"), false);
  assert.equal(html.includes("deepThink"), false);
  assert.equal(html.includes("enableThinking"), false);
  assert.doesNotMatch(html, /进度|progress|percent|%/i);
  assert.doesNotMatch(html, /id="enabled"/);
});

test("popup CSS uses elevated dark tokens and 340px shell", () => {
  const css = readFileSync(join(root, "popup/popup.css"), "utf8");
  const tokens = readFileSync(join(root, "ui/tokens.css"), "utf8");
  assert.match(tokens, /--oi-bg-elevated:\s*#181c26/);
  assert.match(tokens, /--oi-bg:\s*#12151c/);
  assert.match(css, /width:\s*3(2\d|3\d|4\d|5\d|60)px/);
  assert.match(tokens, /height:\s*3px/);
  assert.match(tokens, /color-scheme:\s*dark/);
  assert.equal(/color-scheme:\s*light/.test(tokens + css), false);
  assert.match(tokens, /\.mark span[^}]*background:\s*var\(--oi-text\)/);
  assert.equal(/\.mark span[^}]*--oi-accent/.test(tokens), false);
});

test("options sidebar drops learning/docs links; about and popup still open them", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  const popup = readFileSync(join(root, "popup/popup.html"), "utf8");
  const js = readFileSync(join(root, "options/options.js"), "utf8");
  const aside = html.match(/<aside class="options-nav"[\s\S]*?<\/aside>/)[0];
  const about = html.match(/id="panel-about"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(aside, /brand-links|学习中心|文档翻译/);
  assert.doesNotMatch(css, /\.brand-links/);
  assert.equal(js.includes("brand-links"), false);
  assert.match(aside, /class="brand"[\s\S]*class="nav-tabs"/);
  assert.doesNotMatch(aside, /class="note"|set-nav-item/);
  assert.match(aside, /data-nav="translate"[^>]*>翻译<span class="set-badge"/);
  assert.match(aside, /data-nav="mm"[^>]*>多模态 · OCR<span class="set-badge"/);
  assert.match(aside, /data-nav="web"[^>]*>网页</);
  assert.match(aside, /data-nav="pdf"[^>]*>PDF 阅读</);
  assert.match(aside, /data-nav="notes"[^>]*>笔记</);
  assert.match(aside, /data-nav="labs"[^>]*>功能与实验室</);
  assert.match(aside, /data-nav="data"[^>]*>数据与隐私<span class="set-badge"/);
  assert.match(aside, /data-nav="about"[^>]*>关于</);
  assert.doesNotMatch(aside, /data-nav="advanced"/);
  assert.match(about, /学习中心[\s\S]{0,240}href="\.\.\/learning\/learning\.html">打开/);
  assert.match(about, /文档翻译[\s\S]{0,240}href="\.\.\/documents\/documents\.html">打开/);
  assert.match(popup, /id="openLearning">学习/);
  assert.match(popup, /id="openDocs">文档/);
  assert.doesNotMatch(css, /\.note a\s*\{[^}]*--oi-accent/);
  assert.match(css, /\.nav-tabs\s*\{[^}]*margin-top:\s*22px/s);
  assert.match(css, /\.nav-tabs\s*\{[^}]*border-top:\s*0/s);
});

test("options save bar is a quiet sticky Loom bar", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  assert.doesNotMatch(html, />保存设置</);
  assert.match(html, /class="actions-bar"/);
  assert.match(html, /class="bar"/);
  assert.match(html, /id="exportSettings"[^>]*>导出设置/);
  assert.match(html, /id="importSettings"[^>]*>导入设置/);
  assert.doesNotMatch(html, /id="save"/);
  assert.match(css, /padding:\s*8px 14px/);
  assert.match(css, /min-height:\s*36px/);
  assert.match(css, /\.btn-primary[^}]*font-weight:\s*600/);
  assert.match(css, /\.btn-secondary[^}]*font-weight:\s*500/);
  assert.match(css, /\.btn-secondary[^}]*background:\s*transparent/);
  assert.match(css, /\.actions-bar[^}]*box-shadow:\s*none/);
  assert.equal(/font-weight:\s*700/.test(css), false);
});

test("options keep v1 module gates; youtube\/x only in Advanced group", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  const featSrc = readFileSync(join(root, "lib/features.js"), "utf8");
  assert.match(html, /data-nav="translate"[^>]*>翻译/);
  assert.match(html, /data-nav="labs"[^>]*>功能与实验室</);
  assert.doesNotMatch(html, /data-nav="advanced"/);
  assert.doesNotMatch(html, /data-nav="engine"/);
  assert.match(html, /id="featureList"/);
  assert.match(html, /id="twoStepPolishLabel">先信后润/);
  assert.match(html, /id="twoStepPolishHint">先直译再润色，质量更好，更耗 token</);
  const translatePanel = html.match(/id="panel-translate"[\s\S]*?<\/section>/)[0];
  const labsPanel = html.match(/id="panel-labs"[\s\S]*?<\/section>/)[0];
  const webPanel = html.match(/id="panel-web"[\s\S]*?<\/section>/)[0];
  const readingPanel = html.match(/id="panel-pdf"[\s\S]*?<\/section>/)[0];
  assert.match(translatePanel, /id="twoStepPolish"/);
  assert.match(translatePanel, /id="deepThink"/);
  assert.match(labsPanel, /id="featureList"/);
  assert.match(labsPanel, /id="laterList"/);
  assert.doesNotMatch(labsPanel, /twoStepPolish/);
  assert.doesNotMatch(html, /<details class="later">/);
  assert.doesNotMatch(html, /id="autoOnNewPages"[\s\S]{0,80}id="twoStepPolish"/);
  assert.doesNotMatch(html, /两步译（先信后润）/);
  assert.doesNotMatch(html, /id="translateQuality"/);
  assert.doesNotMatch(html, /id="translationStyle"/);
  assert.doesNotMatch(html, /译文样式/);
  assert.doesNotMatch(html, /preview|双语预览|样式说明/i);
  assert.match(html, /id="batchSizeLabel">每批条数</);
  assert.match(html, /一次请求翻几段，1–20/);
  assert.doesNotMatch(html, /每批条数（分批，不是总数）/);
  assert.doesNotMatch(readingPanel, /id="fontScale"/);
  assert.match(readingPanel, /id="bodyGlossGap"/);
  assert.match(readingPanel, /正文译文间距/);
  assert.match(readingPanel, /id="bodyGlossStackGap"/);
  assert.match(readingPanel, /译文段间距/);
  assert.match(webPanel, /id="fontScale"/);
  assert.match(webPanel, /id="translateScope"/);
  assert.doesNotMatch(readingPanel, /id="translateScope"|id="featureList"|id="provider"/);
  assert.match(html, /id="bodyGlossGap"[^>]*type="number"/);
  assert.match(html, /id="bodyGlossStackGap"[^>]*type="number"/);
  assert.doesNotMatch(html, /type="range"/);
  assert.doesNotMatch(html, /id="bodyGlossGapValue"/);
  assert.match(html, /min="0.10"/);
  assert.match(html, /max="0.70"/);
  assert.match(html, /id="bodyGlossStackGap"[^>]*max="2.5"/);
  assert.match(html, /step="0.05"/);
  assert.match(html, /原文与其下段落译文的空隙（em）。不影响标题译文。/);
  assert.match(html, /相邻两段正文译文之间的空隙（em，0–2\.5，默认 0\.25）。不含标题译文、侧栏。/);
  assert.match(html, /本次翻译/);
  assert.match(html, /value="title_lead">仅标题\+开头/);
  for (const id of ["webpage", "learning", "documents", "fab"]) {
    assert.match(featSrc, new RegExp(`id: "${id}"[\\s\\S]*group: "v1"`));
  }
  for (const id of ["hover", "selection", "youtube", "x"]) {
    assert.match(featSrc, new RegExp(`id: "${id}"[\\s\\S]*group: "later"`));
  }
  assert.match(featSrc, /id: "pdf"[\s\S]*group: "pdf"/);
  assert.match(featSrc, /youtube:\s*false/);
  assert.match(featSrc, /x:\s*false/);
  assert.match(featSrc, /pdf:\s*true/);
  assert.match(featSrc, /label: "PDF 阅读"/);
  assert.doesNotMatch(featSrc, /PDF 阅读（实验室）/);
  assert.doesNotMatch(html, /pdf\/viewer\.html/);
  const optJs = readFileSync(join(root, "options/options.js"), "utf8");
  assert.match(optJs, /el\("twoStepPolish"\)\.checked = settings\.twoStepPolish === true/);
  assert.match(optJs, /twoStepPolish: el\("twoStepPolish"\)\.checked/);
  assert.match(optJs, /el\("deepThink"\)\.checked = settings\.deepThink === true/);
  assert.match(optJs, /deepThink: el\("deepThink"\)\.checked/);
  assert.match(optJs, /normalizeBodyGlossGap/);
  assert.match(optJs, /normalizeBodyGlossStackGap/);
  assert.match(optJs, /el\("bodyGlossGap"\)\.value = String\(normalizeBodyGlossGap/);
  assert.match(optJs, /el\("bodyGlossStackGap"\)\.value = String\(normalizeBodyGlossStackGap/);
  assert.match(optJs, /bodyGlossGap: normalizeBodyGlossGap\(el\("bodyGlossGap"\)\.value\)/);
  assert.match(optJs, /bodyGlossStackGap: normalizeBodyGlossStackGap\(el\("bodyGlossStackGap"\)\.value\)/);
  assert.match(optJs, /translationStyle: cachedSettings\.translationStyle \|\| "under"/);
  assert.match(optJs, /function bindPanelNav/);
  assert.doesNotMatch(optJs, /syncBodyGlossGapLabel/);
  assert.doesNotMatch(optJs, /el\("translationStyle"\)/);
});

test("popup engine link uses short name + full title; lang-row stays 1fr 1fr", () => {
  const js = readFileSync(join(root, "popup/popup.js"), "utf8");
  const css = readFileSync(join(root, "popup/popup.css"), "utf8");
  const html = readFileSync(join(root, "popup/popup.html"), "utf8");
  assert.match(js, /function renderEngine/);
  assert.match(js, /openai:\s*"OpenAI"/);
  assert.match(js, /custom:\s*"Custom"/);
  assert.match(js, /引擎：\$\{shortName\}/);
  assert.match(js, /link\.title = provider\.name/);
  assert.match(js, /described\.mode === "borrow"/);
  assert.match(js, /engineMissing = true/);
  assert.match(js, /unset\.hidden = false/);
  assert.match(js, /NO_ENGINE_COPY\.body/);
  assert.doesNotMatch(js, /const ok = borrowed \|\|/);
  assert.doesNotMatch(js, /warn\.hidden/);
  assert.doesNotMatch(js, /借用/);
  assert.doesNotMatch(js, /formatBorrowedEngine/);
  assert.doesNotMatch(js, /engine-borrow/);
  assert.match(js, /openOptionsPage/);
  assert.match(html, /class="lang-row"/);
  assert.match(html, /id="engineLink"/);
  assert.match(css, /\.lang-row\s*\{[^}]*grid-template-columns:\s*1fr 1fr/s);
  assert.match(css, /\.engine-link\s*\{[^}]*text-overflow:\s*ellipsis/s);
});

test("popup PDF entries stay hidden unless features.pdf is on", () => {
  const js = readFileSync(join(root, "popup/popup.js"), "utf8");
  const html = readFileSync(join(root, "popup/popup.html"), "utf8");
  assert.match(js, /import \{ featureOn \} from "\.\.\/lib\/features\.js"/);
  assert.match(js, /featureOn\(settings,\s*"pdf"\)/);
  assert.match(js, /\$\("pdfEntry"\)\.hidden = !pdfOn/);
  assert.match(js, /if \(!featureOn\(settings, "pdf"\)\) return/);
  assert.match(html, /id="pdfEntry" hidden/);
  assert.doesNotMatch(js, /openPdfPage|openPdfSep/);
  assert.doesNotMatch(html, /openPdfPage|openPdfSep/);
});

test("popup footer links bind before the active-tab ping", () => {
  const js = readFileSync(join(root, "popup/popup.js"), "utf8");
  const init = js.slice(js.indexOf("async function init"), js.indexOf("function setPrimaryBusy"));
  const ping = init.indexOf("syncPrimary(");
  assert.ok(ping > 0);
  assert.equal(init.includes("await syncPrimary"), false);
  for (const id of ["openOptions", "openLearning", "openDocs"]) {
    const at = init.indexOf(`$("${id}").addEventListener`);
    assert.ok(at >= 0 && at < ping, id);
  }
  assert.match(init, /openOptionsPage/);
  assert.match(init, /OI_OPEN_PAGE", page: "learning"/);
  assert.match(init, /OI_OPEN_PAGE", page: "documents"/);
});

test("popup primary is 翻译此页→停止; restore is separate; no progress chrome", () => {
  const js = readFileSync(join(root, "popup/popup.js"), "utf8");
  const html = readFileSync(join(root, "popup/popup.html"), "utf8");
  const css = readFileSync(join(root, "popup/popup.css"), "utf8");
  assert.match(js, /PRIMARY_IDLE = "翻译此页"/);
  assert.match(js, /PRIMARY_STOP = "停止"/);
  assert.match(js, /type: "OI_START"/);
  assert.match(js, /type: "OI_STOP"/);
  assert.match(js, /type: "OI_RESTORE"/);
  assert.match(js, /ping\?\.inflight/);
  assert.match(js, /setPrimaryBusy/);
  const startClick = js.slice(js.indexOf('$("translatePage").addEventListener'), js.indexOf('$("restorePage").addEventListener'));
  assert.match(startClick, /OI_STOP/);
  assert.equal(startClick.includes("OI_RESTORE"), false);
  assert.match(html, /id="restorePage"/);
  assert.doesNotMatch(html, /进度|progress-bar|oi-progress/i);
  assert.doesNotMatch(css, /progress|percent|进度/i);
  assert.doesNotMatch(js, /进度|percent|progress-bar/i);
});

test("isProviderConfigured requires apiKey when the adapter marks it required", () => {
  const paid = getProvider("openai");
  assert.equal(paid.id, "openai");
  assert.equal(isProviderConfigured(paid, {}), false);
  assert.equal(isProviderConfigured(paid, { apiKey: "sk-test" }), true);
  const free = getProvider("mymemory");
  assert.equal(isProviderConfigured(free, {}), true);
});

function popupSources() {
  return {
    html: readFileSync(join(root, "popup/popup.html"), "utf8"),
    css: readFileSync(join(root, "popup/popup.css"), "utf8"),
    js: readFileSync(join(root, "popup/popup.js"), "utf8")
  };
}

function openPdfClick(js) {
  const start = js.indexOf('$("openPdf").addEventListener');
  const end = js.indexOf("armTabWatch();", start);
  assert.ok(start >= 0 && end > start);
  return js.slice(start, end);
}

function popupPdfEntrySource() {
  const lib = readFileSync(join(root, "lib/pdf-viewer.js"), "utf8");
  const start = lib.indexOf("export async function openPopupPdfEntry");
  const end = lib.indexOf("export function isPdfViewerPage");
  assert.ok(start >= 0 && end > start);
  return lib.slice(start, end);
}

test("PPE-01 pdf on shows 打开 PDF on every page, one label, no lab copy", () => {
  const { html, js } = popupSources();
  assert.match(html, /id="openPdf"[^>]*class="btn-secondary"[^>]*>打开 PDF</);
  assert.equal([...html.matchAll(/>打开 PDF</g)].length, 1);
  assert.doesNotMatch(html, /实验室|在沉浸译中打开/);
  assert.doesNotMatch(js, /实验室|在沉浸译中打开/);
  assert.match(js, /\$\("pdfEntry"\)\.hidden = !pdfOn/);
  assert.doesNotMatch(js, /\$\("pdfEntry"\)\.hidden = !\(pdfOn && pdfTab\)/);
  assert.doesNotMatch(js, /\$\("openPdf"\)\.textContent/);
});

test("PPE-02 打开 PDF is its own row under the more block", () => {
  const { html, css } = popupSources();
  const cardStart = html.indexOf('<section class="intent-card">');
  const translate = html.indexOf('id="translatePage"', cardStart);
  const restore = html.indexOf('id="restorePage"', cardStart);
  const more = html.indexOf('<details class="more">', cardStart);
  const open = html.indexOf('id="openPdf"', cardStart);
  assert.ok(cardStart >= 0 && translate > cardStart && restore > translate && more > restore && open > more);
  assert.match(html, /class="action-row"[\s\S]*id="translatePage"[\s\S]*id="restorePage"/);
  assert.match(html, /class="group-sep"[\s\S]*id="openPdf"/);
  assert.match(css, /\.btn-secondary\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.btn-secondary\s*\{[^}]*margin-top:\s*8px/s);
  assert.match(css, /#pdfEntry \.btn-secondary\s*\{[^}]*margin-top:\s*0/s);
});

test("PPE-03 open PDF is a 36px secondary button; only 翻译此页 is accent", () => {
  const { html, css } = popupSources();
  assert.match(html, /id="openPdf"[^>]*class="btn-secondary"/);
  assert.match(html, /id="restorePage"[^>]*class="btn-secondary"/);
  assert.equal([...html.matchAll(/btn-primary/g)].length, 1);
  assert.match(html, /id="translatePage"[^>]*class="btn-primary"/);
  assert.match(css, /\.btn-secondary\s*\{[^}]*min-height:\s*36px/s);
  assert.match(css, /\.btn-secondary\s*\{[^}]*padding:\s*8px 14px/s);
  assert.match(css, /\.btn-secondary\s*\{[^}]*background:\s*transparent/s);
  assert.match(css, /\.btn-secondary\s*\{[^}]*color:\s*var\(--oi-text-muted\)/s);
  assert.match(css, /\.btn-secondary\s*\{[^}]*border:\s*1px solid var\(--oi-line-strong\)/s);
  assert.match(css, /\.btn-secondary\s*\{[^}]*font-weight:\s*500/s);
  assert.match(css, /\.btn-secondary\s*\{[^}]*border-radius:\s*var\(--oi-radius-control\)/s);
  assert.match(css, /\.btn-primary\s*\{[^}]*background:\s*var\(--oi-accent\)/s);
  const openRule = css.match(/#openPdf\s*\{[^}]+\}/)[0];
  assert.doesNotMatch(openRule, /background|color:|border|min-height|font-weight/);
});

test("PPE-04 打开 PDF stays on one line inside the 340px popup", () => {
  const { css } = popupSources();
  assert.match(css, /body\s*\{[^}]*width:\s*340px/s);
  const openRule = css.match(/#openPdf\s*\{[^}]+\}/)[0];
  assert.match(openRule, /white-space:\s*nowrap/);
  assert.match(openRule, /overflow:\s*hidden/);
  assert.match(openRule, /text-overflow:\s*ellipsis/);
});

test("PPE-05 a PDF tab sends OI_OPEN_PAGE with src and then closes", () => {
  const { js } = popupSources();
  const click = openPdfClick(js);
  const init = js.slice(js.indexOf("async function init"), js.indexOf("function setPrimaryBusy"));
  const openAt = init.indexOf('$("openPdf").addEventListener');
  const mountAt = init.indexOf("mountPdf();");
  const probeAt = init.indexOf("readPdfContentType");
  const watchAt = init.indexOf("armTabWatch();", openAt);
  assert.ok(mountAt >= 0 && mountAt < openAt && probeAt > 0 && watchAt > openAt);
  assert.equal(init.includes("await syncPrimary"), false);
  assert.match(click, /openPopupPdfEntry\(/);
  assert.match(click, /probe: pdfProbe/);
  assert.match(click, /close: \(\) => window\.close\(\)/);
  assert.match(js, /chrome\.scripting\.executeScript/);
  assert.doesNotMatch(js, /readPdfContentType\([^)]*,[^)]*,\s*[0-9]{4,}/);
  assert.doesNotMatch(click, /tabs\.query/);
  const entry = popupPdfEntrySource();
  assert.match(entry, /resolvePopupPdfSrc\(url, await probe\)/);
  assert.match(entry, /src\s*\?\s*\{ type: "OI_OPEN_PAGE", page: "pdf", src \}/);
  assert.ok(entry.indexOf("close()") > entry.indexOf("} catch"));
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
  assert.match(sw, /pdf\/viewer\.html/);
  assert.match(sw, /message\.page === "pdf" && message\.src \? `\?src=\$\{encodeURIComponent\(message\.src\)\}`/);
});

test("PPE-06 other pages open the library without src and then close", () => {
  const entry = popupPdfEntrySource();
  const library = entry.match(/:\s*\{ type: "OI_OPEN_PAGE", page: "pdf" \}/);
  assert.ok(library);
  assert.equal(library[0].includes("src"), false);
  assert.ok(entry.indexOf("close()") > entry.lastIndexOf('page: "pdf"'));
});

test("PPE-07 PDF and ordinary pages share one unchanged secondary button", () => {
  const { html, js } = popupSources();
  assert.equal([...html.matchAll(/id="openPdf"/g)].length, 1);
  const click = openPdfClick(js);
  assert.doesNotMatch(click, /textContent|className|classList|btn-primary/);
  assert.doesNotMatch(js, /pdfTab[\s\S]{0,120}(?:textContent|btn-primary)/);
});

test("PPE-08 the button disables before sendMessage so a second click cannot open another tab", () => {
  const entry = popupPdfEntrySource();
  const guard = entry.indexOf("if (button.disabled) return;");
  const disable = entry.indexOf("button.disabled = true;");
  const busy = entry.indexOf('button.setAttribute("aria-busy", "true")');
  const send = entry.indexOf("sendMessage(message)");
  assert.ok(guard >= 0 && guard < disable && disable < busy && busy < send);
  assert.equal(entry.split("sendMessage(").length - 1, 1);
  assert.doesNotMatch(entry, /textContent/);
});

test("PPE-09 a failed open shows 无法打开 PDF 阅读器 and leaves the popup open", () => {
  const { html, css } = popupSources();
  assert.match(html, /id="openPdfError"[^>]*class="danger"[^>]*hidden[^>]*>无法打开 PDF 阅读器</);
  assert.equal(html.indexOf('id="openPdfError"') > html.indexOf('id="openPdf"'), true);
  assert.match(css, /\.danger\s*\{[^}]*color:\s*var\(--oi-danger\)/);
  assert.match(css, /\.danger\s*\{[^}]*font-size:\s*12px/);
  const entry = popupPdfEntrySource();
  const catchAt = entry.indexOf("} catch {");
  const closeAt = entry.indexOf("close()");
  assert.ok(catchAt > 0 && closeAt > catchAt);
  const caught = entry.slice(catchAt, closeAt);
  assert.match(entry, /if \(!res \|\| res\.ok === false\) throw new Error\("open failed"\)/);
  assert.match(caught, /button\.disabled = false/);
  assert.match(caught, /removeAttribute\("aria-busy"\)/);
  assert.match(caught, /error\.hidden = false/);
  assert.match(caught, /return;/);
  assert.equal(caught.includes("close()"), false);
  assert.match(entry.slice(closeAt - 40, closeAt), /error\.hidden = true/);
});

test("PPE-10 pdf off hides the entry and leaves the rest of the popup", () => {
  const { html, js } = popupSources();
  assert.match(html, /id="pdfEntry" hidden/);
  assert.match(js, /const pdfOn = featureOn\(settings, "pdf"\)/);
  assert.match(js, /\$\("pdfEntry"\)\.hidden = !pdfOn/);
  assert.match(html, /id="translatePage"[^>]*>翻译此页</);
  assert.match(html, /id="restorePage"[^>]*>恢复原文</);
  assert.match(html, />本站自动</);
  assert.match(html, /id="openOptions">设置</);
  assert.match(html, /id="openLearning">学习</);
  assert.match(html, /id="openDocs">文档</);
  assert.doesNotMatch(html, /id="openPdfPage"|id="openPdfSep"/);
});

test("PPE-11 footer is only 设置 · 学习 · 文档", () => {
  const { html, css, js } = popupSources();
  assert.doesNotMatch(html, /openPdfPage|openPdfSep/);
  assert.doesNotMatch(js, /openPdfPage|openPdfSep/);
  assert.doesNotMatch(css, /openPdfPage|openPdfSep/);
  const nav = html.match(/<nav class="entries">[\s\S]*?<\/nav>/)[0];
  assert.match(nav, /id="openOptions">设置</);
  assert.match(nav, /id="openLearning">学习</);
  assert.match(nav, /id="openDocs">文档</);
  assert.equal([...nav.matchAll(/·/g)].length, 2);
  assert.doesNotMatch(nav, /PDF/);
});

test("PPE-12 translate, restore, and Alt+T stay; new CSS uses --oi-* tokens; manifest matches cb9425a aside from host-safe tokens", () => {
  const { js, css } = popupSources();
  assert.match(js, /PRIMARY_IDLE = "翻译此页"/);
  assert.match(js, /PRIMARY_STOP = "停止"/);
  assert.match(js, /dataset\.busy === "1"/);
  assert.match(js, /type: "OI_STOP"/);
  assert.match(js, /type: "OI_RESTORE"/);
  assert.match(js, /setPrimaryBusy/);
  const manifest = readFileSync(join(root, "manifest.json"), "utf8");
  assert.match(manifest, /"default": "Alt\+T"/);
  assert.match(manifest, /"mac": "Alt\+T"/);
  const added = [...css.matchAll(/#openPdf(?::focus-visible)?\s*\{[^}]+\}/g)].map((hit) => hit[0]).join("\n");
  assert.match(added, /#openPdf:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-focus\)/s);
  assert.match(added, /outline-offset:\s*2px/);
  assert.equal(added.match(/#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|hsla?\([^)]*\)/g), null);
  assert.doesNotMatch(css, /#pdfEntry\s*\{/);
  const worker = readFileSync(join(root, "background/service-worker.js"), "utf8");
  assert.match(worker, /command !== "toggle-translate"/);
  const pinned = execFileSync("git", ["show", "cb9425a:manifest.json"], { cwd: root, encoding: "utf8" });
  assert.equal(manifest.replaceAll("ui/tokens-content.css", "ui/tokens.css"), pinned);
});

test("popup PDF open uses contentType, then URL fallback, without a new permission", async () => {
  const { readPdfContentType, resolvePopupPdfSrc, looksLikePdfUrl, PDF_CONTENT_TYPE_TIMEOUT_MS } = await import("../lib/pdf-viewer.js");
  const { js } = popupSources();
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.equal(manifest.permissions.includes("tabs"), false);
  assert.equal(PDF_CONTENT_TYPE_TIMEOUT_MS <= 400, true);
  assert.equal(looksLikePdfUrl("https://arxiv.org/pdf/1706.03762"), true);
  assert.equal(looksLikePdfUrl("https://arxiv.org/pdf/1706.03762v7"), true);
  assert.equal(looksLikePdfUrl("https://arxiv.org/abs/1706.03762"), false);
  assert.equal(looksLikePdfUrl("https://example.com/docs/pdf/guide.html"), false);
  assert.equal(looksLikePdfUrl("https://example.com/pdf/guide.html"), false);
  assert.equal(resolvePopupPdfSrc("https://arxiv.org/pdf/1706.03762", null), "https://arxiv.org/pdf/1706.03762");
  assert.equal(resolvePopupPdfSrc("https://example.com/docs/pdf/guide.html", null), "");
  assert.equal(resolvePopupPdfSrc("https://files.example/get", "application/pdf"), "https://files.example/get");
  assert.equal(resolvePopupPdfSrc("https://example.com/article", "text/html"), "");
  assert.equal(resolvePopupPdfSrc("https://example.com/article", null), "");
  assert.equal(resolvePopupPdfSrc("data:application/pdf;base64,AAA", "application/pdf"), "");
  assert.equal(resolvePopupPdfSrc("data:application/pdf;base64,AAA", null), "");
  const failed = await readPdfContentType(7, async () => {
    throw new Error("inject failed");
  });
  assert.equal(failed, null);
  assert.equal(resolvePopupPdfSrc("https://arxiv.org/pdf/1706.03762", failed), "https://arxiv.org/pdf/1706.03762");
  assert.equal(resolvePopupPdfSrc("https://example.com/article", failed), "");
  const timedOut = await readPdfContentType(7, () => new Promise(() => {}), 30);
  assert.equal(timedOut, null);
  assert.equal(resolvePopupPdfSrc("https://arxiv.org/pdf/1706.03762", timedOut), "https://arxiv.org/pdf/1706.03762");
  const click = openPdfClick(js);
  assert.equal(click.split("chrome.runtime.sendMessage").length - 1, 1);
  const entry = popupPdfEntrySource();
  const disable = entry.indexOf("button.disabled = true;");
  const probe = entry.indexOf("await probe");
  const send = entry.indexOf("sendMessage(message)");
  assert.ok(disable >= 0 && disable < probe && probe < send);
});

function popupTabStops(html, { pdf = true, unset = false, restore = false } = {}) {
  const { document } = parseHTML(html);
  if (pdf) document.getElementById("pdfEntry").hidden = false;
  if (restore) document.getElementById("restorePage").disabled = false;
  if (unset) {
    document.getElementById("engineLink").hidden = true;
    document.getElementById("engineUnset").hidden = false;
  }
  return [...document.querySelectorAll("a[href], button, input, select, textarea, summary")].filter((el) => {
    if (el.closest("[hidden]")) return false;
    const details = el.closest("details");
    if (details && !details.open && el.tagName !== "SUMMARY") return false;
    return !el.disabled;
  }).map((el) => el.id || el.textContent.replace(/\s+/g, " ").trim());
}

test("PL-01 header, action row, engine, more, separator, open PDF, then the same footer", () => {
  const { html } = popupSources();
  const order = ["translatePage", "restorePage", "engineNote", "autoSite", "translateScope", "sourceLang", "targetLang", "engineLine", "openPdf", "openOptions", "openLearning", "openDocs"];
  let at = html.indexOf("<header>");
  assert.ok(at >= 0);
  for (const id of order) {
    const next = html.indexOf(`id="${id}"`, at);
    assert.ok(next > at, id);
    at = next;
  }
  const row = html.indexOf('class="action-row"');
  const more = html.indexOf("<details class=\"more\">");
  const sep = html.indexOf('class="group-sep"');
  const pdf = html.indexOf('id="openPdf"');
  const footer = html.indexOf('<nav class="entries">');
  assert.ok(row < more && more < sep && sep < pdf && pdf < footer);
  assert.match(html, /class="action-row">\s*<button[^>]*id="translatePage"[^>]*>翻译此页<\/button>\s*<button[^>]*id="restorePage"[^>]*>恢复原文<\/button>/);
  const nav = html.match(/<nav class="entries">[\s\S]*?<\/nav>/)[0];
  assert.match(nav, /id="openOptions">设置/);
  assert.match(nav, /id="openLearning">学习/);
  assert.match(nav, /id="openDocs">文档/);
  assert.equal([...nav.matchAll(/·/g)].length, 2);
  assert.doesNotMatch(html, /class="group-title"|<h2>[^<]*(网页翻译|PDF)/);
});

test("PL-02 翻译此页 and 恢复原文 share one 36px row at about 2:1", () => {
  const { html, css } = popupSources();
  assert.match(html, /class="action-row"[\s\S]*id="translatePage"[\s\S]*id="restorePage"/);
  assert.match(css, /\.action-row\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.action-row\s*\{[^}]*gap:\s*8px/s);
  const primary = css.match(/\.action-row > \.btn-primary\s*\{[^}]+\}/)[0];
  const secondary = css.match(/\.action-row > \.btn-secondary\s*\{[^}]+\}/)[0];
  for (const rule of [primary, secondary]) {
    assert.match(rule, /height:\s*36px/);
    assert.match(rule, /white-space:\s*nowrap/);
    assert.match(rule, /font-size:\s*14px/);
    assert.match(rule, /font-weight:\s*600/);
  }
  assert.match(primary, /flex:\s*2 1 0/);
  assert.match(secondary, /flex:\s*1 1 0/);
  assert.match(secondary, /min-width:\s*88px/);
  assert.match(css, /\.switch-row\s*\{[^}]*margin:\s*12px 0 6px/s);
});

test("PL-03 separator A is a full-width 1px footer line with 12px gaps", () => {
  const { html, css } = popupSources();
  assert.match(html, /class="group-sep"[^>]*role="separator"/);
  const sep = css.match(/\.group-sep\s*\{[^}]+\}/)[0];
  assert.match(sep, /border-top:\s*1px solid var\(--oi-line\)/);
  assert.match(sep, /margin:\s*12px 0/);
  assert.doesNotMatch(sep, /margin-left|margin-right|width:\s*\d/);
  assert.match(css, /#pdfEntry \.btn-secondary\s*\{[^}]*margin-top:\s*0/s);
  assert.match(css, /\.entries\s*\{[^}]*margin-top:\s*12px/s);
  assert.match(css, /\.entries\s*\{[^}]*border-top:\s*1px solid var\(--oi-line\)/s);
  assert.ok(html.indexOf('class="group-sep"') > html.indexOf("<details class=\"more\">"));
  assert.ok(html.indexOf('id="openPdf"') > html.indexOf('class="group-sep"'));
});

test("PL-04 only 翻译此页 uses the accent button", () => {
  const { html } = popupSources();
  assert.equal([...html.matchAll(/btn-primary/g)].length, 1);
  assert.match(html, /id="translatePage"[^>]*class="btn-primary"/);
  assert.match(html, /id="restorePage"[^>]*class="btn-secondary"/);
  assert.match(html, /id="openPdf"[^>]*class="btn-secondary"/);
});

test("PL-05 no-engine line stays 引擎：未设置 · 去设置 and 去设置 can take focus", () => {
  const { html, css, js } = popupSources();
  assert.match(html, /id="engineUnsetName">未设置<\/span> · <a id="engineSetup"[^>]*>去设置<\/a>/);
  assert.match(html, /id="engineLink"[^>]*>引擎：—<\/a>/);
  assert.match(js, /unset\.hidden = false/);
  assert.match(js, /\$\("engineSetup"\)\?\.focus\(\)/);
  assert.match(css, /\.engine-setup:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--oi-focus\)/s);
  const { document } = parseHTML(html);
  const setup = document.getElementById("engineSetup");
  assert.equal(setup.tagName, "A");
  assert.equal(setup.hasAttribute("href"), true);
  assert.equal(setup.getAttribute("tabindex"), null);
});

test("PL-06 the no-engine note sits under the button row and only pushes what follows", () => {
  const { html, css, js } = popupSources();
  assert.match(html, /class="action-row">[\s\S]*?<\/div>\s*<p id="engineNote"/);
  assert.doesNotMatch(html.slice(html.indexOf('class="action-row"'), html.indexOf("</div>", html.indexOf('class="action-row"'))), /engineNote/);
  assert.match(css, /\.engine-note\s*\{[^}]*margin:\s*8px 0 0/s);
  assert.match(css, /\.engine-note:not\(\[hidden\]\) \+ \.switch-row\s*\{[^}]*margin-top:\s*8px/s);
  assert.match(js, /note\.hidden = false/);
  assert.match(js, /note\.textContent = NO_ENGINE_COPY\.body/);
  assert.doesNotMatch(css, /\.engine-note\s*\{[^}]*position:\s*absolute/s);
});

test("PL-07 a disabled 恢复原文 stays in the action row", () => {
  const { html, css, js } = popupSources();
  const row = html.slice(html.indexOf('class="action-row"'), html.indexOf("</div>", html.indexOf('class="action-row"')));
  assert.match(row, /id="restorePage"[^>]*disabled[^>]*>恢复原文/);
  const disabled = css.match(/\.action-row > #restorePage:disabled\s*\{[^}]+\}/)[0];
  assert.match(disabled, /display:\s*inline-flex/);
  assert.match(disabled, /min-width:\s*88px/);
  assert.doesNotMatch(disabled, /display:\s*none|visibility:\s*hidden/);
  assert.match(js, /restore\.disabled = !\(ping\.running \|\| ping\.hasTranslations \|\| ping\.inflight\)/);
  assert.doesNotMatch(js, /\$\("restorePage"\)\.hidden\s*=/);
  assert.doesNotMatch(js, /restore\.remove\(/);
});

test("PL-08 tab order is translate, restore, site, scope, language, setup, more, PDF, footer", () => {
  const { html } = popupSources();
  assert.match(html, /id="restorePage"[^>]*disabled/);
  assert.equal(popupTabStops(html, { pdf: true }).includes("restorePage"), false);
  const configured = popupTabStops(html, { pdf: true, unset: false, restore: true });
  assert.deepEqual(configured, [
    "translatePage",
    "restorePage",
    "autoSite",
    "translateScope",
    "sourceLang",
    "targetLang",
    "engineLink",
    "更多",
    "openPdf",
    "openOptions",
    "openLearning",
    "openDocs"
  ]);
  const unset = popupTabStops(html, { pdf: true, unset: true, restore: true });
  assert.deepEqual(unset, [
    "translatePage",
    "restorePage",
    "autoSite",
    "translateScope",
    "sourceLang",
    "targetLang",
    "engineSetup",
    "更多",
    "openPdf",
    "openOptions",
    "openLearning",
    "openDocs"
  ]);
  assert.deepEqual(popupTabStops(html, { pdf: false, unset: true }).includes("openPdf"), false);
});

test("PL-09 buttons are in the first paint and a hung page ping cannot blank the popup", async () => {
  assert.equal(POPUP_PAGE_WAIT_MS <= 300, true);
  const started = Date.now();
  assert.equal(await withTimeout(new Promise(() => {}), 40), null);
  assert.ok(Date.now() - started < 300);
  assert.deepEqual(
    await withTimeout(Promise.resolve({ inflight: false, running: false, hasTranslations: false }), 300),
    { inflight: false, running: false, hasTranslations: false }
  );
  assert.equal(await withTimeout(Promise.reject(new Error("no receiver")), 300), null);

  const { html, js } = popupSources();
  const scriptAt = html.indexOf("<script");
  assert.ok(html.indexOf('id="translatePage"') < scriptAt);
  assert.ok(html.indexOf('id="restorePage"') < scriptAt);
  assert.ok(html.indexOf('id="openPdf"') < scriptAt);
  const init = js.slice(js.indexOf("async function init"), js.indexOf("function setPrimaryBusy"));
  const wait = init.indexOf("await withTimeout(Promise.all([settingsPromise, tabsPromise]), POPUP_PAGE_WAIT_MS)");
  const buttons = init.indexOf('$("translatePage").addEventListener');
  const pdf = init.indexOf('$("openPdf").addEventListener');
  const watch = init.indexOf("armTabWatch();", pdf);
  assert.ok(wait >= 0 && wait < buttons && buttons < pdf && watch > pdf);
  assert.equal(init.includes("await syncPrimary"), false);
  const sync = js.slice(js.indexOf("async function syncPrimary"), js.indexOf("function bindEngineRefresh"));
  assert.match(sync, /withTimeout\(/);
  assert.match(sync, /type: "OI_PING"/);
  assert.match(sync, /POPUP_PAGE_WAIT_MS/);
  assert.match(sync, /if \(!ping\) return/);

  execFileSync(process.execPath, ["--input-type=module", "-e", hungPopupScript()], {
    cwd: root,
    timeout: 5000,
    encoding: "utf8"
  });
});

function hungPopupScript() {
  const popupFile = join(root, "popup/popup.js");
  const popupHtml = join(root, "popup/popup.html");
  return `
    import { parseHTML } from "linkedom";
    import { readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";

    const parsed = parseHTML(readFileSync(${JSON.stringify(popupHtml)}, "utf8"));
    const selectProto = Object.getPrototypeOf(parsed.document.createElement("select"));
    Object.defineProperty(selectProto, "value", {
      configurable: true,
      get() { return this._value ?? ""; },
      set(next) { this._value = String(next ?? ""); }
    });
    globalThis.document = parsed.document;
    globalThis.window = parsed.window;
    globalThis.setInterval = () => 0;
    let pings = 0;
    globalThis.chrome = {
      runtime: {
        getURL: (path) => path,
        openOptionsPage() {},
        sendMessage(message) {
          if (message?.type === "OI_GET_SETTINGS") {
            return Promise.resolve({
              settings: {
                provider: "kimi",
                providers: { kimi: { apiKey: "sk-test" } },
                sourceLang: "en",
                targetLang: "zh-CN",
                translateScope: "article",
                translateLimit: "all",
                features: { pdf: true }
              }
            });
          }
          return Promise.resolve({ ok: true });
        }
      },
      storage: {
        local: { async get() { return {}; } },
        onChanged: { addListener() {} }
      },
      tabs: {
        async query() { return [{ id: 7, url: "https://example.com/paper" }]; },
        sendMessage() {
          pings += 1;
          return new Promise(() => {});
        }
      },
      scripting: { executeScript() { return new Promise(() => {}); } }
    };
    const started = Date.now();
    await import(pathToFileURL(${JSON.stringify(popupFile)}).href + "?hang=" + started);
    const pdf = parsed.document.getElementById("pdfEntry");
    const translate = parsed.document.getElementById("translatePage");
    const restore = parsed.document.getElementById("restorePage");
    for (let i = 0; i < 40 && pdf.hidden; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const elapsed = Date.now() - started;
    if (pdf.hidden) throw new Error("打开 PDF stayed hidden while the page ping hung");
    if (!translate.isConnected || !restore.isConnected) throw new Error("action buttons missing");
    if (translate.hidden || restore.hidden) throw new Error("action buttons hidden");
    if (elapsed >= 300) throw new Error("buttons took " + elapsed + "ms");
    if (pings < 1) throw new Error("page ping never started");
  `;
}

test("PL-10 the separator uses the footer line token on the elevated surface", () => {
  const { css } = popupSources();
  const tokens = readFileSync(join(root, "ui/tokens.css"), "utf8");
  const sep = css.match(/\.group-sep\s*\{[^}]+\}/)[0];
  const footer = css.match(/\.entries\s*\{[^}]+\}/)[0];
  assert.match(sep, /border-top:\s*1px solid var\(--oi-line\)/);
  assert.match(footer, /border-top:\s*1px solid var\(--oi-line\)/);
  assert.equal(/#[0-9a-fA-F]{3,8}|rgba?\(/.test(sep), false);
  assert.match(tokens, /--oi-line:\s*rgba\(255,\s*255,\s*255,\s*0\.10\)/);
  assert.match(tokens, /--oi-bg-elevated:\s*#181c26/);
  assert.match(css, /background:\s*var\(--oi-bg-elevated\)/);
  assert.match(tokens, /color-scheme:\s*dark/);
  assert.equal(/color-scheme:\s*light/.test(tokens + css), false);
});
