/**
 * Stratified sample of about 1000 formula units for human review.
 * The seed is fixed. The same pre-labels always produce the same set.
 */

export const REVIEW_SET_SEED = 20260925;
export const REVIEW_SET_TARGET = 1000;
export const REVIEW_FIELDS = ["ai", "math", "physics", "qbio", "med", "econ"];

export function mulberry32(seed) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function byStableId(a, b) {
  return a.paperId.localeCompare(b.paperId) || a.page - b.page || String(a.unitId).localeCompare(String(b.unitId));
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function allocateCounts(groups, quota) {
  const keys = [...groups.keys()].sort();
  const counts = new Map(keys.map((key) => [key, 0]));
  let left = quota;
  while (left > 0 && keys.length) {
    let moved = false;
    for (const key of keys) {
      if (counts.get(key) < groups.get(key).length && left > 0) {
        counts.set(key, counts.get(key) + 1);
        left -= 1;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return counts;
}

function weightedSample(items, count, random) {
  const list = items.slice().sort(byStableId);
  if (list.length <= count) return list;
  const ranked = list.map((item) => {
    const weight = Math.max(0.05, 1 - Number(item.confidence || 0));
    const draw = Math.max(random(), 1e-12);
    return { item, key: draw ** (1 / weight) };
  });
  ranked.sort((a, b) => b.key - a.key || byStableId(a.item, b.item));
  return ranked.slice(0, count).map((row) => row.item);
}

function typeKey(item) {
  const type = item.type === "display" ? "display" : "inline";
  return `${type}:${item.equationNumber ? "eq" : "plain"}`;
}

function interleave(lists) {
  const ordered = [];
  const longest = Math.max(0, ...lists.map((list) => list.length));
  for (let index = 0; index < longest; index += 1) {
    for (const list of lists) {
      if (index < list.length) ordered.push(list[index]);
    }
  }
  return ordered;
}

/**
 * Keep the chosen units, but walk fields in a fixed order and, inside each
 * field, walk papers in id order. Rank 0 of every paper comes before rank 1
 * of the same paper, so the front of the queue is not one paper per field.
 */
export function orderReviewQueue(units) {
  const byField = groupBy(units || [], (unit) => unit.field);
  const fieldLists = REVIEW_FIELDS.map((field) => {
    const byPaper = groupBy(byField.get(field) || [], (unit) => unit.paperId);
    const paperLists = [...byPaper.keys()].sort().map((paperId) => {
      return byPaper.get(paperId).slice().sort((a, b) => Number(a.confidence) - Number(b.confidence) || byStableId(a, b));
    });
    return interleave(paperLists);
  });
  return interleave(fieldLists);
}

export function buildReviewSet(units, options = {}) {
  const target = options.target ?? REVIEW_SET_TARGET;
  const random = mulberry32(options.seed ?? REVIEW_SET_SEED);
  const pool = (units || []).filter((unit) => unit && unit.unitId && unit.paperId);
  const byField = groupBy(pool, (unit) => unit.field);
  const fieldGroups = new Map(REVIEW_FIELDS.filter((field) => byField.has(field)).map((field) => [field, byField.get(field)]));
  const fieldCounts = allocateCounts(fieldGroups, target);
  const chosen = [];
  for (const field of REVIEW_FIELDS) {
    const fieldItems = fieldGroups.get(field);
    if (!fieldItems) continue;
    const bySource = groupBy(fieldItems, (unit) => unit.sourceType || "unknown");
    const sourceCounts = allocateCounts(bySource, fieldCounts.get(field) || 0);
    for (const sourceType of [...bySource.keys()].sort()) {
      const sourceItems = bySource.get(sourceType);
      const byType = groupBy(sourceItems, typeKey);
      const typeCounts = allocateCounts(byType, sourceCounts.get(sourceType) || 0);
      for (const key of [...byType.keys()].sort()) {
        chosen.push(...weightedSample(byType.get(key), typeCounts.get(key) || 0, random));
      }
    }
  }
  const ordered = orderReviewQueue(chosen);
  return {
    schema: "open-immerse.review-set/v1",
    seed: options.seed ?? REVIEW_SET_SEED,
    target,
    units: ordered,
    composition: compositionOf(ordered)
  };
}

export function compositionOf(units) {
  const byField = {};
  const bySource = {};
  const byType = {};
  for (const unit of units || []) {
    byField[unit.field] = (byField[unit.field] || 0) + 1;
    bySource[unit.sourceType] = (bySource[unit.sourceType] || 0) + 1;
    const type = `${unit.type === "display" ? "display" : "inline"}${unit.equationNumber ? "+eq" : ""}`;
    byType[type] = (byType[type] || 0) + 1;
  }
  return { byField, bySource, byType, total: (units || []).length };
}
