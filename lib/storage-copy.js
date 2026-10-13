/**
 * Reader copy for a storage open that did not finish.
 * Seconds come from the storage timeout and the poll interval.
 * The poll stays a fallback; it is not the open timeout.
 */

import { DEFAULT_BLOCKED_TIMEOUT_MS } from "./platform/idb-open.js";

export const STORAGE_POLL_MS = 5000;
export const STORAGE_RETRY_BUFFER_MS = 1000;
export const STORAGE_MANUAL_RETRY_MS = DEFAULT_BLOCKED_TIMEOUT_MS + STORAGE_RETRY_BUFFER_MS;
export const MOVE_CHIP_DELAY_MS = 800;
export const RECOVER_HOLD_MS = 2000;
export const RECOVER_FADE_MS = 200;
export const RETRY_MIN_DISABLE_MS = 600;

export function storageOpenSeconds() {
  return Math.round(DEFAULT_BLOCKED_TIMEOUT_MS / 1000);
}

export function storagePollSeconds() {
  return Math.round(STORAGE_POLL_MS / 1000);
}

export function storageFailureCause(error) {
  const direct = error?.cause;
  if (direct === "blocked" || direct === "timeout") return direct;
  const nested = direct && typeof direct === "object" ? direct.cause : undefined;
  if (nested === "blocked" || nested === "timeout") return nested;
  return "unknown";
}

export function storageFailureSince(error) {
  if (Number.isFinite(error?.since)) return error.since;
  const inner = error?.cause;
  if (inner && typeof inner === "object" && Number.isFinite(inner.since)) return inner.since;
  return null;
}

export function isStorageBlocked(error) {
  return error?.name === "BlockedError" || error?.type === "blocked";
}

export function formatClock(ms) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

export function blockedReasonCopy(cause) {
  const seconds = storageOpenSeconds();
  if (cause === "blocked") {
    return {
      cause: "blocked",
      reason: "另一个 Open Immerse 页面还在用旧版本的数据，这一页暂时写不进去。",
      hint: "关掉或刷新其他 Open Immerse 页面后会自动恢复。"
    };
  }
  if (cause === "timeout") {
    return {
      cause: "timeout",
      reason: `电脑这会儿读写比较慢，这次没能在 ${seconds} 秒内打开存储。`,
      hint: "稍等一下会自动再试；如果一直这样，可以重启浏览器。"
    };
  }
  return {
    cause: "unknown",
    reason: `打开存储超过了 ${seconds} 秒。可能是另一个 Open Immerse 页面还开着旧版本，也可能只是电脑这会儿比较忙。恢复后会自动接着存，不用刷新。`,
    hint: ""
  };
}

export function blockedRetryAdvice(cause) {
  if (cause === "blocked") return "请关掉其他 Open Immerse 页面。";
  if (cause === "timeout") return "可以重启浏览器。";
  return "如果一直这样，可以先关掉其他 Open Immerse 页面，或者重启浏览器。";
}

export function blockedBannerBody(cause) {
  const base = "新写和修改的笔记先暂存在本页，恢复后自动保存。关掉本页前请先等它存好。";
  if (cause === "blocked") return `${base}关掉其他 Open Immerse 页面后会自动恢复。`;
  return base;
}

export const BLOCKED_SAFE_LINE = "已经存好的译文和笔记都还在，没有丢。";
export const BLOCKED_CAN = "阅读、翻译、看已打开的笔记、写新笔记（先暂存在本页）";
export const BLOCKED_CANNOT = "保存译文和笔记到文献库、打开别的论文的存档、删除笔记";
export const BLOCKED_TITLE = "暂时连不上本机存储";
export const BLOCKED_CHIP = "暂时存不了";
export const BLOCKED_CHIP_LABEL = "暂时存不了，已存好的内容没丢，点击查看";
export const WRITE_FAIL_CHIP = "译文没存上";
export const WRITE_FAIL_TITLE = "译文没存上";
export const WRITE_FAIL_SAFE = "已翻好的内容还在这一页上，关掉标签页前都能看。";
export const AUTO_RETRY_LABEL_PREFIX = "每";
export const PENDING_STATUS = "还没存上 · 已暂存在本页";
export const LOCKED_ACTION_TITLE = "本机存储暂时打不开，恢复后可用";
export const NOTES_UNREAD_EMPTY = "笔记暂时读不出来，恢复后会自动显示。你仍然可以先写新笔记。";

export function autoRetryLabel() {
  return `每 ${storagePollSeconds()} 秒自动再试`;
}

export function quotaGroupCopy() {
  return {
    reason: "quota",
    title: "空间不够",
    body: "浏览器给文献库的空间满了。清理一些论文的缓存或原 PDF 后再试。"
  };
}

export function blockedGroupCopy() {
  return {
    reason: "blocked",
    title: "浏览器不允许写入",
    body: "这个窗口不能保存文献库（例如隐私窗口，或浏览器设置禁止了网站数据）。继续用旧方式读取，不影响阅读。"
  };
}

export const PERSIST_CARD_TITLE = "文献库和笔记可能会被浏览器清掉";
export const PERSIST_CARD_BODY = "这台电脑上的浏览器没有同意长期保存。磁盘空间紧张时，它可能自动删除译文和笔记。建议现在导出一份备份。";
export const MOVE_CHIP_TEXT = "正在搬这篇…";
export const MOVE_CHIP_TITLE = "正在把这篇从旧库搬到浏览器里";
