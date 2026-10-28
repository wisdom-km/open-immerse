/**
 * Monotonic alignment of a LaTeX body to the blocks we would translate.
 * The source window is the contiguous run of paragraphs that actually sit on
 * the pages being scored. One block may cover several of those paragraphs.
 * Macros and notes stay out of the denominator. Absent paragraphs are the
 * body text whose words are not on these pages.
 * An inversion is a block whose best source paragraph goes backwards.
 * A break is a body block that still ends mid-sentence.
 * Each example is tagged real or noise.
 */

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "are", "was"]);
const MATCH = 0.5;

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

function overlapTokens(left, right) {
  if (!left.length || !right.size) return 0;
  let hit = 0;
  for (const token of left) if (right.has(token)) hit += 1;
  return hit / left.length;
}

/** Fraction of the block that this paragraph explains. A short later paragraph must not win just because the block contains it. */
function blockCoveredBy(blockTokens, paraSet) {
  if (!blockTokens.length || !paraSet.size) return 0;
  let hit = 0;
  for (const token of blockTokens) if (paraSet.has(token)) hit += 1;
  return hit / blockTokens.length;
}

export function snippet(text, limit = 110) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function dropBraced(text, name) {
  const re = new RegExp(`\\\\${name}\\s*\\{`, "g");
  let out = "";
  let cursor = 0;
  while (cursor < text.length) {
    re.lastIndex = cursor;
    const match = re.exec(text);
    if (!match) {
      out += text.slice(cursor);
      break;
    }
    out += text.slice(cursor, match.index);
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < text.length && depth > 0) {
      const char = text[index];
      const escaped = text[index - 1] === "\\";
      if (char === "{" && !escaped) depth += 1;
      else if (char === "}" && !escaped) depth -= 1;
      index += 1;
    }
    cursor = index;
  }
  return out;
}

export function latexParagraphs(source) {
  let text = String(source || "").replace(/(^|[^\\])%.*$/gm, "$1");
  const begin = text.search(/\\begin\{document\}/);
  if (begin >= 0) text = text.slice(begin);
  text = text
    .replace(/\\(?:begin|end)\{document\}/g, " ")
    .replace(/\\begin\{(?:figure|table|equation|align|eqnarray|algorithm|algorithmic)\*?\}[\s\S]*?\\end\{(?:figure|table|equation|align|eqnarray|algorithm|algorithmic)\*?\}/g, "\n");
  text = dropBraced(text, "footnotetext");
  text = dropBraced(text, "footnote");
  text = text
    .replace(/\\(?:cite|ref|label|eqref)\{[^{}]*\}/g, " ")
    .replace(/\\(?:textbf|textit|emph|textrm)\{([^{}]*)\}/g, "$1")
    .replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, " ");
  return text
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter((part) => tokens(part).length >= 8);
}

function blockText(block) {
  return typeof block === "string" ? block : String(block?.text || block?.sourceText || "");
}

/**
 * Smallest paragraph span that holds the high-confidence hits.
 * An isolated hit far from the cluster is a later section leaking into the
 * score, not part of the pages we read.
 */
export function sourceWindow(hitIndexes) {
  const hits = [...new Set(hitIndexes.filter((index) => index >= 0))].sort((a, b) => a - b);
  if (!hits.length) return null;
  const clusters = [];
  let current = [hits[0]];
  for (let index = 1; index < hits.length; index += 1) {
    if (hits[index] - current.at(-1) > 8) {
      clusters.push(current);
      current = [];
    }
    current.push(hits[index]);
  }
  clusters.push(current);
  clusters.sort((a, b) => b.length - a.length);
  const best = clusters[0];
  return { start: best[0], end: best.at(-1) };
}

function monotonicMatches(paraTokens, blockTokens) {
  const n = paraTokens.length;
  const m = blockTokens.length;
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(-1e9));
  const choice = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  dp[0][0] = 0;
  for (let i = 0; i <= n; i += 1) {
    for (let j = 0; j <= m; j += 1) {
      if (i === 0 && j === 0) continue;
      let best = -1e9;
      let how = 0;
      if (i > 0 && dp[i - 1][j] > best) {
        best = dp[i - 1][j];
        how = 1;
      }
      if (j > 0 && dp[i][j - 1] > best) {
        best = dp[i][j - 1];
        how = 2;
      }
      if (i > 0 && j > 0) {
        const score = overlapTokens(paraTokens[i - 1], blockTokens[j - 1]);
        if (score >= MATCH && dp[i - 1][j - 1] + score >= best) {
          best = dp[i - 1][j - 1] + score;
          how = 3;
        }
      }
      dp[i][j] = best;
      choice[i][j] = how;
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const how = choice[i][j];
    if (how === 3) {
      pairs.push({
        para: i - 1,
        block: j - 1,
        score: overlapTokens(paraTokens[i - 1], blockTokens[j - 1])
      });
      i -= 1;
      j -= 1;
    } else if (how === 1) i -= 1;
    else if (how === 2) j -= 1;
    else break;
  }
  pairs.reverse();
  return pairs;
}

function sentenceBreaks(blocks, anchorOf) {
  const examples = [];
  let real = 0;
  let noise = 0;
  const raw = blocks || [];
  for (let index = 1; index < raw.length; index += 1) {
    const prev = raw[index - 1];
    const next = raw[index];
    const label = String(prev?.label || "");
    if (label === "aside" || label === "footnote" || label === "header" || label === "footer") continue;
    if (label === "heading" || label === "title" || label === "caption") continue;
    const left = blockText(prev).trim();
    const right = blockText(next).trim();
    if (!left || !right) continue;
    if (/[.!?:"”]$/.test(left) || !/^[a-z(]/.test(right)) continue;
    const prevAt = anchorOf(index - 1);
    const nextAt = anchorOf(index);
    const sameOrBack = prevAt >= 0 && nextAt >= 0 && nextAt <= prevAt;
    const kind = sameOrBack ? "real" : "noise";
    if (kind === "real") real += 1;
    else noise += 1;
    if (examples.filter((entry) => entry.kind === "real").length < 10 || examples.length < 10) {
      examples.push({
        kind,
        left: snippet(left),
        right: snippet(right),
        source: prevAt,
        nextSource: nextAt
      });
    }
  }
  return { real, noise, examples: examples.slice(0, 10) };
}

export function alignBodyFlow(paragraphs, blocks) {
  const paras = (paragraphs || []).filter((part) => tokens(part).length >= 8);
  const raw = blocks || [];
  const bodyIndex = [];
  const body = [];
  raw.forEach((block, index) => {
    const text = blockText(block);
    if (tokens(text).length < 4) return;
    bodyIndex.push(index);
    body.push(text);
  });
  const paraTokens = paras.map((part) => tokens(part));
  const paraSets = paraTokens.map((list) => new Set(list));
  const blockTokenList = body.map((text) => tokens(text));
  const blockTokens = blockTokenList.map((list) => new Set(list));
  const best = body.map(() => ({ para: -1, score: 0 }));
  const hitIndexes = [];
  paraTokens.forEach((tokensOfPara, paraIndex) => {
    let top = 0;
    blockTokens.forEach((tokensOfBlock, blockIndex) => {
      const score = overlapTokens(tokensOfPara, tokensOfBlock);
      if (score > top) top = score;
      const owned = blockCoveredBy(blockTokenList[blockIndex], paraSets[paraIndex]);
      if (owned > best[blockIndex].score) best[blockIndex] = { para: paraIndex, score: owned };
    });
    if (top >= MATCH) hitIndexes.push(paraIndex);
  });
  const window = sourceWindow(hitIndexes);
  const start = window ? window.start : 0;
  const end = window ? window.end : -1;
  const inWindow = (index) => window && index >= start && index <= end;
  const windowParas = window ? paraTokens.slice(start, end + 1) : [];
  const pairs = window
    ? monotonicMatches(windowParas, blockTokens).map((pair) => ({
      ...pair,
      para: pair.para + start
    }))
    : [];
  const matchedParas = new Set(pairs.map((pair) => pair.para));
  const matchedBlocks = new Set(pairs.map((pair) => pair.block));
  const anchorByBody = new Map(pairs.map((pair) => [pair.block, pair.para]));
  const anchorOf = (rawIndex) => {
    const bodyAt = bodyIndex.indexOf(rawIndex);
    if (bodyAt < 0) return -1;
    if (anchorByBody.has(bodyAt)) return anchorByBody.get(bodyAt);
    const hit = best[bodyAt];
    return inWindow(hit.para) && hit.score >= MATCH ? hit.para : -1;
  };

  const inversionExamples = [];
  let realInversions = 0;
  let noiseInversions = 0;
  let previousAnchor = window ? start : 0;
  const pending = [];
  const noteInversion = (blockIndex, para, after, score, duplicate) => {
    const strong = score >= 0.85 && blockTokenList[blockIndex].length >= 12;
    const kind = strong && !duplicate ? "real" : "noise";
    if (kind === "real") realInversions += 1;
    else noiseInversions += 1;
    if (inversionExamples.length < 10) {
      inversionExamples.push({
        kind,
        block: snippet(body[blockIndex]),
        source: snippet(paras[para]),
        after: after >= 0 ? snippet(paras[after]) : "",
        score: Math.round(score * 100) / 100
      });
    }
  };
  // A repeated source paragraph can outscore the copy that sits next to the
  // cursor. Among near-equal copies, keep the monotonic nearest one.
  const nearCopies = (blockIndex, floor) => {
    const found = [];
    if (!window) return found;
    for (let para = start; para <= end; para += 1) {
      const score = blockCoveredBy(blockTokenList[blockIndex], paraSets[para]);
      if (score >= floor) found.push({ para, score });
    }
    return found;
  };
  const nearestCopy = (blockIndex, cursor, hit) => {
    const copies = nearCopies(blockIndex, 0.62);
    if (!copies.length) return hit;
    const top = copies.reduce((bestCopy, copy) => (copy.score > bestCopy.score ? copy : bestCopy), copies[0]);
    // Repeated paragraphs stay near the cursor even when a later copy scores a bit higher.
    const near = copies.filter((copy) => copy.score >= 0.82 || copy.score >= top.score - 0.12);
    const forward = near.filter((copy) => copy.para >= cursor).sort((a, b) => a.para - b.para);
    if (forward.length) return forward[0];
    return top;
  };
  best.forEach((hit, blockIndex) => {
    const anchored = anchorByBody.get(blockIndex);
    const pick = nearestCopy(blockIndex, previousAnchor, anchored != null ? { para: anchored, score: 1 } : hit);
    if (anchored != null && inWindow(anchored)) {
      const cursor = inWindow(pick.para) ? pick.para : anchored;
      for (const earlier of pending) {
        if (earlier.para > cursor) noteInversion(earlier.block, earlier.para, cursor, earlier.score, earlier.duplicate);
      }
      pending.length = 0;
      previousAnchor = Math.max(previousAnchor, cursor);
      return;
    }
    if (!inWindow(pick.para) || pick.score < 0.62 || blockTokenList[blockIndex].length < 8) return;
    const duplicate = pick.para !== hit.para && hit.score >= pick.score - 0.12;
    if (pick.para < previousAnchor) noteInversion(blockIndex, pick.para, previousAnchor, pick.score, duplicate);
    else pending.push({ block: blockIndex, para: pick.para, score: pick.score, duplicate });
  });

  const breaks = sentenceBreaks(raw, anchorOf);
  const blockBlob = new Set(blockTokenList.flat());
  const covered = new Set(matchedParas);
  if (window) {
    for (let index = start; index <= end; index += 1) {
      if (covered.has(index)) continue;
      const owned = blockTokens.some((tokensOfBlock) => overlapTokens(paraTokens[index], tokensOfBlock) >= MATCH);
      // A paragraph split over several blocks is still on the page.
      let anywhere = 0;
      if (!owned) {
        for (const token of paraTokens[index]) if (blockBlob.has(token)) anywhere += 1;
      }
      const together = paraTokens[index].length ? anywhere / paraTokens[index].length : 0;
      if (owned || together >= MATCH) covered.add(index);
    }
  }
  const gap = { absent: 0, fragment: 0, macro: 0, note: 0, examples: [] };
  let bodyCount = 0;
  let bodyCovered = 0;
  if (window) {
    for (let index = start; index <= end; index += 1) {
      const rawText = paras[index];
      const kind = gapKind(rawText, paraTokens[index], blockBlob);
      if (kind === "macro" || kind === "note") {
        gap[kind] += 1;
        if (gap.examples.length < 8) gap.examples.push({ kind, text: snippet(rawText, 140) });
        continue;
      }
      bodyCount += 1;
      if (covered.has(index)) {
        bodyCovered += 1;
        continue;
      }
      const missing = kind === "absent" ? "absent" : "fragment";
      gap[missing] += 1;
      if (gap.examples.length < 8) gap.examples.push({ kind: missing, text: snippet(rawText, 140) });
    }
  }
  const denominator = bodyCount;
  return {
    coverage: denominator ? bodyCovered / denominator : 1,
    blockCoverage: body.length ? matchedBlocks.size / body.length : 1,
    inversions: realInversions,
    noiseInversions,
    breaks: breaks.real,
    noiseBreaks: breaks.noise,
    fakeHeadings: 0,
    matched: bodyCovered,
    total: denominator,
    absent: gap.absent,
    blocks: body.length,
    window: window ? { start, end } : null,
    inversionExamples,
    breakExamples: breaks.examples,
    gap
  };
}

function gapKind(rawText, paraTokenList, blockBlob) {
  const raw = String(rawText || "");
  const letters = (raw.match(/[A-Za-z]/g) || []).length;
  const braces = (raw.match(/[{}\\$]/g) || []).length;
  const prose = raw.split(/[.!?]/).some((part) => (part.match(/[A-Za-z]/g) || []).length > 40);
  if (letters < 24 || braces > letters * 0.15 || (/@/.test(raw) && letters < 120) || (!prose && braces >= 4)) return "macro";
  if (/\b(?:width|height)\s*=\s*[\d.]/.test(raw) && braces >= 2) return "macro";
  if (/\b(?:appendix|footnote|proof|acknowledg(?:e)?ments?|we would like to thank|the authors would like to thank)\b/i.test(raw)) return "note";
  let hit = 0;
  for (const token of paraTokenList) if (blockBlob.has(token)) hit += 1;
  const covered = paraTokenList.length ? hit / paraTokenList.length : 0;
  return covered >= 0.45 ? "present" : "absent";
}
