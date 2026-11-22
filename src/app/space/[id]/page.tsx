/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  AtSign,
  ChevronLeft,
  ChevronRight,
  Heart,
  MessageCircle,
  X,
} from "lucide-react";
import CommentDrawer from "@/components/CommentDrawer";
import { type CommentItem } from "@/data/comments";
import {
  SPACE_USERS,
  ME_DEFAULT_AVATAR,
  ME_DEFAULT_BANNER,
  ME_DEFAULT_NAME,
  displayTitle,
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
import { getAuth, getToken } from "@/lib/auth";
import { formatTime } from "@/lib/time";

/** 本地假数据帖子的评论存储（与广场页同 key，评论互通） */
const COMMENTS_KEY = "sq_post_comments";

function loadLocalComments(postId: string): CommentItem[] {
  try {
    const raw = window.localStorage.getItem(COMMENTS_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw);
    return Array.isArray(map?.[postId]) ? map[postId] : [];
  } catch {
    return [];
  }
}

function saveLocalComments(postId: string, list: CommentItem[]) {
  try {
    const raw = window.localStorage.getItem(COMMENTS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[postId] = list;
    window.localStorage.setItem(COMMENTS_KEY, JSON.stringify(map));
  } catch {
    // 忽略存储异常
  }
}

/**
 * 他人空间页（/space/[id]）：
 * - 从广场/评论区点击他人头像或名字进入
 * - 假数据用户（u1~u9）沿用本地帖子；真实数据库用户（authorId 为数字 id）
 *   走 GET /api/users/{id} + GET /api/posts，展示真实头像/背景/动态
 * - 无头像/背景 → 加载全站默认图（网络加载失败同样兜底）
 * - 动态卡片：底部点赞（红心可切换）+ 评论（复用全站评论抽屉）
 * - 配图点击放大：全屏遮罩浏览，多图支持左右切换
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
  comment_count?: number;
  created_at: string;
}

/** 后端 GET /api/posts/{id}/comments 返回的单条评论 */
interface ApiComment {
  id: number;
  actor_id: number;
  actor_username: string;
  actor_avatar?: string | null;
  content: string;
  created_at: string;
}

/** 评论颜色池：CommentItem 需要的无头像兜底背景 */
const COMMENT_COLORS = [
  "bg-violet-500",
  "bg-sky-500",
  "bg-emerald-500",
  "bg-amber-500",
  "bg-rose-500",
];

function apiCommentToItem(c: ApiComment): CommentItem {
  return {
    id: `c-${c.id}`,
    author: c.actor_username,
    avatar: c.actor_avatar || undefined,
    color: COMMENT_COLORS[c.id % COMMENT_COLORS.length],
    time: formatTime(c.created_at),
    content: c.content,
    likes: 0,
    replies: [],
  };
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

  // ===== 点赞 / 评论 / 图片放大 =====
  const [likedIds, setLikedIds] = useState<Set<string>>(new Set());
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 评论抽屉
  const [drawerPost, setDrawerPost] = useState<SocialPost | null>(null);
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [likedComments, setLikedComments] = useState<Record<string, boolean>>({});
  // 每条动态的真实评论数（真实用户帖从后端 comment_count 初始化）
  const [commentCounts, setCommentCounts] = useState<Record<string, number>>({});
  // 图片放大浏览：当前打开的图片列表与索引
  const [preview, setPreview] = useState<{ urls: string[]; index: number } | null>(null);

  // 屏幕居中玻璃态 Toast，2 秒后自动消失
  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2000);
  };

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
        // 每条动态的真实评论数（db-{id} → count）
        const counts: Record<string, number> = {};
        for (const p of all) counts[`db-${p.id}`] = p.comment_count ?? 0;
        setCommentCounts(counts);
        // 我赞过的动态 → 红心初始状态
        const token = getToken();
        if (token) {
          fetch(`${API_BASE}/api/posts/liked`, {
            headers: { Authorization: `Bearer ${token}` },
          })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              if (cancelled || !d?.post_ids) return;
              setLikedIds(new Set(d.post_ids.map((n: number) => `db-${n}`)));
            })
            .catch(() => {});
        }
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

  // ===== 点赞：已赞 → 再次点击取消红心（后端切换接口）；本地假数据帖子仅本地切换 =====
  const toggleLike = async (post: SocialPost) => {
    const token = getToken();
    if (!token) {
      showToast("请先登录后再点赞");
      return;
    }
    const liked = likedIds.has(post.id);
    if (!post.id.startsWith("db-")) {
      setLikedIds((prev) => {
        const s = new Set(prev);
        if (liked) s.delete(post.id);
        else s.add(post.id);
        return s;
      });
      setUserPosts((prev) =>
        prev.map((p) =>
          p.id === post.id ? { ...p, likes: p.likes + (liked ? -1 : 1) } : p
        )
      );
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/posts/${post.id.slice(3)}/like`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "点赞失败");
        return;
      }
      const nowLiked = !!data.liked;
      setLikedIds((prev) => {
        const s = new Set(prev);
        if (nowLiked) s.add(post.id);
        else s.delete(post.id);
        return s;
      });
      setUserPosts((prev) =>
        prev.map((p) =>
          p.id === post.id ? { ...p, likes: data.likes ?? p.likes } : p
        )
      );
      setStats((prev) => ({
        ...prev,
        likes: prev.likes + (nowLiked ? 1 : -1),
      }));
      showToast(data.message ?? (nowLiked ? "点赞成功" : "已取消点赞"));
    } catch {
      showToast("无法连接服务器");
    }
  };

  // ===== 评论抽屉：真实帖子拉后端评论，本地帖子读 localStorage =====
  const openComments = (post: SocialPost) => {
    setDrawerPost(post);
    if (!post.id.startsWith("db-")) {
      setComments(loadLocalComments(post.id));
      return;
    }
    setComments([]);
    setCommentsLoading(true);
    fetch(`${API_BASE}/api/posts/${post.id.slice(3)}/comments`)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: ApiComment[]) => setComments(list.map(apiCommentToItem)))
      .catch(() => {})
      .finally(() => setCommentsLoading(false));
  };

  // ===== 发布评论：真实帖子 POST 后端（成功插入列表最前）；本地帖子存 localStorage =====
  const handlePublish = async (content: string): Promise<boolean> => {
    if (!drawerPost) return false;
    const text = content.trim();
    if (!text) return false;
    const token = getToken();
    if (!token) {
      showToast("请先登录后再评论");
      return false;
    }
    if (!drawerPost.id.startsWith("db-")) {
      const me = getAuth();
      const item: CommentItem = {
        id: `local-${Date.now()}`,
        author: me.username || ME_DEFAULT_NAME,
        color: COMMENT_COLORS[0],
        time: "刚刚",
        content: text,
        likes: 0,
        replies: [],
      };
      const list = [item, ...loadLocalComments(drawerPost.id)];
      saveLocalComments(drawerPost.id, list);
      setComments(list);
      setCommentCounts((prev) => ({
        ...prev,
        [drawerPost.id]: (prev[drawerPost.id] ?? 0) + 1,
      }));
      return true;
    }
    try {
      const res = await fetch(
        `${API_BASE}/api/posts/${drawerPost.id.slice(3)}/comments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: text }),
        }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "评论失败");
        return false;
      }
      const n = data.notification;
      setComments((prev) => [
        apiCommentToItem({
          id: n.id,
          actor_id: n.actor_id,
          actor_username: n.actor_username,
          actor_avatar: n.actor_avatar,
          content: text,
          created_at: new Date().toISOString(),
        }),
        ...prev,
      ]);
      setCommentCounts((prev) => ({
        ...prev,
        [drawerPost.id]: (prev[drawerPost.id] ?? 0) + 1,
      }));
      return true;
    } catch {
      showToast("无法连接服务器");
      return false;
    }
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
            (e.target as HTMLImageElement).src = ME_DEFAULT_BANNER;
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
              (e.target as HTMLImageElement).src = ME_DEFAULT_AVATAR;
            }}
            className="absolute -top-16 left-6 h-32 w-32 rounded-full object-cover shadow-xl ring-4 ring-white"
          />

          {/* 名字 + 关注按钮 + 粉丝数 */}
          <div className="flex items-start pl-44 pr-6 pt-8">
            <div className="min-w-0 flex-1">
              <p className="text-2xl font-bold text-zinc-900">{user.name}</p>
              {/* 粉丝 / 动态 / 获赞：各占一行分段显示 */}
              <p className="mt-2 text-sm text-zinc-500">
                {formatFans(stats.fans)} 粉丝
              </p>
              <p className="mt-1 text-sm text-zinc-500">
                {stats.postCount} 动态
              </p>
              <p className="mt-1 text-sm text-zinc-500">获赞 {stats.likes}</p>
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
                  {post.images.map((src, i) => (
                    <img
                      key={src}
                      src={src}
                      alt="动态配图"
                      onClick={() => setPreview({ urls: post.images, index: i })}
                      className="max-h-80 w-full cursor-zoom-in rounded-xl object-cover transition-opacity hover:opacity-90"
                    />
                  ))}
                </div>
              )}
              {/* 底部操作栏：点赞（红心可切换）+ 评论 */}
              <div className="mt-3 flex items-center gap-6 border-t border-white/60 pt-3 text-sm text-zinc-700">
                <button
                  type="button"
                  aria-label="点赞"
                  onClick={() => toggleLike(post)}
                  className="flex items-center gap-1.5 transition-transform active:scale-75"
                >
                  <Heart
                    className={`h-4 w-4 transition-colors ${
                      likedIds.has(post.id) ? "fill-red-500 text-red-500" : ""
                    }`}
                  />
                  {post.likes}
                </button>
                <button
                  type="button"
                  aria-label="评论"
                  onClick={() => openComments(post)}
                  className="flex items-center gap-1.5"
                >
                  <MessageCircle className="h-4 w-4" />
                  {commentCounts[post.id] ?? 0}
                </button>
              </div>
            </div>
          ))}
          {userPosts.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-400">
              TA 还没有发布过动态
            </p>
          )}
        </div>
      </div>

      {/* ===== 评论抽屉（全站复用） ===== */}
      {drawerPost && (
        <CommentDrawer
          open
          onClose={() => setDrawerPost(null)}
          post={{ title: displayTitle(drawerPost), author: drawerPost.author }}
          comments={comments}
          loading={commentsLoading}
          likedComments={likedComments}
          onToggleLike={(id) =>
            setLikedComments((prev) => ({ ...prev, [id]: !prev[id] }))
          }
          onPublish={handlePublish}
        />
      )}

      {/* ===== 图片放大浏览：全屏遮罩，多图左右切换，点遮罩/关闭键退出 ===== */}
      {preview && (
        <div
          className="fixed inset-0 z-[110] flex items-center justify-center bg-black/90"
          onClick={() => setPreview(null)}
        >
          <button
            type="button"
            aria-label="关闭放大预览"
            onClick={() => setPreview(null)}
            className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md transition-colors hover:bg-white/20"
          >
            <X className="h-5 w-5" />
          </button>
          <img
            src={preview.urls[preview.index]}
            alt="图片放大预览"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[85vh] max-w-full object-contain"
          />
          {preview.urls.length > 1 && (
            <>
              <button
                type="button"
                aria-label="上一张"
                onClick={(e) => {
                  e.stopPropagation();
                  setPreview((p) =>
                    p
                      ? { ...p, index: (p.index - 1 + p.urls.length) % p.urls.length }
                      : p
                  );
                }}
                className="absolute left-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md transition-colors hover:bg-white/20"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                type="button"
                aria-label="下一张"
                onClick={(e) => {
                  e.stopPropagation();
                  setPreview((p) =>
                    p ? { ...p, index: (p.index + 1) % p.urls.length } : p
                  );
                }}
                className="absolute right-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md transition-colors hover:bg-white/20"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
              <span className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-xs text-white">
                {preview.index + 1}/{preview.urls.length}
              </span>
            </>
          )}
        </div>
      )}

      {/* ===== 屏幕居中玻璃态 Toast ===== */}
      {toastMsg && (
        <div className="fixed left-1/2 top-1/2 z-[120] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-black/60 px-6 py-3 text-white backdrop-blur-xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
