/**
 * 阅读历史记录（纯前端 localStorage 版本）。
 * 数据结构：reading_history_v2 = { "1": "1-2", "2": "2-1" }，即 { 漫画ID: 最近阅读的章节ID }。
 *
 * 为什么用 v2 键：旧版 reading_history 是假数据阶段写入的，章节 ID 与后来真实入库的漫画
 * 章节 ID 会发生碰撞（如本地种子书 "1-1" 与真实投稿"1-1"），导致用户从没读过也显示"已读"。
 * 升级后直接忽略并清除旧键，保证「只有真正进过阅读页的章节才会标已读」。
 */
const KEY = "reading_history_v2";
const LEGACY_KEY = "reading_history";

/** 读取整份阅读历史（异常或无数据时返回空对象） */
export function getReadingHistory(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    // 清理旧版脏数据（一次性，避免旧章节 ID 碰撞造成误判）
    if (window.localStorage.getItem(LEGACY_KEY) !== null) {
      window.localStorage.removeItem(LEGACY_KEY);
    }
    const raw = window.localStorage.getItem(KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 保存阅读进度：打开阅读页时自动调用，记录 { 漫画ID: 章节ID } */
export function saveReadingProgress(comicId: string, chapterId: string) {
  try {
    const history = getReadingHistory();
    history[comicId] = chapterId;
    window.localStorage.setItem(KEY, JSON.stringify(history));
  } catch {
    // 存储异常时静默降级，不影响阅读
  }
}

/**
 * 某本漫画已读到的章节下标（0-based）。
 * 未读过或记录的章节在当前数据中不存在时返回 -1。
 */
export function getReadIndex(
  comicId: string,
  chapters: { id: string }[]
): number {
  const chapterId = getReadingHistory()[comicId];
  if (!chapterId) return -1;
  return chapters.findIndex((c) => c.id === chapterId);
}
