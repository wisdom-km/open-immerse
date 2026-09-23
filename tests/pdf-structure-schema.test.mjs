import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LIBRARY_PROBE_WARNING, libraryProbeFailure } from "../lib/pdf-library.js";
import { completePdfStructure, getProvider } from "../lib/providers.js";
import {
  PDF_STRUCTURE_ID,
  applyStructureTranslations,
  isTitlePageCandidate,
  parsePdfStructureJson,
  structureTranslateSlots,
  structureUserPrompt,
  validatePdfStructure
} from "../lib/pdf-structure-schema.js";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const worker = readFileSync(join(root, "background/service-worker.js"), "utf8");

const attention = {
  version: 1,
  page: 1,
  title: "Attention Is All You Need",
  authors: [
    { name: "Ashish Vaswani", aff: "Google Brain", email: "avaswani@google.com" },
    { name: "Noam Shazeer", affiliation: "Google Brain", email: "noam@google.com" },
    { affiliation: "dropped" }
  ],
  abstract: {
    heading: "Abstract",
    body: "The dominant sequence transduction models are based on complex recurrent networks."
  },
  rest: [
    { role: "heading", text: "1 Introduction" },
    { role: "sidebar", text: "Kept as other" },
    { role: "paragraph", text: 12 },
    { role: "paragraph", text: "Recurrent neural networks." }
  ],
  extra: true
};

test("oi.pdf.structure.v1 keeps authors, drops aff alias, and ignores unknown keys", () => {
  assert.equal(PDF_STRUCTURE_ID, "oi.pdf.structure.v1");
  const parsed = validatePdfStructure(attention);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.structure.version, 1);
  assert.equal(parsed.structure.title, "Attention Is All You Need");
  assert.equal(parsed.structure.authors.length, 2);
  assert.equal(parsed.structure.authors[0].affiliation, "Google Brain");
  assert.equal(parsed.structure.authors[0].aff, undefined);
  assert.equal(parsed.structure.authors[0].email, "avaswani@google.com");
  assert.equal(parsed.structure.extra, undefined);
  assert.deepEqual(parsed.structure.rest.map((entry) => entry.role), ["heading", "other", "paragraph"]);
});

test("hard gates discard the whole pack", () => {
  assert.equal(validatePdfStructure({ ...attention, version: 2 }).ok, false);
  assert.equal(validatePdfStructure({ ...attention, title: "  " }).ok, false);
  assert.equal(validatePdfStructure({ ...attention, title: "T".repeat(501) }).ok, false);
  assert.equal(validatePdfStructure({ ...attention, authors: "Ashish" }).ok, false);
  assert.equal(validatePdfStructure({
    ...attention,
    authors: [{ name: "N".repeat(301) }]
  }).ok, false);
  assert.equal(validatePdfStructure({
    ...attention,
    abstract: { heading: "Abstract", body: "x".repeat(20001) }
  }).ok, false);
  assert.equal(validatePdfStructure({
    ...attention,
    abstract: { heading: "Abstract", body: "<script>alert(1)</script>" }
  }).ok, false);
  assert.equal(validatePdfStructure({
    ...attention,
    title: "Attention <b>Is</b> All You Need"
  }).ok, false);
});

test("bad JSON and fences fall back instead of partial render", () => {
  assert.equal(parsePdfStructureJson("not json").ok, false);
  assert.equal(parsePdfStructureJson("```json\n{]\n```").ok, false);
  const fenced = parsePdfStructureJson("```json\n" + JSON.stringify({
    version: 1,
    title: "Attention Is All You Need",
    authors: [],
    abstract: { heading: "Abstract", body: "Body" }
  }) + "\n```");
  assert.equal(fenced.ok, true);
  assert.equal(fenced.structure.authors.length, 0);
});

test("translation refills strings and leaves email and shape alone", () => {
  const pack = validatePdfStructure(attention).structure;
  const slots = structureTranslateSlots(pack);
  assert.deepEqual(slots.map((slot) => slot.path[slot.path.length - 1]), [
    "title", "name", "affiliation", "name", "affiliation", "heading", "body", "text", "text", "text"
  ]);
  assert.equal(slots.some((slot) => slot.path.at(-1) === "email"), false);
  const translated = applyStructureTranslations(pack, slots, [
    "注意力就是你所需要的一切",
    "阿希什·瓦萨瓦尼",
    "谷歌大脑",
    "诺姆·沙泽尔",
    "谷歌大脑",
    "摘要",
    "主流序列转换模型基于复杂的循环网络。",
    "1 引言",
    "保留",
    "循环神经网络。"
  ]);
  assert.equal(translated.version, 1);
  assert.equal(translated.authors.length, pack.authors.length);
  assert.equal(translated.authors[0].email, "avaswani@google.com");
  assert.equal(translated.authors[1].email, "noam@google.com");
  assert.equal(translated.abstract.heading, "摘要");
  assert.equal(translated.rest[0].role, "heading");
  assert.equal(translated.rest.length, pack.rest.length);
  assert.match(structureUserPrompt("Attention", 1), /^page: 1/);
  assert.equal(isTitlePageCandidate(1, "x".repeat(80)), true);
  assert.equal(isTitlePageCandidate(2, "x".repeat(200)), false);
  assert.equal(isTitlePageCandidate(4, "Methods\nAbstract\nBody"), true);
});

test("8765 probe failure warns and does not abort live translate", async () => {
  const failure = libraryProbeFailure();
  assert.equal(failure.continue, true);
  assert.equal(failure.warning, LIBRARY_PROBE_WARNING);
  assert.equal(failure.warning, "本地库不可用，将直接翻译。");
  for (const name of ["translateCurrentPage", "translateWholeDocument"]) {
    const start = viewer.indexOf(`async function ${name}`);
    const next = viewer.indexOf("\nasync function ", start + 10);
    const fn = viewer.slice(start, next);
    const probe = fn.slice(fn.indexOf("} catch {"), fn.indexOf("} catch {") + 80);
    assert.match(probe, /noteLibraryUnavailable\(\)/);
    assert.equal(probe.includes("return"), false);
  }
  assert.match(viewer, /OI_PDF_STRUCTURE/);
  assert.match(readFileSync(join(root, "lib/pdf-viewer.js"), "utf8"), /OI_TRANSLATE_BATCH/);
  assert.match(worker, /OI_PDF_STRUCTURE/);
  assert.equal(typeof getProvider("openai").complete, "function");
  assert.equal(getProvider("mymemory").complete, undefined);
  const skipped = await completePdfStructure({ provider: "mymemory", providers: {} }, { system: "s", user: "u" });
  assert.equal(skipped.ok, false);
});
