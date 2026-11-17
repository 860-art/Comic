"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import Link from "next/link";
import ComicCard from "@/components/ComicCard";
import { type Comic } from "@/data/mockData";

import { API_BASE } from "@/lib/api";

/** 后端 GET /api/comics 返回的单行数据结构 */
interface ApiComicRow {
  id: number;
  title: string;
  author: string;
  coverImage: string;
  tags: string[];
  needTranslation: boolean | null;
  chapters: { id: string; title: string; pages: number }[];
}

/** 两排默认展示数量：超出则最后一格替换为『更多 ∨』按钮 */
const COLLAPSED_COUNT = 10;

/**
 * 分类发现页的筛选与网格视图（玻璃拟态风格，纯真实数据版）。
 * - 数据源：挂载时 fetch GET /api/comics（数据库真实漫画），绝不使用假数据；
 *   后端未启动时回退本地审核发布的用户投稿（真实数据，非假书）
 * - 标签数据：挂载时请求 GET /api/tags（数据库真实标签）；
 *   后端没有传标签时只显示『全部』，绝不硬编码假标签
 * - 空状态：数据库为空显示『暂无作品』空状态，不再展示假书
 * - 两排溢出折叠：折叠态最多展示 10 个（最后一格为紫色『更多 ∨』），
 *   点击展开全部并变为『收起 ∧』
 * - 通过 useSearchParams 读取 URL 中的 ?tag= 参数：有值则高亮对应标签并过滤列表，无值默认“全部”
 * - 点击标签时调用 router.replace 平滑更新 URL（如 /explore?tag=悬疑），列表与 URL 永远同步
 */
export default function ExploreView() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // ===== 动态标签：API 优先，失败只显示『全部』 =====
  const [apiTags, setApiTags] = useState<string[]>(["全部"]);
  // 折叠/展开状态
  const [expanded, setExpanded] = useState(false);
  // 数据源：GET /api/comics 数据库真实漫画；加载中为空数组
  const [comics, setComics] = useState<Comic[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // 拉取数据库真实标签（GET /api/tags 返回 { tags: ["全部", ...] }）
    fetch(`${API_BASE}/api/tags`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { tags?: string[] } | null) => {
        if (data?.tags?.length) {
          // 兜底保证『全部』存在且在首位
          const rest = data.tags.filter((t) => t !== "全部");
          setApiTags(["全部", ...rest]);
        }
        // 后端没有标签数据 → 保持只显示『全部』
      })
      .catch(() => {
        // 后端未启动 → 只显示『全部』
      });
    // 拉取数据库真实漫画列表，保证标签与列表完全对应
    fetch(`${API_BASE}/api/comics`)
      .then((res) => (res.ok ? res.json() : null))
      .then((rows: ApiComicRow[] | null) => {
        // 后端返回空数组也照实显示空状态（绝不填充假书）
        if (rows) {
          setComics(
            rows.map((c) => ({
              id: String(c.id),
              title: c.title,
              author: c.author,
              coverUrl: c.coverImage,
              tags: c.tags,
              themeColor: "#7C3AED",
              progress: 0,
              status: "连载中",
              updatedAt: "—",
              favorites: 0,
              description: "暂无简介",
              needTranslation: c.needTranslation !== false,
              chapters: c.chapters ?? [],
            }))
          );
        } else {
          // 请求失败（后端未启动）→ 显示空状态，绝不回退任何假数据
          setComics([]);
        }
        setLoading(false);
      })
      .catch(() => {
        // 后端未启动 → 显示空状态，绝不回退任何假数据
        setComics([]);
        setLoading(false);
      });
  }, []);

  // 实际渲染的标签数组：只来自后端；后端没有数据时只有『全部』
  const tags = apiTags;

  const rawTag = searchParams.get("tag") ?? "全部";
  // URL 参数不在标签体系内时，安全回退到“全部”
  const activeTag = tags.includes(rawTag) ? rawTag : "全部";

  // ===== 两排溢出折叠 =====
  // 折叠态：前 9 个标签 + 最后一格『更多 ∨』（共占 10 格）；展开态：全部标签 + 『收起 ∧』
  const showMoreButton = !expanded && tags.length > COLLAPSED_COUNT;
  const visibleTags = showMoreButton
    ? tags.slice(0, COLLAPSED_COUNT - 1)
    : tags;

  // 按 URL 标签过滤
  const filtered = useMemo(
    () =>
      activeTag === "全部"
        ? comics
        : comics.filter((comic) => comic.tags.includes(activeTag)),
    [activeTag, comics]
  );

  const handleSelect = (tag: string) => {
    router.replace(
      tag === "全部" ? "/explore" : `/explore?tag=${encodeURIComponent(tag)}`
    );
  };

  const tagChipClass = (active: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-sm transition-colors ${
      active
        ? "border-gray-900 bg-gray-900 text-white"
        : "border-white/60 bg-white/70 text-gray-700 backdrop-blur-md hover:bg-gray-900 hover:text-white"
    }`;

  return (
    <div>
      {/* 顶部筛选栏：玻璃态面板 + 动态标签胶囊（两排折叠） */}
      <div className="rounded-3xl border border-white/50 bg-white/60 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.1)] backdrop-blur-xl">
        <div className="flex items-start gap-3">
          <span className="shrink-0 pt-1.5 text-sm font-medium text-gray-700">
            题材
          </span>
          <div className="flex flex-wrap gap-2">
            {visibleTags.map((tag) => {
              const active = activeTag === tag;
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => handleSelect(tag)}
                  className={tagChipClass(active)}
                >
                  {tag}
                </button>
              );
            })}

            {/* 折叠态最后一格：紫色『更多 ∨』；展开态：『收起 ∧』 */}
            {showMoreButton ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="flex items-center gap-1 rounded-full border border-violet-400 bg-violet-500 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-400"
              >
                更多
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            ) : (
              tags.length > COLLAPSED_COUNT && (
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="flex items-center gap-1 rounded-full border border-violet-400 bg-violet-500 px-3.5 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-400"
                >
                  收起
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
              )
            )}
          </div>
        </div>
      </div>

      {/* 结果网格：真实封面 / 书名 / 作者 / 标签，点击进详情页 */}
      {loading ? (
        <div className="mt-6 flex flex-col items-center gap-3 py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
          <p className="text-sm text-zinc-400">正在从服务器加载作品列表...</p>
        </div>
      ) : filtered.length > 0 ? (
        <div className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
          {filtered.map((comic) => (
            <ComicCard
              key={comic.id}
              id={comic.id}
              title={comic.title}
              author={comic.author}
              coverUrl={comic.coverUrl}
              tags={comic.tags}
            />
          ))}
        </div>
      ) : activeTag === "全部" ? (
        /* 数据库为空：优雅空状态，绝不出现假书 */
        <div className="mt-6 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white/60 py-16">
          <BookOpen className="h-10 w-10 text-zinc-300" />
          <p className="text-sm font-medium text-zinc-500">暂无作品，快去投稿吧</p>
          <Link
            href="/upload"
            className="rounded-full bg-violet-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400"
          >
            我要投稿
          </Link>
        </div>
      ) : (
        /* 有筛选条件但无匹配作品 */
        <p className="mt-6 text-center text-sm text-gray-400">
          没有符合筛选条件的作品
        </p>
      )}
    </div>
  );
}
