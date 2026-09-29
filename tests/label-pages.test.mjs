import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPageLabels } from "../lib/label-schema.js";

const root = fileURLToPath(new URL("../labels/prelabel/", import.meta.url));

test("every committed prelabel page has ids that match char, font, and bbox", () => {
  assert.equal(existsSync(root), true, "labels/prelabel is missing; run node scripts/corpus-prelabel.mjs");
  const papers = readdirSync(root).filter((name) => !name.startsWith("."));
  assert.ok(papers.length >= 30, `expected 30 papers, found ${papers.length}`);
  let pages = 0;
  for (const paper of papers) {
    const dir = join(root, paper);
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    assert.ok(files.length > 0, paper);
    for (const file of files) {
      const page = JSON.parse(readFileSync(join(dir, file), "utf8"));
      const issues = verifyPageLabels(page);
      assert.deepEqual(issues, [], `${paper}/${file} ${issues.slice(0, 4).join("; ")}`);
      pages += 1;
    }
  }
  assert.ok(pages > 100);
});
