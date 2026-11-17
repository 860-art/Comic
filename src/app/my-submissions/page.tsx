"use client";

import { ArrowLeft, BookOpen, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { getToken } from "@/lib/auth";
import { formatTime } from "@/lib/time";

import { API_BASE } from "@/lib/api";

/**
 * 我的投稿（/my-submissions）：
 * - 数据源：GET /api/comics/my-submissions（带 Token，当前用户全部稿件）
 * - 卡片式排版（同通知中心）：左侧封面、右侧书名、下方状态标签
 *   pending → 黄色『正在审核』 / approved → 绿色『审核成功』 / rejected → 红色『已驳回』
 * - 右上角紫色 + 号 → /upload 继续投稿
 * - 未登录 → 登录引导；空列表 → 优雅空状态
 */

/** 后端 GET /api/comics/my-submissions 返回的单条数据结构 */
interface SubmissionRow {
  id: number;
  title: string;
  cover_url: string | null;
  status: "pending" | "approved" | "rejected";
  submit_type: "new" | "append";
  created_at: string;
}

/** 状态标签样式与文案 */
function statusBadge(status: SubmissionRow["status"]) {
  if (status === "approved") {
    return {
      text: "审核成功",
      className: "bg-emerald-100 text-emerald-600",
    };
  }
  if (status === "rejected") {
    return { text: "已驳回", className: "bg-red-100 text-red-600" };
  }
  return { text: "正在审核", className: "bg-amber-100 text-amber-600" };
}

export default function MySubmissionsPage() {
  const router = useRouter();
  const [rows, setRows] = useState<SubmissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [unauthorized, setUnauthorized] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setUnauthorized(true);
      setLoading(false);
      return;
    }
    fetch(`${API_BASE}/api/comics/my-submissions`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => {
        if (res.status === 401) {
          setUnauthorized(true);
          return null;
        }
        return res.ok ? res.json() : null;
      })
      .then((data: SubmissionRow[] | null) => {
        if (data) setRows(data);
        setLoading(false);
      })
      .catch(() => {
        // 后端未启动 → 空列表
        setLoading(false);
      });
  }, []);

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 via-white to-white pb-16">
      {/* 顶栏：标题 + 右上角紫色 + 号（跳转投稿页） */}
      <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-zinc-200/60 bg-white/80 px-4 backdrop-blur-xl">
        <button
          type="button"
          aria-label="返回"
          onClick={() => router.back()}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-zinc-900 shadow-sm transition-colors hover:bg-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-base font-bold text-zinc-900">我的投稿</h1>
        <Link
          href="/upload"
          aria-label="继续投稿"
          className="ml-auto flex h-9 w-9 items-center justify-center rounded-full bg-violet-500 text-white shadow-[0_4px_12px_0_rgba(124,58,237,0.4)] transition-all hover:bg-violet-400 active:scale-95"
        >
          <Plus className="h-5 w-5" />
        </Link>
      </div>

      <div className="mx-auto max-w-2xl px-4 pt-5">
        {/* 未登录 */}
        {unauthorized ? (
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white/60 py-16">
            <BookOpen className="h-10 w-10 text-zinc-300" />
            <p className="text-sm font-medium text-zinc-500">登录后查看你的投稿</p>
            <button
              type="button"
              onClick={() => router.push("/login")}
              className="rounded-full bg-violet-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400"
            >
              去登录
            </button>
          </div>
        ) : loading ? (
          /* 加载中 */
          <div className="flex flex-col items-center gap-3 py-20">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
            <p className="text-sm text-zinc-400">正在加载投稿记录...</p>
          </div>
        ) : rows.length === 0 ? (
          /* 空状态 */
          <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-zinc-300 bg-white/60 py-16">
            <BookOpen className="h-10 w-10 text-zinc-300" />
            <p className="text-sm font-medium text-zinc-500">还没有投稿记录</p>
            <Link
              href="/upload"
              className="rounded-full bg-violet-500 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-400"
            >
              去投稿
            </Link>
          </div>
        ) : (
          /* 投稿列表：卡片式（左侧封面 + 右侧书名 + 状态标签） */
          <div className="space-y-3">
            {rows.map((item) => {
              const badge = statusBadge(item.status);
              return (
                <div
                  key={item.id}
                  className="flex items-center gap-4 rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl"
                >
                  {/* 左侧封面 */}
                  {item.cover_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.cover_url}
                      alt={`${item.title}封面`}
                      className="h-24 w-16 shrink-0 rounded-xl object-cover"
                    />
                  ) : (
                    <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded-xl bg-zinc-100">
                      <BookOpen className="h-6 w-6 text-zinc-300" />
                    </div>
                  )}

                  {/* 右侧信息 */}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-base font-bold text-zinc-900">
                      {item.title || "未命名作品"}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400">
                      {item.submit_type === "append" ? "追加章节" : "新建整本"} ·
                      提交于 {formatTime(item.created_at)}
                    </p>
                    {/* 状态标签 */}
                    <span
                      className={`mt-2 inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${badge.className}`}
                    >
                      {badge.text}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
