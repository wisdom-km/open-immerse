/** PDF dual-pane scroll. Page follow is off unless settings.pdfScroll.softPageFollow === true. */

export const PDF_SCROLL_SOFT_PAGE_FOLLOW_DEFAULT = false;
/** Owner clears on scrollend, or on this idle if the browser never fires scrollend. */
export const SYNC_OWNER_IDLE_MS = 100;
/** Pane-to-pane alignment. Never "smooth". */
export const PANE_SYNC_BEHAVIOR = "auto";

export function normalizePdfScroll(value) {
  const raw = value && typeof value === "object" ? value.softPageFollow : undefined;
  return { softPageFollow: raw === true };
}

/** Missing, false, and non-boolean truthy values stay off. Only boolean true enables follow. */
export function readSoftPageFollow(settings) {
  if (!settings || typeof settings !== "object") return PDF_SCROLL_SOFT_PAGE_FOLLOW_DEFAULT;
  return normalizePdfScroll(settings.pdfScroll).softPageFollow;
}

/**
 * Follow only when the flag is on, this pane is the driver, and the page changed.
 * Same-page micro-scroll and echo scrolls (owner is the other side) do not align.
 */
export function shouldFollowPage({
  softPageFollow = false,
  owner = null,
  driver,
  fromPage,
  toPage
} = {}) {
  if (softPageFollow !== true) return false;
  if (driver !== "pdf" && driver !== "readout") return false;
  if (owner != null && owner !== driver) return false;
  const to = Number(toPage);
  const from = Number(fromPage);
  if (!Number.isFinite(to) || to < 1) return false;
  if (Number.isFinite(from) && from === to) return false;
  return true;
}

export function planPaneFollow(input) {
  return {
    align: shouldFollowPage(input),
    behavior: PANE_SYNC_BEHAVIOR
  };
}

export function clampSyncIdle(idleMs) {
  const n = Number(idleMs);
  if (!Number.isFinite(n) || n < 0) return SYNC_OWNER_IDLE_MS;
  return Math.min(SYNC_OWNER_IDLE_MS, n);
}

export function createSyncOwner({
  idleMs = SYNC_OWNER_IDLE_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id)
} = {}) {
  const wait = clampSyncIdle(idleMs);
  let owner = null;
  let timer = 0;
  let token = 0;

  function clearIdle() {
    if (!timer) return;
    cancel(timer);
    timer = 0;
  }

  function arm(who) {
    clearIdle();
    const ticket = ++token;
    timer = schedule(() => {
      timer = 0;
      if (ticket !== token || owner !== who) return;
      owner = null;
    }, wait);
  }

  return {
    get owner() {
      return owner;
    },
    claim(who) {
      if (who !== "pdf" && who !== "readout" && who !== "click") return owner;
      owner = who;
      arm(who);
      return owner;
    },
    release(who) {
      if (who != null && owner !== who) return owner;
      clearIdle();
      token += 1;
      owner = null;
      return owner;
    },
    ignores(source) {
      return owner != null && owner !== source;
    }
  };
}

/** One synthetic page flip per wheel gesture. Idle ≤100ms opens the next gesture. */
export function createWheelFlipGuard({
  idleMs = SYNC_OWNER_IDLE_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id)
} = {}) {
  const wait = clampSyncIdle(idleMs);
  let latched = false;
  let timer = 0;
  let token = 0;

  function clear() {
    if (!timer) return;
    cancel(timer);
    timer = 0;
  }

  function arm() {
    clear();
    const ticket = ++token;
    timer = schedule(() => {
      timer = 0;
      if (ticket !== token) return;
      latched = false;
    }, wait);
  }

  return {
    get latched() {
      return latched;
    },
    beginGesture() {
      arm();
    },
    consume() {
      latched = true;
      arm();
    },
    release() {
      clear();
      token += 1;
      latched = false;
    }
  };
}

/** Instant anchor. Callers assign scrollTop; this never asks for smooth scrolling. */
export function alignScrollTop(pane, node) {
  if (!pane || !node) return null;
  if (typeof pane.getBoundingClientRect !== "function") return null;
  if (typeof node.getBoundingClientRect !== "function") return null;
  const paneRect = pane.getBoundingClientRect();
  const nodeRect = node.getBoundingClientRect();
  const top = Number(pane.scrollTop) + (Number(nodeRect.top) - Number(paneRect.top));
  return Number.isFinite(top) ? top : null;
}
