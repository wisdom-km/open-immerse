// Confirm-dialog storage. The stub throws unless `this` is the StorageArea.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASK_CONFIRM_KEY } from "../lib/ask-model.js";
import { readStoredAskConfirm, writeStoredAskConfirm } from "../lib/ask-confirm.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");

function chromeLikeStorage(seed = {}) {
  const bag = { ...seed };
  const local = {
    get(key) {
      if (this !== local) {
        const error = new TypeError("Illegal invocation");
        throw error;
      }
      if (typeof key === "string") {
        return Promise.resolve(Object.prototype.hasOwnProperty.call(bag, key) ? { [key]: bag[key] } : {});
      }
      return Promise.resolve({ ...bag });
    },
    set(values) {
      if (this !== local) {
        const error = new TypeError("Illegal invocation");
        throw error;
      }
      Object.assign(bag, values);
      return Promise.resolve();
    }
  };
  return { storage: { local }, bag, local };
}

test("readAskConfirm stays bound and remembers 以后不再提示", async () => {
  const area = chromeLikeStorage();
  const detached = area.local.get;
  await assert.rejects(Promise.resolve().then(() => detached(ASK_CONFIRM_KEY)), /Illegal invocation/);
  assert.equal(await readStoredAskConfirm(area.storage, ASK_CONFIRM_KEY), true);
  assert.equal(await writeStoredAskConfirm(area.storage, ASK_CONFIRM_KEY, false), true);
  assert.equal(area.bag[ASK_CONFIRM_KEY], false);
  assert.equal(await readStoredAskConfirm(area.storage, ASK_CONFIRM_KEY), false);
  const confirmFn = viewer.slice(viewer.indexOf("function readAskConfirm"), viewer.indexOf("function writeAskConfirm"));
  assert.match(confirmFn, /readStoredAskConfirm\(globalThis\.chrome\?\.storage,\s*ASK_CONFIRM_KEY\)/);
  assert.equal(/\.get\(/.test(confirmFn), false);
  assert.equal(confirmFn.includes("const get"), false);
});

test("a storage failure logs a redacted warning and asks again", async () => {
  const area = chromeLikeStorage({ [ASK_CONFIRM_KEY]: false });
  area.local.get = function get() {
    if (this !== area.local) throw new TypeError("Illegal invocation");
    const error = new Error("boom do-not-log-this");
    error.name = "QuotaExceededError";
    throw error;
  };
  const warnings = [];
  const show = await readStoredAskConfirm(area.storage, ASK_CONFIRM_KEY, (message) => {
    warnings.push(String(message));
  });
  assert.equal(show, true);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /QuotaExceededError/);
  assert.equal(warnings[0].includes("do-not-log-this"), false);
  assert.equal(warnings[0].includes(ASK_CONFIRM_KEY), false);

  const seen = [];
  const original = console.warn;
  console.warn = (message) => { seen.push(String(message)); };
  try {
    assert.equal(await readStoredAskConfirm(area.storage, ASK_CONFIRM_KEY), true);
  } finally {
    console.warn = original;
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].includes("do-not-log-this"), false);
});
