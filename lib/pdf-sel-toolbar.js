/**
 * Selection toolbar (PR-3b).
 * Placement and the action registry live here so later note / ask / highlight
 * work only calls registerSelAction. This round renders see-source, jump-source,
 * and copy. Note, ask, highlight, and edit-tr stay registered and disabled.
 * 看原文 peeks in place. 跳到原页 brings the source pane here and resumes follow.
 */

export const SEL_TOOLBAR_H = 36;
export const SEL_TOOLBAR_H_COARSE = 48;
export const SEL_BTN_H = 32;
export const SEL_BTN_HIT_COARSE = 44;
export const SEL_GAP = 8;
export const SEL_ABOVE_CLEARANCE = 44;
export const SEL_EDGE_INSET = 10;
export const SEL_RADIUS = 8;
export const SEL_SCROLL_DISMISS = 24;
export const SEL_FOLD_KEY = "oi.rfSrcFold";
/** Narrow bars drop main actions in this order, from the side toward ⋯. */
export const SEL_COLLAPSE_ORDER = Object.freeze(["edit-tr", "note", "jump-source"]);

const registry = new Map();

export function registerSelAction(spec) {
  if (!spec?.id) throw new Error("sel action needs an id");
  const id = String(spec.id);
  const prev = registry.get(id) || {};
  const next = { ...prev, ...spec, id };
  if (spec.run == null && prev.run) next.run = prev.run;
  if (spec.enabled == null && prev.enabled != null) next.enabled = prev.enabled;
  registry.set(id, next);
  return next;
}

export function selAction(id) {
  return registry.get(String(id || "")) || null;
}

export function selActionList() {
  return [...registry.values()];
}

export function resetSelActions() {
  registry.clear();
  registerBuiltinSelActions();
}

function flagOn(action, ctx) {
  const flag = action.enabled;
  if (typeof flag === "function") return Boolean(flag(ctx));
  return flag !== false;
}

export function enabledSelActions(ctx) {
  return selActionList().filter((action) => flagOn(action, ctx));
}

export function mainSelActions(ctx) {
  return enabledSelActions(ctx)
    .filter((action) => (action.slot || "main") !== "overflow")
    .sort(byOrder);
}

export function overflowSelActions(ctx) {
  return enabledSelActions(ctx)
    .filter((action) => action.slot === "overflow")
    .sort(byOrder);
}

function byOrder(a, b) {
  return (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id));
}

/** Actions land on the selection start block. Later bids stay on the context. */
export function selActionTarget(ctx) {
  const bids = Array.isArray(ctx?.bids) ? ctx.bids.map((id) => String(id || "")) : [];
  const pairIds = Array.isArray(ctx?.pairIds) ? ctx.pairIds.map((id) => String(id || "")) : [];
  const pairId = pairIds[0] || "";
  return {
    bid: bids[0] || "",
    pairId,
    srcPage: Number(ctx?.srcPage) || 0,
    paired: Boolean(pairId)
  };
}

export function jumpSourceLabel(srcPage) {
  const n = Number(srcPage);
  return n >= 1 ? `跳到原页 p.${n}` : "跳到原页";
}

/**
 * Buttons and menu items the toolbar should render.
 * Disabled see-source / jump stay in the DOM. Registry-disabled actions do not.
 */
export function selToolbarModel(ctx, { collapsedIds = [] } = {}) {
  const collapsed = new Set((collapsedIds || []).map((id) => String(id)));
  const target = selActionTarget(ctx);
  const main = mainSelActions(ctx).filter((action) => !collapsed.has(action.id));
  const overflow = [
    ...mainSelActions(ctx).filter((action) => collapsed.has(action.id)),
    ...overflowSelActions(ctx)
  ];
  const buttons = main.map((action) => actionModel(action, target));
  buttons.push({
    id: "more",
    label: "⋯",
    ariaLabel: "更多",
    disabled: false,
    title: "",
    keyshortcuts: ""
  });
  return {
    buttons,
    menu: overflow.map((action) => actionModel(action, target))
  };
}

function actionModel(action, target) {
  const needsPair = action.id === "see-source" || action.id === "jump-source";
  const disabled = needsPair && !target.paired;
  return {
    id: action.id,
    label: action.id === "jump-source" ? jumpSourceLabel(target.srcPage) : action.label,
    ariaLabel: "",
    disabled,
    title: disabled ? "这段没有配对" : "",
    keyshortcuts: action.keyshortcuts || ""
  };
}

/** Drop main actions until the bar fits. 看原文 stays. */
export function fitSelToolbar({ main, overflow, widths, available, moreWidth = 0 } = {}) {
  const kept = [...(main || [])];
  const extra = [...(overflow || [])];
  const widthOf = (items) => items.reduce((sum, item) => sum + (Number(widths?.[item.id]) || 0), 0) + (Number(moreWidth) || 0);
  for (const id of SEL_COLLAPSE_ORDER) {
    if (widthOf(kept) <= Number(available)) break;
    const index = kept.findIndex((item) => item.id === id);
    if (index < 0) continue;
    extra.push(kept.splice(index, 1)[0]);
  }
  return { main: kept, overflow: extra };
}

export function nextSelCollapse(mainIds) {
  const ids = new Set(mainIds || []);
  return SEL_COLLAPSE_ORDER.find((id) => ids.has(id)) || "";
}

/**
 * Place the bar against a selection box in scrollport coordinates.
 * `anchor.y` is the distance from the visible top of the translation scroll root.
 * Returns placement plus offsets from that same visible origin.
 */
export function placeSelToolbar({
  anchor,
  toolbar,
  root,
  gap = SEL_GAP,
  aboveClearance = SEL_ABOVE_CLEARANCE,
  inset = SEL_EDGE_INSET
} = {}) {
  const ax = num(anchor?.x);
  const ay = num(anchor?.y);
  const aw = num(anchor?.width);
  const ah = num(anchor?.height);
  const tw = num(toolbar?.width);
  const th = num(toolbar?.height);
  const rw = num(root?.width);
  const placement = ay < aboveClearance ? "below" : "above";
  const top = placement === "above" ? ay - gap - th : ay + ah + gap;
  let inlineStart = ax + aw / 2 - tw / 2;
  const min = inset;
  const max = Math.max(min, rw - tw - inset);
  if (!(rw > 0) || tw + inset * 2 >= rw) inlineStart = min;
  else inlineStart = Math.min(max, Math.max(min, inlineStart));
  return { placement, top, inlineStart };
}

export function selScrollDismissed(start, current, limit = SEL_SCROLL_DISMISS) {
  return Math.abs(num(current) - num(start)) > limit;
}

/** Reading order, unique by bid. Boxes are viewport rects in the same space as `rects`. */
export function blocksMeetingSelection(blocks, rects) {
  const boxes = (rects || []).filter((rect) => num(rect?.width) > 0 || num(rect?.height) > 0);
  const seen = new Set();
  const hits = [];
  for (const block of blocks || []) {
    const bid = String(block?.bid || "");
    if (!bid || seen.has(bid)) continue;
    const box = block?.box;
    if (!box || !boxes.some((rect) => rectsOverlap(rect, box))) continue;
    seen.add(bid);
    hits.push(block);
  }
  return hits;
}

export function unionRect(rects) {
  const list = (rects || []).filter((rect) => num(rect?.width) > 0 || num(rect?.height) > 0);
  if (!list.length) return { x: 0, y: 0, width: 0, height: 0 };
  const x = Math.min(...list.map((rect) => num(rect.x)));
  const y = Math.min(...list.map((rect) => num(rect.y)));
  const right = Math.max(...list.map((rect) => num(rect.x) + num(rect.width)));
  const bottom = Math.max(...list.map((rect) => num(rect.y) + num(rect.height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function createSrcFoldMemory(storage) {
  const read = () => {
    try {
      const raw = storage?.getItem?.(SEL_FOLD_KEY);
      const parsed = JSON.parse(raw || "[]");
      return new Set(Array.isArray(parsed) ? parsed.map((id) => String(id)) : []);
    } catch {
      return new Set();
    }
  };
  const write = (set) => {
    try {
      storage?.setItem?.(SEL_FOLD_KEY, JSON.stringify([...set]));
    } catch {
      /* private mode or a missing store */
    }
  };
  return {
    has(bid) {
      return Boolean(bid) && read().has(String(bid));
    },
    expand(bid) {
      if (!bid) return;
      const set = read();
      set.add(String(bid));
      write(set);
    },
    collapse(bid) {
      if (!bid) return;
      const set = read();
      set.delete(String(bid));
      write(set);
    },
    toggle(bid) {
      if (!bid) return false;
      const set = read();
      const id = String(bid);
      const open = !set.has(id);
      if (open) set.add(id);
      else set.delete(id);
      write(set);
      return open;
    }
  };
}

/** Text blocks with source copy get a fold. Figures and formulas do not. */
export function blockWantsSrcFold(block) {
  const label = String(block?.label || "");
  if (label === "formula" || label === "figure" || label === "table") return false;
  return Boolean(String(block?.sourceText || "").trim());
}

function rectsOverlap(a, b) {
  const ax = num(a?.x);
  const ay = num(a?.y);
  const bx = num(b?.x);
  const by = num(b?.y);
  return ax < bx + num(b?.width) && ax + num(a?.width) > bx && ay < by + num(b?.height) && ay + num(a?.height) > by;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function registerBuiltinSelActions() {
  registerSelAction({
    id: "note",
    slot: "main",
    order: 10,
    label: "笔记",
    shortcut: "n",
    enabled: () => false,
    run: async () => {}
  });
  registerSelAction({
    id: "ask",
    slot: "main",
    order: 20,
    label: "提问",
    shortcut: "q",
    enabled: () => false,
    run: async () => {}
  });
  registerSelAction({
    id: "see-source",
    slot: "main",
    order: 30,
    label: "看原文",
    shortcut: "",
    enabled: () => true,
    run: async () => {}
  });
  registerSelAction({
    id: "edit-tr",
    slot: "main",
    order: 40,
    label: "改译文",
    shortcut: "",
    enabled: () => false,
    run: async () => {}
  });
  registerSelAction({
    id: "jump-source",
    slot: "main",
    order: 50,
    label: "跳到原页",
    shortcut: "p",
    keyshortcuts: "p",
    enabled: () => true,
    run: async () => {}
  });
  registerSelAction({
    id: "highlight",
    slot: "overflow",
    order: 10,
    label: "划线",
    shortcut: "h",
    enabled: () => false,
    run: async () => {}
  });
  registerSelAction({
    id: "copy",
    slot: "overflow",
    order: 20,
    label: "复制",
    shortcut: "Meta+C",
    keyshortcuts: "Meta+C",
    enabled: () => true,
    run: async () => {}
  });
}

registerBuiltinSelActions();
