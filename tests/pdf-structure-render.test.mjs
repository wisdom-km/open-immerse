import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  applyStructureTranslations,
  structureTranslateSlots,
  validatePdfStructure
} from "../lib/pdf-structure-schema.js";
import {
  blockCoveredByStructure,
  blocksOutsideStructure,
  decorateAbstractHeading,
  renderPdfStructure
} from "../lib/pdf-structure-render.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const renderSrc = readFileSync(join(root, "lib/pdf-structure-render.js"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");

function createDocument() {
  const nodes = [];
  function create(tag) {
    const node = {
      tag,
      tagName: String(tag || "").toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      attrs: {},
      dataset: {},
      ownerDocument: null,
      classList: {
        add(...names) {
          const set = new Set(node.className.split(/\s+/).filter(Boolean));
          names.forEach((name) => set.add(name));
          node.className = [...set].join(" ");
        }
      },
      setAttribute(name, value) {
        node.attrs[name] = String(value);
        if (name.startsWith("data-")) node.dataset[name.slice(5)] = String(value);
      },
      append(...kids) {
        node.children.push(...kids);
      }
    };
    node.ownerDocument = doc;
    nodes.push(node);
    return node;
  }
  const doc = { createElement: create };
  return { doc, create, nodes };
}

function findAll(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const child of node.children || []) findAll(child, pred, out);
  return out;
}

const pack = validatePdfStructure({
  version: 1,
  title: "Attention Is All You Need",
  authors: [
    { name: "Ashish Vaswani", affiliation: "Google Brain", email: "avaswani@google.com" },
    { name: "Noam Shazeer", email: "not an email" }
  ],
  abstract: {
    heading: "Abstract",
    body: "The dominant sequence transduction models."
  },
  rest: [
    { role: "heading", text: "1 Introduction" },
    { role: "paragraph", text: "Recurrent neural networks." }
  ]
}).structure;

test("renderer writes textContent on a whitelist and never innerHTML", () => {
  assert.equal(renderSrc.includes("innerHTML"), false);
  assert.equal(renderSrc.includes("insertAdjacentHTML"), false);
  const { create } = createDocument();
  const root = create("div");
  renderPdfStructure({
    ...pack,
    title: "A < B",
    abstract: { ...pack.abstract, body: "<script>alert(1)</script>" }
  }, root);
  const title = root.children[0];
  assert.equal(title.tag, "h1");
  assert.equal(title.className, "oi-pdf-h1");
  assert.equal(title.textContent, "A < B");
  assert.equal(title.children.length, 0);
  const body = findAll(root, (node) => node.attrs["data-role"] === "abstract_body")[0];
  assert.equal(body.tag, "p");
  assert.equal(body.textContent, "<script>alert(1)</script>");
  assert.equal(body.children.length, 0);
  assert.equal(nodesUsingInnerHTML(root), false);
});

function nodesUsingInnerHTML(node) {
  if (Object.prototype.hasOwnProperty.call(node, "innerHTML")) return true;
  return (node.children || []).some(nodesUsingInnerHTML);
}

test("schema DOM centers the abstract heading by role and lays authors out as cells", () => {
  const { create } = createDocument();
  const root = create("div");
  renderPdfStructure(pack, root);
  const authors = root.children[1];
  assert.equal(authors.className, "oi-pdf-authors");
  assert.equal(authors.attrs["data-role"], "authors");
  assert.equal(authors.children.length, 2);
  const cell = authors.children[0];
  assert.equal(cell.className, "oi-pdf-author-cell");
  assert.equal(cell.children[0].className, "oi-pdf-author-name");
  assert.equal(cell.children[0].textContent, "Ashish Vaswani");
  assert.equal(cell.children[1].className, "oi-pdf-author-aff");
  assert.equal(cell.children[2].className, "oi-pdf-author-email");
  assert.equal(cell.children[2].tag, "a");
  assert.equal(cell.children[2].attrs.href, "mailto:avaswani@google.com");
  assert.equal(authors.children[1].children[1].tag, "div");
  assert.equal(authors.children[1].children[1].attrs.href, undefined);
  const heading = findAll(root, (node) => node.attrs["data-role"] === "abstract_heading")[0];
  assert.equal(heading.tag, "h2");
  assert.match(heading.className, /oi-pdf-abstract-heading/);
  assert.equal(heading.textContent, "Abstract");
  const restHeading = root.children[4];
  assert.equal(restHeading.tag, "h2");
  assert.equal(restHeading.className, "oi-pdf-h2");
  assert.equal(restHeading.attrs["data-role"], undefined);
  assert.match(css, /repeat\(auto-fit, minmax\(140px, 1fr\)\)/);
  assert.doesNotMatch(css, /repeat\(4,\s*1fr\)/);
  assert.match(css, /\.readout-paper \.oi-pdf-h2\[data-role="abstract_heading"\]/);
  assert.match(viewer, /renderPdfStructure/);
  assert.doesNotMatch(viewer, /\$\("mirrorPages"\)\.hidden = false/);
});

test("translated refill keeps the same tree shape and does not retarget email", () => {
  const slots = structureTranslateSlots(pack);
  const translated = applyStructureTranslations(pack, slots, slots.map((slot, index) => (
    slot.path.at(-1) === "heading" ? "摘要" : `译${index}`
  )));
  const { create } = createDocument();
  const root = create("div");
  renderPdfStructure(translated, root);
  assert.equal(findAll(root, (node) => node.attrs["data-role"] === "abstract_heading")[0].textContent, "摘要");
  assert.equal(root.children[1].children[0].children[2].textContent, "avaswani@google.com");
  assert.equal(root.children[1].children.length, pack.authors.length);
  assert.equal(root.dataset.fallback, undefined);
});

test("fallback marks Abstract by the soft string path and schema wins the abstract region", () => {
  const { create } = createDocument();
  const heading = create("h2");
  heading.className = "oi-pdf-h2";
  assert.equal(decorateAbstractHeading(heading, "Abstract"), true);
  assert.equal(heading.attrs["data-role"], "abstract_heading");
  assert.match(heading.className, /oi-pdf-abstract-heading/);
  assert.equal(decorateAbstractHeading(create("h2"), "Introduction"), false);
  const blocks = [
    { id: "t", label: "title", text: pack.title },
    { id: "a", label: "text", presentation: "byline", text: "Ashish Vaswani" },
    { id: "h", label: "heading", text: "Abstract" },
    { id: "b", label: "text", text: "The dominant sequence transduction models." },
    { id: "f", label: "formula", text: "" },
    { id: "p", label: "text", text: "This paragraph stays." }
  ];
  const rest = blocksOutsideStructure(blocks, pack);
  assert.deepEqual(rest.map((block) => block.id), ["f", "p"]);
  assert.equal(blockCoveredByStructure(blocks[2], pack), true);
  assert.equal(blockCoveredByStructure(blocks[3], pack), true);
});
