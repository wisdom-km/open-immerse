/** How long popup init waits on a page or browser message before showing the shell. */
export const POPUP_PAGE_WAIT_MS = 300;

/**
 * Resolve with the promise's value, or null when it rejects or exceeds `ms`.
 * A frozen page never answers `tabs.sendMessage`; the popup must not wait with it.
 */
export function withTimeout(promise, ms = POPUP_PAGE_WAIT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    Promise.resolve(promise).then(
      (value) => finish(value),
      () => finish(null)
    );
  });
}
