import test from "node:test";
import assert from "node:assert/strict";
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
  assert.match(html, /id="openPdfPage"[^>]*>PDF</);
  assert.match(html, /id="openPdfPage"[^>]*\bhidden\b/);
  assert.match(html, /id="openPdfSep"[^>]*\bhidden\b/);
  assert.match(html, /id="openPdf"[^>]*>在沉浸译中打开（实验室）</);
  assert.match(html, /id="pdfEntry" hidden/);
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
  assert.match(tokens, /--oi-bg-elevated:\s*#10131a/);
  assert.match(tokens, /--oi-bg:\s*#0b0d12/);
  assert.match(css, /width:\s*3(2\d|3\d|4\d|5\d|60)px/);
  assert.match(tokens, /height:\s*3px/);
  assert.match(tokens, /color-scheme:\s*dark/);
  assert.equal(/color-scheme:\s*light/.test(tokens + css), false);
  assert.match(tokens, /\.mark span[^}]*background:\s*var\(--oi-text\)/);
  assert.equal(/\.mark span[^}]*--oi-accent/.test(tokens), false);
});

test("options save bar is a quiet sticky Loom bar", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  const css = readFileSync(join(root, "options/options.css"), "utf8");
  assert.match(html, />保存设置</);
  assert.match(html, /class="actions-bar"/);
  assert.match(html, /class="bar"/);
  assert.match(html, /id="exportSettings"[^>]*>导出设置/);
  assert.match(html, /id="importSettings"[^>]*>导入设置/);
  assert.match(html, /id="save"/);
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
  assert.match(html, /data-nav="engine"[^>]*>引擎</);
  assert.match(html, /data-nav="reading"[^>]*>阅读</);
  assert.match(html, /data-nav="features"[^>]*>功能</);
  assert.match(html, /data-nav="advanced"[^>]*>高级</);
  assert.match(html, /id="featureList"/);
  assert.match(html, /id="twoStepPolish"[^>]*> 先信后润/);
  assert.match(html, /id="twoStepPolishHint">先忠实直译，再润色一稿；质量更好，更耗 token。默认开。仅 LLM 引擎生效。/);
  const featuresPanel = html.match(/id="panel-features"[\s\S]*?<\/section>/)[0];
  const advancedPanel = html.match(/id="panel-advanced"[\s\S]*?<\/section>/)[0];
  const readingPanel = html.match(/id="panel-reading"[\s\S]*?<\/section>/)[0];
  assert.match(featuresPanel, /id="featureList"[\s\S]*id="twoStepPolish"/);
  assert.match(advancedPanel, /id="laterList"[\s\S]*id="deepThink"[\s\S]*id="deepThinkHint"/);
  assert.doesNotMatch(advancedPanel, /twoStepPolish/);
  assert.doesNotMatch(featuresPanel, /id="laterList"/);
  assert.doesNotMatch(html, /<details class="later">/);
  assert.doesNotMatch(html, /id="autoOnNewPages"[\s\S]{0,80}id="twoStepPolish"/);
  assert.doesNotMatch(html, /两步译（先信后润）/);
  assert.doesNotMatch(html, /id="translateQuality"/);
  assert.doesNotMatch(html, /id="translationStyle"/);
  assert.doesNotMatch(html, /译文样式/);
  assert.doesNotMatch(html, /preview|双语预览|样式说明/i);
  assert.match(html, /每批条数（分批，不是总数）/);
  assert.match(readingPanel, /id="fontScale"/);
  assert.match(readingPanel, /id="bodyGlossGap"/);
  assert.match(readingPanel, /正文译文间距/);
  assert.match(readingPanel, /id="bodyGlossStackGap"/);
  assert.match(readingPanel, /译文段间距/);
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
  for (const id of ["hover", "selection", "youtube", "x", "pdf"]) {
    assert.match(featSrc, new RegExp(`id: "${id}"[\\s\\S]*group: "later"`));
  }
  assert.match(featSrc, /youtube:\s*false/);
  assert.match(featSrc, /x:\s*false/);
  assert.match(featSrc, /pdf:\s*false/);
  assert.match(featSrc, /PDF 阅读（实验室）/);
  assert.doesNotMatch(html, /pdf\/viewer\.html/);
  const optJs = readFileSync(join(root, "options/options.js"), "utf8");
  assert.match(optJs, /el\("twoStepPolish"\)\.checked = cachedSettings\.twoStepPolish === true/);
  assert.match(optJs, /twoStepPolish: el\("twoStepPolish"\)\.checked/);
  assert.match(optJs, /el\("deepThink"\)\.checked = cachedSettings\.deepThink === true/);
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
  assert.match(js, /\$\("openPdfPage"\)\.hidden = !pdfOn/);
  assert.match(js, /\$\("openPdfSep"\)\.hidden = !pdfOn/);
  assert.match(js, /\$\("pdfEntry"\)\.hidden = !\(pdfOn && pdfTab\)/);
  assert.match(js, /if \(!featureOn\(settings, "pdf"\)\) return/);
  assert.match(html, /id="openPdfPage" hidden/);
  assert.match(html, /id="pdfEntry" hidden/);
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
