/* eslint-disable @next/next/no-img-element */
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Plus, ThumbsUp, X } from "lucide-react";
import { findUserByName, getSpaceHref, ME_DEFAULT_NAME } from "@/data/posts";
import { type CommentItem } from "@/data/comments";

/**
 * 全站共享的玻璃态评论抽屉（漫画广场、漫画详情页复用）。
 * - 数据模型统一放在 src/data/comments.ts（本文件 re-export 保持旧引用可用）
 * - 假数据 MOCK_COMMENTS 已彻底删除：列表由调用方传入（真实接口或空数组）
 * - 抽屉：底部弹出 80vh，白色磨砂质感，点遮罩/X 收回
 * - 评论条目：真实头像（无头像用 ui-avatars.com 网络默认图兜底，可点进空间）
 *   + @名字 + 正文 + 时间 + 点赞（变红/+1）/ 嵌套回复
 */

export type { CommentItem };

/** 无头像时的网络默认图兜底（按用户名生成首字母头像） */
function avatarFallback(name: string): string {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name) || "U"}&background=7C3AED&color=fff`;
}

/** 单条评论：头像 + @名字（可点击跳转空间） + 正文 + 时间 + 点赞/回复 */
function CommentItemView({
  comment,
  liked,
  onToggleLike,
  compact = false,
}: {
  comment: CommentItem;
  liked: boolean;
  onToggleLike: (id: string) => void;
  compact?: boolean;
}) {
  const router = useRouter();
  // 点击头像/名字 → 跳转到对应用户空间（当前用户 → /space，其他 → /space/[id]）
  const openSpace = () => {
    if (comment.author === ME_DEFAULT_NAME) {
      router.push("/space");
      return;
    }
    const user = findUserByName(comment.author);
    if (user) router.push(getSpaceHref(user.id));
  };

  return (
    <div className="flex gap-3">
      <button
        type="button"
        aria-label={`查看 ${comment.author} 的空间`}
        onClick={openSpace}
        className={`shrink-0 overflow-hidden rounded-full transition-transform hover:opacity-80 active:scale-90 ${
          compact ? "h-7 w-7" : "h-9 w-9"
        }`}
      >
        {/* 真实头像：无头像时用 ui-avatars.com 网络默认图兜底 */}
        <img
          src={comment.avatar || avatarFallback(comment.author)}
          alt={`${comment.author} 的头像`}
          className="h-full w-full object-cover"
        />
      </button>
      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={openSpace}
          className="text-sm font-bold text-gray-900 hover:underline"
        >
          @{comment.author}
        </button>
        <p className="mt-1 text-sm leading-relaxed text-gray-800">
          {comment.content}
        </p>
        <p className="mt-1 text-xs text-gray-400">{comment.time}</p>
        {/* 点赞按钮在正文右下侧：变红 + 数字 +1，带缩放动画 */}
        <div className="mt-2 flex items-center gap-5">
          <button
            type="button"
            onClick={() => onToggleLike(comment.id)}
            className="flex items-center gap-1 text-xs text-gray-500 transition-transform active:scale-75"
          >
            <ThumbsUp
              className={`h-4 w-4 transition-colors ${
                liked ? "fill-red-500 text-red-500" : ""
              }`}
            />
            {comment.likes + (liked ? 1 : 0)}
          </button>
          <button type="button" className="text-xs text-gray-500">
            回复
          </button>
        </div>
      </div>
    </div>
  );
}

/** 评论抽屉：底部弹出（80vh，顶部留出 20vh），白色磨砂质感，点遮罩/X 收回 */
export default function CommentDrawer({
  open,
  onClose,
  post,
  comments,
  loading = false,
  likedComments,
  onToggleLike,
  onPublish,
}: {
  open: boolean;
  onClose: () => void;
  /** 抽屉顶部展示的信息（标题 + 作者），由调用方传入 */
  post: { title: string; author: string };
  comments: CommentItem[];
  /** 列表加载中：显示转圈提示 */
  loading?: boolean;
  likedComments: Record<string, boolean>;
  onToggleLike: (id: string) => void;
  /** 发布回调：返回 true（或 Promise<true>）表示发布成功，抽屉随之清空输入框 */
  onPublish: (content: string) => boolean | Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // 动态绑定列表长度：发布一条，数字自动 +1，与列表内容永远一致
  const total = comments.length;

  const handlePublishClick = async () => {
    const ok = await onPublish(draft);
    if (ok) setDraft("");
  };

  return (
    <>
      {/* 背景遮罩：点击收回抽屉 */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-[80] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />

      {/* 抽屉面板：transition-transform 从底部弹出 / 收回 */}
      <div
        className={`fixed inset-x-0 bottom-0 z-[90] h-[80vh] transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="flex h-full flex-col rounded-t-3xl border-t border-white/60 bg-white/90 text-gray-900 backdrop-blur-xl">
          {/* 顶部栏：头像 + 评论数 + 文章信息 + 关闭 */}
          <div className="shrink-0 border-b border-gray-200/80 px-5 py-4">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-gray-300" />
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-200 text-sm text-gray-700">
                {post.author.slice(0, 1)}
              </div>
              <div className="min-w-0">
                <p className="font-bold text-gray-900">{total} 条评论</p>
                <p className="truncate text-xs text-gray-500">
                  {post.title} · by @{post.author}
                </p>
              </div>
              <button
                type="button"
                aria-label="关闭评论"
                onClick={onClose}
                className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white backdrop-blur-md transition-transform active:scale-90"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* 输入区：多行输入框 + 加号 + 发表评论（玻璃态按钮） */}
          <div className="shrink-0 border-b border-gray-200/80 px-5 py-4">
            <div className="relative">
              <textarea
                rows={2}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="写点什么..."
                className="w-full resize-none rounded-2xl border border-white/60 bg-white/70 px-4 py-3 pr-12 text-sm text-gray-900 shadow-inner backdrop-blur-md placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-gray-900/10"
              />
              <button
                type="button"
                aria-label="添加内容"
                className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white backdrop-blur-md"
              >
                <Plus className="h-4 w-4" />
              </button>
            </div>
            <button
              type="button"
              onClick={handlePublishClick}
              className="mt-3 w-full rounded-2xl border border-white/20 bg-black/40 py-3 text-sm font-medium text-white backdrop-blur-md transition-all hover:bg-black/55 active:scale-[0.98]"
            >
              发表评论
            </button>
          </div>

          {/* 评论列表（可滚动）：加载中 / 暂无评论 / 嵌套回复 */}
          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <div className="h-7 w-7 animate-spin rounded-full border-2 border-gray-200 border-t-violet-500" />
                <p className="text-sm text-gray-400">正在加载评论...</p>
              </div>
            ) : comments.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-center">
                <p className="text-sm font-medium text-gray-500">暂无评论</p>
                <p className="mt-1 text-xs text-gray-400">
                  快来抢沙发，写下第一条评论吧
                </p>
              </div>
            ) : (
              comments.map((c) => (
              <div key={c.id}>
                <CommentItemView
                  comment={c}
                  liked={!!likedComments[c.id]}
                  onToggleLike={onToggleLike}
                />
                {c.replies.length > 0 && (
                  <div className="mt-3">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((p) => ({ ...p, [c.id]: !p[c.id] }))
                      }
                      className="flex items-center gap-1 text-xs text-gray-500"
                    >
                      <ChevronDown
                        className={`h-3.5 w-3.5 transition-transform ${
                          expanded[c.id] ? "rotate-180" : ""
                        }`}
                      />
                      {c.replies.length} 条回复
                    </button>
                    {expanded[c.id] && (
                      <div className="ml-12 mt-3 space-y-4 border-l-2 border-gray-200 pl-4">
                        {c.replies.map((r) => (
                          <CommentItemView
                            key={r.id}
                            comment={r}
                            liked={!!likedComments[r.id]}
                            onToggleLike={onToggleLike}
                            compact
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
            )}
            </div>
            </div>
            </div>
            </>
            );
            }
