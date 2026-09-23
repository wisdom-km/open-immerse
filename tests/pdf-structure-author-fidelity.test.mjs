import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PDF_STRUCTURE_ID,
  PDF_STRUCTURE_SYSTEM,
  applyStructureTranslations,
  authorBylineGridOk,
  authorNameFromLine,
  harvestTitleStructure,
  missingTitleAuthors,
  pageTextForStructure,
  resolveTitleStructure,
  structureAuthorsLookTruncated,
  structureTranslateSlots,
  structureUserPrompt,
  validatePdfStructure
} from "../lib/pdf-structure-schema.js";
import { renderPdfStructure } from "../lib/pdf-structure-render.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const renderSrc = readFileSync(join(root, "lib/pdf-structure-render.js"), "utf8");
const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");

const HARD_LINES = [
  "恰好一人",
  "不得单独成 author",
  "纯符号 name",
  "脏格 ≥2"
];

const SURNAMES = ["Vaswani", "Shazeer", "Parmar", "Uszkoreit", "Jones", "Gomez", "Kaiser", "Polosukhin"];

function shell(authors, extra = {}) {
  return {
    version: 1,
    page: 1,
    title: "Attention Is All You Need",
    authors,
    abstract: { heading: "Abstract", body: "The dominant sequence transduction models." },
    ...extra
  };
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

function findAll(node, pred, out = []) {
  if (pred(node)) out.push(node);
  for (const child of node.children || []) findAll(child, pred, out);
  return out;
}

function authorGridCells(authors) {
  const rows = (authors?.children || []).filter((node) => node.className === "oi-pdf-author-row");
  if (!rows.length) return authors?.children || [];
  return rows.flatMap((row) => row.children || []);
}

function attentionAuthors() {
  return [
    { name: "Ashish Vaswani*", affiliation: "Google Brain", email: "avaswani@google.com" },
    { name: "Noam Shazeer", markers: "*", affiliation: "Google Brain", email: "noam@google.com" },
    { name: "Niki Parmar*", affiliation: "Google Research", email: "nikip@google.com" },
    { name: "Jakob Uszkoreit*", affiliation: "Google Research", email: "usz@google.com" },
    { name: "Llion Jones*", affiliation: "Google Research", email: "llion@google.com" },
    { name: "Aidan N. Gomez", markers: "*†", affiliation: "University of Toronto", email: "aidan@cs.toronto.edu" },
    { name: "Łukasz Kaiser*", affiliation: "Google Brain", email: "lukaszkaiser@google.com" },
    { name: "Illia Polosukhin*‡", affiliation: "—", email: "illia.polosukhin@gmail.com" }
  ];
}

test("structure prompts carry the four author-fidelity hard lines", () => {
  assert.equal(PDF_STRUCTURE_ID, "oi.pdf.structure.v1");
  const user = structureUserPrompt("Attention Is All You Need", 1);
  assert.match(user, /^page: 1\n/);
  for (const line of HARD_LINES) {
    assert.equal(PDF_STRUCTURE_SYSTEM.includes(line), true, line);
    assert.equal(user.includes(line), true, line);
  }
  assert.match(PDF_STRUCTURE_SYSTEM, /每个作者一个对象/);
  assert.match(PDF_STRUCTURE_SYSTEM, /禁止仅符号作者/);
});

test("C2/C5 drop one symbol-only or no-letter name and keep the pack", () => {
  const parsed = validatePdfStructure(shell([
    { name: "Ashish Vaswani", affiliation: "Google Brain", email: "avaswani@google.com" },
    { name: "*" },
    { name: " † ‡ " },
    { name: "123" },
    { name: "—" },
    { name: "***" }
  ]));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "authors-dirty");

  const one = validatePdfStructure(shell([
    { name: "Ashish Vaswani*", affiliation: "Google Brain", email: "avaswani@google.com" },
    { name: "*" },
    { name: "" },
    { affiliation: "no name" }
  ]));
  assert.equal(one.ok, true);
  assert.equal(one.structure.authors.length, 1);
  assert.equal(one.structure.authors[0].name, "Ashish Vaswani*");
});

test("C1/C3 drop one crosstalk cell and fail the pack at two", () => {
  const one = validatePdfStructure(shell([
    { name: "Ashish Vaswani", affiliation: "Google Brain Noam Shazeer", email: "avaswani@google.com" },
    { name: "Noam Shazeer", affiliation: "Google Brain", email: "noam@google.com" },
    { name: "Llion Jones", affiliation: "Google Research", email: "llion@google.com" }
  ]));
  assert.equal(one.ok, true);
  assert.deepEqual(one.structure.authors.map((author) => author.name), ["Noam Shazeer", "Llion Jones"]);

  const swapped = validatePdfStructure(shell([
    { name: "Ashish Vaswani Noam Shazeer", affiliation: "Google Brain", email: "avaswani@google.com" },
    { name: "Noam Shazeer*", affiliation: "Google Research", email: "noam@google.com" }
  ]));
  assert.equal(swapped.ok, true);
  assert.deepEqual(swapped.structure.authors.map((author) => author.name), ["Noam Shazeer*"]);

  const two = validatePdfStructure(shell([
    { name: "Ashish Vaswani", affiliation: "Google Brain Noam Shazeer" },
    { name: "Noam Shazeer", affiliation: "Google Research Ashish Vaswani" }
  ]));
  assert.equal(two.ok, false);
  assert.equal(two.reason, "authors-dirty");

  const short = validatePdfStructure(shell([
    { name: "Li", affiliation: "Lab" },
    { name: "Llion Jones", affiliation: "Google Research", email: "llion@google.com" }
  ]));
  assert.equal(short.ok, true);
  assert.deepEqual(short.structure.authors.map((author) => author.name), ["Li", "Llion Jones"]);
});

test("C3/C4 drop a foreign email or a multi-email string", () => {
  const foreign = validatePdfStructure(shell([
    { name: "Ashish Vaswani", affiliation: "Google Brain noam@google.com", email: "avaswani@google.com" },
    { name: "Noam Shazeer", affiliation: "Google Brain", email: "noam@google.com" }
  ]));
  assert.equal(foreign.ok, true);
  assert.deepEqual(foreign.structure.authors.map((author) => author.name), ["Noam Shazeer"]);

  const many = validatePdfStructure(shell([
    { name: "Ashish Vaswani", email: "avaswani@google.com noam@google.com nikip@google.com" },
    { name: "Noam Shazeer", email: "noam@google.com" }
  ]));
  assert.equal(many.ok, true);
  assert.equal(many.structure.authors.length, 1);
  assert.equal(many.structure.authors[0].email, "noam@google.com");

  const both = validatePdfStructure(shell([
    { name: "Ashish Vaswani", email: "avaswani@google.com, noam@google.com" },
    { name: "Niki Parmar", affiliation: "nikip@google.com usz@google.com" }
  ]));
  assert.equal(both.ok, false);
  assert.equal(both.reason, "authors-dirty");
});

test("legacy footnotes become rest role other and markers stay off the translate slots", () => {
  const parsed = validatePdfStructure(shell(
    [{ name: "Noam Shazeer", markers: "* †", affiliation: "Google Brain", email: "noam@google.com" }],
    {
      footnotes: [
        { marker: "*", text: "Equal contribution." },
        { marker: "†", text: "Work performed while at Google Brain." }
      ],
      rest: [
        { role: "other", text: "* Equal contribution." },
        { role: "heading", text: "1 Introduction" }
      ]
    }
  ));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.structure.footnotes, undefined);
  assert.equal(parsed.structure.authors[0].markers, "*†");
  assert.deepEqual(parsed.structure.rest, [
    { role: "other", text: "* Equal contribution." },
    { role: "other", text: "† Work performed while at Google Brain." },
    { role: "heading", text: "1 Introduction" }
  ]);
  const prose = validatePdfStructure(shell([
    { name: "Noam Shazeer", markers: "Equal contribution", email: "noam@google.com" }
  ]));
  assert.equal(prose.ok, true);
  assert.equal(prose.structure.authors[0].markers, undefined);
  assert.equal(validatePdfStructure(shell([
    { name: "Noam Shazeer", markers: "<b>*</b>" }
  ])).ok, false);

  const slots = structureTranslateSlots(parsed.structure);
  assert.equal(slots.some((slot) => slot.path[0] === "authors"), false);
  assert.equal(slots.some((slot) => slot.path.at(-1) === "name"), false);
  assert.equal(slots.some((slot) => slot.path.at(-1) === "affiliation"), false);
  assert.equal(slots.some((slot) => slot.path.at(-1) === "email"), false);
  assert.equal(slots.some((slot) => slot.path.at(-1) === "markers"), false);
  assert.deepEqual(
    slots.filter((slot) => slot.path[0] === "rest").map((slot) => slot.text),
    [
      "* Equal contribution.",
      "† Work performed while at Google Brain.",
      "1 Introduction"
    ]
  );
  const translated = applyStructureTranslations(parsed.structure, slots, slots.map((slot, index) => `译${index}`));
  assert.equal(translated.authors[0].name, parsed.structure.authors[0].name);
  assert.equal(translated.authors[0].affiliation, parsed.structure.authors[0].affiliation);
  assert.equal(translated.authors[0].markers, "*†");
  assert.equal(translated.authors[0].email, "noam@google.com");
  assert.equal(translated.rest[0].role, "other");
  assert.match(translated.rest[0].text, /^译/);
});

test("Attention fixture keeps eight authors, drops one stray symbol, and leaves footnotes outside the grid", () => {
  const parsed = validatePdfStructure(shell([
    ...attentionAuthors(),
    { name: "*" }
  ], {
    footnotes: [
      { marker: "*", text: "Equal contribution." },
      { marker: "†", text: "Work performed while at Google Brain." },
      { marker: "‡", text: "Google Research." }
    ],
    rest: [{ role: "paragraph", text: "Recurrent neural networks." }]
  }));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.structure.authors.length, 8);
  for (const surname of SURNAMES) {
    assert.equal(
      parsed.structure.authors.some((author) => author.name.includes(surname)),
      true,
      surname
    );
  }
  assert.equal(parsed.structure.authors.some((author) => !/\p{L}/u.test(author.name)), false);
  assert.equal(parsed.structure.authors[1].markers, "*");
  assert.equal(parsed.structure.authors[5].markers, "*†");
  assert.deepEqual(parsed.structure.rest.filter((entry) => entry.role === "other").map((entry) => entry.text), [
    "* Equal contribution.",
    "† Work performed while at Google Brain.",
    "‡ Google Research."
  ]);

  const partial = validatePdfStructure(shell([
    {
      name: "Ashish Vaswani* Noam Shazeer* Niki Parmar*",
      affiliation: "Google Brain Jakob Uszkoreit* Llion Jones*",
      email: "avaswani@google.com noam@google.com nikip@google.com"
    },
    { name: "*" },
    { name: "†" },
    { name: "Noam Shazeer", affiliation: "Google Brain", email: "noam@google.com" }
  ]));
  assert.equal(partial.ok, false);
  assert.equal(partial.reason, "authors-dirty");

  const { create } = createDocument();
  const host = create("div");
  renderPdfStructure(parsed.structure, host);
  const authors = findAll(host, (node) => node.className === "oi-pdf-authors")[0];
  const cells = authorGridCells(authors);
  assert.equal(cells.length, 8);
  assert.equal(cells.every((cell) => cell.className === "oi-pdf-author-cell"), true);
  const names = cells.map((cell) => cell.children[0].textContent);
  for (const surname of SURNAMES) assert.equal(names.some((name) => name.includes(surname)), true, surname);
  assert.equal(names.filter((name) => !/\p{L}/u.test(name)).length, 0);
  assert.equal(names[0], "Ashish Vaswani*");
  assert.equal(names[1], "Noam Shazeer*");
  assert.equal(names[5], "Aidan N. Gomez*†");
  assert.equal(names[7], "Illia Polosukhin*‡");
  const footnotes = findAll(host, (node) => node.className === "oi-pdf-footnotes")[0];
  assert.equal(host.children[1], authors);
  assert.equal(host.children[2].attrs["data-role"], "abstract_heading");
  assert.equal(host.children[3].attrs["data-role"], "abstract_body");
  assert.equal(host.children[4], footnotes);
  assert.equal(footnotes.children.map((node) => node.textContent).join(" "), "* Equal contribution. † Work performed while at Google Brain. ‡ Google Research.");
  assert.equal(findAll(authors, (node) => node.className === "oi-pdf-footnote").length, 0);
  assert.equal(cells.some((cell) => cell.children.some((child) => child.textContent === "*")), false);
  assert.notEqual(host.children[2], footnotes);

  const raw = create("div");
  renderPdfStructure({
    title: "Attention Is All You Need",
    authors: [{ name: "*" }, { name: "†", markers: "note" }, { name: "Niki Parmar", markers: "*" }],
    abstract: { heading: "Abstract", body: "Body" },
    rest: [{ role: "other", text: "* Equal contribution." }]
  }, raw);
  assert.equal(raw.children[1].children.length, 1);
  assert.equal(raw.children[1].children[0].children[0].textContent, "Niki Parmar*");
  assert.equal(renderSrc.includes("separateAuthorRows"), false);
  assert.equal(renderSrc.includes("innerHTML"), false);
  assert.match(css, /\.oi-pdf-footnotes/);
  assert.match(css, /repeat\(auto-fit, minmax\(140px, 1fr\)\)/);
  assert.doesNotMatch(css, /repeat\(4,\s*1fr\)/);
});

function modelPack(authors) {
  return {
    ok: true,
    raw: JSON.stringify({
      version: 1,
      title: "Attention Is All You Need",
      authors,
      abstract: { heading: "Abstract", body: "The dominant sequence transduction models." }
    })
  };
}

const firstRow = [
  { name: "Ashish Vaswani*", affiliation: "Google Brain", email: "avaswani@google.com" },
  { name: "Noam Shazeer*", affiliation: "Google Brain", email: "noam@google.com" },
  { name: "Niki Parmar*", affiliation: "Google Research", email: "nikip@google.com" },
  { name: "Jakob Uszkoreit*", affiliation: "Google Research", email: "usz@google.com" }
];

function columnBlocks() {
  return [
    { label: "title", text: "Attention Is All You Need" },
    {
      text: "Ashish Vaswani*",
      presentation: "byline",
      authorCell: {
        name: "Ashish Vaswani*",
        affiliation: "Llion Jones* Google Research",
        email: "avaswani@google.com llion@google.com"
      }
    },
    {
      text: "Noam Shazeer*",
      presentation: "byline",
      authorCell: {
        name: "Noam Shazeer*",
        affiliation: "Aidan N. Gomez*† University of Toronto Illia Polosukhin*‡",
        email: "noam@google.com aidan@cs.toronto.edu illia.polosukhin@gmail.com"
      }
    },
    {
      text: "Niki Parmar*",
      presentation: "byline",
      authorCell: {
        name: "Niki Parmar*",
        affiliation: "Łukasz Kaiser* Google Brain",
        email: "nikip@google.com lukaszkaiser@google.com"
      }
    },
    {
      text: "Jakob Uszkoreit*",
      presentation: "byline",
      authorCell: {
        name: "Jakob Uszkoreit*",
        affiliation: "Google Research",
        email: "usz@google.com"
      }
    },
    { label: "heading", text: "Abstract" },
    { label: "text", text: "The dominant sequence transduction models are based on complex recurrent networks." }
  ];
}

test("a clean first-row pack is not final when later-row names are still in the title text", async () => {
  const schemaSrc = readFileSync(join(root, "lib/pdf-structure-schema.js"), "utf8");
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  assert.equal(schemaSrc.includes("Polosukhin"), false);
  assert.equal(schemaSrc.includes("Uszkoreit"), false);
  assert.match(PDF_STRUCTURE_SYSTEM, /Do not stop after the first row/);
  assert.match(PDF_STRUCTURE_SYSTEM, /Never fold a later row/);
  assert.match(structureUserPrompt("Attention", 1), /Do not stop after the first row/);
  assert.match(viewer, /resolveTitleStructure/);

  const pageText = pageTextForStructure(columnBlocks());
  for (const surname of SURNAMES) assert.equal(pageText.includes(surname), true, surname);
  const missing = missingTitleAuthors(firstRow, pageText);
  assert.equal(structureAuthorsLookTruncated(firstRow, pageText), true);
  for (const surname of ["Jones", "Gomez", "Kaiser", "Polosukhin"]) {
    assert.equal(missing.some((name) => name.includes(surname)), true, surname);
  }
  assert.equal(missing.some((name) => /Google|University|Abstract|Attention/.test(name)), false);
  assert.equal(structureAuthorsLookTruncated(attentionAuthors(), pageText), false);
  assert.equal(missingTitleAuthors(attentionAuthors(), pageText).length, 0);

  const flat = [
    "Attention Is All You Need",
    "Ashish Vaswani* Noam Shazeer* Niki Parmar* Jakob Uszkoreit* Llion Jones* Aidan N. Gomez*† Łukasz Kaiser* Illia Polosukhin*‡",
    "Google Brain University of Toronto",
    "Abstract",
    "The dominant sequence transduction models are based on complex recurrent networks."
  ].join("\n");
  assert.equal(missingTitleAuthors(firstRow, flat).length >= 4, true);
  assert.equal(missingTitleAuthors(attentionAuthors(), flat).length, 0);

  let calls = 0;
  const recovered = await resolveTitleStructure(pageText, 1, async ({ user }) => {
    calls += 1;
    if (calls === 1) return modelPack(firstRow);
    assert.match(user, /Do not stop after the first row/);
    assert.match(user, /Llion Jones/);
    assert.match(user, /Polosukhin/);
    return modelPack(attentionAuthors());
  });
  assert.equal(calls, 2);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.structure.authors.length, 8);
  const { create } = createDocument();
  const host = create("div");
  renderPdfStructure(recovered.structure, host);
  const cells = authorGridCells(host.children[1]);
  assert.equal(cells.length, 8);
  const names = cells.map((cell) => cell.children[0].textContent);
  for (const surname of SURNAMES) assert.equal(names.some((name) => name.includes(surname)), true, surname);

  calls = 0;
  const stuck = await resolveTitleStructure(pageText, 1, async () => {
    calls += 1;
    return modelPack(firstRow);
  });
  assert.equal(calls, 2);
  assert.equal(stuck.ok, false);
  assert.equal(stuck.reason, "authors-truncated");
  assert.equal(stuck.structure, undefined);

  calls = 0;
  const once = await resolveTitleStructure(pageText, 1, async () => {
    calls += 1;
    return modelPack(attentionAuthors());
  });
  assert.equal(calls, 1);
  assert.equal(once.ok, true);
  assert.equal(once.structure.authors.length, 8);
});

function dirtyFourPack() {
  return modelPack([
    { name: "Ashish Vaswani", affiliation: "Google Brain Llion Jones", email: "avaswani@google.com" },
    { name: "Noam Shazeer", affiliation: "Google Brain Aidan N. Gomez", email: "noam@google.com" },
    { name: "Niki Parmar", affiliation: "Google Research", email: "nikip@google.com" },
    { name: "Jakob Uszkoreit", affiliation: "Google Research", email: "usz@google.com" }
  ]);
}

test("a dirty four-author merge is not a successful pack and one retry can recover eight", async () => {
  const parsed = validatePdfStructure(JSON.parse(dirtyFourPack().raw));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "authors-dirty");
  assert.equal(parsed.structure, undefined);

  const absorbed = validatePdfStructure({
    version: 1,
    title: "Attention Is All You Need",
    authors: [{
      name: "Ashish Vaswani",
      affiliation: "Google Brain Llion Jones Aidan N. Gomez",
      email: "avaswani@google.com"
    }],
    abstract: { heading: "Abstract", body: "The dominant sequence transduction models." }
  });
  assert.equal(absorbed.ok, false);
  assert.equal(absorbed.reason, "authors-dirty");

  const clean = validatePdfStructure({
    version: 1,
    title: "Attention Is All You Need",
    authors: attentionAuthors(),
    abstract: { heading: "Abstract", body: "The dominant sequence transduction models." }
  });
  assert.equal(clean.ok, true);
  assert.equal(clean.structure.authors.length, 8);

  const pageText = pageTextForStructure(columnBlocks());
  let calls = 0;
  const recovered = await resolveTitleStructure(pageText, 1, async ({ user }) => {
    calls += 1;
    if (calls === 1) return dirtyFourPack();
    assert.match(user, /Do not stop after the first row/);
    assert.match(user, /Llion Jones/);
    return modelPack(attentionAuthors());
  });
  assert.equal(calls, 2);
  assert.equal(recovered.ok, true);
  assert.equal(recovered.structure.authors.length, 8);
  const { create } = createDocument();
  const host = create("div");
  renderPdfStructure(recovered.structure, host);
  assert.equal(authorGridCells(host.children[1]).length, 8);
  assert.equal(host.children[1].attrs["data-wrap"], "4|3|1");

  calls = 0;
  const stuck = await resolveTitleStructure(pageText, 1, async () => {
    calls += 1;
    return dirtyFourPack();
  });
  assert.equal(calls, 2);
  assert.equal(stuck.ok, false);
  assert.equal(stuck.reason, "authors-dirty");
  assert.equal(stuck.structure, undefined);

  const cleanLines = ["Attention Is All You Need"];
  for (const author of attentionAuthors()) {
    cleanLines.push(author.name);
    if (author.affiliation) cleanLines.push(author.affiliation);
    if (author.email) cleanLines.push(author.email);
  }
  cleanLines.push("Abstract", "The dominant sequence transduction models.");
  const cleanText = cleanLines.join("\n");
  const harvested = harvestTitleStructure(cleanText, 1);
  assert.equal(harvested.ok, true);
  assert.equal(harvested.structure.authors.length, 8);
  assert.equal(authorNameFromLine("Google Brain Llion Jones"), "");
  assert.equal(authorBylineGridOk(attentionAuthors(), cleanText), true);
  assert.equal(authorBylineGridOk(JSON.parse(dirtyFourPack().raw).authors, cleanText), false);

  calls = 0;
  const fromLines = await resolveTitleStructure(cleanText, 1, async () => {
    calls += 1;
    return dirtyFourPack();
  });
  assert.equal(calls, 2);
  assert.equal(fromLines.ok, true);
  assert.equal(fromLines.structure.authors.length, 8);
  const again = createDocument();
  const grid = again.create("div");
  renderPdfStructure(fromLines.structure, grid);
  assert.equal(authorGridCells(grid.children[1]).length, 8);
  assert.equal(grid.children[1].attrs["data-wrap"], "4|3|1");
});
