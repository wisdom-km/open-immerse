/**
 * Hand-bumped formula pipeline identity.
 * chainVersion still invalidates formula decision rows only.
 * This value is the layout-cache key and each saved translation.
 * Bump it when segmentation or the placeholder protocol changes
 * and the four layout files did not.
 */

export const FORMULA_PIPELINE_VERSION = "fp-1";

/** Written when a layout or pair has no pipeline from the run that produced it. */
export const UNKNOWN_FORMULA_PIPELINE = "unknown";

export const STALE_FORMULA_COPY = "这页译文来自旧的公式识别";

/** Shown under the layout engine after the one-time local-ocr reset. */
export const PDF_LAYOUT_RESET_COPY = "已改回默认文字层，可在此重新选择本地 OCR";

/** One-time settings migration. A later explicit local-ocr choice is not run again. */
export const PDF_LAYOUT_MODE_MIGRATED = "fp-1";

/** localStorage key. The settings page does not write this. */
export const ENGINE_OVERRIDE_KEY = "oi-pdf-engine";

/** Set only when something records that the user chose the override. */
export const ENGINE_OVERRIDE_EXPLICIT_KEY = "oi-pdf-engine-explicit";

/**
 * A leftover oi-pdf-engine value is not a settings choice.
 * Product code never writes the explicit marker, so an unmarked value is
 * dropped and the settings mode (empty → text layer) wins.
 * An explicit marker keeps the override, including local-ocr.
 */
export function migrateEngineOverride({ override = "", explicit = false } = {}) {
  const value = String(override || "");
  if (!value) return { override: "", migrated: false, reason: "" };
  if (explicit === true) return { override: value, migrated: false, reason: "explicit" };
  return { override: "", migrated: true, reason: "leftover" };
}

/**
 * One-time reset of a saved local-ocr mode that was not an explicit choice
 * and has no cloud key. An explicit marker keeps local-ocr. Already migrated
 * settings are left alone, including a later local-ocr selection.
 */
export function migrateStoredPdfLayout(settings) {
  const current = settings && typeof settings === "object" ? settings : {};
  if (String(current.pdfLayoutModeMigrated || "") === PDF_LAYOUT_MODE_MIGRATED) {
    return { settings: current, changed: false, reset: false };
  }
  const layout = current.pdfLayout && typeof current.pdfLayout === "object" ? { ...current.pdfLayout } : {};
  const mode = String(layout.mode || "");
  const cloud = String(layout.cloudApiKey || "").trim();
  const explicit = layout.explicit === true;
  const next = {
    ...current,
    pdfLayoutModeMigrated: PDF_LAYOUT_MODE_MIGRATED,
    pdfLayout: layout
  };
  if (mode === "local-ocr" && !cloud && !explicit) {
    next.pdfLayout = { ...layout, mode: "" };
    next.pdfLayoutResetNotice = true;
    return { settings: next, changed: true, reset: true };
  }
  return { settings: next, changed: true, reset: false };
}

/** A real pipeline stamp. Missing and "unknown" are not a version. */
export function formulaPipelineStamp(value) {
  const text = String(value || "").trim();
  if (!text || text === UNKNOWN_FORMULA_PIPELINE) return "";
  return text;
}

/** Persist the pipeline that produced the blocks. Never invent the current version. */
export function storedFormulaPipeline(value) {
  return formulaPipelineStamp(value) || UNKNOWN_FORMULA_PIPELINE;
}

export function normalizeBlockSource(value) {
  return String(value || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

function blockKind(block) {
  const label = String(block?.label || block?.role || "");
  if (label === "formula" || block?.inlineOf) {
    return block?.display === false || block?.inlineOf ? "inline" : "display";
  }
  return "text";
}

function skipBlock(block) {
  if (!block || block.skipTranslate === true) return true;
  const label = String(block.label || "");
  return label === "header" || label === "footer" || label === "page-number";
}

/** Ordered source fingerprint. Formula blocks stay in the line so a split sentence does not match. */
export function blockSourceFingerprint(blocks) {
  const lines = [];
  for (const block of blocks || []) {
    if (skipBlock(block)) continue;
    const text = normalizeBlockSource(block.sourceText || block.text || "");
    if (!text) continue;
    lines.push(`${blockKind(block)}:${text}`);
  }
  return lines.join("\n");
}

function proseBlocks(blocks) {
  return (blocks || []).filter((block) => !skipBlock(block) && blockKind(block) === "text");
}

function pairProseBlocks(pairs) {
  return (pairs || []).filter((pair) => pair && (pair.sourceText || pair.text)).map((pair) => ({
    label: "text",
    sourceText: pair.sourceText || pair.text || "",
    text: pair.text || ""
  }));
}

function hasSettledPair(pairs) {
  return (pairs || []).some((pair) => String(pair?.translation || "").trim());
}

/**
 * One pipeline value for the page, or "" when any settled pair has none
 * or the stamps disagree. Missing means the page still has to be compared.
 */
export function recordedFormulaPipeline({ pairs, layout } = {}) {
  const stamps = [];
  const layoutValue = formulaPipelineStamp(layout?.formulaPipeline);
  if (layoutValue) stamps.push(layoutValue);
  let missingPair = false;
  for (const pair of pairs || []) {
    if (!String(pair?.translation || "").trim()) continue;
    const value = formulaPipelineStamp(pair?.formulaPipeline);
    if (!value) missingPair = true;
    else stamps.push(value);
  }
  if (missingPair || !stamps.length) return "";
  const unique = new Set(stamps);
  return unique.size === 1 ? [...unique][0] : "";
}

/**
 * current: stamped with this pipeline and the fresh text layer matches.
 * compatible: blocks match the fresh text layer, stamp can be written.
 * stale: blocks do not match the fresh text layer.
 * unchecked: fresh text layer has not been read, or the rows are old.
 * absent: nothing translated.
 * A stamp alone is not current. A version bump does not stale a matching page.
 */
export function formulaCacheVerdict({
  pairs = null,
  layout = null,
  freshBlocks = null,
  pipeline = FORMULA_PIPELINE_VERSION
} = {}) {
  const storedBlocks = Array.isArray(layout?.blocks) && layout.blocks.length ? layout.blocks : null;
  const fresh = Array.isArray(freshBlocks) ? freshBlocks : null;
  const recorded = recordedFormulaPipeline({ pairs, layout });
  if (fresh && storedBlocks) {
    const same = blockSourceFingerprint(storedBlocks) === blockSourceFingerprint(fresh);
    if (!same) return "stale";
    return recorded === pipeline ? "current" : "compatible";
  }
  if (fresh && !storedBlocks && hasSettledPair(pairs)) {
    const same = blockSourceFingerprint(pairProseBlocks(pairs)) === blockSourceFingerprint(proseBlocks(fresh));
    if (!same) return "stale";
    return recorded === pipeline ? "current" : "compatible";
  }
  // The new text layer has not been read. A stored fp-1 is not proof the
  // blocks were rebuilt, so the old-page mark stays until that comparison.
  if (hasSettledPair(pairs) || storedBlocks) return "unchecked";
  return "absent";
}

/**
 * Stale pages are not done. A fully covered page is not done either until the
 * text layer is compared. A coverage hole stays partial: it still has to
 * enter the translate queue. Skips and empty pages stay as they are.
 */
export function applyFormulaVerdict(state, verdict) {
  const next = String(state || "");
  if (verdict === "stale") {
    if (next === "skipped" || next === "empty") return next;
    return "stale-formula";
  }
  if (verdict === "unchecked" && next === "done") return "formula-check";
  return next;
}

export function stampFormulaPairs(pairs, pipeline = FORMULA_PIPELINE_VERSION) {
  return (pairs || []).map((pair) => {
    if (!pair || typeof pair !== "object") return pair;
    return { ...pair, formulaPipeline: pipeline };
  });
}
