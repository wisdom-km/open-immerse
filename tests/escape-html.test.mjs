import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { escapeHtml } from "../lib/html.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("escapeHtml encodes & < > \" and '", () => {
  assert.equal(escapeHtml("&"), "&amp;");
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml(">"), "&gt;");
  assert.equal(escapeHtml('"'), "&quot;");
  assert.equal(escapeHtml("'"), "&#39;");
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("escapeHtml does not return the same characters for & < > \"", () => {
  for (const ch of ["&", "<", ">", '"']) {
    const out = escapeHtml(ch);
    assert.notEqual(out, ch);
    assert.match(out, /^&[a-z#0-9]+;$/);
  }
});

test("escapeHtml leaves safe text alone and treats nullish as empty", () => {
  assert.equal(escapeHtml("hello 藏"), "hello 藏");
  assert.equal(escapeHtml(""), "");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
});

test("escapeHtml blocks a script payload", () => {
  assert.equal(
    escapeHtml(`<script>alert("x")</script>`),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"
  );
});

test("learning page imports shared escapeHtml instead of a local broken map", () => {
  const src = readFileSync(join(root, "learning/learning.js"), "utf8");
  assert.match(src, /import\s*\{[^}]*escapeHtml[^}]*\}\s*from\s*["']\.\.\/lib\/html\.js["']/);
  assert.equal(src.includes("function escapeHtml"), false);
});
