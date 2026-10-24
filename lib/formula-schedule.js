/**
 * One formula block through the chain.
 * The object returned is the withRasterCrop block.
 * Tier 0 stamps latex + latexSource + verified and returns before the crop.
 * A verified multimodal result stamps the same three fields with
 * latexSource "vlm", and leaves formulaTier on the crop so the reader
 * keeps showing the image until PR4 paints KaTeX.
 * formulaTier is "placeholder" only when that switch is on and the crop
 * criteria fail. Otherwise it names the crop image.
 */

import { decideFormulaCached } from "./formula-cache.js";
import { formulaIsInline } from "./formula-context-crop.js";
import { flagsOf } from "./formula-contract.js";
import { VISION_CROP_SCALE, visionCropFor } from "./formula-vision-crop.js";
import { classifyMmDecision, noteOnCurrentMmPage } from "./formula-mm-ledger.js";
import { mmConfigFingerprint, mmConfigStamp, sameMmConfig } from "./formula-tiers/multimodal.js";
import { multimodalTarget } from "./mm-client.js";
import { neighbourEdgeLetters } from "./formula-verify.js";

export function formulaUnitFromBlock(block, hooks = {}) {
  const inline = formulaIsInline(block);
  return {
    docHash: hooks.docHash || "",
    bid: block?.bid || block?.id || "",
    page: hooks.page ?? block?.page ?? null,
    bbox: Array.isArray(block?.bbox) ? block.bbox.slice(0, 4) : null,
    display: !inline,
    inlineOf: block?.inlineOf || "",
    layoutBbox: Array.isArray(block?.layoutBbox) ? block.layoutBbox.slice(0, 4) : null,
    paragraphBbox: Array.isArray(block?.paragraphBbox) ? block.paragraphBbox.slice(0, 4) : null,
    glyphBoxes: Array.isArray(block?.glyphBoxes) ? block.glyphBoxes : [],
    maskBoxes: Array.isArray(block?.maskBoxes) ? block.maskBoxes : [],
    pdfText: block?.sourceText || block?.text || "",
    glyphs: Array.isArray(block?.glyphs) ? block.glyphs : [],
    equationNumber: block?.eqLabel || block?.equationNumber || null,
    sourceUnitId: block?.sourceUnitId || "",
    neighbourLetters: Array.isArray(hooks.neighbourLetters)
      ? hooks.neighbourLetters.slice()
      : neighbourEdgeLetters(hooks.textItems, block, {
        formulaBoxes: hooks.otherFormulaBoxes
      }),
    crop: {
      url: block?.imageUrl || "",
      image: hooks.cropImage || null,
      pixels: hooks.cropPixels || null,
      visionMode: hooks.cropVisionMode === "context" ? "context" : "",
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

function currentSettings(hooks) {
  if (typeof hooks.readSettings === "function") return hooks.readSettings();
  return hooks.settings;
}

function vlmAccepted(chosen) {
  return chosen?.status === "ok"
    && chosen.tier === "multimodal"
    && chosen.render === "katex"
    && typeof chosen.latex === "string"
    && chosen.latex.length > 0;
}

export async function scheduleFormulaBlock(block, hooks = {}) {
  const epoch = hooks.mmLedger?.epoch || 0;
  const stamp = currentSettings(hooks) ? mmConfigStamp(currentSettings(hooks)) : null;
  const fresh = () => {
    if (hooks.signal?.aborted) return false;
    if (hooks.isStale?.()) return false;
    if (hooks.mmLedger && epoch !== hooks.mmLedger.epoch) return false;
    const now = currentSettings(hooks);
    if (stamp && now && !sameMmConfig(stamp, mmConfigStamp(now))) return false;
    return true;
  };
  const cropBlock = await hooks.withRasterCrop(block);
  if (!fresh()) return cropBlock;
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
  if (!fresh()) return cropBlock;
  let cropPixels = null;
  let cropVisionMode = "";
  if (hooks.multimodalEnabled === true) {
    // Screen imageUrl stays the redraw. Inline model bytes are the context
    // crop; display model bytes stay the hi-res tight crop.
    try {
      const png = await visionCropFor(cropBlock, {
        scale: VISION_CROP_SCALE,
        pageWidth: hooks.pageWidth,
        pageHeight: hooks.pageHeight,
        renderVisionCrop: hooks.renderVisionCrop,
        cropPngFor: hooks.cropPngFor,
        readCropImage: hooks.readCropImage,
        isStale: () => !fresh()
      });
      if (png?.base64) {
        cropPixels = png.base64;
        cropVisionMode = png.meta?.mode === "context" ? "context" : "";
      }
    } catch {
      cropPixels = null;
      cropVisionMode = "";
    }
  }
  if (!fresh()) return cropBlock;
  const mmTraffic = { sent: 0 };
  const settings = currentSettings(hooks);
  const resolved = settings ? multimodalTarget(settings) : null;
  const namedModel = hooks.model || resolved?.model || "";
  const configFingerprint = settings ? mmConfigFingerprint(settings) : "";
  // guard:fingerprint
  const model = configFingerprint ? `${namedModel}#${configFingerprint}` : namedModel;
  let decision = null;
  try {
    decision = await decideFormulaCached(formulaUnitFromBlock(cropBlock, {
      ...hooks,
      cropImage,
      cropPixels,
      cropVisionMode,
      pixelSize,
      cssSize: pixelSize,
      dpr: pixelSize ? 1 : hooks.dpr
    }), {
      flags: chainFlags(hooks),
      tiers: hooks.tiers,
      arxivId: hooks.arxivId || "",
      arxivVersion: hooks.arxivVersion || "",
      pdfVersion: hooks.pdfVersion,
      isStale: hooks.isStale,
      readAlignment: hooks.arxivEnabled === true ? hooks.readAlignment : undefined,
      withRasterCrop: async () => produced,
      cache: hooks.cache || null,
      katex: hooks.katex,
      model,
      settings,
      readSettings: () => currentSettings(hooks),
      sendVision: hooks.sendVision,
      cropPngFor: hooks.cropPngFor,
      net: hooks.net,
      epoch,
      configFingerprint,
      mmTraffic,
      onCheckpoint: hooks.onCheckpoint,
      stillCurrent: fresh
    }, {
      signal: hooks.signal,
      isStale: hooks.isStale
    });
  } catch {
    decision = null;
  }
  if (typeof hooks.onCheckpoint === "function") {
    try {
      await hooks.onCheckpoint("before-stamp");
    } catch {
      /* a stamp hook that throws leaves the crop in place */
    }
  }
  const chosen = decision?.chosen;
  if (!fresh()) return cropBlock;
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
  const arxivKatexError = (decision?.trace || []).find((item) => item?.tier === "arxiv" && (item.reason === "katex-error" || item.reason === "latex-too-long"));
  if (chosen?.status === "ok" && chosen.render === "placeholder") {
    cropBlock.formulaTier = "placeholder";
    const reason = placeholderReason(decision);
    if (reason) cropBlock.formulaReason = reason;
  } else if (chosen?.status === "ok" && chosen.tier && cropBlock.imageUrl) {
    cropBlock.formulaTier = chosen.render === "image" ? chosen.tier : "crop";
  }
  if (vlmAccepted(chosen)) {
    cropBlock.latex = chosen.latex;
    cropBlock.latexSource = "vlm";
    cropBlock.verified = true;
  } else if (arxivKatexError && cropBlock.imageUrl) {
    cropBlock.formulaReason = arxivKatexError.reason;
  }
  noteOnCurrentMmPage(hooks.page, hooks.mmLedger, cropBlock.bid || cropBlock.id || "", classifyMmDecision(decision, mmTraffic));
  return cropBlock;
}

/** Publish a restamp only while the page is still the one this pass started on. */
export function publishRestampedBlocks(layout, next, stale, onPublish) {
  if (stale) return false;
  if (layout) layout.blocks = next;
  if (typeof onPublish === "function") onPublish();
  return true;
}
