/**
 * IndexedDB commits a transaction when its callback awaits anything other than
 * that transaction's own requests. SQLite can wait longer, but the shared
 * contract is the stricter one: the tx callback must not await anything
 * outside the backend.
 *
 * Await only the promises from get, getAll, put, and delete. Memory and the
 * SQLite stand-in enforce the rule where the runtime can tell those awaits
 * apart. IndexedDB already does, on a real timer.
 *
 * Each transaction keeps its own set of async ids. Those ids are numbers, so
 * they cannot live in a WeakSet; the sets are dropped when the callback
 * settles, and a later transaction does not see them. Async-local state keeps
 * two in-flight transactions apart, so one cannot mark the other inactive.
 */

const BRAND = Symbol("backend-await");
const idState = new Map();
const captureStack = [];
let storage = null;
let executionAsyncId = () => 1;
let hooksInstalled = false;

export const TX_AWAIT_RULE = "The tx callback must not await anything outside the backend.";

function inactive() {
  const error = new Error("事务回调不能等待后端以外的操作。");
  error.name = "TransactionInactiveError";
  return error;
}

function allow(state, asyncId) {
  if (!state || state.dead) return;
  state.allowed.add(asyncId);
  idState.set(asyncId, state);
}

function root(state, asyncId) {
  if (!state || state.dead) return;
  state.roots.add(asyncId);
  idState.set(asyncId, state);
}

function release(state) {
  if (!state || state.dead) return;
  state.dead = true;
  for (const id of state.allowed) {
    if (idState.get(id) === state) idState.delete(id);
  }
  for (const id of state.roots) {
    if (idState.get(id) === state) idState.delete(id);
  }
  state.allowed.clear();
  state.roots.clear();
}

function installHooks() {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const builtin = globalThis.process?.versions?.node && globalThis.process.getBuiltinModule?.("async_hooks");
  if (!builtin?.createHook || !builtin.executionAsyncId || !builtin.AsyncLocalStorage) return;
  executionAsyncId = builtin.executionAsyncId;
  storage = new builtin.AsyncLocalStorage();
  builtin.createHook({
    init(asyncId, type, triggerAsyncId) {
      const capturing = captureStack.at(-1);
      if (capturing && type === "PROMISE") {
        allow(capturing, asyncId);
        return;
      }
      const owner = idState.get(triggerAsyncId);
      if (!owner || !owner.allowed.has(triggerAsyncId)) return;
      allow(owner, asyncId);
    }
  }).enable();
}

function assertTurn(state) {
  if (!state || state.dead) return;
  if (state.violated) throw inactive();
  const here = executionAsyncId();
  if (state.open) {
    root(state, here);
    return;
  }
  if (state.roots.has(here) || state.allowed.has(here)) return;
  state.violated = true;
  throw inactive();
}

/** A promise the tx callback is allowed to await. */
export function backendAwait(value) {
  installHooks();
  const state = storage ? storage.getStore() : null;
  if (state) assertTurn(state);
  if (state) captureStack.push(state);
  let promise;
  try {
    promise = Promise.resolve(value);
  } finally {
    if (state) captureStack.pop();
  }
  promise[BRAND] = true;
  return promise;
}

/**
 * Run fn as a transaction callback. fn may await backendAwait promises only.
 * The tx callback must not await anything outside the backend.
 */
export async function guardCallback(fn) {
  installHooks();
  if (!storage) return fn();
  const state = { roots: new Set(), allowed: new Set(), open: true, violated: false, dead: false };
  try {
    return await storage.run(state, async () => {
      root(state, executionAsyncId());
      try {
        let returned;
        try {
          returned = fn();
        } finally {
          state.open = false;
        }
        return await returned;
      } finally {
        release(state);
      }
    });
  } finally {
    release(state);
  }
}
