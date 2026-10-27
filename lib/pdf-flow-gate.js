/**
 * Compare a LaTeX body with the blocks we would translate.
 * Coverage is fuzzy token overlap. An inversion is a later source paragraph
 * landing on an earlier block. A break is a body block that still ends mid-sentence.
 */

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was"]);

export function normalizeFlowText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\\[a-z]+(\[[^\]]*\])?(\{[^{}]*\})?/gi, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(text) {
  return normalizeFlowText(text).split(" ").filter((token) => token.length > 2 && !STOP.has(token));
}

function overlap(left, right) {
  const a = tokens(left);
  const b = new Set(tokens(right));
  if (!a.length || !b.size) return 0;
  let hit = 0;
  for (const token of a) if (b.has(token)) hit += 1;
  return hit / a.length;
}

export function latexParagraphs(source) {
  let text = String(source || "").replace(/(^|[^\\])%.*$/gm, "$1");
  const begin = text.search(/\\begin\{document\}/);
  if (begin >= 0) text = text.slice(begin);
  text = text
    .replace(/\\begin\{(?:figure|table|equation|align|eqnarray)\*?\}[\s\S]*?\\end\{(?:figure|table|equation|align|eqnarray)\*?\}/g, "\n")
    .replace(/\\(?:cite|ref|label|eqref|footnote)\{[^{}]*\}/g, " ")
    .replace(/\\(?:textbf|textit|emph|textrm)\{([^{}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, " ");
  return text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => tokens(part).length >= 8);
}

export function paragraphsOnBlocks(paragraphs, blocks) {
  const body = (blocks || []).map((block) => (
    typeof block === "string" ? block : String(block?.text || block?.sourceText || "")
  ));
  return (paragraphs || []).filter((part) => body.some((text) => overlap(part, text) >= 0.45));
}

export function alignBodyFlow(paragraphs, blocks) {
  const paras = (paragraphs || []).filter((part) => tokens(part).length >= 8);
  const body = (blocks || []).map((block) => (
    typeof block === "string" ? block : String(block?.text || block?.sourceText || "")
  )).filter((text) => tokens(text).length >= 4);
  const used = new Set();
  const order = [];
  for (const para of paras) {
    let best = -1;
    let bestScore = 0.45;
    body.forEach((text, index) => {
      if (used.has(index)) return;
      const score = overlap(para, text);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    });
    if (best >= 0) {
      used.add(best);
      order.push(best);
    }
  }
  let inversions = 0;
  for (let i = 0; i < order.length; i += 1) {
    for (let j = i + 1; j < order.length; j += 1) {
      if (order[i] > order[j]) inversions += 1;
    }
  }
  let breaks = 0;
  let fakeHeadings = 0;
  const raw = blocks || [];
  for (let i = 1; i < raw.length; i += 1) {
    const prev = raw[i - 1];
    const next = raw[i];
    const label = String(prev?.label || "");
    if (label === "aside" || label === "footnote" || label === "header" || label === "footer") continue;
    const a = String(prev?.text || prev || "").trim();
    const b = String(next?.text || next || "").trim();
    if (!a || !b) continue;
    if (label === "heading" && /^[a-z(]/.test(b) && !/[.!?]$/.test(a)) fakeHeadings += 1;
    else if (!/[.!?:"”]$/.test(a) && /^[a-z]/.test(b)) breaks += 1;
  }
  return {
    coverage: paras.length ? order.length / paras.length : 1,
    blockCoverage: body.length ? used.size / body.length : 1,
    inversions,
    breaks,
    fakeHeadings,
    matched: order.length,
    total: paras.length,
    blocks: body.length
  };
}
