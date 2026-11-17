/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { BookOpen, LayoutGrid } from "lucide-react";
import { ROUTES } from "@/lib/navigation";
import { getReadIndex } from "@/lib/reading-history";
import { getToken } from "@/lib/auth";

import { API_BASE } from "@/lib/api";

/** 后端 GET /api/collections 返回的单本收藏漫画 */
interface ApiShelfBook {
  id: number;
  title: string;
  author: string;
  coverImage: string;
  tags: string[];
  description: string | null;
  favorites: number;
  chapters: { id: string; title: string; pages: number }[];
}

/** 书架渲染用的书籍结构（全部来自后端真实收藏，绝无假数据） */
interface ShelfBook {
  id: string;
  title: string;
  author: string;
  coverUrl: string;
  chapters: { id: string; title: string; pages: number }[];
}

/**
 * 书库页（我的书架）。
 * - 数据源：GET /api/collections（当前 Token 用户真实收藏的漫画，倒序）
 *   未登录 → 提示登录；已登录但没收藏 → 优雅空状态；**绝不使用任何写死的假书**
 * - 全屏模糊背景：取当前选中书的封面，blur-3xl + scale-110 + opacity-60
 * - 两种视图严格条件渲染、互不嵌套，切换时旧组件整个销毁，不保留滚动状态：
 *   GalleryView：沉浸式画廊（横向滚动 + snap 吸附） / GridView：网格书库
 * - activeIndex 是两种模式之间唯一的同步桥梁
 */
export default function LibraryPage() {
  const [viewMode, setViewMode] = useState<"gallery" | "grid">("gallery");
  const [activeIndex, setActiveIndex] = useState(0);
  // 真实收藏的漫画（GET /api/collections）
  const [books, setBooks] = useState<ShelfBook[]>([]);
  // 阅读进度（0-100）：由 reading_history 计算得出，{ 漫画ID: 进度% }
  const [progressMap, setProgressMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  // 是否已登录（决定空状态文案：去登录 / 去收藏）
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setLoggedIn(false);
      setBooks([]);
      setLoading(false);
      return;
    }
    setLoggedIn(true);
    let alive = true;
    fetch(`${API_BASE}/api/collections`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: ApiShelfBook[]) => {
        if (!alive || !Array.isArray(rows)) return;
        // 按 id 去重，保证渲染列表 id 唯一（key 还会再加 index 兜底）
        const deduped = Array.from(
          new Map(rows.map((r) => [String(r.id), r])).values()
        ).map((r) => ({
          id: String(r.id),
          title: r.title,
          author: r.author,
          coverUrl: r.coverImage,
          chapters: r.chapters ?? [],
        }));
        setBooks(deduped);
        // 阅读进度：已读章节数 / 总章节数 * 100（按读到的最大章节算）
        const map: Record<string, number> = {};
        for (const book of deduped) {
          if (book.chapters.length === 0) continue;
          const idx = getReadIndex(book.id, book.chapters);
          if (idx >= 0) {
            map[book.id] = Math.round(((idx + 1) / book.chapters.length) * 100);
          }
        }
        setProgressMap(map);
      })
      .catch(() => {
        if (alive) setBooks([]);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const currentBook = books[activeIndex] ?? books[0];

  // 切换视图：强制外层窗口回到顶部，避免上一模式的页面滚动位置“串台”
  const toggleViewMode = () => {
    setViewMode((v) => (v === "gallery" ? "grid" : "gallery"));
    window.scrollTo(0, 0);
  };

  return (
    <div className="relative min-h-screen" onDoubleClick={toggleViewMode}>
      {/* ===== 全屏模糊背景：独立最底层（无 overflow 裁剪、无实色边框），铺满整屏 ===== */}
      <div className="fixed inset-0 -z-10 bg-[#1E2B3A]">
        {currentBook?.coverUrl && (
          <img
            src={currentBook.coverUrl}
            alt=""
            aria-hidden
            className="h-full w-full scale-110 object-cover opacity-60 blur-3xl"
          />
        )}
        <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-transparent to-black/35" />
      </div>

      {/* 加载中 */}
      {loading ? (
        <div className="flex h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-3 text-white/70">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white/80" />
          <p className="text-sm">正在加载书架...</p>
        </div>
      ) : books.length === 0 ? (
        /* 空状态：未登录 → 去登录；已登录 → 去收藏 */
        <div className="flex h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4 text-center text-white">
          <BookOpen className="h-12 w-12 text-white/40" />
          <p className="mt-4 text-2xl font-bold text-white">
            {loggedIn ? "暂无收藏" : "登录后查看书架"}
          </p>
          <p className="mt-2 text-sm text-white/60">
            {loggedIn
              ? "去分类页发现喜欢的漫画，点击“收藏”即可加入书架"
              : "书架展示你真实收藏的漫画，登录后即可同步"}
          </p>
          <Link
            href={loggedIn ? ROUTES.explore : ROUTES.login}
            className="mt-6 rounded-full bg-white/15 px-6 py-2.5 text-sm font-medium text-white backdrop-blur-md transition-colors hover:bg-white/25"
          >
            {loggedIn ? "去逛逛分类发现" : "去登录"}
          </Link>
        </div>
      ) : viewMode === "gallery" ? (
        <GalleryView
          books={books}
          progressMap={progressMap}
          activeIndex={activeIndex}
          onActiveChange={setActiveIndex}
          onToggleView={toggleViewMode}
        />
      ) : (
        <GridView
          books={books}
          activeIndex={activeIndex}
          onSelect={(i) => {
            setActiveIndex(i);
            setViewMode("gallery");
            window.scrollTo(0, 0);
          }}
          onToggleView={toggleViewMode}
        />
      )}
    </div>
  );
}

/* ==================== 模式一：沉浸式画廊 ==================== */

interface GalleryViewProps {
  books: ShelfBook[];
  /** { 漫画ID: 进度% }，由 reading_history 计算 */
  progressMap: Record<string, number>;
  activeIndex: number;
  onActiveChange: (index: number) => void;
  onToggleView: () => void;
}

function GalleryView({ books, progressMap, activeIndex, onActiveChange, onToggleView }: GalleryViewProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const scrollRafRef = useRef<number | null>(null);

  const currentBook = books[activeIndex] ?? books[0];
  // 阅读进度由 reading_history 计算：0 表示完全未读
  const progress = currentBook ? (progressMap[currentBook.id] ?? 0) : 0;

  // 挂载时（每次从网格切回画廊都会重新挂载）：
  // 把 activeIndex 对应的那本书滚动到屏幕正中间，实现位置锁定
  useEffect(() => {
    const track = trackRef.current;
    const target = track?.children[activeIndex] as HTMLElement | undefined;
    target?.scrollIntoView({ inline: "center", block: "nearest", behavior: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // 滑动换书：几何最近邻——比较每本书中心与轨道中心的距离，
  // 与宽度公式解耦，滑到哪本，activeIndex 就同步到哪本
  const handleGalleryScroll = () => {
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      const track = trackRef.current;
      if (!track) return;
      const trackRect = track.getBoundingClientRect();
      const trackCenter = trackRect.left + trackRect.width / 2;
      let nearest = 0;
      let minDist = Number.POSITIVE_INFINITY;
      Array.from(track.children).forEach((child, i) => {
        const rect = child.getBoundingClientRect();
        const dist = Math.abs(rect.left + rect.width / 2 - trackCenter);
        if (dist < minDist) {
          minDist = dist;
          nearest = i;
        }
      });
      if (books[nearest]) {
        onActiveChange(nearest);
      }
    });
  };

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col px-4 pb-10 pt-6">
      {/* 顶部：白色大字标题 + 视图切换按钮 */}
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold text-white [filter:drop-shadow(0_2px_8px_rgba(0,0,0,0.55))]">
          阅读
        </h1>
        <button
          type="button"
          aria-label="切换为书库网格视图"
          onClick={onToggleView}
          onDoubleClick={(e) => e.stopPropagation()}
          className="rounded-full bg-white/15 p-2.5 text-white transition-colors hover:bg-white/25"
        >
          <LayoutGrid className="h-5 w-5" />
        </button>
      </div>

      {/* 中间：横向滚动书籍区，固定书宽 + snap-center + 两侧大留白；py-12 让阴影不被滚动容器裁切 */}
      <div className="flex min-h-0 w-full flex-1 items-center">
        <div
          ref={trackRef}
          onScroll={handleGalleryScroll}
          className="flex w-full snap-x snap-mandatory overflow-x-auto bg-transparent py-12 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:h-0 [&::-webkit-scrollbar]:w-0 [&::-webkit-scrollbar]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-track]:bg-transparent"
          style={{ paddingInline: "max(20vw, calc(50% - 150px))" }}
        >
          {books.map((book, i) => {
            const active = i === activeIndex;
            return (
              <div
                key={`${book.id}-${i}`}
                className={`w-[60vw] max-w-[300px] shrink-0 snap-center px-3 transition-all duration-500 ${
                  active ? "scale-100 opacity-100" : "scale-90 opacity-40 blur-[1px]"
                }`}
              >
                {/* 点击大书封面进入漫画详情页；阴影用 drop-shadow 贴合书本不规则边缘 */}
                <div
                  className={`relative transition-[filter] duration-500 ${
                    active
                      ? "[filter:drop-shadow(0_26px_34px_rgba(0,0,0,0.5))]"
                      : "[filter:drop-shadow(0_14px_20px_rgba(0,0,0,0.4))]"
                  }`}
                >
                  <Link
                    href={ROUTES.comic(book.id)}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="relative block overflow-visible rounded-md rounded-l-sm shadow-[4px_4px_0_0_rgba(240,236,229,0.95)]"
                  >
                    <img
                      src={book.coverUrl}
                      alt={book.title}
                      className="aspect-[3/4] w-full rounded-md rounded-l-sm object-cover"
                    />
                    {/* 书脊：左侧约 5% 厚度渐变（暗 → 过渡 → 高光） */}
                    <div className="absolute inset-y-0 left-0 w-[5%] rounded-l-sm bg-[linear-gradient(to_right,rgba(0,0,0,0.4),rgba(0,0,0,0.1),rgba(255,255,255,0.2))]" />
                    {/* 硬壳凹槽：书脊与封面交界处的极细高光白线 */}
                    <div className="absolute inset-y-0 left-[5%] w-[2px] bg-[linear-gradient(to_bottom,rgba(255,255,255,0.55),rgba(255,255,255,0.25)_50%,rgba(255,255,255,0.5))]" />
                    {/* 封面反光：左上角环境光，向右下淡出 */}
                    <div className="absolute inset-0 rounded-md rounded-l-sm bg-[linear-gradient(135deg,rgba(255,255,255,0.2),rgba(255,255,255,0)_42%)]" />
                    {/* 底部轻压暗，保持书体厚度 */}
                    <div className="absolute inset-0 rounded-md rounded-l-sm bg-gradient-to-b from-transparent via-transparent to-black/20" />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 底部：书名 / 作者 / 进度条 —— 纯文字悬浮，无任何盒子背景/边框/阴影 */}
      <div className="bg-transparent text-center">
        <h2 className="text-4xl font-bold text-white [filter:drop-shadow(0_2px_8px_rgba(0,0,0,0.55))]">
          {currentBook.title}
        </h2>
        <p className="mt-3 text-xl text-white/70 [filter:drop-shadow(0_1px_6px_rgba(0,0,0,0.5))]">
          {currentBook.author}
        </p>
        {/* 进度条：完全未读时隐藏；进度由 (已读章节数 / 总章节数) * 100 计算 */}
        {progress > 0 && (
          <div className="mx-auto mt-6 h-1 w-56 rounded-full bg-white/25">
            <div
              className="h-full rounded-full bg-white/85 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}
        <p className="mt-3 text-xs text-white/50 [filter:drop-shadow(0_1px_4px_rgba(0,0,0,0.45))]">
          {progress > 0
            ? `已读 ${progress}% · 双击空白处进入书库`
            : "未读 · 双击空白处进入书库"}
        </p>
      </div>
    </div>
  );
}

/* ==================== 模式二：网格书库 ==================== */

interface GridViewProps {
  books: ShelfBook[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onToggleView: () => void;
}

function GridView({ books, activeIndex, onSelect, onToggleView }: GridViewProps) {
  const gridRef = useRef<HTMLDivElement>(null);

  // 挂载时（每次从画廊切回网格都会重新挂载）：
  // 把 activeIndex 对应的书籍滚动到可视区域并高亮，实现位置锁定
  useEffect(() => {
    const grid = gridRef.current;
    const target = grid?.children[activeIndex] as HTMLElement | undefined;
    target?.scrollIntoView({ block: "center", behavior: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-end justify-between">
        <h1 className="text-2xl font-bold text-white [filter:drop-shadow(0_2px_8px_rgba(0,0,0,0.55))]">
          书库
        </h1>
        <button
          type="button"
          aria-label="切换为阅读画廊视图"
          onClick={onToggleView}
          onDoubleClick={(e) => e.stopPropagation()}
          className="rounded-full bg-zinc-900/80 p-2.5 text-white transition-colors hover:bg-zinc-900"
        >
          <BookOpen className="h-5 w-5" />
        </button>
      </div>

      <div ref={gridRef} className="grid grid-cols-2 gap-4">
        {books.map((book, i) => {
          const active = i === activeIndex;
          return (
            <button
              key={`${book.id}-${i}`}
              type="button"
              onClick={() => onSelect(i)}
              onDoubleClick={(e) => e.stopPropagation()}
              className="text-left"
            >
              {/* 外层只负责柔和投影（drop-shadow 贴合不规则边缘），不做任何裁剪 */}
              <div
                className={`relative transition-[filter] duration-300 ${
                  active
                    ? "[filter:drop-shadow(0_18px_24px_rgba(0,0,0,0.5))]"
                    : "[filter:drop-shadow(0_10px_14px_rgba(0,0,0,0.4))]"
                }`}
              >
                {/* 书页厚度改用 box-shadow 生成右下 3px 纸边，避免铺满一块灰底 */}
                <div className="relative overflow-visible rounded-md rounded-l-sm shadow-[3px_3px_0_0_rgba(240,236,229,0.95)]">
                  <img
                    src={book.coverUrl}
                    alt={book.title}
                    className="aspect-[3/4] w-full rounded-md rounded-l-sm object-cover"
                  />
                  {/* 书脊：左侧约 5% 厚度渐变 */}
                  <div className="absolute inset-y-0 left-0 w-[5%] rounded-l-sm bg-[linear-gradient(to_right,rgba(0,0,0,0.4),rgba(0,0,0,0.1),rgba(255,255,255,0.2))]" />
                  {/* 硬壳凹槽高光白线 */}
                  <div className="absolute inset-y-0 left-[5%] w-[2px] bg-[linear-gradient(to_bottom,rgba(255,255,255,0.5),rgba(255,255,255,0.22)_50%,rgba(255,255,255,0.45))]" />
                  {/* 封面反光：左上角环境光 */}
                  <div className="absolute inset-0 rounded-md rounded-l-sm bg-[linear-gradient(135deg,rgba(255,255,255,0.18),rgba(255,255,255,0)_40%)]" />
                  <div className="absolute inset-0 rounded-md rounded-l-sm bg-gradient-to-b from-transparent via-transparent to-black/25" />
                </div>
              </div>
              <p className="mt-2 truncate text-sm font-medium text-white [filter:drop-shadow(0_1px_6px_rgba(0,0,0,0.5))]">
                {book.title}
              </p>
              <p className="mt-0.5 truncate text-xs text-white/70 [filter:drop-shadow(0_1px_4px_rgba(0,0,0,0.45))]">
                {book.author}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
