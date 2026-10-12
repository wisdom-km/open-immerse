/** Vector redraw is not implemented. The chain always skips this tier. */

import { tierResult } from "../formula-contract.js";

export const vectorTier = {
  id: "vector",
  version: "skip-0",
  kind: "fallback",
  available() {
    return true;
  },
  async run() {
    return tierResult({
      tier: "vector",
      status: "skip",
      reason: "not-implemented",
      confidence: null
    });
  }
};
