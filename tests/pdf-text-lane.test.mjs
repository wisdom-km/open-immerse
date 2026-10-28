import test from "node:test";
import assert from "node:assert/strict";
import { claimTextLane } from "../lib/pdf-text-lane.js";

test("a second read of the same page waits until the cancelled one returns", async () => {
  const order = [];
  const first = (async () => {
    const lane = claimTextLane(3);
    await lane.ready;
    order.push("first-start");
    await new Promise((resolve) => setTimeout(resolve, 40));
    order.push("first-end");
    lane.release();
  })();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const lane = claimTextLane(3);
  await lane.ready;
  order.push("second-start");
  lane.release();
  await first;
  assert.deepEqual(order, ["first-start", "first-end", "second-start"]);
});
