/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  SPACE_USERS,
  formatFans,
  getUserStats,
  loadFollowIds,
  loadPosts,
  saveFollowIds,
  type SocialPost,
  type UserStats,
} from "@/data/posts";

/**
 * 他人空间页（/space/[id]）：
 * - 从广场/评论区点击他人头像或名字进入
 * - 展示假数据：背景 Banner + 头像（层级关系与个人中心相同）+ 名字 + 粉丝数 + 关注按钮 + TA 的帖子
 * - 关注按钮：点击变灰色『已关注』并写入 localStorage('follows')，粉丝数实时 +1（useState）
 */

export default function OtherSpacePage() {
  const router = useRouter();
  // 动态路由参数（useParams 更稳，避免使用 ctx.params）
  const [userId, setUserId] = useState<string | null>(null);
  const [followed, setFollowed] = useState(false);
  const [userPosts, setUserPosts] = useState<SocialPost[]>([]);
  // 真实统计：粉丝 = 小基数 + 关注 +1；获赞 = 基础值 + 帖子点赞总和
  const [stats, setStats] = useState<UserStats>({ fans: 0, likes: 0, postCount: 0 });

  useEffect(() => {
    // 从 URL 提取 id：/space/u1
    const path = window.location.pathname;
    const id = path.replace(/^\/space\//, "").replace(/\/$/, "");
    setUserId(id || null);
    const followedNow = loadFollowIds().includes(id);
    setFollowed(followedNow);
    const all = loadPosts();
    setUserPosts(all.filter((p) => p.authorId === id));
    setStats(getUserStats(id, all, followedNow));
  }, []);

  const user = SPACE_USERS.find((u) => u.id === userId);

  // 关注/取关：localStorage 持久化 + React state 实时联动粉丝数
  const toggleFollow = () => {
    if (!userId) return;
    const ids = loadFollowIds();
    const nowFollowed = !ids.includes(userId);
    if (nowFollowed) {
      saveFollowIds([...ids, userId]);
    } else {
      saveFollowIds(ids.filter((id) => id !== userId));
    }
    setFollowed(nowFollowed);
    setStats(getUserStats(userId, loadPosts(), nowFollowed));
  };

  // 用户不存在：占位提示
  if (!user) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-white px-6 text-center">
        <p className="text-lg font-bold text-zinc-900">用户不存在</p>
        <button
          type="button"
          onClick={() => router.push("/square")}
          className="rounded-full bg-violet-500 px-6 py-2.5 text-sm font-medium text-white hover:bg-violet-400"
        >
          回到漫画广场
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 via-white to-white pb-24">
      {/* ===== 顶部 Banner ===== */}
      <div className="relative h-64 w-full">
        <img
          src={user.banner}
          alt={`${user.name}的背景`}
          onError={(e) => {
            (e.target as HTMLImageElement).src = "https://picsum.photos/800/400";
          }}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-black/10" />
        <button
          type="button"
          aria-label="返回"
          onClick={() => router.back()}
          className="absolute left-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/60 bg-white/70 text-zinc-900 shadow-sm backdrop-blur-md transition-colors hover:bg-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
      </div>

      <div className="mx-auto max-w-3xl px-4">
        {/* ===== 白色玻璃名片卡片：层级关系与个人中心相同 ===== */}
        <div className="relative -mt-20 rounded-3xl border border-white/60 bg-white/70 shadow-[0_8px_32px_0_rgba(31,38,135,0.12)] backdrop-blur-xl">
          {/* 头像压在 Banner 与卡片交界线上 */}
          <img
            src={user.avatar}
            alt={`${user.name}的头像`}
            onError={(e) => {
              (e.target as HTMLImageElement).src = "https://picsum.photos/200";
            }}
            className="absolute -top-16 left-6 h-32 w-32 rounded-full object-cover shadow-xl ring-4 ring-white"
          />

          {/* 名字 + 关注按钮 + 粉丝数 */}
          <div className="flex items-start pl-44 pr-6 pt-8">
            <div className="min-w-0 flex-1">
              <p className="text-2xl font-bold text-zinc-900">{user.name}</p>
              {/* 粉丝 / 动态 / 获赞：换排显示，真实数据推导 */}
              <p className="mt-2 text-sm text-zinc-500">
                {formatFans(stats.fans)} 粉丝
              </p>
              <p className="mt-1 text-sm text-zinc-500">
                {stats.postCount} 动态 · 获赞 {stats.likes}
              </p>
            </div>
            <button
              type="button"
              onClick={toggleFollow}
              className={`ml-3 shrink-0 rounded-full px-5 py-2 text-sm font-medium transition-colors ${
                followed
                  ? "border border-zinc-200 bg-zinc-200 text-zinc-500"
                  : "bg-zinc-900 text-white hover:bg-zinc-700"
              }`}
            >
              {followed ? "已关注" : "关注"}
            </button>
          </div>
        </div>

        {/* ===== TA 的动态列表 ===== */}
        <div className="mt-6">
          <h2 className="text-lg font-bold text-zinc-900">TA 的动态</h2>
        </div>

        <div className="mt-3 space-y-4">
          {userPosts.map((post) => (
            <div
              key={post.id}
              className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl"
            >
              <div className="flex items-center gap-3">
                <img
                  src={user.avatar}
                  alt="头像"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = "https://picsum.photos/200";
                  }}
                  className="h-10 w-10 rounded-full object-cover"
                />
                <p className="text-sm font-semibold text-zinc-900">
                  {user.name}
                </p>
                <span className="ml-auto text-xs text-zinc-400">
                  {post.time}
                </span>
              </div>
              {/* 文章标题（广场文章在空间内的展示） */}
              {post.title && (
                <p className="mt-3 text-base font-bold text-zinc-900">
                  {post.title}
                </p>
              )}
              {post.intro && (
                <p className="mt-2 whitespace-pre-line text-sm leading-relaxed text-zinc-800">
                  {post.intro}
                </p>
              )}
              {post.tags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {post.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs text-violet-600"
                    >
                      #{tag}
                    </span>
                  ))}
                </div>
              )}
              {post.images.length > 0 && (
                <div
                  className={`mt-3 grid gap-2 ${
                    post.images.length > 1 ? "grid-cols-2" : "grid-cols-1"
                  }`}
                >
                  {post.images.map((src) => (
                    <img
                      key={src}
                      src={src}
                      alt="动态配图"
                      className="max-h-80 w-full rounded-xl object-cover"
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {userPosts.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-400">
              TA 还没有发布过动态
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
