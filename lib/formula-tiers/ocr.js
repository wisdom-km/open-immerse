/** F9 stub. Same shape as a real candidate tier. available() stays false. */

import { tierResult } from "../formula-contract.js";

export const ocrTier = {
  id: "ocr",
  version: "stub-0",
  kind: "candidate",
  available() {
    return false;
  },
  unavailableReason() {
    return "not-configured";
  },
  async run() {
    return tierResult({
      tier: "ocr",
      status: "skip",
      reason: "not-configured",
      confidence: null
    });
  }
};
