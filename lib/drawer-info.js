/**
 * Reader drawer info and recent-paper models.
 * Formula rows omit zero counts and never name a translation service.
 */

import { libraryProgressCopy, libraryRelativeTime } from "./library-copy.js";
import { formatUsageLabel } from "./usage-format.js";

const TRANSLATED_STATES = new Set(["done", "skipped", "empty", "held"]);
const INCOMPLETE_STATES = new Set(["failed", "partial"]);

function asRows(pageStates) {
  if (!pageStates) return [];
  if (pageStates instanceof Map) {
    return [...pageStates.entries()].map(([page, value]) => ({ page, ...(value || {}) }));
  }
  return Array.isArray(pageStates) ? pageStates : [];
}

export function countInfoTranslated(pageStates) {
  let count = 0;
  for (const row of asRows(pageStates)) {
    const state = typeof row === "string" ? row : row?.state;
    if (TRANSLATED_STATES.has(state) || row?.translated === true) count += 1;
  }
  return count;
}

export function countInfoIncomplete(pageStates) {
  let count = 0;
  for (const row of asRows(pageStates)) {
    const state = typeof row === "string" ? row : row?.state;
    if (INCOMPLETE_STATES.has(state)) count += 1;
  }
  return count;
}

export function formulaBucket(block) {
  if (!block || typeof block !== "object") return "";
  const tier = String(block.formulaTier || "");
  const formula = Boolean(tier) || block.label === "formula" || block.type === "formula";
  if (!formula) return "";
  if (tier === "arxiv") return "arxiv";
  if (tier === "multimodal") return "multimodal";
  if (tier === "placeholder") return "placeholder";
  return "crop";
}

export function formulaNote(tiers) {
  const arxiv = (Number(tiers?.arxiv) || 0) > 0;
  const cropped = (Number(tiers?.crop) || 0) > 0 || (Number(tiers?.placeholder) || 0) > 0;
  if (arxiv && cropped) return "arXiv 源码的公式和原文一致；裁图和占位卡点一下就能看原文。";
  if (arxiv) return "arXiv 源码的公式和原文一致。";
  if (cropped) return "裁图和占位卡点一下就能看原文。";
  return "";
}

const FORMULA_LABELS = [
  ["arxiv", "arXiv 源码"],
  ["multimodal", "多模态"],
  ["crop", "裁原图"],
  ["placeholder", "占位卡"]
];

export function drawerInfoModel({
  pageCount = 0,
  pageStates = [],
  layouts = [],
  storedPages = 0,
  bytes = 0,
  persisted = false,
  hasSource = false
} = {}) {
  const total = Math.max(0, Math.floor(Number(pageCount) || 0));
  const translated = countInfoTranslated(pageStates);
  const incomplete = countInfoIncomplete(pageStates);
  const tiers = { arxiv: 0, multimodal: 0, crop: 0, placeholder: 0 };
  let laidOut = 0;
  for (const layout of layouts || []) {
    if (!layout) continue;
    laidOut += 1;
    for (const block of layout.blocks || []) {
      const bucket = formulaBucket(block);
      if (bucket) tiers[bucket] += 1;
    }
  }
  const formulaRows = [];
  for (const [key, label] of FORMULA_LABELS) {
    if (tiers[key] > 0) formulaRows.push({ key, label, count: tiers[key] });
  }
  const pages = Math.max(0, Math.floor(Number(storedPages) || 0));
  const size = formatUsageLabel(bytes) || "约 0 B";
  return {
    translated,
    total,
    progress: libraryProgressCopy(translated, total, { incomplete }),
    laidOut,
    formulaRows,
    note: formulaNote(tiers),
    storage: [
      { key: "saved", text: `已存 ${pages} 页 · ${size}` },
      { key: "persist", text: `浏览器清理空间时：${persisted ? "会保留" : "可能被清理"}` },
      { key: "source", text: `原 PDF 副本：${hasSource ? "已存在本机" : "没有"}` }
    ]
  };
}

export function recentPapers(papers, currentHash, limit = 15) {
  const current = String(currentHash || "");
  const cap = Math.max(0, Math.floor(Number(limit) || 0));
  return (papers || [])
    .filter((paper) => paper && paper.docHash && paper.docHash !== current && !paper.deletedAt)
    .slice()
    .sort((a, b) => (Number(b.lastOpenedAt) || 0) - (Number(a.lastOpenedAt) || 0))
    .slice(0, cap);
}

export function recentMeta(paper, now = Date.now()) {
  const progress = libraryProgressCopy(paper?.translated ?? paper?.pagesTranslated, paper?.pageCount, {
    incomplete: paper?.pagesIncomplete
  });
  const when = libraryRelativeTime(paper?.lastOpenedAt, now);
  return [progress, when].filter(Boolean).join(" · ");
}
