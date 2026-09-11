import { TYPE_LABEL } from "./export.js";

export const LEARNING_COPY = {
  title: "学习中心",
  tabAll: "全部",
  tabReview: "今日待复习",
  emptyAll: "还没有收藏。",
  emptyAllHint: "在网页选中文本，点「藏」或双击译文",
  emptyReview: "今日没有到期。",
  emptyExport: "当前列表是空的",
  delete: "删除",
  confirmDelete: "确认删除",
  cancel: "取消",
  forgot: "忘了",
  fuzzy: "模糊",
  remembered: "记住"
};

export function typeLabel(type) {
  return TYPE_LABEL[type] || String(type || "");
}

export function itemMeta(item) {
  const parts = [typeLabel(item.type)];
  const source = String(item.title || item.url || "").trim();
  if (source) parts.push(source);
  if (item.nextReview != null) {
    parts.push(`下次复习 ${new Date(item.nextReview).toLocaleDateString()}`);
  }
  return parts.join(" · ");
}

export function emptyAllHtml() {
  return `<li class="empty-all"><p class="empty-title">${LEARNING_COPY.emptyAll}</p><p class="hint">${LEARNING_COPY.emptyAllHint}</p></li>`;
}
