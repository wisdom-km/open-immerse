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

    computedLength(el, prop) {
      const view = el?.ownerDocument?.defaultView;
      if (!view?.getComputedStyle) return 0;
      try {
        const n = parseFloat(view.getComputedStyle(el)[prop]);
        return Number.isFinite(n) ? n : 0;
      } catch {
        return 0;
      }
    },

    /**
     * Used-box helper. TRIAD §C.1: shrink-wrapped card H3 ≠ grid/card column.
     */
    sourceContentWidth(source) {
      if (!source) return 0;
      return OIBilingual.elementBoxWidth(source) || OIBilingual.fallbackHostWidth(source);
    },

    /**
     * TRIAD §C.3 rule 1: width = source getBoundingClientRect().width
     * (visible box). Indent is parent padding/margin, text-indent, or nested
     * column — never parent width:100%.
     */
    sourceVisualBox(source) {
      if (!source) return { width: 0, left: 0 };
      const rect = source.getBoundingClientRect?.() || {};
      const visualW = Number(rect.width) || 0;
      return {
        width: visualW > 0 ? visualW : OIBilingual.sourceContentWidth(source),
        left: Number(rect.left) || 0
      };
    },

    /** @deprecated use sourceVisualBox */
    sourceContentBox(source) {
      return OIBilingual.sourceVisualBox(source);
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

    /** Skip `display:contents` and the stack we wrap around a flex-row H3. */
    layoutParent(el) {
      let node = OIBilingual.skipContents(el);
      while (node?.classList?.contains("oi-bilingual-stack")) {
        node = OIBilingual.skipContents(node.parentElement);
      }
      return node;
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

    applyFlexBreakStyles(translation, opts = {}) {
      if (!translation?.style || translation.classList?.contains("oi-inline")) return translation;
      translation.style.display = "block";
      translation.style.boxSizing = "border-box";
      translation.style.minWidth = "0";
      if (opts.fill !== false) {
        translation.style.width = "100%";
        translation.style.maxWidth = "100%";
      }
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
      if (translation.parentElement === source && OIBilingual.isHorizontalFlex(source)) {
        if (source.style) source.style.flexWrap = "wrap";
        return source;
      }
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

    isHeadingTag(el) {
      return /^H[1-6]$/.test(String(el?.tagName || "").toUpperCase());
    },

    /**
     * Card/list H3 sits in a flex row or grid cell. Blog body headings do not —
     * their ancestor <article> must not be treated as the clamp column.
     */
    inCardGridContext(source) {
      if (!source) return false;
      const parent = OIBilingual.layoutParent(source.parentElement);
      if (OIBilingual.isHorizontalFlex(parent)) return true;
      let node = parent;
      while (node && !/^(MAIN|BODY|HTML)$/.test(String(node.tagName || "").toUpperCase())) {
        const selfDisplay = OIBilingual.computedDisplay(node);
        const parentDisplay = OIBilingual.computedDisplay(node.parentElement);
        if (selfDisplay.includes("grid") || parentDisplay.includes("grid")) return true;
        node = OIBilingual.layoutParent(node.parentElement);
      }
      return false;
    },

    /**
     * §C.1 parent-column only for shrink-wrap card/grid titles.
     * §C.3 indented body paragraphs always prefer the source visual box.
     */
    shouldUseColumnClamp(source, measures = {}) {
      const sourceW = measures.sourceW ?? OIBilingual.sourceContentWidth(source);
      const parentW = measures.parentW ?? OIBilingual.immediateParentWidth(source);
      const columnW = measures.columnW ?? OIBilingual.columnWidth(source);
      const hostW = columnW || parentW;
      if (!(hostW > 0)) return false;
      if (!OIBilingual.isHeadingTag(source) || !OIBilingual.inCardGridContext(source)) return false;
      if (sourceW > 0 && sourceW < OIBilingual.SHRINK_WRAP_MIN_PX) return true;
      if (sourceW > 0 && hostW > 0 && sourceW < hostW * OIBilingual.SHRINK_WRAP_PARENT_RATIO) return true;
      return columnW > 0 || parentW > 0;
    },

    copiedSourceInlineStart(source) {
      const inline = OIBilingual.computedLength(source, "marginInlineStart");
      const left = OIBilingual.computedLength(source, "marginLeft");
      return inline > 0 ? inline : left;
    },

    translationFlowLeft(translation, parent) {
      if (translation?.getBoundingClientRect && translation.parentElement === parent) {
        const current = Number(translation.getBoundingClientRect().left) || 0;
        return current - OIBilingual.computedLength(translation, "marginLeft");
      }
      const parentRect = parent?.getBoundingClientRect?.();
      if (!parentRect) return 0;
      return (Number(parentRect.left) || 0)
        + OIBilingual.computedLength(parent, "paddingLeft")
        + OIBilingual.computedLength(parent, "borderLeftWidth");
    },

    /**
     * Align translation left to the source visual box (≤1px).
     * Same-parent afterend: copy margin-left / margin-inline-start when that is
     * the indent; otherwise 0 (shared parent padding / nested column).
     * Never copies text-indent.
     */
    sourceAlignOffset(source, translation) {
      if (!source) return 0;
      if (translation && translation.parentElement === source) return 0;
      const parent = OIBilingual.skipContents(translation?.parentElement || source.parentElement);
      if (!parent || parent === source) return 0;
      if (parent.classList?.contains("oi-bilingual-stack")) return 0;
      const srcLeft = OIBilingual.sourceVisualBox(source).left;
      const visualOffset = srcLeft - OIBilingual.translationFlowLeft(translation, parent);
      const copied = OIBilingual.copiedSourceInlineStart(source);
      const sameParent = Boolean(translation && source.parentElement === translation.parentElement);
      if (sameParent && (visualOffset <= 0.5 || Math.abs(visualOffset - copied) <= 1)) {
        return copied > 0.5 ? Math.round(copied * 100) / 100 : 0;
      }
      if (!Number.isFinite(visualOffset) || visualOffset <= 0.5) return 0;
      return Math.round(visualOffset * 100) / 100;
    },

    resolveLayout(source, translation) {
      const box = OIBilingual.sourceVisualBox(source);
      const sourceW = box.width || OIBilingual.sourceContentWidth(source);
      const parentW = OIBilingual.immediateParentWidth(source);
      const columnW = OIBilingual.columnWidth(source);
      const inside = Boolean(translation && translation.parentElement === source);
      const useColumn = OIBilingual.shouldUseColumnClamp(source, { sourceW, parentW, columnW });
      const width = useColumn
        ? (columnW || parentW || sourceW)
        : (sourceW || parentW || columnW);
      const offset = useColumn || inside ? 0 : OIBilingual.sourceAlignOffset(source, translation);
      return { width, offset, useColumn };
    },

    /**
     * §C.3 body → source visual box. §C.1 shrink-wrap heading → column.
     */
    resolveClampWidth(source) {
      return OIBilingual.resolveLayout(source).width;
    },

    applySourceOffset(translation, offset) {
      if (!translation?.style) return 0;
      const px = Math.max(0, Number(offset) || 0);
      if (px > 0) {
        const value = `${Math.round(px * 100) / 100}px`;
        translation.style.marginLeft = value;
        translation.style.marginInlineStart = value;
      } else {
        if (translation.style.marginLeft && /px\s*$/.test(translation.style.marginLeft)) {
          translation.style.marginLeft = "";
        }
        if (translation.style.marginInlineStart && /px\s*$/.test(translation.style.marginInlineStart)) {
          translation.style.marginInlineStart = "";
        }
      }
      return px;
    },

    isSideRailTranslation(el) {
      return Boolean(el?.classList?.contains("oi-side-rail"));
    },

    nestSideRailInLabel(source, translation) {
      if (!source || !translation) return translation;
      const parent = translation.parentElement;
      if (!parent || parent === source) return translation;
      const display = OIBilingual.computedDisplay(parent);
      if (display.includes("grid") && translation.parentElement === source.parentElement) {
        if (typeof source.appendChild === "function") source.appendChild(translation);
      }
      return translation;
    },

    unlockSideRailHost(source) {
      if (!source) return null;
      let node = source;
      let unlocked = null;
      for (let i = 0; i < 8 && node; i++) {
        const tag = String(node.tagName || "").toUpperCase();
        if (["MAIN", "BODY", "HTML"].includes(tag)) break;
        if (OIBilingual.isHorizontalFlex(node) && node.style) {
          node.style.flexWrap = "wrap";
          node.style.alignItems = "stretch";
        }
        const cls = typeof node.className === "string" ? node.className : String(node.className?.baseVal || "");
        const lockedHeight =
          tag === "BUTTON" ||
          node.getAttribute?.("role") === "combobox" ||
          /h-\[(\d+)px\]/.test(cls);
        if (lockedHeight && node.style) {
          const computed = OIBilingual.computedLength(node, "height");
          if (computed > 0 && !node.style.minHeight) node.style.minHeight = `${computed}px`;
          node.style.height = "auto";
          unlocked = node;
        }
        node = node.parentElement;
      }
      return unlocked;
    },

    applySideRailLayout(translation, source) {
      OIBilingual.nestSideRailInLabel(source, translation);
      OIBilingual.applyFlexBreakStyles(translation, { fill: true });
      if (translation.style) {
        translation.style.width = "100%";
        translation.style.maxWidth = "100%";
        translation.style.flexBasis = "100%";
        translation.style.alignSelf = "stretch";
        translation.style.flexGrow = "1";
      }
      OIBilingual.unlockSideRailHost(source);
      const parentW = OIBilingual.immediateParentWidth(source) || OIBilingual.sourceContentWidth(source);
      return { width: parentW, offset: 0, useColumn: true };
    },

    applyLayout(translation, source) {
      if (!translation || translation.classList?.contains("oi-inline")) {
        return { width: 0, offset: 0, useColumn: false };
      }
      OIBilingual.bindHost(translation, source);
      if (OIBilingual.isSideRailTranslation(translation)) {
        return OIBilingual.applySideRailLayout(translation, source);
      }
      const plan = OIBilingual.resolveLayout(source, translation);
      const alignStart = !plan.useColumn && (plan.offset > 0 || (
        plan.width > 0
        && OIBilingual.immediateParentWidth(source) > plan.width + 1
      ));
      OIBilingual.applySourceWidth(translation, plan.width, { align: alignStart ? "start" : "stretch" });
      OIBilingual.applySourceOffset(translation, plan.offset);
      return plan;
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

    applySourceWidth(translation, width, opts = {}) {
      if (!translation?.style || !(width > 0)) return 0;
      // §C.3 rule 3: do not leave parent-column width:100% as the used size.
      OIBilingual.applyFlexBreakStyles(translation, { fill: false });
      const px = `${Math.round(width * 100) / 100}px`;
      translation.style.boxSizing = "border-box";
      translation.style.minWidth = "0";
      translation.style.width = px;
      translation.style.maxWidth = px;
      translation.style.overflowWrap = "break-word";
      if (opts.align === "start") {
        translation.style.alignSelf = "flex-start";
        translation.style.flexGrow = "0";
      }
      return width;
    },

    clampTranslationWidth(translation, source) {
      if (!translation || translation.classList?.contains("oi-inline")) return 0;
      OIBilingual.bindHost(translation, source);
      return OIBilingual.applyLayout(translation, source).width;
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
      if (!translation) return { extra: 0, width: 0, offset: 0 };
      const host = source || OIBilingual.hostForTranslation(translation);
      OIBilingual.bindHost(translation, host);
      const keep = OIBilingual.dedupeTranslations(host) || translation;
      OIBilingual.breakFlexRow(host, keep);
      const laid = OIBilingual.applyLayout(keep, host);
      const extra = keep.classList?.contains("oi-inline") ? 0 : OIBilingual.clearTranslationOverlap(keep, host);
      return {
        extra,
        width: laid.width,
        offset: laid.offset,
        useColumn: laid.useColumn,
        stacked: !OIBilingual.sharesFlexRow(host, keep)
      };
    }
  };

  root.OIBilingual = OIBilingual;
})(typeof globalThis !== "undefined" ? globalThis : this);
