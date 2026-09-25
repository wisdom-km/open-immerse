import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgePage } from "../lib/prelabel-accuracy.js";

const root = join(import.meta.dirname, "..");
const fixture = JSON.parse(readFileSync(join(root, "tests/fixtures/prelabel-judgments.json"), "utf8"));

function readPage(paper, page) {
  const path = join(root, "labels/prelabel", paper, `page-${String(page).padStart(3, "0")}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

test("agent judgments: script bases stay attached and citation markers stay text", () => {
  const failures = [];
  for (const judgment of fixture.cases) {
    if (!judgment.must) continue;
    const result = judgePage(readPage(judgment.paper, judgment.page), judgment);
    if (!result.ok) failures.push(`${judgment.id}: ${result.reason}`);
  }
  assert.deepEqual(failures, []);
});
