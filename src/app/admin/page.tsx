/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, Inbox, Lock, Plus, XCircle } from "lucide-react";
import { getToken } from "@/lib/auth";
import { ROUTES } from "@/lib/navigation";
import { formatTime } from "@/lib/time";
import { cacheApprovedComic } from "@/data/pendingComics";

/**
 * 管理员审核台（/admin，真实后端版）：
 * - 带 Token 请求 GET /api/admin/pending 获取待审核投稿（后端校验 role === 'admin'，非管理员 403）
 * - 卡片展示书名 / 封面 / 作者 / 投稿人 / AI 翻译需求 / 提交时间
 * - 绿色『通过』→ POST /api/admin/comics/{id}/review {action:"approve"}：后端复制进正式 comics 表
 * - 红色『驳回』→ {action:"reject"}：后端删除待审核记录
 * - 未登录 → 登录引导；非管理员 → 403 无权限提示
 */

import { API_BASE } from "@/lib/api";

/** 后端 GET /api/admin/pending 返回的单条数据结构 */
interface ApiPending {
  id: number;
  title: string;
  author: string;
  cover_url: string | null;
  tags: string[];
  intro: string | null;
  need_translation: boolean;
  submitter_id: number;
  submitter_username: string;
  status: string;
  chapters: { title: string; images: string[] }[];
  submit_type: string;
  target_comic_id: number | null;
  created_at: string;
}

type ViewState = "loading" | "unauthorized" | "ready";

export default function AdminPage() {
  const router = useRouter();
  const [view, setView] = useState<ViewState>("loading");
  const [pending, setPending] = useState<ApiPending[]>([]);
  const [acting, setActing] = useState<number | null>(null); // 正在审核的投稿 id
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // 审核详情抽屉：当前查看的投稿 id（null = 关闭）
  const [detailId, setDetailId] = useState<number | null>(null);
  const detailItem = pending.find((p) => p.id === detailId) ?? null;

  // ===== 公告发布：抽屉开关 + 表单 =====
  const [annOpen, setAnnOpen] = useState(false);
  const [annTitle, setAnnTitle] = useState("");
  const [annContent, setAnnContent] = useState("");
  const [annPublishing, setAnnPublishing] = useState(false);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  };

  // 发布公告：带 Token POST /api/admin/announcements（后端校验 role === 'admin'）
  const handlePublishAnnouncement = async () => {
    if (!annTitle.trim()) {
      showToast("请填写公告标题");
      return;
    }
    if (!annContent.trim()) {
      showToast("请填写公告内容");
      return;
    }
    const token = getToken();
    if (!token) {
      setView("unauthorized");
      return;
    }
    setAnnPublishing(true);
    try {
      const res = await fetch(`${API_BASE}/api/admin/announcements`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: annTitle.trim(),
          content: annContent.trim(),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "发布失败，请稍后重试");
        return;
      }
      // 成功：关闭抽屉、清空表单、提示发布成功
      setAnnOpen(false);
      setAnnTitle("");
      setAnnContent("");
      showToast("公告发布成功");
    } catch (err) {
      console.error("[审核台] 发布公告失败：", err);
      showToast("无法连接服务器");
    } finally {
      setAnnPublishing(false);
    }
  };

  // 拉取待审核列表（带 Token）
  const loadPending = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setView("unauthorized");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/admin/pending`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        setView("unauthorized");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: ApiPending[] = await res.json();
      setPending(data);
      setView("ready");
    } catch (err) {
      console.error("[审核台] 拉取待审核列表失败：", err);
      showToast("无法连接服务器，请确认后端已启动");
      setView("unauthorized");
    }
  }, []);

  useEffect(() => {
    loadPending();
  }, [loadPending]);

  // 审核操作：action = approve | reject，成功后刷新列表
  const handleReview = async (
    id: number,
    action: "approve" | "reject"
  ): Promise<boolean> => {
    const token = getToken();
    if (!token) {
      setView("unauthorized");
      return false;
    }
    setActing(id);
    try {
      const res = await fetch(`${API_BASE}/api/admin/comics/${id}/review`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "审核失败，请稍后重试");
        return false;
      }
      // approve：新建 → 后端返回的正式漫画（含真实章节）写入本地缓存；
      // 追加章节 → 不重复缓存，详情/阅读页直接走后端 API 拿目标漫画的最新章节
      if (action === "approve" && data?.comic_id) {
        const item = pending.find((p) => p.id === id);
        if (item && (item.submit_type || "new") !== "append") {
          const cached = cacheApprovedComic({
            id: data.comic_id,
            title: item.title,
            author: item.author,
            cover: item.cover_url ?? "",
            tags: item.tags,
            intro: item.intro,
            needTranslation: item.need_translation,
            chapters: data.chapters?.length
              ? data.chapters // 后端返回的真实章节 [{id,title,pages}]
              : item.chapters.map((ch) => ({ title: ch.title, pages: ch.images.length || 8 })),
          });
          if (!cached) showToast("已通过，但本地缓存失败");
        }
        showToast(action === "approve" && data?.chapters ? data.message || "已通过！" : "已通过并发布！");
      } else {
        showToast("已驳回");
      }
      await loadPending();
      return true;
    } catch (err) {
      console.error("[审核台] 审核请求失败：", err);
      showToast("无法连接服务器");
      return false;
    } finally {
      setActing(null);
    }
  };

  // 未登录 / 非管理员：登录引导（后端对非 admin 账号返回 403）
  if (view === "loading") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-50">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
        <p className="text-sm text-zinc-400">正在加载审核台...</p>
      </div>
    );
  }

  if (view === "unauthorized") {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-gradient-to-b from-zinc-50 via-white to-white px-6 text-center">
        <Lock className="h-10 w-10 text-zinc-300" />
        <p className="text-lg font-medium text-zinc-700">
          请使用管理员账号登录后访问审核台
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
    <div className="min-h-screen bg-gradient-to-b from-zinc-50 via-white to-white pb-16">
      {/* 顶栏 */}
      <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-zinc-200/60 bg-white/80 px-4 backdrop-blur-xl">
        <button
          type="button"
          aria-label="返回"
          onClick={() => router.back()}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-zinc-900 shadow-sm transition-colors hover:bg-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-base font-bold text-zinc-900">管理员审核台</h1>
        {pending.length > 0 && (
          <span className="ml-auto rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-600">
            待审核 {pending.length} 篇
          </span>
        )}
      </div>

      <div className="mx-auto max-w-2xl px-4 pt-5">
        {/* 空状态 */}
        {pending.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-24 text-center">
            <Inbox className="h-10 w-10 text-zinc-300" />
            <p className="text-sm text-zinc-400">暂无待审核稿件</p>
          </div>
        ) : (
          <div className="space-y-4">
            {pending.map((item) => (
              <div
                key={item.id}
                className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl"
              >
                <div className="flex gap-4">
                  {/* 封面：点击打开审核详情抽屉 */}
                  {item.cover_url && (
                    <button
                      type="button"
                      aria-label={`查看《${item.title}》详情`}
                      onClick={() => setDetailId(item.id)}
                      className="shrink-0 transition-transform active:scale-95"
                    >
                      <img
                        src={item.cover_url}
                        alt={`${item.title}封面`}
                        className="h-36 w-24 rounded-xl object-cover"
                      />
                    </button>
                  )}
                  {/* 信息 */}
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setDetailId(item.id)}
                      className="block max-w-full truncate text-left text-base font-bold text-zinc-900 hover:text-violet-600"
                    >
                      {item.title}
                    </button>
                    <p className="mt-1 text-sm text-zinc-500">
                      作者：{item.author}
                    </p>
                    <p className="mt-0.5 text-xs text-zinc-400">
                      投稿人：{item.submitter_username}
                    </p>
                    {/* 投稿类型标识：蓝 = 新建整本，紫 = 追加章节 */}
                    {(item.submit_type || "new") === "append" ? (
                      <span className="mr-1.5 mt-2 inline-flex items-center gap-1 rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-600">
                        追加章节{item.target_comic_id ? ` → 漫画 #${item.target_comic_id}` : ""}
                      </span>
                    ) : (
                      <span className="mr-1.5 mt-2 inline-flex items-center gap-1 rounded-full bg-sky-100 px-2.5 py-0.5 text-xs font-medium text-sky-600">
                        新建整本
                      </span>
                    )}
                    {/* AI 翻译需求标识：绿色 = 需要，灰色 = 不需要 */}
                    <span
                      className={`mt-2 inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                        item.need_translation
                          ? "bg-emerald-100 text-emerald-600"
                          : "bg-zinc-100 text-zinc-500"
                      }`}
                    >
                      {item.need_translation ? "需要AI翻译" : "不需要翻译"}
                    </span>
                    {item.tags.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {item.tags.map((tag) => (
                          <span
                            key={tag}
                            className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs text-violet-600"
                          >
                            #{tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {item.intro && (
                      <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-zinc-400">
                        {item.intro}
                      </p>
                    )}
                    <p className="mt-2 text-xs text-zinc-400">
                      提交于 {formatTime(item.created_at)}
                    </p>
                  </div>
                </div>
                {/* 审核操作：真实请求后端审核 API */}
                <div className="mt-4 flex gap-3">
                  <button
                    type="button"
                    disabled={acting === item.id}
                    onClick={() => handleReview(item.id, "approve")}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    {acting === item.id ? "处理中..." : "通过"}
                  </button>
                  <button
                    type="button"
                    disabled={acting === item.id}
                    onClick={() => handleReview(item.id, "reject")}
                    className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <XCircle className="h-4 w-4" />
                    驳回
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 右下角悬浮紫色 + 号：打开发布公告抽屉 */}
      <button
        type="button"
        aria-label="发布公告"
        onClick={() => setAnnOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-violet-500 text-white shadow-[0_8px_24px_0_rgba(124,58,237,0.45)] transition-all hover:bg-violet-400 hover:scale-105 active:scale-95"
      >
        <Plus className="h-6 w-6" />
      </button>

      {/* ===== 发布公告抽屉（底部弹出） ===== */}
      <div
        onClick={() => !annPublishing && setAnnOpen(false)}
        className={`fixed inset-0 z-[90] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          annOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[95] mx-auto max-w-2xl transform rounded-t-3xl border-t border-white/60 bg-white/95 shadow-2xl backdrop-blur-xl transition-transform duration-300 ${
          annOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="shrink-0 px-6 pt-5">
          <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300" />
          <h3 className="text-xl font-bold text-zinc-900">发布公告</h3>
          <p className="mt-1 text-sm text-zinc-500">
            公告将实时推送到所有用户的通知中心。
          </p>
        </div>
        <div className="px-6 py-4">
          {/* 公告标题 */}
          <input
            type="text"
            value={annTitle}
            onChange={(e) => setAnnTitle(e.target.value)}
            placeholder="公告标题，如“全新 AI 翻译功能上线”"
            className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
          />
          {/* 公告内容多行输入框 */}
          <textarea
            value={annContent}
            onChange={(e) => setAnnContent(e.target.value)}
            rows={5}
            placeholder="公告正文内容..."
            className="mt-3 w-full resize-none rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
          />
        </div>
        <div className="shrink-0 px-6 pb-6 pt-2">
          <button
            type="button"
            disabled={annPublishing}
            onClick={handlePublishAnnouncement}
            className="w-full rounded-2xl bg-violet-500 py-3 text-sm font-semibold text-white shadow-lg transition-all hover:bg-violet-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {annPublishing ? "发布中..." : "发布公告"}
          </button>
        </div>
      </div>

      {/* ===== 审核详情抽屉（底部弹出，全高可滚动） ===== */}
      <div
        onClick={() => setDetailId(null)}
        className={`fixed inset-0 z-[92] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          detailItem ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[96] mx-auto flex max-h-[88vh] max-w-2xl transform flex-col rounded-t-3xl border-t border-white/60 bg-white/95 shadow-2xl backdrop-blur-xl transition-transform duration-300 ${
          detailItem ? "translate-y-0" : "translate-y-full"
        }`}
      >
        {detailItem && (
          <>
            {/* 抽屉头部：书名 + 投稿人 + 关闭 */}
            <div className="shrink-0 px-6 pt-5">
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300" />
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="text-xl font-bold text-zinc-900">
                    {detailItem.title}
                  </h3>
                  <p className="mt-1 text-sm text-zinc-500">
                    作者：{detailItem.author} · 投稿人：
                    {detailItem.submitter_username}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="关闭"
                  onClick={() => setDetailId(null)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-100 text-zinc-500 transition-colors hover:bg-zinc-200"
                >
                  <XCircle className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* 抽屉滚动区：封面 + 简介 + 标签 + 各章节内页图 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
              <div className="mt-4 flex gap-4">
                {detailItem.cover_url && (
                  <img
                    src={detailItem.cover_url}
                    alt={`${detailItem.title}封面`}
                    className="h-32 w-[5.5rem] shrink-0 rounded-xl object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  {/* 标签 */}
                  {detailItem.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {detailItem.tags.map((tag) => (
                        <span
                          key={tag}
                          className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs text-violet-600"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-zinc-400">暂无标签</p>
                  )}
                  {/* 简介 */}
                  <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-zinc-600">
                    {detailItem.intro || "暂无简介"}
                  </p>
                  <p className="mt-2 text-xs text-zinc-400">
                    提交于 {formatTime(detailItem.created_at)} · 共{" "}
                    {detailItem.chapters.length} 个章节
                  </p>
                </div>
              </div>

              {/* 章节内页预览：逐章展示标题 + 图片竖向列表 */}
              <div className="mt-5 space-y-5">
                {detailItem.chapters.map((ch, chIdx) => (
                  <div key={`${ch.title}-${chIdx}`}>
                    <p className="mb-2 text-sm font-semibold text-zinc-800">
                      {ch.title || `第${chIdx + 1}话`}
                      <span className="ml-2 text-xs font-normal text-zinc-400">
                        {ch.images.length} 页
                      </span>
                    </p>
                    {ch.images.length === 0 ? (
                      <p className="text-xs text-zinc-400">本章暂无内页图</p>
                    ) : (
                      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                        {ch.images.map((src, imgIdx) => (
                          <a
                            key={`${imgIdx}-${src.slice(0, 24)}`}
                            href={src}
                            target="_blank"
                            rel="noreferrer"
                            className="block"
                          >
                            <img
                              src={src}
                              alt={`${ch.title || `第${chIdx + 1}话`} 第${imgIdx + 1}页`}
                              className="aspect-[3/4] w-full rounded-lg border border-zinc-100 object-cover"
                            />
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
                {detailItem.chapters.length === 0 && (
                  <p className="text-xs text-zinc-400">本次投稿未包含章节内页</p>
                )}
              </div>
            </div>

            {/* 抽屉底部：通过 / 驳回（看完直接操作） */}
            <div className="shrink-0 border-t border-zinc-100 px-6 py-4">
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={acting === detailItem.id}
                  onClick={async () => {
                    if (await handleReview(detailItem.id, "approve")) {
                      setDetailId(null);
                    }
                  }}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-emerald-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <CheckCircle2 className="h-4 w-4" />
                  {acting === detailItem.id ? "处理中..." : "通过"}
                </button>
                <button
                  type="button"
                  disabled={acting === detailItem.id}
                  onClick={async () => {
                    if (await handleReview(detailItem.id, "reject")) {
                      setDetailId(null);
                    }
                  }}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-red-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <XCircle className="h-4 w-4" />
                  驳回
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {/* 屏幕正中玻璃态 Toast */}
      {toastMsg && (
        <div className="fixed left-1/2 top-1/2 z-[100] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-black/60 px-6 py-3 text-white backdrop-blur-xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
