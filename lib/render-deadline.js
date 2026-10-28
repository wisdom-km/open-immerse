/** A full-page raster that has not settled by now will not settle. pdf.js
 *  cancel() only clears the continuation timer, and the promise can stay
 *  pending. The source pane already stops waiting after 1s. The multimodal
 *  flight has one slot, so an unbounded wait there leaves every later page
 *  on「正在重建本页」with no vision request.
 *
 *  Promise.race is the wrong tool here. If the render promise fulfills with
 *  a thenable, the race locks onto that thenable and ignores the timeout, so
 *  the flight slot never opens. This wrapper rejects on its own timer. */

export const MM_RASTER_TIMEOUT_MS = 8000;

export function awaitRenderTask(task, { timeoutMs = MM_RASTER_TIMEOUT_MS } = {}) {
  const promise = task && typeof task.cancel === "function" && task.promise && typeof task.promise.then === "function"
    ? task.promise
    : task;
  const ms = Math.max(0, Number(timeoutMs) || 0);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { task?.cancel?.(); } catch { /* already finished */ }
      const err = new Error("render timeout");
      err.code = "timeout";
      finish(reject, err);
    }, ms);
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    );
  });
}
