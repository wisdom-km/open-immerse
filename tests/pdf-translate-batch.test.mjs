import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendPromptAddendum } from "../lib/providers.js";
import { buildLlmTurn } from "../lib/translate-skill.js";
import {
  PDF_PROMPT_ADDENDUM,
  applyBlockTranslations,
  blockRenderPieces,
  blockTranslationIntegrity,
  translatableBlocks
} from "../lib/pdf-blocks.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const contentSrc = readFileSync(join(root, "content/content.js"), "utf8");
const documentsSrc = readFileSync(join(root, "documents/documents.js"), "utf8");
const pdfLibSrc = readFileSync(join(root, "lib/pdf-viewer.js"), "utf8");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");

function stubChrome() {
  globalThis.chrome = {
    storage: {
      sync: { async get() { return {}; }, async set() {} },
      local: { async get() { return {}; }, async set() {} }
    },
    runtime: {
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener() {} },
      getURL: (path) => path
    },
    contextMenus: { onClicked: { addListener() {} }, async removeAll() {}, create() {} },
    commands: { onCommand: { addListener() {} } },
    tabs: { async query() { return []; }, async sendMessage() {}, async create() {} }
  };
}

test("a batch without polish still follows twoStepPolish", async () => {
  stubChrome();
  const { resolveBatchPolish } = await import("../background/service-worker.js");
  assert.equal(resolveBatchPolish({}, { twoStepPolish: true }), true);
  assert.equal(resolveBatchPolish({ texts: ["Hello"] }, { twoStepPolish: true }), true);
  assert.equal(resolveBatchPolish({}, { twoStepPolish: false }), false);
});

test("explicit polish false forces a single pass", async () => {
  stubChrome();
  const { resolveBatchPolish } = await import("../background/service-worker.js");
  assert.equal(resolveBatchPolish({ polish: false }, { twoStepPolish: true }), false);
  assert.doesNotMatch(pdfLibSrc, /polish:\s*false/);
  assert.doesNotMatch(viewerSrc, /polish:\s*false/);
});

test("PDF addendum keeps tokens, numbers, variable names, and ranks fidelity first", () => {
  assert.match(PDF_PROMPT_ADDENDUM, /⟦f1⟧/);
  assert.match(PDF_PROMPT_ADDENDUM, /⟦f2⟧/);
  assert.match(PDF_PROMPT_ADDENDUM, /Keep numbers, citation markers, and variable names exactly as written/);
  assert.match(PDF_PROMPT_ADDENDUM, /Faithfulness to the source outranks smoother wording/);
  const prompt = appendPromptAddendum("Skill", PDF_PROMPT_ADDENDUM);
  const faithful = buildLlmTurn({
    texts: ["see ⟦f1⟧"],
    skillPrompt: prompt,
    step: "faithful",
    ctx: { targetLang: "zh-CN" }
  });
  const polish = buildLlmTurn({
    texts: ["see ⟦f1⟧"],
    skillPrompt: prompt,
    step: "polish",
    drafts: ["见 ⟦f1⟧"],
    ctx: { targetLang: "zh-CN" }
  });
  assert.match(faithful.system, /⟦f1⟧/);
  assert.match(polish.system, /⟦f1⟧/);
  assert.match(pdfLibSrc, /promptAddendum: PDF_PROMPT_ADDENDUM/);
});

test("formula and author blocks stay out of the translation batch", () => {
  const blocks = [
    { id: "t", label: "text", text: "see ⟦f1⟧", placeholders: [{ token: "⟦f1⟧", blockId: "f" }] },
    { id: "f", label: "formula", bbox: [0, 0, 1, 1], imageUrl: "data:image/png;base64,aa" },
    { id: "a", label: "text", text: "Ashish Vaswani", skipTranslate: true, presentation: "byline" },
    { id: "c", label: "caption", text: "" }
  ];
  const batch = translatableBlocks(blocks);
  assert.deepEqual(batch.map((block) => block.id), ["t"]);
  assert.match(batch[0].text, /⟦f1⟧/);
});

test("a dropped placeholder keeps the Chinese sentence instead of the English source", () => {
  const formula = { id: "f", label: "formula", imageUrl: "data:image/png;base64,same" };
  const block = {
    id: "t",
    label: "text",
    text: "see ⟦f1⟧ here",
    translation: "见图",
    placeholders: [{ token: "⟦f1⟧", blockId: "f" }]
  };
  const pieces = blockRenderPieces(block, [block, formula]);
  assert.equal(blockTranslationIntegrity(block).reason, "formula-placeholder-mismatch");
  assert.equal(pieces.filter((piece) => piece.type === "image").length, 0);
  assert.equal(pieces.map((piece) => piece.text || "").join(""), "见图");
  assert.doesNotMatch(pieces.map((piece) => piece.text || "").join(""), /see /);
  const filled = applyBlockTranslations([block, formula], [{ id: "t", translation: "见图" }]);
  assert.equal(filled[1].imageUrl, "data:image/png;base64,same");
  assert.equal(filled[0].translation, "见图");
});

test("a partial placeholder translation slots what it can and appends the rest", () => {
  const block = {
    id: "t",
    label: "text",
    text: "see ⟦f1⟧ and ⟦f2⟧",
    translation: "见 ⟦f1⟧ 和后式",
    placeholders: [
      { token: "⟦f1⟧", blockId: "f1" },
      { token: "⟦f2⟧", blockId: "f2" }
    ]
  };
  const pieces = blockRenderPieces(block, [
    block,
    { id: "f1", label: "formula", imageUrl: "data:image/png;base64,one" },
    { id: "f2", label: "formula", imageUrl: "data:image/png;base64,two" }
  ]);
  assert.equal(blockTranslationIntegrity(block).reason, "formula-placeholder-mismatch");
  assert.deepEqual(pieces.map((piece) => piece.type), ["text", "image", "text", "image"]);
  assert.match(pieces[0].text, /见 /);
  assert.equal(pieces[1].blockId, "f1");
  assert.match(pieces[2].text, /和后式/);
  assert.equal(pieces[3].blockId, "f2");
  assert.doesNotMatch(pieces.map((piece) => piece.text || "").join(""), /see /);
});

test("a translation with missing citation numbers keeps the Chinese sentence", () => {
  const block = { text: "memory [13] and recurrent [7]", sourceText: "memory [13] and recurrent [7]",
    translation: "记忆 [ ] 和循环 [7]" };
  assert.equal(blockTranslationIntegrity(block).reason, "citation-mismatch");
  assert.equal(blockRenderPieces(block)[0].text, "记忆 [ ] 和循环 [7]");
  assert.doesNotMatch(blockRenderPieces(block)[0].text, /memory/);
});

test("webpage and document batches do not send a PDF addendum", () => {
  assert.equal(contentSrc.includes("promptAddendum"), false);
  assert.equal(documentsSrc.includes("promptAddendum"), false);
});
