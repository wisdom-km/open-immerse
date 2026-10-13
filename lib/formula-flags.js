/**
 * Tier 0 in the viewer. No settings control. F5 turns this on.
 * Default false, so the right pane stays on the crop.
 */

let arxivSourceEnabled = false;

export function formulaArxivSourceEnabled() {
  return arxivSourceEnabled === true;
}

export function setFormulaArxivSourceEnabled(enabled) {
  arxivSourceEnabled = enabled === true;
  return arxivSourceEnabled;
}
