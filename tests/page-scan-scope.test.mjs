import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_TOP_NAV_SELECTOR, PRIMARY_TITLE_SKIP_ANCESTOR } from "../lib/site-presets.js";
import { isPrimaryTitle, shouldCollectNode } from "../lib/page-scan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentSrc = readFileSync(join(root, "content/content.js"), "utf8");

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

test("page scope collects side-column and left-rail post titles", () => {
  const side = fakeNode({
    tagName: "LI",
    hits: ["aside", "role='complementary'"],
    text: "Rethinking skills and prompts for GPT-6 Astra",
    left: 16,
    width: 180
  });
  assert.equal(shouldCollectNode(side, pageSettings, articleCtx), true);
});

test("page and article scopes collect the primary H1 even under header/banner", () => {
  const title = fakeNode({
    tagName: "H1",
    hits: ["header", "role='banner'"],
    text: "Rethinking skills and prompts for GPT-6 Astra",
    left: 280,
    width: 640,
    height: 72
  });
  assert.equal(isPrimaryTitle(title), true);
  assert.equal(shouldCollectNode(title, articleSettings, articleCtx), true);
  assert.equal(shouldCollectNode(title, pageSettings, articleCtx), true);
});

test("page scope still skips site header nav, not just leftover article chrome", () => {
  const topNav = fakeNode({
    tagName: "LI",
    hits: ["header nav", "role='navigation'"],
    text: "Resources"
  });
  assert.equal(shouldCollectNode(topNav, pageSettings, articleCtx), false);
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

test("page scope still drops Category/Share chrome labels via isChromeMetaText", () => {
  const label = fakeNode({
    tagName: "LI",
    hits: ["aside"],
    text: "Category",
    left: 16,
    width: 160
  });
  assert.equal(shouldCollectNode(label, pageSettings, articleCtx), false);
});

test("content.js gates chrome by scope and always keeps the primary title", () => {
  assert.match(contentSrc, /function isPrimaryTitle\(/);
  assert.match(contentSrc, /function shouldSkipScopedChrome\(/);
  assert.match(contentSrc, /PRIMARY_TITLE_SKIP_ANCESTOR/);
  assert.match(contentSrc, /PAGE_TOP_NAV_SELECTOR/);
  assert.match(contentSrc, /scope === "page"/);
  assert.match(contentSrc, /const primaryTitle = isPrimaryTitle\(el\)/);
  assert.match(contentSrc, /!primaryTitle && shouldSkipScopedChrome\(el, scope\)/);
  assert.doesNotMatch(
    contentSrc,
    /if \(el\.closest\(HARD_SKIP_SELECTOR\) \|\| el\.closest\(ALWAYS_CHROME_SELECTOR\) \|\| el\.closest\(CHROME_SELECTOR\)\) return false;/
  );
  assert.match(contentSrc, /script, style, noscript/);
  assert.match(contentSrc, /\.oi-translation, \.oi-toast, \.oi-selection-card, \.oi-fab/);
  assert.ok(PRIMARY_TITLE_SKIP_ANCESTOR.includes("nav"));
  assert.ok(!PRIMARY_TITLE_SKIP_ANCESTOR.includes("header"));
  assert.ok(PAGE_TOP_NAV_SELECTOR.includes("header nav"));
});
