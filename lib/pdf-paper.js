/** Right-pane paper size. Width follows the left PDF page, clamped to the translate pane. */

export const PDF_PAPER_GUTTER_X = 16;
export const PDF_PAPER_GAP_Y = 16;
export const PDF_PAPER_PAD_X = 0.085;
export const PDF_PAPER_PAD_TOP = 0.075;
export const PDF_PAPER_PAD_BOTTOM = 0.08;

export function paperAvailWidth(clientWidth, gutterX = PDF_PAPER_GUTTER_X) {
  const width = Number(clientWidth);
  const gutter = Number(gutterX);
  if (!Number.isFinite(width) || width <= 0) return 0;
  const inset = Number.isFinite(gutter) && gutter > 0 ? gutter : 0;
  return Math.max(0, width - 2 * inset);
}

/**
 * W_paper = min(that page's CSS box width, pane avail).
 * H_base keeps that page's aspect (viewport from MediaBox/CropBox). No stock page size.
 */
/**
 * Left page CSS box with the left-pane zoom divided out.
 * Zoom 1 returns the same width and height. A non-positive zoom is treated as 1.
 */
export function basePageBox(box, zoom) {
  const width = Number(box?.width);
  const height = Number(box?.height);
  if (!(width > 0) || !(height > 0)) return null;
  const scale = Number(zoom);
  const z = scale > 0 && Number.isFinite(scale) ? scale : 1;
  if (z === 1) return { width, height };
  return { width: width / z, height: height / z };
}

export function readoutPaperSize({ leftWidth, leftHeight, availWidth } = {}) {
  const leftW = Number(leftWidth);
  const leftH = Number(leftHeight);
  const avail = Number(availWidth);
  if (!(leftW > 0) || !(leftH > 0)) return { width: 0, heightBase: 0, aspect: 0 };
  const aspect = leftW / leftH;
  const width = avail > 0 ? Math.min(leftW, avail) : leftW;
  return { width, heightBase: width / aspect, aspect };
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
