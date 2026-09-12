import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "content/content.css"), "utf8");
const js = readFileSync(join(root, "content/content.js"), "utf8");

const bodyBlock = css.slice(css.indexOf(".oi-translation {"), css.indexOf(".oi-translation.oi-after-heading"));
const headingBlock = css.slice(css.indexOf(".oi-translation.oi-after-heading"), css.indexOf(".oi-translation.oi-inline"));
const inlineBlock = css.slice(css.indexOf(".oi-translation.oi-inline"), css.indexOf("html[data-oi-style=\"line\"]"));

test("body translations pull up into the host margin box", () => {
  assert.match(bodyBlock, /margin:\s*-0\.65em\s+0\s+0\.1em/);
  assert.equal(/margin:\s*0\.08em/.test(bodyBlock), false);
  assert.equal(/margin:\s*calc\(/.test(bodyBlock), false);
});

test("heading translations clear descenders with 0.45em padding-top", () => {
  assert.match(headingBlock, /padding-top:\s*0\.45em/);
  assert.match(headingBlock, /margin:\s*0\.7rem\s+0\s+0\.45rem/);
  assert.equal(/padding-top:\s*0\.22rem/.test(headingBlock), false);
  assert.equal(/padding-top:\s*0\.2rem/.test(headingBlock), false);
});

test("in-flow list/table translations do not inherit the negative pull", () => {
  assert.match(css, /:is\(li,\s*td,\s*th,\s*dt,\s*dd\)\s*>\s*\.oi-translation:not\(\.oi-inline\)\s*\{[^}]*margin-top:\s*0\.25em/);
});

test("inline translations stay on the same line with a small left gap", () => {
  assert.match(inlineBlock, /display:\s*inline/);
  assert.match(inlineBlock, /margin:\s*0\s+0\s+0\s+0\.4em/);
});

test("card and box styles keep padding and a positive top gap", () => {
  assert.match(
    css,
    /html\[data-oi-style="card"\] \.oi-translation:not\(\.oi-inline\):not\(\.oi-after-heading\)[\s\S]*?margin-top:\s*0\.35em/
  );
  assert.match(css, /html\[data-oi-style="card"\][\s\S]*padding:\s*0\.4em\s+0\.65em/);
  assert.match(css, /html\[data-oi-style="box"\][\s\S]*padding:\s*0\.4em\s+0\.65em/);
  assert.match(css, /html\[data-oi-style="card"\][\s\S]*border-left-width:\s*3px/);
});

test("content.js marks H1–H3 as oi-after-heading and inserts afterend", () => {
  assert.match(js, /\^H\[1-3\]\$/);
  assert.match(js, /oi-translation oi-after-heading/);
  assert.match(js, /insertAdjacentElement\("afterend"/);
  assert.match(js, /\["LI",\s*"TD",\s*"TH",\s*"DT",\s*"DD"\]/);
});
