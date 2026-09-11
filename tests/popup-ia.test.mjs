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
  assert.match(html, />翻译此页</);
  assert.match(html, />本站自动</);
  assert.match(html, /value="article">仅正文</);
  assert.match(html, /value="page">全页面</);
  assert.match(html, /本次翻译/);
  assert.match(html, /value="title_lead">仅标题\+开头/);
  assert.match(html, /id="translateLimit"/);
  assert.match(html, /class="lang-row"/);
  assert.match(html, /id="engineLink"/);
  assert.match(html, /未配置引擎/);
  assert.match(html, /id="openLearning">学习中心</);
  assert.match(html, /id="openDocs">文档</);
  assert.match(html, /id="openOptions">设置</);
  assert.equal(html.includes("featureList"), false);
  assert.equal(/youtube|YouTube/i.test(html), false);
  assert.equal(html.includes("hamburger"), false);
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

test("options keep v1 module gates; youtube\/x only in Advanced fold", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  const featSrc = readFileSync(join(root, "lib/features.js"), "utf8");
  assert.match(html, /id="featureList"/);
  assert.match(html, /高级（YouTube \/ X，默认关闭）/);
  assert.match(html, /id="laterList"/);
  assert.match(html, /id="translateLimit"/);
  assert.match(html, /每批条数（分批，不是总数）/);
  assert.match(html, /本次翻译/);
  assert.match(html, /value="title_lead">仅标题\+开头/);
  for (const id of ["webpage", "hover", "selection", "learning", "documents", "fab"]) {
    assert.match(featSrc, new RegExp(`id: "${id}"[\\s\\S]*group: "v1"`));
  }
  assert.match(featSrc, /id: "youtube"[\s\S]*group: "later"/);
  assert.match(featSrc, /id: "x"[\s\S]*group: "later"/);
  assert.match(featSrc, /youtube:\s*false/);
  assert.match(featSrc, /x:\s*false/);
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

test("isProviderConfigured requires apiKey when the adapter marks it required", () => {
  const paid = getProvider("openai");
  assert.equal(paid.id, "openai");
  assert.equal(isProviderConfigured(paid, {}), false);
  assert.equal(isProviderConfigured(paid, { apiKey: "sk-test" }), true);
  const free = getProvider("mymemory");
  assert.equal(isProviderConfigured(free, {}), true);
});
