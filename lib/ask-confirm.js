/**
 * Whether the next Ask send should show the confirm dialog.
 *
 * chrome.storage.local.get throws TypeError Illegal invocation when it is
 * called without the StorageArea as `this`. The warning is the error name
 * only: storage values and exception text stay out of the log.
 */

export function confirmStorageWarning(err) {
  const raw = err && typeof err.name === "string" ? err.name : "Error";
  const name = raw.replace(/[^\w]/g, "").slice(0, 40) || "Error";
  return `ask confirm storage failed (${name})`;
}

function defaultConfirmLog(message) {
  const log = globalThis.console?.warn;
  if (typeof log !== "function") return;
  log.call(globalThis.console, message);
}

/**
 * Interrupt point: local.get throws (detached this, or a storage failure).
 * Missing chrome returns false and does not log. A thrown read logs a
 * redacted warning and asks again.
 */
export async function readStoredAskConfirm(storage, key, log = defaultConfirmLog) {
  try {
    const local = storage?.local;
    const get = local?.get;
    if (typeof get !== "function") return false;
    const bag = await get.call(local, key);
    if (!bag || !Object.prototype.hasOwnProperty.call(bag, key)) return true;
    return bag[key] !== false;
  } catch (err) {
    log(confirmStorageWarning(err));
    return true;
  }
}

/**
 * Interrupt point: local.set throws. The value is not logged. A missing
 * setter returns false without a warning.
 */
export async function writeStoredAskConfirm(storage, key, value, log = defaultConfirmLog) {
  try {
    const local = storage?.local;
    const set = local?.set;
    if (typeof set !== "function") return false;
    await set.call(local, { [key]: value !== false });
    return true;
  } catch (err) {
    log(confirmStorageWarning(err));
    return false;
  }
}
