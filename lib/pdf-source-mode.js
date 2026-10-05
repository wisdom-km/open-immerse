/**
 * Source-pane layout modes (SPEC rev 3.8, SM-01…08).
 * side = split columns, mini = collapsible source panel, hidden = translation only.
 * Window bands coerce the effective mode. Stored reader.sourceMode is not overwritten
 * when a narrow window forces hidden, or when 900–945 cannot fit side.
 */

export const SOURCE_MODES = Object.freeze(["side", "mini", "hidden"]);
export const SOURCE_MODE_STORAGE_KEY = "reader.sourceMode";
export const MINI_WIDTH_STORAGE_KEY = "reader.miniWidth";
export const MINI_COLLAPSED_STORAGE_KEY = "reader.miniCollapsed";
export const MINI_WIDTH_DEFAULT = 360;
export const MINI_WIDTH_MIN = 300;
export const MINI_WIDTH_MAX = 480;
export const MINI_RAIL_PX = 32;
export const SOURCE_POP_WIDTH = 420;
/** Bottom sheet height below 900px (wf-06b). */
export const SOURCE_POP_SHEET_VH = 64;
/** Side-by-side needs 320 + 8 + T_min. T_min stays 560/540 in this PR; 946 is the SPEC 3.8 band. */
export const SOURCE_MODE_SIDE_MIN_WIDTH = 946;
export const SIDE_SLOT_TOAST = "请先关闭笔记 / 问 AI / 文献库面板";
export const SOURCE_MODE_NARROW_HINT = "窗口太窄，放宽到 900px 以上可用";

const ALIASES = Object.freeze({
  split: "side",
  float: "mini",
  hide: "hidden"
});

export function normalizeSourceMode(value) {
  const raw = String(value ?? "");
  const mapped = ALIASES[raw] || raw;
  return SOURCE_MODES.includes(mapped) ? mapped : null;
}

export function normalizeMiniWidth(value) {
  if (value == null || value === "") return MINI_WIDTH_DEFAULT;
  const n = Number(value);
  if (!Number.isFinite(n)) return MINI_WIDTH_DEFAULT;
  return Math.min(MINI_WIDTH_MAX, Math.max(MINI_WIDTH_MIN, Math.round(n)));
}

export function normalizeMiniCollapsed(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

/** Missing preference: side from 946 up, mini from 900–945, hidden below 900. */
export function defaultSourceMode(width) {
  const w = Number(width) || 0;
  if (w < 900) return "hidden";
  if (w < SOURCE_MODE_SIDE_MIN_WIDTH) return "mini";
  return "side";
}

/** Modes the user can pick at this width. Below 900 none (原页 opens the sheet). */
export function sourceModeChoices(width) {
  const w = Number(width) || 0;
  if (w < 900) return [];
  if (w < SOURCE_MODE_SIDE_MIN_WIDTH) return ["mini", "hidden"];
  return ["side", "mini", "hidden"];
}

export function effectiveSourceMode({ width, stored } = {}) {
  const w = Number(width) || 0;
  if (w < 900) return "hidden";
  const saved = normalizeSourceMode(stored);
  const choices = sourceModeChoices(w);
  if (saved && choices.includes(saved)) return saved;
  return defaultSourceMode(w);
}

/**
 * `\` cycles the modes that fit. 900–945 skips side. Below 900 the key does nothing.
 * An open side slot (notes / ask / library) blocks the key. The slot is absent until
 * those panels land; callers pass sideSlotOpen from the [data-side-slot] hook.
 */
export function cycleSourceMode({ width, current, sideSlotOpen = false } = {}) {
  const w = Number(width) || 0;
  const now = effectiveSourceMode({ width: w, stored: current });
  if (sideSlotOpen) return { mode: now, blocked: true, toast: SIDE_SLOT_TOAST };
  if (w < 900) return { mode: "hidden", blocked: true, toast: "" };
  const choices = sourceModeChoices(w);
  const index = Math.max(0, choices.indexOf(now));
  const next = choices[(index + 1) % choices.length];
  return { mode: next, blocked: false, toast: "" };
}

export function sourcePopPlace(width) {
  return Number(width) < 900 ? "bottom" : "side";
}

export function sourceModeLabel(mode) {
  if (mode === "mini") return "小窗";
  if (mode === "hidden") return "隐藏";
  return "并排";
}

export function sourceModeMenuLabel(mode) {
  return `原文：${sourceModeLabel(mode)}`;
}

/** Pixel width of the mini pane from a pointer on the workspace. */
export function miniWidthFromPointer({ clientX, rect, side = "start" } = {}) {
  const x = Number(clientX);
  const start = Number(rect?.x) || 0;
  const end = Number.isFinite(Number(rect?.end)) ? Number(rect.end) : start + (Number(rect?.width) || 0);
  const raw = side === "end" ? end - x : x - start;
  return normalizeMiniWidth(raw);
}

/**
 * F6 regions in visual order. The parked source pane is omitted while hidden.
 * An open popup is its own stop (SM-07). The side slot is included only when open.
 */
export function f6RegionIds({ mode = "side", popOpen = false, side = "start", sideSlotOpen = false } = {}) {
  const ids = ["toolbar"];
  const sourceLaidOut = mode === "side" || mode === "mini";
  const order = side === "end" ? ["translation", "source"] : ["source", "translation"];
  for (const name of order) {
    if (name === "source" && !sourceLaidOut) continue;
    ids.push(name);
  }
  if (popOpen) ids.push("popup");
  if (sideSlotOpen) ids.push("sideSlot");
  return ids;
}

export function sourcePagingAllowed(mode) {
  return mode !== "hidden";
}
