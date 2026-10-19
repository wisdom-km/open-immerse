/**
 * Library panel copy and pure formatters.
 * Strings live here so a later wording pass can edit one file.
 */

import { cleanTitle } from "./library-record.js";
import { formatUsageLabel } from "./usage-format.js";

export const LIBRARY_COPY = Object.freeze({
  title: "文献库",
  empty: "还没有论文",
  emptyBody: "打开一篇 PDF 开始阅读，译文会自动存在这台电脑上，下次打开不用重新翻译。",
  openPdf: "打开 PDF…",
  openPdfHeader: "＋ 打开 PDF…",
  import: "从旧库或备份导入…",
  unnamed: "未命名 PDF",
  full: "全文已译",
  reading: "正在阅读",
  readingReason: "正在阅读，切到其他论文后可删",
  confirmTitle: "从文献库删除这篇？",
  deleteFailed: "没删成，稍后再试。",
  searchHint: "只搜题名和文件名。",
  storageLink: "存储与备份 →",
  delete: "删除",
  cancel: "取消",
  confirmDelete: "删除",
  keepFile: "不会删除：你电脑上的 PDF 文件。",
  search: "搜索",
  clearSearch: "清除搜索",
  back: "← 返回译文",
  close: "关闭文献库",
  retry: "重试",
  pickFile: "选择文件…",
  pickOther: "换一个…",
  repick: "本机没有这篇的 PDF 副本，需要重新选一次文件。",
  urlChanged: "网址上的 PDF 已经换了版本，和这篇的译文对不上。",
  fileMismatch: "选的文件和这篇不是同一份 PDF。",
  blockedTitle: "暂时连不上本机存储"
});

export function libraryRowTitle(paper) {
  const title = cleanTitle(paper?.title);
  if (title) return { title, unnamed: false };
  const fileName = String(paper?.fileName || "").trim();
  if (fileName) return { title: fileName, unnamed: false };
  const hash = String(paper?.docHash || "");
  const id = hash ? hash.slice(0, 8) : "";
  return { title: id ? `${LIBRARY_COPY.unnamed} · ${id}` : LIBRARY_COPY.unnamed, unnamed: true };
}

export function libraryRelativeTime(ms, now = Date.now()) {
  const at = Number(ms);
  if (!Number.isFinite(at) || at <= 0) return "";
  const date = new Date(at);
  const today = new Date(now);
  if (Number.isNaN(date.getTime())) return "";
  const start = (value) => new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const day = Math.round((start(today) - start(date)) / 86400000);
  const hh = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const clock = `${hh}:${minute}`;
  if (day === 0) return `今天 ${clock}`;
  if (day === 1) return `昨天 ${clock}`;
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  if (y === today.getFullYear()) return `${m}月${d}日`;
  const mm = String(m).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  return `${y}-${mm}-${dd}`;
}

export function libraryProgressCopy(translated, total) {
  const n = Math.max(0, Math.floor(Number(translated) || 0));
  const t = Math.max(0, Math.floor(Number(total) || 0));
  if (t > 0 && n === t) return LIBRARY_COPY.full;
  return `已译 ${n} / ${t} 页`;
}

export function libraryHeaderCount(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return `${n} 篇`;
}

export function libraryFooterCopy(count, bytes) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  const size = librarySizeCopy(bytes) || "约 0 B";
  return `共 ${n} 篇 · ${size}（估算）`;
}

export function libraryNotesDeleteCopy(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  return `同时删除笔记（${n} 条，可在回收站找回）`;
}

export function librarySizeCopy(bytes) {
  return formatUsageLabel(bytes);
}

/** Local file: no http(s) source URL. A stored blob is a separate fact. */
export function librarySourceIsLocalFile(paper) {
  return !String(paper?.sourceUrl || "").trim();
}

export function deleteWillCopy({ pages = 0, hasSource = false, localFile = false } = {}) {
  const n = Math.max(0, Math.floor(Number(pages) || 0));
  const base = hasSource
    ? `会删除：译文 ${n} 页、版面缓存和 Open Immerse 保存的 PDF 副本。再打开要重新翻译（会再次调用翻译服务）。`
    : `会删除：译文 ${n} 页和版面缓存。再打开要重新翻译（会再次调用翻译服务）。`;
  if (hasSource && localFile) return `${base}下次打开要重新选一次 PDF 文件。`;
  return base;
}

export function librarySearchHit(paper, query) {
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return true;
  const title = cleanTitle(paper?.title).toLowerCase();
  const fileName = String(paper?.fileName || "").toLowerCase();
  return title.includes(needle) || fileName.includes(needle);
}

export function libraryNoHitCopy(query) {
  return `没有找到「${String(query || "").trim()}」`;
}

export function libraryDeleteAllowed(openHash, docHash) {
  const open = String(openHash || "");
  const hash = String(docHash || "");
  return !open || !hash || open !== hash;
}

export function libraryToastDeleted(title) {
  const name = String(title || LIBRARY_COPY.unnamed).trim() || LIBRARY_COPY.unnamed;
  return `已删除《${name}》`;
}

export function sortLibraryRows(rows, sort) {
  const list = (rows || []).slice();
  if (sort === "size") {
    list.sort((a, b) => (Number(b?.bytes) || 0) - (Number(a?.bytes) || 0) || String(a?.docHash).localeCompare(String(b?.docHash)));
    return list;
  }
  list.sort((a, b) => (Number(b?.lastOpenedAt) || 0) - (Number(a?.lastOpenedAt) || 0) || String(a?.docHash).localeCompare(String(b?.docHash)));
  return list;
}

/** Deep link `#library?sort=size` is consumed once. */
export function consumeLibrarySort(hash, consumed) {
  if (consumed) return { sort: "", consumed: true };
  const text = String(hash || "");
  if (!text.startsWith("#library")) return { sort: "", consumed: false };
  const q = text.includes("?") ? text.slice(text.indexOf("?") + 1) : "";
  const sort = new URLSearchParams(q).get("sort") === "size" ? "size" : "";
  return { sort, consumed: true };
}

export function libraryPanelPhase({ loading = false, blocked = false, count = 0 } = {}) {
  if (blocked) return "blocked";
  if (loading) return "blank";
  if (count > 0) return "list";
  return "empty";
}
