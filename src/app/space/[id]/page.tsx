/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, AtSign } from "lucide-react";
import {
  SPACE_USERS,
  ME_DEFAULT_AVATAR,
  ME_DEFAULT_BANNER,
  formatFans,
  getUserStats,
  loadFollowIds,
  loadPosts,
  saveFollowIds,
  type SocialPost,
  type SpaceUser,
  type UserStats,
} from "@/data/posts";
import { API_BASE } from "@/lib/api";
import { formatTime } from "@/lib/time";

/**
 * 他人空间页（/space/[id]）：
 * - 从广场/评论区点击他人头像或名字进入
 * - 假数据用户（u1~u9）沿用本地帖子；真实数据库用户（authorId 为数字 id）
 *   走 GET /api/users/{id} + GET /api/posts，展示真实头像/背景/动态
 * - 关注按钮：点击变灰色『已关注』并写入 localStorage('follows')，粉丝数实时 +1
 */

/** 后端 GET /api/posts 返回的单条数据结构 */
interface ApiPost {
  id: number;
  content: string | null;
  image_url: string | null;
  image_urls?: string[] | null;
  mention_username?: string | null;
  author_id: number;
  author_username: string;
  likes: number;
  created_at: string;
}

function toSocialPost(p: ApiPost): SocialPost {
  return {
    id: `db-${p.id}`,
    title: "",
    authorId: String(p.author_id),
    author: p.author_username,
    followers: 0,
    tags: [],
    images:
      p.image_urls && p.image_urls.length > 0
        ? p.image_urls
        : p.image_url
          ? [p.image_url]
          : [],
    likes: p.likes ?? 0,
    heat: "",
    intro: p.content ?? "",
    time: formatTime(p.created_at),
    comments: [],
    commentsCount: 0,
    mention: p.mention_username ?? undefined,
  };
}

export default function OtherSpacePage() {
  const router = useRouter();
  // 动态路由参数（useParams 更稳，避免使用 ctx.params）
  const [userId, setUserId] = useState<string | null>(null);
  const [user, setUser] = useState<SpaceUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [followed, setFollowed] = useState(false);
  const [userPosts, setUserPosts] = useState<SocialPost[]>([]);
  // 真实统计：粉丝 = 小基数 + 关注 +1；获赞 = 基础值 + 帖子点赞总和
  const [stats, setStats] = useState<UserStats>({ fans: 0, likes: 0, postCount: 0 });

  useEffect(() => {
    // 从 URL 提取 id：/space/u1（假数据）或 /space/3（真实数据库用户）
    const path = window.location.pathname;
    const id = path.replace(/^\/space\//, "").replace(/\/$/, "");
    setUserId(id || null);
    const followedNow = loadFollowIds().includes(id);
    setFollowed(followedNow);

    // 1) 假数据用户：沿用本地帖子与统计
    const mock = SPACE_USERS.find((u) => u.id === id);
    if (mock) {
      setUser(mock);
      const all = loadPosts();
      setUserPosts(all.filter((p) => p.authorId === id));
      setStats(getUserStats(id, all, followedNow));
      setLoading(false);
      return;
    }

    // 2) 真实数据库用户：公开资料 + 全站帖子过滤出 TA 的动态
    if (!/^\d+$/.test(id)) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const [profileRes, postsRes] = await Promise.all([
          fetch(`${API_BASE}/api/users/${id}`),
          fetch(`${API_BASE}/api/posts`),
        ]);
        if (cancelled) return;
        if (profileRes.status === 404) {
          setUser(null);
          return;
        }
        if (!profileRes.ok) throw new Error(`HTTP ${profileRes.status}`);
        const profile = await profileRes.json();
        const all: ApiPost[] = postsRes.ok ? await postsRes.json() : [];
        const mine = all
          .filter((p) => p.author_id === Number(id))
          .map(toSocialPost);
        setUser({
          id,
          name: profile.username,
          avatar: profile.avatar_url || ME_DEFAULT_AVATAR,
          banner: profile.cover_url || ME_DEFAULT_BANNER,
          fans: 0,
          baseLikes: 0,
        });
        setUserPosts(mine);
        setStats({
          fans: followedNow ? 1 : 0,
          likes: mine.reduce((sum, p) => sum + (p.likes || 0), 0),
          postCount: mine.length,
        });
      } catch {
        setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    setStats((prev) => ({
      ...prev,
      fans: prev.fans + (nowFollowed ? 1 : -1),
    }));
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white text-sm text-zinc-400">
        加载中…
      </div>
    );
  }

  // 用户不存在：占位提示（仅后端明确 404 或 id 非法时）
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
              {post.mention && (
                <span className="mt-2 inline-flex items-center gap-0.5 rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-600">
                  <AtSign className="h-3 w-3" />
                  {post.mention}
                </span>
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
