import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LIBRARY_PERSIST_HINT_KEY } from "../lib/library-store.js";
import { NOTES_PERSIST_HINT_KEY } from "../lib/notes-prefs.js";
import {
  createChromePlatform,
  createMemoryPlatform,
  getPlatform,
  setPlatform
} from "../lib/platform/index.js";
import { createMemoryKv } from "../lib/platform/kv.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

globalThis.fetch = () => {
  const error = new Error("platform skeleton test must not send a network request");
  error.code = "live-fetch-blocked";
  throw error;
};

test("platform skeleton exposes kv, library, and net, and the hint key is global", async () => {
  setPlatform(null);
  const detected = getPlatform();
  assert.equal(detected.target, "memory");
  assert.equal(typeof detected.kv.get, "function");
  assert.equal(typeof detected.library.open, "function");
  assert.equal(detected.library.kind, "memory");
  assert.equal(typeof detected.net.fetch, "function");
  assert.equal(Object.hasOwn(detected, "files"), false);

  const kv = createMemoryKv();
  let seen = 0;
  const stop = kv.watch((changes, area) => {
    if (area === "local" && changes.example) seen += 1;
  });
  await kv.set("local", { example: 1 });
  assert.equal(await kv.get("local", "example"), 1);
  assert.deepEqual(await kv.keys("local", "ex"), ["example"]);
  assert.equal(seen, 1);
  await kv.remove("local", ["example"]);
  assert.equal(await kv.get("local", "example"), undefined);
  stop();

  const custom = createMemoryPlatform({ kv });
  setPlatform(custom);
  assert.equal(getPlatform(), custom);
  setPlatform(null);

  assert.equal(LIBRARY_PERSIST_HINT_KEY, "library.persistHintDismissed");
  assert.notEqual(LIBRARY_PERSIST_HINT_KEY, NOTES_PERSIST_HINT_KEY);
  assert.equal(LIBRARY_PERSIST_HINT_KEY.includes("docId"), false);
  const librarySrc = readFileSync(join(root, "lib/library-store.js"), "utf8");
  assert.equal(librarySrc.includes(`"${NOTES_PERSIST_HINT_KEY}"`), false);
  assert.equal(librarySrc.includes("notesPersistGranted"), false);
  assert.equal(librarySrc.includes("indexedDB.open"), false);
  assert.equal(librarySrc.includes("127.0.0.1:8765"), false);
  const notesSrc = readFileSync(join(root, "lib/notes-store.js"), "utf8");
  assert.equal(notesSrc.includes("openIndexedDatabase"), true);
  assert.equal(/indexedDB\.open\(/.test(notesSrc), false);
});

test("chrome kv reads storage areas and does not scan the whole local area", async () => {
  const areas = {
    local: { "libraryPersistGranted": false },
    sync: { settings: { provider: "mymemory" } }
  };
  let scanned = false;
  const chrome = {
    runtime: { id: "extension-id" },
    storage: {
      local: {
        get(key) {
          if (key == null) scanned = true;
          return Promise.resolve({ [key]: areas.local[key] });
        },
        set(entries) {
          Object.assign(areas.local, entries);
          return Promise.resolve();
        },
        remove() {
          return Promise.resolve();
        },
        getKeys() {
          return Promise.resolve(Object.keys(areas.local));
        }
      },
      sync: {
        get(key) {
          return Promise.resolve({ [key]: areas.sync[key] });
        },
        set() {
          return Promise.resolve();
        },
        remove() {
          return Promise.resolve();
        }
      },
      onChanged: {
        addListener() {},
        removeListener() {}
      }
    }
  };
  const platform = createChromePlatform(chrome);
  assert.equal(platform.target, "chrome-ext");
  assert.equal(platform.library.kind, "idb");
  assert.equal(await platform.kv.get("local", "libraryPersistGranted"), false);
  await platform.kv.set("local", { librarySchemaSeen: 2 });
  assert.equal(areas.local.librarySchemaSeen, 2);
  assert.equal(scanned, false);
  assert.deepEqual(await platform.kv.keys("local"), ["libraryPersistGranted", "librarySchemaSeen"]);
  const noKeys = {
    storage: {
      local: {
        get() {
          scanned = true;
          return Promise.resolve({});
        },
        set() {
          return Promise.resolve();
        },
        remove() {
          return Promise.resolve();
        }
      }
    }
  };
  assert.deepEqual(await createChromePlatform(noKeys).kv.keys("local"), []);
  assert.equal(scanned, false);
});
