import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolbar = readFileSync(join(root, "content/toolbar.js"), "utf8");
const fabSrc = readFileSync(join(root, "lib/fab.js"), "utf8");

function loadFab() {
  const ctx = createContext({ globalThis: {} });
  runInContext(fabSrc, ctx);
  return ctx.globalThis.OIFab || ctx.OIFab;
}

function fakeNode({ className = "", acts = [], menu = false, _act } = {}) {
  const kids = acts.map((act) =>
    fakeNode({
      className: act === "fold" ? "oi-fab-fold" : "",
      acts: [],
      _act: act
    })
  );
  if (menu) kids.push(fakeNode({ className: "oi-fab-menu", acts: [] }));
  const node = {
    className,
    classList: {
      contains: (name) => className.split(/\s+/).filter(Boolean).includes(name)
    },
    dataset: {},
    children: kids,
    _act,
    _removed: false,
    querySelector(sel) {
      return queryAll(node, sel)[0] || null;
    },
    querySelectorAll(sel) {
      return queryAll(node, sel);
    },
    remove() {
      node._removed = true;
      if (node._host) node._host._drop(node);
    }
  };
  for (const child of kids) child._parent = node;
  return node;
}

function matches(node, simple) {
  const sel = simple.trim();
  if (!sel) return false;
  if (sel.startsWith(".")) {
    return node.classList.contains(sel.slice(1));
  }
  const act = sel.match(/^\[data-act="([^"]+)"\]$/);
  if (act) return node._act === act[1];
  return false;
}

function descendants(node) {
  const out = [];
  for (const child of node.children || []) {
    out.push(child, ...descendants(child));
  }
  return out;
}

function queryAll(node, selector) {
  const parts = String(selector).split(",").map((s) => s.trim()).filter(Boolean);
  return descendants(node).filter((el) => parts.some((part) => matches(el, part)));
}

function fakeHost(nodes) {
  let kids = [...nodes];
  const host = {
    _drop(el) {
      kids = kids.filter((n) => n !== el);
    },
    querySelector(sel) {
      return host.querySelectorAll(sel)[0] || null;
    },
    querySelectorAll(sel) {
      if (sel === ".oi-fab") return kids.filter((n) => n.classList.contains("oi-fab") && !n._removed);
      return kids.flatMap((n) => n.querySelectorAll(sel));
    }
  };
  for (const n of kids) n._host = host;
  return host;
}

function staleFourButton() {
  return fakeNode({
    className: "oi-fab",
    acts: ["toggle", "restore", "save", "more"],
    menu: true
  });
}

function v1Bar() {
  return fakeNode({
    className: "oi-fab",
    acts: ["toggle", "restore", "fold"]
  });
}

test("isV1Shape rejects the leftover 翻译/原文/收藏/⋯ bar", () => {
  const FAB = loadFab();
  assert.equal(FAB.isV1Shape(staleFourButton()), false);
  assert.equal(FAB.isV1Shape(fakeNode({ className: "oi-fab", acts: ["toggle", "restore", "save"] })), false);
  assert.equal(FAB.isV1Shape(fakeNode({ className: "oi-fab", acts: ["toggle", "restore"] })), false);
  assert.equal(FAB.isV1Shape(fakeNode({ className: "oi-fab", acts: ["toggle", "restore", "fold", "more"] })), false);
  assert.equal(FAB.isV1Shape(fakeNode({ className: "oi-fab", acts: ["toggle", "restore", "fold"], menu: true })), false);
  assert.equal(FAB.isV1Shape(null), false);
  assert.equal(FAB.isV1Shape({ classList: { contains: () => true } }), false);
});

test("isV1Shape accepts toggle + restore + fold and no save/more/menu", () => {
  const FAB = loadFab();
  const bar = v1Bar();
  bar.className = "oi-fab oi-fab-collapsed";
  assert.equal(FAB.isV1Shape(v1Bar()), true);
  assert.equal(FAB.isV1Shape(bar), true);
});

test("isV1Shape ignores foreign toolbars that are not .oi-fab", () => {
  const FAB = loadFab();
  const foreign = fakeNode({
    className: "imt-panel immersive-translate-popup",
    acts: ["translate", "save", "more"]
  });
  assert.equal(FAB.isV1Shape(foreign), false);
  const host = fakeHost([foreign]);
  const plan = FAB.reconcile(host);
  assert.equal(plan.removed, 0);
  assert.equal(foreign._removed, false);
});

test("reconcile upgrades a leftover four-button FAB and remounts", () => {
  const FAB = loadFab();
  const stale = staleFourButton();
  const host = fakeHost([stale]);
  const plan = FAB.reconcile(host);
  assert.equal(plan.action, "mount");
  assert.equal(plan.removed, 1);
  assert.equal(plan.stale, 1);
  assert.equal(stale._removed, true);
  assert.equal(host.querySelector(".oi-fab"), null);
});

test("reconcile remounts leftover V1 so inject can rebind listeners", () => {
  const FAB = loadFab();
  const live = v1Bar();
  const host = fakeHost([live]);
  const plan = FAB.reconcile(host);
  assert.equal(plan.action, "mount");
  assert.equal(plan.removed, 1);
  assert.equal(plan.stale, 0);
  assert.equal(live._removed, true);
});

test("reconcile hides any leftover FAB when settings turn the bar off", () => {
  const FAB = loadFab();
  const stale = staleFourButton();
  const host = fakeHost([stale]);
  const plan = FAB.reconcile(host, { hidden: true });
  assert.equal(plan.action, "hide");
  assert.equal(plan.removed, 1);
  assert.equal(stale._removed, true);
});

test("toolbar inject reconciles instead of returning on an existing .oi-fab", () => {
  assert.doesNotMatch(toolbar, /if \(document\.querySelector\("\.oi-fab"\)\) return/);
  assert.match(toolbar, /FAB\.reconcile\(document,\s*\{\s*hidden\s*\}\)/);
  assert.match(toolbar, /plan\.action !== "mount"/);
  assert.match(toolbar, /dataset\.oiFab = "v1"/);
  assert.match(toolbar, /data-act="fold"/);
  assert.match(toolbar, /data-act="toggle"/);
  assert.match(toolbar, /data-act="restore"/);
  assert.equal(toolbar.includes('data-act="save"'), false);
  assert.equal(toolbar.includes('data-act="more"'), false);
  assert.doesNotMatch(toolbar, /immersive-translate/i);
  assert.doesNotMatch(fabSrc, /immersive-translate/i);
  assert.doesNotMatch(fabSrc, /chrome\.management/);
});
