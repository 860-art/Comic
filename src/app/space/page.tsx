/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  AtSign,
  CalendarDays,
  Hash,
  ImagePlus,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { ROUTES } from "@/lib/navigation";
import { ALL_TAGS } from "@/data/mockData";
import { getToken } from "@/lib/auth";
import { formatTime } from "@/lib/time";
import { ME_DEFAULT_AVATAR, ME_DEFAULT_BANNER, ME_DEFAULT_NAME } from "@/data/posts";

/**
 * 个人空间页（数据源：后端数据库 posts 表）：
 * - Banner + 白玻璃卡片 + 头像压交界线（与个人中心同款层级）
 * - 动态列表：GET /api/posts（真实数据库数据），只展示当前登录用户的帖子
 * - 发布抽屉：POST /api/posts（Authorization: Bearer token），成功后重新拉取列表
 * - 删除动态：DELETE /api/posts/{id}（仅作者本人可删）
 * - 未登录：拦截并引导去登录
 */

import { API_BASE } from "@/lib/api";

/** 后端 GET /api/posts 返回的单条数据结构 */
interface ApiPost {
  id: number;
  content: string | null;
  image_url: string | null;
  author_id: number;
  author_username: string;
  created_at: string;
}

export default function SpacePage() {
  // 与个人中心同步的资料（头像/背景副本，数据库为最终来源）
  const [nickname, setNickname] = useState(ME_DEFAULT_NAME);
  const [avatarSrc, setAvatarSrc] = useState(ME_DEFAULT_AVATAR);
  const [bannerSrc, setBannerSrc] = useState(ME_DEFAULT_BANNER);
  const [myId, setMyId] = useState<number | null>(null);

  // 动态列表（来自后端数据库）+ 加载状态
  const [posts, setPosts] = useState<ApiPost[]>([]);
  const [loading, setLoading] = useState(true);
  const [loggedIn, setLoggedIn] = useState(false);
  const [fans, setFans] = useState(0);

  // 发布抽屉状态
  const [composerOpen, setComposerOpen] = useState(false);
  const [content, setContent] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 标签选择抽屉（仅作用于本条动态的展示，不写入数据库）
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [customTags, setCustomTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");

  // 删除动态
  const [deleteTarget, setDeleteTarget] = useState<ApiPost | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  };

  // 从后端拉取帖子列表（GET /api/posts），并过滤出当前登录用户自己的动态
  const loadPosts = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/posts`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const all: ApiPost[] = await res.json();
      setPosts(myId === null ? [] : all.filter((p) => p.author_id === myId));
    } catch (err) {
      console.error("[空间] 拉取动态失败：", err);
      showToast("动态加载失败，请确认后端已启动");
    } finally {
      setLoading(false);
    }
  }, [myId]);

  // 挂载：读资料副本 + 资料接口确认身份（拿 author_id 用于过滤自己的帖子）
  useEffect(() => {
    const token = getToken();
    setLoggedIn(Boolean(token));
    try {
      const raw = window.localStorage.getItem("userInfo");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.nickname) setNickname(parsed.nickname);
        if (parsed?.avatar) setAvatarSrc(parsed.avatar);
        if (parsed?.banner) setBannerSrc(parsed.banner);
        if (typeof parsed?.fans === "number") setFans(parsed.fans);
      }
    } catch {
      // 忽略
    }

    if (!token) return;
    const loadMe = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) return;
        const data = await res.json();
        setMyId(data.user.id);
        if (data.user.avatar_url) setAvatarSrc(data.user.avatar_url);
        if (data.user.cover_url) setBannerSrc(data.user.cover_url);
      } catch (err) {
        console.error("[空间] 拉取用户信息失败：", err);
      }
    };
    loadMe();
  }, []);

  // myId 就绪后拉取帖子列表
  useEffect(() => {
    if (myId !== null && loggedIn) loadPosts();
    else if (!loggedIn) setLoading(false);
  }, [myId, loggedIn, loadPosts]);

  // 本地选图：FileReader 转 dataURL（可直接作为 image_url 提交入库）
  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setImages([reader.result as string]);
    reader.readAsDataURL(file);
  };

  // 标签选择（仅展示用）
  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };
  const addCustomTag = () => {
    const tag = tagInput.trim();
    if (!tag) return;
    if (!customTags.includes(tag)) setCustomTags((prev) => [...prev, tag]);
    if (!selectedTags.includes(tag)) setSelectedTags((prev) => [...prev, tag]);
    setTagInput("");
  };

  // 发布：带 Bearer token POST /api/posts → 成功后重新拉取列表
  const handlePublish = async () => {
    if (images.length === 0) {
      showToast("请至少上传一张图片");
      return;
    }
    const token = getToken();
    if (!token) {
      showToast("请先登录");
      return;
    }
    setPublishing(true);
    try {
      const res = await fetch(`${API_BASE}/api/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          content: content.trim() || null,
          image_url: images[0],
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        showToast(data?.detail ?? "发布失败，请稍后重试");
        return;
      }
      // 成功：清空表单 + 关闭抽屉 + 重新拉取当前页面的帖子列表
      setContent("");
      setImages([]);
      setSelectedTags([]);
      setComposerOpen(false);
      showToast("发布成功");
      await loadPosts();
    } catch (err) {
      console.error("[空间] 发布失败：", err);
      showToast("无法连接服务器，请确认后端已启动");
    } finally {
      setPublishing(false);
    }
  };

  // 删除动态：DELETE /api/posts/{id}（后端校验只有作者本人可删）
  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const token = getToken();
    if (!token) {
      showToast("请先登录");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/posts/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        showToast(data?.detail ?? "删除失败");
        return;
      }
      setDeleteOpen(false);
      setDeleteTarget(null);
      showToast("已删除");
      await loadPosts();
    } catch (err) {
      console.error("[空间] 删除失败：", err);
      showToast("无法连接服务器");
    }
  };

  // 未登录：拦截并引导登录
  if (!loggedIn) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-gradient-to-b from-violet-50 via-white to-white px-6 text-center">
        <p className="text-lg font-medium text-zinc-700">
          请先登录才能查看个人空间
        </p>
        <Link
          href={ROUTES.login}
          className="rounded-full bg-violet-500 px-8 py-2.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-violet-400"
        >
          登录
        </Link>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 via-white to-white pb-24">
      {/* ===== 顶部 Banner ===== */}
      <div className="relative h-64 w-full">
        <img
          src={bannerSrc}
          alt="空间背景"
          onError={(e) => {
            (e.target as HTMLImageElement).src = ME_DEFAULT_BANNER;
          }}
          className="h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-black/10" />
        <Link
          href={ROUTES.profile}
          aria-label="返回个人中心"
          className="absolute left-4 top-4 flex h-9 w-9 items-center justify-center rounded-full border border-white/60 bg-white/70 text-zinc-900 shadow-sm backdrop-blur-md transition-colors hover:bg-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </Link>
      </div>

      <div className="mx-auto max-w-3xl px-4">
        {/* ===== 白色玻璃名片卡片 ===== */}
        <div className="relative -mt-20 rounded-3xl border border-white/60 bg-white/70 shadow-[0_8px_32px_0_rgba(31,38,135,0.12)] backdrop-blur-xl">
          <img
            src={avatarSrc}
            alt="头像"
            onError={(e) => {
              (e.target as HTMLImageElement).src = ME_DEFAULT_AVATAR;
            }}
            className="absolute -top-16 left-6 h-32 w-32 rounded-full object-cover shadow-xl ring-4 ring-white"
          />

          <div className="pl-44 pr-6 pt-8">
            <p className="text-2xl font-bold text-zinc-900">{nickname}</p>
          </div>

          {/* 统计区：动态数来自数据库，粉丝/获赞来自真实资料 */}
          <div className="mt-4 grid grid-cols-3 divide-x divide-zinc-200/70 border-t border-zinc-200/70 px-6 py-4">
            <div className="text-center">
              <p className="text-xs text-zinc-400">动态</p>
              <p className="mt-1 text-xl font-bold text-zinc-900">{posts.length}</p>
            </div>
            <div className="text-center">
              <p className="text-xs text-zinc-400">粉丝</p>
              <p className="mt-1 text-xl font-bold text-zinc-900">{fans}</p>
            </div>
            <div className="text-center">
              <p className="text-xs text-zinc-400">获赞</p>
              <p className="mt-1 text-xl font-bold text-zinc-900">0</p>
            </div>
          </div>
        </div>

        {/* ===== 我的动态列表 ===== */}
        <div className="mt-6 flex items-center justify-between">
          <h2 className="text-lg font-bold text-zinc-900">动态</h2>
          <CalendarDays className="h-4 w-4 text-zinc-400" />
        </div>

        {/* 加载中 */}
        {loading && (
          <div className="flex items-center justify-center gap-3 py-16">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
            <p className="text-sm text-zinc-400">正在加载动态...</p>
          </div>
        )}

        <div className="mt-3 space-y-4">
          {!loading &&
            posts.map((post) => (
              <div
                key={post.id}
                className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl"
              >
                {/* 用户行：右侧删除入口 */}
                <div className="flex items-center gap-3">
                  <img
                    src={avatarSrc}
                    alt="头像"
                    onError={(e) => {
                      (e.target as HTMLImageElement).src = ME_DEFAULT_AVATAR;
                    }}
                    className="h-10 w-10 rounded-full object-cover"
                  />
                  <p className="text-sm font-semibold text-zinc-900">
                    {post.author_username}
                  </p>
                  <span className="ml-auto text-xs text-zinc-400">
                    {formatTime(post.created_at)}
                  </span>
                  <button
                    type="button"
                    aria-label="删除动态"
                    onClick={() => {
                      setDeleteTarget(post);
                      setDeleteOpen(true);
                    }}
                    className="flex h-8 w-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-red-500"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                {/* 文字内容 */}
                {post.content && (
                  <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-zinc-800">
                    {post.content}
                  </p>
                )}
                {/* 配图 */}
                {post.image_url && (
                  <img
                    src={post.image_url}
                    alt="动态配图"
                    className="mt-3 max-h-80 w-full rounded-xl object-cover"
                  />
                )}
              </div>
            ))}
          {!loading && posts.length === 0 && (
            <p className="py-10 text-center text-sm text-zinc-400">
              还没有发布过动态，点击右下角 + 分享一下吧
            </p>
          )}
        </div>
      </div>

      {/* ===== 悬浮发布按钮 ===== */}
      <button
        type="button"
        aria-label="发布动态"
        onClick={() => setComposerOpen(true)}
        className="fixed bottom-6 right-5 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-violet-500 text-white shadow-xl transition-transform hover:bg-violet-400 active:scale-90"
      >
        <Plus className="h-6 w-6" />
      </button>

      {/* ===== 发布动态抽屉 ===== */}
      <div
        onClick={() => setComposerOpen(false)}
        className={`fixed inset-0 z-[80] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          composerOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[85] transition-transform duration-300 ease-out ${
          composerOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="rounded-t-3xl border-t border-white/60 bg-white/90 shadow-2xl backdrop-blur-xl">
          <div className="flex items-center justify-between px-5 pt-4">
            <button
              type="button"
              onClick={() => setComposerOpen(false)}
              className="text-sm text-zinc-500"
            >
              取消
            </button>
            <p className="text-base font-bold text-zinc-900">写说说</p>
            <button
              type="button"
              onClick={handlePublish}
              disabled={publishing}
              className="rounded-lg bg-violet-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-violet-400 disabled:opacity-50"
            >
              {publishing ? "发布中..." : "发布"}
            </button>
          </div>

          <div className="px-5 py-4">
            <div className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-sm backdrop-blur-xl">
              <textarea
                rows={5}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="分享什么漫画好呢..."
                className="w-full resize-none bg-transparent text-sm leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
              />
              {selectedTags.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {selectedTags.map((tag) => (
                    <span
                      key={tag}
                      className="flex items-center gap-1.5 rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-600"
                    >
                      #{tag}
                      <button
                        type="button"
                        aria-label={`移除标签 ${tag}`}
                        onClick={() => toggleTag(tag)}
                        className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-200 text-violet-600 hover:bg-violet-300"
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {/* 配图预览（单张）+ 添加图片占位框 */}
              <div className="mt-3 flex flex-wrap gap-3">
                {images.map((src, i) => (
                  <div key={i} className="relative">
                    <img
                      src={src}
                      alt={`配图预览 ${i + 1}`}
                      className="h-24 w-24 rounded-lg object-cover"
                    />
                    <button
                      type="button"
                      aria-label="移除配图"
                      onClick={() => setImages([])}
                      className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900/80 text-white"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
                {images.length === 0 && (
                  <button
                    type="button"
                    aria-label="添加图片"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex h-24 w-24 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-300 bg-zinc-100/80 text-zinc-400 transition-colors hover:bg-zinc-200/70"
                  >
                    <ImagePlus className="h-6 w-6" />
                    <span className="text-xs">添加图片</span>
                  </button>
                )}
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                <span className="flex items-center gap-1 rounded-full bg-zinc-100 px-3 py-1.5 text-xs text-zinc-500">
                  <AtSign className="h-3 w-3" />
                  好友
                </span>
                <button
                  type="button"
                  onClick={() => setTagPickerOpen(true)}
                  className="flex items-center gap-1 rounded-full bg-zinc-100 px-3 py-1.5 text-xs text-zinc-500 transition-colors hover:bg-zinc-200/70"
                >
                  <Hash className="h-3 w-3" />
                  添加标签
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 标签选择抽屉（仅展示用） ===== */}
      <div
        onClick={() => setTagPickerOpen(false)}
        className={`fixed inset-0 z-[90] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          tagPickerOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[95] transition-transform duration-300 ease-out ${
          tagPickerOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="flex max-h-[70vh] flex-col rounded-t-3xl border-t border-white/60 bg-white/90 shadow-2xl backdrop-blur-xl">
          <div className="shrink-0 px-6 pt-5">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300" />
            <h3 className="text-xl font-bold text-zinc-900">选择标签</h3>
            <p className="mt-1 text-sm text-zinc-500">
              可选漫画标签，也可添加自定义标签（两者互不影响）
            </p>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
            <div>
              <p className="text-xs text-zinc-400">漫画标签</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {ALL_TAGS.filter((t) => t !== "全部").map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => toggleTag(tag)}
                    className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                      selectedTags.includes(tag)
                        ? "border-violet-500 bg-violet-500 text-white"
                        : "border-zinc-200 bg-white/80 text-zinc-700 hover:bg-zinc-100"
                    }`}
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            </div>
            {customTags.length > 0 && (
              <div>
                <p className="text-xs text-zinc-400">自定义标签</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {customTags
                    .filter((t) => !(ALL_TAGS as readonly string[]).includes(t))
                    .map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTag(tag)}
                        className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                          selectedTags.includes(tag)
                            ? "border-violet-500 bg-violet-500 text-white"
                            : "border-zinc-200 bg-white/80 text-zinc-700 hover:bg-zinc-100"
                        }`}
                      >
                        #{tag}
                      </button>
                    ))}
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addCustomTag()}
                placeholder="输入自定义标签"
                className="flex-1 rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={addCustomTag}
                className="rounded-xl bg-violet-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-400 active:scale-95"
              >
                添加
              </button>
            </div>
          </div>
          <div className="shrink-0 px-6 pb-6 pt-2">
            <button
              type="button"
              onClick={() => setTagPickerOpen(false)}
              className="w-full rounded-2xl bg-violet-500 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-violet-400 active:scale-[0.98]"
            >
              完成（已选 {selectedTags.length} 个）
            </button>
          </div>
        </div>
      </div>

      {/* ===== 删除动态 Action Sheet ===== */}
      <div
        onClick={() => setDeleteOpen(false)}
        className={`fixed inset-0 z-[90] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          deleteOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[95] transition-transform duration-300 ease-out ${
          deleteOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-3 mb-3 overflow-hidden rounded-3xl border border-white/60 bg-white/90 shadow-2xl backdrop-blur-xl">
          <div className="border-b border-zinc-200/70 px-4 py-3 text-center text-xs text-zinc-400">
            删除后无法恢复，确定删除这条动态吗？
          </div>
          <button
            type="button"
            onClick={confirmDelete}
            className="w-full border-b border-zinc-200/70 py-3.5 text-sm font-semibold text-violet-600 transition-colors hover:bg-zinc-100/70"
          >
            删除
          </button>
          <button
            type="button"
            onClick={() => setDeleteOpen(false)}
            className="w-full py-3.5 text-sm text-zinc-500 transition-colors hover:bg-zinc-100/70"
          >
            取消
          </button>
        </div>
      </div>

      {/* 隐藏的本地文件选择 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFile}
      />

      {/* Toast */}
      {toastMsg && (
        <div className="fixed left-1/2 top-1/2 z-[100] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-black/60 px-6 py-3 text-white backdrop-blur-xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
