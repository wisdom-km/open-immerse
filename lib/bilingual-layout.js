(function (root) {
  const hosts = new WeakMap();

  const OIBilingual = {
    OVERLAP_GAP_MIN: 2,
    OVERLAP_STEP_PX: 3,
    OVERLAP_EXTRA_CAP_EM: 1.2,
    SHRINK_WRAP_MIN_PX: 40,
    SHRINK_WRAP_PARENT_RATIO: 0.5,
    BLOCK_SELECTOR: "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd",

    verticalGap(sourceRect, translationRect) {
      return Number(translationRect?.top) - Number(sourceRect?.bottom);
    },

    needsOverlapBump(gap, minGap = OIBilingual.OVERLAP_GAP_MIN) {
      return !Number.isFinite(Number(gap)) || Number(gap) < minGap;
    },

    overlapCapPx(fontSize) {
      const fs = Number(fontSize);
      return (Number.isFinite(fs) && fs > 0 ? fs : 16) * OIBilingual.OVERLAP_EXTRA_CAP_EM;
    },

    nextOverlapExtra(current, step = OIBilingual.OVERLAP_STEP_PX, capPx) {
      const cur = Math.max(0, Number(current) || 0);
      const s = Math.max(1, Number(step) || OIBilingual.OVERLAP_STEP_PX);
      const cap = Number.isFinite(Number(capPx)) ? Number(capPx) : Infinity;
      if (cur >= cap) return cap;
      return Math.min(cap, cur + s);
    },

    preferOverlapPadding(el) {
      return Boolean(el?.classList?.contains("oi-after-heading"));
    },

    bindHost(translation, source) {
      if (translation && source) hosts.set(translation, source);
      return source || null;
    },

    elementBoxWidth(el) {
      if (!el) return 0;
      const border = Number(el.getBoundingClientRect?.().width) || 0;
      const client = Number(el.clientWidth) || 0;
      const candidates = [border, client].filter((n) => n > 0);
      return candidates.length ? Math.min(...candidates) : 0;
    },

    /**
     * Source content box. TRIAD §C.1: shrink-wrapped card H3 ≠ grid/card column.
     */
    sourceContentWidth(source) {
      if (!source) return 0;
      return OIBilingual.elementBoxWidth(source) || OIBilingual.fallbackHostWidth(source);
    },

    computedDisplay(el) {
      const view = el?.ownerDocument?.defaultView;
      if (!view?.getComputedStyle) return "";
      try {
        return String(view.getComputedStyle(el).display || "");
      } catch {
        return "";
      }
    },

    looksLikeCardRoot(el) {
      if (!el) return false;
      const tag = String(el.tagName || "").toUpperCase();
      if (tag === "ARTICLE") return true;
      if (el.getAttribute?.("role") === "article") return true;
      const cls = typeof el.className === "string" ? el.className : String(el.className?.baseVal || "");
      return /card|article/i.test(cls);
    },

    skipContents(el) {
      let node = el;
      while (node && OIBilingual.computedDisplay(node) === "contents") node = node.parentElement;
      return node || el;
    },

    immediateParentWidth(source) {
      const parent = OIBilingual.skipContents(source?.parentElement);
      return OIBilingual.elementBoxWidth(parent);
    },

    /** Grid cell, card root, or offsetParent — the column the H3 sits in. */
    columnWidth(source) {
      if (!source) return 0;
      let node = OIBilingual.skipContents(source.parentElement);
      let found = 0;
      while (node && !/^(MAIN|BODY|HTML)$/.test(String(node.tagName || "").toUpperCase())) {
        const parent = node.parentElement;
        const selfDisplay = OIBilingual.computedDisplay(node);
        const parentDisplay = OIBilingual.computedDisplay(parent);
        const w = OIBilingual.elementBoxWidth(node);
        if (w > 0 && (parentDisplay.includes("grid") || selfDisplay.includes("grid"))) {
          found = w;
          break;
        }
        if (w > 0 && OIBilingual.looksLikeCardRoot(node)) {
          found = w;
          break;
        }
        node = OIBilingual.skipContents(parent);
      }
      const offset = OIBilingual.elementBoxWidth(source.offsetParent);
      const parentW = OIBilingual.immediateParentWidth(source);
      const candidates = [found, offset, parentW].filter((n) => n > 0);
      return candidates.length ? Math.min(...candidates) : 0;
    },

    computedFlexDirection(el) {
      const view = el?.ownerDocument?.defaultView;
      if (!view?.getComputedStyle) return "row";
      try {
        return String(view.getComputedStyle(el).flexDirection || "row");
      } catch {
        return "row";
      }
    },

    isHorizontalFlex(el) {
      const display = OIBilingual.computedDisplay(el);
      if (!display.includes("flex")) return false;
      const dir = OIBilingual.computedFlexDirection(el);
      return dir === "row" || dir === "row-reverse";
    },

    sharesFlexRow(source, translation) {
      if (!source || !translation) return false;
      if (source.parentElement !== translation.parentElement) return false;
      return OIBilingual.isHorizontalFlex(source.parentElement);
    },

    applyFlexBreakStyles(translation) {
      if (!translation?.style || translation.classList?.contains("oi-inline")) return translation;
      translation.style.display = "block";
      translation.style.boxSizing = "border-box";
      translation.style.minWidth = "0";
      translation.style.width = "100%";
      translation.style.maxWidth = "100%";
      translation.style.flexBasis = "100%";
      translation.style.flexGrow = "1";
      translation.style.flexShrink = "0";
      translation.style.alignSelf = "stretch";
      translation.style.overflowWrap = "break-word";
      return translation;
    },

    applyStackStyles(stack) {
      if (!stack?.style) return stack;
      stack.style.display = "flex";
      stack.style.flexDirection = "column";
      stack.style.alignItems = "stretch";
      stack.style.minWidth = "0";
      stack.style.flex = "1 1 auto";
      stack.style.maxWidth = "100%";
      stack.style.boxSizing = "border-box";
      return stack;
    },

    /** Take translation out of a row-flex pairing with the H3 (Anthropic `__content`). */
    breakFlexRow(source, translation) {
      if (!source || !translation || translation.classList?.contains("oi-inline")) return null;
      OIBilingual.applyFlexBreakStyles(translation);
      const parent = source.parentElement;
      if (parent?.classList?.contains("oi-bilingual-stack")) {
        OIBilingual.applyStackStyles(parent);
        return parent;
      }
      if (!OIBilingual.isHorizontalFlex(parent)) return null;
      const doc = source.ownerDocument;
      if (!doc?.createElement) {
        if (parent.style) parent.style.flexWrap = "wrap";
        return null;
      }
      const stack = doc.createElement("div");
      stack.className = "oi-bilingual-stack";
      parent.insertBefore(stack, source);
      stack.appendChild(source);
      if (translation.parentElement) translation.parentElement.removeChild?.(translation);
      stack.appendChild(translation);
      OIBilingual.applyStackStyles(stack);
      return stack;
    },

    unwrapBilingualStacks(root) {
      const scope = root?.querySelectorAll ? root : root?.ownerDocument || root;
      if (!scope?.querySelectorAll) return 0;
      let n = 0;
      scope.querySelectorAll(".oi-bilingual-stack").forEach((stack) => {
        const parent = stack.parentElement;
        if (!parent) return;
        while (stack.firstChild) parent.insertBefore(stack.firstChild, stack);
        stack.remove();
        n += 1;
      });
      return n;
    },

    /**
     * Clamp to card column / parent container — not the shrink-wrapped H3.
     */
    resolveClampWidth(source) {
      const columnW = OIBilingual.columnWidth(source);
      const parentW = OIBilingual.immediateParentWidth(source);
      const sourceW = OIBilingual.sourceContentWidth(source);
      return columnW || parentW || sourceW;
    },

    fallbackHostWidth(source) {
      const child = source.firstElementChild;
      if (child && !child.classList?.contains("oi-translation")) {
        const w = Number(child.getBoundingClientRect?.().width) || Number(child.clientWidth) || 0;
        if (w > 0) return w;
      }
      return OIBilingual.textInkWidth(source);
    },

    textInkWidth(el) {
      try {
        const doc = el.ownerDocument;
        if (!doc?.createRange) return 0;
        const range = doc.createRange();
        range.selectNodeContents(el);
        const rects = [...range.getClientRects()].filter((r) => Number(r.width) > 1);
        if (!rects.length) return 0;
        return Math.max(...rects.map((r) => r.right)) - Math.min(...rects.map((r) => r.left));
      } catch {
        return 0;
      }
    },

    hostForTranslation(node) {
      if (!node) return null;
      const bound = hosts.get(node);
      if (bound) return bound;
      const parent = node.parentElement;
      const prev = node.previousElementSibling;
      if (parent && ["LI", "TD", "TH", "DT", "DD"].includes(parent.tagName) && node.parentElement === parent) {
        if (prev && /^(P|H[1-6]|BLOCKQUOTE|FIGCAPTION)$/.test(prev.tagName)) return prev;
        return parent;
      }
      if (prev && !prev.classList?.contains("oi-translation")) return prev;
      return parent || null;
    },

    applySourceWidth(translation, width) {
      if (!translation?.style || !(width > 0)) return 0;
      OIBilingual.applyFlexBreakStyles(translation);
      const px = `${Math.round(width * 100) / 100}px`;
      translation.style.boxSizing = "border-box";
      translation.style.minWidth = "0";
      translation.style.width = px;
      translation.style.maxWidth = px;
      translation.style.overflowWrap = "break-word";
      return width;
    },

    clampTranslationWidth(translation, source) {
      if (!translation || translation.classList?.contains("oi-inline")) return 0;
      OIBilingual.bindHost(translation, source);
      return OIBilingual.applySourceWidth(translation, OIBilingual.resolveClampWidth(source));
    },

    applyOverlapExtra(translation, extraPx) {
      const extra = Math.max(0, Number(extraPx) || 0);
      if (!translation?.style) return extra;
      translation.style.setProperty?.("--oi-overlap-extra", `${extra}px`);
      if (OIBilingual.preferOverlapPadding(translation)) {
        translation.style.paddingTop = `calc(0.45em + ${extra}px)`;
        translation.style.marginTop = "";
      } else {
        translation.style.marginTop = `calc(-0.65em + ${extra}px)`;
      }
      return extra;
    },

    clearTranslationOverlap(translation, source, opts = {}) {
      if (!translation || !source?.getBoundingClientRect) return 0;
      const minGap = opts.minGap ?? OIBilingual.OVERLAP_GAP_MIN;
      const step = opts.step ?? OIBilingual.OVERLAP_STEP_PX;
      const view = translation.ownerDocument?.defaultView;
      const fontSize = parseFloat(view?.getComputedStyle?.(translation)?.fontSize) || 16;
      const cap = opts.capPx ?? OIBilingual.overlapCapPx(fontSize);
      let extra = 0;
      OIBilingual.applyOverlapExtra(translation, 0);
      const maxSteps = Math.ceil(cap / Math.max(1, step)) + 2;
      for (let i = 0; i < maxSteps; i++) {
        const gap = OIBilingual.verticalGap(source.getBoundingClientRect(), translation.getBoundingClientRect());
        if (!OIBilingual.needsOverlapBump(gap, minGap)) break;
        if (extra >= cap) break;
        extra = OIBilingual.nextOverlapExtra(extra, step, cap);
        OIBilingual.applyOverlapExtra(translation, extra);
      }
      return extra;
    },

    collectHostTranslations(source) {
      const out = [];
      if (!source) return out;
      const sib = source.nextElementSibling;
      if (sib?.classList?.contains("oi-translation")) out.push(sib);
      if (typeof source.querySelectorAll === "function") {
        source.querySelectorAll(":scope > .oi-translation").forEach((node) => {
          if (!out.includes(node)) out.push(node);
        });
      }
      return out;
    },

    dedupeTranslations(source) {
      const nodes = OIBilingual.collectHostTranslations(source);
      nodes.slice(1).forEach((node) => {
        if (typeof node.remove === "function") node.remove();
      });
      return nodes[0] || null;
    },

    hasNestedCollectible(el, selector = OIBilingual.BLOCK_SELECTOR) {
      return Boolean(el?.querySelector?.(selector));
    },

    layoutTranslation(translation, source) {
      if (!translation) return { extra: 0, width: 0 };
      const host = source || OIBilingual.hostForTranslation(translation);
      OIBilingual.bindHost(translation, host);
      const keep = OIBilingual.dedupeTranslations(host) || translation;
      OIBilingual.breakFlexRow(host, keep);
      const width = OIBilingual.clampTranslationWidth(keep, host);
      const extra = keep.classList?.contains("oi-inline") ? 0 : OIBilingual.clearTranslationOverlap(keep, host);
      return { extra, width, stacked: !OIBilingual.sharesFlexRow(host, keep) };
    }
  };

  root.OIBilingual = OIBilingual;
})(typeof globalThis !== "undefined" ? globalThis : this);
