/** Right-pane paper size. Width follows the left PDF page, clamped to the translate pane. */

export const PDF_PAPER_GUTTER_X = 16;
export const PDF_PAPER_GAP_Y = 16;
export const PDF_PAPER_PAD_X = 0.085;
export const PDF_PAPER_PAD_TOP = 0.075;
export const PDF_PAPER_PAD_BOTTOM = 0.08;
/** US Letter, used only when the left page has not been measured yet. */
export const PDF_PAPER_FALLBACK_ASPECT = 612 / 792;

export function paperAvailWidth(clientWidth, gutterX = PDF_PAPER_GUTTER_X) {
  const width = Number(clientWidth);
  const gutter = Number(gutterX);
  if (!Number.isFinite(width) || width <= 0) return 0;
  const inset = Number.isFinite(gutter) && gutter > 0 ? gutter : 0;
  return Math.max(0, width - 2 * inset);
}

/**
 * W_paper = min(left page width, pane avail). H_base keeps the left page aspect.
 * Missing left size falls back to avail; missing both yields zeros.
 */
export function readoutPaperSize({ leftWidth, leftHeight, availWidth, fallbackAspect = PDF_PAPER_FALLBACK_ASPECT } = {}) {
  const leftW = Number(leftWidth);
  const leftH = Number(leftHeight);
  const avail = Number(availWidth);
  const hasLeft = leftW > 0 && leftH > 0;
  const hasAvail = avail > 0;
  const aspect = hasLeft
    ? leftW / leftH
    : (Number(fallbackAspect) > 0 ? Number(fallbackAspect) : PDF_PAPER_FALLBACK_ASPECT);
  let width = 0;
  if (hasLeft && hasAvail) width = Math.min(leftW, avail);
  else if (hasLeft) width = leftW;
  else if (hasAvail) width = avail;
  return {
    width,
    heightBase: width > 0 ? width / aspect : 0,
    aspect
  };
}

export function paperCssPx(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "0px";
  const rounded = Math.round(n * 100) / 100;
  return `${rounded}px`;
}

/** Full document keeps every translated page. Current-page keeps one paper. */
export function pagesInTranslateScope(pages, scope, currentPage) {
  const list = Array.isArray(pages) ? pages : [];
  if (scope === "all") return list.slice();
  const current = Number(currentPage);
  return list.filter((item) => Number(item?.page ?? item) === current);
}
