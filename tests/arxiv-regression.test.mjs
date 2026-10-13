import "./helpers/block-live-fetch.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

function changedNames() {
  const bases = ["origin/main", "main"];
  for (const base of bases) {
    try {
      execFileSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], { stdio: "ignore" });
    } catch {
      continue;
    }
    try {
      return execFileSync("git", ["diff", "--name-only", base], { encoding: "utf8" })
        .split("\n")
        .filter(Boolean);
    } catch {
      continue;
    }
  }
  return [];
}

// viewer 锁定随 F3-PR2 解除（Wisdom 2026-10-13）。
// lib/notes-* 继续锁定。只放开 lib/notes-store.js（Wisdom 2026-10-13 17:59，F4 PR-1）。
test("AX-23 notes files are untouched versus origin/main", () => {
  const names = changedNames();
  const forbidden = names.filter((name) => name.startsWith("lib/notes-") && name !== "lib/notes-store.js");
  assert.deepEqual(forbidden, []);
});
