/**
 * Decisions the review page must share with tests: missing-PDF lock,
 * merge without splitting a unit, and Chinese import errors.
 */

export function reviewActionsLocked(pdfMissing) {
  return pdfMissing === true;
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

/**
 * Merge whole formula units only. A partial selection must not pull
 * glyphs out of a unit.
 */
export function planMerge(elements, selectedIds) {
  const selected = selectedIds instanceof Set ? selectedIds : new Set(selectedIds || []);
  const list = Array.isArray(elements) ? elements : [];
  const chosen = list.filter((element) => element && element.label === "formula" && selected.has(element.id));
  const partial = "当前只选中了单元里的一部分字形，直接合并会把原单元拆碎。请从空白处拖出方框，盖住每个式子的全部字形，确认右栏的选中数后再按 m。";
  if (chosen.length < 2) {
    return {
      ok: false,
      message: "请先选中至少两个完整的公式单元。点击只选中一个字形。从空白处拖出方框选中整式，确认右栏的选中数，再按 m。"
    };
  }
  const unitIds = [...new Set(chosen.map((element) => element.unitId))];
  const ids = [];
  for (const unitId of unitIds) {
    const members = list.filter((element) => element.label === "formula" && element.unitId === unitId);
    if (!members.length || members.some((element) => !selected.has(element.id))) {
      return { ok: false, message: partial };
    }
    for (const member of members) ids.push(member.id);
  }
  if (unitIds.length < 2) {
    return { ok: false, message: "选中的字形都在同一个单元里，不需要合并。" };
  }
  return { ok: true, message: "", ids };
}
