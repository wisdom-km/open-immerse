/**
 * Per-page counts for the multimodal chip (PR4 paints the chip).
 * m: formulas that entered the multimodal candidate, after tier 0.
 * ready: of those, verified and safe for PR4 to paint as vlm KaTeX.
 *   PR3 does not paint, so ready is not "already on screen".
 * n: of those, already on screen as vlm KaTeX. PR3 always leaves this 0.
 *   PR4 increments n when it paints, and must not treat ready as n.
 * k: vision requests actually sent. Cache hits, tier 0, and aborted or
 * stale calls are not included.
 * ready and painted only move from false to true. A later note cannot clear them.
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
    note(unitKey, { candidate = false, ready = false, painted = false, shown = false, sent = 0, failure = null } = {}) {
      const key = String(unitKey || "");
      if (!key) return;
      const prev = rows.get(key) || { candidate: false, ready: false, painted: false, sent: 0 };
      if (candidate) prev.candidate = true;
      if (ready || shown) prev.ready = true;
      if (painted) prev.painted = true;
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
      let ready = 0;
      let k = 0;
      for (const row of rows.values()) {
        if (row.candidate) m += 1;
        if (row.painted) n += 1;
        if (row.ready) ready += 1;
        k += row.sent;
      }
      return {
        m,
        n,
        ready,
        k,
        epoch,
        lastFailure: lastFailure ? { ...lastFailure } : null
      };
    }
  };
}

const pages = new Map();

/** Drop every page ledger. A newly adopted document must not inherit the last one. */
export function resetMmPages() {
  pages.clear();
}

/** Start a fresh ledger for one page. PR4 reads it back with mmPageStatsFor. */
export function beginMmPage(page) {
  const ledger = createMmLedger();
  pages.set(Number(page) || 0, ledger);
  return ledger;
}

/** The ledger for this page's current life. A second ask does not replace it. */
export function mmPageLedger(page) {
  const key = Number(page) || 0;
  const existing = pages.get(key);
  if (existing) return existing;
  return beginMmPage(page);
}

/**
 * Count a finished formula on the ledger the page is using now.
 * A beginMmPage that replaced the one captured at the start still receives k.
 */
export function noteOnCurrentMmPage(page, fallback, unitKey, row) {
  if (!row?.candidate) return;
  const current = page == null ? null : pages.get(Number(page) || 0);
  const ledger = current || fallback;
  if (ledger) ledger.note(unitKey, row);
}

export function mmPageStatsFor(page) {
  const ledger = pages.get(Number(page) || 0);
  if (!ledger) return { m: 0, n: 0, ready: 0, k: 0, epoch: 0, lastFailure: null };
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
    return { candidate: false, ready: false, painted: false, sent: 0, failure: null };
  }
  const mm = trace.find((item) => item?.tier === "multimodal");
  if (!mm || (mm.status === "skip" && SKIPPED.has(mm.reason))) {
    return { candidate: false, ready: false, painted: false, sent: 0, failure: null };
  }
  const ready = decision?.chosen?.tier === "multimodal"
    && decision?.chosen?.status === "ok"
    && decision?.chosen?.render === "katex"
    && typeof decision?.chosen?.latex === "string"
    && decision.chosen.latex.length > 0;
  const sent = Number(traffic?.sent) || 0;
  let failure = null;
  const failureCode = mm.meta?.visionCode || mm.reason || "";
  // 429 / cooldown is rate limiting. It is not a model failure.
  const rateLimited = failureCode === "429" || mm.reason === "cooldown";
  if (!ready && mm.status !== "ok" && !rateLimited) {
    failure = {
      code: failureCode,
      summary: String(mm.meta?.summary || "").slice(0, 80),
      at: decision?.decidedAt || 0
    };
  }
  return { candidate: true, ready, painted: false, sent, failure };
}
