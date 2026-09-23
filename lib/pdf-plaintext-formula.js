/**
 * Simple relations that stay Unicode in the sentence.
 * No ⟦fN⟧ and no pageRaster crop.
 *
 * Allow: one Latin/Greek base, optional _identifier, one equals, one number.
 * Examples: N = 6, h = 8, P_drop = 0.1, ε_ls = 0.1.
 * Dimension subscripts (d_model, d_k, d_ff) stay crops even when they end in = number.
 */

const RELATION_RE = /^([A-Za-z\u0370-\u03FF])(?:_\{?([A-Za-z]{2,}[A-Za-z0-9]*)\}?)?=(-?\d+(?:\.\d+)?)$/;
const RELATION_SCAN_RE = /[A-Za-z\u0370-\u03FF](?:_\{?[A-Za-z]{2,}[A-Za-z0-9]*\}?)?\s*=\s*-?\d+(?:\.\d+)?/g;

export function plaintextRelationParts(text) {
  const compact = String(text || "").replace(/\s+/g, "");
  if (!compact || /[√∑∫∏\[\]^]/.test(compact)) return null;
  const match = compact.match(RELATION_RE);
  if (!match) return null;
  const base = match[1];
  const sub = match[2] || "";
  if (sub && /^d$/i.test(base)) return null;
  return { base, sub, num: match[3] };
}

export function formatPlaintextRelation(parts, spaced = true) {
  if (!parts?.base || parts.num == null) return "";
  const left = parts.sub ? `${parts.base}_${parts.sub}` : parts.base;
  return spaced ? `${left} = ${parts.num}` : `${left}=${parts.num}`;
}

/** Relations already written as Unicode in a source sentence. */
export function plaintextRelationsIn(text) {
  const found = [];
  for (const match of String(text || "").matchAll(RELATION_SCAN_RE)) {
    const parts = plaintextRelationParts(match[0]);
    if (!parts) continue;
    found.push(formatPlaintextRelation(parts, true));
  }
  return found;
}
