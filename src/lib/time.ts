/**
 * 时间格式化工具（前后端时区对齐）。
 * 后端数据库以 UTC 存储时间；如果 ISO 字符串没有时区后缀，
 * 一律视为 UTC（补 Z），浏览器 new Date() 自动换算为本地时区。
 */

/** 兼容处理：无时区后缀的 ISO 字符串视为 UTC，已有后缀的原样返回 */
function normalizeIso(iso: string): string {
  if (/[zZ]$/.test(iso) || /[+-]\d{2}:?\d{2}$/.test(iso)) {
    return iso; // 已带 Z 或 ±hh:mm 偏移
  }
  return `${iso}Z`; // 视为 UTC
}

/**
 * 相对时间格式化：
 * - 1 分钟内  → "刚刚"
 * - 1 小时内  → "X 分钟前"
 * - 24 小时内 → "X 小时前"
 * - 超过 24 小时 → 本年显示 "10月24日"，跨年显示 "2026-11-15"
 */
export function formatTime(iso: string): string {
  if (!iso) return "";
  const then = new Date(normalizeIso(iso)).getTime();
  if (Number.isNaN(then)) return "";

  const diff = Date.now() - then;
  // 容忍 2 秒内的时钟误差（客户端/服务器时间微差）
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;

  const date = new Date(then);
  const now = new Date();
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}
