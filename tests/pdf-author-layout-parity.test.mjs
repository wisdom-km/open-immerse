import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PDF_PAPER_PAD_X } from "../lib/pdf-paper.js";
import { structureTranslateSlots } from "../lib/pdf-structure-schema.js";
import { authorWrapPlan, renderPdfStructure } from "../lib/pdf-structure-render.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
const renderSrc = readFileSync(join(root, "lib/pdf-structure-render.js"), "utf8");

const SURNAMES = ["Vaswani", "Shazeer", "Parmar", "Uszkoreit", "Jones", "Gomez", "Kaiser", "Polosukhin"];

function attentionAuthors(extra) {
  const authors = [
    { name: "Ashish Vaswani*", affiliation: "Google Brain", email: "avaswani@google.com" },
    { name: "Noam Shazeer", markers: "*", affiliation: "Google Brain", email: "noam@google.com" },
    { name: "Niki Parmar*", affiliation: "Google Research", email: "nikip@google.com" },
    { name: "Jakob Uszkoreit*", affiliation: "Google Research", email: "usz@google.com" },
    { name: "Llion Jones*", affiliation: "Google Research", email: "llion@google.com" },
    { name: "Aidan N. Gomez", markers: "*†", affiliation: "University of Toronto", email: "aidan@cs.toronto.edu" },
    { name: "Łukasz Kaiser*", affiliation: "Google Brain", email: "lukaszkaiser@google.com" },
    { name: "Illia Polosukhin*‡", affiliation: "—", email: "illia.polosukhin@gmail.com" }
  ];
  if (extra) authors.push(extra);
  return authors;
}

function createDocument() {
  function create(tag) {
    const node = {
      tag,
      tagName: String(tag || "").toUpperCase(),
      className: "",
      textContent: "",
      children: [],
      attrs: {},
      ownerDocument: null,
      setAttribute(name, value) {
        node.attrs[name] = String(value);
      },
      append(...kids) {
        node.children.push(...kids);
      }
    };
    node.ownerDocument = doc;
    return node;
  }
  const doc = { createElement: create };
  return { create };
}

function pack(authors, heading = "摘要") {
  return {
    title: "Attention Is All You Need",
    authors,
    abstract: { heading, body: "主要的序列转换模型基于复杂的循环或卷积网络。" },
    rest: [
      { role: "other", text: "* Equal contribution." },
      { role: "heading", text: "1 Introduction" }
    ]
  };
}

test("Attention byline wraps 4|3|1 inside the [7,9] gate", () => {
  assert.deepEqual(authorWrapPlan(8), [4, 3, 1]);
  assert.deepEqual(authorWrapPlan(7), [4, 3]);
  assert.deepEqual(authorWrapPlan(9), [4, 3, 2]);
  assert.equal(authorWrapPlan(6), null);
  assert.equal(authorWrapPlan(10), null);
  assert.equal(authorWrapPlan(8).reduce((sum, row) => sum + row, 0), 8);
  assert.ok(authorWrapPlan(8).every((row) => row <= 4));
});

test("a hard 140px floor cannot place four tracks in the letter measure", () => {
  const content = 612 * (1 - 2 * PDF_PAPER_PAD_X);
  const floor = 140;
  const gap = 12;
  assert.equal(Math.floor((content + gap) / (floor + gap)), 3);
  assert.match(css, /\.readout-paper \.oi-pdf-author-row\s*\{[^}]*display:\s*flex/s);
});

test("rendered Attention grid is 4|3|1 with a compact name-affiliation-email stack", () => {
  const { create } = createDocument();
  const host = create("div");
  renderPdfStructure(pack(attentionAuthors()), host);
  const authors = host.children[1];
  assert.equal(authors.className, "oi-pdf-authors");
  assert.equal(authors.attrs["data-role"], "authors");
  assert.equal(authors.attrs["data-wrap"], "4|3|1");
  const rows = authors.children;
  assert.deepEqual(rows.map((row) => row.className), [
    "oi-pdf-author-row",
    "oi-pdf-author-row",
    "oi-pdf-author-row"
  ]);
  assert.deepEqual(rows.map((row) => row.children.length), [4, 3, 1]);
  const cells = rows.flatMap((row) => row.children);
  assert.equal(cells.length, 8);
  const names = cells.map((cell) => cell.children[0].textContent);
  assert.equal(names[0], "Ashish Vaswani*");
  assert.equal(names[7], "Illia Polosukhin*‡");
  for (const surname of SURNAMES) assert.equal(names.some((name) => name.includes(surname)), true, surname);
  const stacked = cells[0].children.map((child) => child.className);
  assert.deepEqual(stacked, ["oi-pdf-author-name", "oi-pdf-author-aff", "oi-pdf-author-email"]);
  assert.equal(host.children[0].className, "oi-pdf-h1");
  assert.equal(host.children[2].attrs["data-role"], "abstract_heading");
  assert.equal(host.children[2].textContent, "摘要");
  assert.equal(host.children[3].attrs["data-role"], "abstract_body");
  assert.equal(host.children[4].className, "oi-pdf-footnotes");
  assert.equal(host.children[5].className, "oi-pdf-h2");
  assert.ok(host.children.indexOf(host.children[4]) > host.children.indexOf(host.children[3]));

  const slots = structureTranslateSlots(pack(attentionAuthors()));
  assert.equal(slots.some((slot) => slot.path[0] === "authors"), false);
  assert.equal(renderSrc.includes("separateAuthorRows"), false);
});

test("seven and nine authors keep the same row breaks without a flat string", () => {
  const { create } = createDocument();
  const seven = create("div");
  renderPdfStructure(pack(attentionAuthors().slice(0, 7)), seven);
  assert.equal(seven.children[1].attrs["data-wrap"], "4|3");
  assert.deepEqual(seven.children[1].children.map((row) => row.children.length), [4, 3]);

  const nine = create("div");
  renderPdfStructure(pack(attentionAuthors({ name: "Extra Person", affiliation: "Lab", email: "extra@example.com" })), nine);
  assert.equal(nine.children[1].attrs["data-wrap"], "4|3|2");
  assert.deepEqual(nine.children[1].children.map((row) => row.children.length), [4, 3, 2]);
});

test("paper CSS keeps max-4 auto-fit and tightens title-authors-abstract rhythm", () => {
  assert.match(css, /repeat\(auto-fit, minmax\(140px, 1fr\)\)/);
  assert.doesNotMatch(css, /repeat\(4,\s*1fr\)/);
  assert.match(css, /\.readout-paper \.oi-pdf-author-row\s*\{[^}]*display:\s*flex/s);
  assert.match(css, /\.readout-paper \.oi-pdf-author-row\s*\{[^}]*flex-wrap:\s*nowrap/s);
  assert.match(css, /\.readout-paper \.oi-pdf-author-row\s*\{[^}]*justify-content:\s*center/s);
  assert.match(css, /\.readout-paper \.oi-pdf-author-row\s*\{[^}]*align-items:\s*flex-start/s);
  assert.match(css, /\.readout-paper \.oi-pdf-author-row > \.oi-pdf-author-cell\s*\{[^}]*width:\s*max-content/s);
  assert.match(css, /\.readout-paper \.oi-pdf-author-cell\s*\{[^}]*justify-content:\s*flex-start/s);
  assert.match(css, /\.readout-paper \.oi-pdf-author-cell\s*\{[^}]*align-self:\s*start/s);
  assert.match(css, /\.readout-paper \.oi-pdf-authors\[data-role="authors"\]\s*\{[^}]*margin:\s*0 0 8px/s);
  assert.match(css, /\.readout-paper \.oi-pdf-authors\[data-role="authors"\]:has\(> \.oi-pdf-author-row\)\s*\{[^}]*gap:\s*2px/s);
  assert.match(css, /\.readout-paper \.oi-pdf-h1\s*\{[^}]*margin-bottom:\s*8px/s);
  assert.match(css, /\.readout-paper \.oi-pdf-h1\s*\{[^}]*border-block:\s*medium double var\(--oi-paper-muted\)/s);
  assert.match(css, /\.readout-paper \.oi-pdf-h2\[data-role="abstract_heading"\]\s*\{[^}]*margin-top:\s*8px/s);
  assert.match(css, /\.readout-paper \.oi-pdf-h2\[data-role="abstract_heading"\]\s*\{[^}]*text-align:\s*center/s);
  assert.doesNotMatch(css, /\.oi-pdf-h1\s*\{[^}]*font:\s*650 (?!22px)/);
});
