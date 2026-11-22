/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Languages,
  Loader2,
  RotateCcw,
  X,
} from "lucide-react";
import { ROUTES } from "@/lib/navigation";
import { getAllComics } from "@/data/pendingComics";
import { type Comic } from "@/data/mockData";
import { saveReadingProgress } from "@/lib/reading-history";

import { API_BASE } from "@/lib/api";
import { getToken } from "@/lib/auth";

/** 后端 GET /api/comics/{id} 返回的数据结构 */
interface ApiComicDetail {
  id: number;
  title: string;
  author: string;
  coverImage: string;
  tags: string[];
  needTranslation: boolean | null;
  chapters: { id: string; title: string; pages: number }[];
}

/** 后端 GET /api/comics/{id}/chapters/{chapterId} 返回的数据结构 */
interface ApiChapter {
  id: string;
  title: string;
  images: string[];
}

/** 后端 POST /api/translate 返回的单个气泡（box 为原图像素坐标 [x, y, w, h]） */
interface TranslateBubble {
  box: [number, number, number, number];
  bg_color: string;
  original: string;
  translated: string;
}

/** 把后端取色的 #rrggbb 转为带透明度的 rgba（80% 不透明 + backdrop-blur，通透如漫画气泡） */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return `rgba(255,255,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 根据背景色亮度自动决定文字用黑还是白（RGB 加权平均：亮底黑字、深底白字） */
function contrastTextColor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return "#1a1a1a";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  // 加权亮度：>150 视为浅色底 → 黑字，否则白字
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1a1a1a" : "#ffffff";
}

/**
 * 漫画阅读页 /comic/[id]/chapter/[chapterId]（真实后端版）：
 * - 章节 ID 形如 "{comicId}-{chapterId}" 时，请求后端章节接口，
 *   只加载这一话的真实内页图（GET /api/comics/{id}/chapters/{chapterId}）
 * - 本地漫画（种子书/无后端）回退占位画格模式
 * - 打开时自动把 { 漫画ID: 章节ID } 写入 localStorage 的 reading_history，
 *   供详情页『继续阅读』与书架进度条计算使用。
 */
export default function ComicReadPage({
  params,
}: {
  params: Promise<{ id: string; chapterId: string }>;
}) {
  const [comic, setComic] = useState<Comic | null>(null);
  const [chapter, setChapter] = useState<{ id: string; title: string; pages: number } | null>(null);
  // 真实内页图：null 表示占位画格模式（本地种子漫画）
  const [images, setImages] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // 翻译抽屉开关
  const [isTranslateDrawerOpen, setIsTranslateDrawerOpen] = useState(false);
  // ===== 真实 OCR 翻译（POST /api/translate） =====
  const [isTranslating, setIsTranslating] = useState(false);
  // 每一页的翻译气泡：{ 页下标: [气泡...] }
  const [translations, setTranslations] = useState<Record<number, TranslateBubble[]>>({});
  // 顶部『查看原图 / 查看译文』切换开关
  const [showTranslated, setShowTranslated] = useState(false);
  // 图片原始像素尺寸（后端 box 坐标基于原图，渲染时换算为百分比定位）
  const [imgSizes, setImgSizes] = useState<Record<number, { w: number; h: number }>>({});
  // 每页 <img> 的 DOM 引用（onLoad 里统一经 ref 读取，避免事件对象被复用/置空导致 null 崩溃）
  const imgRefs = useRef<Record<number, HTMLImageElement | null>>({});

  // 图片加载完成：经 ref + 空值保护读取原始宽高，写入 imgSizes 状态（只写一次）
  const handleImgLoad = (index: number) => {
    const el = imgRefs.current[index];
    if (el && el.naturalWidth > 0 && el.naturalHeight > 0) {
      setImgSizes((prev) =>
        prev[index] ? prev : { ...prev, [index]: { w: el.naturalWidth, h: el.naturalHeight } }
      );
    }
  };
  // 每页独立的翻译状态：idle 未翻译 / loading 翻译中 / success 已翻译（流式渲染，互不阻塞）
  type PageTranslateStatus = "idle" | "loading" | "success" | "error";
  const [pageStatus, setPageStatus] = useState<Record<number, PageTranslateStatus>>({});
  // 是否仍有页面在翻译中（普通变量，供顶部 hook 与后续逻辑共用）
  const anyLoading = Object.values(pageStatus).some((s) => s === "loading");
  // 每页翻译开始时间（毫秒时间戳）：用于「翻译超过 2 分钟」的卡死判定
  const pageStartRef = useRef<Record<number, number>>({});
  // 滴答时钟：仅存在翻译中的页面时每 10 秒触发一次重渲染，驱动超时按钮出现
  const [nowTick, setNowTick] = useState(0);
  // 注意：所有 Hook 必须放在组件顶部、任何提前 return 之前，
  // 否则加载中/加载完成两次渲染的 Hook 数量不一致会导致页面直接崩溃
  useEffect(() => {
    if (!anyLoading) return;
    const timer = setInterval(() => setNowTick(Date.now()), 10000);
    return () => clearInterval(timer);
  }, [anyLoading]);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  // 翻译抽屉内的设置：翻译方式 Tab / 图片文字识别开关 / 识别质量滑动条
  const [translateTab, setTranslateTab] = useState<"online" | "ai">("online");
  const [ocrEnabled, setOcrEnabled] = useState(true);
  const [ocrQuality, setOcrQuality] = useState(50);
  // 我的 AI 密钥配置（表单内存态）
  const [aiConfig, setAiConfig] = useState({
    service: "Google Gemini",
    apiKey: "",
    model: "gemini-1.5-flash",
    baseUrl: "https://generativelanguage.googleapis.com",
    styleNote: "",
  });
  // 用户正在输入的密钥草稿（空 = 未编辑）
  const [keyDraft, setKeyDraft] = useState("");
  // 已保存的密钥（localStorage user_zhipu_key，BYOK 模式），用于判断底部按钮“保存”/“翻译”并随翻译请求携带
  const [savedKey, setSavedKey] = useState("");

  // 密钥脱敏显示：前 4 位 + **** + 后 4 位（不回显完整明文）
  const maskKey = (key: string) =>
    key.length <= 8 ? "sk-********" : `${key.slice(0, 4)}****${key.slice(-4)}`;

  // 挂载时读取已保存的密钥，输入框回显掩码
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("user_zhipu_key");
      if (raw) setSavedKey(raw);
    } catch {
      // 读取失败时视为未保存
    }
  }, []);

  useEffect(() => {
    let alive = true;
    params.then(async ({ id, chapterId }) => {
      if (!alive) return;
      // 章节 ID 形如 "{comicId}-{chapterId}"（纯数字）→ 优先走后端真实章节
      const m = /^(\d+)-(\d+)$/.exec(chapterId);
      if (m) {
        try {
          const chRes = await fetch(
            `${API_BASE}/api/comics/${m[1]}/chapters/${m[2]}`
          );
          if (chRes.ok) {
            const ch: ApiChapter = await chRes.json();
            // 拉取漫画详情（章节列表供上一章/下一章导航；失败也能读当前章）
            let detail: ApiComicDetail | null = null;
            try {
              const dRes = await fetch(`${API_BASE}/api/comics/${m[1]}`);
              if (dRes.ok) detail = await dRes.json();
            } catch {
              // 详情失败不影响阅读
            }
            const comicObj: Comic = {
              id,
              title: detail?.title ?? "漫画",
              author: detail?.author ?? "",
              coverUrl: detail?.coverImage ?? "",
              themeColor: "#7C3AED",
              progress: 0,
              status: "连载中",
              updatedAt: "",
              favorites: 0,
              description: "",
              tags: detail?.tags ?? [],
              needTranslation: detail ? detail.needTranslation !== false : true,
              chapters:
                detail?.chapters ??
                [{ id: chapterId, title: ch.title, pages: ch.images.length }],
            };
            // 核心：打开阅读页即记录阅读历史
            saveReadingProgress(id, chapterId);
            setComic(comicObj);
            setChapter({ id: chapterId, title: ch.title, pages: ch.images.length });
            setImages(ch.images); // 只加载这一话的真实图片
            setLoading(false);
            return;
          }
        } catch {
          // 后端未启动 → 走本地兜底
        }
      }
      // 本地兜底：种子漫画 / 本地发布的漫画（占位画格模式）
      const localComic = getAllComics().find((c) => c.id === id);
      const localChapter = localComic?.chapters.find((c) => c.id === chapterId);
      if (!localComic || !localChapter) {
        setNotFound(true);
        setLoading(false);
        return;
      }
      saveReadingProgress(localComic.id, localChapter.id);
      setComic(localComic);
      setChapter(localChapter);
      setImages(null);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [params]);

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        <p className="text-sm text-white/50">正在加载章节内容...</p>
      </div>
    );
  }

  if (notFound || !comic || !chapter) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-24 text-center">
        <p className="text-lg font-medium text-zinc-700">未找到该章节</p>
        <Link
          href={ROUTES.home}
          className="mt-4 inline-block rounded-full bg-zinc-900 px-5 py-2 text-sm text-white hover:bg-zinc-700"
        >
          返回首页
        </Link>
      </div>
    );
  }

  // 翻译按钮显隐：needTranslation === false 彻底隐藏；true 或字段缺失（老数据）默认显示
  const showTranslate = comic.needTranslation !== false;
  const chapterIndex = comic.chapters.findIndex((c) => c.id === chapter.id);
  const prevChapter = comic.chapters[chapterIndex - 1];
  const nextChapter = comic.chapters[chapterIndex + 1];

  // 保存 AI 密钥：写入 localStorage('user_zhipu_key') → Toast → 保持在当前 Tab 不重置
  const handleSaveKey = () => {
    const key = (keyDraft.trim() || savedKey).trim();
    if (!key) {
      setToastMsg("请先填写 API 密钥");
      setTimeout(() => setToastMsg(null), 2000);
      return;
    }
    try {
      window.localStorage.setItem("user_zhipu_key", key);
    } catch {
      // 存储异常时仍给予保存反馈
    }
    setSavedKey(key);
    setKeyDraft("");
    setToastMsg("密钥已保存");
    setTimeout(() => setToastMsg(null), 2000);
  };

  // ===== 流式翻译：每页独立请求、独立渲染，先返回的页面先显示中文气泡 =====
  // 成功页里：有真实气泡 → 「已汉化」；全是空数组 → 「未识别到文字」
  const successEntries = Object.entries(pageStatus).filter(([, s]) => s === "success");
  const hasAnyBubbles = successEntries.some(([i]) => (translations[Number(i)] ?? []).length > 0);
  const hasEmptyPage = successEntries.some(([i]) => (translations[Number(i)] ?? []).length === 0);
  const hasTranslation = Object.keys(translations).length > 0;

  /**
   * 单页翻译：幂等提交任务（POST /api/translate/tasks）→ 轮询状态直到终态。
   * 后端幂等键 comic_id+page_id+target_lang：已 done 直接返回结果；
   * queued/processing 返回同一 task_id 绝不重复执行；failed 未超限自动重置排队。
   * 前端一次只持有 1 个进行中任务（与后端「每用户最多 1 个进行中」对齐），逐页串行流水线。
   */
  const runTaskForPage = async (
    src: string,
    i: number,
    force: boolean
  ): Promise<boolean> => {
    setPageStatus((prev) => ({ ...prev, [i]: "loading" }));
    pageStartRef.current[i] = Date.now();
    try {
      const token = getToken();
      if (!token) {
        setPageStatus((prev) => ({ ...prev, [i]: "error" }));
        setToastMsg("请先登录后再使用 AI 翻译");
        setTimeout(() => setToastMsg(null), 2200);
        return false;
      }
      const res = await fetch(`${API_BASE}/api/translate/tasks`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          comic_id: Number(comic?.id) || 0,
          page_id: `${chapter?.id ?? ""}:${i}`,
          image_url: src,
          lang: "en",
          target_lang: "zh",
          force,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.task_id) {
        setPageStatus((prev) => ({ ...prev, [i]: "error" }));
        setToastMsg(data?.detail ?? "任务提交失败");
        setTimeout(() => setToastMsg(null), 2500);
        return false;
      }
      // 已完成：直接拿到结果（幂等命中），无需轮询
      if (data.status === "done" && Array.isArray(data.result)) {
        setTranslations((prev) => ({ ...prev, [i]: data.result as TranslateBubble[] }));
        setPageStatus((prev) => ({ ...prev, [i]: "success" }));
        return true;
      }
      if (data.status === "failed") {
        setPageStatus((prev) => ({ ...prev, [i]: "error" }));
        return false;
      }
      // queued / processing → 每 2 秒轮询一次，直到 done/failed
      const taskId: number = data.task_id;
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        const poll = await fetch(`${API_BASE}/api/translate/tasks/${taskId}`);
        const pd = await poll.json().catch(() => null);
        if (!poll.ok || !pd?.status) {
          setPageStatus((prev) => ({ ...prev, [i]: "error" }));
          return false;
        }
        if (pd.status === "done") {
          setTranslations((prev) => ({
            ...prev,
            [i]: (pd.result ?? []) as TranslateBubble[],
          }));
          setPageStatus((prev) => ({ ...prev, [i]: "success" }));
          return true;
        }
        if (pd.status === "failed") {
          setPageStatus((prev) => ({ ...prev, [i]: "error" }));
          setToastMsg(pd.error ?? "翻译失败");
          setTimeout(() => setToastMsg(null), 2200);
          return false;
        }
        // queued / processing → 继续轮询；超过 2 分钟页面右上角出现「重新翻译」
      }
    } catch {
      setPageStatus((prev) => ({ ...prev, [i]: "error" }));
      return false;
    }
  };

  const runTranslate = async (force = false) => {
    const pages = images;
    if (!pages || pages.length === 0) {
      setToastMsg("本章节没有可翻译的内页图");
      setTimeout(() => setToastMsg(null), 2000);
      return;
    }
    if (anyLoading) {
      setToastMsg("正在翻译中，请稍候");
      setTimeout(() => setToastMsg(null), 2000);
      return;
    }
    setIsTranslateDrawerOpen(false);
    setShowTranslated(true); // 立即切到译文模式：先完成的页面马上展示气泡

    // 重新翻译：先清空旧的译文与状态，后端 force 会重置任务重跑
    if (force) {
      setTranslations({});
      setPageStatus({});
    }

    // 串行流水线：每用户同时只有 1 个进行中任务，页 i 完成后立即提交页 i+1，
    // 后端单 worker 按用户轮转调度，先完成的页面先渲染
    let okCount = 0;
    for (let i = 0; i < pages.length; i++) {
      const ok = await runTaskForPage(pages[i], i, force);
      if (ok) okCount++;
    }

    setToastMsg(
      okCount === pages.length
        ? `全部 ${pages.length} 页翻译完成`
        : `完成 ${okCount}/${pages.length} 页，失败页可点右上角「重新翻译」`
    );
    setTimeout(() => setToastMsg(null), 2800);
  };

  /** 单页重新翻译：只清空该页译文与状态、force 重译该页，已成功的页面完全不受影响 */
  const retryPage = async (i: number) => {
    const src = images?.[i];
    if (!src || pageStatus[i] === "loading") return;
    setShowTranslated(true);
    // 清空该页相关数据（旧译文 + 状态）后重新提交翻译
    setTranslations((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
    const ok = await runTaskForPage(src, i, true);
    setToastMsg(
      ok
        ? `第 ${i + 1} 页翻译完成`
        : `第 ${i + 1} 页翻译失败，可再次点击「重新翻译」重试`
    );
    setTimeout(() => setToastMsg(null), 2500);
  };

  /** 该页是否显示右上角「重新翻译」按钮：翻译失败，或翻译中已超过 2 分钟（疑似卡死） */
  const pageStuck = (i: number): boolean => {
    const status = pageStatus[i];
    if (status === "error") return true;
    if (status === "loading") {
      const started = pageStartRef.current[i];
      return started != null && nowTick > 0 && Date.now() - started > 120000;
    }
    return false;
  };

  // 底部主按钮：拦截无密钥 → 关闭抽屉并调用真实翻译
  const handleMainAction = () => {
    // 拦截：AI 密钥模式下没有可用密钥时不放行
    if (translateTab === "ai" && !savedKey.trim()) {
      setToastMsg("请先填写 API 密钥");
      setTimeout(() => setToastMsg(null), 2000);
      return;
    }
    // 已有译文时按钮是「重新翻译」→ force 清缓存与旧译文后重新保存
    runTranslate(hasTranslation);
  };

  // 底部按钮文案：已有结果 → 重新翻译；AI Tab 未存密钥 → 保存；其余 → 翻译
  const mainActionLabel = hasTranslation
    ? "重新翻译"
    : translateTab === "ai" && !savedKey.trim()
      ? "保存"
      : "翻译";

  // 真实内页 → 渲染 <img>；本地兜底 → 按页数渲染占位画格
  const realImages = images;
  const placeholderPages = Array.from({ length: Math.min(chapter.pages, 8) });

  return (
    <div className="min-h-screen bg-zinc-950 pb-24 text-white">
      {/* 顶部栏：返回详情 + 漫画名/章节名 */}
      <header className="sticky top-0 z-40 border-b border-white/10 bg-zinc-950/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link
            href={ROUTES.comic(comic.id)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20"
            aria-label="返回详情页"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{comic.title}</p>
            <p className="truncate text-xs text-white/50">{chapter.title}</p>
          </div>
          {/* 查看原图 / 查看译文 切换开关：有翻译结果后出现在顶部 */}
          {hasTranslation && (
            <div className="ml-auto flex shrink-0 rounded-full border border-white/10 bg-white/5 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setShowTranslated(false)}
                className={`rounded-full px-2.5 py-1 transition-colors ${
                  !showTranslated
                    ? "bg-white/90 font-medium text-zinc-900"
                    : "text-white/60 hover:text-white"
                }`}
              >
                原图
              </button>
              <button
                type="button"
                onClick={() => setShowTranslated(true)}
                className={`rounded-full px-2.5 py-1 transition-colors ${
                  showTranslated
                    ? "bg-white/90 font-medium text-zinc-900"
                    : "text-white/60 hover:text-white"
                }`}
              >
                译文
              </button>
            </div>
          )}
          {/* 翻译入口按钮：needTranslation === false 时整个组件不渲染，无法触发翻译 */}
          {showTranslate && (
            <button
              type="button"
              onClick={() => setIsTranslateDrawerOpen(true)}
              disabled={anyLoading}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                hasAnyBubbles ? "" : "ml-auto"
              } ${
                hasAnyBubbles
                  ? "border-emerald-400/40 bg-emerald-500/20 text-emerald-300"
                  : hasEmptyPage
                    ? "border-amber-400/40 bg-amber-500/20 text-amber-300"
                    : "border-white/20 bg-white/10 text-white hover:bg-white/20"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              <Languages className="h-3.5 w-3.5" />
              {anyLoading
                ? "翻译中"
                : hasAnyBubbles
                  ? "已汉化"
                  : hasEmptyPage
                    ? "未识别到文字"
                    : "翻译"}
            </button>
          )}
          <span
            className={`shrink-0 text-xs text-white/40 ${showTranslate ? "" : "ml-auto"}`}
          >
            {chapterIndex + 1}/{comic.chapters.length} 章
          </span>
        </div>
      </header>

      {/* 漫画内容：真实内页图 / 占位画格 */}
      <main className="mx-auto max-w-3xl space-y-2 px-4 py-6">
        {realImages && realImages.length > 0
          ? realImages.map((src, i) => {
              const size = imgSizes[i];
              const status = pageStatus[i] ?? "idle";
              // 译文模式下：已成功页展示气泡；翻译中页展示毛玻璃遮罩
              const bubbles = showTranslated && status === "success" ? translations[i] ?? [] : [];
              return (
                /* 相对定位容器：气泡覆盖层叠加在原图上方，原图本身不做任何修改 */
                <div key={i} className="relative" style={{ containerType: "inline-size" }}>
                  <img
                    ref={(el) => {
                      // 每页一个 ref 槽位；卸载时 React 会以 null 回调，安全清空
                      imgRefs.current[i] = el ?? null;
                    }}
                    src={src}
                    alt={`第 ${i + 1} 页`}
                    className={`w-full rounded-lg transition-all duration-500 ${
                      status === "loading" ? "blur-sm" : ""
                    }`}
                    onLoad={() => handleImgLoad(i)}
                  />
                  {/* 毛玻璃占位：该页翻译中 → 黑色半透明遮罩 + 旋转图标 + 文案 */}
                  {status === "loading" && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2.5 rounded-lg bg-black/55 backdrop-blur-sm">
                      <Loader2 className="h-6 w-6 animate-spin text-white/90" />
                      <p className="text-xs tracking-wide text-white/80">
                        AI 汉化中<span className="animate-pulse">...</span>
                      </p>
                    </div>
                  )}
                  {/* 右上角「重新翻译」：该页失败，或翻译中超过 2 分钟疑似卡死时出现；
                      点击只重译这一页（清空该页旧数据 force 重跑），已完成的页面不受影响 */}
                  {showTranslated && pageStuck(i) && (
                    <button
                      type="button"
                      onClick={() => retryPage(i)}
                      className="absolute right-3 top-3 z-20 flex items-center gap-1.5 rounded-full border border-white/25 bg-black/75 px-3 py-1.5 text-xs font-medium text-white shadow-lg backdrop-blur-md transition-transform hover:bg-black/90 active:scale-95"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      重新翻译
                    </button>
                  )}
                  {/* 翻译气泡覆盖层：按后端 box 坐标换算百分比定位；
                      背景用取色 bg_color 加 80% 透明度 + backdrop-blur；文字按背景亮度自动黑/白 */}
                  {size &&
                    bubbles.map((bubble, j) => {
                      const [bx, by, bw, bh] = bubble.box;
                      return (
                        <div
                          key={j}
                          title={`${bubble.original} → ${bubble.translated}`}
                          className="absolute flex items-center justify-center overflow-hidden rounded-md p-1 text-center text-sm font-bold leading-tight break-words shadow-[0_2px_8px_rgba(0,0,0,0.25)] ring-1 ring-black/10 drop-shadow-sm backdrop-blur-sm"
                          style={{
                            left: `${(bx / size.w) * 100}%`,
                            top: `${(by / size.h) * 100}%`,
                            width: `${(bw / size.w) * 100}%`,
                            height: `${(bh / size.h) * 100}%`,
                            backgroundColor: hexToRgba(bubble.bg_color, 0.8),
                            color: contrastTextColor(bubble.bg_color),
                          }}
                        >
                          {bubble.translated}
                        </div>
                      );
                    })}
                  {/* 该页翻译成功但后端没识别到文字（空数组）→ 明确提示，而不是假装已汉化 */}
                  {status === "success" && (translations[i] ?? []).length === 0 && (
                    <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-center">
                      <span className="rounded-full border border-white/15 bg-black/60 px-4 py-1.5 text-xs text-white/70 backdrop-blur-md">
                        未识别到文字
                      </span>
                    </div>
                  )}
                </div>
              );
            })
          : placeholderPages.map((_, i) => (
              <div
                key={i}
                className={`flex aspect-[3/4] w-full items-center justify-center rounded-lg text-sm transition-all duration-700 ${
                  hasTranslation
                    ? "bg-emerald-950/60 text-emerald-200/70 grayscale"
                    : "bg-zinc-900 text-white/30"
                }`}
              >
                {hasTranslation ? (
                  <span className="px-6 text-center leading-relaxed">
                    【汉化】第 {i + 1} 页
                    <br />
                    “这是模拟翻译后的中文台词。”
                  </span>
                ) : (
                  <>第 {i + 1} 页（漫画内容占位）</>
                )}
              </div>
            ))}
        {realImages && realImages.length === 0 && (
          <p className="py-16 text-center text-sm text-white/40">
            这一话还没有上传内页图
          </p>
        )}
      </main>

      {/* 底部：上一章 / 下一章 */}
      <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-zinc-950/90 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          {prevChapter ? (
            <Link
              href={ROUTES.read(comic.id, prevChapter.id)}
              className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-white/10 py-3 text-sm transition-colors hover:bg-white/20"
            >
              <ChevronLeft className="h-4 w-4" />
              上一章
            </Link>
          ) : (
            <span className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-white/5 py-3 text-sm text-white/30">
              <ChevronLeft className="h-4 w-4" />
              上一章
            </span>
          )}
          {nextChapter ? (
            <Link
              href={ROUTES.read(comic.id, nextChapter.id)}
              className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-white/90 py-3 text-sm font-semibold text-zinc-900 transition-colors hover:bg-white"
            >
              下一章
              <ChevronRight className="h-4 w-4" />
            </Link>
          ) : (
            <span className="flex flex-1 items-center justify-center gap-1 rounded-xl bg-white/5 py-3 text-sm text-white/30">
              已是最新一章
              <ChevronRight className="h-4 w-4" />
            </span>
          )}
        </div>
      </nav>

      {/* 翻译设置抽屉：深色玻璃态，底部弹出 70vh */}
      <div
        onClick={() => setIsTranslateDrawerOpen(false)}
        className={`fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm transition-opacity duration-300 ${
          isTranslateDrawerOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[75] h-[70vh] transition-transform duration-300 ease-out ${
          isTranslateDrawerOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="flex h-full flex-col rounded-t-3xl border-t border-white/10 bg-zinc-900/85 text-white backdrop-blur-xl">
          {/* 顶部：大字标题 + X 关闭 */}
          <div className="shrink-0 px-5 pt-5">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/20" />
            <div className="flex items-center justify-between">
              <h2 className="text-2xl font-bold">翻译</h2>
              <button
                type="button"
                aria-label="关闭翻译设置"
                onClick={() => setIsTranslateDrawerOpen(false)}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 transition-colors hover:bg-white/20"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* 语言选择：源语言 ⇄ 目标语言 */}
            <div className="mt-4 flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
              <div>
                <p className="text-[10px] text-white/40">源语言</p>
                <p className="text-sm font-medium">检测语言</p>
              </div>
              {/* 单向箭头：源语言 → 目标语言 */}
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10">
                <ArrowRight className="h-4 w-4 text-white/70" />
              </div>
              <div className="text-right">
                <p className="text-[10px] text-white/40">目标语言</p>
                <p className="text-sm font-medium">中文 (简体中文)</p>
              </div>
            </div>

            {/* 翻译方式 Tab：选中态用漫画封面主题色高亮 */}
            <div className="mt-4 grid grid-cols-2 gap-2">
              {(
                [
                  { key: "online", label: "在线" },
                  { key: "ai", label: "我的 AI 密钥" },
                ] as const
              ).map((tab) => {
                const active = translateTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setTranslateTab(tab.key)}
                    className={`rounded-xl border px-4 py-2.5 text-sm font-medium transition-colors ${
                      active
                        ? "border-white/20 text-white"
                        : "border-white/10 bg-white/5 text-white/60 hover:bg-white/10"
                    }`}
                    style={active ? { backgroundColor: comic.themeColor } : undefined}
                  >
                    {tab.label}
                  </button>
                );
              })}
            </div>
            {/* Tab 说明文字随切换变化 */}
            <p className="mt-2 text-xs text-white/50">
              {translateTab === "online"
                ? "免费在线翻译，无需配置，开箱即用"
                : "填入你自己的 API Key，使用自己的模型额度"}
            </p>
          </div>

          {/* 内容区：在线 → 图片识别选项；我的 AI 密钥 → API 配置表单 */}
          <div className="mt-4 flex-1 space-y-2 overflow-y-auto px-5">
            {translateTab === "online" ? (
              <>
                {/* 开关项：翻译图片中的文字（默认开启）
                    原生 checkbox + peer：无外框无 ring，
                    开启 → 主题色背景、圆点在右；关闭 → 深灰背景、圆点在左 */}
                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-sm">翻译图片中的文字</span>
                  <label className="relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      checked={ocrEnabled}
                      onChange={(e) => setOcrEnabled(e.target.checked)}
                      className="peer sr-only"
                    />
                    {/* 轨道：默认深灰，选中用 currentColor 继承主题色 */}
                    <div
                      className="h-6 w-11 rounded-full bg-zinc-700 transition-colors peer-checked:bg-current"
                      style={{ color: comic.themeColor }}
                    />
                    {/* 圆点：关闭在左，开启滑到右 */}
                    <div className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform peer-checked:translate-x-[22px]" />
                  </label>
                </div>

                {/* 滑动条：图片识别质量（快速 ↔ 质量），进度色跟随主题色 */}
                <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm">图片识别</span>
                    <span className="text-xs text-white/40">
                      {ocrQuality < 34 ? "偏快速" : ocrQuality > 66 ? "偏质量" : "均衡"}
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={ocrQuality}
                    onChange={(e) => setOcrQuality(Number(e.target.value))}
                    className="mt-2 w-full"
                    style={{ accentColor: comic.themeColor }}
                  />
                  <div className="flex justify-between text-[10px] text-white/40">
                    <span>快速</span>
                    <span>质量</span>
                  </div>
                </div>

                {/* 固定展示项：不可点击，无箭头 */}
                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-sm">译文字体</span>
                  <span className="text-xs text-white/40">黑体</span>
                </div>
                <div className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-sm">译文颜色</span>
                  <span className="text-xs text-white/40">适应（默认）</span>
                </div>
              </>
            ) : (
              <>
                {/* 服务下拉框 */}
                <label className="block rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-[10px] text-white/40">服务</span>
                  <select
                    value={aiConfig.service}
                    onChange={(e) =>
                      setAiConfig((prev) => ({ ...prev, service: e.target.value }))
                    }
                    className="mt-1 w-full bg-transparent text-sm font-medium text-white focus:outline-none"
                  >
                    <option className="bg-zinc-900">Google Gemini</option>
                    <option className="bg-zinc-900">OpenAI</option>
                    <option className="bg-zinc-900">Anthropic Claude</option>
                    <option className="bg-zinc-900">自定义接口</option>
                  </select>
                </label>

                {/* API 密钥 */}
                <label className="block rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-[10px] text-white/40">API 密钥</span>
                  <input
                    type="password"
                    value={keyDraft || (savedKey ? maskKey(savedKey) : "")}
                    onChange={(e) => setKeyDraft(e.target.value)}
                    placeholder="粘贴你的 API 密钥"
                    className="mt-1 w-full bg-transparent text-sm font-medium text-white placeholder:text-white/30 focus:outline-none"
                  />
                </label>

                {/* 模型 */}
                <label className="block rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-[10px] text-white/40">模型</span>
                  <input
                    type="text"
                    value={aiConfig.model}
                    onChange={(e) =>
                      setAiConfig((prev) => ({ ...prev, model: e.target.value }))
                    }
                    className="mt-1 w-full bg-transparent text-sm font-medium text-white focus:outline-none"
                  />
                </label>

                {/* 基础网址 */}
                <label className="block rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-[10px] text-white/40">基础网址</span>
                  <input
                    type="text"
                    value={aiConfig.baseUrl}
                    onChange={(e) =>
                      setAiConfig((prev) => ({ ...prev, baseUrl: e.target.value }))
                    }
                    className="mt-1 w-full bg-transparent text-sm font-medium text-white focus:outline-none"
                  />
                </label>

                {/* 风格说明（选填） */}
                <label className="block rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
                  <span className="text-[10px] text-white/40">风格说明（选填）</span>
                  <input
                    type="text"
                    value={aiConfig.styleNote}
                    onChange={(e) =>
                      setAiConfig((prev) => ({ ...prev, styleNote: e.target.value }))
                    }
                    placeholder="例如：保持口语化，这是漫画"
                    className="mt-1 w-full bg-transparent text-sm font-medium text-white placeholder:text-white/30 focus:outline-none"
                  />
                </label>
              </>
            )}
          </div>

          {/* 底部大按钮：主题色；文案随状态切换（保存 / 翻译 / 显示原文） */}
          <div className="shrink-0 px-5 pb-6 pt-3">
            <button
              type="button"
              onClick={mainActionLabel === "保存" ? handleSaveKey : handleMainAction}
              className="w-full rounded-2xl py-3.5 text-base font-semibold text-white shadow-lg transition-all hover:brightness-110 active:scale-[0.98]"
              style={{ backgroundColor: comic.themeColor }}
            >
              {mainActionLabel}
            </button>
          </div>
        </div>
      </div>

      {/* 翻译完成 Toast，2.5 秒后自动消失（每页状态已改为原地毛玻璃占位，不再有全屏大遮罩） */}
      {toastMsg && (
        <div className="fixed left-1/2 top-1/2 z-[100] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-emerald-400/30 bg-black/70 px-6 py-3 text-emerald-300 backdrop-blur-xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
