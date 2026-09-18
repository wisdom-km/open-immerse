import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_CHROME_SELECTOR, PAGE_TOP_NAV_SELECTOR, PRIMARY_TITLE_SKIP_ANCESTOR } from "../lib/site-presets.js";
import { DEFAULT_SETTINGS } from "../lib/storage.js";
import { applyTranslateLimit } from "../lib/translate-limit.js";
import { hasNestedCollectible, inSideRail, isPrimaryTitle, shouldCollectNode, shouldInline, shouldSkipScopedChrome, translationClassName } from "../lib/page-scan.js";

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

test("page scope still skips nav bars, menus, breadcrumbs, footer piles, cookies", () => {
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
  assert.equal(shouldCollectNode(topNav, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(menu, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(crumb, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(footer, pageSettings, articleCtx), false);
  assert.equal(shouldCollectNode(cookie, pageSettings, articleCtx), false);
});

test("page scope keeps short side-rail labels that article scope still skips", () => {
  const labels = [
    { text: "Getting started", hits: ["aside", "role='complementary'"], left: 16, width: 180 },
    { text: "Topics", hits: ["aside"], left: 16, width: 160 },
    { text: "Recent", hits: ["aside"], left: 16, width: 160 },
    { text: "General", hits: ["aside"], left: 16, width: 170 },
    { text: "Better skills", hits: ["aside", "role='complementary'"], left: 980, width: 200 }
  ];
  for (const spec of labels) {
    const node = fakeNode({
      tagName: "LI",
      hits: spec.hits,
      text: spec.text,
      left: spec.left,
      width: spec.width
    });
    assert.equal(inSideRail(node, articleCtx), true, spec.text + " inSideRail");
    assert.equal(shouldSkipScopedChrome(node, "page", articleCtx), false, spec.text + " page keep");
    assert.equal(shouldCollectNode(node, pageSettings, articleCtx), true, spec.text + " page collect");
    assert.equal(shouldSkipScopedChrome(node, "article", articleCtx), true, spec.text + " article skip");
    assert.equal(shouldCollectNode(node, articleSettings, articleCtx), false, spec.text + " article collect");
  }
});

test("page scope keeps short labels inside a left-rail nav (OpenAI Recent/Topics)", () => {
  const rail = {
    tagName: "NAV",
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 218, height: 640, left: 12, right: 230, top: 80 };
    }
  };
  const closest = (sel) => {
    const s = String(sel);
    if (s === "nav, aside, [role='navigation']" || s === "nav, [role='navigation']") return rail;
    return null;
  };
  const recent = fakeNode({ tagName: "H3", text: "Recent", left: 12, width: 200, height: 24 });
  const topics = fakeNode({ tagName: "H3", text: "Topics", left: 12, width: 200, height: 24 });
  const allPosts = fakeNode({ tagName: "LI", text: "All posts", left: 12, width: 200, height: 28 });
  for (const node of [recent, topics, allPosts]) node.closest = closest;
  for (const node of [recent, topics, allPosts]) {
    assert.equal(inSideRail(node, articleCtx), true, node.cloneNode().innerText + " rail");
    assert.equal(shouldSkipScopedChrome(node, "page", articleCtx), false, node.cloneNode().innerText + " page keep");
    assert.equal(shouldCollectNode(node, pageSettings, articleCtx), true, node.cloneNode().innerText + " page collect");
    assert.equal(shouldSkipScopedChrome(node, "article", articleCtx), true, node.cloneNode().innerText + " article skip");
    assert.equal(shouldCollectNode(node, articleSettings, articleCtx), false, node.cloneNode().innerText + " article collect");
  }
});

test("page scope keeps short geometric side-column labels without aside", () => {
  const toc = fakeNode({
    tagName: "LI",
    text: "Designing for iOS",
    left: 12,
    width: 176
  });
  toc.parentElement = { tagName: "NAV" };
  assert.equal(inSideRail(toc, articleCtx), true);
  assert.equal(shouldSkipScopedChrome(toc, "page", articleCtx), false);
  assert.equal(shouldCollectNode(toc, pageSettings, articleCtx), true);
  assert.equal(shouldSkipScopedChrome(toc, "article", articleCtx), true);
  assert.equal(shouldCollectNode(toc, articleSettings, articleCtx), false);
});

test("page scope still skips short top-bar chrome", () => {
  const design = fakeNode({
    tagName: "LI",
    hits: ["header nav", "role='navigation'"],
    text: "Design",
    left: 320,
    width: 72
  });
  const docs = fakeNode({
    tagName: "LI",
    hits: ["header nav", "role='banner' nav"],
    text: "Getting started",
    left: 420,
    width: 110
  });
  assert.equal(shouldSkipScopedChrome(design, "page", articleCtx), true);
  assert.equal(shouldCollectNode(design, pageSettings, articleCtx), false);
  assert.equal(shouldSkipScopedChrome(docs, "page", articleCtx), true);
  assert.equal(shouldCollectNode(docs, pageSettings, articleCtx), false);
});

test("side-rail mounts stay block with underline class, not oi-inline", () => {
  const labels = [
    fakeNode({ tagName: "LI", hits: ["aside"], text: "Getting started", left: 16, width: 180 }),
    fakeNode({ tagName: "H3", hits: ["aside"], text: "Recent", left: 16, width: 160, height: 24 }),
    fakeNode({ tagName: "LI", hits: ["aside"], text: "Latest Version", left: 16, width: 200 }),
    fakeNode({ tagName: "A", hits: ["aside"], text: "Guides", left: 16, width: 160, height: 24 })
  ];
  const toc = fakeNode({ tagName: "LI", text: "Designing for iOS", left: 12, width: 176 });
  labels.push(toc);
  for (const node of labels) {
    assert.equal(inSideRail(node, articleCtx), true, node.cloneNode().innerText + " rail");
    assert.equal(shouldInline(node, articleCtx), false, node.cloneNode().innerText + " not inline");
    const cls = translationClassName(node, articleCtx);
    assert.equal(cls.includes("oi-inline"), false, node.cloneNode().innerText + " class " + cls);
    assert.match(cls, /^oi-translation/);
    assert.equal(shouldCollectNode(node, pageSettings, articleCtx), true, node.cloneNode().innerText + " still KEEP");
  }
  assert.equal(translationClassName(labels[1], articleCtx), "oi-translation oi-after-heading");
  assert.equal(translationClassName(labels[0], articleCtx), "oi-translation");
});

test("top-bar chrome may still mount inline", () => {
  const design = fakeNode({
    tagName: "LI",
    hits: ["header nav", "role='navigation'"],
    text: "Design",
    left: 320,
    width: 72
  });
  const topLink = fakeNode({
    tagName: "A",
    hits: ["header nav", "role='navigation'"],
    text: "Docs",
    left: 400,
    width: 64,
    height: 24
  });
  assert.equal(inSideRail(design, articleCtx), false);
  assert.equal(shouldInline(design, articleCtx), true);
  assert.equal(translationClassName(design, articleCtx), "oi-translation oi-inline");
  assert.equal(shouldInline(topLink, articleCtx), true);
  assert.equal(translationClassName(topLink, articleCtx), "oi-translation oi-inline");
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
  const optionsJs = readFileSync(join(root, "options/options.js"), "utf8");
  const popupHtml = readFileSync(join(root, "popup/popup.html"), "utf8");
  assert.match(optionsHtml, /value="article">仅正文</);
  assert.match(optionsHtml, /value="page">全页面</);
  assert.match(optionsHtml, /id="translateScopeHint" class="hint field-hint"/);
  assert.match(optionsHtml, /只译主栏正文，跳过侧栏与导航。/);
  assert.match(optionsJs, /含侧栏短目录；主标题（含页头 H1）必译。顶栏导航链仍可跳过。/);
  assert.match(optionsJs, /function syncTranslateScopeHint\(/);
  assert.match(optionsJs, /translateScope"\)\.addEventListener\("change"/);
  assert.doesNotMatch(optionsHtml, /value="article">只译主栏/);
  assert.doesNotMatch(optionsHtml, /value="page">含侧栏/);
  assert.doesNotMatch(optionsHtml, /仍跳过顶栏导航/);
  assert.doesNotMatch(optionsHtml, /更大范围/);
  assert.match(popupHtml, /value="article">仅正文</);
  assert.match(popupHtml, /value="page">全页面</);
});

test("content.js gates chrome by scope and does not blanket-drop header", () => {
  assert.match(contentSrc, /function isPrimaryTitle\(/);
  assert.match(contentSrc, /function shouldSkipScopedChrome\(/);
  assert.match(contentSrc, /function inSideRail\(/);
  assert.match(contentSrc, /PAGE_CHROME_SELECTOR/);
  assert.match(contentSrc, /scope !== "page"/);
  assert.match(contentSrc, /looksLikeArticleTitle/);
  assert.match(contentSrc, /isTinyChrome/);
  assert.match(contentSrc, /if \(inSideRail\(el\)\) return false;/);
  assert.match(contentSrc, /function shouldInline\([\s\S]*?if \(inSideRail\(el\)\) return false;/);
  assert.doesNotMatch(contentSrc, /closest\("nav, aside, header, \[role='navigation'\]"\)/);
  assert.match(contentSrc, /function schedulePageHydrationRescan\(/);
  assert.match(contentSrc, /PAGE_SCOPE_RESCAN_MS/);
  assert.doesNotMatch(contentSrc, /if \(el\.closest\(HARD_SKIP_SELECTOR\) \|\| el\.closest\(ALWAYS_CHROME_SELECTOR\) \|\| el\.closest\(CHROME_SELECTOR\)\) return false;/);
  assert.doesNotMatch(contentSrc, /closest\(['"]header['"]\)/);
  assert.match(contentSrc, /script, style, noscript/);
  assert.match(contentSrc, /el\.querySelector\(BLOCK_SELECTOR\)/);
  assert.equal(hasNestedCollectible({ querySelector: () => ({ tagName: "P" }) }), true);
  assert.equal(hasNestedCollectible({ querySelector: () => null }), false);
  assert.ok(PRIMARY_TITLE_SKIP_ANCESTOR.includes("nav"));
  assert.ok(!PRIMARY_TITLE_SKIP_ANCESTOR.includes("header"));
  assert.ok(PAGE_TOP_NAV_SELECTOR.includes("header nav"));
  assert.ok(PAGE_CHROME_SELECTOR.includes("footer"));
  assert.ok(PAGE_CHROME_SELECTOR.includes("cookie"));
});
