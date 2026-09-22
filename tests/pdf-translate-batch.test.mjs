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

test("a dropped placeholder is appended without changing the formula pixels", () => {
  const formula = { id: "f", label: "formula", imageUrl: "data:image/png;base64,same" };
  const block = {
    id: "t",
    label: "text",
    text: "see ⟦f1⟧",
    translation: "见图",
    placeholders: [{ token: "⟦f1⟧", blockId: "f" }]
  };
  const pieces = blockRenderPieces(block, [block, formula]);
  assert.equal(pieces.filter((piece) => piece.type === "image").length, 1);
  assert.equal(pieces.at(-1).src, "data:image/png;base64,same");
  const filled = applyBlockTranslations([block, formula], [{ id: "t", translation: "见图" }]);
  assert.equal(filled[1].imageUrl, "data:image/png;base64,same");
  assert.equal(filled[0].translation, "见图");
});

test("webpage and document batches do not send a PDF addendum", () => {
  assert.equal(contentSrc.includes("promptAddendum"), false);
  assert.equal(documentsSrc.includes("promptAddendum"), false);
});
