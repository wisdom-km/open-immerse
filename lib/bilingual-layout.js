(function (root) {
  const hosts = new WeakMap();

  const OIBilingual = {
    OVERLAP_GAP_MIN: 2,
    OVERLAP_STEP_PX: 3,
    OVERLAP_EXTRA_CAP_EM: 1.2,
    BODY_MARGIN_TOP_EM: -0.65,
    BODY_MARGIN_FLOOR_EM: -0.8,
    BODY_TARGET_EM: 0.35,
    BODY_TARGET_MAX_EM: 0.45,
    BODY_GLOSS_GAP_MIN_EM: 0.1,
    BODY_GLOSS_GAP_MAX_EM: 0.7,
    BODY_GLOSS_GAP_DEFAULT_EM: 0.35,
    BODY_GLOSS_STACK_GAP_MIN_EM: 0,
    BODY_GLOSS_STACK_GAP_MAX_EM: 2.5,
    BODY_GLOSS_STACK_GAP_DEFAULT_EM: 0.25,
    HEADING_MARGIN_TOP_EM: 0.05,
    HEADING_PAD_TOP_EM: 0.14,
    HEADING_PAD_MIN_EM: 0.08,
    HEADING_TARGET_MIN_EM: 0.12,
    HEADING_TARGET_EM: 0.2,
    HEADING_TARGET_MAX_EM: 0.28,
    HEADING_HARD_MAX_EM: 0.32,
    HEADING_HARD_MIN_EM: 0.1,
    HEADING_HARD_MAX_PX: 10,
    /** BILINGUAL-SPACING §8 / BODY-BILINGUAL-GAP §2.1 / BODY-HEADING-GLOSS-SIZE. */
    HEADING_BODY_FONT_SLACK: 0.05,
    DEFAULT_FONT_SCALE: 0.95,
    GAP_CLAMP_STEP_PX: 2,
    GAP_CLAMP_CAP_EM: 3,
    SIDE_RAIL_NEXT_GAP_CAP_PX: 80,
    SHRINK_WRAP_MIN_PX: 40,
    SHRINK_WRAP_PARENT_RATIO: 0.5,
    BLOCK_SELECTOR: "p, h1, h2, h3, h4, h5, h6, li, blockquote, figcaption, td, th, dt, dd, [data-as=p]",

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

    fontSizePx(fontSize) {
      const fs = Number(fontSize);
      return Number.isFinite(fs) && fs > 0 ? fs : 16;
    },

    elementFontSize(el) {
      const view = el?.ownerDocument?.defaultView;
      try {
        return OIBilingual.fontSizePx(parseFloat(view?.getComputedStyle?.(el)?.fontSize));
      } catch {
        return 16;
      }
    },

    opticalGapEm(gap, fontSize) {
      const fs = OIBilingual.fontSizePx(fontSize);
      return Number(gap) / fs;
    },

    headingGapLimitPx(fontSize) {
      const fs = OIBilingual.fontSizePx(fontSize);
      return Math.min(fs * OIBilingual.HEADING_HARD_MAX_EM, OIBilingual.HEADING_HARD_MAX_PX);
    },

    headingTightenPx(fontSize) {
      const fs = OIBilingual.fontSizePx(fontSize);
      return Math.min(fs * OIBilingual.HEADING_TARGET_MAX_EM, OIBilingual.HEADING_HARD_MAX_PX);
    },

    headingTargetPx(fontSize) {
      const fs = OIBilingual.fontSizePx(fontSize);
      const min = fs * OIBilingual.HEADING_TARGET_MIN_EM;
      const max = Math.min(fs * OIBilingual.HEADING_TARGET_MAX_EM, OIBilingual.headingGapLimitPx(fs));
      const mid = fs * OIBilingual.HEADING_TARGET_EM;
      return Math.min(max, Math.max(min, mid));
    },

    headingMinGapPx(fontSize) {
      const fs = OIBilingual.fontSizePx(fontSize);
      return Math.max(OIBilingual.OVERLAP_GAP_MIN, fs * OIBilingual.HEADING_HARD_MIN_EM);
    },

    opticalGapMaxPx(fontSize) {
      return OIBilingual.headingTightenPx(fontSize);
    },

    opticalGapTargetPx(fontSize) {
      return OIBilingual.headingTargetPx(fontSize);
    },

    gapClampCapPx(fontSize) {
      return OIBilingual.fontSizePx(fontSize) * OIBilingual.GAP_CLAMP_CAP_EM;
    },

    bodyPullCapPx(fontSize, el) {
      const fs = OIBilingual.fontSizePx(fontSize);
      const slack = OIBilingual.BODY_MARGIN_TOP_EM - OIBilingual.BODY_MARGIN_FLOOR_EM;
      const tighter = Math.max(
        0,
        OIBilingual.BODY_GLOSS_GAP_DEFAULT_EM - OIBilingual.readBodyGlossGapEm(el)
      );
      return Math.max(0, Math.round((slack + tighter) * fs * 100) / 100);
    },

    normalizeBodyGlossGap(value) {
      const n = parseFloat(value);
      if (!Number.isFinite(n)) return OIBilingual.BODY_GLOSS_GAP_DEFAULT_EM;
      return Math.round(
        Math.min(OIBilingual.BODY_GLOSS_GAP_MAX_EM, Math.max(OIBilingual.BODY_GLOSS_GAP_MIN_EM, n)) * 100
      ) / 100;
    },

    readBodyGlossGapEm(el) {
      const root = el?.ownerDocument?.documentElement;
      const view = el?.ownerDocument?.defaultView;
      const fromStyle = OIBilingual.readStyleVar(root, "--oi-body-gloss-gap");
      let fromComputed = "";
      try {
        fromComputed = String(view?.getComputedStyle?.(root)?.getPropertyValue?.("--oi-body-gloss-gap") || "");
      } catch {
        fromComputed = "";
      }
      return OIBilingual.normalizeBodyGlossGap(fromStyle || fromComputed);
    },

    normalizeBodyGlossStackGap(value) {
      const n = parseFloat(value);
      if (!Number.isFinite(n)) return OIBilingual.BODY_GLOSS_STACK_GAP_DEFAULT_EM;
      return Math.round(
        Math.min(OIBilingual.BODY_GLOSS_STACK_GAP_MAX_EM, Math.max(OIBilingual.BODY_GLOSS_STACK_GAP_MIN_EM, n)) * 100
      ) / 100;
    },

    readBodyGlossStackGapEm(el) {
      const root = el?.ownerDocument?.documentElement;
      const view = el?.ownerDocument?.defaultView;
      const fromStyle = OIBilingual.readStyleVar(root, "--oi-body-gloss-stack-gap");
      let fromComputed = "";
      try {
        fromComputed = String(view?.getComputedStyle?.(root)?.getPropertyValue?.("--oi-body-gloss-stack-gap") || "");
      } catch {
        fromComputed = "";
      }
      return OIBilingual.normalizeBodyGlossStackGap(fromStyle || fromComputed);
    },

    /**
     * BODY-GLOSS-STACK-GAP-VISIBLE: isolated extra after a body gloss.
     * Anvil: g = 译1底 → 下一段源顶 (empty band) = isolated margin-bottom px
     * (value × translation em). Next source margin-top is zeroed in CSS.
     * Do not max() with the host paragraph margin, and do not include the
     * intervening English paragraph height. g(1)/g(0.25) ∈ [3,5], g(2)/g(1) ∈ [1.5,2.5].
     */
    opticalBodyGlossStackGapPx(el, value) {
      const em = value == null
        ? OIBilingual.readBodyGlossStackGapEm(el)
        : OIBilingual.normalizeBodyGlossStackGap(value);
      return Math.round(em * OIBilingual.elementFontSize(el) * 100) / 100;
    },

    /** Empty band from gloss bottom to the next source top (source2 may sit between glosses). */
    opticalGlossToNextSourcePx(glossBottom, nextSourceTop) {
      const g = Number(nextSourceTop) - Number(glossBottom);
      return Number.isFinite(g) ? Math.round(g * 100) / 100 : 0;
    },

    /** Collapsed sibling margins: max(stack, next-source-top). This is the pre-fix trap. */
    collapsedBodyGlossStackGapEm(stackEm, nextSourceMarginTopEm) {
      return Math.max(Number(stackEm) || 0, Number(nextSourceMarginTopEm) || 0);
    },

    bodyStackGapDisplay(el) {
      return OIBilingual.isBodyTranslation(el) ? "flow-root" : "block";
    },

    bodyMarginTopEm(el) {
      const gap = OIBilingual.readBodyGlossGapEm(el);
      return Math.round((OIBilingual.BODY_MARGIN_TOP_EM + (gap - OIBilingual.BODY_TARGET_EM)) * 100) / 100;
    },

    bodyMarginCalc(extraPx, pullPx) {
      const extra = Math.max(0, Number(extraPx) || 0);
      const pull = Math.max(0, Number(pullPx) || 0);
      const net = extra - pull;
      const signed = net >= 0 ? `+ ${net}px` : `- ${Math.abs(net)}px`;
      const gap = OIBilingual.BODY_GLOSS_GAP_DEFAULT_EM;
      return `calc(${OIBilingual.BODY_MARGIN_TOP_EM}em + (var(--oi-body-gloss-gap, ${gap}em) - ${gap}em) ${signed})`;
    },

    needsGapClamp(gap, maxGap) {
      return Number.isFinite(Number(gap)) && Number(gap) > Number(maxGap);
    },

    nextGapPull(current, step = OIBilingual.GAP_CLAMP_STEP_PX, capPx) {
      return OIBilingual.nextOverlapExtra(current, step, capPx);
    },

    shouldClampAsHeading(translation, source) {
      return OIBilingual.preferOverlapPadding(translation) || OIBilingual.isHeadingTag(source);
    },

    shouldClampOpticalGap(translation) {
      if (!translation || translation.classList?.contains("oi-inline")) return false;
      return !OIBilingual.isSideRailTranslation(translation);
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

    shouldMatchBodyFont(translation, source) {
      if (!translation || translation.classList?.contains("oi-inline")) return false;
      if (OIBilingual.isSideRailTranslation(translation)) return false;
      return OIBilingual.shouldClampAsHeading(translation, source);
    },

    isBodyTranslation(el) {
      if (!el?.classList?.contains("oi-translation")) return false;
      if (el.classList.contains("oi-inline")) return false;
      if (el.classList.contains("oi-after-heading")) return false;
      if (el.classList.contains("oi-side-rail")) return false;
      return true;
    },

    isBodyCopyEl(el) {
      if (!el || el.classList?.contains("oi-translation")) return false;
      if (OIBilingual.isHeadingTag(el)) return false;
      return /^(P|LI|BLOCKQUOTE|FIGCAPTION|DD)$/.test(String(el.tagName || "").toUpperCase());
    },

    readFontScale(el) {
      const root = el?.ownerDocument?.documentElement;
      const view = el?.ownerDocument?.defaultView;
      const fromStyle = OIBilingual.readStyleVar(root, "--oi-font-scale");
      let fromComputed = "";
      try {
        fromComputed = String(view?.getComputedStyle?.(root)?.getPropertyValue?.("--oi-font-scale") || "");
      } catch {
        fromComputed = "";
      }
      const n = parseFloat(fromStyle || fromComputed);
      return Number.isFinite(n) && n > 0 ? n : OIBilingual.DEFAULT_FONT_SCALE;
    },

    readBodyFontVar(el) {
      const nodes = [el, el?.ownerDocument?.documentElement];
      const view = el?.ownerDocument?.defaultView;
      for (const node of nodes) {
        const fromStyle = OIBilingual.readStyleVar(node, "--oi-body-font-size");
        let fromComputed = "";
        try {
          fromComputed = String(view?.getComputedStyle?.(node)?.getPropertyValue?.("--oi-body-font-size") || "");
        } catch {
          fromComputed = "";
        }
        const n = parseFloat(fromStyle || fromComputed);
        if (Number.isFinite(n) && n > 0) return n;
      }
      return 0;
    },

    collectNearby(start) {
      const hits = [];
      for (const dir of ["nextElementSibling", "previousElementSibling"]) {
        let node = start?.[dir];
        for (let i = 0; i < 16 && node; i++) {
          hits.push(node);
          node = node[dir];
        }
      }
      return hits;
    },

    articleScope(el) {
      return el?.closest?.("article, main, [role='main'], [role='article']") || null;
    },

    nearbyBodySample(translation, source) {
      const nodes = [
        ...OIBilingual.collectNearby(source),
        ...OIBilingual.collectNearby(translation)
      ];
      const trans = nodes.find((node) => OIBilingual.isBodyTranslation(node));
      if (trans) return trans;
      const copy = nodes.find((node) => OIBilingual.isBodyCopyEl(node));
      if (copy) return copy;
      const scope = OIBilingual.articleScope(source) || OIBilingual.articleScope(translation);
      if (scope?.querySelectorAll) {
        try {
          const found = scope.querySelectorAll("p, li, blockquote, .oi-translation");
          for (const node of found) {
            if (OIBilingual.isBodyTranslation(node) || OIBilingual.isBodyCopyEl(node)) return node;
          }
        } catch {
          /* ignore */
        }
      }
      return scope;
    },

    scaledBodyFontSize(bodySourcePx, scale) {
      const fs = OIBilingual.fontSizePx(bodySourcePx);
      const s = Number(scale);
      const used = Number.isFinite(s) && s > 0 ? s : OIBilingual.DEFAULT_FONT_SCALE;
      return Math.round(fs * used * 100) / 100;
    },

    headingBodyFontRatio(headingFs, bodyFs) {
      const heading = Number(headingFs);
      const body = Number(bodyFs);
      if (!(heading > 0) || !(body > 0)) return Infinity;
      return heading / body;
    },

    /**
     * §8: heading .oi-after-heading size must stay within ±5% of main-column
     * body .oi-translation (or article p × --oi-font-scale).
     */
    withinHeadingBodyFontBand(headingFs, bodyFs, slack) {
      const ratio = OIBilingual.headingBodyFontRatio(headingFs, bodyFs);
      const band = Number.isFinite(Number(slack)) ? Number(slack) : OIBilingual.HEADING_BODY_FONT_SLACK;
      return Number.isFinite(ratio) && ratio >= 1 - band && ratio <= 1 + band;
    },

    resolveBodySourceFontSize(translation, source, opts = {}) {
      if (Number(opts.bodySourcePx) > 0) return OIBilingual.fontSizePx(opts.bodySourcePx);
      if (Number(opts.fontSize) > 0) {
        return Math.round(OIBilingual.fontSizePx(opts.fontSize) / OIBilingual.readFontScale(translation) * 100) / 100;
      }
      const sample = OIBilingual.nearbyBodySample(translation, source);
      if (sample && OIBilingual.isBodyTranslation(sample)) {
        const scaled = OIBilingual.elementFontSize(sample);
        const scale = OIBilingual.readFontScale(translation);
        return Math.round(scaled / scale * 100) / 100;
      }
      if (sample && (OIBilingual.isBodyCopyEl(sample) || sample === OIBilingual.articleScope(source) || sample === OIBilingual.articleScope(translation))) {
        const fs = OIBilingual.elementFontSize(sample);
        if (fs > 0) return fs;
      }
      const fromVar = OIBilingual.readBodyFontVar(translation);
      if (fromVar > 0) return fromVar;
      return 0;
    },

    resolveBodyTranslationFontSize(translation, source, opts = {}) {
      if (Number(opts.fontSize) > 0) return OIBilingual.fontSizePx(opts.fontSize);
      const bodySource = OIBilingual.resolveBodySourceFontSize(translation, source, opts);
      if (!(bodySource > 0)) return 0;
      return OIBilingual.scaledBodyFontSize(bodySource, OIBilingual.readFontScale(translation));
    },

    applyHeadingBodyFontSize(translation, source, opts = {}) {
      if (!OIBilingual.shouldMatchBodyFont(translation, source)) return 0;
      if (!translation?.style) return 0;
      if (Number(opts.fontSize) > 0) {
        const scaled = OIBilingual.fontSizePx(opts.fontSize);
        const bodySource = OIBilingual.resolveBodySourceFontSize(translation, source, opts);
        if (bodySource > 0) {
          translation.style.setProperty?.("--oi-body-font-size", `${Math.round(bodySource * 100) / 100}px`);
        }
        translation.style.setProperty?.("--oi-body-gloss-size", `${scaled}px`);
        translation.style.fontSize = `${scaled}px`;
        if ("__fontSize" in translation) translation.__fontSize = scaled;
        return scaled;
      }
      const bodySource = OIBilingual.resolveBodySourceFontSize(translation, source, opts);
      if (!(bodySource > 0)) return 0;
      const scaled = OIBilingual.scaledBodyFontSize(bodySource, OIBilingual.readFontScale(translation));
      if (!(scaled > 0)) return 0;
      translation.style.setProperty?.("--oi-body-font-size", `${Math.round(bodySource * 100) / 100}px`);
      translation.style.setProperty?.("--oi-body-gloss-size", `${scaled}px`);
      translation.style.fontSize = `${scaled}px`;
      if ("__fontSize" in translation) translation.__fontSize = scaled;
      return scaled;
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
      translation.style.display = OIBilingual.bodyStackGapDisplay(translation);
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
        OIBilingual.forceSideRailFlexStack(source);
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

    forceSideRailFlexStack(node) {
      if (!node?.style || !OIBilingual.isHorizontalFlex(node)) return false;
      node.classList?.add?.("oi-side-rail-host");
      node.style.flexWrap = "wrap";
      node.style.flexDirection = "column";
      node.style.alignItems = "stretch";
      node.style.setProperty?.("flex-wrap", "wrap", "important");
      node.style.setProperty?.("flex-direction", "column", "important");
      node.style.setProperty?.("align-items", "stretch", "important");
      return true;
    },

    unlockSideRailHost(source) {
      if (!source) return null;
      let node = source;
      let unlocked = null;
      for (let i = 0; i < 8 && node; i++) {
        const tag = String(node.tagName || "").toUpperCase();
        if (["UL", "OL", "NAV", "ASIDE", "MAIN", "BODY", "HTML"].includes(tag)) break;
        OIBilingual.forceSideRailFlexStack(node);
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

    stackSideRailHosts(source, translation) {
      OIBilingual.unlockSideRailHost(translation?.parentElement || source);
      if (source && source !== translation?.parentElement) OIBilingual.unlockSideRailHost(source);
      return translation;
    },

    isSideRailColumnStop(el) {
      const tag = String(el?.tagName || "").toUpperCase();
      return ["UL", "OL", "NAV", "ASIDE", "MAIN", "BODY", "HTML"].includes(tag);
    },

    looksLikeTitleContainer(el) {
      const cls = typeof el?.className === "string" ? el.className : String(el?.className?.baseVal || "");
      return /title-container|nav-title|nav-link-text|label-container|sidebar-label/i.test(cls);
    },

    /** Label column content box (~180px), not shrink-wrapped English ink. */
    sideRailLabelColumnWidth(source, translation) {
      let node = translation?.parentElement || source;
      let named = 0;
      let columnW = 0;
      while (node && !OIBilingual.isSideRailColumnStop(node)) {
        const w = OIBilingual.elementBoxWidth(node);
        if (OIBilingual.looksLikeTitleContainer(node) && w >= 120 && w <= 360) {
          named = w;
          break;
        }
        if (w >= 160 && w <= 320 && w > columnW) columnW = w;
        node = node.parentElement;
      }
      if (named) return named;
      if (columnW) return columnW;
      return (
        OIBilingual.immediateParentWidth(source) ||
        OIBilingual.elementBoxWidth(translation?.parentElement) ||
        OIBilingual.sourceContentWidth(source)
      );
    },

    applySideRailColumnWidth(translation, columnW) {
      if (!translation?.style || !(columnW > 0)) return 0;
      const px = `${Math.round(columnW * 100) / 100}px`;
      translation.style.display = "block";
      translation.style.boxSizing = "border-box";
      translation.style.width = px;
      translation.style.minWidth = px;
      translation.style.maxWidth = px;
      translation.style.flexBasis = "100%";
      translation.style.flexGrow = "1";
      translation.style.flexShrink = "0";
      translation.style.alignSelf = "stretch";
      translation.style.overflowWrap = "break-word";
      return columnW;
    },

    applySideRailLayout(translation, source) {
      OIBilingual.nestSideRailInLabel(source, translation);
      OIBilingual.stackSideRailHosts(source, translation);
      OIBilingual.applyFlexBreakStyles(translation, { fill: true });
      const columnW = OIBilingual.sideRailLabelColumnWidth(source, translation);
      OIBilingual.applySideRailColumnWidth(translation, columnW);
      const host = translation.parentElement;
      if (host?.style && !OIBilingual.isSideRailColumnStop(host)) {
        host.style.width = "100%";
        host.style.minWidth = "100%";
        host.style.flexGrow = "1";
        host.style.alignSelf = "stretch";
      }
      OIBilingual.unlockSideRailHost(source);
      return { width: columnW, offset: 0, useColumn: true };
    },

    sideRailRow(source) {
      let node = source;
      for (let i = 0; i < 8 && node; i++) {
        const tag = String(node.tagName || "").toUpperCase();
        if (["LI", "BUTTON"].includes(tag) || node.getAttribute?.("role") === "combobox") return node;
        if (["MAIN", "BODY", "HTML"].includes(tag)) break;
        node = node.parentElement;
      }
      return source;
    },

    nextSideRailRow(source) {
      const row = OIBilingual.sideRailRow(source);
      let next = row?.nextElementSibling;
      while (next?.classList?.contains("oi-translation")) next = next.nextElementSibling;
      return next || null;
    },

    sharesYBand(a, b, slop = 1) {
      const ra = a?.getBoundingClientRect?.();
      const rb = b?.getBoundingClientRect?.();
      if (!ra || !rb) return false;
      return Number(ra.bottom) > Number(rb.top) + slop && Number(ra.top) < Number(rb.bottom) - slop;
    },

    applyNextRowGap(row, extraPx) {
      if (!row?.style) return extraPx;
      const extra = Math.max(0, Number(extraPx) || 0);
      row.style.marginBottom = extra ? `${extra}px` : "";
      return extra;
    },

    /** If side-rail translation ink hits the next label, grow the row gap so the next top moves down. */
    clearNextRowOverlap(translation, source, opts = {}) {
      if (!translation || !OIBilingual.isSideRailTranslation(translation)) return 0;
      const next = opts.next || OIBilingual.nextSideRailRow(source);
      if (!next?.getBoundingClientRect || !translation.getBoundingClientRect) return 0;
      const minGap = opts.minGap ?? OIBilingual.OVERLAP_GAP_MIN;
      const cap = opts.capPx ?? OIBilingual.SIDE_RAIL_NEXT_GAP_CAP_PX;
      const row = OIBilingual.sideRailRow(source);
      OIBilingual.applyNextRowGap(row, 0);
      const tr = translation.getBoundingClientRect();
      const nr = next.getBoundingClientRect();
      const need = Number(tr.bottom) + minGap - Number(nr.top);
      if (!Number.isFinite(need) || need <= 0) return 0;
      return OIBilingual.applyNextRowGap(row, Math.min(need, cap));
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
        translation.style.paddingTop = `calc(${OIBilingual.HEADING_PAD_TOP_EM}em + ${extra}px)`;
        translation.style.marginTop = "";
      } else {
        const pull = parseFloat(OIBilingual.readStyleVar(translation, "--oi-gap-pull")) || 0;
        translation.style.marginTop = OIBilingual.bodyMarginCalc(extra, pull);
      }
      return extra;
    },

    readStyleVar(el, name) {
      if (!el?.style) return "";
      if (el.style.props && el.style.props[name] != null) return String(el.style.props[name]);
      try {
        return String(el.style.getPropertyValue?.(name) || "");
      } catch {
        return "";
      }
    },

    applyGapPull(translation, pullPx) {
      const pull = Math.max(0, Number(pullPx) || 0);
      if (!translation?.style) return pull;
      translation.style.setProperty?.("--oi-gap-pull", `${pull}px`);
      translation.style.setProperty?.("--oi-gap-adjust", `${-pull}px`);
      if (pull <= 0) {
        if (OIBilingual.preferOverlapPadding(translation)) {
          const mt = String(translation.style.marginTop || "");
          if (/em\s+-\s+\d/.test(mt)) translation.style.marginTop = "";
        }
        return 0;
      }
      if (OIBilingual.preferOverlapPadding(translation)) {
        translation.style.marginTop = `calc(${OIBilingual.HEADING_MARGIN_TOP_EM}em - ${pull}px)`;
        return pull;
      }
      const extra = parseFloat(OIBilingual.readStyleVar(translation, "--oi-overlap-extra")) || 0;
      translation.style.marginTop = OIBilingual.bodyMarginCalc(extra, pull);
      return pull;
    },

    applyHeadingPad(translation, extraPx, reducePx) {
      if (!translation?.style) return 0;
      const extra = Math.max(0, Number(extraPx) || 0);
      const reduce = Math.max(0, Number(reducePx) || 0);
      const net = extra - reduce;
      const signed = net >= 0 ? `+ ${net}` : `- ${Math.abs(net)}`;
      translation.style.paddingTop = `calc(${OIBilingual.HEADING_PAD_TOP_EM}em ${signed}px)`;
      return reduce;
    },

    /**
     * BODY-BILINGUAL-GAP: measure source-bottom → translation-top in source em.
     * Headings: §7 target 0.12–0.28em, must tighten if > 0.32em or > 10px; keep descender clearance.
     * Body: default 0.35em via −0.65em and --oi-body-gloss-gap; extra pull stays within −0.8em.
     */
    clampOversizedGap(translation, source, opts = {}) {
      if (!translation || !source?.getBoundingClientRect) return 0;
      if (!OIBilingual.shouldClampOpticalGap(translation, source)) return 0;
      const heading = opts.heading ?? OIBilingual.shouldClampAsHeading(translation, source);
      const sourceFs = opts.sourceFs ?? OIBilingual.elementFontSize(source);
      const transFs = OIBilingual.elementFontSize(translation);
      const bodyGapEm = heading ? 0 : OIBilingual.readBodyGlossGapEm(translation);
      const bodySlack = OIBilingual.BODY_TARGET_MAX_EM - OIBilingual.BODY_TARGET_EM;
      const maxGap = opts.maxGap ?? (heading
        ? OIBilingual.headingTightenPx(sourceFs)
        : sourceFs * (bodyGapEm + bodySlack));
      const target = opts.targetGap ?? (heading
        ? OIBilingual.headingTargetPx(sourceFs)
        : sourceFs * bodyGapEm);
      const step = opts.step ?? OIBilingual.GAP_CLAMP_STEP_PX;
      const cap = opts.capPx ?? (heading
        ? OIBilingual.gapClampCapPx(sourceFs)
        : OIBilingual.bodyPullCapPx(transFs, translation));
      let pull = 0;
      OIBilingual.applyGapPull(translation, 0);
      const maxSteps = Math.ceil((cap || 1) / Math.max(1, step)) + 2;
      for (let i = 0; i < maxSteps; i++) {
        const gap = OIBilingual.verticalGap(source.getBoundingClientRect(), translation.getBoundingClientRect());
        if (!OIBilingual.needsGapClamp(gap, maxGap)) break;
        if (pull >= cap) break;
        pull = Math.min(cap, pull + Math.max(step, Number(gap) - target));
        OIBilingual.applyGapPull(translation, pull);
      }
      const overlapExtra = parseFloat(OIBilingual.readStyleVar(translation, "--oi-overlap-extra")) || 0;
      if (heading && overlapExtra <= 0) {
        const gap = OIBilingual.verticalGap(source.getBoundingClientRect(), translation.getBoundingClientRect());
        if (OIBilingual.needsGapClamp(gap, maxGap)) {
          const room = Math.max(0, (OIBilingual.HEADING_PAD_TOP_EM - OIBilingual.HEADING_PAD_MIN_EM) * transFs);
          const reduce = Math.min(room, Math.max(0, Number(gap) - target));
          if (reduce > 0) OIBilingual.applyHeadingPad(translation, 0, reduce);
        }
      }
      return pull;
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
      if (!translation) return { extra: 0, pull: 0, width: 0, offset: 0 };
      const host = source || OIBilingual.hostForTranslation(translation);
      OIBilingual.bindHost(translation, host);
      const keep = OIBilingual.dedupeTranslations(host) || translation;
      OIBilingual.breakFlexRow(host, keep);
      const laid = OIBilingual.applyLayout(keep, host);
      const fontSize = keep.classList?.contains("oi-inline")
        ? 0
        : OIBilingual.applyHeadingBodyFontSize(keep, host);
      const heading = OIBilingual.shouldClampAsHeading(keep, host);
      const sourceFs = OIBilingual.elementFontSize(host);
      const extra = keep.classList?.contains("oi-inline")
        ? 0
        : OIBilingual.clearTranslationOverlap(keep, host, {
          minGap: heading ? OIBilingual.headingMinGapPx(sourceFs) : OIBilingual.OVERLAP_GAP_MIN
        });
      const pull = keep.classList?.contains("oi-inline")
        ? 0
        : OIBilingual.clampOversizedGap(keep, host, { heading, sourceFs });
      const nextExtra = keep.classList?.contains("oi-inline") ? 0 : OIBilingual.clearNextRowOverlap(keep, host);
      return {
        extra,
        pull,
        nextExtra,
        width: laid.width,
        offset: laid.offset,
        useColumn: laid.useColumn,
        stacked: !OIBilingual.sharesFlexRow(host, keep),
        fontSize: fontSize || OIBilingual.elementFontSize(keep)
      };
    }
  };

  root.OIBilingual = OIBilingual;
})(typeof globalThis !== "undefined" ? globalThis : this);
