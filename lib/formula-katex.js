/**
 * KaTeX gate for the formula chain.
 * throwOnError and trust:false. Untrusted commands (\href, \url, \htmlClass, …)
 * do not throw in KaTeX 0.18; they are painted in errorColor. That is not
 * renderable. This module never writes an HTML string onto the node.
 */

export const KATEX_RENDER_OPTIONS = Object.freeze({
  throwOnError: true,
  trust: false,
  strict: "ignore",
  errorColor: "#e10091",
  output: "html"
});

export function resolveKatex(katex) {
  if (katex?.renderToString) return katex;
  if (globalThis.katex?.renderToString) return globalThis.katex;
  return null;
}

export function canRenderLatex(latex, display = false, katex) {
  const engine = resolveKatex(katex);
  if (!engine) return { pass: false, error: "katex-missing" };
  try {
    const html = engine.renderToString(String(latex ?? ""), {
      ...KATEX_RENDER_OPTIONS,
      displayMode: Boolean(display)
    });
    if (String(html || "").includes(KATEX_RENDER_OPTIONS.errorColor)) {
      return { pass: false, error: "untrusted command" };
    }
    return { pass: true, error: null };
  } catch (err) {
    return { pass: false, error: String(err?.message || err) };
  }
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

/** HTML string from the same options. Empty when the formula cannot render. */
export function renderLatexMarkup(latex, display = false, katex) {
  const verdict = canRenderLatex(latex, display, katex);
  if (!verdict.pass) return "";
  const engine = resolveKatex(katex);
  return engine.renderToString(String(latex ?? ""), {
    ...KATEX_RENDER_OPTIONS,
    displayMode: Boolean(display)
  });
}
