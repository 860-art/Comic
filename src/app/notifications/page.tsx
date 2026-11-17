"use client";

import { ArrowLeft, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth";

import { API_BASE } from "@/lib/api";

/**
 * 通知中心（/notifications，双数据源合并版）：
 * - 数据源 A：GET /api/announcements（官方公告，公开接口）
 * - 数据源 B：GET /api/notifications（点赞/评论真实互动通知，带 Token；未登录跳过）
 * - 合并后按真实时间 created_at 倒序渲染
 * - 官方公告：紫色“官”字头像 + line-clamp-2 点击展开全文（expandedId 只展开一条）
 * - 互动通知：触发者真实头像（ui-avatars.com 兜底）+ “xx 赞了你的动态 / 评论了你：...”，
 *   点击跳转 /square 查看对应动态
 * - 管理员（GET /api/auth/me 的 role === 'admin'）：右下角悬浮紫色 + 号 → 底部抽屉发布公告
 */

/** 后端 GET /api/announcements 返回的单条数据结构（未登录时的公告来源） */
interface ApiAnnouncement {
  id: number;
  title: string;
  content: string;
  created_at: string;
}

/**
 * 后端 GET /api/notifications 返回的单条数据结构（已由后端合并）：
 * - source = "notification"：仅当前 Token 用户的私人通知（后端按 recipient_id 过滤）
 * - source = "announcement"：全站公开公告（后端不加用户过滤）
 */
interface ApiNotification {
  /** 来源：私人通知 / 全站公告 */
  source: "notification" | "announcement";
  id: number;
  type: "like" | "comment" | "review" | "official";
  title: string | null;
  actor_id: number;
  actor_username: string;
  actor_avatar: string | null;
  recipient_id: number | null;
  post_id: number | null;
  content: string | null;
  is_read: boolean;
  created_at: string;
}

/** 合并后的统一渲染条目：kind 区分官方公告与互动/审核通知 */
interface UnifiedItem {
  kind: "official" | "like" | "comment" | "review";
  /** 唯一渲染 key：ann-{id} / noti-{id} */
  id: string;
  /** 数据来源（删除时决定调用公告接口还是通知接口） */
  source: "notification" | "announcement";
  /** 公告标题（私人通知为空） */
  title?: string;
  /** 公告正文 / 评论内容（like 为空） */
  content: string;
  /** 互动触发者（官方公告为空） */
  actorUsername?: string;
  actorAvatar?: string;
  /** 关联帖子 id（互动通知跳转广场定位用） */
  postId?: number;
  /** 数据表主键（删除接口用） */
  numericId?: number;
  createdAt: string;
}

/** 官方公告默认头像兜底（无头像时紫底白字首字母图） */
function avatarFallback(name: string): string {
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(name) || "U"}&background=7C3AED&color=fff`;
}

/** 相对时间格式化：刚发布几分钟内显示“刚刚”，否则 年-月-日 时:分 */
function formatAnnouncementTime(iso: string): string {
  try {
    const date = new Date(iso);
    const diffMin = Math.floor((Date.now() - date.getTime()) / 60000);
    if (diffMin < 1) return "刚刚";
    if (diffMin < 60) return `${diffMin} 分钟前`;
    if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)} 小时前`;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return "";
  }
}

export default function NotificationsPage() {
  const router = useRouter();
  // 合并后的列表（公告 + 互动通知，created_at 倒序）
  const [items, setItems] = useState<UnifiedItem[]>([]);
  const [loading, setLoading] = useState(true);
  // 当前展开全文的公告 id：同一时间只有一条展开，再次点击收起
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // 管理员身份（GET /api/auth/me 的 role）
  const [isAdmin, setIsAdmin] = useState(false);

  // ===== 管理员删除通知：二次确认目标 + 删除中标记 =====
  const [deleteTarget, setDeleteTarget] = useState<UnifiedItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ===== 管理员发布抽屉 =====
  const [annOpen, setAnnOpen] = useState(false);
  const [annTitle, setAnnTitle] = useState("");
  const [annContent, setAnnContent] = useState("");
  const [annPublishing, setAnnPublishing] = useState(false);
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  };

  useEffect(() => {
    const token = getToken();

    // 已登录：后端 GET /api/notifications 已合并『我的私人通知 + 全站公告』（倒序），
    // 前端不再自行拼接，避免把别人的通知混进来。
    // 未登录：只能看全站公告（GET /api/announcements 公开接口）。
    const loadList: Promise<ApiNotification[]> = token
      ? fetch(`${API_BASE}/api/notifications`, {
          headers: { Authorization: `Bearer ${token}` },
        })
          .then((res) => (res.ok ? res.json() : []))
          .catch(() => [])
      : fetch(`${API_BASE}/api/announcements`)
          .then((res) => (res.ok ? res.json() : []))
          .then((anns: ApiAnnouncement[]) =>
            anns.map((a) => ({
              source: "announcement" as const,
              id: a.id,
              type: "official" as const,
              title: a.title,
              actor_id: 0,
              actor_username: "AoliComic官方",
              actor_avatar: null,
              recipient_id: null,
              post_id: null,
              content: a.content,
              is_read: true,
              created_at: a.created_at,
            }))
          )
          .catch(() => []);

    // 进入通知中心即把全部通知标记为已读（导航栏铃铛红点消失）
    if (token) {
      fetch(`${API_BASE}/api/notifications/read`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {
        // 标记失败不影响展示
      });

      // 管理员身份判断（失败不影响通知展示）
      fetch(`${API_BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then((res) => (res.ok ? res.json() : null))
        .then((data) => {
          if (data?.user?.role === "admin") setIsAdmin(true);
        })
        .catch(() => {
          // 忽略，保持非管理员
        });
    }

    loadList.then((rows) => {
      const mapped: UnifiedItem[] = rows.map((n) => ({
        kind: n.type,
        source: n.source,
        id: `${n.source === "announcement" ? "ann" : "noti"}-${n.id}`,
        title: n.title ?? undefined,
        content: n.content ?? "",
        actorUsername: n.actor_username || undefined,
        actorAvatar: n.actor_avatar ?? undefined,
        postId: n.post_id ?? undefined,
        numericId: n.id,
        createdAt: n.created_at,
      }));
      // 再兜底排一次（同秒并发时保持稳定倒序）
      mapped.sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      setItems(mapped);
      setLoading(false);
    });
  }, []);

  // 管理员删除：
  // - 公告 → DELETE /api/announcements/{id}（全站撤销，所有人都看不到了）
  // - 私人通知 → DELETE /api/notifications/{id}（后端校验：管理员任意 / 普通用户仅自己的）
  const handleDeleteNotification = async () => {
    if (!deleteTarget?.numericId) return;
    const token = getToken();
    if (!token) return;
    setDeleting(true);
    const isAnnouncement = deleteTarget.source === "announcement";
    const url = isAnnouncement
      ? `${API_BASE}/api/announcements/${deleteTarget.numericId}`
      : `${API_BASE}/api/notifications/${deleteTarget.numericId}`;
    try {
      const res = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "删除失败，请稍后重试");
        return;
      }
      // 成功后本地移除该条，列表立即刷新（无需重载页面）
      setItems((prev) => prev.filter((it) => it.id !== deleteTarget.id));
      setDeleteTarget(null);
      showToast(isAnnouncement ? "公告已撤销" : "通知已删除");
    } catch (err) {
      console.error("[通知中心] 删除失败：", err);
      showToast("无法连接服务器");
    } finally {
      setDeleting(false);
    }
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
    if (!token) return;
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
      // 成功：关闭抽屉、清空表单、把新公告插到列表最前
      const a = data.announcement;
      setItems((prev) => [
        {
          kind: "official",
          id: `ann-${a.id}`,
          content: a.content,
          createdAt: a.created_at,
        },
        ...prev,
      ]);
      setAnnOpen(false);
      setAnnTitle("");
      setAnnContent("");
      showToast("公告发布成功");
    } catch (err) {
      console.error("[通知中心] 发布公告失败：", err);
      showToast("无法连接服务器");
    } finally {
      setAnnPublishing(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 via-white to-white pb-16">
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
        <h1 className="text-base font-bold text-zinc-900">通知中心</h1>
      </div>

      <div className="mx-auto max-w-2xl px-4 pt-5">
        {/* 加载中 */}
        {loading ? (
          <div className="flex flex-col items-center gap-3 py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
            <p className="text-sm text-zinc-400">正在加载通知...</p>
          </div>
        ) : items.length === 0 ? (
          /* 双数据源均为空：优雅空状态 */
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white/60 py-16">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-violet-500 text-lg font-bold text-white">
              官
            </span>
            <p className="text-sm font-medium text-zinc-500">暂无通知</p>
            <p className="text-xs text-zinc-400">
              官方公告与互动动态会在这里通知你
            </p>
          </div>
        ) : (
          /* 合并列表：卡片式展示（保持原有卡片宽度与布局） */
          <div className="overflow-hidden rounded-2xl border border-white/60 bg-white/70 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl">
            {items.map((item, i) => {
              const expanded = expandedId === item.id;
              const isOfficial = item.kind === "official";
              const isReview = item.kind === "review";
              // 管理员可删除任意条目：公告 = 全站撤销，私人通知 = 单条清理
              const canDelete = isAdmin && !!item.numericId;
              return (
                <div
                  key={item.id}
                  className={`relative ${
                    i < items.length - 1 ? "border-b border-zinc-200/70" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (isReview) {
                        // 审核通知 → 跳『我的投稿』查看状态
                        router.push("/my-submissions");
                      } else if (isOfficial) {
                        // 公告 → 展开/收起
                        setExpandedId(expanded ? null : item.id);
                      } else {
                        // 互动通知 → 跳广场精准定位对应动态
                        router.push(`/square?post_id=${item.postId}`);
                      }
                    }}
                    className={`flex w-full items-start gap-3 py-3.5 pl-4 text-left transition-colors ${
                      canDelete ? "pr-14" : "pr-4"
                    } ${isOfficial ? "" : "hover:bg-zinc-100/70"}`}
                  >
                    {/* 头像：公告 = 紫圆『官』；审核 = 紫圆『审』；互动 = 触发者真实头像 */}
                    {isOfficial || isReview ? (
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-violet-500 text-sm font-semibold text-white">
                        {isOfficial ? "官" : "审"}
                      </span>
                    ) : (
                      <img
                        src={item.actorAvatar || avatarFallback(item.actorUsername ?? "U")}
                        alt={`${item.actorUsername}头像`}
                        className="h-10 w-10 shrink-0 rounded-full object-cover"
                      />
                    )}

                    {/* 名字 + 动作 + 内容 + 时间 */}
                    <div className="min-w-0 flex-1">
                      {isOfficial ? (
                        <p className="text-sm text-zinc-900">
                          <span className="font-semibold">官方</span>
                          <span className="text-zinc-700">
                            {" "}
                            {item.title || "AoliComic官方发布了新公告"}
                          </span>
                        </p>
                      ) : isReview ? (
                        <p className="text-sm text-zinc-900">
                          <span className="font-semibold">官方</span>
                          <span className="text-zinc-700"> 投稿审核结果</span>
                        </p>
                      ) : (
                        <p className="text-sm text-zinc-900">
                          <span className="font-semibold">
                            {item.actorUsername}
                          </span>
                          <span className="text-zinc-700">
                            {item.kind === "like"
                              ? " 赞了你的动态"
                              : " 评论了你："}
                          </span>
                        </p>
                      )}
                      {/* 内容：公告默认两行省略可展开；评论/审核结果全文显示 */}
                      {item.content && (
                        <p
                          className={`mt-0.5 text-xs leading-relaxed text-zinc-500 transition-all duration-300 ${
                            isOfficial && !expanded ? "line-clamp-2" : ""
                          }`}
                        >
                          {item.content}
                        </p>
                      )}
                      <p className="mt-0.5 text-xs text-zinc-400">
                        {formatAnnouncementTime(item.createdAt)}
                      </p>
                    </div>

                    <ChevronRight
                      className={`mt-1 h-4 w-4 shrink-0 text-zinc-300 transition-transform duration-300 ${
                        expanded ? "rotate-90" : ""
                      }`}
                    />
                  </button>

                  {/* 管理员专属：红色垃圾桶（卡片右侧，点击弹二次确认） */}
                  {canDelete && (
                    <button
                      type="button"
                      aria-label="删除通知"
                      onClick={() => setDeleteTarget(item)}
                      className="absolute right-2 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-red-400 transition-colors hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="py-6 text-center text-xs text-zinc-400">
          公告可点击展开全文；互动通知跳转广场；审核通知跳转我的投稿
        </p>
      </div>

      {/* 管理员专属：右下角悬浮紫色 + 号（打开发布公告抽屉） */}
      {isAdmin && (
        <button
          type="button"
          aria-label="发布公告"
          onClick={() => setAnnOpen(true)}
          className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-violet-500 text-white shadow-[0_8px_24px_0_rgba(124,58,237,0.45)] transition-all hover:bg-violet-400 hover:scale-105 active:scale-95"
        >
          <Plus className="h-6 w-6" />
        </button>
      )}

      {/* ===== 发布公告抽屉（底部弹出，仅管理员可见入口） ===== */}
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
          <input
            type="text"
            value={annTitle}
            onChange={(e) => setAnnTitle(e.target.value)}
            placeholder="公告标题，如“全新 AI 翻译功能上线”"
            className="w-full rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
          />
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

      {/* ===== 删除通知二次确认弹窗 ===== */}
      <div
        onClick={() => !deleting && setDeleteTarget(null)}
        className={`fixed inset-0 z-[98] bg-black/40 backdrop-blur-sm transition-opacity duration-200 ${
          deleteTarget ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed left-1/2 top-1/2 z-[99] w-[min(90vw,22rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-white/60 bg-white/95 p-6 shadow-2xl backdrop-blur-xl transition-all duration-200 ${
          deleteTarget ? "scale-100 opacity-100" : "scale-95 opacity-0"
        } ${deleteTarget ? "" : "pointer-events-none"}`}
      >
        <h3 className="text-base font-bold text-zinc-900">
          {deleteTarget?.source === "announcement" ? "撤销公告" : "删除通知"}
        </h3>
        <p className="mt-2 text-sm leading-relaxed text-zinc-500">
          {deleteTarget?.source === "announcement"
            ? "确定要撤销这条公告吗？撤销后全站所有用户都将看不到它，且不可恢复。"
            : "确定要删除这条通知吗？删除后不可恢复。"}
        </p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            disabled={deleting}
            onClick={() => setDeleteTarget(null)}
            className="flex-1 rounded-xl border border-zinc-200 py-2.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50"
          >
            取消
          </button>
          <button
            type="button"
            disabled={deleting}
            onClick={handleDeleteNotification}
            className="flex-1 rounded-xl bg-red-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-red-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {deleting ? "删除中..." : "确定删除"}
          </button>
        </div>
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
