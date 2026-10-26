/**
 * Clear one document's translations, layout cache, and formula decisions.
 * Notes, settings, secrets, the PDF blob, and other documents stay.
 */

export const CLEAR_DOC_COPY = Object.freeze({
  item: "清空本文档译文…",
  note: "删除这篇的译文和公式缓存，笔记不受影响",
  confirm: "清空后回到未翻译状态，需要重新翻译。",
  cancel: "取消",
  confirmButton: "清空",
  toast: "已清空本文档译文",
  toastFail: "清空失败，请重试",
  libraryRow: "未翻译",
  toastMs: 3000
});

export function layoutCacheKeyPrefix(docHash) {
  const hash = String(docHash || "");
  return hash ? `oi-pdf-layout:${hash}:` : "";
}

/**
 * Confirm stays inside the menu. Cancel, Esc, and an outside click do not clear.
 * Esc and outside also close the menu. Cancel only leaves the confirm row.
 */
export function reduceClearDocConfirm(state, event) {
  const confirming = state?.confirming === true;
  if (event === "open-item") {
    return { confirming: true, clear: false, close: false, focus: "cancel" };
  }
  if (event === "cancel") {
    return { confirming: false, clear: false, close: false, focus: "" };
  }
  if (event === "escape" || event === "outside") {
    return { confirming: false, clear: false, close: true, focus: "" };
  }
  if (event === "confirm" && confirming) {
    return { confirming: false, clear: true, close: true, focus: "" };
  }
  return { confirming, clear: false, close: false, focus: "" };
}

/** A busy translation stops before the clear. The clear never starts a new one. */
export function clearDocTranslationPlan({ busy = false } = {}) {
  return { stopFirst: busy === true, autoTranslate: false };
}

export async function deleteLayoutCacheKeys(storage, docHash) {
  const prefix = layoutCacheKeyPrefix(docHash);
  if (!prefix || !storage || typeof storage.get !== "function") return [];
  const bag = await storage.get(null);
  const keys = Object.keys(bag && typeof bag === "object" ? bag : {}).filter((key) => key.startsWith(prefix));
  if (keys.length && typeof storage.remove === "function") await storage.remove(keys);
  return keys;
}

/**
 * store.clearDocTranslations deletes this document's pages, groups, and layouts
 * and leaves the paper row, source blob, and notes alone.
 * clearFormula deletes oi-formula rows for this docHash only.
 */
export async function clearDocTranslationRecords(docHash, deps = {}) {
  const hash = String(docHash || "");
  if (!hash || hash === "nohash") {
    const error = new Error("missing doc");
    error.code = "missing-doc";
    throw error;
  }
  const report = {
    docHash: hash,
    pages: 0,
    groups: 0,
    layouts: 0,
    layoutKeys: [],
    formula: false,
    notes: "kept",
    settings: "kept",
    source: "kept"
  };
  if (typeof deps.store?.clearDocTranslations === "function") {
    const cleared = await deps.store.clearDocTranslations(hash);
    report.pages = Number(cleared?.pages) || 0;
    report.groups = Number(cleared?.groups) || 0;
    report.layouts = Number(cleared?.layouts) || 0;
    report.paperKept = cleared?.paperKept === true;
  }
  report.layoutKeys = await deleteLayoutCacheKeys(deps.layoutStorage, hash);
  if (typeof deps.clearFormula === "function") {
    await deps.clearFormula(hash);
    report.formula = true;
  }
  return report;
}
