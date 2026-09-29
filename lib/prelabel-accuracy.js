/**
 * Score pre-labels against a fixed list of agent judgments.
 * The judgments are not owner ground truth.
 */

export function judgePage(page, judgment) {
  const byId = new Map((page?.elements || []).map((element) => [element.id, element]));
  const elements = judgment.elementIds.map((id) => byId.get(id));
  if (elements.some((element) => !element)) {
    return { id: judgment.id, ok: false, reason: "missing-element" };
  }
  if (judgment.expect === "text") {
    const ok = elements.every((element) => element.label === "text" && !element.unitId);
    return { id: judgment.id, ok, reason: elements.map((element) => element.rule).join(",") };
  }
  if (judgment.expect === "same-unit") {
    const unitIds = elements.map((element) => element.unitId || "");
    const ok = unitIds.every((unitId) => unitId && unitId === unitIds[0]);
    return { id: judgment.id, ok, reason: unitIds[0] || "none" };
  }
  if (judgment.expect === "not-same-unit") {
    const unitIds = new Set(elements.map((element) => element.unitId || "none"));
    return { id: judgment.id, ok: unitIds.size > 1, reason: [...unitIds].join(",") };
  }
  return { id: judgment.id, ok: false, reason: "unknown-expect" };
}

export function summarizeJudgments(cases, results) {
  const byId = new Map(results.map((result) => [result.id, result]));
  const buckets = new Map();
  for (const item of cases) {
    const key = item.source;
    if (!buckets.has(key)) buckets.set(key, { source: key, total: 0, correct: 0 });
    const bucket = buckets.get(key);
    bucket.total += 1;
    if (byId.get(item.id)?.ok) bucket.correct += 1;
  }
  const total = cases.length;
  const correct = results.filter((result) => result.ok).length;
  return {
    total,
    correct,
    rate: total ? Math.round((correct / total) * 1000) / 1000 : 0,
    bySource: [...buckets.values()].sort((a, b) => a.source.localeCompare(b.source))
  };
}
