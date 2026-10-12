/**
 * Crop tier. Wraps the viewer's withRasterCrop when ctx supplies it.
 * redraw failure stays on this tier as surface "png" (V1-B1): no badge, no tier change.
 * Sharpness and neighbor-ink are confidence checks on top of that image.
 */

import { NEIGHBOR_INK_MAX, tierResult } from "../formula-contract.js";

const PAPER = 250;

export function isInkPixel(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  const a = data[offset + 3];
  if (a < 16) return false;
  return r < PAPER || g < PAPER || b < PAPER;
}

export function judgeCrop({
  image,
  pixelSize,
  cssSize,
  dpr = 1,
  foreignMask
} = {}) {
  const width = image?.width || 0;
  const height = image?.height || 0;
  const data = image?.data;
  let ink = 0;
  let foreign = 0;
  if (data && width && height) {
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      if (!isInkPixel(data, i)) continue;
      ink += 1;
      if (foreignMask && foreignMask[p]) foreign += 1;
    }
  }
  const blank = ink === 0;
  const pw = Number(pixelSize?.width ?? width);
  const ph = Number(pixelSize?.height ?? height);
  const needW = Number(cssSize?.width || 0) * Number(dpr || 1);
  const needH = Number(cssSize?.height || 0) * Number(dpr || 1);
  const sharp = needW > 0 && needH > 0 && pw >= needW && ph >= needH;
  const neighborInk = ink ? foreign / ink : 0;
  let reason = null;
  if (blank) reason = "crop-blank";
  else if (!sharp) reason = "crop-blurry";
  else if (neighborInk > NEIGHBOR_INK_MAX) reason = "crop-neighbor-ink";
  const sharpScore = !needW || !needH ? 0 : Math.min(1, pw / needW, ph / needH);
  const confidence = blank ? 0 : Math.min(sharpScore, Math.max(0, 1 - neighborInk / NEIGHBOR_INK_MAX));
  return {
    pass: !reason,
    reason,
    confidence,
    checks: {
      sharp: { pass: sharp && !blank },
      neighborInk: { pass: !blank && neighborInk <= NEIGHBOR_INK_MAX, ratio: neighborInk }
    }
  };
}

async function loadProduced(unit, ctx, signal) {
  const crop = unit?.crop || {};
  let url = crop.url || "";
  let surface = "png";
  let image = crop.image || null;
  if (typeof crop.getImage === "function") {
    const got = await crop.getImage();
    if (got) {
      url = got.url || url;
      if (got.surface === "redraw" || got.surface === "png") surface = got.surface;
      image = got.image || got.pixels || image;
    }
  }
  if (typeof ctx?.withRasterCrop === "function") {
    const block = {
      label: "formula",
      bbox: unit?.bbox,
      display: unit?.display,
      inlineOf: unit?.inlineOf || ""
    };
    try {
      const cropped = await ctx.withRasterCrop(ctx.raster, ctx.page, block, unit?.page, { signal });
      if (cropped?.imageUrl) url = cropped.imageUrl;
      surface = cropped?.surface === "redraw" ? "redraw" : "png";
      if (cropped?.image) image = cropped.image;
    } catch {
      surface = "png";
    }
  }
  return { url, surface, image };
}

export const cropTier = {
  id: "crop",
  version: "raster-1",
  kind: "fallback",
  available() {
    return true;
  },
  async run(unit, ctx, { signal } = {}) {
    const produced = await loadProduced(unit, ctx, signal);
    const crop = unit?.crop || {};
    const judged = judgeCrop({
      image: produced.image,
      pixelSize: crop.pixelSize || (produced.image ? { width: produced.image.width, height: produced.image.height } : null),
      cssSize: crop.cssSize,
      dpr: crop.dpr ?? 1,
      foreignMask: crop.foreignMask
    });
    const image = {
      url: produced.url || "",
      surface: produced.surface === "redraw" ? "redraw" : "png",
      pixelSize: crop.pixelSize || null
    };
    if (!judged.pass) {
      return tierResult({
        tier: "crop",
        status: "reject",
        render: "image",
        image,
        confidence: judged.confidence,
        checks: judged.checks,
        reason: judged.reason,
        meta: {}
      });
    }
    return tierResult({
      tier: "crop",
      status: "ok",
      render: "image",
      image,
      confidence: judged.confidence,
      checks: judged.checks,
      meta: {}
    });
  }
};

/** Criteria failed and the placeholder switch is off: still show the crop. No badge. */
export function cropShownAnyway(result) {
  return tierResult({
    ...result,
    tier: "crop",
    status: "ok",
    render: "image",
    reason: null,
    meta: { ...(result?.meta || {}), criteria: result?.reason || null }
  });
}
