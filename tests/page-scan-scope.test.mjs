import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_CHROME_SELECTOR, PAGE_TOP_NAV_SELECTOR, PRIMARY_TITLE_SKIP_ANCESTOR } from "../lib/site-presets.js";
import { DEFAULT_SETTINGS } from "../lib/storage.js";
import { applyTranslateLimit } from "../lib/translate-limit.js";
import { isPrimaryTitle, shouldCollectNode } from "../lib/page-scan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentSrc = readFileSync(join(root, "content/content.js"), "utf8");
const optionsHtml = readFileSync(join(root, "options/options.html"), "utf8");

function fakeNode({
  tagName = "P",
  className = "",
  hits = [],
  text = "Hello world about AI tools",
  left = 120,
  width = 480,
  height = 40
} = {}) {
  const node = {
    tagName,
    className,
    nextElementSibling: null,
    matches(sel) {
      return hits.some((hit) => sel.includes(hit));
    },
    closest(sel) {
      return hits.some((hit) => sel.includes(hit)) ? node : null;
    },
    querySelector() {
      return null;
    },
    getBoundingClientRect() {
      return { width, height, left, right: left + width, top: 180 };
    },
    cloneNode() {
      return {
        querySelectorAll() {
          return { forEach() {} };
        },
        innerText: text,
        textContent: text
      };
    }
  };
  return node;
}

const articleCtx = { hostname: "developers.openai.com", innerWidth: 1280 };
const pageSettings = { translateScope: "page", skipCode: true };
const articleSettings = { translateScope: "article", skipCode: true };

test("default translateScope stays article; PDF viewer copy is untouched", () => {
  assert.equal(DEFAULT_SETTINGS.translateScope, "article");
  const pdfHtml = readFileSync(join(root, "pdf/viewer.html"), "utf8");
  assert.match(pdfHtml, />当前页</);
  assert.match(pdfHtml, />全文</);
  assert.doesNotMatch(pdfHtml, /仍跳过顶栏导航/);
});

test("article scope still skips a left-rail side column", () => {
  const side = fakeNode({
    tagName: "LI",
    hits: ["aside", "role='complementary'"],
    text: "Rethinking skills and prompts for GPT-6 Astra",
    left: 16,
    width: 180
  });
  assert.equal(shouldCollectNode(side, articleSettings, articleCtx), false);
});

test("article scope collects main-column H1 only, not site-logo header junk", () => {
  const logo = fakeNode({
    tagName: "H1",
    hits: ["header", "role='banner'"],
    text: "OpenAI Developers"
  });
  const mainTitle = fakeNode({
    tagName: "H1",
    hits: ["main", "article", "role='main'"],
    text: "Rethinking skills and prompts for GPT-6 Astra",
    left: 280,
    width: 640
  });
  assert.equal(isPrimaryTitle(logo, { scope: "article" }), false);
  assert.equal(shouldCollectNode(logo, articleSettings, articleCtx), false);
  assert.equal(isPrimaryTitle(mainTitle, { scope: "article" }), true);
  assert.equal(shouldCollectNode(mainTitle, articleSettings, articleCtx), true);
});

test("page scope collects sidebar readable titles and body", () => {
  const side = fakeNode({
    tagName: "LI",
    hits: ["aside", "role='complementary'"],
    text: "Rethinking skills and prompts for GPT-6 Astra",
    left: 16,
    width: 180
  });
  const sidePara = fakeNode({
    tagName: "P",
    hits: ["aside", "role='complementary'"],
    text: "Coding agents have come a long way, and best practices are changing fast.",
    left: 16,
    width: 200
  });
  assert.equal(shouldCollectNode(side, pageSettings, articleCtx), true);
  assert.equal(shouldCollectNode(sidePara, pageSettings, articleCtx), true);
});

test("page scope translates the header main H1, not a short logo H1", () => {
  const logo = fakeNode({
    tagName: "H1",
    hits: ["header", "role='banner'"],
    text: "OpenAI"
  });
  const title = fakeNode({
    tagName: "H1",
    hits: ["header", "role='banner'"],
    text: "Rethinking skills and prompts for GPT-6 Astra",
    left: 280,
    width: 640,
    height: 72
  });
  assert.equal(isPrimaryTitle(logo, { scope: "page" }), false);
  assert.equal(shouldCollectNode(logo, pageSettings, articleCtx), false);
  assert.equal(isPrimaryTitle(title, { scope: "page" }), true);
  assert.equal(shouldCollectNode(title, pageSettings, articleCtx), true);
});

test("title_lead can still pick the page-scope header H1", () => {
  const title = fakeNode({
    tagName: "H1",
    hits: ["header", "role='banner'"],
    text: "Rethinking skills and prompts for GPT-6 Astra",
    left: 280,
    width: 640
  });
  const side = fakeNode({
    tagName: "LI",
    hits: ["aside"],
    text: "Architectural visualization with ASTRA workshop notes",
    left: 16,
    width: 180
  });
  const lead = fakeNode({
    tagName: "P",
    hits: ["main"],
    text: "Coding agents have come a long way, and best practices are changing fast."
  });
  assert.equal(shouldCollectNode(title, pageSettings, articleCtx), true);
  assert.equal(shouldCollectNode(side, pageSettings, articleCtx), true);
  assert.equal(shouldCollectNode(lead, pageSettings, articleCtx), true);
  assert.deepEqual(applyTranslateLimit([side, title, lead], "title_lead"), [title, lead]);
});

test("page scope still skips nav bars, menus, breadcrumbs, footer piles, cookies, short links", () => {
  const topNav = fakeNode({
    tagName: "LI",
    hits: ["header nav", "role='navigation'"],
    text: "Resources and documentation for builders"
  });
  const menu = fakeNode({
    tagName: "LI",
    hits: ["role='menu'", "role='menubar'"],
    text: "Account settings and workspace switcher"
  });
  const crumb = fakeNode({
    tagName: "LI",
    hits: ["breadcrumb"],
    text: "Blog"
  });
  const footer = fakeNode({
    tagName: "LI",
    hits: ["footer", "role='contentinfo'"],
    text: "Privacy Policy and terms of service docs"
  });
  const cookie = fakeNode({
    tagName: "P",
    className: "cookie-banner",
    hits: ["cookie", "consent"],
    text: "We use cookies to improve your browsing experience"
  });
  const shortLink = fakeNode({
    tagName: "LI",
    hits: ["aside"],
    text: "All posts",
    left: 16,
    width: 160
  });
  assert.equal(shouldCollectNode(topNav, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(menu, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(crumb, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(footer, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(cookie, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(shortLink, pageSettings, articleCtx), false);
});

test("hard skips for code and extension UI remain in both scopes", () => {
  const code = fakeNode({ hits: ["code", "pre"], text: "const foo = 1;" });
  const oi = fakeNode({ hits: [".oi-translation", ".oi-fab"], text: "已翻译的句子足够长" });
  const editable = fakeNode({ hits: ["[contenteditable]"], text: "Draft note about agents" });
  for (const settings of [pageSettings, articleSettings]) {
    assert.equal(shouldCollectNode(code, settings, articleCtx), false, settings.translateScope + " code");
    assert.equal(shouldCollectNode(oi, settings, articleCtx), false, settings.translateScope + " oi");
    assert.equal(shouldCollectNode(editable, settings, articleCtx), false, settings.translateScope + " editable");
  }
});

test("options copy describes sidebar + header H1 without the old 顶栏-only line", () => {
  assert.match(optionsHtml, /value="article">只译主栏正文，跳过侧栏与导航。</);
  assert.match(optionsHtml, /value="page">含侧栏；主标题（含页头 H1）必译。顶栏导航链仍可跳过。</);
  assert.doesNotMatch(optionsHtml, /仍跳过顶栏导航/);
  assert.doesNotMatch(optionsHtml, /更大范围/);
});

test("content.js gates chrome by scope and does not blanket-drop header", () => {
  assert.match(contentSrc, /function isPrimaryTitle\(/);
  assert.match(contentSrc, /function shouldSkipScopedChrome\(/);
  assert.match(contentSrc, /PAGE_CHROME_SELECTOR/);
  assert.match(contentSrc, /scope !== "page"/);
  assert.match(contentSrc, /looksLikeArticleTitle/);
  assert.match(contentSrc, /isTinyChrome/);
  assert.doesNotMatch(contentSrc, /if \(el\.closest\(HARD_SKIP_SELECTOR\) \|\| el\.closest\(ALWAYS_CHROME_SELECTOR\) \|\| el\.closest\(CHROME_SELECTOR\)\) return false;/);
  assert.doesNotMatch(contentSrc, /closest\(['"]header['"]\)/);
  assert.match(contentSrc, /script, style, noscript/);
  assert.ok(PRIMARY_TITLE_SKIP_ANCESTOR.includes("nav"));
  assert.ok(!PRIMARY_TITLE_SKIP_ANCESTOR.includes("header"));
  assert.ok(PAGE_TOP_NAV_SELECTOR.includes("header nav"));
  assert.ok(PAGE_CHROME_SELECTOR.includes("footer"));
  assert.ok(PAGE_CHROME_SELECTOR.includes("cookie"));
});
