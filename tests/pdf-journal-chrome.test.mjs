import test from "node:test";
import assert from "node:assert/strict";

import { isJournalChromeBlock, isJournalChromeItem } from "../lib/pdf-journal-chrome.js";
import { isPageChromeItem, isPageChromeText } from "../lib/pdf-readout.js";
import { vendorLayoutToBlocks } from "../lib/pdf-layout-adapter.js";

const page = { width: 612, height: 792 };

test("decorative text and DOI-only lines are chrome without a position", () => {
  assert.equal(isPageChromeText("a1111111111"), true);
  assert.equal(isPageChromeText("OPEN ACCESS"), true);
  assert.equal(isPageChromeText("10.1186/s13059-014-0550-8"), true);
  assert.equal(isPageChromeText("Attention Is All You Need"), false);
  assert.equal(isPageChromeText("Abstract"), false);
  assert.equal(isPageChromeText("The dominant sequence transduction models are based on"), false);
});

test("article type and running headers need the page edge; section headings stay", () => {
  assert.equal(
    isJournalChromeItem({ str: "METHOD", x: 72, y: 770, width: 60, height: 8 }, page),
    true
  );
  assert.equal(
    isPageChromeItem({ str: "Methods", x: 72, y: 770, width: 70, height: 16 }, page),
    false
  );
  assert.equal(
    isPageChromeItem({ str: "Smith et al. | Nature 2020", x: 72, y: 776, width: 180, height: 8 }, page),
    true
  );
  assert.equal(
    isPageChromeItem({ str: "Abstract", x: 72, y: 548, width: 70, height: 14 }, page),
    false
  );
  assert.equal(
    isPageChromeItem({ str: "Attention Is All You Need", x: 96, y: 730, width: 420, height: 20 }, page),
    false
  );
  assert.equal(
    isPageChromeItem({ str: "(3)", x: 540, y: 400, width: 16, height: 10 }, page),
    false
  );
  assert.equal(
    isPageChromeItem({ str: "ID", x: 24, y: 400, width: 12, height: 8 }, page),
    true
  );
  assert.equal(
    isPageChromeItem({ str: "ID", x: 200, y: 400, width: 16, height: 11 }, page),
    false
  );
});

test("relabelText marks a top banner as a header and keeps Abstract", () => {
  const labeled = vendorLayoutToBlocks({
    layoutDetails: [
      { label: "text", bbox_2d: [0.1, 0.01, 0.9, 0.04], content: "PLOS MEDICINE" },
      { label: "text", bbox_2d: [0.1, 0.2, 0.4, 0.24], content: "Abstract" }
    ]
  }, {
    viewport: {
      width: 612,
      height: 792,
      convertToViewportRectangle(rect) {
        return rect;
      }
    },
    page: 1,
    items: [{ str: "\uFFFD", x: 10, y: 10, width: 10, height: 10 }]
  });
  const texts = (labeled.blocks || []).map((block) => block.text);
  assert.equal(texts.includes("PLOS MEDICINE"), false);
  assert.equal(texts.includes("Abstract"), true);
  assert.equal(isJournalChromeBlock("PLOS MEDICINE", [0.1, 0.01, 0.9, 0.04]), true);
  assert.equal(isJournalChromeBlock("Abstract", [0.1, 0.2, 0.4, 0.24]), false);
});
