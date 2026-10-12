import { arxivTier } from "./arxiv.js";
import { cropTier } from "./crop.js";
import { multimodalTier } from "./multimodal.js";
import { ocrTier } from "./ocr.js";
import { placeholderTier } from "./placeholder.js";
import { selfTier } from "./self.js";
import { vectorTier } from "./vector.js";

export function createDefaultTiers() {
  return {
    arxiv: arxivTier,
    multimodal: multimodalTier,
    ocr: ocrTier,
    self: selfTier,
    vector: vectorTier,
    crop: cropTier,
    placeholder: placeholderTier
  };
}
