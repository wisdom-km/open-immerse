/** F7 stub. Same shape as a real candidate tier. available() stays false. */

import { tierResult } from "../formula-contract.js";

export const multimodalTier = {
  id: "multimodal",
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
      tier: "multimodal",
      status: "skip",
      reason: "not-configured",
      confidence: null
    });
  }
};
