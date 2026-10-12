import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocument, GlobalWorkerOptions } from "../pdf/vendor/pdf.min.mjs";
import { textLayerToBlocks } from "../lib/pdf-text-layer.js";
import { blockSrcHead, stampLayoutBids } from "../lib/pdf-block-id.js";
import { createNotesStore } from "../lib/notes-store.js";
import {
  QUOTE_CONTEXT,
  createBlockAnchor,
  injectDeadExactNote,
  noteWithDeadExactBid,
  reanchorNote,
  reanchorNotes,
  reanchorOpenPage
} from "../lib/notes-anchor.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const attentionPath = join(root, "tests/fixtures/Attention_Is_All_You_Need.pdf");
const dpoPath = join(root, "tests/fixtures/Direct_Preference_Optimization_2305.18290.pdf");
const viewerSrc = readFileSync(join(root, "pdf/viewer.js"), "utf8");
const anchorSrc = readFileSync(join(root, "lib/notes-anchor.js"), "utf8");
const manifest = readFileSync(join(root, "manifest.json"), "utf8");
const TRANSLATION = "这里是锚定测试的整段译文，后面还有一些字，用来做前后文。";
const REV_A = "source-v3:aaaabbbbccccdddd";
const REV_B = "source-v3:eeeeffff00001111";
const DOC = "doc-attention";

GlobalWorkerOptions.workerSrc = new URL("../pdf/vendor/pdf.worker.min.mjs", import.meta.url).href;

function changeTail(source) {
  const text = String(source || "");
  const head = blockSrcHead(text);
  for (let index = 48; index < text.length; index += 1) {
    const ch = text[index];
    if (!/[A-Za-z]/.test(ch)) continue;
    const next = `${text.slice(0, index)}${ch === "Q" ? "Z" : "Q"}${text.slice(index + 1)}`;
    if (blockSrcHead(next) === head) return next;
  }
  return `${text}\n tail-change`;
}

function paint(layout, id, translation) {
  const copy = structuredClone(layout);
  const block = copy.blocks.find((item) => item.id === id);
  block.translation = translation;
  return copy;
}

function stampedChange(page, id, source, { alias }) {
  const layout = structuredClone(page);
  const block = layout.blocks.find((item) => item.id === id);
  block.sourceText = source;
  block.text = source;
  if (!alias) {
    delete block.bid;
    delete block.bidAliases;
  }
  return stampLayoutBids(page.page, layout);
}

function noteFrom(block, page, translation, docHash) {
  const made = createBlockAnchor({
    docHash,
    block,
    page,
    translation,
    layoutRev: "source-v3:old"
  });
  return {
    id: `n-${block.id}`,
    schema: 1,
    docHash,
    kind: "highlight",
    author: "me",
    anchor: made.anchor,
    anchorState: made.anchorState,
    page,
    rev: 1,
    createdAt: 1,
    updatedAt: 1,
    deviceId: "device-a"
  };
}

async function loadPages(path, wanted) {
  const bytes = readFileSync(path);
  const doc = await getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0,
    isOffscreenCanvasSupported: false
  }).promise;
  const want = new Set(wanted);
  const pages = [];
  try {
    for (let number = 1; number <= doc.numPages; number += 1) {
      if (!want.has(number)) continue;
      const pdfPage = await doc.getPage(number);
      const content = await pdfPage.getTextContent();
      const view = pdfPage.getViewport({ scale: 1 });
      const ops = await pdfPage.getOperatorList();
      const layout = textLayerToBlocks({
        items: content.items,
        viewport: view,
        images: { fnArray: ops.fnArray, argsArray: ops.argsArray },
        page: number
      });
      pages.push(stampLayoutBids(number, { ...layout, kind: "blocks" }));
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

function byId(pages, id) {
  for (const page of pages) {
    const block = page.blocks.find((item) => item.id === id);
    if (block) return { page, block };
  }
  return null;
}

function firstText(pages) {
  for (const page of pages) {
    const block = page.blocks.find((item) => (
      (item.label === "text" || item.label === "heading")
      && String(item.sourceText || item.text || "").length > 40
      && item.bid
    ));
    if (block) return { page, block };
  }
  return null;
}

test("createBlockAnchor stores source and translation quotes", () => {
  const translation = `${"前".repeat(40)}目标句子${"后".repeat(40)}`;
  const start = 40;
  const end = start + "目标句子".length;
  const bbox = [0.1, 0.2, 0.8, 0.3];
  const made = createBlockAnchor({
    docHash: "abc",
    page: 4,
    translation,
    start,
    end,
    sourceStart: 0,
    sourceEnd: 5,
    block: {
      id: "p4-b13",
      bid: "b1-p4-t010gv1t",
      sourceId: "p4-s11cng5c",
      sourceText: "Hello source sentence for the quote",
      bbox
    }
  });
  assert.equal(QUOTE_CONTEXT, 32);
  assert.equal(made.anchor.quote, "目标句子");
  assert.equal(made.anchor.prefix.length, 32);
  assert.equal(made.anchor.suffix.length, 32);
  assert.equal(made.anchor.quoteSrc.quote, "Hello");
  assert.equal(made.anchor.quoteSrc.prefix, "");
  assert.equal(made.anchor.legacy.pairId, "p4:p4-b13");
  assert.equal(made.anchor.legacy.sourceId, "p4-s11cng5c");
  assert.equal(made.anchor.bidV, 1);
  assert.equal(made.anchor.bid, "b1-p4-t010gv1t");
  assert.deepEqual(made.anchor.offset, { start, end });
  assert.equal(made.anchor.srcHead.length > 0, true);
  assert.equal(made.anchor.srcHash.length > 0, true);
  bbox[0] = 9;
  assert.equal(made.anchor.srcRects[0][0], 0.1);
  const paper = reanchorNote({ kind: "paperNote", page: 4, anchor: null }, [], { layoutRev: "x" });
  assert.equal(paper.skipped, true);
  assert.equal(anchorSrc.includes("function resolveBlockAnchor"), false);
  assert.match(anchorSrc, /resolveBlockAnchor\(note\.anchor, scoped\)/);
});

test("viewer re-anchors after layout and retranslate without drawing notes", () => {
  const setPage = viewerSrc.slice(viewerSrc.indexOf("function setPageLayout"), viewerSrc.indexOf("function appendReadoutNode"));
  assert.match(setPage, /reanchorLaidPage\(page\)/);
  assert.equal(setPage.includes("assignBids"), false);
  assert.match(viewerSrc, /reanchorTranslatedPage\(targetPage\)/);
  assert.match(viewerSrc, /__oiNotes/);
  assert.match(viewerSrc, /injectDeadExact/);
  assert.equal(viewerSrc.includes("indexedDB"), false);
  assert.equal(viewerSrc.includes("unlimitedStorage"), false);
  assert.equal(manifest.includes("unlimitedStorage"), false);
});

test("a dead exact bid is forced through alias, and a second note through text", async () => {
  const source = "Attention is all you need for this anchor probe sentence.";
  const block = {
    id: "p4-b7",
    bid: "b1-p4-t010gv1t",
    sourceId: "p4-src",
    label: "text",
    sourceText: source,
    text: source
  };
  const pages = [{ page: 4, blocks: [block] }];
  const aliasDraft = noteWithDeadExactBid({
    block,
    page: 4,
    docHash: DOC,
    path: "alias",
    id: "dead-alias"
  });
  assert.notEqual(aliasDraft.deadBid, block.bid);
  assert.equal(aliasDraft.note.anchor.srcHead, "");
  assert.equal(aliasDraft.note.anchor.legacy.pairId, "p4:p4-b7");
  assert.equal(aliasDraft.note.anchor.quote, "");
  const aliasHit = reanchorNote(aliasDraft.note, pages, { layoutRev: REV_B, checkedAt: 1 });
  assert.equal(aliasHit.note.anchorState.status, "alias");
  assert.equal(aliasHit.note.anchor.bid, block.bid);
  assert.equal(aliasHit.note.page, 4);
  assert.equal(aliasHit.located.how, "quoteSrc");
  assert.equal(aliasHit.located.start, 0);
  assert.equal(aliasHit.located.end, source.length);

  const textDraft = noteWithDeadExactBid({
    block,
    page: 4,
    docHash: DOC,
    path: "text",
    id: "dead-text"
  });
  assert.equal(textDraft.note.anchor.legacy, undefined);
  assert.equal(textDraft.note.anchor.srcHead.length > 0, true);
  assert.notEqual(textDraft.deadBid, block.bid);
  const textHit = reanchorNote(textDraft.note, pages, { layoutRev: REV_B, checkedAt: 2 });
  assert.equal(textHit.note.anchorState.status, "text");
  assert.equal(textHit.note.anchor.bid, block.bid);
  assert.equal(textHit.note.page, 4);
  assert.equal(textHit.located.how, "quoteSrc");
  assert.equal(textHit.located.start, 0);
  assert.equal(textHit.located.end, source.length);

  const store = createNotesStore({
    memory: true,
    persist: false,
    deviceId: "device-a",
    now: () => 40,
    createId: () => "unused"
  });
  const probed = await injectDeadExactNote({ path: "alias", page: 4, id: "probe-alias" }, {
    store,
    docHash: DOC,
    layoutRev: REV_B,
    pagesFor: () => pages
  });
  assert.equal(probed.status, "alias");
  assert.equal(probed.bid, block.bid);
  assert.equal(probed.page, 4);
  assert.equal(probed.located.how, "quoteSrc");
  assert.notEqual(probed.deadBid, probed.bid);
  const textProbe = await injectDeadExactNote({ path: "text", page: 4, id: "probe-text" }, {
    store,
    docHash: DOC,
    layoutRev: REV_B,
    pagesFor: () => pages
  });
  assert.equal(textProbe.status, "text");
  assert.equal(textProbe.bid, block.bid);
  assert.equal(textProbe.page, 4);
  assert.equal(textProbe.located.how, "quoteSrc");
  const lost = reanchorNote({
    ...textDraft.note,
    id: "dead-lost",
    anchor: {
      ...textDraft.note.anchor,
      srcHead: "zzzznotthesource",
      quoteSrc: { quote: "也没有", prefix: "", suffix: "" }
    }
  }, pages, { layoutRev: REV_B, checkedAt: 3 });
  assert.equal(lost.note.anchorState.status, "lost");
  assert.equal(lost.note.page, 4);
  assert.equal(lost.note.anchor.bid, textDraft.deadBid);
});

test("real Attention and DPO blocks re-anchor without fuzzy recovery", { timeout: 120000 }, async () => {
  const attention = await loadPages(attentionPath, [4, 5]);
  const dpo = await loadPages(dpoPath, [2, 3]);
  const page4 = attention.find((page) => page.page === 4);
  const page5 = attention.find((page) => page.page === 5);
  const found = byId(attention, "p4-b13");
  assert.equal(found.block.bid, "b1-p4-t010gv1t");
  assert.equal(page5.blocks.some((block) => block.bid === "b1-p5-t1gsw7yq"), true);
  const painted = paint(page4, "p4-b13", TRANSLATION);
  const block = painted.blocks.find((item) => item.id === "p4-b13");
  const note = noteFrom(block, 4, TRANSLATION, DOC);
  const exact = reanchorNote(note, [painted, page5], { layoutRev: REV_A, checkedAt: 1 });
  assert.equal(exact.skipped, false);
  assert.equal(exact.note.anchorState.status, "exact");
  assert.equal(exact.note.anchor.bid, "b1-p4-t010gv1t");
  assert.equal(exact.located.how, "quote");
  assert.equal(exact.note.anchorState.drift, undefined);

  const skip = reanchorNote(exact.note, [painted, page5], { layoutRev: REV_A, checkedAt: 2 });
  assert.equal(skip.skipped, true);
  assert.equal(skip.note, exact.note);
  const forced = reanchorNote(exact.note, [painted, page5], {
    layoutRev: REV_A,
    reason: "retranslate",
    checkedAt: 3
  });
  assert.equal(forced.skipped, false);

  const lostSeed = reanchorNote({
    ...note,
    anchor: {
      ...note.anchor,
      bid: "b1-p9-tmissing",
      srcHead: "zzzznotthesource",
      quote: "完全没有",
      prefix: "",
      suffix: "",
      quoteSrc: { quote: "也没有", prefix: "", suffix: "" },
      offset: { start: 0, end: 0 },
      legacy: {}
    },
    anchorState: { status: "lost", layoutRev: "source-v3:old", checkedAt: 0 }
  }, [painted, page5], { layoutRev: REV_A, checkedAt: 4 });
  assert.equal(lostSeed.note.anchorState.status, "lost");
  const recomputed = reanchorNotes([exact.note, lostSeed.note], [painted, page5], { layoutRev: REV_B, checkedAt: 5 });
  assert.equal(recomputed.length, 2);
  assert.equal(recomputed[0].skipped, false);
  assert.equal(recomputed[1].skipped, false);
  assert.equal(recomputed[0].note.anchorState.layoutRev, REV_B);
  assert.equal(recomputed[1].note.anchorState.layoutRev, REV_B);
  assert.equal(recomputed[1].note.anchorState.status, "lost");
  const sameRev = reanchorNotes([exact.note, lostSeed.note], [painted, page5], { layoutRev: REV_A, checkedAt: 6 });
  assert.equal(sameRev[0].skipped, true);
  assert.equal(sameRev[1].skipped, false);

  const source = String(block.sourceText || block.text);
  const changed = changeTail(source);
  assert.equal(blockSrcHead(changed), blockSrcHead(source));
  const aliased = stampedChange(page4, "p4-b13", changed, { alias: true });
  const aliasBlock = aliased.blocks.find((item) => item.id === "p4-b13");
  aliasBlock.translation = TRANSLATION;
  assert.notEqual(aliasBlock.bid, block.bid);
  assert.equal(aliasBlock.bidAliases.includes(block.bid), true);
  const aliasHit = reanchorNote(exact.note, [aliased, page5], { layoutRev: REV_B, checkedAt: 7 });
  assert.equal(aliasHit.note.anchorState.status, "alias");
  assert.equal(aliasHit.note.anchor.bid, aliasBlock.bid);
  assert.equal(aliasHit.note.anchor.legacy.bids.includes(block.bid), true);
  assert.equal(aliasHit.note.anchor.legacy.pairId, note.anchor.legacy.pairId);
  assert.equal(aliasHit.note.anchorState.drift, true);
  assert.notEqual(aliasHit.note.anchorState.status, "lost");

  const textLayout = stampedChange(page4, "p4-b13", changed, { alias: false });
  const textBlock = textLayout.blocks.find((item) => item.id === "p4-b13");
  textBlock.translation = TRANSLATION;
  assert.equal(textBlock.bidAliases, undefined);
  const textNote = structuredClone(note);
  delete textNote.anchor.legacy;
  const textHit = reanchorNote(textNote, [textLayout, page5], { layoutRev: REV_B, checkedAt: 8 });
  assert.equal(textHit.note.anchorState.status, "text");
  assert.equal(textHit.note.anchor.bid, textBlock.bid);
  assert.equal(textHit.note.anchorState.drift, true);

  const quoteNote = structuredClone(note);
  quoteNote.anchor.bid = "b1-p4-tmissing";
  quoteNote.anchor.srcHead = "zzzznotthesource";
  quoteNote.anchor.quoteSrc = { quote: "nope", prefix: "", suffix: "" };
  quoteNote.anchor.offset = { start: 0, end: 0 };
  delete quoteNote.anchor.legacy;
  quoteNote.anchorState = { status: "lost", layoutRev: "old", checkedAt: 0 };
  const quoteBefore = structuredClone(quoteNote.anchor);
  const quoted = reanchorNote(quoteNote, [painted, page5], { layoutRev: REV_B, checkedAt: 9 });
  assert.equal(quoted.note.anchorState.status, "quote");
  assert.deepEqual(quoted.note.anchor, quoteBefore);
  assert.equal(quoted.note.page, 4);

  const far = reanchorNote(exact.note, [{ page: 9, blocks: [{ ...block, page: 9 }] }], {
    layoutRev: "source-v3:far",
    checkedAt: 10
  });
  assert.equal(far.note.anchorState.status, "lost");
  assert.equal(far.note.page, 4);
  assert.equal(far.note.anchor.bid, block.bid);

  const dpoText = firstText(dpo);
  assert.equal(dpo.length, 2);
  assert.ok(dpoText, "DPO p2/p3 text block");
  const dpoPainted = paint(dpoText.page, dpoText.block.id, TRANSLATION);
  const dpoBlock = dpoPainted.blocks.find((item) => item.id === dpoText.block.id);
  const dpoNote = noteFrom(dpoBlock, dpoText.page.page, TRANSLATION, "doc-dpo");
  dpoNote.anchorState.layoutRev = REV_A;
  const retranslated = paint(dpoPainted, dpoBlock.id, "zzzz-retranslated");
  const backed = reanchorNote(dpoNote, [retranslated, ...dpo.filter((page) => page.page !== dpoText.page.page)], {
    layoutRev: REV_A,
    reason: "retranslate",
    checkedAt: 11
  });
  assert.equal(backed.skipped, false);
  assert.equal(backed.located.how, "quoteSrc");
  assert.equal(backed.note.anchorState.status, "exact");
  assert.notEqual(backed.note.anchorState.status, "lost");

  const offsetNote = structuredClone(dpoNote);
  offsetNote.anchor.quote = "不会出现的译文";
  offsetNote.anchor.prefix = "";
  offsetNote.anchor.suffix = "";
  offsetNote.anchor.quoteSrc = { quote: "也不会出现在原文", prefix: "", suffix: "" };
  offsetNote.anchor.offset = { start: 0, end: 99999 };
  offsetNote.anchorState = { status: "exact", layoutRev: "other", checkedAt: 0 };
  const short = paint(dpoPainted, dpoBlock.id, "短译文");
  const clamped = reanchorNote(offsetNote, [short], { layoutRev: REV_B, checkedAt: 12 });
  assert.equal(clamped.located.how, "offset");
  assert.equal(clamped.located.start, 0);
  assert.equal(clamped.located.end, "短译文".length);
  assert.equal(clamped.located.end < 99999, true);
  assert.equal(clamped.note.anchorState.status, "exact");

  const lostNote = structuredClone(dpoNote);
  const lostAnchor = structuredClone(lostNote.anchor);
  lostAnchor.bid = "b1-p2-tmissing";
  lostAnchor.srcHead = "zzzznotthesource";
  lostAnchor.quote = "完全没有";
  lostAnchor.prefix = "";
  lostAnchor.suffix = "";
  lostAnchor.quoteSrc = { quote: "也没有这段", prefix: "", suffix: "" };
  lostAnchor.offset = { start: 0, end: 0 };
  lostAnchor.legacy = {};
  lostNote.anchor = lostAnchor;
  lostNote.page = dpoText.page.page;
  lostNote.anchorState = { status: "exact", layoutRev: "old", checkedAt: 0 };
  const lostBefore = structuredClone(lostNote.anchor);
  const lost = reanchorNote(lostNote, dpo, { layoutRev: REV_B, checkedAt: 13 });
  assert.equal(lost.note.anchorState.status, "lost");
  assert.equal(lost.note.page, dpoText.page.page);
  assert.deepEqual(lost.note.anchor, lostBefore);
  assert.deepEqual(lostNote.anchor, lostBefore);
  assert.notEqual(lost.note.anchor.bid, dpoBlock.bid);

  const store = createNotesStore({
    memory: true,
    persist: false,
    deviceId: "device-a",
    now: () => 30,
    createId: () => "unused"
  });
  await store.put({ ...note, id: "on-4", docHash: DOC });
  await store.put({
    ...note,
    id: "on-1",
    docHash: DOC,
    page: 1,
    anchor: { ...note.anchor, page: 1 },
    anchorState: { status: "exact", layoutRev: REV_A, checkedAt: 1 }
  });
  const opened = await reanchorOpenPage({
    store,
    docHash: DOC,
    page: 4,
    pages: [painted, page5],
    layoutRev: REV_A,
    checkedAt: 14
  });
  assert.equal(opened.results.length, 1);
  assert.equal(opened.results[0].stored, true);
  assert.equal((await store.get("on-4")).rev, 2);
  assert.equal((await store.get("on-4")).anchorState.status, "exact");
  assert.equal((await store.get("on-1")).rev, 1);
  await store.put({ ...lost.note, id: "lost-1", docHash: DOC });
  await reanchorOpenPage({
    store,
    docHash: DOC,
    page: lost.note.page,
    pages: dpo,
    layoutRev: REV_B,
    checkedAt: 15
  });
  const kept = await store.get("lost-1");
  assert.equal(kept.anchorState.status, "lost");
  assert.equal(kept.page, dpoText.page.page);
  assert.equal((await store.list(DOC)).some((item) => item.id === "lost-1"), true);
});

test("位置近似 notes are not stored again when only the check or layout rev changes", async () => {
  let persistCalls = 0;
  const store = createNotesStore({
    memory: true,
    persist: async () => {
      persistCalls += 1;
      return false;
    },
    deviceId: "device-a",
    now: () => 40,
    createId: () => "unused-approx"
  });
  const doc = "doc-approx";
  const pages = [{
    page: 1,
    blocks: [{
      bid: "b1-p1-tother",
      id: "p1-b1",
      page: 1,
      sourceText: "other source text",
      text: "other source text",
      translation: "位置近似的引文"
    }]
  }];
  const quoteAnchor = {
    docHash: doc,
    bid: "b1-p1-tmissing",
    page: 1,
    srcHead: "zzzznotthesource",
    quote: "位置近似的引文",
    prefix: "",
    suffix: "",
    quoteSrc: { quote: "nope", prefix: "", suffix: "" },
    offset: { start: 0, end: 0 }
  };
  await store.put({
    id: "approx",
    docHash: doc,
    kind: "highlight",
    page: 1,
    anchor: quoteAnchor,
    anchorState: { status: "quote", layoutRev: "source-v3:old", checkedAt: 1 }
  });
  const first = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages,
    layoutRev: "source-v3:new",
    checkedAt: 2
  });
  assert.equal(first.results.find((row) => row.note.id === "approx").stored, false);
  assert.equal((await store.get("approx")).rev, 1);
  assert.equal((await store.get("approx")).anchorState.layoutRev, "source-v3:old");
  assert.equal((await store.get("approx")).anchorState.status, "quote");
  const second = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages,
    layoutRev: "source-v3:newer",
    checkedAt: 3
  });
  assert.equal(second.results.find((row) => row.note.id === "approx").stored, false);
  assert.equal((await store.get("approx")).rev, 1);
  assert.equal(persistCalls, 1);

  await store.put({
    id: "blocked",
    docHash: doc,
    kind: "highlight",
    page: 1,
    anchor: {
      docHash: doc,
      bid: "b1-p1-tother",
      page: 1,
      quote: "没有这段译文",
      prefix: "",
      suffix: "",
      offset: { start: 0, end: 0 }
    },
    anchorState: { status: "block", layoutRev: "source-v3:old", checkedAt: 1 }
  });
  const blocked = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages,
    layoutRev: "source-v3:block",
    checkedAt: 4
  });
  assert.equal(blocked.results.find((row) => row.note.id === "blocked").stored, false);
  assert.equal((await store.get("blocked")).rev, 1);
  assert.equal((await store.get("blocked")).anchorState.status, "block");

  await store.put({
    id: "exact-1",
    docHash: doc,
    kind: "highlight",
    page: 1,
    anchor: {
      docHash: doc,
      bid: "b1-p1-tother",
      page: 1,
      quote: "位置近似的引文",
      prefix: "",
      suffix: "",
      offset: { start: 0, end: "位置近似的引文".length }
    },
    anchorState: { status: "exact", layoutRev: "source-v3:old", checkedAt: 1 }
  });
  const exact = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages,
    layoutRev: REV_A,
    checkedAt: 5
  });
  assert.equal(exact.results.find((row) => row.note.id === "exact-1").stored, true);
  assert.equal((await store.get("exact-1")).rev, 2);
  assert.equal((await store.get("exact-1")).anchorState.status, "exact");
  assert.equal((await store.get("approx")).rev, 1);
  assert.equal(persistCalls, 1);

  const lostPages = [{
    page: 1,
    blocks: [{
      bid: "b1-p1-tother",
      id: "p1-b1",
      page: 1,
      sourceText: "other source text",
      text: "other source text",
      translation: "完全不同"
    }]
  }];
  const lost = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages: lostPages,
    layoutRev: REV_B,
    checkedAt: 6
  });
  assert.equal(lost.results.find((row) => row.note.id === "approx").stored, true);
  assert.equal((await store.get("approx")).anchorState.status, "lost");
  assert.equal((await store.get("approx")).anchor.bid, "b1-p1-tmissing");
  assert.equal(persistCalls, 1);
});

test("版面晚到时位置近似笔记不写库，revision 不变", async () => {
  let persistCalls = 0;
  const store = createNotesStore({
    memory: true,
    persist: async () => {
      persistCalls += 1;
      return false;
    },
    deviceId: "device-a",
    now: () => 50,
    createId: () => "unused-late"
  });
  const doc = "doc-late-layout";
  const quote = "版面晚到的引文";
  await store.put({
    id: "late",
    docHash: doc,
    kind: "highlight",
    page: 1,
    anchor: {
      docHash: doc,
      bid: "b1-p1-tmissing",
      page: 1,
      srcHead: "zzzznotthesource",
      quote,
      prefix: "",
      suffix: "",
      quoteSrc: { quote: "nope", prefix: "", suffix: "" },
      offset: { start: 0, end: 0 }
    },
    anchorState: { status: "quote", layoutRev: "source-v3:old", checkedAt: 1 }
  });
  assert.equal((await store.get("late")).rev, 1);

  const empty = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages: [],
    layoutRev: "source-v3:empty",
    checkedAt: 2
  });
  assert.equal(empty.results.find((row) => row.note.id === "late").stored, false);
  assert.equal(empty.results.find((row) => row.note.id === "late").pendingLayout, true);
  assert.equal((await store.get("late")).rev, 1);
  assert.equal((await store.get("late")).anchorState.status, "quote");

  const neighbor = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages: [{
      page: 2,
      blocks: [{
        bid: "b1-p2-tother",
        id: "p2-b1",
        page: 2,
        sourceText: "neighbor source",
        text: "neighbor source",
        translation: "邻页译文"
      }]
    }],
    layoutRev: "source-v3:neighbor",
    checkedAt: 3
  });
  assert.equal(neighbor.results.find((row) => row.note.id === "late").stored, false);
  assert.equal(neighbor.results.find((row) => row.note.id === "late").pendingLayout, true);
  assert.equal((await store.get("late")).rev, 1);
  assert.equal((await store.get("late")).anchorState.status, "quote");

  const untranslated = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages: [{
      page: 1,
      blocks: [{
        bid: "b1-p1-tother",
        id: "p1-b1",
        page: 1,
        sourceText: "source is here",
        text: "source is here",
        translation: ""
      }]
    }],
    layoutRev: "source-v3:bare",
    checkedAt: 4
  });
  assert.equal(untranslated.results.find((row) => row.note.id === "late").stored, false);
  assert.equal(untranslated.results.find((row) => row.note.id === "late").pendingLayout, true);
  assert.equal((await store.get("late")).rev, 1);
  assert.equal((await store.get("late")).anchorState.status, "quote");

  const ready = await reanchorOpenPage({
    store,
    docHash: doc,
    page: 1,
    pages: [{
      page: 1,
      blocks: [{
        bid: "b1-p1-tother",
        id: "p1-b1",
        page: 1,
        sourceText: "source is here",
        text: "source is here",
        translation: quote
      }]
    }],
    layoutRev: "source-v3:ready",
    checkedAt: 5
  });
  const row = ready.results.find((item) => item.note.id === "late");
  assert.equal(row.stored, false);
  assert.equal(row.note.anchorState.status, "quote");
  const saved = await store.get("late");
  assert.equal(saved.rev, 1);
  assert.equal(saved.anchorState.status, "quote");
  assert.equal(saved.anchorState.layoutRev, "source-v3:old");
  assert.equal(persistCalls, 1);
});
