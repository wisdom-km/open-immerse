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
  tagName = "DIV",
  parent = null,
  display = "block",
  left = 0,
  paddingLeft = 0,
  paddingRight = 0,
  borderLeftWidth = 0,
  marginLeft = 0
} = {}) {
  const style = {
    fontSize: `${fontSize}px`,
    display: "",
    flexDirection: "",
    flexWrap: "",
    flex: "",
    marginTop: "",
    marginLeft: "",
    marginRight: "",
    marginInlineStart: "",
    paddingTop: "",
    maxWidth: "",
    width: "",
    minWidth: "",
    boxSizing: "",
    overflowWrap: "",
    flexGrow: "",
    flexShrink: "",
    flexBasis: "",
    alignSelf: "",
    justifySelf: "",
    props: {}
  };
  const el = {
    tagName,
    className,
    __display: display,
    __paddingLeft: paddingLeft,
    __paddingRight: paddingRight,
    __borderLeftWidth: borderLeftWidth,
    __marginLeft: marginLeft,
    clientWidth: clientWidth == null ? width : clientWidth,
    parentElement: parent,
    offsetParent: parent,
    firstElementChild: null,
    getAttribute(name) {
      return name === "role" ? null : "";
    },
    classList: {
      contains(name) {
        return className.split(/\s+/).includes(name);
      }
    },
    style: {
      setProperty(key, value) {
        style.props[key] = value;
      },
      get display() {
        return style.display;
      },
      set display(value) {
        style.display = value;
      },
      get flexDirection() {
        return style.flexDirection;
      },
      set flexDirection(value) {
        style.flexDirection = value;
      },
      get flexWrap() {
        return style.flexWrap;
      },
      set flexWrap(value) {
        style.flexWrap = value;
      },
      get flex() {
        return style.flex;
      },
      set flex(value) {
        style.flex = value;
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
      get marginLeft() {
        return style.marginLeft;
      },
      set marginLeft(value) {
        style.marginLeft = value;
      },
      get marginRight() {
        return style.marginRight;
      },
      set marginRight(value) {
        style.marginRight = value;
      },
      get marginInlineStart() {
        return style.marginInlineStart;
      },
      set marginInlineStart(value) {
        style.marginInlineStart = value;
      },
      get paddingTop() {
        return style.paddingTop;
      },
      set paddingTop(value) {
        style.paddingTop = value;
      },
      get overflowWrap() {
        return style.overflowWrap;
      },
      set overflowWrap(value) {
        style.overflowWrap = value;
      }
    },
    ownerDocument: {
      defaultView: {
        getComputedStyle(node) {
          return {
            fontSize: `${fontSize}px`,
            display: node?.style?.display || node?.__display || display,
            flexDirection: node?.style?.flexDirection || node?.__flexDirection || "row",
            paddingLeft: `${node?.__paddingLeft ?? paddingLeft}px`,
            paddingRight: `${node?.__paddingRight ?? paddingRight}px`,
            borderLeftWidth: `${node?.__borderLeftWidth ?? borderLeftWidth}px`,
            borderRightWidth: "0px",
            marginLeft: node?.style?.marginLeft || `${node?.__marginLeft ?? marginLeft}px`,
            marginInlineStart: node?.style?.marginInlineStart || `${node?.__marginInlineStart ?? marginLeft}px`,
            textIndent: node?.__textIndent || "0px"
          };
        }
      }
    },
    getBoundingClientRect() {
      const shift = parseExtra(style.marginTop) || parseExtra(style.paddingTop);
      const indent = parseFloat(style.marginLeft) || 0;
      const used = parseFloat(style.width) || width;
      return {
        top: top + shift,
        bottom: bottom + shift,
        width: used,
        height: bottom - top,
        left: left + indent,
        right: left + indent + used
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
  assert.equal(block.style.display, "block");
  assert.equal(block.style.flexBasis, "100%");
  assert.notEqual(block.style.flexBasis, "360px");

  const inline = fakeBox({ className: "oi-translation oi-inline", top: 90, bottom: 110, width: 900 });
  assert.equal(OI.clampTranslationWidth(inline, source), 0);
  assert.equal(inline.style.maxWidth, "");
});

test("block clamp never sets flex-basis to shrink-wrapped H3 px", () => {
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
  assert.equal(translation.style.minWidth, "0");
  assert.equal(translation.style.flexBasis, "100%");
  assert.equal(translation.style.flexGrow, "1");
  assert.equal(translation.style.flexShrink, "0");
  assert.equal(translation.style.alignSelf, "stretch");
  assert.notEqual(translation.style.flexBasis, "372px");
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

test("§C.1 clamp uses card/grid column, not shrink-wrapped H3", () => {
  const OI = loadBilingual();
  assert.equal(OI.SHRINK_WRAP_MIN_PX, 40);
  assert.equal(OI.SHRINK_WRAP_PARENT_RATIO, 0.5);

  const card = fakeBox({
    className: "ArticleList-module__article",
    tagName: "ARTICLE",
    top: 0,
    bottom: 80,
    width: 400,
    display: "block"
  });
  const content = fakeBox({
    className: "ArticleList-module__content",
    tagName: "DIV",
    top: 0,
    bottom: 80,
    width: 400,
    parent: card,
    display: "flex"
  });
  content.__flexDirection = "row";
  const h3 = fakeBox({
    className: "headline-4",
    tagName: "H3",
    top: 0,
    bottom: 40,
    width: 372,
    parent: content
  });
  assert.equal(OI.resolveClampWidth(h3), 400);

  const tiny = fakeBox({
    className: "headline-4",
    tagName: "H3",
    top: 0,
    bottom: 40,
    width: 80,
    parent: content
  });
  assert.equal(OI.resolveClampWidth(tiny), 400);

  const collapsed = fakeBox({
    className: "headline-4",
    tagName: "H3",
    top: 0,
    bottom: 20,
    width: 12,
    parent: content
  });
  assert.equal(OI.resolveClampWidth(collapsed), 400);

  const grid = fakeBox({
    className: "grid",
    tagName: "DIV",
    top: 0,
    bottom: 200,
    width: 900,
    display: "grid"
  });
  const cell = fakeBox({
    className: "card",
    tagName: "DIV",
    top: 0,
    bottom: 200,
    width: 360,
    parent: grid,
    display: "block"
  });
  const gridH3 = fakeBox({
    className: "headline-4",
    tagName: "H3",
    top: 0,
    bottom: 40,
    width: 120,
    parent: cell
  });
  assert.equal(OI.resolveClampWidth(gridH3), 360);

  const trans = fakeBox({ className: "oi-translation oi-after-heading", top: 48, bottom: 88, width: 900 });
  assert.equal(OI.clampTranslationWidth(trans, tiny), 400);
  assert.equal(trans.style.overflowWrap, "break-word");
  assert.equal(trans.style.boxSizing, "border-box");
  assert.equal(trans.style.maxWidth, "400px");
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

function createFlexRowCard({ columnWidth = 872, h3Width = 372, translationWidth = 1110 } = {}) {
  const nodes = [];
  const doc = {
    defaultView: {
      getComputedStyle(node) {
        return {
          fontSize: "16px",
          display: node?.style?.display || node?.__display || "block",
          flexDirection: node?.style?.flexDirection || node?.__flexDirection || "row",
          paddingLeft: `${node?.__paddingLeft || 0}px`,
          paddingRight: `${node?.__paddingRight || 0}px`,
          borderLeftWidth: `${node?.__borderLeftWidth || 0}px`,
          borderRightWidth: "0px",
          marginLeft: node?.style?.marginLeft || `${node?.__marginLeft || 0}px`,
          marginInlineStart: node?.style?.marginInlineStart || `${node?.__marginInlineStart || 0}px`,
          textIndent: node?.__textIndent || "0px"
        };
      }
    }
  };

  function queryAll(root, predicate) {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (predicate(n)) out.push(n);
      (n.children || []).forEach(walk);
    };
    walk(root);
    return out;
  }

  function createNode(opts) {
    const children = [];
    const style = {
      display: "",
      flexDirection: "",
      flexWrap: "",
      flex: "",
      boxSizing: "",
      minWidth: "",
      width: "",
      maxWidth: "",
      overflowWrap: "",
      flexGrow: "",
      flexShrink: "",
      flexBasis: "",
      alignSelf: "",
      justifySelf: "",
      marginTop: "",
      marginLeft: "",
      marginRight: "",
      marginInlineStart: "",
      paddingTop: "",
      props: {},
      setProperty(key, value) {
        style.props[key] = value;
      }
    };
    const el = {
      tagName: opts.tagName || "DIV",
      className: opts.className || "",
      __display: opts.display || "block",
      __flexDirection: opts.flexDirection || "row",
      __paddingLeft: opts.paddingLeft || 0,
      __paddingRight: opts.paddingRight || 0,
      __borderLeftWidth: opts.borderLeftWidth || 0,
      __marginLeft: opts.marginLeft || 0,
      __left: opts.left || 0,
      clientWidth: opts.width || 0,
      boxWidth: opts.width || 0,
      parentElement: null,
      offsetParent: null,
      ownerDocument: doc,
      children,
      get firstChild() {
        return children[0] || null;
      },
      get firstElementChild() {
        return children[0] || null;
      },
      get nextElementSibling() {
        const p = el.parentElement;
        if (!p) return null;
        const i = p.children.indexOf(el);
        return i >= 0 ? p.children[i + 1] || null : null;
      },
      get previousElementSibling() {
        const p = el.parentElement;
        if (!p) return null;
        const i = p.children.indexOf(el);
        return i > 0 ? p.children[i - 1] : null;
      },
      classList: {
        contains(name) {
          return String(el.className).split(/\s+/).includes(name);
        }
      },
      getAttribute(name) {
        return name === "role" ? opts.role || null : "";
      },
      style,
      getBoundingClientRect() {
        const indent = parseFloat(style.marginLeft) || 0;
        const used = parseFloat(style.width) || el.boxWidth;
        const left = (el.__left || 0) + indent;
        return {
          width: used,
          height: 40,
          top: 0,
          bottom: 40,
          left,
          right: left + used
        };
      },
      appendChild(child) {
        if (child.parentElement?.removeChild) child.parentElement.removeChild(child);
        children.push(child);
        child.parentElement = el;
        return child;
      },
      insertBefore(child, ref) {
        if (child.parentElement?.removeChild) child.parentElement.removeChild(child);
        const i = children.indexOf(ref);
        if (i === -1) children.push(child);
        else children.splice(i, 0, child);
        child.parentElement = el;
        return child;
      },
      removeChild(child) {
        const i = children.indexOf(child);
        if (i !== -1) children.splice(i, 1);
        child.parentElement = null;
        return child;
      },
      remove() {
        el.parentElement?.removeChild?.(el);
      },
      querySelectorAll(sel) {
        if (sel === ".oi-bilingual-stack") {
          return queryAll(el, (n) => String(n.className).split(/\s+/).includes("oi-bilingual-stack"));
        }
        if (sel === ".oi-translation") {
          return queryAll(el, (n) => String(n.className).split(/\s+/).includes("oi-translation"));
        }
        return [];
      }
    };
    nodes.push(el);
    return el;
  }

  doc.createElement = (tag) =>
    createNode({
      tagName: String(tag || "DIV").toUpperCase(),
      width: 0,
      display: "block"
    });
  doc.querySelectorAll = (sel) => {
    const matches = [];
    nodes.forEach((n) => {
      if (sel === ".oi-bilingual-stack" && String(n.className).split(/\s+/).includes("oi-bilingual-stack")) {
        matches.push(n);
      }
    });
    return matches;
  };

  const article = createNode({
    tagName: "ARTICLE",
    className: "ArticleList-module__article",
    width: columnWidth,
    display: "block"
  });
  const link = createNode({
    tagName: "A",
    className: "ArticleList-module__cardLink",
    width: columnWidth,
    display: "flex",
    flexDirection: "row"
  });
  const content = createNode({
    tagName: "DIV",
    className: "ArticleList-module__content",
    width: columnWidth,
    display: "flex",
    flexDirection: "row"
  });
  const h3 = createNode({
    tagName: "H3",
    className: "headline-4",
    width: h3Width,
    display: "block"
  });
  const date = createNode({
    tagName: "DIV",
    className: "ArticleList-module__date",
    width: 96,
    display: "block"
  });
  const translation = createNode({
    tagName: "DIV",
    className: "oi-translation oi-after-heading",
    width: translationWidth,
    display: "block"
  });

  article.appendChild(link);
  link.appendChild(content);
  content.appendChild(h3);
  content.appendChild(date);
  content.insertBefore(translation, date);
  h3.offsetParent = article;
  translation.offsetParent = article;
  content.offsetParent = article;

  return { article, link, content, h3, date, translation, doc };
}

test("§C.2 flex-row parent does not keep .oi-translation beside H3", () => {
  const OI = loadBilingual();
  const columnWidth = 872;
  const { content, h3, date, translation, article } = createFlexRowCard({
    columnWidth,
    h3Width: 372,
    translationWidth: 1110
  });

  assert.equal(OI.isHorizontalFlex(content), true);
  assert.equal(OI.sharesFlexRow(h3, translation), true);
  assert.equal(translation.previousElementSibling, h3);
  assert.equal(h3.nextElementSibling, translation);

  const laid = OI.layoutTranslation(translation, h3);
  const stack = translation.parentElement;

  assert.equal(stack.classList.contains("oi-bilingual-stack"), true);
  assert.equal(h3.parentElement, stack);
  assert.equal(translation.parentElement, stack);
  assert.equal(stack.parentElement, content);
  assert.equal(date.parentElement, content);
  assert.equal(OI.sharesFlexRow(h3, translation), false);
  assert.equal(laid.stacked, true);
  assert.ok(laid.width <= columnWidth);
  assert.equal(laid.width, columnWidth);
  assert.equal(translation.style.display, "block");
  assert.equal(translation.style.flexBasis, "100%");
  assert.notEqual(translation.style.flexBasis, "372px");
  assert.match(translation.style.maxWidth, /^872(\.0+)?px$/);
  assert.match(translation.style.width, /^872(\.0+)?px$/);
  assert.ok(Number.parseFloat(translation.style.width) <= columnWidth);
  assert.ok(Number.parseFloat(translation.style.width) < 1110);
  assert.equal(OI.hostForTranslation(translation), h3);

  OI.unwrapBilingualStacks(article);
  assert.equal(h3.parentElement, content);
  assert.equal(date.parentElement, content);
  assert.equal(article.querySelectorAll(".oi-bilingual-stack").length, 0);
});

test("breakFlexRow stacks a translation appended inside a row-flex sidebar host", () => {
  const OI = loadBilingual();
  const view = {
    getComputedStyle(node) {
      return {
        display: node?.__display || "flex",
        flexDirection: node?.__flexDirection || "row",
        fontSize: "16px"
      };
    }
  };
  const source = fakeBox({ tagName: "LI", display: "flex", width: 200 });
  source.__display = "flex";
  source.__flexDirection = "row";
  source.ownerDocument = { defaultView: view };
  const translation = fakeBox({
    className: "oi-translation",
    display: "block",
    width: 200,
    parent: source
  });
  translation.ownerDocument = { defaultView: view };
  const result = OI.breakFlexRow(source, translation);
  assert.equal(result, source);
  assert.equal(source.style.flexWrap, "wrap");
  assert.equal(translation.style.display, "block");
  assert.equal(translation.style.flexBasis, "100%");
  assert.equal(translation.classList.contains("oi-inline"), false);
});

function createIndentedParagraph({
  articleWidth = 900,
  wrapperWidth = 800,
  wrapperPadLeft = 40,
  sourceWidth = 560,
  sourceMarginLeft = 24
} = {}) {
  const sourceLeft = wrapperPadLeft + sourceMarginLeft;
  const article = fakeBox({
    className: "Post-module__article",
    tagName: "ARTICLE",
    top: 0,
    bottom: 400,
    width: articleWidth,
    left: 0,
    display: "block"
  });
  const wrapper = fakeBox({
    className: "PostContent",
    tagName: "DIV",
    top: 0,
    bottom: 400,
    width: wrapperWidth,
    left: 0,
    parent: article,
    display: "block",
    paddingLeft: wrapperPadLeft
  });
  const p = fakeBox({
    className: "source",
    tagName: "P",
    top: 0,
    bottom: 80,
    width: sourceWidth,
    clientWidth: sourceWidth,
    left: sourceLeft,
    parent: wrapper,
    display: "block",
    marginLeft: sourceMarginLeft
  });
  const translation = fakeBox({
    className: "oi-translation",
    top: 90,
    bottom: 170,
    width: articleWidth,
    left: wrapperPadLeft,
    parent: wrapper,
    display: "block"
  });
  p.nextElementSibling = translation;
  translation.previousElementSibling = p;
  p.offsetParent = article;
  translation.offsetParent = article;
  wrapper.offsetParent = article;
  return { article, wrapper, p, translation, sourceLeft, sourceWidth };
}

function assertVisualLock(source, translation, { maxLeftDelta = 1 } = {}) {
  const src = source.getBoundingClientRect();
  const tr = translation.getBoundingClientRect();
  assert.ok(tr.width <= src.width + 0.01, `width ${tr.width} > source ${src.width}`);
  assert.ok(Math.abs(tr.left - src.left) <= maxLeftDelta, `left Δ ${tr.left - src.left}`);
  assert.notEqual(translation.style.width, "100%");
  assert.equal(translation.style.textIndent || "", "");
  return { src, tr };
}

test("§C.3 indented p uses source visual box, not a wider ancestor", () => {
  const OI = loadBilingual();
  const { article, wrapper, p, translation, sourceLeft, sourceWidth } = createIndentedParagraph();

  assert.equal(OI.sourceVisualBox(p).width, sourceWidth);
  assert.equal(OI.sourceVisualBox(p).left, sourceLeft);
  assert.equal(OI.columnWidth(p), 800);
  assert.equal(OI.shouldUseColumnClamp(p), false);
  assert.equal(OI.resolveClampWidth(p), sourceWidth);
  assert.ok(OI.resolveClampWidth(p) < article.clientWidth);

  const laid = OI.layoutTranslation(translation, p);
  assert.equal(laid.width, sourceWidth);
  assert.equal(laid.offset, 24);
  assert.equal(translation.style.maxWidth, "560px");
  assert.equal(translation.style.width, "560px");
  assert.equal(translation.style.marginLeft, "24px");
  assert.equal(translation.style.marginInlineStart, "24px");
  const { src, tr } = assertVisualLock(p, translation);
  assert.equal(tr.left, sourceLeft);
  assert.ok(tr.left > wrapper.getBoundingClientRect().left);
  assert.ok(tr.right <= src.right + 0.5);
});

test("§C.3 indented wrapper afterend uses source rect, not parent width:100%", () => {
  const OI = loadBilingual();
  const { article, wrapper, p, translation } = createIndentedParagraph({
    wrapperPadLeft: 96,
    sourceWidth: 640,
    sourceMarginLeft: 0
  });
  p.__marginLeft = 0;
  const sourceRect = p.getBoundingClientRect();
  const laid = OI.layoutTranslation(translation, p);
  assert.equal(laid.useColumn, false);
  assert.equal(laid.width, sourceRect.width);
  assert.equal(laid.offset, 0);
  assert.equal(translation.style.width, `${sourceRect.width}px`);
  assert.equal(translation.style.maxWidth, `${sourceRect.width}px`);
  assert.notEqual(translation.style.width, "100%");
  assert.notEqual(translation.style.maxWidth, "100%");
  assert.ok(!translation.style.marginLeft || translation.style.marginLeft === "0px");
  assert.ok(laid.width < OI.columnWidth(p) || OI.columnWidth(p) === 640);
  assert.ok(laid.width < article.clientWidth);
  assertVisualLock(p, translation);
  assert.ok(Math.abs(translation.getBoundingClientRect().left - sourceRect.left) <= 1);
});

test("§C.3 body paragraphs never take §C.1 column clamp", () => {
  const OI = loadBilingual();
  const { p } = createIndentedParagraph({ sourceWidth: 24, sourceMarginLeft: 0, wrapperPadLeft: 40 });
  p.__marginLeft = 0;
  assert.equal(OI.isHeadingTag(p), false);
  assert.equal(OI.shouldUseColumnClamp(p), false);
  assert.equal(OI.resolveClampWidth(p), 24);
});

test("§C.3 does not copy text-indent; still uses the source border-box", () => {
  const OI = loadBilingual();
  const { p, translation } = createIndentedParagraph({
    wrapperPadLeft: 80,
    sourceWidth: 600,
    sourceMarginLeft: 0
  });
  p.__textIndent = "2em";
  p.__marginLeft = 0;
  const laid = OI.layoutTranslation(translation, p);
  assert.equal(laid.width, 600);
  assert.equal(laid.offset, 0);
  assert.equal(translation.style.textIndent || "", "");
  assertVisualLock(p, translation);
});

test("§C.3 marketing li stays the source width (not the article column)", () => {
  const OI = loadBilingual();
  const article = fakeBox({
    className: "Post-module__article",
    tagName: "ARTICLE",
    top: 0,
    bottom: 200,
    width: 900,
    left: 0,
    display: "block"
  });
  const li = fakeBox({
    className: "source",
    tagName: "LI",
    top: 0,
    bottom: 60,
    width: 640,
    clientWidth: 640,
    left: 48,
    parent: article,
    display: "block"
  });
  const translation = fakeBox({
    className: "oi-translation",
    top: 40,
    bottom: 80,
    width: 900,
    left: 48,
    parent: li,
    display: "block"
  });
  li.firstElementChild = translation;
  assert.equal(OI.shouldUseColumnClamp(li), false);
  assert.equal(OI.resolveClampWidth(li), 640);
  const laid = OI.layoutTranslation(translation, li);
  assert.equal(laid.width, 640);
  assert.equal(laid.offset, 0);
  assert.equal(translation.style.width, "640px");
  assert.ok(laid.width < 900);
});

test("article-body heading uses source visual width, not the wider article column", () => {
  const OI = loadBilingual();
  const article = fakeBox({
    className: "Post-module__article",
    tagName: "ARTICLE",
    top: 0,
    bottom: 200,
    width: 900,
    display: "block"
  });
  const h3 = fakeBox({
    className: "headline-3",
    tagName: "H3",
    top: 0,
    bottom: 40,
    width: 680,
    parent: article,
    display: "block",
    left: 110
  });
  assert.equal(OI.inCardGridContext(h3), false);
  assert.equal(OI.shouldUseColumnClamp(h3), false);
  assert.equal(OI.resolveClampWidth(h3), 680);
  assert.equal(OI.sourceVisualBox(h3).left, 110);
  assert.equal(OI.sourceAlignOffset(h3), 110);
});


