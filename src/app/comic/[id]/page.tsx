/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BookOpen,
  Bookmark,
  Clock,
  LayoutGrid,
  MessageCircle,
  Plus,
  Sparkles,
  X,
} from "lucide-react";
import { ROUTES } from "@/lib/navigation";
import { ALL_TAGS, type Comic } from "@/data/mockData";
import { getAllComics } from "@/data/pendingComics";
import { getReadIndex } from "@/lib/reading-history";
import { removePublishedComic } from "@/data/pendingComics";
import CommentDrawer, { type CommentItem } from "@/components/CommentDrawer";
import { formatTime } from "@/lib/time";
import { getToken } from "@/lib/auth";

/**
 * 漫画详情页（玻璃拟态风格，真实后端版）：
 * - 数据源：优先 GET /api/comics/{id}（真实章节列表），404/后端未启动时回退本地 getAllComics
 * - 种子漫画（数据库无章节）自动回退本地章节；审核发布的漫画展示真实章节
 * - 全屏模糊封面背景 + 白毛玻璃主卡片，文字深色
 * - 头部：左封面 / 右作者·更新时间·最新章节·收藏数·连载状态
 * - 标签可点击 → /explore?tag=xxx
 * - 操作区：开始阅读 + 评论(N)（呼出共享玻璃态评论抽屉）
 * - 章节列表玻璃态行；底部悬浮：亮玻璃开始阅读 + 收藏 + 分类
 */

import { API_BASE } from "@/lib/api";

/** 后端 GET /api/comics/{id} 返回的数据结构 */
interface ApiComicDetail {
  id: number;
  title: string;
  author: string;
  coverImage: string;
  tags: string[];
  /** 真实简介：投稿时写的 intro，未填写为 null */
  description: string | null;
  needTranslation: boolean | null;
  /** 真实收藏总数（collections 表统计） */
  favorites: number;
  /** 当前登录用户是否已收藏（未登录恒为 false） */
  collected: boolean;
  chapters: { id: string; title: string; pages: number }[];
}

/** 后端 GET/POST /api/comics/{id}/comments 返回的单条评论结构 */
interface ApiCommentRow {
  id: number;
  content: string;
  author_id: number;
  author_username: string;
  avatar_url: string | null;
  created_at: string;
}

/** 后端评论 → 前端 CommentItem（真实身份：author_username + avatar_url） */
function toCommentItem(c: ApiCommentRow): CommentItem {
  return {
    id: `db-${c.id}`,
    author: c.author_username,
    avatar: c.avatar_url ?? undefined,
    color: "bg-violet-200",
    time: formatTime(c.created_at),
    content: c.content,
    likes: 0,
    replies: [],
  };
}

export default function ComicDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [comic, setComic] = useState<Comic | null>(null);
  const [loading, setLoading] = useState(true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [commentsList, setCommentsList] = useState<CommentItem[]>([]);
  const [likedComments, setLikedComments] = useState<Record<string, boolean>>({});
  const [collected, setCollected] = useState(false);
  // 真实收藏总数（后端 collections 表统计），不再用写死的 12800
  const [favCount, setFavCount] = useState(0);
  // 已读到的章节下标（0-based），-1 表示从未读过；**详情页只读，绝不写入**
  const [readIndex, setReadIndex] = useState(-1);
  const [toast, setToast] = useState<string | null>(null);
  // ===== 真实评论（GET/POST /api/comics/{id}/comments） =====
  const [commentsLoading, setCommentsLoading] = useState(false);
  // ===== 标签动态管理（PUT /api/comics/{id}/tags） =====
  const [isAdmin, setIsAdmin] = useState(false);
  const [tagInputOpen, setTagInputOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  // ===== 管理员删除漫画（DELETE /api/comics/{id}） =====
  const [deleteSheetOpen, setDeleteSheetOpen] = useState(false);
  const [deletingComic, setDeletingComic] = useState(false);
  const router = useRouter();

  useEffect(() => {
    let alive = true;
    params.then(async ({ id }) => {
      if (!alive) return;
      // 本地兜底数据先取一次（种子漫画的章节从这里补全）
      const local = getAllComics().find((c) => c.id === id);
      // 优先从后端拉真实数据（真实简介 / 真实收藏数 / 当前用户收藏状态 / 真实章节列表）
      // 带 Token 时后端会额外返回 collected（我是否已收藏）
      try {
        const token = getToken();
        const res = await fetch(`${API_BASE}/api/comics/${id}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        });
        if (res.ok) {
          const a: ApiComicDetail = await res.json();
          const obj: Comic = {
            id: String(a.id),
            title: a.title,
            author: a.author,
            coverUrl: a.coverImage || local?.coverUrl || "",
            themeColor: "#7C3AED",
            progress: local?.progress ?? 0,
            status: "连载中",
            updatedAt: local?.updatedAt ?? "—",
            // 真实收藏数（后端统计），绝不再用假数据
            favorites: a.favorites ?? 0,
            // 真实简介：后端没写就是空字符串 → 页面显示『作者很懒，暂无简介』
            description: a.description ?? "",
            tags: a.tags,
            needTranslation: a.needTranslation !== false,
            // 数据库有真实章节用真实章节；种子漫画（无章节）回退本地章节
            chapters: a.chapters.length ? a.chapters : (local?.chapters ?? []),
          };
          setComic(obj);
          setFavCount(a.favorites ?? 0);
          setCollected(Boolean(a.collected));
          // 只读取进度用于展示；**绝不在这里写阅读进度**
          setReadIndex(getReadIndex(id, obj.chapters));
          setLoading(false);
          return;
        }
      } catch {
        // 后端未启动 → 下面按 ID 类型决定是否兜底
      }
      if (/^\d+$/.test(id)) {
        // 数字 ID 一定是数据库漫画：后端 404 / 未启动时**不再回退本地假数据**，
        // 避免出现「同一 id 命中 mock 书」导致的假简介、假收藏数
        setComic(null);
      } else {
        setComic(local ?? null);
        setFavCount(local?.favorites ?? 0);
        if (local) setReadIndex(getReadIndex(id, local.chapters));
      }
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [params]);

  // 拉取该漫画的真实评论（仅数据库漫画，数字 ID；本地占位书无评论）
  useEffect(() => {
    if (!comic || !/^\d+$/.test(comic.id)) {
      setCommentsList([]);
      return;
    }
    let alive = true;
    setCommentsLoading(true);
    fetch(`${API_BASE}/api/comics/${comic.id}/comments`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: ApiCommentRow[]) => {
        if (alive && Array.isArray(rows)) {
          setCommentsList(rows.map(toCommentItem));
        }
      })
      .catch(() => {
        // 后端未启动 → 保持空列表（抽屉显示暂无评论）
      })
      .finally(() => {
        if (alive) setCommentsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [comic?.id]);

  // 屏幕正中玻璃态 Toast，2 秒后自动消失
  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 2000);
  };

  const isLoggedIn = () =>
    typeof window !== "undefined" && Boolean(window.localStorage.getItem("token"));

  // 管理员身份（决定标签是否显示删除 ×）
  useEffect(() => {
    const token = getToken();
    if (!token) return;
    fetch(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.user?.role === "admin") setIsAdmin(true);
      })
      .catch(() => {
        // 忽略：保持普通用户视角
      });
  }, []);

  // 收藏 / 取消收藏：真实写库（POST / DELETE /api/comics/{id}/collect）
  const toggleCollect = async () => {
    if (!comic) return;
    if (!isLoggedIn()) {
      showToast("未登录");
      return;
    }
    const token = getToken();
    // 本地占位书（非数据库漫画）没有收藏接口，仅切换本地状态
    if (!/^\d+$/.test(comic.id)) {
      setCollected(!collected);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/comics/${comic.id}/collect`, {
        method: collected ? "DELETE" : "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "操作失败，请稍后重试");
        return;
      }
      setCollected(Boolean(data?.collected));
      setFavCount(typeof data?.count === "number" ? data.count : favCount);
      // 书库页仍读本地 collected_books，这里保持同步（不参与收藏数统计）
      try {
        const raw = window.localStorage.getItem("collected_books");
        const list: string[] = raw ? JSON.parse(raw) : [];
        const safe = Array.isArray(list) ? list : [];
        const next = data?.collected
          ? Array.from(new Set([...safe, comic.id]))
          : safe.filter((id) => id !== comic.id);
        window.localStorage.setItem("collected_books", JSON.stringify(next));
      } catch {
        // 本地存储异常不影响真实收藏结果
      }
      showToast(data?.collected ? "已收藏" : "已取消收藏");
    } catch {
      showToast("无法连接服务器，请确认后端已启动");
    }
  };

  // 更新标签：PUT /api/comics/{id}/tags（后端校验：删除标签仅管理员）
  const updateTags = async (next: string[]) => {
    if (!comic) return;
    const token = getToken();
    if (!token) {
      showToast("未登录");
      return;
    }
    if (!/^\d+$/.test(comic.id)) {
      showToast("该作品暂不支持修改标签");
      return;
    }
    setSavingTags(true);
    try {
      const res = await fetch(`${API_BASE}/api/comics/${comic.id}/tags`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tags: next }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "标签更新失败");
        return;
      }
      setComic((prev) =>
        prev ? { ...prev, tags: Array.isArray(data?.tags) ? data.tags : prev.tags } : prev
      );
      showToast("标签已更新");
    } catch {
      showToast("无法连接服务器，请确认后端已启动");
    } finally {
      setSavingTags(false);
    }
  };

  // 添加标签：输入框确认后提交（重复标签直接提示）
  const addTag = async () => {
    if (!comic) return;
    const tag = tagInput.trim().replace(/^#+/, "").trim();
    if (!tag) return;
    if (comic.tags.includes(tag)) {
      showToast("该标签已存在");
      return;
    }
    if (tag.length > 12) {
      showToast("单个标签不能超过 12 个字");
      return;
    }
    await updateTags([...comic.tags, tag]);
    setTagInput("");
    setTagInputOpen(false);
  };

  // 删除标签（仅管理员入口可见，后端二次校验 role）
  const removeTag = async (tag: string) => {
    if (!comic) return;
    await updateTags(comic.tags.filter((t) => t !== tag));
  };

  // 管理员确认删除漫画：调 DELETE /api/comics/{id} → 成功后提示并跳回首页
  const handleDeleteComic = async () => {
    if (!comic || deletingComic) return;
    setDeletingComic(true);
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/comics/${comic.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        // 同步清理本地缓存（数据库镜像 + 阅读历史），防止已删漫画在首页/书架“复活”
        removePublishedComic(String(comic.id));
        setDeleteSheetOpen(false);
        setToast("删除成功");
        setTimeout(() => {
          router.push(ROUTES.home);
          router.refresh(); // 首页列表重新拉取，剔除已删漫画
        }, 800);
      } else {
        setToast(data?.detail ?? (res.status === 403 ? "无权限：需要管理员账号" : "删除失败"));
        setDeletingComic(false);
      }
    } catch {
      setToast("无法连接服务器，请确认后端已启动");
      setDeletingComic(false);
    }
  };

  // 评论点赞：变红 + 数字 +1
  const toggleCommentLike = (id: string) =>
    setLikedComments((prev) => ({ ...prev, [id]: !prev[id] }));

  // 发布评论：未登录拦截 → POST 真实接口（带 Token）→ 用后端返回的真实身份插入最前
  const handlePublish = async (content: string): Promise<boolean> => {
    if (!isLoggedIn()) {
      showToast("未登录");
      return false;
    }
    if (!comic || !/^\d+$/.test(comic.id)) {
      showToast("该漫画暂不支持评论");
      return false;
    }
    const text = content.trim();
    if (!text) return false;
    const token = getToken();
    if (!token) {
      showToast("未登录");
      return false;
    }
    try {
      const res = await fetch(`${API_BASE}/api/comics/${comic.id}/comments`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "评论发表失败");
        return false;
      }
      setCommentsList((prev) => [toCommentItem(data.comment), ...prev]);
      return true;
    } catch {
      showToast("无法连接服务器，请确认后端已启动");
      return false;
    }
  };

  // 详情页加载中
  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
        <p className="text-sm text-zinc-400">正在加载漫画详情...</p>
      </div>
    );
  }

  // 动态路由解析完成但仍无数据（无效 ID / 404）
  if (!comic) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-24 text-center">
        <p className="text-lg font-medium text-zinc-700">未找到该漫画</p>
        <Link
          href={ROUTES.home}
          className="mt-4 inline-block rounded-full bg-zinc-900 px-5 py-2 text-sm text-white hover:bg-zinc-700"
        >
          返回首页
        </Link>
      </div>
    );
  }

  const latestChapter = comic.chapters[comic.chapters.length - 1] ?? null;
  // 阅读状态联动：未读 → 第 1 话；已读未完 → 下一话；已读最后一话 → 已读完
  const hasRead = readIndex >= 0;
  const isFinished = hasRead && readIndex >= comic.chapters.length - 1;
  const targetChapter = comic.chapters.length
    ? hasRead && !isFinished
      ? comic.chapters[readIndex + 1]
      : comic.chapters[0]
    : null;
  const readLabel = !hasRead
    ? "开始阅读"
    : isFinished
      ? "已读完"
      : "继续阅读";
  const glassChip =
    "rounded-full border border-white/20 bg-black/40 text-white backdrop-blur-md";

  return (
    <div className="relative pb-28">
      {/* 全屏模糊背景：独立最底层（无 overflow 裁剪、无实色边框），铺满整屏 */}
      <div className="fixed inset-0 -z-10 bg-[#0b0b0f]">
        <img
          src={comic.coverUrl}
          alt=""
          aria-hidden
          className="h-full w-full scale-110 object-cover opacity-70 blur-3xl"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-transparent to-black/45" />
      </div>

      {/* 内容层：完全透明，让模糊背景直接透上来（无背景色 / 无边框 / 无 overflow 裁剪） */}
      <div className="relative mx-auto max-w-4xl px-4 py-8">
        <div className="bg-transparent">
          {/* 头部信息：左侧大封面，右侧元信息 */}
          <div className="flex flex-col gap-6 p-6 sm:flex-row">
            {/* 封面：管理员在右上角有灰色叉号删除入口（半透明玻璃态） */}
            <div className="relative shrink-0 self-start">
              <img
                src={comic.coverUrl}
                alt={comic.title}
                className="h-64 w-48 rounded-xl object-cover [filter:drop-shadow(0_18px_32px_rgba(0,0,0,0.45))]"
              />
              {isAdmin && (
                <button
                  type="button"
                  aria-label="删除该漫画"
                  onClick={() => setDeleteSheetOpen(true)}
                  className="absolute right-2.5 top-2.5 flex h-8 w-8 items-center justify-center rounded-full border border-white/25 bg-black/40 text-white/60 backdrop-blur-md transition-colors hover:border-white/40 hover:bg-black/60 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-3xl font-bold text-white drop-shadow-sm">
                  {comic.title}
                </h1>
                <span
                  className={`px-2.5 py-1 text-xs ${glassChip} ${
                    comic.status === "已完结" ? "opacity-80" : ""
                  }`}
                >
                  {comic.status}
                </span>
              </div>
              <p className="mt-2 text-sm font-medium text-white/80">
                {comic.author}
              </p>

              {/* 元信息网格：更新时间 / 最新章节 / 收藏数 */}
              <div className="mt-4 grid gap-2 text-sm text-white/70">
                <p className="flex items-center gap-1.5">
                  <Clock className="h-4 w-4 text-white/50" />
                  更新时间：{comic.updatedAt}
                </p>
                <p className="flex items-center gap-1.5">
                  <Sparkles className="h-4 w-4 text-white/50" />
                  最新章节：{latestChapter?.title ?? "暂无章节"}
                </p>
                <p className="flex items-center gap-1.5">
                  <Bookmark className="h-4 w-4 text-white/50" />
                  收藏数：{favCount}
                </p>
              </div>

              {/* 可点击标签：跳转分类页并携带参数 /explore?tag=xxx；右侧 + 号可添加 */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {comic.tags.map((tag) => (
                  <span key={tag} className="relative inline-flex">
                    <Link
                      href={`${ROUTES.explore}?tag=${encodeURIComponent(tag)}`}
                      className={`rounded-full border border-white/20 bg-white/10 px-3 py-1 text-xs font-medium text-white/90 backdrop-blur-md transition-colors hover:bg-white/25 hover:text-white ${
                        isAdmin ? "pr-5" : ""
                      }`}
                    >
                      #{tag}
                    </Link>
                    {/* 管理员专属：标签右上角红色 × 删除 */}
                    {isAdmin && (
                      <button
                        type="button"
                        aria-label={`删除标签 ${tag}`}
                        disabled={savingTags}
                        onClick={() => removeTag(tag)}
                        className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold leading-none text-white shadow transition-colors hover:bg-red-600 disabled:opacity-50"
                      >
                        ×
                      </button>
                    )}
                  </span>
                ))}
                {/* 添加标签：小 + 号按钮（登录用户可见） */}
                <button
                  type="button"
                  aria-label="添加标签"
                  onClick={() => setTagInputOpen((v) => !v)}
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-violet-300 bg-violet-50/80 text-violet-600 transition-colors hover:bg-violet-100"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* 添加标签输入框（点 + 号展开） */}
              {tagInputOpen && (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={tagInput}
                    onChange={(e) => setTagInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") addTag();
                      if (e.key === "Escape") setTagInputOpen(false);
                    }}
                    maxLength={12}
                    placeholder="输入新标签（最多 12 字）"
                    className="w-40 rounded-full border border-white/60 bg-white/80 px-3 py-1.5 text-xs text-gray-800 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-violet-300"
                  />
                  <button
                    type="button"
                    disabled={savingTags}
                    onClick={addTag}
                    className="rounded-full bg-violet-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-violet-400 disabled:opacity-60"
                  >
                    {savingTags ? "保存中..." : "确定"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setTagInputOpen(false);
                      setTagInput("");
                    }}
                    className="rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-xs text-white/80 backdrop-blur-md"
                  >
                    取消
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 简介：只用后端返回的真实 description，为空时显示占位文案（绝无假文本） */}
          <div className="px-6 py-5">
            {comic.description?.trim() ? (
              <p className="whitespace-pre-line text-sm leading-relaxed text-white/85">
                {comic.description}
              </p>
            ) : (
              <p className="text-sm leading-relaxed text-white/45">
                作者很懒，暂无简介
              </p>
            )}
          </div>

          {/* 操作区：开始阅读/继续阅读 + 评论（数量） */}
          <div className="flex gap-3 px-6 py-5">
            {!targetChapter ? (
              <span className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/20 bg-gray-900/40 py-3 text-sm font-medium text-white/70 backdrop-blur-md">
                <BookOpen className="h-4 w-4" />
                暂无章节
              </span>
            ) : isFinished ? (
              <button
                type="button"
                onClick={() => showToast("已读完")}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/20 bg-gray-900/80 py-3 text-sm font-medium text-white backdrop-blur-md transition-all hover:bg-gray-900 active:scale-[0.98]"
              >
                <BookOpen className="h-4 w-4" />
                已读完
              </button>
            ) : (
              <Link
                href={ROUTES.read(comic.id, targetChapter.id)}
                className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/20 bg-gray-900/80 py-3 text-sm font-medium text-white backdrop-blur-md transition-all hover:bg-gray-900 active:scale-[0.98]"
              >
                <BookOpen className="h-4 w-4" />
                {readLabel}
              </Link>
            )}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/20 bg-black/40 py-3 text-sm font-medium text-white backdrop-blur-md transition-all hover:bg-black/55 active:scale-[0.98]"
            >
              <MessageCircle className="h-4 w-4" />
              评论（{commentsList.length}）
            </button>
          </div>

          {/* 章节列表：玻璃态行 + 『追加章节』入口 */}
          <div className="px-6 py-5">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-white">
                章节列表（{comic.chapters.length}）
              </h2>
              {/* 追加章节：跳转投稿页携带参数（仅数据库漫画，数字 ID） */}
              {/^\d+$/.test(comic.id) && (
                <Link
                  href={`/upload?comic_id=${comic.id}&type=append`}
                  className="flex items-center gap-1 rounded-full border border-violet-300/50 bg-violet-500/25 px-3 py-1.5 text-xs font-medium text-violet-100 backdrop-blur-md transition-colors hover:bg-violet-500/40"
                >
                  <Plus className="h-3.5 w-3.5" />
                  追加章节
                </Link>
              )}
            </div>
            {comic.chapters.length === 0 ? (
              <p className="mt-4 text-sm text-white/45">暂无章节，敬请期待</p>
            ) : (
              <ul className="mt-4 space-y-2">
              {comic.chapters.map((chapter, i) => {
                const isLatest = i === comic.chapters.length - 1;
                return (
                  <li key={chapter.id}>
                    <Link
                      href={ROUTES.read(comic.id, chapter.id)}
                      className="flex items-center justify-between rounded-xl border border-white/15 bg-white/10 px-4 py-3 backdrop-blur-md transition-colors hover:bg-white/20"
                    >
                      <span className="text-sm font-medium text-white/90">
                        {chapter.title}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-white/50">
                        {chapter.pages} 页
                        {/* 已读标记：章节序号 ≤ 已读记录 */}
                        {i <= readIndex && (
                          <span className="rounded-full bg-white/15 px-2 py-0.5 text-[10px] text-white/60">
                            已读
                          </span>
                        )}
                        {isLatest && (
                          <span
                            className={`px-2 py-0.5 text-[10px] ${glassChip}`}
                          >
                            最新
                          </span>
                        )}
                      </span>
                    </Link>
                  </li>
                );
              })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* 底部悬浮操作栏：亮色玻璃开始/继续阅读 + 收藏 + 分类 */}
      <div className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t border-white/30 bg-white/70 px-4 py-3 backdrop-blur-xl">
        {!targetChapter ? (
          <span className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/60 bg-white/60 py-3 text-sm font-semibold text-gray-400 shadow-md backdrop-blur-xl">
            <BookOpen className="h-4 w-4" />
            暂无章节
          </span>
        ) : isFinished ? (
          <button
            type="button"
            onClick={() => showToast("已读完")}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/60 bg-white/90 py-3 text-sm font-semibold text-gray-900 shadow-md backdrop-blur-xl transition-all hover:bg-white active:scale-[0.98]"
          >
            <BookOpen className="h-4 w-4" />
            已读完
          </button>
        ) : (
          <Link
            href={ROUTES.read(comic.id, targetChapter.id)}
            className="flex flex-1 items-center justify-center gap-2 rounded-2xl border border-white/60 bg-white/90 py-3 text-sm font-semibold text-gray-900 shadow-md backdrop-blur-xl transition-all hover:bg-white active:scale-[0.98]"
          >
            <BookOpen className="h-4 w-4" />
            {readLabel}
          </Link>
        )}
        <button
          type="button"
          onClick={toggleCollect}
          className="flex items-center gap-1.5 rounded-2xl border border-white/60 bg-white/70 px-4 py-3 text-sm font-medium text-gray-900 backdrop-blur-xl transition-transform active:scale-95"
        >
          <Bookmark
            className={`h-4 w-4 transition-colors ${
              collected ? "fill-amber-400 text-amber-500" : ""
            }`}
          />
          {collected ? "已收藏" : "收藏"}
        </button>
        <Link
          href={ROUTES.explore}
          className="flex items-center gap-1.5 rounded-2xl border border-white/60 bg-white/70 px-4 py-3 text-sm font-medium text-gray-900 backdrop-blur-xl transition-transform active:scale-95"
        >
          <LayoutGrid className="h-4 w-4" />
          分类
        </Link>
      </div>

      {/* 共享玻璃态评论抽屉 */}
      <CommentDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        post={{ title: comic.title, author: comic.author }}
        comments={commentsList}
        loading={commentsLoading}
        likedComments={likedComments}
        onToggleLike={toggleCommentLike}
        onPublish={handlePublish}
      />

      {/* 屏幕正中玻璃态 Toast（未登录 / 已读完提示），2 秒后自动消失 */}
      {toast && (
        <div className="fixed left-1/2 top-1/2 z-[100] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-black/60 px-6 py-3 text-white backdrop-blur-xl">
          {toast}
        </div>
      )}

      {/* 管理员删除漫画：底部 Action Sheet（两行：红字确认 / 取消） */}
      {deleteSheetOpen && (
        <div
          className="fixed inset-0 z-[90] flex items-end bg-black/50 backdrop-blur-sm"
          onClick={() => !deletingComic && setDeleteSheetOpen(false)}
        >
          <div
            className="mx-auto w-full max-w-md px-3 pb-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-zinc-900/90 backdrop-blur-xl">
              {/* 第一行：确认删除（红字），点击后调 DELETE 接口 */}
              <button
                type="button"
                onClick={handleDeleteComic}
                disabled={deletingComic}
                className="flex w-full items-center justify-center gap-2 border-b border-white/10 px-6 py-4 text-base font-semibold text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {deletingComic ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-red-400/30 border-t-red-400" />
                    正在删除...
                  </>
                ) : (
                  "确认删除该漫画"
                )}
              </button>
              {/* 第二行：取消（关闭抽屉） */}
              <button
                type="button"
                onClick={() => setDeleteSheetOpen(false)}
                disabled={deletingComic}
                className="w-full px-6 py-4 text-base text-white/80 transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-60"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
