import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hasNestedCollectible, shouldCollectNode } from "../lib/page-scan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function loadBilingual() {
  const ctx = createContext({ globalThis: {} });
  runInContext(readFileSync(join(root, "lib/bilingual-layout.js"), "utf8"), ctx);
  return ctx.globalThis.OIBilingual;
}

function parseExtra(value) {
  const m = String(value || "").match(/(\d+(?:\.\d+)?)px\)/);
  return m ? Number(m[1]) : 0;
}

function fakeBox({
  className = "oi-translation",
  top,
  bottom,
  width = 320,
  clientWidth,
  fontSize = 16,
  tagName = "DIV"
} = {}) {
  const style = {
    fontSize: `${fontSize}px`,
    marginTop: "",
    paddingTop: "",
    maxWidth: "",
    width: "",
    minWidth: "",
    boxSizing: "",
    flexGrow: "",
    flexShrink: "",
    flexBasis: "",
    alignSelf: "",
    justifySelf: "",
    props: {}
  };
  const el = {
    tagName,
    clientWidth: clientWidth == null ? width : clientWidth,
    firstElementChild: null,
    classList: {
      contains(name) {
        return className.split(/\s+/).includes(name);
      }
    },
    style: {
      setProperty(key, value) {
        style.props[key] = value;
      },
      get boxSizing() {
        return style.boxSizing;
      },
      set boxSizing(value) {
        style.boxSizing = value;
      },
      get maxWidth() {
        return style.maxWidth;
      },
      set maxWidth(value) {
        style.maxWidth = value;
      },
      get width() {
        return style.width;
      },
      set width(value) {
        style.width = value;
      },
      get minWidth() {
        return style.minWidth;
      },
      set minWidth(value) {
        style.minWidth = value;
      },
      get flexGrow() {
        return style.flexGrow;
      },
      set flexGrow(value) {
        style.flexGrow = value;
      },
      get flexShrink() {
        return style.flexShrink;
      },
      set flexShrink(value) {
        style.flexShrink = value;
      },
      get flexBasis() {
        return style.flexBasis;
      },
      set flexBasis(value) {
        style.flexBasis = value;
      },
      get alignSelf() {
        return style.alignSelf;
      },
      set alignSelf(value) {
        style.alignSelf = value;
      },
      get justifySelf() {
        return style.justifySelf;
      },
      set justifySelf(value) {
        style.justifySelf = value;
      },
      get marginTop() {
        return style.marginTop;
      },
      set marginTop(value) {
        style.marginTop = value;
      },
      get paddingTop() {
        return style.paddingTop;
      },
      set paddingTop(value) {
        style.paddingTop = value;
      }
    },
    ownerDocument: {
      defaultView: {
        getComputedStyle() {
          return { fontSize: `${fontSize}px` };
        }
      }
    },
    getBoundingClientRect() {
      const shift = parseExtra(style.marginTop) || parseExtra(style.paddingTop);
      return {
        top: top + shift,
        bottom: bottom + shift,
        width,
        height: bottom - top,
        left: 0,
        right: width
      };
    }
  };
  return el;
}

test("overlap helper steps 2–4px until gap ≥ 2px and caps extra at ~1.2em", () => {
  const OI = loadBilingual();
  assert.equal(OI.OVERLAP_GAP_MIN, 2);
  assert.ok(OI.OVERLAP_STEP_PX >= 2 && OI.OVERLAP_STEP_PX <= 4);
  assert.equal(OI.verticalGap({ bottom: 100 }, { top: 98 }), -2);
  assert.equal(OI.needsOverlapBump(-2), true);
  assert.equal(OI.needsOverlapBump(2), false);
  assert.equal(OI.overlapCapPx(16), 19.2);
  assert.equal(OI.nextOverlapExtra(0, 3, 12), 3);
  assert.equal(OI.nextOverlapExtra(18, 3, 19.2), 19.2);

  const source = fakeBox({ className: "source", top: 0, bottom: 100, width: 400 });
  const body = fakeBox({ className: "oi-translation", top: 98, bottom: 140, width: 480, fontSize: 16 });
  const extra = OI.clearTranslationOverlap(body, source);
  assert.ok(extra >= 3);
  assert.ok(extra <= 19.2);
  assert.match(body.style.marginTop, /calc\(-0\.65em \+ /);
  const gap = OI.verticalGap(source.getBoundingClientRect(), body.getBoundingClientRect());
  assert.ok(gap >= 2);

  const heading = fakeBox({
    className: "oi-translation oi-after-heading",
    top: 90,
    bottom: 130,
    width: 480,
    fontSize: 16
  });
  const headingExtra = OI.clearTranslationOverlap(heading, source);
  assert.ok(headingExtra > 0);
  assert.match(heading.style.paddingTop, /calc\(0\.45em \+ /);
  assert.equal(heading.style.marginTop, "");
});

test("width clamp uses the source content box and skips inline nodes", () => {
  const OI = loadBilingual();
  const source = fakeBox({ className: "source", top: 0, bottom: 80, width: 360 });
  const block = fakeBox({ className: "oi-translation", top: 90, bottom: 130, width: 900 });
  assert.equal(OI.clampTranslationWidth(block, source), 360);
  assert.equal(block.style.boxSizing, "border-box");
  assert.equal(block.style.maxWidth, "360px");
  assert.equal(block.style.width, "360px");

  const inline = fakeBox({ className: "oi-translation oi-inline", top: 90, bottom: 110, width: 900 });
  assert.equal(OI.clampTranslationWidth(inline, source), 0);
  assert.equal(inline.style.maxWidth, "");
});

test("card/grid H3 clamp uses shrink-wrapped host, not the flex row", () => {
  const OI = loadBilingual();
  const h3 = fakeBox({
    className: "headline-4",
    tagName: "H3",
    top: 0,
    bottom: 40,
    width: 372,
    clientWidth: 372
  });
  const translation = fakeBox({
    className: "oi-translation oi-after-heading",
    top: 48,
    bottom: 88,
    width: 478
  });
  assert.equal(OI.sourceContentWidth(h3), 372);
  assert.equal(OI.clampTranslationWidth(translation, h3), 372);
  assert.equal(translation.style.width, "372px");
  assert.equal(translation.style.maxWidth, "372px");
  assert.equal(translation.style.minWidth, "0");
  assert.equal(translation.style.flexGrow, "0");
  assert.equal(translation.style.flexBasis, "372px");
  assert.equal(translation.style.alignSelf, "flex-start");
  assert.equal(translation.style.justifySelf, "start");
  OI.bindHost(translation, h3);
  assert.equal(OI.hostForTranslation(translation), h3);
});

test("source content width prefers the smaller client box over a stretched border box", () => {
  const OI = loadBilingual();
  const stretched = fakeBox({
    className: "headline-4",
    tagName: "H3",
    top: 0,
    bottom: 40,
    width: 478,
    clientWidth: 372
  });
  assert.equal(OI.sourceContentWidth(stretched), 372);
});

test("dedupe keeps one .oi-translation per host", () => {
  const OI = loadBilingual();
  const removed = [];
  const first = { classList: { contains: (n) => n === "oi-translation" }, remove() { removed.push("first"); } };
  const second = { classList: { contains: (n) => n === "oi-translation" }, remove() { removed.push("second"); } };
  const host = {
    nextElementSibling: first,
    querySelectorAll() {
      return [second];
    }
  };
  assert.equal(OI.dedupeTranslations(host), first);
  assert.deepEqual(removed, ["second"]);
});

test("page-scan skips nested block hosts so parent li does not duplicate children", () => {
  const child = { tagName: "P" };
  const parent = {
    tagName: "LI",
    nextElementSibling: null,
    querySelector(sel) {
      if (sel.includes("p") || sel.includes("li")) return child;
      return null;
    },
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { width: 480, height: 80, left: 120, right: 600, top: 180 };
    },
    cloneNode() {
      return {
        querySelectorAll() {
          return { forEach() {} };
        },
        innerText: "Sectioning Implementing guardrails Automating evals",
        textContent: "Sectioning Implementing guardrails Automating evals"
      };
    }
  };
  assert.equal(hasNestedCollectible(parent), true);
  assert.equal(
    shouldCollectNode(parent, { translateScope: "article" }, { hostname: "www.anthropic.com", innerWidth: 1280 }),
    false
  );
});
