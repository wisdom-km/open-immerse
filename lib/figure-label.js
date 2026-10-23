/**
 * Figure and table numbers read from a caption at render time.
 * The result is not written into the library.
 */

const FIGURE_LABEL_RE = /^(?:Figure|Fig\.?|图|Table|表)\s*(\d+[a-z]?)/i;

/**
 * @param {string} captionText source caption, not the translation
 * @returns {{ kind: "figure" | "table", num: string } | null}
 */
export function parseFigureLabel(captionText) {
  const text = String(captionText ?? "").trim();
  const match = FIGURE_LABEL_RE.exec(text);
  if (!match) return null;
  const num = match[1];
  const head = match[0].slice(0, match[0].length - num.length);
  const kind = /^(?:table|表)/i.test(head.trim()) ? "table" : "figure";
  return { kind, num };
}
