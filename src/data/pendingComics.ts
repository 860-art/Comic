import { MOCK_COMICS, type Comic } from "@/data/mockData";

/**
 * 投稿审核数据模块：
 * - localStorage('pending_comics')：用户投稿队列（status: 'pending' 待审核）
 * - localStorage('all_comics')：审核通过后发布的漫画（与 MOCK_COMICS 合并展示）
 * - getAllComics() = MOCK_COMICS + 已发布用户漫画，全站页面统一从这里取数
 */

/** 投稿条目（/upload 提交的对象结构） */
export interface PendingComic {
  id: string;
  title: string;
  author: string;
  intro: string;
  tags: string[];
  cover: string;
  /** 章节内页图（dataURL 数组） */
  pages: string[];
  /** 是否需要 AI 翻译（投稿时选择） */
  needTranslation: boolean;
  status: "pending" | "published";
  submittedAt: string;
}

/** 读取待审核投稿队列 */
export function loadPendingComics(): PendingComic[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("pending_comics");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as PendingComic[];
    }
  } catch {
    // 数据损坏时视为空
  }
  return [];
}

/** 持久化投稿队列 */
export function savePendingComics(list: PendingComic[]) {
  try {
    window.localStorage.setItem("pending_comics", JSON.stringify(list));
  } catch {
    // 忽略
  }
}

/** 读取审核通过后发布的漫画 */
export function loadPublishedComics(): Comic[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem("all_comics");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as Comic[];
    }
  } catch {
    // 忽略
  }
  return [];
}

/** 全站统一取数：内置假数据 + 用户已发布漫画 */
export function getAllComics(): Comic[] {
  return [...MOCK_COMICS, ...loadPublishedComics()];
}

/**
 * 删除漫画时同步清理本地缓存，防止“已删漫画复活”：
 * - 从 all_comics 移除该条（cacheApprovedComic 写入的数据库镜像）
 * - 从阅读历史移除该漫画（书架『继续阅读』不再出现已删书）
 * 数据库是权威数据源，本地缓存只是后端不可达时的兜底。
 */
export function removePublishedComic(id: string) {
  try {
    const published = loadPublishedComics().filter((c) => c.id !== id);
    window.localStorage.setItem("all_comics", JSON.stringify(published));
  } catch {
    // 忽略
  }
  try {
    const raw = window.localStorage.getItem("reading_history_v2");
    if (raw) {
      const history = JSON.parse(raw) as Record<string, string>;
      if (history && typeof history === "object" && history[id]) {
        delete history[id];
        window.localStorage.setItem("reading_history_v2", JSON.stringify(history));
      }
    }
  } catch {
    // 忽略
  }
}

/**
 * 通过审核：
 * 1. 从 pending_comics 移除
 * 2. 组装为 Comic（单章：第1话，页数 = 上传的内页图数量）写入 all_comics
 */
export function approvePendingComic(id: string): Comic | null {
  const list = loadPendingComics();
  const target = list.find((p) => p.id === id);
  if (!target) return null;

  const comic: Comic = {
    id: `pub-${Date.now()}`,
    title: target.title,
    author: target.author,
    coverUrl: target.cover,
    themeColor: "#7C3AED",
    progress: 0,
    status: "连载中",
    updatedAt: new Date().toISOString().slice(0, 10),
    favorites: 0,
    description: target.intro || "暂无简介",
    tags: target.tags,
    // 携带投稿时选择的 AI 翻译需求（true/false），阅读页据此显隐翻译按钮
    needTranslation: target.needTranslation === true,
    chapters: [
      {
        id: `${id}-ch1`,
        title: "第1话",
        pages: Math.max(1, target.pages.length),
      },
    ],
  };

  savePendingComics(list.filter((p) => p.id !== id));
  try {
    const published = loadPublishedComics();
    published.push(comic);
    window.localStorage.setItem("all_comics", JSON.stringify(published));
  } catch {
    return null;
  }
  return comic;
}

/** 驳回：直接从待审核队列移除 */
export function rejectPendingComic(id: string) {
  const list = loadPendingComics();
  savePendingComics(list.filter((p) => p.id !== id));
}

/**
 * 审核通过（后端 API 版）：管理员审核通过后，把后端返回的正式漫画
 * 写入本地 all_comics 缓存（id 与数据库一致），供详情页/阅读页/书架打开。
 */
export function cacheApprovedComic(params: {
  id: number;
  title: string;
  author: string;
  cover: string;
  tags: string[];
  intro?: string | null;
  needTranslation?: boolean;
  /** 后端审核返回的真实章节：[{id, title, pages}] 或投稿章节 [{title, images}] */
  chapters?: { id?: string; title: string; pages?: number; images?: string[] }[];
}): Comic | null {
  // 章节列表：优先用后端真实章节；没有则单章占位
  const rawChapters =
    params.chapters && params.chapters.length > 0
      ? params.chapters
      : [{ title: "第1话", images: [] as string[] }];
  const chapters = rawChapters.map((ch, i) => ({
    id: ch.id ?? `${params.id}-${i + 1}`,
    title: ch.title || `第${i + 1}话`,
    pages: ch.pages ?? (ch.images?.length ? ch.images.length : 8),
  }));

  const comic: Comic = {
    id: String(params.id),
    title: params.title,
    author: params.author,
    coverUrl: params.cover,
    themeColor: "#7C3AED",
    progress: 0,
    status: "连载中",
    updatedAt: new Date().toISOString().slice(0, 10),
    favorites: 0,
    description: params.intro || "暂无简介",
    tags: params.tags,
    needTranslation: params.needTranslation === true,
    chapters,
  };
  try {
    const published = loadPublishedComics().filter((c) => c.id !== comic.id);
    published.push(comic);
    window.localStorage.setItem("all_comics", JSON.stringify(published));
  } catch {
    return null;
  }
  return comic;
}
