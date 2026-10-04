// Per-file /tmp ownership for tests that create temp dirs.
// node --test runs files in parallel, so the snapshot lives in this process:
// record the names this file creates, then assert only those are gone.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before } from "node:test";

const ownedDirs = new Set();

export function tmpNames(prefixes) {
  return readdirSync(tmpdir()).filter((name) => prefixes.some((prefix) => name.startsWith(prefix)));
}

export function snapshotTmp(prefixes) {
  return new Set(tmpNames(prefixes));
}

export function rememberOwnedTemp(dir) {
  ownedDirs.add(dir);
}

export function removeOwnedTemp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

export function createOwnedTemp(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  rememberOwnedTemp(dir);
  t.after(() => {
    removeOwnedTemp(dir);
  });
  return dir;
}

// Names that already existed are ignored, and so are names this file did not create.
export function leakedOwnedDirs(beforeNames, prefixes) {
  const root = tmpdir();
  const leaked = [];
  for (const dir of ownedDirs) {
    const name = basename(dir);
    if (!prefixes.some((prefix) => name.startsWith(prefix))) continue;
    if (dir === join(root, name) && beforeNames.has(name)) continue;
    if (existsSync(dir)) leaked.push(dir);
  }
  return leaked;
}

export function installOwnedTmpGuard(prefixes) {
  let beforeNames = new Set();
  before(() => {
    beforeNames = snapshotTmp(prefixes);
  });
  after((t) => {
    const leaked = leakedOwnedDirs(beforeNames, prefixes);
    if (leaked.length === 0) return;
    const message = `owned temp dirs still present: ${leaked.join(", ")}`;
    t.diagnostic(message);
    assert.deepEqual(leaked, [], message);
  });
}
