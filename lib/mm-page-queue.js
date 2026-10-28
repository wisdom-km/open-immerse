/**
 * One multimodal page vision at a time. A second slot can be opened, not more.
 * The current page runs before neighbor warm-up. Queued neighbors drop when
 * they leave the ±2 window or the layout epoch is cancelled. An in-flight
 * call is left to its own abort signal.
 */

export const MM_PAGE_FLIGHT_DEFAULT = 1;
export const MM_PAGE_FLIGHT_MAX = 2;

export function clampMmPageFlight(value) {
  return Math.floor(Number(value)) === MM_PAGE_FLIGHT_MAX ? MM_PAGE_FLIGHT_MAX : MM_PAGE_FLIGHT_DEFAULT;
}

/**
 * Run the swap, then let the next page start.
 * The layout write is started and not awaited: one stuck storage put used to
 * keep the single flight slot busy after the page had already left "rebuilding",
 * so later pages stayed on「正在重建本页」and never sent a vision request.
 * `swap` returning false means the epoch died and nothing is written.
 */
export function detachAfterSwap(swap, persist) {
  return Promise.resolve()
    .then(() => (typeof swap === "function" ? swap() : undefined))
    .then((value) => {
      if (value !== false && typeof persist === "function") {
        void Promise.resolve().then(() => persist()).then(() => {}, () => {});
      }
      return value;
    });
}

export function createMmPageFlight({ limit = MM_PAGE_FLIGHT_DEFAULT } = {}) {
  let cap = clampMmPageFlight(limit);
  let active = 0;
  let seq = 0;
  const waiting = [];
  const running = new Set();

  function settle(job, result) {
    if (job.settled) return;
    job.settled = true;
    job.settle(result);
  }

  function pump() {
    waiting.sort((a, b) => {
      const byRole = (a.role === "current" ? 0 : 1) - (b.role === "current" ? 0 : 1);
      if (byRole) return byRole;
      return a.seq - b.seq;
    });
    while (active < cap && waiting.length) {
      const job = waiting.shift();
      if (job.dropped) {
        settle(job, { ok: false, dropped: true });
        continue;
      }
      active += 1;
      running.add(job);
      Promise.resolve()
        .then(() => job.task())
        .then((value) => settle(job, { ok: true, dropped: false, value }))
        .catch((error) => settle(job, { ok: false, dropped: false, error }))
        .finally(() => {
          running.delete(job);
          active -= 1;
          pump();
        });
    }
  }

  function findWaiting(page, epoch) {
    return waiting.find((job) => !job.dropped && job.page === page && job.epoch === epoch);
  }

  return {
    limit() {
      return cap;
    },
    setLimit(value) {
      cap = clampMmPageFlight(value);
      pump();
      return cap;
    },
    active() {
      return active;
    },
    queued() {
      return waiting.filter((job) => !job.dropped).length;
    },
    /**
     * `role` is "current" or "neighbor". A waiting neighbor is promoted when
     * the same page becomes current. A page already in flight is not sent twice.
     */
    run({ page, role = "current", epoch = 0 }, task) {
      const pageNum = Number(page);
      const nextRole = role === "neighbor" ? "neighbor" : "current";
      const existing = findWaiting(pageNum, epoch);
      if (existing) {
        if (nextRole === "current") {
          existing.role = "current";
          existing.task = task;
        }
        pump();
        return existing.promise;
      }
      const inflight = [...running].find((job) => job.page === pageNum && job.epoch === epoch);
      if (inflight) return inflight.promise;
      let settleJob;
      const promise = new Promise((resolve) => {
        settleJob = resolve;
      });
      waiting.push({
        page: pageNum,
        role: nextRole,
        epoch,
        seq: seq += 1,
        task,
        dropped: false,
        settled: false,
        settle: settleJob,
        promise
      });
      pump();
      return promise;
    },
    dropNeighborsOutside({ focus, radius = 2, epoch } = {}) {
      const center = Number(focus);
      const span = Number(radius);
      let dropped = 0;
      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        const job = waiting[i];
        if (job.role !== "neighbor" || job.dropped) continue;
        if (epoch != null && job.epoch !== epoch) continue;
        if (Math.abs(job.page - center) <= span) continue;
        job.dropped = true;
        waiting.splice(i, 1);
        settle(job, { ok: false, dropped: true });
        dropped += 1;
      }
      return dropped;
    },
    dropEpoch(epoch) {
      let dropped = 0;
      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        const job = waiting[i];
        if (job.epoch !== epoch || job.dropped) continue;
        job.dropped = true;
        waiting.splice(i, 1);
        settle(job, { ok: false, dropped: true });
        dropped += 1;
      }
      return dropped;
    }
  };
}
