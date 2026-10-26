import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { blockSoftLead, isInternalSlotLead, slotBadgeForLead, stripUserVisibleSlots } from "../lib/pdf-library.js";
import { layoutRouteForPage, TEXT_LAYER_ROUTE } from "../lib/pdf-layout-route.js";
import { collectReadoutExportNodes } from "../lib/pdf-viewer.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("internal slot leads stay available to integrity checks and stay off the surface", () => {
  const bad = {
    text: "Where the projections are parameter matrices ⟦f1⟧ and ⟦f2⟧.",
    sourceText: "Where the projections are parameter matrices W and W.",
    translation: "其中这些投影是参数矩阵。",
    placeholders: [
      { token: "⟦f1⟧", blockId: "f1" },
      { token: "⟦f2⟧", blockId: "f2" }
    ]
  };
  const lead = blockSoftLead(bad);
  assert.match(lead, /公式槽待对齐/);
  assert.equal(isInternalSlotLead(lead), true);
  assert.equal(slotBadgeForLead(lead).label, "公式");
  assert.equal(slotBadgeForLead("（引用待对齐） ").label, "引用");
  assert.equal(isInternalSlotLead("（译文待核对，以下为原文） "), false);
  assert.equal(stripUserVisibleSlots(`前缀 ${lead}其中 ⟦f1⟧ 结束`), "前缀 其中 结束");
});

test("exported readout text drops unresolved slot tokens", () => {
  const nodes = collectReadoutExportNodes({
    querySelectorAll() {
      return [{
        tagName: "P",
        childNodes: [
          { nodeType: 3, textContent: "其中这些投影是参数矩阵（公式槽待对齐） ⟦f1⟧。" }
        ]
      }];
    }
  });
  assert.equal(nodes[0].text.includes("槽"), false);
  assert.equal(nodes[0].text.includes("⟦"), false);
  assert.match(nodes[0].text, /其中这些投影是参数矩阵/);
});

test("the reader paints a badge instead of the internal slot lead", () => {
  const viewer = readFileSync(join(root, "pdf/viewer.js"), "utf8");
  const css = readFileSync(join(root, "pdf/viewer.css"), "utf8");
  const fn = viewer.slice(viewer.indexOf("function appendBlockLead"), viewer.indexOf("function writeBlockPieces"));
  assert.match(fn, /isInternalSlotLead/);
  assert.match(fn, /slotBadgeForLead/);
  assert.match(fn, /oi-pdf-slot-badge/);
  assert.match(fn, /if \(isInternalSlotLead\(lead\)\)[\s\S]*return;/);
  assert.match(css, /\.oi-pdf-slot-badge/);
});

test("Appendix R seam stays on the text layer", () => {
  const route = layoutRouteForPage();
  assert.equal(route.route, TEXT_LAYER_ROUTE);
  assert.equal(route.route, "text-layer");
  const src = readFileSync(join(root, "lib/pdf-layout-route.js"), "utf8");
  assert.equal(/^\s*import /m.test(src), false);
  assert.equal(src.includes("fetch("), false);
});
