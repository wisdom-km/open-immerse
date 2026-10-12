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

test("AX-23 viewer and notes files are untouched versus origin/main", () => {
  const names = changedNames();
  const forbidden = names.filter((name) =>
    name === "pdf/viewer.js" ||
    name === "pdf/viewer.html" ||
    name === "pdf/viewer.css" ||
    name.startsWith("lib/notes-")
  );
  assert.deepEqual(forbidden, []);
});
