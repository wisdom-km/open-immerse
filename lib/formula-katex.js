/**
 * KaTeX gate for the formula chain.
 * throwOnError and trust:false. Untrusted commands (\href, \url, \htmlClass, …)
 * do not throw in KaTeX 0.18; they are painted in errorColor. That is not
 * renderable. This module never writes an HTML string onto the node.
 * Do not add a markup string for the viewer to assign onto a node.
 *
 * maxSize is in em. KaTeX's default is Infinity, so a formula that passes
 * the check can still paint \hspace{100000em}. 20em caps one user size
 * (about 7cm) and still leaves ordinary \hspace / \kern alone.
 * maxExpand matches KaTeX's own default of 1000 and is set here so a
 * macro loop stops instead of inheriting Infinity.
 */

/**
 * One formula, in characters, after the caller prepares it.
 * canRenderLatex and the alignment render both refuse a longer string
 * before KaTeX parses it. The chain then continues; alignment marks it unmatched.
 */
export const MAX_FORMULA_LATEX_CHARS = 8000;

const renderChecks = new Map();

export const KATEX_RENDER_OPTIONS = Object.freeze({
  throwOnError: true,
  trust: false,
  strict: "ignore",
  errorColor: "#e10091",
  output: "html",
  maxSize: 20,
  maxExpand: 1000
});

export function resolveKatex(katex) {
  if (katex?.renderToString) return katex;
  if (globalThis.katex?.renderToString) return globalThis.katex;
  return null;
}

export function canRenderLatex(latex, display = false, katex) {
  const src = String(latex ?? "");
  if (src.length > MAX_FORMULA_LATEX_CHARS) return { pass: false, error: "latex-too-long" };
  const engine = resolveKatex(katex);
  if (!engine) return { pass: false, error: "katex-missing" };
  const key = `${display ? "1" : "0"}:${src}`;
  const cached = renderChecks.get(key);
  if (cached) return cached;
  let result;
  try {
    const html = engine.renderToString(src, {
      ...KATEX_RENDER_OPTIONS,
      displayMode: Boolean(display)
    });
    if (String(html || "").includes(KATEX_RENDER_OPTIONS.errorColor)) {
      result = { pass: false, error: "untrusted command" };
    } else {
      result = { pass: true, error: null };
    }
  } catch (err) {
    result = { pass: false, error: String(err?.message || err) };
  }
  if (renderChecks.size > 256) renderChecks.clear();
  renderChecks.set(key, result);
  return result;
}

function clearNode(node) {
  if (!node) return;
  if (typeof node.replaceChildren === "function") {
    node.replaceChildren();
    return;
  }
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Clear the node, then let katex.render build the DOM. */
export function renderLatexInto(node, latex, display = false, katex) {
  const engine = resolveKatex(katex);
  if (!engine?.render) throw new Error("katex-missing");
  clearNode(node);
  engine.render(String(latex ?? ""), node, {
    ...KATEX_RENDER_OPTIONS,
    displayMode: Boolean(display)
  });
  return node;
}
