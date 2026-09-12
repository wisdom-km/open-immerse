import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "content/content.js"), "utf8");

test("webpage FAB path injects draft on OI_TRANSLATE_PROGRESS then replaces", () => {
  assert.match(src, /const STATUS_TRANSLATING = "翻译中…"/);
  assert.match(src, /const STATUS_POLISHING = "润色中…"/);
  assert.match(src, /message\.type === "OI_TRANSLATE_PROGRESS"/);
  assert.match(src, /applyTranslateProgress\(message\)/);
  assert.match(src, /showStatus\(STATUS_TRANSLATING\)/);
  assert.match(src, /showStatus\(STATUS_POLISHING\)/);
  assert.match(src, /requestId/);
  assert.match(src, /type: "OI_TRANSLATE_BATCH"/);
  assert.match(
    src,
    /function applyTranslateProgress\(message\) \{\n  if \(!inflight \|\| message\.phase !== "draft"\) return;/
  );
  assert.match(src, /mountTranslation\(el, text, inflight\.settings\)/);
  assert.match(src, /mountTranslation\(el, res\.translations\[idx\] \|\| "", settings\)/);
  assert.match(src, /clearStatus\(\)/);
  assert.match(src, /opts\.persist/);
  assert.match(src, /text !== STATUS_TRANSLATING && text !== STATUS_POLISHING/);
  assert.match(src, /translation: node\.textContent/);
});
