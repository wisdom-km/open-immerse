import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));

test("AX-22 default glob does not include tests/net, and this file does not call arxiv.org", () => {
  const top = readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs"));
  assert.equal(top.some((name) => name.startsWith("arxiv-")), true);
  assert.equal(top.includes("arxiv-live.test.mjs"), false);
  const live = readFileSync(join(testsDir, "net/arxiv-live.test.mjs"), "utf8");
  assert.match(live, /ARXIV_LIVE/);
  assert.equal(live.includes("arxiv.org"), true);
  const here = readFileSync(fileURLToPath(import.meta.url), "utf8");
  assert.equal(/https?:\/\/arxiv\.org/.test(here), false);
});
