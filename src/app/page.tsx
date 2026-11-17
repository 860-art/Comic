"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, ChevronRight } from "lucide-react";
import ComicCard from "@/components/ComicCard";
import SectionTitle from "@/components/SectionTitle";
import { ROUTES } from "@/lib/navigation";
import { API_BASE } from "@/lib/api";
import { loadPublishedComics } from "@/data/pendingComics";

/** 后端 /api/comics 返回的单条数据结构 */
interface ApiComic {
  id: number;
  title: string;
  author: string;
  coverImage: string;
  tags: string[];
}

/** 首页卡片渲染所需的字段 */
interface HomeComic {
  id: string;
  title: string;
  author: string;
  coverUrl: string;
  tags: string[];
}

export default function HomePage() {
  // 漫画列表：来自后端数据库（app.db），不再使用写死的 MOCK_COMICS
  const [comics, setComics] = useState<HomeComic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        // 首次启动后端可能稍慢，先进入 Loading 态
        const res = await fetch(`${API_BASE}/api/comics`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data: ApiComic[] = await res.json();
        // 后端数据库漫画（权威数据源）
        const fromApi: HomeComic[] = data.map((c) => ({
          id: String(c.id),
          title: c.title,
          author: c.author,
          coverUrl: c.coverImage,
          tags: c.tags,
        }));
        // 本地缓存只补充“纯本地书”（pub- 等非数字 id）；
        // 数字 id 的条目是数据库镜像（cacheApprovedComic 写入），一律以数据库为权威：
        // API 里没有 = 已被管理员删除 → 绝不从缓存复活
        const seen = new Set(fromApi.map((c) => c.id));
        const fromCache: HomeComic[] = loadPublishedComics()
          .filter((c) => !seen.has(c.id) && !/^\d+$/.test(c.id))
          .map((c) => ({
            id: c.id,
            title: c.title,
            author: c.author,
            coverUrl: c.coverUrl,
            tags: c.tags,
          }));
        // 再兜一层：按 id 去重（Map 保留首次出现的条目），确保渲染列表 id 唯一
        const deduped = Array.from(
          new Map([...fromApi, ...fromCache].map((c) => [c.id, c])).values()
        );
        setComics(deduped);
        setError(null);
      } catch (err) {
        console.error("[首页] 拉取漫画列表失败：", err);
        setError("后端服务未响应，请确认已启动 FastAPI（uvicorn main:app --reload）");
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      {/* 横幅占位区 */}
      <div className="flex h-48 items-center justify-center rounded-xl bg-gradient-to-r from-zinc-100 to-zinc-200 text-zinc-500">
        横幅占位区（banners）
      </div>

      <section className="mt-8">
        <SectionTitle
          title="热门漫画"
          action={
            <Link
              href={ROUTES.explore}
              className="flex items-center text-sm text-zinc-500 hover:text-zinc-900"
            >
              查看更多
              <ChevronRight className="h-4 w-4" />
            </Link>
          }
        />

        {/* 加载状态 */}
        {loading && (
          <div className="flex flex-col items-center gap-3 py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
            <p className="text-sm text-zinc-400">正在从服务器加载漫画列表...</p>
          </div>
        )}

        {/* 错误状态 */}
        {!loading && error && (
          <div className="rounded-2xl border border-red-200 bg-red-50 py-12 text-center">
            <p className="text-sm text-red-500">{error}</p>
          </div>
        )}

        {/* 数据全部来自 GET /api/comics（+ 本地审核发布的漫画）；空库时显示优雅空状态 */}
        {!loading && !error && (comics.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white/60 py-16">
            <BookOpen className="h-10 w-10 text-zinc-300" />
            <p className="text-sm font-medium text-zinc-500">暂无漫画，快去投稿吧</p>
            <Link
              href={ROUTES.upload}
              className="rounded-full bg-violet-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400"
            >
              我要投稿
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4">
            {comics.map((comic, index) => (
              <ComicCard
                key={`${comic.id}-${index}`}
                id={comic.id}
                title={comic.title}
                author={comic.author}
                coverUrl={comic.coverUrl}
                tags={comic.tags}
              />
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
