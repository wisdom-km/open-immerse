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

const LIGATURE_ASCII = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl"
};

function expandLigatures(text) {
  return String(text || "").replace(/[\uFB00-\uFB04]/g, (ch) => LIGATURE_ASCII[ch]);
}

/**
 * A radical bar is sometimes mapped to a run of ffi/ff/fi ligature
 * fragments, such as ffiffiffi. One real fragment (fi, ffi) stays a word.
 * Two or more fragments, and only those fragments, are not a word.
 */
function isRepeatedLigature(token) {
  if (!/^(?:ffi|ffl|ff|fi|fl)+$/.test(token)) return false;
  return token.match(/ffi|ffl|ff|fi|fl/g).length >= 2;
}

/**
 * Ordinary words in a text run. Operator names (max, Cov, i.i.d.) are not
 * prose, with or without a following "(". A name glued to "(" stays a
 * symbol too, like softmax(. Single letters are not prose. A repeated
 * ligature fragment (ffiffiffi, or U+FB00–U+FB04) is not prose either.
 * Callers still have to ignore this list when the font itself is a
 * math-symbol font; see isMathSymbolFont.
 */
export function proseTextWords(text) {
  const words = [];
  const source = expandLigatures(text);
  const pattern = /[A-Za-z]+(?:\.[A-Za-z]+)*\.?/g;
  let match = pattern.exec(source);
  while (match) {
    const token = match[0];
    const after = source[match.index + token.length] || "";
    const bare = token.endsWith(".") && !isMathOperatorName(token) ? token.slice(0, -1) : token;
    if (isRepeatedLigature(bare) || isRepeatedLigature(token)) {
      match = pattern.exec(source);
      continue;
    }
    if (bare.length > 1 && after !== "(" && !isMathOperatorName(bare) && !isMathOperatorName(token)) words.push(bare);
    match = pattern.exec(source);
  }
  return words;
}

/**
 * Fonts that draw operators, radicals, and big delimiters. ToUnicode
 * often turns a bar or a brace into letter junk (fflffl…, gi, g þ Gf).
 * That junk belongs to the formula. Body fonts such as Calibri and
 * MinionPro are not on this list, so a real sentence stays prose.
 */
export function isMathSymbolFont(font) {
  const name = String(font || "");
  if (/^AdvMacMth/i.test(name)) return true;
  if (/^AdvP4C4E/i.test(name)) return true;
  if (/^CM(?:EX|SY|MI)/i.test(name)) return true;
  if (/Math-?Extension|Math-?Symbols?/i.test(name)) return true;
  return false;
}

export function isWideProseText(element) {
  if (!element || element.label !== "text") return false;
  if (isMathSymbolFont(element.font)) return false;
  return proseTextWords(element.char).length > 0;
}

function boxWidth(box) {
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.max(0, Number(box[2]) - Number(box[0]));
}

function boxHeight(box) {
  if (!Array.isArray(box) || box.length < 4) return 0;
  return Math.max(0, Number(box[3]) - Number(box[1]));
}

function medianNumber(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

// A text subscript is shorter than the glyphs around it. 0.8 lets a 6pt
// word such as "sites" join a 9pt formula, and leaves a normal-size word.
const FORMULA_WORD_HEIGHT_RATIO = 0.8;

function isLetterGlyph(element) {
  const kind = element?.kind || "glyph";
  return kind === "glyph" && boxWidth(element.bbox) > 0 && boxHeight(element.bbox) > 0;
}

/**
 * One word that belongs inside the formula being merged. The trimmed
 * text has no spaces, and either the glyph is clearly shorter than the
 * other selected glyphs, or other non-prose glyphs sit on both sides.
 * Rules and page-tall strokes are not glyphs, so they do not set the
 * median and do not count as a side. A multi-word line, or a normal-size
 * word parked outside the formula, stays prose.
 */
export function isFormulaTextWord(element, chosen) {
  const text = String(element?.char || "").trim();
  if (!text || /\s/.test(text)) return false;
  const others = (Array.isArray(chosen) ? chosen : []).filter((item) => item && item !== element && item.id !== element.id);
  const glyphs = others.filter(isLetterGlyph);
  if (!glyphs.length || !Array.isArray(element?.bbox)) return false;
  const height = boxHeight(element.bbox);
  const peerHeights = glyphs.map((item) => boxHeight(item.bbox));
  const mid = medianNumber(peerHeights);
  if (mid > 0 && height > 0 && height < FORMULA_WORD_HEIGHT_RATIO * mid) return true;
  const peers = glyphs.filter((item) => !isWideProseText(item));
  if (!peers.length) return false;
  const box = unionBox(peers);
  const left = Number(element.bbox[0]);
  const right = Number(element.bbox[2]);
  return left > box[0] && right < box[2];
}

export function planMerge(elements, selectedIds) {
  const list = Array.isArray(elements) ? elements : [];
  const selected = new Set(expandPairIds(list, asSet(selectedIds)));
  const chosen = list.filter((element) => selected.has(element.id) && joinable(element));
  if (chosen.length < 2) {
    return {
      ok: false,
      changed: false,
      message: "请先拖出方框，框住要合成一个单元的元素，再按 m。只点中一个字形不会合并。"
    };
  }
  const prose = chosen.filter((element) => isWideProseText(element) && !isFormulaTextWord(element, chosen));
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
  const list = Array.isArray(elements) ? elements : [];
  const selected = new Set(expandPairIds(list, asSet(selectedIds)));
  const pairs = extensionDelimiterPairs(list);
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
  const gluedIds = [];
  let leftCount = 0;
  for (const [unitId, members] of byUnit) {
    const all = list.filter((element) => element.label === "formula" && element.unitId === unitId);
    if (all.length <= 1) continue;
    if (members.length === all.length) {
      const groups = pairGroupsAmong(members, pairs);
      const paired = new Set(groups.flat());
      const singles = members.filter((element) => !paired.has(element.id)).map((element) => element.id);
      if (!singles.length && groups.length <= 1) continue;
      atomIds.push(...singles);
      if (singles.length || groups.length > 1) gluedIds.push(...groups);
      continue;
    }
    peelIds.push(members.map((element) => element.id));
    leftCount += all.length - members.length;
  }
  if (!peelIds.length && !atomIds.length && !gluedIds.length) return { ok: true, changed: false, message: "选中的元素已经各自成单元。" };
  const peeled = peelIds.reduce((sum, group) => sum + group.length, 0);
  let message = "";
  if (peelIds.length) message = `已把选中的 ${peeled} 个元素拆成 ${peelIds.length} 个行内单元，原单元留下 ${leftCount} 个元素`;
  if (atomIds.length) {
    const atomMessage = `已把 ${atomIds.length} 个元素拆成各自的单元`;
    message = message ? `${message}。${atomMessage}` : atomMessage;
  }
  if (gluedIds.length) {
    const gluedMessage = `成对的 ${gluedIds.length} 组元素仍各是一个单元`;
    message = message ? `${message}。${gluedMessage}` : gluedMessage;
  }
  return {
    ok: true,
    changed: true,
    ids: [...atomIds, ...peelIds.flat(), ...gluedIds.flat()],
    peelIds,
    atomIds,
    gluedIds,
    message
  };
}

function pairGroupsAmong(members, pairs) {
  const ids = new Set(members.map((element) => element.id));
  const groups = [];
  for (const pair of pairs) {
    const inkIds = pairInkIds(pair);
    if (ids.has(pair.glyphId) && inkIds.length && inkIds.every((id) => ids.has(id))) groups.push([pair.glyphId, ...inkIds]);
  }
  return groups;
}

export function applySplit(elements, selectedIds) {
  const plan = planSplit(elements, selectedIds);
  if (!plan.ok || !plan.changed) return plan;
  const atom = new Set(plan.atomIds || []);
  const peelOf = new Map();
  const gluedOf = new Map();
  for (const group of plan.peelIds || []) {
    const temporaryId = `split:${group.slice().sort().join(",")}`;
    for (const id of group) peelOf.set(id, temporaryId);
  }
  for (const group of plan.gluedIds || []) {
    const temporaryId = `split:${group.slice().sort().join(",")}`;
    for (const id of group) gluedOf.set(id, temporaryId);
  }
  for (const element of elements) {
    if (atom.has(element.id)) element.unitId = `split:${element.id}`;
    else if (peelOf.has(element.id)) {
      element.unitId = peelOf.get(element.id);
      element.unitType = "inline";
    } else if (gluedOf.has(element.id)) element.unitId = gluedOf.get(element.id);
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
  const list = Array.isArray(elements) ? elements : [];
  const expanded = new Set(expandPairIds(list, asSet(selectedIds)));
  const byId = new Map(list.map((element) => [element?.id, element]));
  const selected = new Set([...expanded].filter((id) => {
    const element = byId.get(id);
    return element && (element.label === "formula" || !isUnboundInkElement(element));
  }));
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
  rebuildFormulaUnits(elements);
  const attached = attachExtensionPairs(elements, plan.ids);
  return { ...plan, units: attached.changed ? attached.units : rebuildFormulaUnits(elements) };
}

/** Every selected element, grouped by unit. Nothing is truncated. */
export function inspectorModel(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const pairedIds = new Set();
  for (const pair of extensionDelimiterPairs(list)) {
    pairedIds.add(pair.glyphId);
    for (const inkId of pairInkIds(pair)) pairedIds.add(inkId);
  }
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
      equationNumber: element?.equationNumber === true,
      paired: pairedIds.has(element?.id)
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
 * Big delimiters and operators from a math-extension font are stored as a
 * glyph box above the ink. A glyph whose char holds several delimiters,
 * such as "{(", has one ink element per delimiter. The group stays separate
 * elements, but every review action treats it as one box.
 */
const EXTENSION_FONT = /Math-?Extension|CMEX|LMMathExtension|extension/i;
const PAIR_X_FRACTION = 0.5;
const PAIR_TOP_GAP = 4;
const DELIMITER_CHARS = new Set(["(", ")", "[", "]", "{", "}", "⟨", "⟩", "⌊", "⌋", "⌈", "⌉", "|", "‖"]);

export const PAIR_SPLIT_NOTICE = "这一对大括号或大算符只有一块在当前单元里，另一块没能自动补进来。请把字形和它的墨迹选在一起，再按 Enter。";

function finiteBox(element) {
  const box = element?.bbox;
  if (!Array.isArray(box) || box.length < 4) return null;
  if (box.some((value) => !Number.isFinite(Number(value)))) return null;
  return box;
}

function isExtensionDelimiterGlyph(element) {
  if (!element || element.kind === "path" || element.kind === "image") return false;
  if (!String(element.char ?? "")) return false;
  return EXTENSION_FONT.test(String(element.font || ""));
}

function isUnboundInkElement(element) {
  if (!element || element.kind === "path" || element.kind === "image") return false;
  if (String(element.char ?? "") !== "") return false;
  if (element.source === "unbound-paint") return true;
  return (element.kind || "glyph") === "glyph" && !String(element.font || "");
}

function xOverlapFraction(left, right) {
  const overlap = Math.max(0, Math.min(Number(left[2]), Number(right[2])) - Math.max(Number(left[0]), Number(right[0])));
  const narrower = Math.min(boxWidth(left), boxWidth(right));
  if (narrower <= 0) return 0;
  return overlap / narrower;
}

function pairsVertically(glyphBox, inkBox) {
  const glyphTop = Number(glyphBox[1]);
  const glyphBottom = Number(glyphBox[3]);
  const inkTop = Number(inkBox[1]);
  const inkBottom = Number(inkBox[3]);
  if (Math.abs(inkTop - glyphBottom) <= PAIR_TOP_GAP && inkBottom >= glyphBottom - 1) return true;
  const overlap = Math.min(glyphBottom, inkBottom) - Math.max(glyphTop, inkTop);
  return overlap > 0 && inkBottom >= glyphBottom - 0.5 && inkTop >= glyphTop - 2;
}

function pairScore(glyphBox, inkBox) {
  const glyphCenter = (Number(glyphBox[0]) + Number(glyphBox[2])) / 2;
  const inkCenter = (Number(inkBox[0]) + Number(inkBox[2])) / 2;
  return Math.abs(glyphCenter - inkCenter) + 0.25 * Math.abs(Number(inkBox[1]) - Number(glyphBox[3]));
}

function unionOfBoxes(left, right) {
  return [
    Math.min(Number(left[0]), Number(right[0])),
    Math.min(Number(left[1]), Number(right[1])),
    Math.max(Number(left[2]), Number(right[2])),
    Math.max(Number(left[3]), Number(right[3]))
  ];
}

/** One ink slot per delimiter character. A bare operator such as ∑ still gets one. */
function inkSlotCount(char) {
  let count = 0;
  for (const ch of String(char || "")) {
    if (DELIMITER_CHARS.has(ch)) count += 1;
  }
  return Math.max(1, count);
}

function pairInkIds(pair) {
  if (Array.isArray(pair?.inkIds) && pair.inkIds.length) return pair.inkIds;
  return pair?.inkId ? [pair.inkId] : [];
}

/**
 * Group each extension glyph with up to one empty ink element per delimiter
 * character in its char. The ink must sit inside the glyph's x-range and its
 * top within a few points of the glyph bottom (or overlap the glyph and still
 * reach that bottom). Each ink is used once. Nearest centre wins.
 */
export function extensionDelimiterPairs(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const glyphs = [];
  const inks = [];
  for (const element of list) {
    if (!element?.id || !finiteBox(element)) continue;
    if (isExtensionDelimiterGlyph(element)) glyphs.push(element);
    else if (isUnboundInkElement(element)) inks.push(element);
  }
  const slots = new Map(glyphs.map((glyph) => [glyph.id, inkSlotCount(glyph.char)]));
  const candidates = [];
  for (const glyph of glyphs) {
    for (const ink of inks) {
      const overlap = xOverlapFraction(glyph.bbox, ink.bbox);
      const inkWidth = boxWidth(ink.bbox);
      const inside = inkWidth > 0
        && Math.max(0, Math.min(Number(glyph.bbox[2]), Number(ink.bbox[2])) - Math.max(Number(glyph.bbox[0]), Number(ink.bbox[0]))) / inkWidth >= PAIR_X_FRACTION - 1e-9;
      if (overlap < PAIR_X_FRACTION - 1e-9 || !inside) continue;
      if (!pairsVertically(glyph.bbox, ink.bbox)) continue;
      candidates.push({
        score: pairScore(glyph.bbox, ink.bbox),
        glyphId: glyph.id,
        inkId: ink.id
      });
    }
  }
  candidates.sort((a, b) => a.score - b.score || a.glyphId.localeCompare(b.glyphId) || a.inkId.localeCompare(b.inkId));
  const taken = new Map();
  const usedInk = new Set();
  for (const candidate of candidates) {
    if (usedInk.has(candidate.inkId)) continue;
    const have = taken.get(candidate.glyphId) || [];
    if (have.length >= slots.get(candidate.glyphId)) continue;
    have.push(candidate.inkId);
    taken.set(candidate.glyphId, have);
    usedInk.add(candidate.inkId);
  }
  const byInk = new Map(inks.map((ink) => [ink.id, ink]));
  const pairs = [];
  for (const glyph of glyphs) {
    const inkIds = taken.get(glyph.id);
    if (!inkIds?.length) continue;
    inkIds.sort((a, b) => Number(byInk.get(a).bbox[0]) - Number(byInk.get(b).bbox[0]) || a.localeCompare(b));
    let bbox = glyph.bbox;
    for (const inkId of inkIds) bbox = unionOfBoxes(bbox, byInk.get(inkId).bbox);
    pairs.push({ glyphId: glyph.id, inkIds, inkId: inkIds[0], bbox });
  }
  return pairs;
}

export function expandPairIds(elements, ids) {
  const membersOf = new Map();
  for (const pair of extensionDelimiterPairs(elements)) {
    const members = [pair.glyphId, ...pairInkIds(pair)];
    for (const id of members) membersOf.set(id, members);
  }
  const source = ids instanceof Set ? [...ids] : [...(ids || [])];
  const next = [];
  const seen = new Set();
  for (const id of source) {
    if (!id || seen.has(id)) continue;
    const members = membersOf.get(id) || [id];
    for (const member of members) {
      if (!member || seen.has(member)) continue;
      seen.add(member);
      next.push(member);
    }
  }
  return next;
}

/** One drawn box per delimiter: the union of the glyph and its ink. */
export function reviewMarkBoxes(elements) {
  const list = Array.isArray(elements) ? elements : [];
  const pairs = extensionDelimiterPairs(list);
  const byGlyph = new Map(pairs.map((pair) => [pair.glyphId, pair]));
  const inkIds = new Set(pairs.flatMap((pair) => pairInkIds(pair)));
  const marks = [];
  for (const element of list) {
    if (!element?.id || inkIds.has(element.id)) continue;
    const pair = byGlyph.get(element.id);
    const groupInk = pair ? pairInkIds(pair) : [];
    marks.push({
      id: element.id,
      bbox: pair ? pair.bbox : element.bbox,
      paired: Boolean(pair),
      glyphId: pair ? pair.glyphId : "",
      inkId: groupInk[0] || "",
      inkIds: groupInk
    });
  }
  return marks;
}

function formulaHost(element) {
  return Boolean(element
    && element.label === "formula"
    && element.unitId
    && (element.unitType === "display" || element.unitType === "inline"));
}

function hostForSplitPair(glyph, ink, glyphIn, inkIn) {
  if (glyphIn && formulaHost(glyph)) return { host: glyph, guest: ink };
  if (inkIn && formulaHost(ink)) return { host: ink, guest: glyph };
  if (inkIn && !glyphIn && formulaHost(glyph) && ink.label !== "formula") return { host: glyph, guest: ink };
  if (glyphIn !== inkIn) return { blocked: true };
  return {};
}

/**
 * When the current unit has one side of a pair, copy that formula unit
 * onto the other side. The glyph is the host when it is already a formula.
 * Both elements stay in the data. Returns blocked when the join is not safe.
 */
export function attachExtensionPairs(elements, memberIds) {
  const list = Array.isArray(elements) ? elements : [];
  const members = memberIds instanceof Set ? memberIds : new Set(memberIds || []);
  const byId = new Map(list.map((element) => [element?.id, element]));
  const jobs = [];
  for (const pair of extensionDelimiterPairs(list)) {
    const glyph = byId.get(pair.glyphId);
    if (!glyph) continue;
    for (const inkId of pairInkIds(pair)) {
      const ink = byId.get(inkId);
      if (!ink) continue;
      const glyphIn = members.has(glyph.id);
      const inkIn = members.has(ink.id);
      if (!glyphIn && !inkIn) continue;
      if (glyph.label === "formula" && ink.label === "formula" && glyph.unitId && glyph.unitId === ink.unitId) continue;
      const job = hostForSplitPair(glyph, ink, glyphIn, inkIn);
      if (job.blocked) return { changed: false, blocked: true, units: null, message: PAIR_SPLIT_NOTICE };
      if (job.host && job.guest) jobs.push(job);
    }
  }
  if (!jobs.length) return { changed: false, blocked: false, units: null, message: "" };
  for (const { host, guest } of jobs) {
    if (guest.label === "formula" && guest.unitId === host.unitId) continue;
    if (guest.label !== "formula") {
      guest.label = "formula";
      guest.confidence = 1;
      guest.rule = "human";
      guest.equationNumber = false;
    }
    if (typeof guest.equationNumber !== "boolean") guest.equationNumber = false;
    guest.unitId = host.unitId;
    guest.unitType = host.unitType;
  }
  return { changed: true, blocked: false, units: rebuildFormulaUnits(list), message: "" };
}

/**
 * After a label or type edit, formula members of a selected pair share
 * the glyph's unit when the glyph is already a formula.
 */
export function bindExtensionPairUnits(elements, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const byId = new Map((elements || []).map((element) => [element?.id, element]));
  let changed = false;
  for (const pair of extensionDelimiterPairs(elements)) {
    const glyph = byId.get(pair.glyphId);
    for (const inkId of pairInkIds(pair)) {
      const ink = byId.get(inkId);
      if (!selected.has(pair.glyphId) && !selected.has(ink?.id)) continue;
      if (!glyph || !ink || glyph.label !== "formula" || ink.label !== "formula") continue;
      const host = glyph.unitId ? glyph : (ink.unitId ? ink : null);
      if (!host?.unitId) continue;
      const guest = host === glyph ? ink : glyph;
      if (guest.unitId === host.unitId && guest.unitType === host.unitType) continue;
      guest.unitId = host.unitId;
      guest.unitType = host.unitType;
      if (typeof guest.equationNumber !== "boolean") guest.equationNumber = false;
      changed = true;
    }
  }
  return changed;
}

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
  const ids = (Array.isArray(id) ? id : [id]).filter(Boolean);
  const selected = new Set(selectedIds || []);
  if (!ids.length) return [...selected];
  if (toggle || shift) {
    const allIn = ids.every((item) => selected.has(item));
    if (allIn) {
      for (const item of ids) selected.delete(item);
    } else {
      for (const item of ids) selected.add(item);
    }
    return [...selected];
  }
  return [...ids];
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
