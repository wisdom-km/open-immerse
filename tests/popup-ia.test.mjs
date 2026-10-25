import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getProvider, isProviderConfigured } from "../lib/providers.js";

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
  assert.match(html, /未配置引擎/);
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
  const ping = init.indexOf("await syncPrimary");
  assert.ok(ping > 0);
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
  const end = js.indexOf("if (tab?.id) setInterval");
  assert.ok(start >= 0 && end > start);
  return js.slice(start, end);
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

test("PPE-02 打开 PDF sits between 翻译此页 and 恢复原文 at full width", () => {
  const { html, css } = popupSources();
  const cardStart = html.indexOf('<section class="intent-card">');
  const translate = html.indexOf('id="translatePage"', cardStart);
  const open = html.indexOf('id="openPdf"', cardStart);
  const restore = html.indexOf('id="restorePage"', cardStart);
  assert.ok(cardStart >= 0 && translate > cardStart && open > translate && restore > open);
  assert.equal(html.indexOf('id="openPdf"'), open);
  assert.match(html, /id="pdfEntry"[\s\S]*id="openPdf"[\s\S]*id="restorePage"/);
  assert.match(css, /\.btn-secondary\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.btn-secondary\s*\{[^}]*margin-top:\s*8px/s);
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
  assert.match(js, /const pdfTab = shouldOfferPdfOpen\(tab\?\.url\)/);
  assert.match(click, /pdfTab\s*\?\s*\{ type: "OI_OPEN_PAGE", page: "pdf", src: tab\.url \}/);
  assert.doesNotMatch(click, /tabs\.query/);
  const sw = readFileSync(join(root, "background/service-worker.js"), "utf8");
  assert.match(sw, /pdf\/viewer\.html/);
  assert.match(sw, /message\.page === "pdf" && message\.src \? `\?src=\$\{encodeURIComponent\(message\.src\)\}`/);
  assert.ok(click.indexOf("window.close()") > click.indexOf("} catch"));
});

test("PPE-06 other pages open the library without src and then close", () => {
  const click = openPdfClick(popupSources().js);
  const library = click.match(/:\s*\{ type: "OI_OPEN_PAGE", page: "pdf" \}/);
  assert.ok(library);
  assert.equal(library[0].includes("src"), false);
  assert.ok(click.indexOf("window.close()") > click.lastIndexOf('page: "pdf"'));
});

test("PPE-07 PDF and ordinary pages share one unchanged secondary button", () => {
  const { html, js } = popupSources();
  assert.equal([...html.matchAll(/id="openPdf"/g)].length, 1);
  const click = openPdfClick(js);
  assert.doesNotMatch(click, /textContent|className|classList|btn-primary/);
  assert.doesNotMatch(js, /pdfTab[\s\S]{0,120}(?:textContent|btn-primary)/);
});

test("PPE-08 the button disables before sendMessage so a second click cannot open another tab", () => {
  const click = openPdfClick(popupSources().js);
  const guard = click.indexOf("if (btn.disabled) return;");
  const disable = click.indexOf("btn.disabled = true;");
  const busy = click.indexOf('btn.setAttribute("aria-busy", "true")');
  const send = click.indexOf("chrome.runtime.sendMessage");
  assert.ok(guard >= 0 && guard < disable && disable < busy && busy < send);
  assert.equal(click.split("chrome.runtime.sendMessage").length - 1, 1);
  assert.doesNotMatch(click, /textContent/);
});

test("PPE-09 a failed open shows 无法打开 PDF 阅读器 and leaves the popup open", () => {
  const { html, css, js } = popupSources();
  assert.match(html, /id="openPdfError"[^>]*class="danger"[^>]*hidden[^>]*>无法打开 PDF 阅读器</);
  assert.equal(html.indexOf('id="openPdfError"') > html.indexOf('id="openPdf"'), true);
  assert.match(css, /\.danger\s*\{[^}]*color:\s*var\(--oi-danger\)/);
  assert.match(css, /\.danger\s*\{[^}]*font-size:\s*12px/);
  const click = openPdfClick(js);
  const catchAt = click.indexOf("} catch {");
  const closeAt = click.indexOf("window.close()");
  assert.ok(catchAt > 0 && closeAt > catchAt);
  const caught = click.slice(catchAt, closeAt);
  assert.match(click, /if \(!res \|\| res\.ok === false\) throw new Error\("open failed"\)/);
  assert.match(caught, /btn\.disabled = false/);
  assert.match(caught, /removeAttribute\("aria-busy"\)/);
  assert.match(caught, /err\.hidden = false/);
  assert.match(caught, /return;/);
  assert.equal(caught.includes("window.close"), false);
  assert.match(click.slice(closeAt - 30, closeAt), /err\.hidden = true/);
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

test("PPE-12 translate, restore, and Alt+T stay; new CSS uses --oi-* tokens; manifest and service worker are untouched", () => {
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
  execFileSync("git", ["diff", "--quiet", "cb9425a", "--", "manifest.json", "background/service-worker.js"], { cwd: root });
});
