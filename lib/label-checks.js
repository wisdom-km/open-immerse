/**
 * M1 checks. A1 looks at every pixel of the crop. A2 trusts labels, not
 * the selector's own font tag. A3 compares element sets. A4 is the
 * share of pre-label formula units whose confidence is below 0.65.
 * An empty baseline SVG is reported separately and is not A4.
 */

import { INK_AA_TOLERANCE, countMissingInk } from "./formula-svg.js";
import { FALLBACK_CONFIDENCE } from "./prelabel.js";
import { identityMatches } from "./label-schema.js";

export { FALLBACK_CONFIDENCE, INK_AA_TOLERANCE };

/** Left-pane ink with no SVG ink within r, anywhere in the crop. */
export function countMissingInkFullCrop(reference, svg, width, height, tolerance = INK_AA_TOLERANCE) {
  return countMissingInk(reference, svg, width, height, null, tolerance);
}

/**
 * Selected ids whose ground-truth label is not formula.
 * The character and the box come from that label record.
 */
export function neighbourContent(selectedIds, labelById) {
  const hits = [];
  for (const id of selectedIds || []) {
    const label = labelById.get(id);
    if (!label) {
      hits.push({ id, problem: "unlabelled" });
      continue;
    }
    if (!identityMatches(label)) {
      hits.push({ id, problem: "identity" });
      continue;
    }
    if (label.label !== "formula") {
      hits.push({
        id,
        problem: "neighbour",
        label: label.label,
        char: label.char,
        font: label.font,
        bbox: label.bbox.slice()
      });
    }
  }
  return hits;
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function jaccard(a, b) {
  let inter = 0;
  for (const id of a) if (b.has(id)) inter += 1;
  const union = a.size + b.size - inter;
  return union ? inter / union : 1;
}

/**
 * A truth unit is correct when one predicted set contains exactly its
 * element ids. Each predicted set is used at most once.
 */
export function unitAccuracy(truthUnits, predictedSets) {
  const truths = (truthUnits || []).map((unit) => ({
    id: unit.id,
    ids: new Set(unit.elementIds || [])
  }));
  const predicted = (predictedSets || []).map((ids) => new Set(ids));
  const pairs = [];
  truths.forEach((truth, truthIndex) => {
    predicted.forEach((set, predictedIndex) => {
      const score = jaccard(truth.ids, set);
      if (score <= 0) return;
      pairs.push({
        truthIndex,
        predictedIndex,
        score,
        exact: sameSet(truth.ids, set)
      });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.truthIndex - b.truthIndex);
  const usedTruth = new Set();
  const usedPredicted = new Set();
  let correct = 0;
  let jaccardSum = 0;
  for (const pair of pairs) {
    if (usedTruth.has(pair.truthIndex) || usedPredicted.has(pair.predictedIndex)) continue;
    usedTruth.add(pair.truthIndex);
    usedPredicted.add(pair.predictedIndex);
    jaccardSum += pair.score;
    if (pair.exact) correct += 1;
  }
  const total = truths.length;
  return {
    correct,
    total,
    accuracy: total ? correct / total : 1,
    meanJaccard: total ? jaccardSum / total : 1
  };
}

export function fallbackRate(units, options = {}) {
  const list = units || [];
  const empty = options.emptyIds instanceof Set ? options.emptyIds : new Set(options.emptyIds || []);
  const degenerate = options.degenerateIds instanceof Set ? options.degenerateIds : new Set(options.degenerateIds || []);
  let fallback = 0;
  for (const unit of list) {
    const low = unit.fallback === true || (Number.isFinite(Number(unit.confidence)) && Number(unit.confidence) < FALLBACK_CONFIDENCE);
    if (low || empty.has(unit.id) || degenerate.has(unit.id)) fallback += 1;
  }
  const total = list.length;
  return { fallback, total, rate: total ? fallback / total : 0 };
}

export function markdownTable(headers, rows) {
  const head = `| ${headers.join(" | ")} |`;
  const rule = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map((cell) => String(cell ?? "")).join(" | ")} |`);
  return [head, rule, ...body].join("\n");
}

export function round3(value) {
  return Math.round(Number(value) * 1000) / 1000;
}
