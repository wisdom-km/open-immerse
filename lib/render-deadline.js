/** A full-page raster that has not settled by now will not settle. pdf.js
 *  cancel() only clears the continuation timer, and the promise can stay
 *  pending. The source pane already stops waiting after 1s. The multimodal
 *  flight has one slot, so an unbounded wait there leaves every later page
 *  on「正在重建本页」with no vision request. */

export const MM_RASTER_TIMEOUT_MS = 8000;

export function awaitRenderTask(task, { timeoutMs = MM_RASTER_TIMEOUT_MS } = {}) {
  const promise = task && typeof task === "object" && "promise" in task ? task.promise : task;
  const ms = Math.max(0, Number(timeoutMs) || 0);
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { task?.cancel?.(); } catch { /* already finished */ }
      const err = new Error("render timeout");
      err.code = "timeout";
      reject(err);
    }, ms);
  });
  return Promise.race([
    Promise.resolve(promise),
    timeout
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
