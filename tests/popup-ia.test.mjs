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
  assert.match(html, /class="status-row"/);
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
  assert.match(css, /--oi-bg-elevated:\s*#10131a/);
  assert.match(css, /--oi-bg:\s*#0b0d12/);
  assert.match(css, /width:\s*340px/);
  assert.match(css, /height:\s*3px/);
});

test("options keep v1 module gates; youtube\/x only in Advanced fold", () => {
  const html = readFileSync(join(root, "options/options.html"), "utf8");
  assert.match(html, /id="featureList"/);
  assert.match(html, /高级（YouTube \/ X，默认关闭）/);
  assert.match(html, /id="laterList"/);
});

test("isProviderConfigured requires apiKey when the adapter marks it required", () => {
  const paid = getProvider("openai");
  assert.equal(paid.id, "openai");
  assert.equal(isProviderConfigured(paid, {}), false);
  assert.equal(isProviderConfigured(paid, { apiKey: "sk-test" }), true);
  const free = getProvider("mymemory");
  assert.equal(isProviderConfigured(free, {}), true);
});
