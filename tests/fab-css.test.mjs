import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../content/content.css"), "utf8");
const fabBtn = css.slice(css.indexOf(".oi-fab > button"), css.indexOf(".oi-fab > button.on"));

test("FAB buttons are 36×36 and flex-centered", () => {
  assert.match(fabBtn, /display:\s*flex/);
  assert.match(fabBtn, /align-items:\s*center/);
  assert.match(fabBtn, /justify-content:\s*center/);
  assert.match(fabBtn, /width:\s*36px/);
  assert.match(fabBtn, /height:\s*36px/);
  assert.match(fabBtn, /padding:\s*0/);
  assert.match(fabBtn, /font-size:\s*12px/);
  assert.match(fabBtn, /line-height:\s*1/);
});
