import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BLOCK_SELECTOR,
  collectNodes,
  hasNestedCollectible,
  placeTranslationNode,
  planTranslationMount,
  shouldCollectNode
} from "../lib/page-scan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentSrc = readFileSync(join(root, "content/content.js"), "utf8");
const bilingualSrc = readFileSync(join(root, "lib/bilingual-layout.js"), "utf8");

const articleSettings = { translateScope: "article", skipCode: true };
const mintlifyCtx = { hostname: "docs.typesafe.ai", innerWidth: 1280 };

function contentBlockSelector() {
  const m = contentSrc.match(/const BLOCK_SELECTOR = "([^"]+)"/);
  return m ? m[1] : "";
}

function bilingualBlockSelector() {
  const m = bilingualSrc.match(/BLOCK_SELECTOR:\s*"([^"]+)"/);
  return m ? m[1] : "";
}

function matchSimple(el, token) {
  const part = String(token || "").trim();
  if (!el || !part) return false;
  const attrOnly = part.match(/^\[([^=\]]+)=["']?([^"'\]]+)["']?\]$/);
  if (attrOnly) return String(el.getAttribute(attrOnly[1]) || "") === attrOnly[2];
  const tagged = part.match(/^([a-zA-Z][\w-]*)(?:\[([^=\]]+)=["']([^"']+)["']\])?$/);
  if (tagged) {
    if (el.tagName !== tagged[1].toUpperCase()) return false;
    if (tagged[2]) return String(el.getAttribute(tagged[2]) || "") === tagged[3];
    return true;
  }
  if (part.startsWith(".")) return String(el.className || "").split(/\s+/).includes(part.slice(1));
  const role = part.match(/^\[role=["']([^"']+)["']\]$/);
  if (role) return String(el.getAttribute("role") || "") === role[1];
  return false;
}

function matchesSelector(el, selector) {
  return String(selector || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .some((part) => matchSimple(el, part));
}

function descendants(el) {
  const out = [];
  const walk = (node) => {
    for (const child of node.children || []) {
      out.push(child);
      walk(child);
    }
  };
  walk(el);
  return out;
}

function textOf(el) {
  const chunks = [...(el.textChunks || [])];
  for (const child of el.children || []) chunks.push(textOf(child));
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function createEl(tag, attrs = {}, ...kids) {
  if (attrs && (typeof attrs === "string" || attrs.tagName)) {
    kids = [attrs, ...kids];
    attrs = {};
  }
  const el = {
    tagName: String(tag || "DIV").toUpperCase(),
    attrs: { ...attrs },
    className: String(attrs.class || attrs.className || ""),
    children: [],
    parentElement: null,
    textChunks: [],
    getAttribute(name) {
      const key = String(name);
      if (key in el.attrs) return String(el.attrs[key]);
      if (key === "class") return el.className;
      return null;
    },
    matches(sel) {
      return matchesSelector(el, sel);
    },
    closest(sel) {
      let node = el;
      while (node) {
        if (matchesSelector(node, sel)) return node;
        node = node.parentElement;
      }
      return null;
    },
    querySelector(sel) {
      return descendants(el).find((node) => matchesSelector(node, sel)) || null;
    },
    querySelectorAll(sel) {
      return descendants(el).filter((node) => matchesSelector(node, sel));
    },
    getBoundingClientRect() {
      return { width: 640, height: 48, left: 220, right: 860, top: 180 };
    },
    cloneNode() {
      const text = textOf(el);
      return {
        querySelectorAll() {
          return { forEach() {} };
        },
        innerText: text,
        textContent: text
      };
    },
    classList: {
      contains(name) {
        return String(el.className || "").split(/\s+/).includes(name);
      }
    },
    appendChild(child) {
      el.children.push(child);
      child.parentElement = el;
      return child;
    },
    insertAdjacentElement(where, child) {
      if (where !== "afterend" || !el.parentElement) return child;
      const sibs = el.parentElement.children;
      const i = sibs.indexOf(el);
      if (i === -1) sibs.push(child);
      else sibs.splice(i + 1, 0, child);
      child.parentElement = el.parentElement;
      return child;
    }
  };
  Object.defineProperty(el, "nextElementSibling", {
    get() {
      const sibs = el.parentElement?.children || [];
      const i = sibs.indexOf(el);
      return i >= 0 ? sibs[i + 1] || null : null;
    }
  });
  Object.defineProperty(el, "lastElementChild", {
    get() {
      return el.children[el.children.length - 1] || null;
    }
  });
  for (const kid of kids) {
    if (typeof kid === "string") el.textChunks.push(kid);
    else if (kid) el.appendChild(kid);
  }
  return el;
}

function mintlifyFixture() {
  const leaf = createEl(
    "span",
    { "data-as": "p" },
    "Large language models (LLMs) are designed to produce text for humans to read."
  );
  const withInline = createEl(
    "span",
    { "data-as": "p" },
    "Jev is TypeSafe’s flagship model and the first ",
    createEl("a", { class: "link", href: "/concepts/system-one" }, "System One model"),
    "."
  );
  const heading = createEl("h2", { class: "flex font-medium" }, "TypeSafe primitives");
  const nestedHost = createEl(
    "span",
    { "data-as": "p" },
    createEl("span", { "data-as": "p" }, "Inner leaf paragraph that should still be collected.")
  );
  const innerLeaf = nestedHost.children[0];
  const listItem = createEl(
    "li",
    {},
    createEl("span", { "data-as": "p" }, "A list item whose inner Mintlify paragraph is the leaf.")
  );
  const listLeaf = listItem.children[0];
  const realP = createEl("p", {}, "Classic paragraph still collected beside Mintlify spans.");
  const prose = createEl(
    "div",
    { class: "mdx-content prose", id: "content" },
    leaf,
    withInline,
    heading,
    nestedHost,
    listItem,
    realP
  );
  const article = createEl("article", {}, prose);
  const main = createEl("main", { role: "main" }, article);
  const body = createEl("body", {}, main);
  return { body, leaf, withInline, heading, nestedHost, innerLeaf, listItem, listLeaf, realP };
}

test("BLOCK_SELECTOR stays in sync and includes Mintlify [data-as=p]", () => {
  assert.match(BLOCK_SELECTOR, /\[data-as="?p"?\]/);
  assert.equal(contentBlockSelector(), BLOCK_SELECTOR);
  assert.equal(bilingualBlockSelector(), BLOCK_SELECTOR);
  assert.equal(BLOCK_SELECTOR.includes("nav"), false);
});

test("Mintlify span[data-as=p] leaves are collected like p; nested hosts are skipped", () => {
  const fx = mintlifyFixture();
  const collected = collectNodes({ body: fx.body }, articleSettings, mintlifyCtx);
  const set = new Set(collected);

  assert.equal(shouldCollectNode(fx.leaf, articleSettings, mintlifyCtx), true);
  assert.equal(shouldCollectNode(fx.withInline, articleSettings, mintlifyCtx), true);
  assert.equal(shouldCollectNode(fx.realP, articleSettings, mintlifyCtx), true);
  assert.equal(shouldCollectNode(fx.heading, articleSettings, mintlifyCtx), true);
  assert.equal(hasNestedCollectible(fx.nestedHost), true);
  assert.equal(shouldCollectNode(fx.nestedHost, articleSettings, mintlifyCtx), false);
  assert.equal(shouldCollectNode(fx.innerLeaf, articleSettings, mintlifyCtx), true);
  assert.equal(hasNestedCollectible(fx.listItem), true);
  assert.equal(shouldCollectNode(fx.listItem, articleSettings, mintlifyCtx), false);
  assert.equal(shouldCollectNode(fx.listLeaf, articleSettings, mintlifyCtx), true);

  assert.equal(set.has(fx.leaf), true);
  assert.equal(set.has(fx.withInline), true);
  assert.equal(set.has(fx.innerLeaf), true);
  assert.equal(set.has(fx.listLeaf), true);
  assert.equal(set.has(fx.realP), true);
  assert.equal(set.has(fx.heading), true);
  assert.equal(set.has(fx.nestedHost), false);
  assert.equal(set.has(fx.listItem), false);
  assert.ok(collected.some((el) => el.getAttribute("data-as") === "p" && !el.querySelector(BLOCK_SELECTOR)));
});

test("insert path treats Mintlify span[data-as=p] like p (afterend body gloss)", () => {
  const fx = mintlifyFixture();
  const spanPlan = planTranslationMount(fx.leaf, mintlifyCtx);
  const pPlan = planTranslationMount(fx.realP, mintlifyCtx);

  assert.equal(spanPlan.placement, "afterend");
  assert.equal(spanPlan.tagName, "DIV");
  assert.equal(spanPlan.className, "oi-translation");
  assert.equal(spanPlan.inline, false);
  assert.equal(spanPlan.placement, pPlan.placement);
  assert.equal(spanPlan.tagName, pPlan.tagName);
  assert.equal(spanPlan.className, pPlan.className);

  const node = { className: spanPlan.className, classList: { contains: (n) => n === "oi-translation" } };
  placeTranslationNode(fx.leaf, node, spanPlan);
  assert.equal(fx.leaf.nextElementSibling, node);
  assert.equal(fx.leaf.lastElementChild, null);
  assert.equal(fx.leaf.parentElement.children.indexOf(node), fx.leaf.parentElement.children.indexOf(fx.leaf) + 1);
});
