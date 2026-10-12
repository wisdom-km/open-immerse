/**
 * Pure notes list model for T2b.
 * Filtering, counts, grouping, anchor labels, pins, import banners, and
 * the card font clamp. No DOM and no storage.
 */

export const NOTE_FILTERS = Object.freeze([
  { id: "all", label: "全部" },
  { id: "mine", label: "我的笔记" },
  { id: "highlight", label: "划线" },
  { id: "ai", label: "AI" },
  { id: "pending", label: "待回答" }
]);

export const NOTES_UNDO_MS = 6000;
export const NOTES_SAVE_DEBOUNCE_MS = 600;
export const NOTES_LOADING_DELAY_MS = 150;
export const NOTES_BODY_FONT_MIN = 13;
export const NOTES_BODY_FONT_MAX = 20;
export const NOTES_BODY_FONT_SCALE = 0.84375;

const FILTER_EMPTY = {
  highlight: {
    title: "没有「划线」",
    body: "选中译文后点「⋯ › 划线」，或按 h。",
    action: "看全部"
  },
  mine: {
    title: "没有「我的笔记」",
    body: "选中译文后点「笔记」，或按 n 给当前段写一条。",
    action: "看全部"
  },
  ai: {
    title: "AI 条目还没有上线",
    body: "以后「问 AI」的回答可以存成 AI 条目，会出现在这里。现在这里总是空的。",
    action: null
  },
  pending: {
    title: "没有待回答的问题",
    body: "卡片上点「改成问题」，或选中文字后 ⋯ › 记为问题，它就会出现在这里。",
    action: null
  }
};

export function noteHasAnswer(note) {
  const answer = note?.qa?.answer;
  return Boolean(answer && String(answer).trim());
}

export function isPaperNote(note) {
  return note?.kind === "paperNote" && !note.deletedAt;
}

/** Anchored highlight / note / question. Paper notes stay in their own segment. */
export function isAnnotationNote(note) {
  if (!note || note.deletedAt) return false;
  if (note.kind === "paperNote") return false;
  return note.kind === "highlight" || note.kind === "note" || note.kind === "question";
}

export function noteMatchesFilter(note, filter) {
  if (!isAnnotationNote(note)) return false;
  if (filter === "all") return true;
  if (filter === "mine") return note.author === "me" && (note.kind === "note" || note.kind === "question");
  if (filter === "highlight") return note.kind === "highlight";
  if (filter === "ai") return note.author === "ai";
  if (filter === "pending") return note.kind === "question" && !noteHasAnswer(note);
  return false;
}

export function filterCounts(notes) {
  const counts = { all: 0, mine: 0, highlight: 0, ai: 0, pending: 0 };
  for (const note of notes || []) {
    for (const filter of NOTE_FILTERS) {
      if (noteMatchesFilter(note, filter.id)) counts[filter.id] += 1;
    }
  }
  return counts;
}

export function paperNotes(notes) {
  return (notes || [])
    .filter(isPaperNote)
    .slice()
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)));
}

export function anchorPresentation(note) {
  const status = note?.anchorState?.status || "";
  if (status === "lost") {
    return {
      kind: "lost",
      label: "找不到原位置",
      hint: "译文重排后没找到这段话，没有画到别处。"
    };
  }
  if (status === "quote" || status === "block") {
    return {
      kind: "approx",
      label: "位置近似",
      hint: "译文改过，这条按原文位置挂在这段附近"
    };
  }
  return { kind: "normal", label: "", hint: "" };
}

export function noteBodySavable(body) {
  return String(body || "").trim().length > 0;
}

export function firstLineQuote(text, limit = 80) {
  const line = String(text || "").split(/\n/)[0].trim();
  if (line.length <= limit) return line;
  return line.slice(0, limit);
}

function blockIndexOf(note, blockOrder) {
  const bid = note?.anchor?.bid || "";
  if (!bid || !blockOrder) return 1e9;
  if (typeof blockOrder.get === "function") {
    const value = blockOrder.get(bid);
    return Number.isFinite(value) ? value : 1e9;
  }
  const value = blockOrder[bid];
  return Number.isFinite(value) ? value : 1e9;
}

function pageOf(note) {
  const page = Number(note?.page);
  if (Number.isFinite(page) && page >= 1) return Math.floor(page);
  const anchorPage = Number(note?.anchor?.page);
  if (Number.isFinite(anchorPage) && anchorPage >= 1) return Math.floor(anchorPage);
  return 0;
}

/**
 * Group anchored notes by source page. Lost cards sit at the end of their page.
 * Section names are omitted unless `sectionName(page)` returns one.
 */
export function groupNotes(notes, { blockOrder, sectionName } = {}) {
  const buckets = new Map();
  for (const note of notes || []) {
    if (!isAnnotationNote(note)) continue;
    const page = pageOf(note);
    if (!buckets.has(page)) buckets.set(page, []);
    buckets.get(page).push(note);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((page) => {
    const rows = buckets.get(page).slice().sort((a, b) => compareInGroup(a, b, blockOrder));
    const section = typeof sectionName === "function" ? String(sectionName(page) || "").trim() : "";
    const heading = page >= 1
      ? (section ? `原文第 ${page} 页 · ${section}` : `原文第 ${page} 页`)
      : "未分页";
    return { page, section, heading, notes: rows };
  });
}

function compareInGroup(a, b, blockOrder) {
  const lostA = anchorPresentation(a).kind === "lost" ? 1 : 0;
  const lostB = anchorPresentation(b).kind === "lost" ? 1 : 0;
  if (lostA !== lostB) return lostA - lostB;
  const ia = blockIndexOf(a, blockOrder);
  const ib = blockIndexOf(b, blockOrder);
  if (ia !== ib) return ia - ib;
  const sa = Number(a?.anchor?.offset?.start);
  const sb = Number(b?.anchor?.offset?.start);
  const startA = Number.isFinite(sa) ? sa : 0;
  const startB = Number.isFinite(sb) ? sb : 0;
  if (startA !== startB) return startA - startB;
  return (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id));
}

export function trashGroups(notes) {
  const buckets = new Map();
  for (const note of notes || []) {
    if (!note?.deletedAt) continue;
    const page = pageOf(note);
    if (!buckets.has(page)) buckets.set(page, []);
    buckets.get(page).push(note);
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((page) => ({
    page,
    heading: page >= 1 ? `原文第 ${page} 页` : "论文笔记",
    notes: buckets.get(page).slice().sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0) || String(a.id).localeCompare(String(b.id)))
  }));
}

/** ? > n > ‾. Count is shown only when two or more notes share the block. */
export function pinModel(notes) {
  const live = (notes || []).filter((note) => isAnnotationNote(note) && anchorPresentation(note).kind !== "lost");
  if (!live.length) return null;
  const rank = (note) => (note.kind === "question" ? 3 : note.kind === "note" ? 2 : 1);
  let best = live[0];
  for (const note of live) if (rank(note) > rank(best)) best = note;
  const glyph = rank(best) >= 3 ? "?" : rank(best) === 2 ? "n" : "‾";
  return {
    glyph,
    count: live.length >= 2 ? live.length : 0,
    approx: live.some((note) => anchorPresentation(note).kind === "approx"),
    noteId: best.id,
    label: live.length >= 2 ? `${glyph}${live.length}` : glyph
  };
}

export function notesBodyFont(actualPx) {
  const n = Number(actualPx);
  const scaled = NOTES_BODY_FONT_SCALE * (Number.isFinite(n) ? n : 16);
  const fontSize = Math.min(NOTES_BODY_FONT_MAX, Math.max(NOTES_BODY_FONT_MIN, scaled));
  return {
    fontSize,
    lineHeight: Math.round(fontSize * 1.7),
    quoteSize: fontSize - 0.5,
    quoteLine: Math.round((fontSize - 0.5) * 1.6)
  };
}

export function emptyState(filter, { total = 0 } = {}) {
  if (filter === "all" && !(total > 0)) {
    return {
      title: "还没有笔记",
      body: "选中译文后点「笔记」或「⋯ › 划线」，也可以按 n 给当前段写一条。笔记只存在本机。",
      action: null
    };
  }
  if (filter === "ai") return { ...FILTER_EMPTY.ai };
  if (filter === "pending") return { ...FILTER_EMPTY.pending };
  const named = FILTER_EMPTY[filter];
  if (named) return { ...named };
  const label = NOTE_FILTERS.find((item) => item.id === filter)?.label || "笔记";
  return {
    title: `没有「${label}」`,
    body: "换一个筛选，或回到全部。",
    action: "看全部"
  };
}

export function paperEmptyState() {
  return {
    title: "还没有论文笔记",
    body: "整篇的感悟、总结、待办。支持 Markdown 和 $公式$，只存在本机。",
    action: null
  };
}

export function trashEmptyState() {
  return {
    title: "回收站是空的",
    body: "删除的笔记会先放在这里，可以恢复。",
    action: null
  };
}

export function formatNoteStamp(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
}

export function notesExportFilename(title, kind) {
  const cleaned = String(title || "笔记").replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  const short = cleaned || "笔记";
  return kind === "md" ? `${short}-笔记.md` : `${short}-notes.json`;
}

export function quoteText(note) {
  const selected = note?.anchor?.quote;
  if (selected && String(selected).trim()) return String(selected).trim();
  const source = note?.anchor?.quoteSrc?.quote;
  if (source && String(source).trim()) return String(source).trim();
  return "";
}

function countParts(row, { keepZero = false } = {}) {
  const parts = [];
  const fields = [
    ["added", "新增"],
    ["updated", "更新"],
    ["skipped", "跳过"]
  ];
  for (const [key, label] of fields) {
    const n = Number(row?.[key]) || 0;
    if (keepZero || n > 0) parts.push(`${label} ${n}`);
  }
  return parts;
}

/**
 * Import result banner. Current document always lists 新增/更新/跳过.
 * Other documents are one line each; untitled ones collapse into
 * 「未在本机打开过的 N 篇」.
 */
export function importResultModel({ currentDocHash = "", byDoc = [], rejected = 0, error } = {}) {
  if (error) {
    if (error.type === "schema") {
      const version = error.schema != null ? `（格式版本 ${error.schema}）` : "";
      return {
        tone: "warn",
        lines: [`没有导入：文件来自更新版本的 Open Immerse${version}`]
      };
    }
    return {
      tone: "warn",
      lines: ["没有导入：这不是 Open Immerse 的笔记文件"]
    };
  }
  const rows = Array.isArray(byDoc) ? byDoc : [];
  const current = rows.find((row) => row.docHash === currentDocHash) || { added: 0, updated: 0, skipped: 0, rejected: 0 };
  const lines = [`本文档：${countParts(current, { keepZero: true }).join(" · ")}`];
  const rowRejected = rows.reduce((sum, row) => sum + (Number(row.rejected) || 0), 0);
  const rejectedTotal = Math.max(rowRejected, Number(rejected) || 0, Number(current.rejected) || 0);
  const others = rows.filter((row) => row.docHash && row.docHash !== currentDocHash);
  const titled = others.filter((row) => String(row.title || "").trim());
  const untitled = others.filter((row) => !String(row.title || "").trim());
  for (const row of titled) {
    const parts = countParts(row);
    lines.push(parts.length ? `${row.title}：${parts.join(" · ")}` : String(row.title));
  }
  if (untitled.length) {
    const sum = untitled.reduce((acc, row) => ({
      added: acc.added + (Number(row.added) || 0),
      updated: acc.updated + (Number(row.updated) || 0),
      skipped: acc.skipped + (Number(row.skipped) || 0)
    }), { added: 0, updated: 0, skipped: 0 });
    const label = `未在本机打开过的 ${untitled.length} 篇`;
    const parts = countParts(sum);
    lines.push(parts.length ? `${label}：${parts.join(" · ")}` : label);
  }
  if (rejectedTotal > 0) lines.push(`无法识别 ${rejectedTotal}`);
  return { tone: rejectedTotal > 0 ? "partial" : "ok", lines };
}

export function writeFailureBanner(count, message) {
  const n = Math.max(0, Number(count) || 0);
  return {
    tone: "warn",
    title: `${n} 条笔记没写入磁盘`,
    body: String(message || "这次没能写进本机存储。条目还在这次打开里。")
  };
}

export function persistHintBanner() {
  return {
    tone: "neutral",
    title: "浏览器没有允许长期保存笔记",
    body: "清理浏览数据时笔记可能会丢失。建议定期导出备份。"
  };
}

/** Latest delete replaces the previous undo target. */
export function replaceUndo(previous, note, now = Date.now()) {
  if (!note?.id) return previous || null;
  return {
    id: String(note.id),
    until: now + NOTES_UNDO_MS,
    remaining: NOTES_UNDO_MS
  };
}

export function undoStillOpen(undo, now = Date.now()) {
  return Boolean(undo?.id) && Number(undo.until) > now;
}

const KIND_GLYPH = {
  highlight: "‾",
  note: "n",
  question: "?",
  paperNote: "¶"
};

export function kindGlyph(kind) {
  return KIND_GLYPH[kind] || "n";
}

export function kindLabel(kind) {
  if (kind === "highlight") return "划线";
  if (kind === "question") return "问题";
  if (kind === "paperNote") return "论文笔记";
  return "笔记";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Paragraphs, bold, italic, inline code, lists, and math placeholders.
 * KaTeX is applied later by the panel when `katex` is on the page.
 */
export function renderNoteMarkdown(source) {
  const math = [];
  const marked = String(source || "")
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
      math.push({ display: true, tex });
      return `\u0000${math.length - 1}\u0000`;
    })
    .replace(/(^|[^$])\$([^$\n]+?)\$/g, (_, lead, tex) => {
      math.push({ display: false, tex });
      return `${lead}\u0000${math.length - 1}\u0000`;
    });
  const blocks = marked.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const html = blocks.map((block) => renderBlock(block)).filter(Boolean).join("");
  return restoreMath(html, math);
}

function renderBlock(block) {
  const lines = String(block || "").split("\n");
  const items = lines.filter((line) => /^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line));
  if (items.length === lines.filter((line) => line.trim()).length && items.length) {
    const ordered = /^\s*\d+\./.test(items[0]);
    const tag = ordered ? "ol" : "ul";
    const body = items.map((line) => `<li>${inlineHtml(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ""))}</li>`).join("");
    return `<${tag}>${body}</${tag}>`;
  }
  const text = lines.map((line) => inlineHtml(line)).join("<br>");
  if (!text.trim()) return "";
  return `<p>${text}</p>`;
}

function inlineHtml(line) {
  let html = escapeHtml(line);
  html = html.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  return html;
}

function restoreMath(html, math) {
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => {
    const item = math[Number(index)];
    if (!item) return "";
    const tex = escapeHtml(item.tex);
    return `<span class="oi-note-math" data-display="${item.display ? "1" : "0"}" data-tex="${tex}">${tex}</span>`;
  });
}
