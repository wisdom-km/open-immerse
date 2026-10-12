import test from "node:test";
import assert from "node:assert/strict";

test("optional live arXiv fetch stays opt-in", async () => {
  if (process.env.ARXIV_LIVE !== "1") {
    assert.equal(process.env.ARXIV_LIVE || "", "");
    return;
  }
  const response = await fetch("https://arxiv.org/src/1706.03762v7");
  assert.equal(response.ok, true);
});
