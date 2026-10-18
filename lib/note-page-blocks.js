/**
 * Pages handed to notes. Formula sourceText is the charset source.
 * translationNotReady reads sourceText, and lib/notes-anchor.js stays
 * locked (AX-23), so the formula source is dropped on this copy.
 */
export function blocksForNotes(blocks) {
  return (blocks || []).map((block) => {
    if (block?.label !== "formula" || !block.sourceText) return block;
    const next = { ...block };
    delete next.sourceText;
    return next;
  });
}
