import "./helpers/block-live-fetch.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeBlockedFetch } from "./helpers/block-live-fetch.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));

test("AX-22 default glob does not include tests/net, and arxiv tests cannot live-fetch", () => {
  const top = readdirSync(testsDir).filter((name) => name.endsWith(".test.mjs"));
  const arxiv = top.filter((name) => name.startsWith("arxiv-"));
  assert.equal(arxiv.length > 0, true);
  assert.equal(top.includes("arxiv-live.test.mjs"), false);
  for (const name of arxiv) {
    const source = readFileSync(join(testsDir, name), "utf8");
    assert.equal(
      source.includes('import "./helpers/block-live-fetch.mjs"'),
      true,
      name
    );
  }
  const live = readFileSync(join(testsDir, "net/arxiv-live.test.mjs"), "utf8");
  assert.match(live, /ARXIV_LIVE/);
  assert.equal(live.includes("arxiv.org"), true);
  assert.equal(live.includes("block-live-fetch"), false);
  assert.equal(probeBlockedFetch(), true);
});
