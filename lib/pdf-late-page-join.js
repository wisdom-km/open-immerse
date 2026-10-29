/**
 * A text-layer page can finish after the next page is already on screen.
 * The forward join lives here. The viewer only applies the result.
 */

import { continuationRepaintSafe, joinPageBoundary, pageOpensMidSentence } from "./pdf-flow-join.js";

function textOf(block) {
  return String(block?.text || "");
}

/**
 * Claim the continuation `next` is already showing, once `current` arrives.
 * Returns copies, or null when nothing should be painted.
 * A stored translation that owns the pre-join source stays as it was.
 */
export function claimArrivedPageContinuation(current, next, options = {}) {
  const left = current || [];
  const right = next || [];
  if (!left.length || !right.length) return null;
  const joined = joinPageBoundary(left, right);
  if (!joined.joined) return null;
  const hostGrew = joined.previous.some((block, index) => textOf(block) !== textOf(left[index]));
  const tailHidden = joined.next.some((block, index) => block?.flowHost && !right[index]?.flowHost);
  if (!hostGrew && !tailHidden) return null;
  if (hostGrew && !continuationRepaintSafe({
    before: left,
    after: joined.previous,
    pairs: options.pairs || []
  })) return null;
  return {
    current: joined.previous,
    next: joined.next,
    repaintCurrent: hostGrew,
    repaintNext: tailHidden
  };
}

/**
 * Page n+1 is already on screen and its first sentence is only a tail.
 * The previous page still has no text, so it has to be read in the background.
 */
export function priorPageNeedsText(priorBlocks, nextBlocks) {
  if ((priorBlocks || []).some((block) => String(block?.text || "").trim())) return false;
  return pageOpensMidSentence(nextBlocks);
}
