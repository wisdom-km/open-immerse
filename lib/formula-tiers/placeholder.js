/** Tier "placeholder": a decision only. The card itself is F8. */

import { tierResult } from "../formula-contract.js";

export const placeholderTier = {
  id: "placeholder",
  version: "decision-1",
  kind: "terminal",
  available(ctx) {
    return ctx?.flags?.placeholderEnabled === true;
  },
  unavailableReason() {
    return "disabled";
  },
  async run(unit) {
    const page = unit?.page ?? null;
    const bbox = Array.isArray(unit?.bbox) ? unit.bbox.slice() : null;
    return tierResult({
      tier: "placeholder",
      status: "ok",
      render: "placeholder",
      confidence: null,
      meta: {
        page,
        bbox,
        jumpTarget: bbox ? { page, bbox: bbox.slice() } : { page, bbox: null, top: true }
      }
    });
  }
};
