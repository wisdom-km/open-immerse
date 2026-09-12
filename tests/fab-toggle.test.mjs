import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolbar = readFileSync(join(root, "content/toolbar.js"), "utf8");
const content = readFileSync(join(root, "content/content.js"), "utf8");

function loadFab() {
  const ctx = createContext({ globalThis: {} });
  runInContext(readFileSync(join(root, "lib/fab.js"), "utf8"), ctx);
  return ctx.globalThis.OIFab || ctx.OIFab;
}

test("scheme B: 停止 only while translating / inflight, else 翻译", () => {
  const FAB = loadFab();
  assert.equal(FAB.fabToggleState({ inflight: false, hasTranslations: false }), "idle");
  assert.equal(FAB.fabToggleState({ inflight: true, hasTranslations: false }), "translating");
  assert.equal(FAB.fabToggleState({ inflight: true, hasTranslations: true }), "translating");
  assert.equal(FAB.fabToggleState({ inflight: false, hasTranslations: true }), "translated");
  assert.equal(FAB.fabToggleLabel("idle"), "翻译");
  assert.equal(FAB.fabToggleLabel("translated"), "翻译");
  assert.equal(FAB.fabToggleLabel("translating"), "停止");
  assert.equal(FAB.fabToggleIntent("idle"), "translate");
  assert.equal(FAB.fabToggleIntent("translated"), "translate");
  assert.equal(FAB.fabToggleIntent("translating"), "abort");
});

test("toolbar left button uses scheme B copy and never restore on 停止", () => {
  assert.match(toolbar, /fabToggleLabel/);
  assert.match(toolbar, /fabToggleIntent/);
  assert.match(toolbar, /fabToggleState/);
  assert.match(toolbar, /oi-please-stop/);
  assert.match(toolbar, /oi-please-start/);
  const click = toolbar.slice(toolbar.indexOf('if (act === "toggle")'), toolbar.indexOf('if (act === "restore")'));
  assert.match(click, /fabToggleIntent\(state\) === "abort"/);
  assert.match(click, /oi-please-stop/);
  assert.equal(click.includes("oi-please-restore"), false);
  assert.match(click, /enabled: true/);
  assert.equal(click.includes("enabled: on"), false);
});

test("content abort keeps translations; restore still clears; busy settles after batch", () => {
  assert.match(content, /addEventListener\("oi-please-stop", \(\) => abort\(\)\)/);
  assert.doesNotMatch(content, /oi-please-stop", \(\) => restore\(\)/);
  assert.match(content, /function abort\(/);
  assert.match(content, /function settleBusy\(/);
  assert.match(content, /function markBusy\(/);
  assert.match(content, /let session = false/);
  const abort = content.slice(content.indexOf("function abort("), content.indexOf("function restore("));
  assert.match(abort, /markBusy\(false\)/);
  assert.match(abort, /epoch \+= 1/);
  assert.equal(abort.includes('.oi-translation'), false);
  assert.equal(abort.includes("restore("), false);
  assert.match(content, /if \(ticket === epoch\) settleBusy\(\)/);
  assert.match(content, /classList\.toggle\("oi-active", running\)/);
  const restore = content.slice(content.indexOf("function restore("), content.indexOf("function hasPageTranslations("));
  assert.match(restore, /\.oi-translation, \.oi-selection-card/);
  assert.match(restore, /session = false/);
  assert.match(content, /if \(!session\) return/);
});
