/**
 * Ask AI answer HTML. The renderer is shared with notes: see markdown-render.js.
 * These names stay exported so existing callers and tests do not move.
 */

export {
  ASK_KATEX_OPTIONS,
  ASK_MATH_MAX_FORMULAS,
  ASK_MATH_MAX_TEX,
  escapeAskText,
  katexHtmlIsSafe,
  markdownItSetup,
  renderAskAnswer,
  renderMarkdown,
  sanitizeMarkdownHtml,
  texIsDisplayable
} from "./markdown-render.js";
