/**
 * Decisions the review page must share with tests: missing-PDF lock,
 * merge and equation-number edits, the inspector list, and Chinese import errors.
 */
import { unitIdFromMembers } from "./label-schema.js";

export function reviewActionsLocked(pdfMissing) {
  return pdfMissing === true;
}

/** pdf.js rejects an in-flight render when a newer paint destroys the page. */
export function isRenderingCancelled(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || error || "");
  return name === "RenderingCancelledException" || message.includes("RenderingCancelledException") || message.includes("Rendering cancelled");
}

export function missingPdfBanner(paperId) {
  return `缺少 PDF 文件 corpus/pdfs/${paperId}.pdf，这一单元不能复核，确认和改标签都已停用。请用浏览器打开 corpus/manifest.json 里该篇的链接，把 PDF 手动保存为这个文件名；若文件在别的目录，再运行 node scripts/corpus-fetch.mjs --import <目录>。出版商若返回 Client Challenge 页面，请不要改请求头，用浏览器自己下载。`;
}

export function chineseLabelIssue(issue) {
  const text = String(issue || "");
  let match = text.match(/^element (\d+) id does not match char\/font\/bbox$/);
  if (match) return `第 ${match[1]} 个元素的编号和字符、字体或框对不上`;
  match = text.match(/^element (\d+) kind$/);
  if (match) return `第 ${match[1]} 个元素的种类不对`;
  match = text.match(/^element (\d+) label$/);
  if (match) return `第 ${match[1]} 个元素的标签不对`;
  match = text.match(/^element (\d+) path carries a character$/);
  if (match) return `第 ${match[1]} 个路径元素不该带有字符`;
  match = text.match(/^element (\d+) duplicate id /);
  if (match) return `第 ${match[1]} 个元素的编号重复`;
  match = text.match(/^element (\d+) formula without unit$/);
  if (match) return `第 ${match[1]} 个公式元素没有单元`;
  match = text.match(/^element (\d+) unit type$/);
  if (match) return `第 ${match[1]} 个元素的单元类型不对`;
  match = text.match(/^element (\d+) equation number flag$/);
  if (match) return `第 ${match[1]} 个元素的公式编号标记不对`;
  match = text.match(/^element (\d+) non-formula has unit /);
  if (match) return `第 ${match[1]} 个非公式元素不该有单元`;
  if (text === "schema") return "文件的 schema 不对";
  if (text === "page") return "页码不对";
  if (text === "elements") return "缺少元素列表";
  if (text === "units") return "缺少单元列表";
  if (text.startsWith("ordinal gap")) return "同一指纹的序号不连续";
  if (text === "unit id") return "有单元缺少编号";
  match = text.match(/^duplicate unit /);
  if (match) return "单元编号重复";
  match = text.match(/^unit (\S+) type$/);
  if (match) return `单元 ${match[1]} 的类型不对`;
  match = text.match(/^unit (\S+) equation flag$/);
  if (match) return `单元 ${match[1]} 的公式编号标记不对`;
  match = text.match(/^unit (\S+) empty$/);
  if (match) return `单元 ${match[1]} 是空的`;
  match = text.match(/^unit (\S+) id drift$/);
  if (match) return `单元 ${match[1]} 的编号和成员对不上`;
  match = text.match(/^unit (\S+) missing /);
  if (match) return `单元 ${match[1]} 引用了不存在的元素`;
  match = text.match(/^unit (\S+) member /);
  if (match) return `单元 ${match[1]} 的成员和元素不一致`;
  match = text.match(/^formula (\S+) unit /);
  if (match) return "有公式元素的单元不在单元列表里";
  return "";
}

export function importRejection(issues) {
  const first = Array.isArray(issues) ? issues[0] : issues;
  const chinese = chineseLabelIssue(first) || "文件没有通过编号校验";
  return `导入被拒绝：${chinese}。请用本页「导出」得到的 JSON，不要手改元素编号、字符或框。`;
}

const EQ_NUMBER = /^\(\d{1,3}(\.\d+)?[a-z]?\)$/;

export function selectionKey(selectedIds) {
  const ids = selectedIds instanceof Set ? [...selectedIds] : [...(selectedIds || [])];
  return ids.map(String).sort().join(",");
}

/** Enter must not record a review when the last merge or split failed on this selection. */
export function confirmBlocked(notice, selectedIds) {
  if (!notice || notice.ok !== false || !notice.selectionKey) return false;
  return notice.selectionKey === selectionKey(selectedIds);
}

function asSet(selectedIds) {
  return selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
}

function joinable(element) {
  if (!element) return false;
  const kind = element.kind || "glyph";
  return kind === "glyph" || kind === "path";
}

function charsOf(elements) {
  const text = elements.map((element) => element.char || (element.kind === "path" ? "路径" : "空")).join("");
  return text || "空";
}

function sameLine(a, b) {
  const boxA = a?.bbox || [0, 0, 0, 0];
  const boxB = b?.bbox || [0, 0, 0, 0];
  const midA = (Number(boxA[1]) + Number(boxA[3])) / 2;
  const midB = (Number(boxB[1]) + Number(boxB[3])) / 2;
  const height = Math.max(Number(boxA[3]) - Number(boxA[1]), Number(boxB[3]) - Number(boxB[1]), 0);
  return Math.abs(midA - midB) <= Math.max(4, height * 0.92);
}

function unionBox(elements) {
  const boxes = elements.map((element) => element.bbox).filter((box) => Array.isArray(box) && box.length >= 4);
  if (!boxes.length) return [0, 0, 0, 0];
  return [
    Math.min(...boxes.map((box) => box[0])),
    Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])),
    Math.max(...boxes.map((box) => box[3]))
  ];
}

function horizontalGap(left, right) {
  return Math.max(0, Math.max(left[0], right[0]) - Math.min(left[2], right[2]));
}

function isEquationNumberGlyph(element) {
  const text = String(element?.char || "").replace(/\s+/g, "");
  return element?.equationNumber === true
    || element?.rule === "equation-number"
    || element?.rule === "eq-number-candidate"
    || EQ_NUMBER.test(text);
}

/**
 * Group formula elements that share a unit id and recompute that id from
 * the members. Non-formula elements lose any unit fields.
 */
export function rebuildFormulaUnits(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const groups = new Map();
  for (const element of list) {
    if (!element || element.label !== "formula") {
      if (element) {
        element.unitId = null;
        element.unitType = null;
        element.equationNumber = false;
      }
      continue;
    }
    if (!element.unitId) element.unitId = `tmp-${element.id}`;
    if (element.unitType !== "display" && element.unitType !== "inline") element.unitType = "inline";
    element.equationNumber = element.equationNumber === true;
    if (!groups.has(element.unitId)) groups.set(element.unitId, []);
    groups.get(element.unitId).push(element);
  }
  const units = [];
  for (const members of groups.values()) {
    const id = unitIdFromMembers(members.map((member) => member.id));
    const type = members.some((member) => member.unitType === "display") ? "display" : "inline";
    const equationNumber = members.some((member) => member.equationNumber === true);
    const confidence = Math.min(...members.map((member) => Number(member.confidence) || 0));
    for (const member of members) {
      member.unitId = id;
      member.unitType = type;
      member.equationNumber = member.equationNumber === true && equationNumber;
    }
    units.push({
      id,
      type,
      equationNumber,
      confidence: Math.round(confidence * 1000) / 1000,
      fallback: confidence < 0.65,
      elementIds: members.map((member) => member.id)
    });
  }
  return units;
}

/**
 * A drag selection plus m means exactly these elements are one unit.
 * Text and path pieces become formula. Unselected members of a touched
 * unit stay behind as their own unit. That remainder is not an error.
 */
const MATH_OPERATOR_NAMES = new Set([
  "max", "min", "sup", "inf", "lim", "liminf", "limsup",
  "arg", "argmax", "argmin",
  "log", "ln", "lg", "exp",
  "sin", "cos", "tan", "cot", "sec", "csc",
  "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh",
  "det", "dim", "ker", "deg", "gcd", "lcm", "ppcm", "pgcd", "mod",
  "tr", "Tr", "diag", "rank", "sgn", "sign",
  "Pr", "Var", "Cov", "Corr", "var", "cov",
  "span", "Re", "Im", "erf", "Id",
  "s.t.", "i.i.d.", "a.e."
]);

function isMathOperatorName(token) {
  const bare = token.endsWith(".") ? token.slice(0, -1) : token;
  if (MATH_OPERATOR_NAMES.has(token) || MATH_OPERATOR_NAMES.has(bare) || MATH_OPERATOR_NAMES.has(`${bare}.`)) return true;
  const lower = bare.toLowerCase();
  return lower !== bare && MATH_OPERATOR_NAMES.has(lower);
}

/**
 * Ordinary words in a text run. Operator names (max, Cov, i.i.d.) are not
 * prose, with or without a following "(". A name glued to "(" stays a
 * symbol too, like softmax(. Single letters are not prose.
 */
export function proseTextWords(text) {
  const words = [];
  const source = String(text || "");
  const pattern = /[A-Za-z]+(?:\.[A-Za-z]+)*\.?/g;
  let match = pattern.exec(source);
  while (match) {
    const token = match[0];
    const after = source[match.index + token.length] || "";
    const bare = token.endsWith(".") && !isMathOperatorName(token) ? token.slice(0, -1) : token;
    if (bare.length > 1 && after !== "(" && !isMathOperatorName(bare) && !isMathOperatorName(token)) words.push(bare);
    match = pattern.exec(source);
  }
  return words;
}

export function isWideProseText(element) {
  if (!element || element.label !== "text") return false;
  return proseTextWords(element.char).length > 0;
}

function boxWidth(box) {
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.max(0, Number(box[2]) - Number(box[0]));
}

export function planMerge(elements, selectedIds) {
  const selected = asSet(selectedIds);
  const list = Array.isArray(elements) ? elements : [];
  const chosen = list.filter((element) => selected.has(element.id) && joinable(element));
  if (chosen.length < 2) {
    return {
      ok: false,
      changed: false,
      message: "请先拖出方框，框住要合成一个单元的元素，再按 m。只点中一个字形不会合并。"
    };
  }
  const prose = chosen.filter((element) => isWideProseText(element));
  if (prose.length) {
    const formulaWidth = boxWidth(unionBox(chosen.filter((element) => !isWideProseText(element))));
    const names = prose.map((element) => {
      const text = String(element.char || "空").replace(/\s+/g, " ").trim() || "空";
      return `「${text.slice(0, 28)}」`;
    }).join("、");
    const wider = prose.some((element) => formulaWidth > 0 && boxWidth(element.bbox) > formulaWidth);
    const widthNote = wider ? "这些正文比旁边的公式宽，" : "";
    return {
      ok: false,
      changed: false,
      message: `${widthNote}选区里有整段正文，没有改成公式：${names}。请用 Ctrl 或 Cmd 点击，或按住 Alt 拖动，把它们从选区去掉，然后再按 m。`
    };
  }
  const formulaIds = new Set(chosen.filter((element) => element.label === "formula" && element.unitId).map((element) => element.unitId));
  const hasNonFormula = chosen.some((element) => element.label !== "formula");
  if (!hasNonFormula && formulaIds.size === 1) {
    const unitId = [...formulaIds][0];
    const members = list.filter((element) => element.label === "formula" && element.unitId === unitId);
    if (members.length === chosen.length && members.every((element) => selected.has(element.id))) {
      return { ok: true, changed: false, message: "选中的元素已经是同一个单元。" };
    }
  }
  const typed = chosen.filter((element) => element.unitType === "display" || element.unitType === "inline");
  const unitType = typed.some((element) => element.unitType === "display") ? "display" : "inline";
  const remainders = [];
  for (const unitId of formulaIds) {
    const left = list.filter((element) => element.label === "formula" && element.unitId === unitId && !selected.has(element.id));
    if (left.length) remainders.push(left);
  }
  const memberIds = chosen.map((element) => element.id);
  let message = `已合并 ${memberIds.length} 个元素为 1 个单元`;
  if (remainders.length) {
    message += remainders.map((left) => `；原单元剩余 ${left.length} 个元素（${charsOf(left)}）`).join("");
  }
  return {
    ok: true,
    changed: true,
    message,
    memberIds,
    unitType,
    temporaryId: `merge:${memberIds.slice().sort().join(",")}`
  };
}

export function applyMerge(elements, selectedIds) {
  const plan = planMerge(elements, selectedIds);
  if (!plan.ok || !plan.changed) return plan;
  const members = new Set(plan.memberIds);
  for (const element of elements) {
    if (!members.has(element.id)) continue;
    if (element.label !== "formula") {
      element.label = "formula";
      element.confidence = 1;
      element.rule = "human";
      element.equationNumber = false;
    }
    if (typeof element.equationNumber !== "boolean") element.equationNumber = false;
    element.unitId = plan.temporaryId;
    element.unitType = plan.unitType;
  }
  return { ...plan, units: rebuildFormulaUnits(elements) };
}

export function planSplit(elements, selectedIds) {
  const selected = asSet(selectedIds);
  const list = Array.isArray(elements) ? elements : [];
  const chosen = list.filter((element) => selected.has(element.id) && element.label === "formula");
  if (!chosen.length) {
    return { ok: false, changed: false, message: "没有可拆开的公式元素。请先选中公式字形再按 s。" };
  }
  const byUnit = new Map();
  for (const element of chosen) {
    if (!byUnit.has(element.unitId)) byUnit.set(element.unitId, []);
    byUnit.get(element.unitId).push(element);
  }
  const peelIds = [];
  const atomIds = [];
  let leftCount = 0;
  for (const [unitId, members] of byUnit) {
    const all = list.filter((element) => element.label === "formula" && element.unitId === unitId);
    if (all.length <= 1) continue;
    if (members.length === all.length) {
      atomIds.push(...members.map((element) => element.id));
      continue;
    }
    peelIds.push(members.map((element) => element.id));
    leftCount += all.length - members.length;
  }
  if (!peelIds.length && !atomIds.length) return { ok: true, changed: false, message: "选中的元素已经各自成单元。" };
  const peeled = peelIds.reduce((sum, group) => sum + group.length, 0);
  let message = "";
  if (peelIds.length) message = `已把选中的 ${peeled} 个元素拆成 ${peelIds.length} 个行内单元，原单元留下 ${leftCount} 个元素`;
  if (atomIds.length) {
    const atomMessage = `已把 ${atomIds.length} 个元素拆成各自的单元`;
    message = message ? `${message}。${atomMessage}` : atomMessage;
  }
  return {
    ok: true,
    changed: true,
    ids: [...atomIds, ...peelIds.flat()],
    peelIds,
    atomIds,
    message
  };
}

export function applySplit(elements, selectedIds) {
  const plan = planSplit(elements, selectedIds);
  if (!plan.ok || !plan.changed) return plan;
  const atom = new Set(plan.atomIds || []);
  const peelOf = new Map();
  for (const group of plan.peelIds || []) {
    const temporaryId = `split:${group.slice().sort().join(",")}`;
    for (const id of group) peelOf.set(id, temporaryId);
  }
  for (const element of elements) {
    if (atom.has(element.id)) element.unitId = `split:${element.id}`;
    else if (peelOf.has(element.id)) {
      element.unitId = peelOf.get(element.id);
      element.unitType = "inline";
    }
  }
  return { ...plan, units: rebuildFormulaUnits(elements) };
}

function hostUnit(elements, chosen) {
  const chosenIds = new Set(chosen.map((element) => element.id));
  const groups = new Map();
  for (const element of elements) {
    if (element?.label !== "formula" || !element.unitId || chosenIds.has(element.id)) continue;
    if (!chosen.some((item) => sameLine(item, element))) continue;
    if (!groups.has(element.unitId)) groups.set(element.unitId, []);
    groups.get(element.unitId).push(element);
  }
  const chosenBox = unionBox(chosen);
  const ranked = [...groups.entries()].map(([unitId, members]) => ({
    unitId,
    members,
    display: members.some((member) => member.unitType === "display"),
    gap: horizontalGap(chosenBox, unionBox(members))
  }));
  ranked.sort((a, b) => Number(b.display) - Number(a.display) || a.gap - b.gap || a.unitId.localeCompare(b.unitId));
  return ranked[0] || null;
}

/**
 * e on a lone (1) attaches it to the formula unit on the same line and
 * marks only those glyphs as the equation number. e on glyphs already
 * inside that unit toggles the flag. The unit flag is true when any
 * member is an equation number, matching the pre-labeler.
 */
export function planEquationNumber(elements, selectedIds) {
  const selected = asSet(selectedIds);
  const list = Array.isArray(elements) ? elements : [];
  const chosen = list.filter((element) => selected.has(element.id) && joinable(element));
  if (!chosen.length) {
    return { ok: false, changed: false, message: "请先选中公式编号，例如 (1)，再按 e。" };
  }
  const host = hostUnit(list, chosen);
  const chosenIds = new Set(chosen.map((element) => element.id));
  const properSubset = host
    && chosen.every((element) => element.label === "formula" && element.unitId === host.unitId)
    && host.members.some((member) => !chosenIds.has(member.id));
  if (properSubset) {
    const turningOn = !chosen.every((element) => element.equationNumber === true);
    return {
      ok: true,
      changed: true,
      action: "toggle",
      ids: [...chosenIds],
      equationNumber: turningOn,
      message: turningOn ? "已把选中的字形标成公式编号。" : "已取消这些字形的公式编号。"
    };
  }
  if (host && chosen.every((element) => isEquationNumberGlyph(element))) {
    return {
      ok: true,
      changed: true,
      action: "attach",
      ids: [...chosenIds],
      hostUnitId: host.unitId,
      hostType: host.display ? "display" : (host.members[0]?.unitType === "inline" ? "inline" : "display"),
      message: `已把 ${charsOf(chosen)} 标成公式编号，并入旁边的单元`
    };
  }
  const formulas = chosen.filter((element) => element.label === "formula");
  if (formulas.length === chosen.length) {
    const turningOn = !formulas.every((element) => element.equationNumber === true);
    return {
      ok: true,
      changed: true,
      action: "toggle",
      ids: formulas.map((element) => element.id),
      equationNumber: turningOn,
      message: turningOn ? "已把选中的整式标成公式编号。" : "已取消公式编号。"
    };
  }
  return {
    ok: false,
    changed: false,
    message: "请只选中 (1) 这样的编号再按 e。它会并进同一行旁边的公式单元，并且只有编号标成公式编号。"
  };
}

export function applyEquationNumber(elements, selectedIds) {
  const plan = planEquationNumber(elements, selectedIds);
  if (!plan.ok || !plan.changed) return plan;
  const ids = new Set(plan.ids);
  for (const element of elements) {
    if (!ids.has(element.id)) continue;
    if (plan.action === "attach") {
      element.label = "formula";
      element.rule = "equation-number";
      element.confidence = 1;
      element.equationNumber = true;
      element.unitId = plan.hostUnitId;
      element.unitType = plan.hostType || "display";
    } else if (plan.action === "toggle") {
      if (element.label !== "formula") continue;
      element.equationNumber = plan.equationNumber === true;
    }
  }
  return { ...plan, units: rebuildFormulaUnits(elements) };
}

/** Every selected element, grouped by unit. Nothing is truncated. */
export function inspectorModel(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const groups = [];
  const byUnit = new Map();
  for (const element of list) {
    const key = element?.unitId || "";
    if (!byUnit.has(key)) {
      const group = { unitId: key, type: "", equationNumber: false, rows: [] };
      byUnit.set(key, group);
      groups.push(group);
    }
    const group = byUnit.get(key);
    if (element?.unitType === "display") group.type = "display";
    else if (!group.type && element?.unitType === "inline") group.type = "inline";
    if (element?.equationNumber === true) group.equationNumber = true;
    group.rows.push({
      id: element?.id || "",
      char: element?.char ?? "",
      label: element?.label || "",
      unitId: element?.unitId || "",
      equationNumber: element?.equationNumber === true
    });
  }
  return { count: list.length, groups };
}

/**
 * Map a review-set unit onto the page as it is now. Original element ids
 * may have moved into a larger unit, split apart, or been relabeled.
 * The review-set unit id itself is not rewritten.
 */
export function selectionForReviewUnit(elements, originalElementIds, reviewUnitId = "") {
  const list = Array.isArray(elements) ? elements : [];
  const byId = new Map(list.map((element) => [element?.id, element]));
  const wantedUnits = new Set();
  const loose = new Set();
  for (const id of originalElementIds || []) {
    const element = byId.get(id);
    if (!element) continue;
    if (element.label === "formula" && element.unitId) wantedUnits.add(element.unitId);
    else loose.add(element.id);
  }
  const ids = [];
  const nonFormulaIds = [];
  const unitIds = [];
  const seenUnits = new Set();
  let equationNumber = false;
  for (const element of list) {
    const inUnit = element?.label === "formula" && element.unitId && wantedUnits.has(element.unitId);
    if (inUnit && !seenUnits.has(element.unitId)) {
      seenUnits.add(element.unitId);
      unitIds.push(element.unitId);
    }
    if (!inUnit && !loose.has(element?.id)) continue;
    ids.push(element.id);
    if (element.label !== "formula") nonFormulaIds.push(element.id);
    if (element.equationNumber === true) equationNumber = true;
  }
  const originalSet = new Set((originalElementIds || []).map(String));
  const sameMembers = ids.length === originalSet.size && ids.every((id) => originalSet.has(String(id)));
  const spanned = unitIds.length > 1;
  const changed = !sameMembers || nonFormulaIds.length > 0 || spanned
    || (reviewUnitId && unitIds.length === 1 && unitIds[0] !== reviewUnitId);
  return {
    ids,
    unitIds,
    nonFormulaIds,
    spanned,
    changed,
    equationNumber,
    count: ids.length
  };
}

export function formatQueueStatus({
  reviewedCount = 0,
  reviewTotal = 0,
  reviewed = false,
  changed = false,
  unitIds = [],
  elementCount = 0,
  equationNumber = false,
  spanned = false,
  nonFormulaCount = 0
} = {}) {
  const countLine = `队列已复核 ${reviewedCount}/${reviewTotal}`;
  let statusLine = reviewed ? "已复核" : "未复核";
  if (!reviewed && changed) statusLine += " · 已改过，尚未确认";
  if ((reviewed || changed) && elementCount) {
    if (spanned) statusLine += ` · 当前 ${unitIds.length} 个单元 · ${elementCount} 个元素`;
    else if (unitIds.length === 1) statusLine += ` · 当前单元 ${unitIds[0]} · ${elementCount} 个元素`;
    else statusLine += ` · ${elementCount} 个元素`;
    if (equationNumber) statusLine += "（含公式编号）";
    if (nonFormulaCount) statusLine += ` · ${nonFormulaCount} 个已不是公式`;
    if (spanned) statusLine += " · 原单元现在分成多个单元";
  }
  return { countLine, statusLine };
}

export const CURRENT_UNIT_RED = "#b00000";

function hasId(collection, id) {
  if (!collection || id == null) return false;
  if (typeof collection.has === "function") return collection.has(id);
  return Array.isArray(collection) && collection.includes(id);
}

/**
 * Unit-queue mode paints only the queue unit in red. A manual selection is
 * orange, and every other mark stays grey. Page mode keeps per-unit colours.
 */
export function overlayRole({
  mode = "units",
  elementId,
  currentIds,
  selectedIds,
  queuedIds
} = {}) {
  const selected = hasId(selectedIds, elementId);
  if (mode !== "units") return selected ? "picked" : "page";
  if (hasId(currentIds, elementId)) return "current";
  if (selected) return "picked";
  if (hasId(queuedIds, elementId)) return "queued";
  return "neutral";
}

export function overlayClass(input = {}) {
  const role = overlayRole(input);
  const parts = ["hit"];
  if (input.label) parts.push(input.label);
  if (input.mode !== "units" && input.uncertain) parts.push("uncertain");
  if (role !== "page") parts.push(role);
  return parts.join(" ");
}

/** Per-unit stroke for page mode. Hues stay out of the current-unit red. */
export function pageUnitColor(index) {
  const start = 28;
  const span = 292;
  const step = ((Number(index) || 0) % 100000 + 100000) % 100000;
  const hue = start + (step * 47) % span;
  return `hsl(${hue} 58% 40%)`;
}

export function isTaskRed(color) {
  const raw = String(color || "").trim().toLowerCase();
  const compact = raw.replace(/\s+/g, "");
  if (compact === CURRENT_UNIT_RED || compact === "rgb(176,0,0)") return true;
  const match = raw.match(/^hsl\(\s*([0-9.]+)/);
  if (!match) return false;
  const hue = Number(match[1]) % 360;
  return hue < 16 || hue > 344;
}

/**
 * Other review-set units on this page, in current membership.
 * Members that now belong to the open queue unit are left out.
 */
export function otherQueueMarks({ units, paperId, page, elements, currentReviewUnitId } = {}) {
  const list = Array.isArray(units) ? units : [];
  const pageNumber = Number(page);
  const byId = new Map((elements || []).map((element) => [element?.id, element]));
  const current = list.find((unit) => unit?.paperId === paperId && Number(unit.page) === pageNumber && unit.unitId === currentReviewUnitId);
  const blocked = new Set();
  if (current) {
    for (const id of selectionForReviewUnit(elements, current.elementIds, current.unitId).unitIds) blocked.add(id);
  }
  const marks = [];
  for (let index = 0; index < list.length; index += 1) {
    const unit = list[index];
    if (!unit || unit.paperId !== paperId || Number(unit.page) !== pageNumber) continue;
    if (unit.unitId === currentReviewUnitId) continue;
    const mapped = selectionForReviewUnit(elements, unit.elementIds, unit.unitId);
    const elementIds = mapped.ids.filter((id) => {
      const element = byId.get(id);
      return element && !(element.unitId && blocked.has(element.unitId));
    });
    if (!elementIds.length) continue;
    marks.push({ queueNumber: index + 1, reviewUnitId: unit.unitId, elementIds });
  }
  return marks;
}

export const EXTRA_SELECTION_HEADING = "选区里还有这些（不属于当前单元）";
export const ZOOM_MIN = 0.8;
export const ZOOM_MAX = 4;

/**
 * Drag selection keeps an element when its centre is inside the rectangle
 * and at least 60% of its area is inside. A box that sits fully inside,
 * such as a subscript, is kept even when it is tiny.
 */
export function dragSelectsElement(bbox, rect, { minFraction = 0.6 } = {}) {
  if (!Array.isArray(bbox) || bbox.length < 4 || !Array.isArray(rect) || rect.length < 4) return false;
  const [x0, y0, x1, y1] = bbox.map(Number);
  const [rx0, ry0, rx1, ry1] = rect.map(Number);
  const fully = x0 >= rx0 && y0 >= ry0 && x1 <= rx1 && y1 <= ry1;
  if (fully) return true;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const center = cx >= rx0 && cx <= rx1 && cy >= ry0 && cy <= ry1;
  if (!center) return false;
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const area = width * height;
  if (area <= 0) return true;
  const overlapWidth = Math.max(0, Math.min(x1, rx1) - Math.max(x0, rx0));
  const overlapHeight = Math.max(0, Math.min(y1, ry1) - Math.max(y0, ry0));
  return (overlapWidth * overlapHeight) / area >= minFraction - 1e-9;
}

export function pageRectFromPointer(start, end, scale) {
  const factor = Number(scale) > 0 ? Number(scale) : 1;
  const x0 = Math.min(start.x, end.x) / factor;
  const y0 = Math.min(start.y, end.y) / factor;
  const x1 = Math.max(start.x, end.x) / factor;
  const y1 = Math.max(start.y, end.y) / factor;
  return [x0, y0, x1, y1];
}

export function nextDragSelection(selectedIds, hitIds, { shift = false, alt = false } = {}) {
  const selected = new Set(selectedIds || []);
  if (alt) {
    for (const id of hitIds || []) selected.delete(id);
    return [...selected];
  }
  const next = shift ? new Set(selected) : new Set();
  for (const id of hitIds || []) next.add(id);
  return [...next];
}

export function nextClickSelection(selectedIds, id, { shift = false, toggle = false } = {}) {
  const selected = new Set(selectedIds || []);
  if (!id) return [...selected];
  if (toggle || shift) {
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return [...selected];
  }
  return [id];
}

export function clampZoom(value) {
  const stepped = Math.round(Number(value) * 10) / 10;
  if (!Number.isFinite(stepped)) return 1.25;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped));
}

/** Scale so the unit width is about half the viewport, never above 400%. */
export function zoomToFitWidth(elements, viewportWidth) {
  const box = unionBox(elements || []);
  const width = Math.max(1, box[2] - box[0]);
  const view = Math.max(1, Number(viewportWidth) || 1);
  return clampZoom((view * 0.5) / width);
}

export function selectionAside(elements, currentIds) {
  const current = currentIds instanceof Set ? currentIds : new Set(currentIds || []);
  const inside = [];
  const extra = [];
  for (const element of elements || []) {
    if (current.size && !current.has(element?.id)) extra.push(element);
    else inside.push(element);
  }
  return { inside: inspectorModel(inside), extra: inspectorModel(extra) };
}
