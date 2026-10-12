import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { exportMarkdown, mergeNotesBundle, NOTES_FORMAT, NOTE_SCHEMA } from "../lib/notes-io.js";
import { readReaderPrefs } from "../lib/pdf-reader-flow.js";
import {
  overflowSelActions,
  resetSelActions,
  selAction
} from "../lib/pdf-sel-toolbar.js";
import {
  NOTES_PANEL_WIDTH_DEFAULT,
  NOTES_PANEL_WIDTH_KEY,
  NOTES_PERSIST_HINT_KEY,
  dismissPersistHint,
  normalizePanelWidth,
  persistHintDismissed,
  readNotesUiPrefs,
  writeNotesUiPrefs
} from "../lib/notes-prefs.js";
import {
  NOTES_LOADING_DELAY_MS,
  NOTES_SAVE_DEBOUNCE_MS,
  NOTES_UNDO_MS,
  NOTES_XS,
  anchorPresentation,
  currentParagraphHint,
  emptyState,
  filterCounts,
  firstLineQuote,
  groupNotes,
  importResultModel,
  kindGlyph,
  lostSectionCopy,
  noteBodySavable,
  noteMatchesFilter,
  notesBodyFont,
  notesExportFilename,
  notesListModel,
  notesMenuModel,
  paperEmptyState,
  paperNotes,
  persistHintBanner,
  pinModel,
  renderNoteMarkdown,
  replaceUndo,
  trashEmptyState,
  undoStillOpen
} from "../lib/notes-view-model.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const panelSrc = readFileSync(join(root, "pdf/notes-panel.js"), "utf8");
const modelSrc = readFileSync(join(root, "lib/notes-view-model.js"), "utf8");
const prefsSrc = readFileSync(join(root, "lib/notes-prefs.js"), "utf8");

function note(id, extra = {}) {
  return {
    id,
    kind: "note",
    author: "me",
    body: "正文",
    page: 4,
    createdAt: 1,
    updatedAt: 1,
    anchor: { bid: "b4", page: 4, offset: { start: 0 } },
    anchorState: { status: "exact" },
    ...extra
  };
}

test("filters count the current document and leave paper notes out of the five chips", () => {
  const notes = [
    note("h", { kind: "highlight", body: "" }),
    note("n", { kind: "note" }),
    note("q", { kind: "question", body: "为什么", qa: { answer: "" } }),
    note("answered", { kind: "question", author: "me", qa: { answer: "因为" } }),
    note("ai", { kind: "note", author: "ai", body: "模型写的" }),
    note("paper", { kind: "paperNote", anchor: null, page: 0 }),
    note("gone", { deletedAt: 9 }),
    note("other-doc")
  ];
  const counts = filterCounts(notes);
  assert.deepEqual(counts, { all: 6, mine: 4, highlight: 1, ai: 1, pending: 1 });
  assert.deepEqual(paperNotes(notes).map((item) => item.id), ["paper"]);
  assert.equal(counts.all, notes.filter((item) => !item.deletedAt && item.kind !== "paperNote").length);
});

test("lost cards sort to the end of their page and headings stay page-only without a section", () => {
  const notes = [
    note("late", { anchor: { bid: "b2", offset: { start: 4 } }, createdAt: 3 }),
    note("lost", { anchor: { bid: "b0", offset: { start: 0 } }, anchorState: { status: "lost" }, createdAt: 1 }),
    note("early", { anchor: { bid: "b1", offset: { start: 8 } }, createdAt: 2 }),
    note("p5", { page: 5, anchor: { bid: "b5", page: 5, offset: { start: 0 } } })
  ];
  const order = new Map([["b2", 2], ["b1", 1], ["b0", 0]]);
  const groups = groupNotes(notes, { blockOrder: order });
  assert.deepEqual(groups.map((group) => group.heading), ["原文第 4 页", "原文第 5 页"]);
  assert.deepEqual(groups[0].notes.map((item) => item.id), ["early", "late", "lost"]);
  const named = groupNotes(notes, {
    blockOrder: order,
    sectionName: (page) => (page === 4 ? "缩放点积" : "")
  });
  assert.equal(named[0].heading, "原文第 4 页 · 缩放点积");
  assert.equal(named[1].heading, "原文第 5 页");
});

test("quote and block anchors read as approximate, lost as missing", () => {
  assert.equal(anchorPresentation(note("a", { anchorState: { status: "quote" } })).label, "位置近似");
  assert.equal(anchorPresentation(note("b", { anchorState: { status: "block" } })).kind, "approx");
  assert.equal(anchorPresentation(note("c", { anchorState: { status: "lost" } })).label, "找不到原位置");
  assert.equal(anchorPresentation(note("d", { anchorState: { status: "exact" } })).label, "");
});

test("pin glyph prefers question over note over highlight and counts only past one", () => {
  assert.equal(pinModel([note("h", { kind: "highlight" })]).label, "‾");
  assert.equal(pinModel([
    note("h", { kind: "highlight" }),
    note("n", { kind: "note" })
  ]).label, "n2");
  const mixed = pinModel([
    note("h", { kind: "highlight" }),
    note("n", { kind: "note" }),
    note("q", { kind: "question" }),
    note("lost", { kind: "question", anchorState: { status: "lost" } })
  ]);
  assert.equal(mixed.glyph, "?");
  assert.equal(mixed.count, 3);
  assert.equal(mixed.label, "?3");
  assert.equal(kindGlyph("paperNote"), "¶");
  assert.equal(pinModel([note("lost", { anchorState: { status: "lost" } })]), null);
});

test("card font follows the clamped Aa scale", () => {
  const at14 = notesBodyFont(14);
  assert.equal(at14.fontSize, 13);
  assert.equal(at14.lineHeight, 22);
  const at16 = notesBodyFont(16);
  assert.equal(at16.fontSize, 13.5);
  assert.equal(at16.lineHeight, 23);
  const at28 = notesBodyFont(28);
  assert.equal(at28.fontSize, 20);
  assert.equal(at28.lineHeight, 34);
  assert.equal(at28.quoteSize, 19.5);
  assert.equal(at28.quoteLine, 31);
});

test("empty bodies are not savable and undo tracks only the latest delete", () => {
  assert.equal(noteBodySavable("  "), false);
  assert.equal(noteBodySavable("有字"), true);
  assert.equal(NOTES_UNDO_MS, 6000);
  assert.equal(NOTES_SAVE_DEBOUNCE_MS, 600);
  assert.equal(NOTES_LOADING_DELAY_MS, 150);
  const first = replaceUndo(null, { id: "a" }, 1000);
  const second = replaceUndo(first, { id: "b" }, 2000);
  assert.equal(second.id, "b");
  assert.equal(undoStillOpen(second, 2000 + 5999), true);
  assert.equal(undoStillOpen(second, 2000 + 6000), false);
  assert.notEqual(second.id, first.id);
});

test("import banner lists this document, other titles, and untitled documents", () => {
  const ok = importResultModel({
    currentDocHash: "doc-a",
    byDoc: [
      { docHash: "doc-a", title: "Attention", added: 2, updated: 1, skipped: 0, rejected: 0 },
      { docHash: "doc-b", title: "BERT", added: 3, updated: 0, skipped: 1, rejected: 0 },
      { docHash: "doc-c", title: "", added: 1, updated: 0, skipped: 0, rejected: 0 },
      { docHash: "doc-d", title: "  ", added: 4, updated: 0, skipped: 0, rejected: 0 }
    ],
    rejected: 2
  });
  assert.deepEqual(ok.lines, [
    "本文档：新增 2 · 更新 1 · 跳过 0",
    "BERT：新增 3 · 跳过 1",
    "未在本机打开过的 2 篇：新增 5",
    "无法识别 2"
  ]);
  assert.equal(ok.tone, "partial");
  const schema = importResultModel({ error: { type: "schema", schema: 4 } });
  assert.deepEqual(schema.lines, ["没有导入：文件来自更新版本的 Open Immerse（格式版本 4）"]);
  const format = importResultModel({ error: { type: "format" } });
  assert.deepEqual(format.lines, ["没有导入：这不是 Open Immerse 的笔记文件"]);
});

test("merge reports per-document counts without changing the locked totals", () => {
  const local = [note("keep", { docHash: "doc-a", rev: 2, body: "留" })];
  const bundle = {
    format: NOTES_FORMAT,
    schema: NOTE_SCHEMA,
    docs: [
      {
        docHash: "doc-a",
        title: "Attention",
        notes: [note("add", { docHash: "doc-a", body: "新" })]
      },
      {
        docHash: "doc-b",
        title: "",
        notes: [note("later", { docHash: "doc-b", body: "别的" })]
      }
    ]
  };
  const plan = mergeNotesBundle(local, bundle);
  assert.equal(plan.added, 2);
  assert.equal(plan.updated, 0);
  assert.equal(plan.skipped, 0);
  assert.deepEqual(plan.byDoc.map((row) => [row.docHash, row.title, row.added]), [
    ["doc-a", "Attention", 1],
    ["doc-b", "", 1]
  ]);
});

test("markdown heading gains a section only when a section source is passed", () => {
  const bundle = {
    docs: [{
      title: "Attention",
      docHash: "bdfaa68d",
      notes: [note("n", { page: 4, body: "记住", anchor: { quoteSrc: { quote: "Attention" } } })]
    }]
  };
  const plain = exportMarkdown(bundle);
  assert.match(plain, /## 原文第 4 页\n/);
  assert.equal(plain.includes("· 节名"), false);
  const named = exportMarkdown(bundle, { sectionName: () => "节名" });
  assert.match(named, /## 原文第 4 页 · 节名\n/);
});

test("empty copy, filenames, and markdown stay local to the notes model", () => {
  assert.equal(emptyState("all").title, "还没有笔记");
  assert.equal(emptyState("highlight").title, "没有「划线」");
  assert.equal(emptyState("ai").title, "AI 条目还没有上线");
  assert.equal(emptyState("pending").title, "没有待回答的问题");
  assert.equal(paperEmptyState().title, "还没有论文笔记");
  assert.equal(trashEmptyState().title, "回收站是空的");
  assert.equal(notesExportFilename("Attention Is All You Need.pdf", "md"), "Attention Is All You Need.pdf-笔记.md");
  assert.equal(notesExportFilename("a/b:c", "json"), "a b c-notes.json");
  assert.equal(firstLineQuote("第一行\n第二行"), "第一行");
  const html = renderNoteMarkdown("**<script>** 与 $x$");
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /class="oi-note-math"/);
});

test("panel width and the persist hint live beside the locked reader prefs", () => {
  const storage = {};
  assert.equal(normalizePanelWidth("nope"), NOTES_PANEL_WIDTH_DEFAULT);
  assert.equal(normalizePanelWidth(null), NOTES_PANEL_WIDTH_DEFAULT);
  assert.equal(normalizePanelWidth(""), NOTES_PANEL_WIDTH_DEFAULT);
  assert.equal(normalizePanelWidth(10), 360);
  assert.equal(normalizePanelWidth(900), 640);
  assert.equal(readNotesUiPrefs({}).panelWidth, NOTES_PANEL_WIDTH_DEFAULT);
  const written = writeNotesUiPrefs(storage, { panelWidth: 480 });
  assert.equal(written.panelWidth, 480);
  assert.equal(storage[NOTES_PANEL_WIDTH_KEY], "480");
  assert.equal(storage[NOTES_PERSIST_HINT_KEY], "{}");
  const dismissed = writeNotesUiPrefs(storage, dismissPersistHint(written, "doc-a"));
  assert.equal(persistHintDismissed(dismissed, "doc-a"), true);
  assert.equal(persistHintDismissed(readNotesUiPrefs(storage), "doc-b"), false);
  const reader = readReaderPrefs(storage);
  assert.equal(Object.hasOwn(reader, "panelWidth"), false);
  assert.equal(Object.hasOwn(reader, "notesPersistHintDismissed"), false);
  assert.match(prefsSrc, /Not chrome\.storage\.sync/);
  assert.equal(prefsSrc.includes("chrome.storage.local"), false);
  assert.match(prefsSrc, /reader\.panelWidth/);
  assert.match(prefsSrc, /reader\.notesPersistHintDismissed/);
});

test("question stays disabled in the builtin registry and the panel has no cross-library entry", () => {
  resetSelActions();
  const question = selAction("question");
  assert.equal(question.slot, "overflow");
  assert.equal(question.order, 15);
  assert.equal(question.label, "记为问题");
  assert.equal(question.shortcut, "Shift+N");
  assert.equal(question.keyshortcuts, "Shift+N");
  assert.equal(question.enabled(), false);
  assert.equal(selAction("highlight").keyshortcuts, "h");
  assert.equal(selAction("highlight").enabled(), false);
  assert.deepEqual(overflowSelActions().map((action) => action.id), ["copy"]);
  assert.equal(panelSrc.includes("全部笔记"), false);
  assert.match(modelSrc, /位置近似/);
  assert.match(modelSrc, /找不到原位置/);
  assert.match(panelSrc, /anchorPresentation\(note\)/);
  assert.match(panelSrc, /本文档不再提示/);
  assert.match(panelSrc, /给这段写笔记/);
  assert.equal(panelSrc.includes("chrome.storage.sync"), false);
});

test("NIM-01/03/04/09 copy and the lost section stay beside the locked page groups", () => {
  assert.equal(currentParagraphHint(null), "先在译文里点一段");
  assert.equal(currentParagraphHint(undefined), "先在译文里点一段");
  assert.equal(currentParagraphHint({ page: 4 }), "当前段：原文第 4 页");
  assert.equal(currentParagraphHint({ page: 4, section: "  " }), "当前段：原文第 4 页");
  assert.equal(currentParagraphHint({ page: 4, section: "缩放点积" }), "当前段：原文第 4 页 · 缩放点积");
  assert.equal(currentParagraphHint({ page: 0 }), "当前段：未分页");
  const lost = lostSectionCopy(2);
  assert.equal(lost.title, "找不到原位置 · 2");
  assert.equal(lost.line, "2 条找不到原位置");
  assert.equal(lost.jump, "在列表末尾 ↓");
  assert.equal(lost.collapse, "收起 ▴");
  assert.equal(lost.expand, "展开 ▾");
  assert.equal(lost.hint, anchorPresentation(note("c", { anchorState: { status: "lost" } })).hint);
  assert.equal(lostSectionCopy(0).title, "找不到原位置 · 0");
  const menu = notesMenuModel();
  assert.equal(menu.exportHeading, "导出 · 本 PDF，不含回收站");
  assert.equal(menu.importHeading, "导入 · 合并到本机，含其他文档的笔记");
  const banner = persistHintBanner();
  assert.equal(banner.line, "浏览器可能清理本机笔记，建议定期导出备份");
  assert.equal(banner.exportLabel, "导出备份");
  assert.equal(banner.dismissLabel, "本文档不再提示");
  assert.equal(NOTES_XS, 340);

  const notes = [
    note("approx", { anchorState: { status: "quote" }, createdAt: 2 }),
    note("lost-late", { page: 6, anchor: { bid: "b6", page: 6 }, anchorState: { status: "lost" }, createdAt: 4 }),
    note("lost-early", { page: 2, anchor: { bid: "b2", page: 2 }, anchorState: { status: "lost" }, createdAt: 3 }),
    note("exact", { createdAt: 1 }),
    note("pending-lost", {
      id: "pending-lost",
      kind: "question",
      page: 3,
      anchor: { bid: "b3", page: 3 },
      anchorState: { status: "lost" },
      qa: { answer: "" },
      createdAt: 5
    })
  ];
  const listed = notesListModel(notes);
  assert.deepEqual(listed.groups.map((group) => group.heading), ["原文第 4 页"]);
  assert.deepEqual(listed.groups[0].notes.map((item) => item.id), ["exact", "approx"]);
  assert.equal(anchorPresentation(listed.groups[0].notes[1]).label, "位置近似");
  assert.deepEqual(listed.lost.map((item) => item.id), ["lost-early", "pending-lost", "lost-late"]);
  assert.equal(listed.groups.some((group) => group.notes.some((item) => anchorPresentation(item).kind === "lost")), false);

  const pending = notes.filter((item) => noteMatchesFilter(item, "pending"));
  const pendingList = notesListModel(pending);
  assert.equal(pendingList.lost.length, 1);
  assert.equal(pendingList.groups.length, 0);
  const visible = pendingList.groups.reduce((sum, group) => sum + group.notes.length, 0) + pendingList.lost.length;
  assert.equal(visible, filterCounts(notes).pending);

  const noLostPending = notes.filter((item) => item.id !== "pending-lost" && noteMatchesFilter(item, "pending"));
  const quiet = notesListModel(noLostPending);
  assert.equal(quiet.lost.length, 0);
  assert.equal(quiet.groups.length, 0);
});

test("NIM panel source keeps the new rows without moving the locked import click", () => {
  assert.match(panelSrc, /class: "oi-notes-add addb"/);
  assert.match(panelSrc, /class: "hint2"/);
  assert.match(panelSrc, /currentParagraphHint\(current\)/);
  assert.match(panelSrc, /class: "lostline"/);
  assert.match(panelSrc, /class: "lostsec"/);
  assert.match(panelSrc, /lostOpen: true/);
  assert.match(panelSrc, /text: state\.lostOpen \? copy\.collapse : copy\.expand/);
  assert.match(panelSrc, /class: "ghostadd", text: "＋ 加笔记"/);
  assert.match(panelSrc, /class: "tbtn-label", text: "回收站"/);
  assert.match(panelSrc, /aria-label", `回收站，\$\{n\} 条`/);
  assert.match(panelSrc, /class: "oi-notes-banner-line"/);
  assert.match(panelSrc, /title: "本文档不再提示"/);
  assert.match(panelSrc, /notesMenuModel\(\)/);
  assert.match(panelSrc, /menuItem\("导出 Markdown".*\.md"\)/);
  assert.match(panelSrc, /scroller\.scrollTop = Math\.max\(0, top\)/);
  assert.match(panelSrc, /const scrollTop = scroll\?\.scrollTop \|\| 0/);
  assert.match(panelSrc, /nextScroll\.scrollTop = scrollTop/);
  assert.equal(panelSrc.includes("oi-note-lost-copy"), false);
  const menuAt = panelSrc.indexOf("导入 JSON…");
  const handler = panelSrc.slice(menuAt, menuAt + 80);
  assert.match(handler, /root\.querySelector\("\.oi-notes-file"\)\?\.click\(\)/);

  const css = readFileSync(join(root, "pdf/notes-panel.css"), "utf8");
  const tokens = readFileSync(join(root, "pdf/reader-tokens.css"), "utf8");
  assert.match(tokens, /--oi-notes-card-gap:\s*16px/);
  assert.match(tokens, /--oi-notes-banner-line-h:\s*32px/);
  assert.match(tokens, /--oi-notes-safe-bottom:\s*72px/);
  assert.match(tokens, /--oi-notes-xs:\s*340px/);
  assert.match(css, /\.addb[\s\S]*white-space:\s*nowrap/);
  assert.match(css, /\.addb[\s\S]*height:\s*28px/);
  assert.match(css, /\.hint2\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.hint2\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(css, /margin:\s*0 0 var\(--oi-notes-card-gap\)/);
  assert.match(css, /padding:\s*0 var\(--oi-notes-pad-x\) var\(--oi-notes-safe-bottom\)/);
  assert.match(css, /\.oi-note-card\.is-linked:hover[\s\S]*--oi-reader-mine-soft/);
  assert.match(css, /\.hl\.linked\s*\{[^}]*inset 0 -2px 0 var\(--oi-reader-mine\)/);
  assert.match(css, /\.lostline\s*\{[^}]*height:\s*28px/);
  assert.match(css, /\.lostsec\s*\{[^}]*25%/);
  assert.match(css, /\.lostsec \.oi-note-quote\s*\{[^}]*line-through/);
  assert.match(css, /\.ghostadd\s*\{[^}]*height:\s*24px/);
  assert.match(css, /\.oi-notes-banner-line\s*\{[^}]*height:\s*var\(--oi-notes-banner-line-h\)/);
  assert.match(css, /\.oi-notes-trash\.tbtn\s*\{[^}]*height:\s*30px/);
  assert.match(css, /\.oi-notes\.xs \.tbtn-label\s*\{\s*display:\s*none/);
  assert.match(css, /\.oi-notes\.xs \.addb kbd\s*\{\s*display:\s*none/);
  assert.match(css, /\.oi-notes-skeleton\s*\{[^}]*var\(--oi-notes-card-gap\)/);

  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const start = viewer.indexOf("function jumpToNoteAnchor");
  const end = viewer.indexOf("function notesFromSel");
  const jump = viewer.slice(start, end);
  assert.equal(jump.includes("jumpTranslationToSource"), false);
  assert.match(jump, /jumpPairId = ""/);
  assert.match(jump, /currentPairId = el\.dataset\.pairId/);
  assert.match(jump, /scrollSourceToRect\(rect\)/);
});

test("NB-14 import menu clicks the file input inside the notes panel", () => {
  const menuAt = panelSrc.indexOf("导入 JSON…");
  const handler = panelSrc.slice(menuAt, menuAt + 80);
  assert.match(handler, /root\.querySelector\("\.oi-notes-file"\)\?\.click\(\)/);
  assert.match(panelSrc, /root\.append\(fileInput\)/);
  assert.match(panelSrc, /if \(fileInput\) nodes\.push\(fileInput\)/);
  assert.equal(panelSrc.includes("slot.append(file"), false);
  assert.equal(panelSrc.includes('class: "oi-notes-file"'), true);
  const fileRule = readFileSync(join(root, "pdf/notes-panel.css"), "utf8");
  assert.match(fileRule, /\.oi-notes-file\s*\{[^}]*clip:\s*rect\(0 0 0 0\)/);
  assert.equal(/\.oi-notes-file\s*\{\s*display:\s*none/.test(fileRule), false);
});
