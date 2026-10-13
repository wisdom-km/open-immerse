/**
 * One formula block through the chain.
 * The object returned is the withRasterCrop block. PR2 does not paint
 * KaTeX (F5) or a placeholder card (F8). formulaTier names the image
 * actually returned, which is the crop.
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
    crop: {
      url: block?.imageUrl || "",
      pixelSize: hooks.pixelSize || null,
      cssSize: hooks.cssSize || null,
      dpr: hooks.dpr
    }
  };
}

export async function scheduleFormulaBlock(block, hooks = {}) {
  const cropBlock = await hooks.withRasterCrop(block);
  if (!cropBlock || cropBlock.label !== "formula") return cropBlock;
  const arxivEnabled = hooks.arxivEnabled === true;
  const produced = {
    imageUrl: cropBlock.imageUrl || "",
    surface: cropBlock.surface === "redraw" ? "redraw" : "png"
  };
  let decision = null;
  try {
    decision = await decideFormulaCached(formulaUnitFromBlock(cropBlock, hooks), {
      flags: flagsOf({ arxivEnabled }),
      arxivId: hooks.arxivId || "",
      arxivVersion: hooks.arxivVersion || "",
      isStale: hooks.isStale,
      readAlignment: arxivEnabled ? hooks.readAlignment : undefined,
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
  if (chosen?.status === "ok" && chosen.tier && cropBlock.imageUrl) {
    cropBlock.formulaTier = chosen.render === "image" ? chosen.tier : "crop";
  }
  return cropBlock;
}
