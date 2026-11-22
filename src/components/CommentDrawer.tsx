/* eslint-disable @next/next/no-img-element */
"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ImagePlus, Plus, ThumbsUp, X } from "lucide-react";
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

/** 单条评论：头像 + @名字（可点击跳转空间） + 正文 + 配图 + 时间 + 点赞/回复 */
function CommentItemView({
  comment,
  liked,
  onToggleLike,
  onImageClick,
  compact = false,
}: {
  comment: CommentItem;
  liked: boolean;
  onToggleLike: (id: string) => void;
  /** 点击评论配图 → 全屏放大查看 */
  onImageClick: (url: string) => void;
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
        {comment.content && (
          <p className="mt-1 text-sm leading-relaxed text-gray-800">
            {comment.content}
          </p>
        )}
        {/* 评论配图：正文下方展示，点击全屏放大 */}
        {comment.image && (
          <button
            type="button"
            onClick={() => onImageClick(comment.image as string)}
            className="mt-2 block"
          >
            <img
              src={comment.image}
              alt="评论配图"
              className="max-h-56 max-w-full cursor-zoom-in rounded-xl border border-gray-200 object-cover"
            />
          </button>
        )}
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
  /**
   * 发布回调：返回 true（或 Promise<true>）表示发布成功，抽屉随之清空输入框与配图。
   * imageDataUrl：加号选择的图片（本地 dataURL），由调用方上传后随评论保存
   */
  onPublish: (
    content: string,
    imageDataUrl?: string
  ) => boolean | Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // ===== 附图评论：加号菜单 / 待发布配图预览 / 配图放大查看 =====
  const [menuOpen, setMenuOpen] = useState(false);
  const [pendingImage, setPendingImage] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 动态绑定列表长度：发布一条，数字自动 +1，与列表内容永远一致
  const total = comments.length;

  // 输入框有内容（文字或配图）→ 发布按钮变紫色可用态
  const hasInput = Boolean(draft.trim() || pendingImage);

  const handlePublishClick = async () => {
    if (!hasInput) return;
    const ok = await onPublish(draft, pendingImage || undefined);
    if (ok) {
      setDraft("");
      setPendingImage(null);
    }
  };

  // 选择照片：读入本地文件转 dataURL 预览（上传与保存由调用方在发布时完成）
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    setMenuOpen(false);
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setPendingImage(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
    e.target.value = ""; // 允许再次选择同一张图
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

          {/* 输入区：多行输入框 + 加号（选图菜单）+ 发表评论（有内容时变紫） */}
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
                onClick={() => setMenuOpen(true)}
                className="absolute right-3 top-3 flex h-7 w-7 items-center justify-center rounded-full border border-white/20 bg-black/40 text-white backdrop-blur-md transition-transform active:scale-90"
              >
                <Plus className="h-4 w-4" />
              </button>

              {/* 加号菜单：选择照片 / 取消 */}
              {menuOpen && (
                <>
                  <div
                    className="fixed inset-0 z-[95]"
                    onClick={() => setMenuOpen(false)}
                  />
                  <div className="absolute right-0 top-10 z-[96] w-44 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-xl">
                    <button
                      type="button"
                      onClick={() => fileRef.current?.click()}
                      className="flex w-full items-center gap-2 px-4 py-3 text-sm text-gray-800 transition-colors hover:bg-gray-50"
                    >
                      <ImagePlus className="h-4 w-4 text-violet-500" />
                      选择照片
                    </button>
                    <button
                      type="button"
                      onClick={() => setMenuOpen(false)}
                      className="flex w-full items-center gap-2 border-t border-gray-100 px-4 py-3 text-sm text-gray-500 transition-colors hover:bg-gray-50"
                    >
                      <X className="h-4 w-4" />
                      取消
                    </button>
                  </div>
                </>
              )}
            </div>

            {/* 隐藏的文件选择框 */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleFileChange}
            />

            {/* 待发布配图预览：缩略图 + 移除 */}
            {pendingImage && (
              <div className="mt-3 flex items-center gap-3">
                <div className="relative">
                  <img
                    src={pendingImage}
                    alt="待发布的评论配图"
                    className="h-20 w-20 rounded-xl border border-gray-200 object-cover"
                  />
                  <button
                    type="button"
                    aria-label="移除配图"
                    onClick={() => setPendingImage(null)}
                    className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-black/70 text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
                <p className="text-xs text-gray-400">发布后图片将随评论一起展示</p>
              </div>
            )}

            <button
              type="button"
              onClick={handlePublishClick}
              className={`mt-3 w-full rounded-2xl border border-white/20 py-3 text-sm font-medium text-white backdrop-blur-md transition-all active:scale-[0.98] ${
                hasInput
                  ? "bg-violet-500 hover:bg-violet-400"
                  : "bg-black/40 hover:bg-black/55"
              }`}
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
                  onImageClick={setLightboxUrl}
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
                            onImageClick={setLightboxUrl}
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

            {/* 评论配图放大查看：全屏遮罩，点击任意处关闭 */}
            {lightboxUrl && (
              <div
                className="fixed inset-0 z-[120] flex items-center justify-center bg-black/90"
                onClick={() => setLightboxUrl(null)}
              >
                <img
                  src={lightboxUrl}
                  alt="评论配图放大"
                  className="max-h-[85vh] max-w-full cursor-zoom-out object-contain"
                />
                <button
                  type="button"
                  aria-label="关闭放大"
                  onClick={() => setLightboxUrl(null)}
                  className="absolute right-4 top-4 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-md"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            )}
            </>
            );
            }
