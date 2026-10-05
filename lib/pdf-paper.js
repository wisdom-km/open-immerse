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

/**
 * Painted border box of the right-pane paper. CSS `zoom` on `.paper-stack`
 * scales that px width once. It does not scale a `100%` width.
 */
export function paintedPaperWidth(paperCssWidth, zoom) {
  const width = Number(paperCssWidth);
  const scale = Number(zoom);
  if (!(width > 0) || !(scale > 0) || !Number.isFinite(scale)) return 0;
  return width * scale;
}

/**
 * Stack width after a paper is appended. Only a strictly wider paper raises it.
 * A narrower or equal paper leaves the current value, so an async append does
 * not wait for the next resize and does not shrink the stack.
 */
export function raisedStackWidth(current, next) {
  const prev = Number(current);
  const incoming = Number(next);
  const base = Number.isFinite(prev) && prev > 0 ? prev : 0;
  if (!(Number.isFinite(incoming) && incoming > base)) return base;
  return incoming;
}

/** Horizontal scrollbar only when painted content is wider than the scrollport. */
export function paneHasHScroll(paintedWidth, clientWidth, slack = 1) {
  const content = Number(paintedWidth);
  const client = Number(clientWidth);
  if (!(content > 0) || !(client > 0)) return false;
  const slop = Number(slack);
  const pad = Number.isFinite(slop) && slop >= 0 ? slop : 0;
  return content > client + pad;
}
