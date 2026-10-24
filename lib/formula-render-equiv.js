/**
 * Acceptance metric for formula / multimodal evals.
 * Two strings match when their KaTeX MathML is the same after the rewrites
 * below. Exact string match is not the primary metric.
 *
 * Rewrites before render: \bm / \boldsymbol → \mathbf, \tfrac / \dfrac → \frac,
 * \coloneqq → :=, \mathrm → \text, \text{ln} → \ln, \lVert → \|, \Bbb → \mathbb,
 * {u^*}^T → u^{*T}, drop \hspace.
 * MathML then drops annotation, mrow, mspace, attributes, and a trailing
 * sentence period. \mathrm and \text become the same element. Bold and
 * bold-italic differ only by an attribute, so stripping attributes equates them.
 */

import { KATEX_RENDER_OPTIONS, resolveKatex } from "./formula-katex.js";

export function prepareRenderLatex(latex) {
  let text = String(latex ?? "");
  text = text.replace(/\\boldsymbol/g, "\\mathbf");
  text = text.replace(/\\bm(?![a-zA-Z])/g, "\\mathbf");
  text = text.replace(/\\tfrac/g, "\\frac");
  text = text.replace(/\\dfrac/g, "\\frac");
  text = text.replace(/\\coloneqq/g, ":=");
  text = text.replace(/\\mathrm(?![a-zA-Z])/g, "\\text");
  text = text.replace(/\\text\{ln\}/g, "\\ln");
  text = text.replace(/\\lVert/g, "\\|");
  text = text.replace(/\\Bbb/g, "\\mathbb");
  text = text.replace(/\{([A-Za-z])\^(?:\{\*\}|\*)\}\^(?:\{T\}|T)/g, "$1^{*T}");
  text = text.replace(/\\hspace\*?\{[^}]*\}/g, "");
  return text;
}

/** MathML with the parts that do not change the painted formula removed. */
export function normalizeMathMl(xml) {
  let text = String(xml || "");
  text = text.replace(/<annotation\b[\s\S]*?<\/annotation>/g, "");
  text = text.replace(/<\/?mrow>/g, "");
  text = text.replace(/<mspace\b[^>]*\/>/g, "");
  text = text.replace(/<mspace\b[^>]*>[\s\S]*?<\/mspace>/g, "");
  text = text.replace(/<([A-Za-z][\w:-]*)(?:\s[^>]*)?>/g, "<$1>");
  text = text.replace(/<\/?mtext>/g, (tag) => tag.replace("mtext", "mi"));
  text = text.replace(/(?:<mo>\.<\/mo>)+$/g, "");
  text = text.replace(/\s+/g, "");
  return text;
}

export function renderMathMl(latex, display = false, katex) {
  const engine = resolveKatex(katex);
  if (!engine?.renderToString) return null;
  try {
    const xml = engine.renderToString(prepareRenderLatex(latex), {
      ...KATEX_RENDER_OPTIONS,
      displayMode: Boolean(display),
      output: "mathml"
    });
    if (String(xml || "").includes(KATEX_RENDER_OPTIONS.errorColor)) return null;
    const normalized = normalizeMathMl(xml);
    return normalized || null;
  } catch {
    return null;
  }
}

/**
 * True when both sides render and the MathML matches.
 * A side that does not render is not equivalent.
 */
export function renderEquivalent(left, right, { display = false, katex } = {}) {
  const a = renderMathMl(left, display, katex);
  const b = renderMathMl(right, display, katex);
  if (!a || !b) return false;
  return a === b;
}
