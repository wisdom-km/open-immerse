import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PAGE_CHROME_SELECTOR, PAGE_TOP_NAV_SELECTOR, PRIMARY_TITLE_SKIP_ANCESTOR } from "../lib/site-presets.js";
import { DEFAULT_SETTINGS } from "../lib/storage.js";
import { applyTranslateLimit } from "../lib/translate-limit.js";
import { detachStaleRailGloss, ensureRailId, getText, hasNestedCollectible, inSideRail, isPrimaryTitle, mountPairedGloss, pairGlossBySource, pickSideRailMountHost, placeTranslationNode, planTranslationMount, rebindLiveSourceHash, shouldCollectNode, shouldInline, shouldSkipScopedChrome, sourceTextHash, stampRailMountKeys, translationClassName } from "../lib/page-scan.js";

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
  const attrs = {};
  const dataset = {};
  const node = {
    tagName,
    className,
    dataset,
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
    querySelectorAll() {
      return [];
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
      if (name === "data-oi-rail-id") dataset.oiRailId = String(value);
      if (name === "data-oi-for") dataset.oiFor = String(value);
    },
    getAttribute(name) {
      return attrs[name] || null;
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

function sidebarFixture(tagName, text, hits, box = {}) {
  const kids = [];
  const parent = {
    children: kids,
    tagName: "ASIDE",
    appendChild(child) {
      kids.push(child);
      child.parentElement = parent;
      return child;
    },
    insertBefore(child, ref) {
      const i = kids.indexOf(ref);
      if (i === -1) kids.push(child);
      else kids.splice(i, 0, child);
      child.parentElement = parent;
      return child;
    }
  };
  const source = fakeNode({
    tagName,
    hits,
    text,
    left: box.left ?? 16,
    width: box.width ?? 180,
    height: box.height ?? 24
  });
  const own = [];
  source.parentElement = parent;
  source.children = own;
  source.__label = text;
  source.cloneNode = () => ({
    querySelectorAll() {
      return { forEach() {} };
    },
    get innerText() {
      return source.__label;
    },
    get textContent() {
      return source.__label;
    }
  });
  source.appendChild = (child) => {
    own.push(child);
    child.parentElement = source;
    child.remove = () => {
      const i = own.indexOf(child);
      if (i >= 0) own.splice(i, 1);
      child.parentElement = null;
    };
    return child;
  };
  Object.defineProperty(source, "lastElementChild", {
    get() {
      return own[own.length - 1] || null;
    }
  });
  const matchTranslation = (sel) => String(sel).includes("oi-translation");
  source.querySelector = (sel) => {
    if (!matchTranslation(sel)) return null;
    return own.find((n) => n.classList?.contains("oi-translation")) || null;
  };
  source.querySelectorAll = (sel) => {
    if (!matchTranslation(sel)) return [];
    return own.filter((n) => n.classList?.contains("oi-translation"));
  };
  source.insertAdjacentElement = (where, child) => {
    if (where !== "afterend") return child;
    const i = kids.indexOf(source);
    if (i === -1) kids.push(child);
    else kids.splice(i + 1, 0, child);
    child.parentElement = parent;
    return child;
  };
  Object.defineProperty(source, "nextElementSibling", {
    get() {
      const i = kids.indexOf(source);
      return i >= 0 ? kids[i + 1] || null : null;
    }
  });
  parent.appendChild(source);
  return { parent, source };
}

function mountedNode(className, text = "") {
  const attrs = {};
  const dataset = {};
  const node = {
    className,
    textContent: text,
    dataset,
    classList: {
      contains(name) {
        return String(node.className).split(/\s+/).includes(name);
      }
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
      if (name === "data-oi-for") dataset.oiFor = String(value);
      if (name === "data-oi-src-hash") dataset.oiSrcHash = String(value);
    },
    getAttribute(name) {
      return attrs[name] || "";
    }
  };
  return node;
}

test("side-rail fixture stacks translation below source without oi-inline", () => {
  const cases = [
    { tagName: "H3", text: "Recent", hits: ["aside"] },
    { tagName: "LI", text: "Getting started", hits: ["aside"] },
    { tagName: "LI", text: "API Reference", hits: ["aside"] },
    { tagName: "A", text: "Topics", hits: ["aside"] }
  ];
  for (const spec of cases) {
    const { source } = sidebarFixture(spec.tagName, spec.text, spec.hits);
    assert.equal(inSideRail(source, articleCtx), true, spec.text + " rail");
    assert.equal(shouldCollectNode(source, pageSettings, articleCtx), true, spec.text + " page KEEP");
    assert.equal(shouldCollectNode(source, articleSettings, articleCtx), false, spec.text + " article SKIP");
    const plan = planTranslationMount(source, articleCtx, { mode: "block" });
    assert.match(plan.className, /oi-translation/, spec.text + " class");
    assert.equal(plan.className.includes("oi-inline"), false, spec.text + " forbids oi-inline");
    assert.equal(plan.inline, false);
    assert.equal(plan.forceBlock, true);
    assert.equal(plan.placement, "append", spec.text + " inside host");
    assert.match(plan.className, /oi-side-rail/);
    const node = mountedNode(plan.className);
    placeTranslationNode(source, node, plan);
    assert.equal(source.lastElementChild, node, spec.text + " last child below source");
    assert.equal(node.classList.contains("oi-translation"), true);
    assert.equal(node.classList.contains("oi-inline"), false);
    assert.equal(node.classList.contains("oi-side-rail"), true);
  }
});

test("side-rail flex-row item wraps translation to full width below source", () => {
  const { source } = sidebarFixture("LI", "Getting started", ["aside"]);
  const link = fakeNode({ tagName: "A", hits: ["aside"], text: "Getting started", left: 16, width: 160, height: 20 });
  const kids = [];
  source.querySelector = (sel) => (String(sel).includes("a") ? link : null);
  source.appendChild(link);
  link.appendChild = (child) => {
    kids.push(child);
    child.parentElement = link;
    return child;
  };
  Object.defineProperty(link, "lastElementChild", {
    get() {
      return kids[kids.length - 1] || null;
    }
  });
  assert.equal(pickSideRailMountHost(source), link);
  const plan = planTranslationMount(source, articleCtx, { mode: "block" });
  assert.equal(plan.host, link);
  assert.equal(plan.placement, "append");
  assert.equal(plan.className.includes("oi-inline"), false);
  const node = mountedNode(plan.className);
  placeTranslationNode(source, node, plan);
  assert.equal(link.lastElementChild, node);
  assert.equal(source.nextElementSibling, null);
});

test("side-rail card title is not oi-inline", () => {
  const card = fakeNode({
    tagName: "P",
    hits: ["data-docs-sidebar"],
    text: "Latest Version",
    left: 48,
    width: 140,
    height: 20
  });
  assert.equal(inSideRail(card, articleCtx), true);
  assert.equal(shouldInline(card, articleCtx), false);
  assert.equal(shouldCollectNode(card, pageSettings, articleCtx), true);
  assert.equal(shouldCollectNode(card, articleSettings, articleCtx), false);
  const plan = planTranslationMount(card, articleCtx, { mode: "block" });
  assert.match(plan.className, /oi-translation/);
  assert.match(plan.className, /oi-side-rail/);
  assert.equal(plan.className.includes("oi-inline"), false);
  assert.equal(plan.placement, "append");
});

test("side-rail skip-middle keeps gloss on the same source, no neighbor fill", () => {
  const specs = [
    { text: "Getting started", zh: "入门" },
    { text: "Design principles", zh: "设计原则" },
    { text: "Designing for iOS", zh: "为 iOS 设计" }
  ];
  const items = specs.map((spec) => {
    const { source } = sidebarFixture("LI", spec.text, ["aside"]);
    return { source, ...spec };
  });
  const sources = items.map((item) => item.source);
  const translations = items.map((item) => item.zh);
  const keep = [sources[0], sources[2]];

  const zipped = keep.map((el, i) => ({ el, text: translations[i] }));
  assert.equal(zipped[1].text, "设计原则", "bare index zip after skip is the bug");

  const pairs = pairGlossBySource(sources, translations, keep);
  assert.equal(pairs.length, 2);
  assert.equal(getText(pairs[0].source), "Getting started");
  assert.equal(pairs[0].text, "入门");
  assert.notEqual(pairs[0].text, "设计原则");
  assert.equal(getText(pairs[1].source), "Designing for iOS");
  assert.equal(pairs[1].text, "为 iOS 设计");
  assert.notEqual(pairs[1].text, "设计原则");
  assert.equal(pairGlossBySource(sources, translations, [sources[1]])[0].text, "设计原则");

  const missing = pairGlossBySource(sources, ["入门", "", "为 iOS 设计"], keep);
  assert.equal(missing[0].text, "入门");
  assert.equal(missing[1].text, "为 iOS 设计");

  const mounted = mountPairedGloss(sources, translations, keep, articleCtx, {
    mode: "block",
    createNode(plan, pair) {
      return mountedNode(plan.className, pair.text);
    }
  });
  assert.equal(mounted.length, 2);
  assert.equal(mounted[0].node.textContent, "入门");
  assert.equal(mounted[0].node.getAttribute("data-oi-for"), pairs[0].key);
  assert.equal(mounted[0].node.getAttribute("data-oi-src-hash"), sourceTextHash("Getting started"));
  assert.equal(mounted[1].node.textContent, "为 iOS 设计");
  assert.equal(sources[0].lastElementChild, mounted[0].node);
  assert.equal(sources[2].lastElementChild, mounted[1].node);
  assert.equal(sources[1].lastElementChild, null);
  assert.match(mounted[0].plan.className, /oi-side-rail/);
  assert.equal(mounted[0].plan.className.includes("oi-inline"), false);
  assert.equal(ensureRailId(sources[0]), pairs[0].key);
});

test("recycle-scroller same LI remounts Getting started→Design principles→Technologies", () => {
  const { source } = sidebarFixture("LI", "Getting started", ["aside"]);
  const steps = [
    { en: "Getting started", zh: "入门", not: "设计原则" },
    { en: "Design principles", zh: "设计原则", not: "技术" },
    { en: "Technologies", zh: "技术", not: "设计原则" }
  ];
  let previous = null;
  for (const step of steps) {
    source.__label = step.en;
    assert.equal(getText(source), step.en);
    if (previous) {
      assert.equal(shouldCollectNode(source, pageSettings, articleCtx), true, step.en + " stale stripped");
      assert.equal(source.lastElementChild, null, step.en + " no leftover " + previous.zh);
    }
    const mounted = mountPairedGloss([source], [step.zh], undefined, articleCtx, {
      mode: "block",
      createNode(plan, pair) {
        return mountedNode(plan.className, pair.text);
      }
    });
    assert.equal(mounted.length, 1);
    assert.equal(mounted[0].node.textContent, step.zh);
    assert.notEqual(mounted[0].node.textContent, step.not);
    assert.equal(source.lastElementChild.textContent, step.zh);
    assert.equal(source.children.filter((n) => n.classList?.contains("oi-translation")).length, 1);
    assert.equal(mounted[0].node.getAttribute("data-oi-src-hash"), sourceTextHash(step.en));
    assert.equal(shouldCollectNode(source, pageSettings, articleCtx), false);
    assert.equal(shouldCollectNode(source, articleSettings, articleCtx), false, step.en + " article SKIP");
    previous = step;
  }
  assert.notEqual(source.lastElementChild.textContent, "设计原则");
  assert.notEqual(source.lastElementChild.textContent, "入门");
});

test("title-container mount host shares rail-id + hash; recycle clears both keys", () => {
  const { source } = sidebarFixture("LI", "Design principles", ["aside"]);
  const title = fakeNode({
    tagName: "DIV",
    className: "title-container",
    hits: ["aside"],
    text: "Design principles"
  });
  const prevQS = source.querySelector;
  source.querySelector = (sel) => {
    if (String(sel).includes("title-container")) return title;
    return prevQS.call(source, sel);
  };
  assert.equal(pickSideRailMountHost(source), title);
  const hash = rebindLiveSourceHash(source);
  assert.equal(hash, sourceTextHash("Design principles"));
  assert.equal(title.getAttribute("data-oi-src-hash") || title.dataset.oiSrcHash, hash);
  assert.equal(source.getAttribute("data-oi-src-hash") || source.dataset.oiSrcHash, hash);
  const mounted = mountPairedGloss([source], ["设计原则"], undefined, articleCtx, {
    mode: "block",
    createNode(plan, pair) {
      return mountedNode(plan.className, pair.text);
    }
  });
  assert.equal(mounted[0].node.textContent, "设计原则");
  assert.notEqual(mounted[0].node.textContent, "技术");
  assert.equal(mounted[0].plan.host, title);
  const keys = stampRailMountKeys(source, mounted[0].node);
  assert.equal(title.getAttribute("data-oi-rail-id") || title.dataset.oiRailId, keys.id);
  assert.equal(mounted[0].node.getAttribute("data-oi-for"), keys.id);
  const leftover = mountedNode("oi-translation oi-side-rail", "技术");
  leftover.setAttribute("data-oi-for", "oi-rail-other");
  leftover.setAttribute("data-oi-src-hash", sourceTextHash("Technologies"));
  leftover.remove = () => {
    leftover.removed = true;
    leftover.parentElement = null;
  };
  title.appendChild?.(leftover);
  if (!title.children) title.children = [leftover];
  else if (Array.isArray(title.children) && !title.children.includes(leftover)) title.children.push(leftover);
  leftover.parentElement = title;
  source.__label = "Technologies";
  const stripped = detachStaleRailGloss(source);
  assert.ok(stripped.length >= 1, "stale hash or foreign rail-id must clear the row");
  const remounted = mountPairedGloss([source], ["技术"], undefined, articleCtx, {
    mode: "block",
    createNode(plan, pair) {
      return mountedNode(plan.className, pair.text);
    }
  });
  assert.equal(remounted[0].node.textContent, "技术");
  assert.notEqual(remounted[0].node.textContent, "设计原则");
});

test("Apple Getting started gloss is not 设计原则", () => {
  const gettingStarted = sidebarFixture("LI", "Getting started", ["aside"]).source;
  const designPrinciples = sidebarFixture("LI", "Design principles", ["aside"]).source;
  const designingForIos = sidebarFixture("LI", "Designing for iOS", ["aside"]).source;
  const sources = [gettingStarted, designPrinciples, designingForIos];
  const translations = ["入门", "设计原则", "为 iOS 设计"];
  const pairs = pairGlossBySource(sources, translations);
  assert.equal(pairs[0].text, "入门");
  assert.notEqual(pairs[0].text, "设计原则");
  assert.equal(pairs[1].text, "设计原则");
  assert.notEqual(pairs[1].text, "为 iOS 设计");
  for (const source of sources) {
    assert.equal(shouldCollectNode(source, pageSettings, articleCtx), true, getText(source) + " page KEEP");
    assert.equal(shouldCollectNode(source, articleSettings, articleCtx), false, getText(source) + " article SKIP");
  }
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
  assert.equal(translationClassName(labels[1], articleCtx), "oi-translation oi-after-heading oi-side-rail");
  assert.equal(translationClassName(labels[0], articleCtx), "oi-translation oi-side-rail");
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
  assert.match(contentSrc, /function pickSideRailMountHost\(/);
  assert.match(contentSrc, /oi-side-rail/);
  assert.match(contentSrc, /data-docs-sidebar/);
  assert.match(contentSrc, /PAGE_CHROME_SELECTOR/);
  assert.match(contentSrc, /scope !== "page"/);
  assert.match(contentSrc, /looksLikeArticleTitle/);
  assert.match(contentSrc, /isTinyChrome/);
  assert.match(contentSrc, /if \(inSideRail\(el\)\) return false;/);
  assert.match(contentSrc, /function shouldInline\([\s\S]*?if \(inSideRail\(el\)\) return false;/);
  assert.match(contentSrc, /function mountTranslation\(el, text, settings, opts = \{\}\)/);
  assert.match(contentSrc, /function pairGlossBySource\(/);
  assert.match(contentSrc, /function mountPairedTranslations\(/);
  assert.match(contentSrc, /data-oi-for/);
  assert.match(contentSrc, /data-oi-rail-id/);
  assert.match(contentSrc, /data-oi-src-hash/);
  assert.match(contentSrc, /function detachStaleRailGloss\(/);
  assert.match(contentSrc, /function rebindLiveSourceHash\(/);
  assert.match(contentSrc, /function stampRailMountKeys\(/);
  assert.match(contentSrc, /function glossIsStale\(/);
  assert.match(contentSrc, /function revalidateSideRailGlosses\(/);
  assert.match(contentSrc, /characterData: true/);
  assert.match(contentSrc, /title-container/);
  assert.match(contentSrc, /new Map\(/);
  assert.match(contentSrc, /mountPairedTranslations\(chunk, res\.translations/);
  assert.match(contentSrc, /opts\.mode === "block"/);
  assert.match(contentSrc, /inSideRail\(source\) \? \{ mode: "block" \}/);
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
