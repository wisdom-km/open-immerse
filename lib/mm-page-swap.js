/**
 * Replace only the paragraphs whose text changed.
 * setPageLayout stores a whole page and reanchors notes. It does not diff
 * DOM nodes, so the viewer calls this after the layout is stored.
 */

export const MM_SWAP_STRUCTURE_RATIO = 0.3;
export const MM_SWAP_MS = 150;
export const MM_SWAP_DEFER_MS = 2000;
export const MM_SWAP_SCROLL_IDLE_MS = 200;

export function normalizeSwapText(text) {
  return String(text || "").normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function structureChange(before, after, { columnsBefore = 0, columnsAfter = 0 } = {}) {
  const left = (before || []).length;
  const right = (after || []).length;
  const denom = Math.max(left, right, 1);
  const ratio = Math.abs(left - right) / denom;
  const columnsChanged = Number(columnsBefore) > 0 && Number(columnsAfter) > 0 && Number(columnsBefore) !== Number(columnsAfter);
  return ratio > MM_SWAP_STRUCTURE_RATIO || columnsChanged;
}

/**
 * Identical normalized text keeps the previous block id so the DOM node stays.
 * A count change above 30%, or a column-count change, replaces the page in one frame.
 */
export function planParagraphSwap(before, after, options = {}) {
  const prev = before || [];
  const next = after || [];
  if (structureChange(prev, next, options)) {
    return {
      mode: "page",
      ratio: Math.abs(prev.length - next.length) / Math.max(prev.length, next.length, 1),
      ops: next.map((block) => ({ op: "replace", id: String(block.id || ""), block }))
    };
  }
  const unused = prev.map((block, index) => ({ block, index, used: false }));
  const ops = [];
  for (const block of next) {
    const needle = normalizeSwapText(block.text || "");
    const label = String(block.label || "");
    const found = unused.find((item) => !item.used && String(item.block.label || "") === label && normalizeSwapText(item.block.text || "") === needle);
    if (found && needle) {
      found.used = true;
      ops.push({
        op: "keep",
        id: String(found.block.id || ""),
        nextId: String(block.id || found.block.id || ""),
        block
      });
    } else {
      ops.push({ op: "replace", id: String(block.id || ""), block });
    }
  }
  const leftover = unused.filter((item) => !item.used);
  let cursor = 0;
  for (const op of ops) {
    if (op.op !== "replace") continue;
    const host = leftover[cursor];
    if (!host) break;
    cursor += 1;
    op.fromId = String(host.block.id || "");
    if (!op.id) op.id = op.fromId;
  }
  return { mode: "diff", ratio: Math.abs(prev.length - next.length) / Math.max(prev.length, next.length, 1), ops };
}

export function swapShouldDefer({ selecting = false, scrolling = false, tooltip = false, waitedMs = 0 } = {}) {
  const busy = selecting || scrolling || tooltip;
  if (!busy) return { defer: false, viewportOnly: false };
  if (waitedMs >= MM_SWAP_DEFER_MS) return { defer: false, viewportOnly: true };
  return { defer: true, viewportOnly: false };
}

export function scrollCompensation(top0, top1) {
  const before = Number(top0);
  const after = Number(top1);
  if (!Number.isFinite(before) || !Number.isFinite(after)) return 0;
  return after - before;
}

function blockNodes(root) {
  if (!root?.querySelectorAll) return [];
  return [...root.querySelectorAll("[data-block-id]")];
}

/** First paragraph whose box still meets the top of the viewport. */
export function swapAnchor(nodes, viewportTop = 0) {
  const list = [...(nodes || [])];
  const line = Number(viewportTop) || 0;
  for (const node of list) {
    const rect = node?.getBoundingClientRect?.();
    if (!rect) continue;
    if (rect.bottom > line) return node;
  }
  return list[0] || null;
}

function nextFrame(fn) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(fn);
  else setTimeout(fn, 0);
}

function writeText(node, block) {
  const zh = node.querySelector?.(":scope > .rf-zh") || node.querySelector?.(".rf-zh");
  const src = node.querySelector?.(":scope > .rf-src") || node.querySelector?.(".rf-src");
  const text = String(block?.text || "");
  if (zh && !String(zh.textContent || "").trim()) zh.textContent = text;
  if (src) src.textContent = text;
  else if (!zh) node.textContent = text;
}

/**
 * Apply a swap plan. Kept paragraphs are the same node object.
 * `reducedMotion` skips the opacity cross-fade. Anchor compensation is returned
 * so the caller can add it to scrollTop; this function applies it when `scroller` is set.
 */
export function applyParagraphSwap(root, plan, {
  reducedMotion = false,
  durationMs = MM_SWAP_MS,
  scroller = null,
  anchor = null,
  viewportTop = 0,
  frame = nextFrame,
  scheduleRelease = (fn, ms) => setTimeout(fn, ms),
  now = () => Date.now()
} = {}) {
  void now;
  if (!root || !plan) return { kept: 0, replaced: 0, mode: plan?.mode || "" };
  const nodes = blockNodes(root);
  const byId = new Map(nodes.map((node) => [String(node.dataset?.blockId || ""), node]));
  const anchorEl = anchor || swapAnchor(nodes, viewportTop) || null;
  const top0 = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect().top : 0;
  let kept = 0;
  let replaced = 0;
  const animate = plan.mode === "diff" && reducedMotion !== true;
  const locked = [];
  for (const op of plan.ops || []) {
    if (op.op === "keep") {
      const node = byId.get(op.id);
      if (node) {
        kept += 1;
        if (op.nextId && op.nextId !== op.id) node.dataset.blockId = op.nextId;
      }
      continue;
    }
    const node = byId.get(op.fromId || op.id) || byId.get(op.id);
    if (!node) continue;
    if (op.id && node.dataset) node.dataset.blockId = op.id;
    const rect = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
    const above = rect ? rect.bottom <= viewportTop : false;
    if (animate && !above) {
      const height = rect?.height || node.offsetHeight || 0;
      if (height) node.style.minBlockSize = `${height}px`;
      node.classList?.add?.("rf-swap-lock");
      node.style.transition = `opacity ${durationMs}ms ease-out`;
      node.style.opacity = "0";
      writeText(node, op.block);
      node.classList?.add?.("rf-swap-in");
      locked.push(node);
      frame(() => {
        node.style.opacity = "1";
      });
    } else {
      writeText(node, op.block);
    }
    replaced += 1;
  }
  const top1 = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect().top : top0;
  const delta = scrollCompensation(top0, top1);
  if (scroller && delta) scroller.scrollTop += delta;
  if (locked.length) {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const beforeTop = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect().top : 0;
      for (const node of locked) {
        node.style.minBlockSize = "";
        node.classList?.remove?.("rf-swap-lock");
      }
      const afterTop = anchorEl?.getBoundingClientRect ? anchorEl.getBoundingClientRect().top : beforeTop;
      const extra = scrollCompensation(beforeTop, afterTop);
      if (scroller && extra) scroller.scrollTop += extra;
    };
    for (const node of locked) {
      node.addEventListener?.("transitionend", (event) => {
        if (event?.propertyName && event.propertyName !== "opacity") return;
        release();
      });
    }
    scheduleRelease(release, durationMs);
  }
  return { kept, replaced, mode: plan.mode, delta, anchorTop0: top0, anchorTop1: top1, anchor: anchorEl };
}
