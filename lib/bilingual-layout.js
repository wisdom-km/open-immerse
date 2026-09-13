(function (root) {
  const OIBilingual = {
    OVERLAP_GAP_MIN: 2,
    OVERLAP_STEP_PX: 3,
    OVERLAP_EXTRA_CAP_EM: 1.2,
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

    sourceContentWidth(source) {
      if (!source?.getBoundingClientRect) return 0;
      const width = Number(source.getBoundingClientRect()?.width) || 0;
      return width > 0 ? width : 0;
    },

    hostForTranslation(node) {
      if (!node) return null;
      const parent = node.parentElement;
      const prev = node.previousElementSibling;
      if (parent && ["LI", "TD", "TH", "DT", "DD"].includes(parent.tagName) && node.parentElement === parent) {
        if (prev && /^(P|H[1-6]|BLOCKQUOTE|FIGCAPTION)$/.test(prev.tagName)) return prev;
        return parent;
      }
      if (prev && !prev.classList?.contains("oi-translation")) return prev;
      return parent || null;
    },

    clampTranslationWidth(translation, source) {
      if (!translation || translation.classList?.contains("oi-inline")) return 0;
      if (translation.style) translation.style.boxSizing = "border-box";
      const width = OIBilingual.sourceContentWidth(source);
      if (width > 0 && translation.style) translation.style.maxWidth = `${width}px`;
      return width;
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
      const keep = OIBilingual.dedupeTranslations(source) || translation;
      const width = OIBilingual.clampTranslationWidth(keep, source);
      const extra = keep.classList?.contains("oi-inline") ? 0 : OIBilingual.clearTranslationOverlap(keep, source);
      return { extra, width };
    }
  };

  root.OIBilingual = OIBilingual;
})(typeof globalThis !== "undefined" ? globalThis : this);
