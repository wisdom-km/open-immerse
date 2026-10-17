/**
 * Per-page counts for the multimodal chip (PR4 paints them).
 * m: formulas that entered the multimodal candidate, after tier 0.
 * n: of those, verified as vlm LaTeX (PR4 is what puts them on screen).
 * k: vision requests actually sent. Cache hits, tier 0, and aborted or
 * stale calls are not included.
 * A shown row stays shown. A later note cannot clear it.
 */

export function createMmLedger() {
  let epoch = 1;
  const rows = new Map();
  let lastFailure = null;
  return {
    get epoch() {
      return epoch;
    },
    bump() {
      epoch += 1;
      rows.clear();
      lastFailure = null;
      return epoch;
    },
    note(unitKey, { candidate = false, shown = false, sent = 0, failure = null } = {}) {
      const key = String(unitKey || "");
      if (!key) return;
      const prev = rows.get(key) || { candidate: false, shown: false, sent: 0 };
      if (candidate) prev.candidate = true;
      if (shown) prev.shown = true;
      const extra = Number(sent) || 0;
      if (extra > 0) prev.sent += extra;
      rows.set(key, prev);
      if (failure && failure.code) lastFailure = {
        code: String(failure.code),
        summary: String(failure.summary || "").slice(0, 80),
        at: Number(failure.at) || 0
      };
    },
    stats() {
      let m = 0;
      let n = 0;
      let k = 0;
      for (const row of rows.values()) {
        if (row.candidate) m += 1;
        if (row.shown) n += 1;
        k += row.sent;
      }
      return {
        m,
        n,
        k,
        epoch,
        lastFailure: lastFailure ? { ...lastFailure } : null
      };
    }
  };
}

const pages = new Map();

/** Start a fresh ledger for one page. PR4 reads it back with mmPageStatsFor. */
export function beginMmPage(page) {
  const ledger = createMmLedger();
  pages.set(Number(page) || 0, ledger);
  return ledger;
}

export function mmPageStatsFor(page) {
  const ledger = pages.get(Number(page) || 0);
  if (!ledger) return { m: 0, n: 0, k: 0, epoch: 0, lastFailure: null };
  return ledger.stats();
}

const SKIPPED = new Set(["not-configured", "disabled", "not-implemented"]);

/**
 * m counts only formulas the chain actually tried as multimodal.
 * A passing arXiv row is tier 0 and stays out of the denominator.
 */
export function classifyMmDecision(decision, traffic = {}) {
  const trace = decision?.trace || [];
  const arxivHit = trace.some((item) => item?.tier === "arxiv" && item.status === "ok");
  if (arxivHit || (decision?.chosen?.tier === "arxiv" && decision?.chosen?.status === "ok")) {
    return { candidate: false, shown: false, sent: 0, failure: null };
  }
  const mm = trace.find((item) => item?.tier === "multimodal");
  if (!mm || (mm.status === "skip" && SKIPPED.has(mm.reason))) {
    return { candidate: false, shown: false, sent: 0, failure: null };
  }
  const shown = decision?.chosen?.tier === "multimodal"
    && decision?.chosen?.status === "ok"
    && decision?.chosen?.render === "katex"
    && typeof decision?.chosen?.latex === "string"
    && decision.chosen.latex.length > 0;
  const sent = Number(traffic?.sent) || 0;
  let failure = null;
  if (!shown && mm.status !== "ok") {
    failure = {
      code: mm.meta?.visionCode || mm.reason || "",
      summary: String(mm.meta?.summary || "").slice(0, 80),
      at: decision?.decidedAt || 0
    };
  }
  return { candidate: true, shown, sent, failure };
}
