/**
 * Tier "self": the frozen plaintext-relation whitelist in pdf-plaintext-formula.js.
 * Anything outside that whitelist is reject. No new recognizer.
 */

import { formatPlaintextRelation, plaintextRelationParts } from "../pdf-plaintext-formula.js";
import { tierResult } from "../formula-contract.js";

function relationText(unit) {
  if (unit?.pdfText) return String(unit.pdfText);
  const glyphs = unit?.glyphs || [];
  return glyphs.map((glyph) => glyph.ch ?? glyph.str ?? "").join("");
}

export const selfTier = {
  id: "self",
  version: "plaintext-1",
  kind: "fallback",
  available() {
    return true;
  },
  async run(unit) {
    const parts = plaintextRelationParts(relationText(unit));
    if (!parts) {
      return tierResult({
        tier: "self",
        status: "reject",
        // 在这一级，not-located 的意思是「不在白名单内」。
        reason: "not-located",
        confidence: 0
      });
    }
    return tierResult({
      tier: "self",
      status: "ok",
      render: "unicode",
      text: formatPlaintextRelation(parts, true),
      confidence: 1,
      checks: { whitelist: { pass: true } }
    });
  }
};
