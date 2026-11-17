"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, Flame, Heart, MessageCircle } from "lucide-react";
import { FeedPost } from "@/lib/mock-feeds";
import { ROUTES } from "@/lib/navigation";

/**
 * 漫画广场的单卡片 Feed 视图。
 * 点击上/下按钮切换上/下一篇内容。
 * 桌面端（md+）：按钮悬浮在主图左侧、底部为通栏“开始阅读”固定条。
 * 移动端（<md）：主图加高、标题放入卡片头部，正文可滚动，
 * 上/下按钮与“开始阅读”固定悬浮在屏幕底部。
 */
export default function FeedView({ posts }: { posts: FeedPost[] }) {
  const [index, setIndex] = useState(0);
  const post = posts[index];
  const canPrev = index > 0;
  const canNext = index < posts.length - 1;

  const prev = () => setIndex((i) => Math.max(0, i - 1));
  const next = () => setIndex((i) => Math.min(posts.length - 1, i + 1));

  return (
    <>
      <article className="rounded-lg border border-zinc-200 bg-white">
        {/* 卡片头部：移动端大标题 + 作者行；桌面端标题在主图上方悬浮 */}
        <header className="p-4">
          {/* 移动端：大标题 */}
          <h3 className="text-2xl font-bold leading-snug text-zinc-900 md:hidden">
            {post.title}
          </h3>
          <div className="mt-3 flex items-center gap-3 md:mt-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-zinc-300 text-sm text-zinc-600">
              {post.author.slice(0, 1)}
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-900">{post.author}</p>
              <p className="truncate text-xs text-zinc-500">
                @{post.handle} · {post.followers} 粉丝
              </p>
            </div>
            <button
              type="button"
              className="ml-auto shrink-0 rounded-md border border-zinc-300 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-100"
            >
              关注
            </button>
          </div>
        </header>

        {/* 主图区域：核心容器，内部元素用绝对定位避免互相遮挡 */}
        <div className="relative">
          {/* 主图占位：移动端加高接近全屏，桌面端保持 16:9 */}
          <div className="flex aspect-[4/5] items-center justify-center bg-zinc-200 text-sm text-zinc-400 md:aspect-[16/9]">
            主图占位
          </div>

          {/* 桌面端：顶部居中文章标题 */}
          <h3 className="absolute left-1/2 top-3 z-10 hidden max-w-[70%] -translate-x-1/2 truncate rounded bg-white/80 px-3 py-1 text-sm font-medium text-zinc-900 md:block">
            {post.title}
          </h3>

          {/* 右上角：热度标签 */}
          <span className="absolute right-3 top-3 z-10 flex items-center gap-1 rounded bg-white/80 px-2 py-1 text-xs text-zinc-700">
            <Flame className="h-3.5 w-3.5" />
            {post.heat}
          </span>

          {/* 右下角：点赞数和评论数 */}
          <div className="absolute bottom-3 right-3 z-10 flex items-center gap-2 rounded bg-white/80 px-2 py-1 text-xs text-zinc-700">
            <span className="flex items-center gap-1">
              <Heart className="h-3.5 w-3.5" />
              {post.likes}
            </span>
            <span className="flex items-center gap-1">
              <MessageCircle className="h-3.5 w-3.5" />
              {post.comments}
            </span>
          </div>

          {/* 桌面端：左侧垂直居中的上/下切换按钮（位置保持不变） */}
          <div className="absolute left-3 top-1/2 z-10 hidden -translate-y-1/2 flex-col gap-2 md:flex">
            <button
              type="button"
              aria-label="上一篇"
              disabled={!canPrev}
              onClick={prev}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-zinc-700 hover:bg-white disabled:opacity-40"
            >
              <ChevronUp className="h-4 w-4" />
            </button>
            <button
              type="button"
              aria-label="下一篇"
              disabled={!canNext}
              onClick={next}
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/80 text-zinc-700 hover:bg-white disabled:opacity-40"
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* 卡片文字区：标签芯片 + 长文本简介 */}
        <div className="p-4">
          {/* 移动端：标签芯片（位于正文上方，参考图位置） */}
          <div className="mb-3 flex flex-wrap gap-2 md:hidden">
            {post.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs text-zinc-600"
              >
                #{tag}
              </span>
            ))}
          </div>
          <p className="text-sm leading-relaxed text-zinc-600">{post.intro}</p>
          <p className="mt-2 text-xs text-zinc-400">
            第 {index + 1} / {posts.length} 篇
          </p>
        </div>
      </article>

      {/* 移动端：固定悬浮的上/下切换按钮（屏幕左下角，横向排列） */}
      <div className="fixed bottom-6 left-4 z-50 flex gap-3 md:hidden">
        <button
          type="button"
          aria-label="上一篇"
          disabled={!canPrev}
          onClick={prev}
          className="flex h-12 w-12 items-center justify-center rounded-full border border-zinc-300 bg-white text-zinc-700 shadow-md disabled:opacity-40"
        >
          <ChevronUp className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="下一篇"
          disabled={!canNext}
          onClick={next}
          className="flex h-12 w-12 items-center justify-center rounded-full bg-zinc-900 text-white shadow-md disabled:opacity-40"
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      </div>

      {/* 移动端：固定悬浮的“开始阅读”按钮（屏幕右下角胶囊） */}
      <Link
        href={ROUTES.read(post.id)}
        className="fixed bottom-6 right-4 z-50 flex items-center gap-2 rounded-full bg-zinc-900 px-5 py-3 text-sm font-medium text-white shadow-lg md:hidden"
      >
        <MessageCircle className="h-4 w-4" />
        开始阅读
      </Link>

      {/* 桌面端：底部固定区，通栏“开始阅读”大按钮（保持不变） */}
      <div className="fixed inset-x-0 bottom-0 z-50 hidden border-t border-zinc-200 bg-white p-4 md:block">
        <div className="mx-auto max-w-3xl">
          <Link
            href={ROUTES.read(post.id)}
            className="block w-full rounded-md bg-zinc-900 py-3 text-center text-base text-white hover:bg-zinc-700"
          >
            开始阅读
          </Link>
        </div>
      </div>
    </>
  );
}
