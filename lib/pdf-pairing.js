/**
 * Block pairing, follow, jump lock, and pane-order math.
 * No document, and no start/end screen edges named as physical sides.
 * Source pane and translation pane only.
 */

import { blockCoveredByStructure } from "./pdf-structure-render.js";
import { clearFadeScroll } from "./pdf-reader-flow.js";

export const PAIR_ANCHOR = 0.3;
export const JUMP_LOCK_MS = 1500;
export const PAIR_CLICK_SLOP = 4;
export const PAIR_BG_SPREAD = 12;
export const JUMP_FADE = 40;
export const JUMP_TOP_PAD = 8;

const ABSTRACT_HEADING_RE = /^(abstract|摘要)$/i;
const UNLOCK_KEYS = new Set([
  "ArrowUp", "ArrowDown", "PageUp", "PageDown", " ", "Home", "End", "j", "k", "J", "K"
]);

export function pairIdFor(page, blockId) {
  const n = Number(page);
  const id = blockId == null ? "" : String(blockId);
  if (!(n >= 1) || !Number.isFinite(n) || !id) return "";
  return `p${n}:${id}`;
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Normalized top-origin bbox → PDF points at scale 1. */
export function rectFromNormalized(bbox, pageWidth, pageHeight, page) {
  if (!Array.isArray(bbox) || bbox.length < 4) return null;
  const x0 = finite(bbox[0]);
  const y0 = finite(bbox[1]);
  const x1 = finite(bbox[2]);
  const y1 = finite(bbox[3]);
  const width = finite(pageWidth);
  const height = finite(pageHeight);
  const n = finite(page);
  if ([x0, y0, x1, y1, width, height, n].some((part) => part == null)) return null;
  if (!(width > 0) || !(height > 0) || !(n >= 1)) return null;
  const w = (x1 - x0) * width;
  const h = (y1 - y0) * height;
  if (!(w > 0) || !(h > 0)) return null;
  return { p: n, x: x0 * width, y: y0 * height, w, h };
}

function cleanRect(value) {
  if (!value || typeof value !== "object") return null;
  const p = finite(value.p);
  const x = finite(value.x);
  const y = finite(value.y);
  const w = finite(value.w);
  const h = finite(value.h);
  if ([p, x, y, w, h].some((part) => part == null)) return null;
  if (!(p >= 1) || !(w > 0) || !(h > 0)) return null;
  return { p, x, y, w, h };
}

export function encodeSrcRects(rects) {
  const clean = [];
  for (const rect of rects || []) {
    const next = cleanRect(rect);
    if (next) clean.push(next);
  }
  return JSON.stringify(clean);
}

export function decodeSrcRects(value) {
  let parsed = value;
  if (typeof value === "string") {
    if (!value) return [];
    try {
      parsed = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];
  const clean = [];
  for (const rect of parsed) {
    const next = cleanRect(rect);
    if (next) clean.push(next);
  }
  return clean;
}

function blockRect(block, page, pageWidth, pageHeight) {
  return rectFromNormalized(block?.bbox, pageWidth, pageHeight, page);
}

function normText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * One flow node per paragraph, heading, display formula, figure, or table.
 * A figure with its caption is one node and two rects.
 * A byline run is one node and one rect per byline block.
 * A block with no bbox is omitted (unpaired).
 */
export function buildBlockPairs({ page, blocks, pageWidth, pageHeight } = {}) {
  const list = Array.isArray(blocks) ? blocks : [];
  const used = new Set();
  const inlineByParent = new Map();
  for (const block of list) {
    if (!block?.inlineOf) continue;
    const parent = String(block.inlineOf);
    if (!inlineByParent.has(parent)) inlineByParent.set(parent, []);
    inlineByParent.get(parent).push(block);
  }
  const nodes = [];
  const inlines = [];

  for (let index = 0; index < list.length; index += 1) {
    const block = list[index];
    if (!block || block.inlineOf || used.has(block.id)) continue;

    if (block.presentation === "byline") {
      const run = [];
      for (let cursor = index; cursor < list.length; cursor += 1) {
        const item = list[cursor];
        if (!item || item.presentation !== "byline" || used.has(item.id)) break;
        run.push(item);
        used.add(item.id);
      }
      const rects = run.map((item) => blockRect(item, page, pageWidth, pageHeight)).filter(Boolean);
      if (!rects.length) continue;
      nodes.push({
        kind: "authors",
        pairId: pairIdFor(page, run[0].id),
        blockIds: run.map((item) => item.id),
        rects
      });
      continue;
    }

    const linked = block.label === "caption"
      ? list.find((item) => item && item.id === block.captionFor)
      : null;
    const visual = block.label === "figure" || block.label === "table" ? block : linked;
    if (visual && (block.label === "figure" || block.label === "table" || block.label === "caption")) {
      const caption = list.find((item) => item && item.captionFor === visual.id) || null;
      const members = [];
      for (const item of list) {
        if (!item) continue;
        if (item.id === visual.id || (caption && item.id === caption.id)) members.push(item);
      }
      for (const item of members) used.add(item.id);
      const rects = members.map((item) => blockRect(item, page, pageWidth, pageHeight)).filter(Boolean);
      if (!rects.length) continue;
      nodes.push({
        kind: visual.label,
        pairId: pairIdFor(page, members[0].id),
        blockIds: members.map((item) => item.id),
        anchorId: visual.id,
        rects
      });
      continue;
    }

    const rect = blockRect(block, page, pageWidth, pageHeight);
    if (!rect) continue;
    const pairId = pairIdFor(page, block.id);
    nodes.push({
      kind: block.label || "paragraph",
      pairId,
      blockIds: [block.id],
      anchorId: block.id,
      rects: [rect]
    });
    for (const formula of inlineByParent.get(String(block.id)) || []) {
      const own = blockRect(formula, page, pageWidth, pageHeight);
      if (!own) continue;
      inlines.push({
        blockId: formula.id,
        parentId: block.id,
        pairId,
        part: "inline",
        rects: [own]
      });
    }
  }
  return { nodes, inlines };
}

function packRole(role, members, page, pageWidth, pageHeight) {
  const list = members || [];
  const rects = list.map((item) => blockRect(item, page, pageWidth, pageHeight)).filter(Boolean);
  if (!rects.length || !list.length) {
    return { role, pairId: "", blockIds: list.map((item) => item.id), rects: [] };
  }
  return {
    role,
    pairId: pairIdFor(page, list[0].id),
    blockIds: list.map((item) => item.id),
    rects
  };
}

/**
 * Structure shell nodes mapped back onto covered source blocks.
 * title → label title, authors → byline, abstract → covered prose.
 * A role with no covered rect stays unpaired.
 */
export function structureRolePairs({ page, blocks, pageWidth, pageHeight, structure } = {}) {
  if (!structure) return [];
  const covered = (blocks || []).filter((block) => (
    block && !block.inlineOf && blockCoveredByStructure(block, structure)
  ));
  const title = covered.filter((block) => block.label === "title");
  const authors = covered.filter((block) => block.presentation === "byline");
  const abstractHeading = covered.filter((block) => (
    block.label === "heading" && ABSTRACT_HEADING_RE.test(normText(block.text || block.sourceText))
  ));
  const body = normText(structure.abstract?.body);
  const abstractBody = covered.filter((block) => {
    if (title.includes(block) || authors.includes(block) || abstractHeading.includes(block)) return false;
    const text = normText(block.text || block.sourceText);
    if (!text || !body) return false;
    return body.includes(text) || (body.length >= 24 && text.includes(body.slice(0, 60)));
  });
  const claimed = new Set([...title, ...authors, ...abstractHeading, ...abstractBody]);
  const roles = [
    packRole("title", title, page, pageWidth, pageHeight),
    packRole("authors", authors, page, pageWidth, pageHeight),
    packRole("abstract_heading", abstractHeading, page, pageWidth, pageHeight),
    packRole("abstract_body", abstractBody, page, pageWidth, pageHeight)
  ];
  for (const entry of structure.rest || []) {
    if (entry?.role === "other") continue;
    const rest = normText(entry?.text);
    const members = covered.filter((block) => {
      if (claimed.has(block)) return false;
      const text = normText(block.text || block.sourceText);
      return Boolean(rest && text && (rest.includes(text) || (rest.length >= 24 && text.includes(rest.slice(0, 40)))));
    });
    for (const block of members) claimed.add(block);
    roles.push(packRole(entry?.role || "rest", members, page, pageWidth, pageHeight));
  }
  return roles;
}

/** Several nodes share one id. One node may carry many rects. */
export function sharePair(pairId, members) {
  const id = String(pairId || "");
  return (members || []).map((member) => ({
    pairId: id,
    key: member?.key ?? "",
    rects: Array.isArray(member?.rects) ? member.rects.map((rect) => ({ ...rect })) : []
  }));
}

/**
 * Current block at the anchor line.
 * A gap uses the first block below. Past the end, the last block.
 * Callers omit breaks, untranslated rows, and gaps.
 */
export function blockAtAnchor(entries, line) {
  const list = (entries || []).filter((item) => (
    item && Number.isFinite(Number(item.top)) && Number.isFinite(Number(item.bottom)) && Number(item.bottom) > Number(item.top)
  ));
  if (!list.length) return null;
  const y = Number(line);
  if (!Number.isFinite(y)) return list[0];
  for (const item of list) {
    if (Number(item.top) <= y && Number(item.bottom) >= y) return item;
  }
  const below = list.find((item) => Number(item.top) > y);
  if (below) return below;
  return list[list.length - 1];
}

/** Smallest-area rect that contains the point. Edges count. Misses return null. */
export function sourceHit(rects, pt) {
  const x = finite(pt?.x);
  const y = finite(pt?.y);
  if (x == null || y == null) return null;
  let best = null;
  let bestArea = Infinity;
  for (const rect of rects || []) {
    const next = cleanRect({ p: rect?.p ?? 1, x: rect?.x, y: rect?.y, w: rect?.w, h: rect?.h });
    if (!next) continue;
    const x1 = next.x + next.w;
    const y1 = next.y + next.h;
    if (x < next.x || x > x1 || y < next.y || y > y1) continue;
    const area = next.w * next.h;
    if (area < bestArea) {
      best = rect;
      bestArea = area;
    }
  }
  return best;
}

/**
 * Follow switch. persist is set only by toggle, and never to the paused state.
 * Events: toggle, userSourceScroll, resume, clickJump, capsuleJump,
 * sourceModeChange, sourceAvailable.
 */
export function followReducer(state, event) {
  const type = typeof event === "string" ? event : event?.type;
  const current = state === "off" || state === "paused" || state === "unavailable" ? state : "on";
  if (type === "sourceAvailable") {
    const available = event?.available !== false;
    if (!available) return { state: "unavailable", persist: null };
    if (current === "unavailable") {
      return { state: event?.stored === "0" ? "off" : "on", persist: null };
    }
    return { state: current, persist: null };
  }
  if (current === "unavailable") return { state: "unavailable", persist: null };
  if (type === "toggle") {
    if (current === "on") return { state: "off", persist: "0" };
    if (current === "off") return { state: "on", persist: "1" };
    return { state: "on", persist: null };
  }
  if (type === "userSourceScroll") {
    if (current === "on") return { state: "paused", persist: null };
    return { state: current, persist: null };
  }
  if (type === "resume") {
    if (current === "paused") return { state: "on", persist: null };
    return { state: current, persist: null };
  }
  if (type === "clickJump" || type === "capsuleJump" || type === "sourceModeChange") {
    if (current === "off") return { state: "off", persist: null };
    return { state: "on", persist: null };
  }
  return { state: current, persist: null };
}

export function createJumpLock({ now = () => Date.now(), holdMs = JUMP_LOCK_MS } = {}) {
  let until = 0;
  return {
    get until() {
      return until;
    },
    get locked() {
      return now() < until;
    },
    lock(at) {
      const t = Number.isFinite(Number(at)) ? Number(at) : now();
      until = t + holdMs;
      return until;
    },
    unlock() {
      until = 0;
    }
  };
}

export function isUnlockEvent(event = {}) {
  const type = event.type;
  if (type === "wheel" || type === "touchstart") return true;
  if (type === "pointerdown") return event.onScrollSurface === true;
  if (type === "keydown") return UNLOCK_KEYS.has(event.key);
  return false;
}

export function pairClickKept({ dx = 0, dy = 0, collapsed = true, blocked = false } = {}) {
  if (blocked || collapsed === false) return false;
  const distance = Math.hypot(Number(dx) || 0, Number(dy) || 0);
  return distance <= PAIR_CLICK_SLOP;
}

/** Scroll that puts rect top on the source 30% line, clamped to the pane. */
export function sourceAnchorScroll({
  rectTop,
  clientHeight,
  scrollHeight,
  anchor = PAIR_ANCHOR
} = {}) {
  const top = finite(rectTop);
  const height = finite(clientHeight);
  const total = finite(scrollHeight);
  if (top == null || height == null || !(height > 0)) return 0;
  const max = total == null ? Infinity : Math.max(0, total - height);
  const want = top - anchor * height;
  return Math.min(max, Math.max(0, want));
}

/** Null when the rect is already fully inside the source viewport. */
export function sourceFollowScroll({
  rectTop,
  rectBottom,
  scrollTop = 0,
  clientHeight,
  scrollHeight,
  anchor = PAIR_ANCHOR
} = {}) {
  const top = finite(rectTop);
  const bottom = finite(rectBottom);
  const origin = finite(scrollTop) ?? 0;
  const height = finite(clientHeight);
  if (top == null || bottom == null || height == null) return null;
  const fully = top >= origin - 0.5 && bottom <= origin + height + 0.5;
  if (fully) return null;
  return sourceAnchorScroll({ rectTop: top, clientHeight: height, scrollHeight, anchor });
}

/**
 * Translation landing. wantTop is the scroll that puts the block on the pane
 * top; clearFadeScroll pulls that back to the 30% line, or to +8 when the
 * block is taller than the viewport minus 48. blockHeight grows by the 6px
 * background spread on each side.
 */
export function translationJumpScroll({
  blockTopInContent,
  blockHeight,
  paneHeight,
  scrollHeight
} = {}) {
  const blockTop = finite(blockTopInContent);
  const rawHeight = finite(blockHeight);
  const pane = finite(paneHeight);
  if (blockTop == null || rawHeight == null || pane == null || !(pane > 0)) return 0;
  const height = rawHeight + PAIR_BG_SPREAD;
  const landed = clearFadeScroll({
    wantTop: blockTop,
    paneHeight: pane,
    blockHeight: height,
    blockTopInPane: blockTop,
    fade: JUMP_FADE,
    topPad: JUMP_TOP_PAD,
    anchor: PAIR_ANCHOR
  });
  const total = finite(scrollHeight);
  const max = total == null ? Infinity : Math.max(0, total - pane);
  return Math.min(max, Math.max(0, landed));
}

export function nudgeScrollToPair({ proposed, entries, anchorOffset, targetId } = {}) {
  const base = finite(proposed) ?? 0;
  const offset = finite(anchorOffset) ?? 0;
  const at = (top) => blockAtAnchor(entries, top + offset);
  if (at(base)?.pairId === targetId) return base;
  for (const delta of [1, -1]) {
    if (at(base + delta)?.pairId === targetId) return base + delta;
  }
  return base;
}

/**
 * Pointer ratio of the source column. `side` "end" mirrors the gesture:
 * moving toward the screen origin widens the source column.
 * rect uses x, width, and end — not physical edge names.
 */
export function splitPointerRatio({ clientX, rect, splitW, side = "start" } = {}) {
  const origin = finite(rect?.x) ?? 0;
  const span = finite(rect?.width) ?? 0;
  const gap = finite(splitW) > 0 ? finite(splitW) : 0;
  const available = Math.max(1, span - gap);
  const x = finite(clientX) ?? origin;
  if (side === "end") {
    const end = finite(rect?.end);
    const far = end == null ? origin + span : end;
    return (far - x - gap / 2) / available;
  }
  return (x - origin - gap / 2) / available;
}

/** Arrow keys move the splitter along the arrow. Home/End are source min/max. */
export function splitKeyStep({ key, shift = false, side = "start" } = {}) {
  const step = shift ? 64 : 16;
  if (key === "Home") return { to: "min" };
  if (key === "End") return { to: "max" };
  if (key === "Enter") return { to: "reset" };
  if (key === "ArrowLeft") return { delta: side === "end" ? step : -step };
  if (key === "ArrowRight") return { delta: side === "end" ? -step : step };
  return null;
}

export function menuNext(items, index, key) {
  const list = items || [];
  const enabled = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || item.separator || item.disabled || item.hidden) continue;
    enabled.push(i);
  }
  if (!enabled.length) return -1;
  if (key === "Home") return enabled[0];
  if (key === "End") return enabled[enabled.length - 1];
  const current = enabled.indexOf(index);
  if (key === "ArrowDown") {
    if (current < 0) return enabled.find((i) => i > index) ?? enabled[0];
    return enabled[Math.min(enabled.length - 1, current + 1)];
  }
  if (key === "ArrowUp") {
    if (current < 0) {
      const prev = [...enabled].reverse().find((i) => i < index);
      return prev ?? enabled[enabled.length - 1];
    }
    return enabled[Math.max(0, current - 1)];
  }
  return Number.isInteger(index) ? index : enabled[0];
}

export function moreMenuModel(width) {
  const wide = Number(width) >= 900;
  const items = [];
  if (wide) items.push({ id: "swap", separator: false, disabled: false, hidden: false });
  if (wide) items.push({ id: "sep", separator: true, disabled: false, hidden: false });
  items.push({ id: "exportMd", separator: false, disabled: false, hidden: false });
  items.push({ id: "exportPdf", separator: false, disabled: false, hidden: false });
  return items;
}

export function appliedSourceSide(width, stored) {
  if (!(Number(width) >= 900)) return "start";
  return stored === "end" ? "end" : "start";
}

export function visualPaneOrder(side) {
  return side === "end"
    ? ["translation", "split", "source"]
    : ["source", "split", "translation"];
}

export function sourcePageLabel(page, total) {
  const m = Number(total);
  if (!(m >= 1) || !Number.isFinite(m)) return "第 0/0 页";
  const n = Number(page);
  const shown = Number.isFinite(n) && n >= 1 ? Math.min(m, Math.floor(n)) : 1;
  return `第 ${shown}/${m} 页`;
}

export function pageArrivalText(page) {
  const n = Number(page);
  if (!(n >= 1) || !Number.isFinite(n)) return "";
  return `已到第 ${Math.floor(n)} 页`;
}

/** Percent box inside a rendered page, expanded by outset px. */
export function pairBoxStyle(rect, pageWidth, pageHeight, outset = 5) {
  const width = finite(pageWidth);
  const height = finite(pageHeight);
  const box = cleanRect(rect);
  if (!box || !(width > 0) || !(height > 0)) return null;
  const pad = finite(outset) ?? 0;
  return {
    x: `calc(${(box.x / width) * 100}% - ${pad}px)`,
    y: `calc(${(box.y / height) * 100}% - ${pad}px)`,
    w: `calc(${(box.w / width) * 100}% + ${pad * 2}px)`,
    h: `calc(${(box.h / height) * 100}% + ${pad * 2}px)`
  };
}
