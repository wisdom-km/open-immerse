/**
 * Tier 0. Read an alignment F2 already stored. No download, no new alignment.
 * A passing row is used as-is and does not enter arbitration.
 */

import { canRenderLatex } from "../formula-katex.js";
import { prepareFormulaLatex } from "../latex-units.js";
import { equationNumbersAgree, versionScreenGate } from "../formula-arxiv-gate.js";
import { tierResult, USE_SOURCE_MIN } from "../formula-contract.js";

export const arxivTier = {
  id: "arxiv",
  version: "align-1",
  kind: "source",
  available(ctx) {
    return ctx?.flags?.arxivEnabled === true;
  },
  unavailableReason() {
    return "disabled";
  },
  async run(unit, ctx) {
    const read = ctx?.readAlignment;
    if (typeof read !== "function") {
      return tierResult({ tier: "arxiv", status: "reject", reason: "no-source", confidence: 0 });
    }
    const alignment = await read({
      id: ctx.arxivId,
      version: ctx.arxivVersion || "",
      pdfSha256: unit?.docHash
    });
    return resultFromAlignment(alignment, unit, ctx);
  }
};

export function alignmentBelowThreshold(alignment) {
  if (!alignment || typeof alignment !== "object") return false;
  if (alignment.useSource === false) return true;
  const rate = alignment.stats?.wordRate;
  return typeof rate === "number" && rate < USE_SOURCE_MIN;
}

export function matchAlignmentRows(formulas, unit) {
  const rows = formulas || [];
  if (unit?.sourceUnitId) {
    const exact = rows.filter((row) => row.unitId === unit.sourceUnitId);
    if (exact.length) return exact;
  }
  const byUnit = rows.filter((row) => row.unitId && row.unitId === unit?.bid);
  if (byUnit.length === 1) return byUnit;
  let matched = rows.filter((row) => row.bid && row.bid === unit?.bid);
  if (!matched.length && byUnit.length) matched = byUnit;
  if (unit?.display === true) {
    const displays = matched.filter((row) => row.kind === "display");
    if (displays.length) matched = displays;
  } else if (unit?.display === false) {
    const inlines = matched.filter((row) => row.kind === "inline");
    if (inlines.length) matched = inlines;
  }
  if (unit?.equationNumber != null && unit.equationNumber !== "") {
    const numbered = matched.filter((row) => String(row.number) === String(unit.equationNumber));
    if (numbered.length) matched = numbered;
  }
  return matched;
}

function rowReason(row) {
  const checks = row?.checks || {};
  if (!checks.position) return "not-located";
  if (!checks.chars) return "charset-mismatch";
  if (checks.number === false) return "number-mismatch";
  if (checks.render === false) return "katex-error";
  return null;
}

export function resultFromAlignment(alignment, unit, ctx = {}) {
  if (!alignment) {
    return tierResult({ tier: "arxiv", status: "reject", reason: "no-source", confidence: 0 });
  }
  if (ctx?.pdfVersion !== undefined) {
    const gate = versionScreenGate(ctx.pdfVersion, alignment.version || "");
    if (!gate.screen) {
      return tierResult({
        tier: "arxiv",
        status: "reject",
        reason: gate.reason,
        confidence: 0,
        checks: { position: false, chars: false, number: false, render: false }
      });
    }
  }
  if (alignmentBelowThreshold(alignment)) {
    return tierResult({
      tier: "arxiv",
      status: "reject",
      reason: "doc-align-low",
      confidence: 0,
      checks: { position: false, chars: false, number: false, render: false }
    });
  }
  const rows = matchAlignmentRows(alignment.formulas, unit);
  if (!rows.length) {
    return tierResult({ tier: "arxiv", status: "reject", reason: "not-located", confidence: 0 });
  }
  const passing = rows.filter((row) => !rowReason(row));
  const row = passing[0] || rows[0];
  const reason = rowReason(row);
  if (reason) {
    return tierResult({
      tier: "arxiv",
      status: "reject",
      reason,
      latex: row.latex || null,
      confidence: 0,
      checks: {
        position: Boolean(row.checks?.position),
        chars: Boolean(row.checks?.chars),
        number: row.checks?.number !== false,
        render: row.checks?.render !== false
      }
    });
  }
  if (ctx?.pdfVersion !== undefined && !equationNumbersAgree(row, unit)) {
    return tierResult({
      tier: "arxiv",
      status: "reject",
      reason: "number-mismatch",
      latex: row.latex || null,
      confidence: 0,
      checks: { position: true, chars: true, number: false, render: true }
    });
  }
  if (ctx?.katex) {
    const display = unit?.display !== false;
    const shown = prepareFormulaLatex(row.latex || "", display);
    const check = canRenderLatex(shown, display, ctx.katex);
    if (!check.pass) {
      return tierResult({
        tier: "arxiv",
        status: "reject",
        reason: "katex-error",
        latex: null,
        confidence: 0,
        checks: { position: true, chars: true, number: true, render: false }
      });
    }
  }
  return tierResult({
    tier: "arxiv",
    status: "ok",
    render: "katex",
    latex: row.latex || "",
    confidence: 1,
    checks: { position: true, chars: true, number: true, render: true },
    meta: { sourceUnitId: row.unitId || "", cached: true }
  });
}
