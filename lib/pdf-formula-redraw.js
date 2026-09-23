/** Optional glyph composite from the opened page raster. Any failure returns "". */

function finiteBox(box) {
  return Array.isArray(box) && box.length >= 4 && box.every((value) => Number.isFinite(value)) &&
    box[2] > box[0] && box[3] > box[1];
}

/**
 * Copy formula-font glyph rectangles from the page raster onto a tight canvas.
 * Positions stay in page space, so the strokes are the opened PDF's pixels.
 * Returns "" when canvas, glyph boxes, or drawing are unavailable.
 */
export function redrawFormulaGlyphs(canvas, glyphBoxes, bbox) {
  if (!canvas || typeof canvas.getContext !== "function") return "";
  if (!Array.isArray(glyphBoxes) || !glyphBoxes.length || !finiteBox(bbox)) return "";
  if (!glyphBoxes.every(finiteBox)) return "";
  try {
    const scaleX = Number(canvas.width) || 0;
    const scaleY = Number(canvas.height) || 0;
    if (scaleX < 1 || scaleY < 1) return "";
    const [x0, y0, x1, y1] = bbox;
    const sw = Math.max(1, Math.round((x1 - x0) * scaleX));
    const sh = Math.max(1, Math.round((y1 - y0) * scaleY));
    if (sw < 24 || sh < 12) return "";
    const owner = canvas.ownerDocument || globalThis.document;
    const out = owner?.createElement?.("canvas");
    if (!out) return "";
    out.width = sw;
    out.height = sh;
    const ctx = out.getContext("2d");
    if (!ctx || typeof ctx.drawImage !== "function") return "";
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, sw, sh);
    for (const box of glyphBoxes) {
      const sx = box[0] * scaleX;
      const sy = box[1] * scaleY;
      const dw = (box[2] - box[0]) * scaleX;
      const dh = (box[3] - box[1]) * scaleY;
      if (!(dw > 0) || !(dh > 0)) return "";
      ctx.drawImage(canvas, sx, sy, dw, dh, (box[0] - x0) * scaleX, (box[1] - y0) * scaleY, dw, dh);
    }
    const url = typeof out.toDataURL === "function" ? out.toDataURL("image/png") : "";
    return /^data:image\/png;base64,/.test(url) ? url : "";
  } catch {
    return "";
  }
}
