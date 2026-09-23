/** Saved PDF readout. The viewer restores this instead of translating again. */

import { blockTranslationIntegrity, isTranslatableBlock } from "./pdf-blocks.js";

const LIBRARY_BASE = "http://127.0.0.1:8765";

export const LIBRARY_PROBE_WARNING = "本地库不可用，将直接翻译。";

/** Bibliography / skipTranslate pages keep the original. This is not a review failure. */
export const PAGE_STATUS_BIBLIOGRAPHY = "本页为参考文献，保留原文（不自动翻译）。";

/** A real pending, source-uncertain, or integrity failure on a translatable block. */
export const PAGE_STATUS_PENDING_REVIEW = "本页旧译文有待核对的段落；原文已保留。";

/** Library hole that is not a skip-only page and not a corrupt translation. */
export const PAGE_STATUS_UNSAVED = "本页尚未写入本地库。";

/** Whole-document reuse when stored pairs still need review on translatable blocks. */
export const LIBRARY_HOLD_PENDING = "本地库已有逐页记录；待核对段落不会自动重新翻译。";

/** Whole-document reuse. Intentional skips are not described as pending-review failures. */
export const LIBRARY_HOLD_READY = "本地库已有逐页记录，已沿用保存的译文。参考文献保留原文，不会自动翻译。";

/** A down library is a warning. Live OI_TRANSLATE_BATCH still runs. */
export function libraryProbeFailure() {
  return { continue: true, warning: LIBRARY_PROBE_WARNING };
}

/** Preserve page-save order, including when an earlier write fails. */
export function createLibraryWriteQueue() {
  let tail = Promise.resolve();
  return (write) => {
    const job = tail.then(write);
    tail = job.catch(() => {});
    return job;
  };
}

function readablePng(dataUrl) {
  try {
    const header = atob(String(dataUrl).split(",")[1].slice(0, 36));
    if (header.slice(1, 4) !== "PNG") return false;
    const value = (at) => (
      (header.charCodeAt(at) * 0x1000000) +
      (header.charCodeAt(at + 1) << 16) +
      (header.charCodeAt(at + 2) << 8) +
      header.charCodeAt(at + 3)
    );
    return value(16) >= 24 && value(20) >= 12;
  } catch {
    return false;
  }
}

export function storedReadoutBlocks(markdown) {
  const blocks = [];
  const recentParagraphs = new Map();
  const normalized = String(markdown || "").replace(/\r\n?/g, "\n");
  for (const part of normalized.split(/\n{2,}/)) {
    const chunk = part.trim();
    if (!chunk) continue;
    const visual = chunk.replace(/^#{1,2}[ \t]+(?=!\[)/, "");
    const image = visual.match(/^!\[([^\]]*)\]\((data:image\/png;base64,[A-Za-z0-9+/=]+)\)$/);
    if (image) {
      if (readablePng(image[2])) blocks.push({ tag: "img", alt: image[1] || "公式", src: image[2] });
      continue;
    }
    if (visual.startsWith("![") || /data:image\/|chrome-extension:\/\//.test(chunk)) continue;
    const heading = chunk.match(/^(#{1,2})[ \t]+([^\n]+)$/);
    if (heading && heading[2].length <= 100 && !/[。；;]/.test(heading[2])) {
      blocks.push({ tag: heading[1].length === 1 ? "h1" : "h2", text: heading[2].trim() });
      continue;
    }
    const text = chunk.replace(/^#+\s*/, "");
    const previous = recentParagraphs.get(text);
    if (text.length >= 80 && previous != null && blocks.length - previous < 30) continue;
    if (text.length >= 80) recentParagraphs.set(text, blocks.length);
    blocks.push({ tag: "p", text });
  }
  return blocks;
}

export function pairsFromResults(results) {
  return (results || []).map((item) => ({
    text: String(item?.text || item?.original || "").trim(),
    translation: String(item?.translation || "").trim(),
    ...(item?.sourceId ? { sourceId: String(item.sourceId) } : {}),
    ...(item?.sourceText ? { sourceText: String(item.sourceText) } : {}),
    ...(item?.id ? { id: String(item.id) } : {})
  })).filter((item) => item.text && item.translation);
}

export function applySavedPairs(units, pairs) {
  const bySourceId = new Map((pairs || []).filter((item) => item.sourceId)
    .map((item) => [String(item.sourceId), item]));
  const byText = new Map((pairs || []).filter((item) => item.text && !item.sourceId)
    .map((item) => [String(item.text).trim(), item]));
  return (units || []).map((unit) => {
    if (unit?.skipTranslate === true) {
      return { ...unit, translation: "", translationStatus: "skipped" };
    }
    const hit = bySourceId.get(String(unit.sourceId || "")) || byText.get(String(unit.text || "").trim());
    if (hit?.sourceText && unit.sourceText &&
        String(hit.sourceText).replace(/\s+/g, " ").trim() !== String(unit.sourceText).replace(/\s+/g, " ").trim()) {
      return { ...unit, translation: "", translationStatus: "source-uncertain" };
    }
    return {
      ...unit,
      translation: String(hit?.translation || unit.translation || ""),
      ...(hit?.status ? { translationStatus: String(hit.status) } : {})
    };
  });
}

function normalizedPairText(row) {
  return String(row?.sourceText || row?.text || "").replace(/\s+/g, " ").trim();
}

function sameSavedBlock(row, block) {
  const rowId = String(row?.sourceId || row?.id || "");
  const blockId = String(block?.sourceId || block?.id || "");
  if (rowId && blockId && rowId === blockId) return true;
  const rowText = normalizedPairText(row);
  const blockText = normalizedPairText(block);
  return Boolean(rowText && blockText && rowText === blockText);
}

/** A page whose prose is entirely intentional skipTranslate and has nothing to translate. */
export function isSkipOnlyPage(blocks) {
  if (!Array.isArray(blocks) || !blocks.length) return false;
  const hasSkip = blocks.some((block) => block?.skipTranslate === true);
  const hasTranslatable = blocks.some((block) => isTranslatableBlock(block));
  return hasSkip && !hasTranslatable;
}

function referenceEntryText(row) {
  return /^\[\d+\]/.test(normalizedPairText(row));
}

/** pending / source-uncertain / integrity-fail. skipped and skipTranslate are not review. */
export function isReviewRow(row) {
  if (!row || row.skipTranslate === true) return false;
  const status = String(row.status || row.translationStatus || "");
  if (status === "skipped") return false;
  if (status === "pending" || status === "source-uncertain") return true;
  return Boolean(String(row.translation || "").trim()) && !blockTranslationIntegrity(row).valid;
}

/**
 * Review counts only on a block that would be translated.
 * Bare library holes, bibliography skipTranslate, and `[n]` reference entries do not.
 * Without a layout, a reference-shaped pair stays an intentional skip (historical migration).
 */
export function reviewOnTranslatableBlock(row, blocks) {
  if (!isReviewRow(row)) return false;
  if (!Array.isArray(blocks)) return !referenceEntryText(row);
  const match = blocks.find((block) => sameSavedBlock(row, block));
  if (!match) return false;
  return isTranslatableBlock(match);
}

/**
 * Page soft status.
 * A missing library page (`migrated` + empty pairs) is a hole, not a bad translation.
 * Skip-only holes use the bibliography sentence. True review stays on translatable blocks.
 */
export function pageSoftStatus({ saved = null, restored = [], blocks = null, done = "本页已翻译。" } = {}) {
  const rows = [...(saved?.pairs || []), ...(restored || [])];
  if (rows.some((row) => reviewOnTranslatableBlock(row, blocks))) {
    return { kind: "pending-review", copy: PAGE_STATUS_PENDING_REVIEW };
  }
  const skipRecord = saved?.skipped === true &&
    !(saved?.pairs || []).some((pair) => String(pair?.translation || "").trim());
  if (isSkipOnlyPage(blocks) || skipRecord) {
    return { kind: "bibliography", copy: PAGE_STATUS_BIBLIOGRAPHY };
  }
  if (saved?.migrated && !(saved?.pairs || []).length) {
    return { kind: "library-hole", copy: PAGE_STATUS_UNSAVED };
  }
  return { kind: "done", copy: done };
}

/** Library-up short-circuit. Do not call intentional non-translation a pending failure. */
export function libraryHoldCopy(pages, blocksByPage = null) {
  const list = Array.isArray(pages) ? pages : [];
  const blocksFor = (page) => {
    if (!blocksByPage) return null;
    if (typeof blocksByPage.get === "function") return blocksByPage.get(page) || null;
    return blocksByPage[page] || null;
  };
  const review = list.some((page) => (page?.pairs || []).some((pair) =>
    reviewOnTranslatableBlock(pair, blocksFor(page?.page))));
  return review ? LIBRARY_HOLD_PENDING : LIBRARY_HOLD_READY;
}

/** Lead-in for one block. Intentional skips stay silent; real review still explains itself. */
export function blockSoftLead(block) {
  if (!block || block.skipTranslate === true || block.translationStatus === "skipped" || block.status === "skipped") {
    return "";
  }
  if (block.translationStatus === "source-uncertain" && !block.translation) {
    return "（旧译文未沿用。以下为文字层原文） ";
  }
  if (block.translationStatus === "pending" && !block.translation) {
    return "（译文待核对，以下为原文） ";
  }
  if (block.translation && !blockTranslationIntegrity(block).valid) {
    return "（译文中的公式或引用与原文不符，以下为原文） ";
  }
  return "";
}

/** Page records supersede the legacy whole-document Markdown when both exist. */
export function selectSavedTranslation(document, page, blocks) {
  if (!document) return null;
  const pages = Array.isArray(document.pages) ? document.pages : [];
  if (pages.length) {
    const found = pages.find((item) => item.page === page);
    if (found) return found;
    if (isSkipOnlyPage(blocks)) return { page, pairs: [], skipped: true };
    return { page, pairs: [], migrated: true };
  }
  return document.readout ? { readout: true } : null;
}

export async function fetchLibraryDocument(hash) {
  if (!hash || hash === "nohash") return null;
  for (const delay of [0, 400, 1000, 1800]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      const res = await fetch(`${LIBRARY_BASE}/v1/library/document?hash=${encodeURIComponent(hash)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`library HTTP ${res.status}`);
      return res.json();
    } catch {
      // The Native Messaging host may have just launched port 8765.
    }
  }
  throw new Error("local PDF library unavailable");
}

export async function saveLibraryPage(payload) {
  const res = await fetch(`${LIBRARY_BASE}/v1/library/page`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`library HTTP ${res.status}`);
}
