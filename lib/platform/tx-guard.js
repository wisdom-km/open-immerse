/**
 * IndexedDB commits a transaction when its callback awaits anything other than
 * that transaction's own requests. SQLite can wait longer, but the shared
 * contract is the stricter one: the tx callback must not await anything
 * outside the backend.
 *
 * Await only the promises from get, getAll, put, and delete. Memory and the
 * SQLite stand-in enforce the rule where the runtime can tell those awaits
 * apart. IndexedDB already does, on a real timer.
 */

const BRAND = Symbol("backend-await");
const stack = [];
const allowed = new Set();
let capture = null;
let executionAsyncId = () => 1;
let hooksInstalled = false;

export const TX_AWAIT_RULE = "The tx callback must not await anything outside the backend.";

function inactive() {
  const error = new Error("事务回调不能等待后端以外的操作。");
  error.name = "TransactionInactiveError";
  return error;
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const builtin = globalThis.process?.versions?.node && globalThis.process.getBuiltinModule?.("async_hooks");
  if (!builtin?.createHook || !builtin.executionAsyncId) return;
  executionAsyncId = builtin.executionAsyncId;
  builtin.createHook({
    init(asyncId, type, triggerAsyncId) {
      if (capture && type === "PROMISE") {
        capture.add(asyncId);
        allowed.add(asyncId);
        return;
      }
      if (allowed.has(triggerAsyncId)) allowed.add(asyncId);
    }
  }).enable();
}

function assertTurn(state) {
  if (!state) return;
  if (state.violated) throw inactive();
  const here = executionAsyncId();
  if (state.open) {
    state.roots.add(here);
    return;
  }
  if (state.roots.has(here) || allowed.has(here)) return;
  state.violated = true;
  throw inactive();
}

/** A promise the tx callback is allowed to await. */
export function backendAwait(value) {
  installHooks();
  const state = stack.at(-1);
  assertTurn(state);
  capture = new Set();
  const promise = Promise.resolve(value);
  capture = null;
  promise[BRAND] = true;
  return promise;
}

/**
 * Run fn as a transaction callback. fn may await backendAwait promises only.
 * The tx callback must not await anything outside the backend.
 */
export async function guardCallback(fn) {
  installHooks();
  const state = { roots: new Set(), open: true, violated: false };
  stack.push(state);
  try {
    let returned;
    try {
      returned = fn();
    } finally {
      state.open = false;
    }
    return await returned;
  } finally {
    stack.pop();
  }
}
