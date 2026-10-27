/**
 * Recursive XY-cut reading order for text-layer lines.
 * One vertical gutter is two columns; two gutters are three. Full-width lines
 * stay in their own bands. A narrow edge column is an aside and follows the
 * body. Footnotes, when the line is already tagged, follow the asides.
 * PDF y grows upward.
 */

const MAX_DEPTH = 6;

function boundsOf(lines) {
  const left = Math.min(...lines.map((line) => line.x));
  const right = Math.max(...lines.map((line) => line.x + line.width));
  const bottom = Math.min(...lines.map((line) => line.y));
  const top = Math.max(...lines.map((line) => line.y + (line.height || 0)));
  return { left, right, bottom, top, width: Math.max(1, right - left), height: Math.max(1, top - bottom) };
}

function sortDown(lines) {
  return [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
}

function tag(lines, patch) {
  for (const line of lines) Object.assign(line, patch);
  return lines;
}

function median(values) {
  const list = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!list.length) return 0;
  return list[Math.floor(list.length / 2)];
}

function fullWidth(line, width) {
  return line.width > width * 0.58;
}

function findGutters(lines, box) {
  if (lines.length < 4 || box.width < 40) return [];
  const bins = 48;
  const cover = new Array(bins).fill(0);
  for (const line of lines) {
    const a = Math.max(0, Math.min(bins - 1, Math.floor(((line.x - box.left) / box.width) * bins)));
    const b = Math.max(a, Math.min(bins - 1, Math.floor(((line.x + line.width - box.left) / box.width) * bins)));
    for (let i = a; i <= b; i += 1) cover[i] += 1;
  }
  const peak = Math.max(...cover);
  if (peak < 2) return [];
  const gutters = [];
  let index = 0;
  while (index < bins) {
    if (cover[index] > peak * 0.35) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < bins && cover[index] <= peak * 0.35) index += 1;
    const end = index;
    const run = end - start;
    const mid = box.left + ((start + end) / 2 / bins) * box.width;
    const rel = (mid - box.left) / box.width;
    if (run >= 2 && rel > 0.12 && rel < 0.88) gutters.push(mid);
  }
  gutters.sort((a, b) => a - b);
  const picked = [];
  for (const gutter of gutters) {
    if (picked.length >= 2) break;
    if (picked.some((kept) => Math.abs(kept - gutter) < box.width * 0.12)) continue;
    picked.push(gutter);
  }
  return picked;
}

function splitAt(lines, gutters) {
  const edges = [Number.NEGATIVE_INFINITY, ...gutters, Number.POSITIVE_INFINITY];
  const columns = edges.slice(0, -1).map(() => []);
  for (const line of lines) {
    const center = line.x + line.width / 2;
    let at = 0;
    while (at < gutters.length && center > gutters[at]) at += 1;
    columns[at].push(line);
  }
  return columns.filter((column) => column.length);
}

function asideColumn(column, bodyWidth, box) {
  const width = Math.max(...column.map((line) => line.width));
  if (!(bodyWidth > 0) || width >= bodyWidth * 0.55) return false;
  const left = Math.min(...column.map((line) => line.x));
  const right = Math.max(...column.map((line) => line.x + line.width));
  const onEdge = left <= box.left + box.width * 0.16 || right >= box.right - box.width * 0.16;
  return onEdge && width < box.width * 0.34;
}

function lineFromItems(line, items) {
  const left = Math.min(...items.map((item) => item.x));
  const right = Math.max(...items.map((item) => item.x + (Number(item.width) || 0)));
  const text = items.map((item) => String(item.str || item.text || "")).join(" ").replace(/\s+/g, " ").trim();
  return {
    ...line,
    text,
    x: left,
    width: Math.max(1, right - left),
    items
  };
}

function itemText(items) {
  return items.map((item) => item.str || item.text || "").join("").trim();
}

/** Gutters voted by lines that really have prose on both sides. Short equation numbers do not vote. */
function columnGutters(lines) {
  const votes = [];
  for (const line of lines) {
    const ordered = [...(line.items || [])].sort((a, b) => a.x - b.x);
    for (let index = 1; index < ordered.length; index += 1) {
      const prev = ordered[index - 1];
      const gapStart = prev.x + (Number(prev.width) || 0);
      const gap = ordered[index].x - gapStart;
      if (gap < 18) continue;
      const left = itemText(ordered.slice(0, index));
      const right = itemText(ordered.slice(index));
      if (left.length >= 18 && right.length >= 12) votes.push(gapStart + gap / 2);
    }
  }
  votes.sort((a, b) => a - b);
  const clusters = [];
  for (const vote of votes) {
    const last = clusters.at(-1);
    if (last && Math.abs(last.mid - vote) < 28) {
      last.sum += vote;
      last.n += 1;
      last.mid = last.sum / last.n;
    } else clusters.push({ mid: vote, sum: vote, n: 1 });
  }
  return clusters.filter((cluster) => cluster.n >= 2).slice(0, 2).map((cluster) => cluster.mid);
}

/**
 * A content-stream line can hold two columns that share a baseline.
 * Split only at a gutter that other prose lines also vote for.
 */
function splitStitched(lines) {
  const gutters = columnGutters(lines);
  if (!gutters.length) return lines;
  const out = [];
  for (const line of lines) {
    const ordered = [...(line.items || [])].sort((a, b) => a.x - b.x || b.y - a.y);
    if (ordered.length < 2) {
      out.push(line);
      continue;
    }
    const groups = [[]];
    for (const item of ordered) {
      const prev = groups.at(-1).at(-1);
      if (prev) {
        const gapStart = prev.x + (Number(prev.width) || 0);
        const gapEnd = item.x;
        const crosses = gutters.some((gutter) => gapStart + 4 < gutter && gapEnd - 4 > gutter);
        if (crosses) groups.push([]);
      }
      groups.at(-1).push(item);
    }
    const parts = groups.filter((group) => group.length);
    if (parts.length < 2) out.push(line);
    else out.push(...parts.map((group) => lineFromItems(line, group)).filter((part) => part.text));
  }
  return out;
}

function orderRegion(lines, depth) {
  const list = lines.filter((line) => line && String(line.text || "").trim());
  if (list.length < 2 || depth > MAX_DEPTH) return sortDown(list);
  const box = boundsOf(list);
  const wide = list.filter((line) => fullWidth(line, box.width));
  const narrow = list.filter((line) => !fullWidth(line, box.width));
  if (wide.length && narrow.length) {
    const strips = [];
    const marks = sortDown(wide);
    let rest = narrow;
    for (const mark of marks) {
      const above = rest.filter((line) => line.y > mark.y + 1);
      rest = rest.filter((line) => line.y <= mark.y + 1);
      if (above.length) strips.push(orderRegion(above, depth + 1));
      strips.push(sortDown([mark]));
    }
    if (rest.length) strips.push(orderRegion(rest, depth + 1));
    return strips.flat();
  }
  const gutters = findGutters(list, box);
  if (!gutters.length) return sortDown(list);
  const columns = splitAt(list, gutters);
  if (columns.length < 2) return sortDown(list);
  const widths = columns.map((column) => Math.max(...column.map((line) => line.width)));
  const bodyWidth = median(widths.filter((width) => width > box.width * 0.2)) || Math.max(...widths);
  const body = [];
  const asides = [];
  columns.forEach((column, index) => {
    const ordered = orderRegion(column, depth + 1);
    if (asideColumn(column, bodyWidth, box)) asides.push(...tag(ordered, { region: "aside", column: -1 }));
    else body.push(...tag(ordered, { region: "body", column: index }));
  });
  return [...body, ...asides];
}

/** Lines in reading order. Aside lines are tagged `region: "aside"` and follow the body. */
export function xyCutOrder(lines, { width = 0, height = 0 } = {}) {
  const list = (Array.isArray(lines) ? lines : []).filter((line) => line && String(line.text || "").trim());
  if (list.length < 2) return list.map((line) => ({ ...line }));
  void width;
  void height;
  const footnotes = [];
  const body = [];
  for (const line of list) {
    if (line.region === "footnote" || line.footnote === true) footnotes.push({ ...line, region: "footnote" });
    else body.push({ ...line, region: line.region === "aside" ? "aside" : "body" });
  }
  const ordered = orderRegion(splitStitched(body), 0);
  const notes = sortDown(footnotes);
  return [...ordered, ...notes];
}
