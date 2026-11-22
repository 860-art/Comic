/* eslint-disable @next/next/no-img-element */
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AtSign, ChevronDown, ChevronUp, Flame, Heart, MessageCircle } from "lucide-react";
import CommentDrawer, { type CommentItem } from "@/components/CommentDrawer";
import {
  ME_ID,
  displayTitle,
  formatFans,
  getSpaceHref,
  loadFollowIds,
  saveFollowIds,
  type SocialPost,
} from "@/data/posts";
import { formatTime } from "@/lib/time";
import { getToken } from "@/lib/auth";

/**
 * 漫画广场：单篇卡片 Feed 流（玻璃拟态风格）。
 * - 数据源：后端数据库 GET /api/posts（真实帖子，含用户在 /space 发布的动态）
 * - 排序规则：URL 带 ?post_id=xxx（通知中心跳转）→ 目标帖置顶、其余随机打乱，定位后 router.replace('/square') 清参数；
 *   无 post_id → 全部随机打乱（每次刷新顺序都不同）
 * - 页面外层固定高度，只渲染 posts[activeIndex] 这一篇文章，绝不用 map 渲染多篇
 * - 左侧悬浮玻璃态上/下箭头切换文章，超出范围置灰禁用
 * - 文章内容区：作者信息区（头像/名字 + 粉丝数 + 关注按钮）、图片轮播、正文、点赞评论
 * - 点赞拦截：未登录弹出“未登录”玻璃态 Toast（2 秒自动消失）
 */

import { API_BASE } from "@/lib/api";
import { dataUrlToFile, uploadImage } from "@/lib/upload";

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

/** 把后端帖子映射为广场卡片所需的 SocialPost 结构 */
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
    mention: p.mention_username ?? undefined,
    likes: p.likes ?? 0,
    comments: [],
    commentsCount: 0,
    heat: "",
    intro: p.content ?? "",
    time: formatTime(p.created_at),
  };
}

/** 随机打乱帖子顺序（每次进入广场页面重新洗牌） */
function shufflePosts(list: SocialPost[]): SocialPost[] {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/** 全屏模糊背景：黑色打底 + 当前文章第一张图放大虚化（无图时用渐变兜底） */
function BlurredBackground({ src }: { src?: string }) {
  if (!src) {
    return (
      <div className="fixed inset-0 -z-10 bg-gradient-to-b from-violet-300/60 via-white to-white" />
    );
  }
  return (
    <div className="fixed inset-0 -z-10 overflow-hidden bg-black">
      <img
        src={src}
        alt=""
        className="h-full w-full scale-110 object-cover opacity-70 blur-3xl"
      />
    </div>
  );
}

/** 后端 GET /api/posts/{id}/comments 返回的单条评论 */
interface ApiCommentRow {
  id: number;
  actor_id: number;
  actor_username: string;
  actor_avatar?: string | null;
  content: string;
  image_url?: string | null;
  created_at: string;
}

const COMMENT_COLORS = ["bg-violet-500", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500"];

function toCommentItem(c: ApiCommentRow): CommentItem {
  return {
    id: `c-${c.id}`,
    author: c.actor_username,
    avatar: c.actor_avatar || undefined,
    color: COMMENT_COLORS[c.id % COMMENT_COLORS.length],
    time: formatTime(c.created_at),
    content: c.content,
    image: c.image_url || undefined,
    likes: 0,
    replies: [],
  };
}

/** 评论本地持久化：仅用于本地种子帖子（真实帖子统一走后端评论接口） */
const COMMENTS_KEY = "sq_post_comments";

function loadPostComments(postId: string): CommentItem[] {
  try {
    const raw = window.localStorage.getItem(COMMENTS_KEY);
    if (!raw) return [];
    const map = JSON.parse(raw);
    return Array.isArray(map?.[postId]) ? map[postId] : [];
  } catch {
    return [];
  }
}

function savePostComments(postId: string, list: CommentItem[]) {
  try {
    const raw = window.localStorage.getItem(COMMENTS_KEY);
    const map = raw ? JSON.parse(raw) : {};
    map[postId] = list;
    window.localStorage.setItem(COMMENTS_KEY, JSON.stringify(map));
  } catch {
    // 忽略存储异常
  }
}

/** 单篇文章视图（每次切换文章都会重新挂载，滚动位置与吸顶状态自动重置） */
function FeedView({
  post,
  index,
  total,
  onPrev,
  onNext,
}: {
  post: SocialPost;
  index: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const router = useRouter();
  const [liked, setLiked] = useState(false);
  // 点赞数显示：跟随后端返回实时更新（红心可切换，二次点击取消）
  const [likeCount, setLikeCount] = useState(post.likes);
  // Toast 消息内容：点赞/评论的成功与错误提示都走这里（此前文案被硬编码成"未登录"，导致点赞成功也误报）
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [carouselPage, setCarouselPage] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 关注状态：挂载时从 localStorage('follows') 恢复；粉丝数 = 基础数 + (已关注 ? 1 : 0)
  const [following, setFollowing] = useState(false);

  useEffect(() => {
    setFollowing(loadFollowIds().includes(post.authorId));
  }, [post.authorId]);

  // 切换文章时重置红心，并按后端「我赞过的动态」恢复红心初始状态
  useEffect(() => {
    setLiked(false);
    setLikeCount(post.likes);
    const token = getToken();
    if (!token || !post.id.startsWith("db-")) return;
    fetch(`${API_BASE}/api/posts/liked`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.post_ids?.includes(Number(post.id.replace("db-", "")))) {
          setLiked(true);
        }
      })
      .catch(() => {});
  }, [post.id]);

  // 关注/取关：更新 localStorage + React state 实时联动粉丝数
  const toggleFollow = () => {
    const ids = loadFollowIds();
    if (ids.includes(post.authorId)) {
      saveFollowIds(ids.filter((id) => id !== post.authorId));
      setFollowing(false);
    } else {
      saveFollowIds([...ids, post.authorId]);
      setFollowing(true);
    }
  };

  // 头像/名字 → 跳转对应空间（自己 → /space，他人 → /space/[id]）
  const openAuthorSpace = () => router.push(getSpaceHref(post.authorId));
  // 评论列表：真实帖子统一从后端 GET /api/posts/{id}/comments 读取，
  // 与漫画详情页/他人空间页共用同一数据源（本地库只用于本地种子帖子）
  const [commentsList, setCommentsList] = useState<CommentItem[]>(
    post.id.startsWith("db-") ? [] : loadPostComments(post.id)
  );
  const [commentsLoading, setCommentsLoading] = useState(false);

  useEffect(() => {
    if (!post.id.startsWith("db-")) {
      setCommentsList(loadPostComments(post.id));
      return;
    }
    let alive = true;
    setCommentsLoading(true);
    fetch(`${API_BASE}/api/posts/${post.id.slice(3)}/comments`)
      .then((r) => {
        if (!r.ok) throw new Error("评论接口不可用（后端版本落后）");
        return r.json();
      })
      .then((rows: ApiCommentRow[]) => {
        if (alive) setCommentsList(rows.map(toCommentItem));
      })
      .catch(() => {
        // 后端还没更新到评论读取接口时，兜底显示浏览器里已发的本地评论
        if (alive) setCommentsList(loadPostComments(post.id));
      })
      .finally(() => {
        if (alive) setCommentsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [post.id]);
  // 评论点赞状态：id -> 是否已点赞
  const [likedComments, setLikedComments] = useState<Record<string, boolean>>({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const carouselRef = useRef<HTMLDivElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  // 屏幕正中玻璃态 Toast，2 秒后自动消失（文案跟随传入的消息）
  const showToast = (msg: string) => {
    setToastMsg(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2000);
  };

  // 核心交互：点赞/取消点赞（切换红心）→ 调后端 POST /api/posts/{id}/like
  const handleLike = async () => {
    const token = getToken();
    if (!token) {
      showToast("请先登录后再点赞");
      return;
    }
    try {
      const res = await fetch(
        `${API_BASE}/api/posts/${post.id.replace("db-", "")}/like`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "点赞失败");
        return;
      }
      setLiked(!!data.liked);
      if (typeof data.likes === "number") setLikeCount(data.likes);
      showToast(data.message ?? (data.liked ? "点赞成功" : "已取消点赞"));
    } catch (err) {
      console.error("[广场] 点赞失败：", err);
      showToast("无法连接服务器");
    }
  };

  // 评论点赞：同款变红 + 数字 +1
  const toggleCommentLike = (id: string) =>
    setLikedComments((prev) => ({ ...prev, [id]: !prev[id] }));

  // 发布评论：调后端 POST /api/posts/{id}/comments（给作者产生真实评论通知），
  // 成功后用后端返回的真实身份插入列表最前面；带图时先上传 R2 再随评论入库
  const handlePublish = async (
    content: string,
    imageDataUrl?: string
  ): Promise<boolean> => {
    const token = getToken();
    if (!token) {
      showToast("请先登录后再评论");
      return false;
    }
    const text = content.trim();
    if (!text && !imageDataUrl) return false;
    try {
      let imageUrl: string | undefined;
      if (imageDataUrl) {
        try {
          imageUrl = await uploadImage(dataUrlToFile(imageDataUrl));
        } catch (err) {
          showToast(err instanceof Error ? err.message : "图片上传失败");
          return false;
        }
      }
      const res = await fetch(
        `${API_BASE}/api/posts/${post.id.replace("db-", "")}/comments`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ content: text, image_url: imageUrl ?? null }),
        }
      );
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "评论失败");
        return false;
      }
      // 后端返回的 notification 带真实用户名与头像，绝不写死“当前用户”
      const n = data.notification;
      const newList: CommentItem[] = [
        {
          id: `c-${n.id}`,
          author: n.actor_username,
          avatar: n.actor_avatar ?? undefined,
          color: "bg-violet-200",
          time: "刚刚",
          content: text,
          image: n.image_url ?? undefined,
          likes: 0,
          replies: [],
        },
        ...commentsList,
      ];
      setCommentsList(newList);
      // 本地只作「兜底镜像」：后端评论接口不可用时才读它，正常情况一律以后端为准
      savePostComments(post.id, newList);
      return true;
    } catch (err) {
      console.error("[广场] 评论失败：", err);
      showToast("无法连接服务器");
      return false;
    }
  };

  // 轮播页码：几何最近邻计算当前居中的图片
  const handleCarouselScroll = () => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const track = carouselRef.current;
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
      setCarouselPage(nearest);
    });
  };

  const glassChip =
    "rounded-full border border-white/20 bg-black/40 text-white backdrop-blur-md";

  return (
    <div className="relative h-full">
      {/* 全屏模糊背景：当前文章第一张图 */}
      <BlurredBackground src={post.images[0]} />

      {/* 屏幕左下角横排悬浮：玻璃态上/下切换按钮，超出范围置灰禁用 */}
      <div className="fixed bottom-6 left-4 z-50 flex gap-3">
        <button
          type="button"
          aria-label="上一篇文章"
          onClick={onPrev}
          disabled={index === 0}
          className={`flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white backdrop-blur-md transition-all active:scale-90 ${
            index === 0 ? "cursor-not-allowed opacity-30" : "hover:bg-black/55"
          }`}
        >
          <ChevronUp className="h-5 w-5" />
        </button>
        <button
          type="button"
          aria-label="下一篇文章"
          onClick={onNext}
          disabled={index === total - 1}
          className={`flex h-11 w-11 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white backdrop-blur-md transition-all active:scale-90 ${
            index === total - 1 ? "cursor-not-allowed opacity-30" : "hover:bg-black/55"
          }`}
        >
          <ChevronDown className="h-5 w-5" />
        </button>
      </div>

      {/* 文章内容区：允许向下滚动阅读 */}
      <div ref={scrollRef} className="h-full overflow-y-auto">
        {/* 单篇文章白毛玻璃卡片 */}
        <div className="mx-auto max-w-3xl px-4 py-6">
          <article className="overflow-hidden rounded-3xl border border-white/50 bg-white/60 shadow-[0_8px_32px_0_rgba(31,38,135,0.1)] backdrop-blur-2xl">
            {/* 图片轮播 + 悬浮角标/按钮（纯文字动态显示渐变占位） */}
            <div className="relative">
              {post.images.length > 0 ? (
                <div
                  ref={carouselRef}
                  onScroll={handleCarouselScroll}
                  className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                >
                  {post.images.map((src) => (
                    <div key={src} className="w-full shrink-0 snap-center">
                      <img
                        src={src}
                        alt={post.title}
                        className="aspect-[4/5] w-full object-cover"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex aspect-[4/5] w-full items-center justify-center bg-gradient-to-br from-violet-200 via-violet-100 to-white">
                  <p className="text-sm text-violet-400">纯文字动态</p>
                </div>
              )}

              {/* 左上角：页码角标（有图才显示） */}
              {post.images.length > 0 && (
                <span
                  className={`absolute left-3 top-3 z-10 px-3 py-1 text-xs ${glassChip}`}
                >
                  {carouselPage + 1}/{post.images.length}
                </span>
              )}

              {/* 右下角：点赞 / 评论悬浮按钮 */}
              <div className="absolute bottom-3 right-3 z-10 flex gap-2">
                <button
                  type="button"
                  aria-label="点赞"
                  onClick={handleLike}
                  className={`flex h-10 w-10 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white backdrop-blur-md transition-transform active:scale-75`}
                >
                  <Heart
                    className={`h-5 w-5 transition-colors ${
                      liked ? "fill-red-500 text-red-500" : ""
                    }`}
                  />
                </button>
                <button
                  type="button"
                  aria-label="评论"
                  onClick={() => setDrawerOpen(true)}
                  className="flex h-10 items-center gap-1.5 rounded-full border border-white/20 bg-black/40 px-3.5 text-white backdrop-blur-md transition-transform active:scale-75"
                >
                  <MessageCircle className="h-5 w-5" />
                  <span className="text-xs">{commentsList.length}</span>
                </button>
              </div>
            </div>

            {/* 文字内容区：黑色/深灰文字，保证白玻璃上对比清晰 */}
            <div className="p-5">
              {/* 作者信息区：头像/名字可点击跳转空间；关注按钮与粉丝数联动 */}
              <h1 className="text-3xl font-bold text-gray-900">
                {displayTitle(post)}
              </h1>
              <div className="mt-4 flex items-center gap-3">
                <button
                  type="button"
                  aria-label={`查看 ${post.author} 的空间`}
                  onClick={openAuthorSpace}
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-200 text-base text-gray-700 transition-transform hover:opacity-80 active:scale-90"
                >
                  {post.author.slice(0, 1)}
                </button>
                <button
                  type="button"
                  onClick={openAuthorSpace}
                  className="min-w-0 text-left"
                >
                  <p className="truncate text-sm font-medium text-gray-900 hover:underline">
                    {post.author}
                  </p>
                  <p className="text-xs text-gray-500">
                    {formatFans(post.followers + (following ? 1 : 0))} 粉丝
                  </p>
                </button>
                {post.authorId !== ME_ID && (
                  <button
                    type="button"
                    onClick={toggleFollow}
                    className={`ml-auto shrink-0 rounded-full px-4 py-1 text-sm font-medium transition-colors ${
                      following
                        ? "border border-gray-200 bg-gray-200 text-gray-500"
                        : "border border-gray-900 text-gray-900 hover:bg-gray-900 hover:text-white"
                    }`}
                  >
                    {following ? "已关注" : "关注"}
                  </button>
                )}
              </div>

              {/* 标签行 */}
              <div className="mt-5 flex flex-wrap gap-2">
                {post.tags.map((tag) => (
                  <span key={tag} className="text-sm text-gray-600">
                    #{tag}
                  </span>
                ))}
              </div>

              {/* 长文本简介 */}
              <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-gray-700">
                {post.intro}
              </p>

              {/* @ 徽标：正文后紫色提示（点击@通知跳转进来的定位已由 post_id 处理） */}
              {post.mention && (
                <span className="mt-3 inline-flex items-center gap-0.5 rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-600">
                  <AtSign className="h-3 w-3" />
                  {post.mention}
                </span>
              )}

              {/* 文章结尾：点赞 / 评论计数 */}
              <div className="mt-6 flex items-center gap-6 border-t border-white/60 pt-4 text-sm text-gray-700">
                <button
                  type="button"
                  onClick={handleLike}
                  className="flex items-center gap-1.5 transition-transform active:scale-75"
                >
                  <Heart
                    className={`h-4 w-4 transition-colors ${
                      liked ? "fill-red-500 text-red-500" : ""
                    }`}
                  />
                  {likeCount}
                </button>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(true)}
                  className="flex items-center gap-1.5"
                >
                  <MessageCircle className="h-4 w-4" />
                  {commentsList.length}
                </button>
              </div>
            </div>
          </article>
        </div>
      </div>

      {/* 评论抽屉：底部弹出，白色磨砂质感 */}
      <CommentDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        post={post}
        comments={commentsList}
        loading={commentsLoading}
        likedComments={likedComments}
        onToggleLike={toggleCommentLike}
        onPublish={handlePublish}
      />

      {/* 屏幕正中玻璃态 Toast（点赞/评论结果提示），2 秒后自动消失 */}
      {toastMsg && (
        <div className="fixed left-1/2 top-1/2 z-[100] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-black/60 px-6 py-3 text-white backdrop-blur-xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
}

export default function SquarePage() {
  // useSearchParams 需要 Suspense 包裹（Next.js App Router 构建要求）
  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
          <p className="text-sm text-zinc-400">正在加载广场动态...</p>
        </div>
      }
    >
      <SquareFeed />
    </Suspense>
  );
}

function SquareFeed() {
  const searchParams = useSearchParams();
  const router = useRouter();
  // 真实数据源：后端数据库 GET /api/posts，挂载后按规则排序（定位/随机）
  const [posts, setPosts] = useState<SocialPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/posts`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: ApiPost[] = await res.json();
        const mapped = data.map(toSocialPost);

        // URL 带有 ?post_id=xxx（如从通知中心跳转）：目标帖置顶，其余随机打乱
        const postId = searchParams.get("post_id");
        if (postId) {
          const target = mapped.find((p) => p.id === `db-${postId}`);
          if (target) {
            const rest = shufflePosts(
              mapped.filter((p) => p.id !== `db-${postId}`)
            );
            setPosts([target, ...rest]);
          } else {
            // 目标帖不存在（已删除等）→ 回退完全随机
            setPosts(shufflePosts(mapped));
          }
          // 定位完成后悄悄抹掉 URL 参数，避免刷新永远被锁死在这一篇
          router.replace("/square");
        } else {
          // 正常进入（底部导航/直连）：完全随机打乱，每次刷新顺序都不一样
          setPosts(shufflePosts(mapped));
        }
      } catch (err) {
        console.error("[广场] 拉取帖子失败（请确认后端已启动）：", err);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [searchParams, router]);

  const post = posts[activeIndex] ?? posts[0];

  // 加载中
  if (loading) {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
        <p className="text-sm text-zinc-400">正在加载广场动态...</p>
      </div>
    );
  }

  // 空状态：数据库还没有任何帖子
  if (!post) {
    return (
      <div className="flex h-[calc(100vh-3.5rem)] flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-lg font-medium text-zinc-700">广场还没有动态</p>
        <p className="text-sm text-zinc-400">
          去「我的空间」点右下角 + 发布第一条吧
        </p>
      </div>
    );
  }

  return (
    /* 页面外层：固定高度、隐藏溢出，滚动只发生在文章内容区内部 */
    <div className="h-[calc(100vh-3.5rem)] overflow-hidden">
      {/* key = 文章 id：切换时整棵子树重新挂载，滚动位置与吸顶状态自动重置 */}
      <FeedView
        key={post.id}
        post={post}
        index={activeIndex}
        total={posts.length}
        onPrev={() => setActiveIndex((i) => Math.max(0, i - 1))}
        onNext={() => setActiveIndex((i) => Math.min(posts.length - 1, i + 1))}
      />
    </div>
  );
}
