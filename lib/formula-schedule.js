/**
 * One formula block through the chain.
 * The object returned is the withRasterCrop block.
 * Tier 0 stamps latex + latexSource + verified and returns before the crop.
 * formulaTier is "placeholder" only when that switch is on and the crop
 * criteria fail. Otherwise it names the crop image.
 */

import { decideFormulaCached } from "./formula-cache.js";
import { flagsOf } from "./formula-contract.js";

export function formulaUnitFromBlock(block, hooks = {}) {
  const inline = block?.display === false || Boolean(block?.inlineOf);
  return {
    docHash: hooks.docHash || "",
    bid: block?.bid || block?.id || "",
    page: hooks.page ?? block?.page ?? null,
    bbox: Array.isArray(block?.bbox) ? block.bbox.slice(0, 4) : null,
    display: !inline,
    inlineOf: block?.inlineOf || "",
    pdfText: block?.sourceText || block?.text || "",
    glyphs: Array.isArray(block?.glyphs) ? block.glyphs : [],
    equationNumber: block?.eqLabel || block?.equationNumber || null,
    sourceUnitId: block?.sourceUnitId || "",
    crop: {
      url: block?.imageUrl || "",
      image: hooks.cropImage || null,
      pixelSize: hooks.pixelSize || null,
      cssSize: hooks.cssSize || null,
      dpr: hooks.dpr
    }
  };
}

function chainFlags(hooks) {
  return flagsOf({
    arxivEnabled: hooks.arxivEnabled === true,
    multimodalEnabled: hooks.multimodalEnabled === true,
    multimodalConfigured: hooks.multimodalConfigured === true,
    ocrEnabled: hooks.ocrEnabled === true,
    ocrConfigured: hooks.ocrConfigured === true,
    placeholderEnabled: hooks.placeholderEnabled === true
  });
}

function placeholderReason(decision) {
  if (decision?.forcedReason) return String(decision.forcedReason);
  const crop = (decision?.trace || []).find((item) => item?.tier === "crop" && item.reason);
  return crop?.reason ? String(crop.reason) : "";
}

export async function scheduleFormulaBlock(block, hooks = {}) {
  const cropBlock = await hooks.withRasterCrop(block);
  if (!cropBlock || cropBlock.label !== "formula") return cropBlock;
  const produced = {
    imageUrl: cropBlock.imageUrl || "",
    surface: cropBlock.surface === "redraw" ? "redraw" : "png"
  };
  let cropImage = null;
  let pixelSize = null;
  if (hooks.placeholderEnabled === true && typeof hooks.readCropImage === "function" && cropBlock.imageUrl) {
    try {
      const sample = await hooks.readCropImage(cropBlock.imageUrl);
      if (sample?.image?.data) {
        cropImage = sample.image;
        pixelSize = sample.pixelSize || {
          width: sample.image.width,
          height: sample.image.height
        };
      }
    } catch {
      cropImage = null;
    }
  }
  let decision = null;
  try {
    decision = await decideFormulaCached(formulaUnitFromBlock(cropBlock, {
      ...hooks,
      cropImage,
      pixelSize,
      cssSize: pixelSize,
      dpr: pixelSize ? 1 : hooks.dpr
    }), {
      flags: chainFlags(hooks),
      arxivId: hooks.arxivId || "",
      arxivVersion: hooks.arxivVersion || "",
      isStale: hooks.isStale,
      readAlignment: hooks.arxivEnabled === true ? hooks.readAlignment : undefined,
      withRasterCrop: async () => produced,
      cache: hooks.cache || null,
      katex: hooks.katex,
      model: hooks.model
    }, {
      signal: hooks.signal,
      isStale: hooks.isStale
    });
  } catch {
    decision = null;
  }
  const chosen = decision?.chosen;
  if (
    chosen?.status === "ok"
    && chosen.tier === "arxiv"
    && chosen.render === "katex"
    && typeof chosen.latex === "string"
    && chosen.latex
  ) {
    cropBlock.formulaTier = "arxiv";
    cropBlock.latex = chosen.latex;
    cropBlock.latexSource = "arxiv-src";
    cropBlock.verified = true;
    return cropBlock;
  }
  delete cropBlock.latex;
  delete cropBlock.latexSource;
  delete cropBlock.verified;
  if (chosen?.status === "ok" && chosen.render === "placeholder") {
    cropBlock.formulaTier = "placeholder";
    const reason = placeholderReason(decision);
    if (reason) cropBlock.formulaReason = reason;
  } else if (chosen?.status === "ok" && chosen.tier && cropBlock.imageUrl) {
    cropBlock.formulaTier = chosen.render === "image" ? chosen.tier : "crop";
  }
  return cropBlock;
}
