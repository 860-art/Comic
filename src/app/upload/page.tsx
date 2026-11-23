/* eslint-disable @next/next/no-img-element */
"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, FileImage, ImagePlus, Plus, X } from "lucide-react";
import { getToken } from "@/lib/auth";

/**
 * 投稿页（/upload，真实后端版 + 动态章节管理）：
 * - 表单：书名 / 作者 / 简介 / 标签（chips 输入）
 * - 封面图（单张）
 * - 动态章节：默认“第1话”区块（章节名输入框 + 该章专属多图上传）；
 *   『+ 添加新章节』动态追加，每章右上角可删除
 * - 提交：带 Token POST /api/comics/submit，章节数据组装为
 *   [{ title, images }] 数组（即使只有一章也是单元素数组），
 *   后端写入 pending_comics 表（status='pending'），
 *   Toast『投稿成功！请耐心等待管理员审核』后跳回首页
 */

import { API_BASE } from "@/lib/api";
import { uploadImage } from "@/lib/upload";

/** 单个章节的表单数据 */
interface ChapterForm {
  title: string;
  /** 内页列表：null = 已选中尚未传完的占位槽（位置固定，保证顺序与选择一致） */
  images: (string | null)[];
}

/** 投稿表单主体：使用 useSearchParams，必须在 Suspense 内渲染（见底部默认导出） */
function UploadForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // 表单数据
  const [title, setTitle] = useState("");
  const [author, setAuthor] = useState("");
  const [intro, setIntro] = useState("");
  const [tagInput, setTagInput] = useState("");
  const [tags, setTags] = useState<string[]>([]);

  // 封面（单张）
  const [cover, setCover] = useState<string | null>(null);
  // 动态章节：默认展示一个“第1话”区块
  const [chapters, setChapters] = useState<ChapterForm[]>([
    { title: "第1话", images: [] },
  ]);
  // 当前正在上传内页的章节下标（隐藏 input 共用一个，点击时记住目标章节）
  const activeChapterRef = useRef(0);
  // 内页串行上传状态：正在上传的章节 + 未传完张数（预览区显示占位框）
  const [uploadState, setUploadState] = useState<{ chapter: number; pending: number } | null>(
    null
  );
  // 是否需要 AI 翻译：Segmented Control（默认 NO）
  const [needTranslation, setNeedTranslation] = useState(false);
  // ===== 投稿模式：new=新建整本 / append=为已有漫画追加章节（URL 参数 ?comic_id=N&type=append）=====
  const [mode, setMode] = useState<"new" | "append">("new");
  const [targetComicId, setTargetComicId] = useState<number | null>(null);
  const [targetTitle, setTargetTitle] = useState("");

  // 挂载时解析 URL 参数进入追加模式，并拉取目标漫画信息（书名用于顶部横幅 + 章节序号续排）
  useEffect(() => {
    const comicId = Number(searchParams.get("comic_id"));
    if (searchParams.get("type") === "append" && Number.isInteger(comicId) && comicId > 0) {
      setMode("append");
      setTargetComicId(comicId);
      fetch(`${API_BASE}/api/comics/${comicId}`)
        .then((res) => (res.ok ? res.json() : null))
        .then((detail: { title: string; chapters: unknown[] } | null) => {
          if (!detail) {
            setTargetTitle(`漫画 #${comicId}`);
            return;
          }
          setTargetTitle(detail.title);
          // 默认章节标题接着目标漫画已有章节数（如已有 2 章 → 默认“第3话”）
          setChapters((prev) =>
            prev.length === 1 && prev[0].images.length === 0 && prev[0].title === "第1话"
              ? [{ title: `第${detail.chapters.length + 1}话`, images: [] }]
              : prev
          );
        })
        .catch(() => setTargetTitle(`漫画 #${comicId}`));
    }
  }, [searchParams]);

  // Toast 与提交状态
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const pagesInputRef = useRef<HTMLInputElement>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2200);
  };

  // 封面选择：只取第一张替换（上传到 R2 对象存储，返回公网 URL）
  const handleCover = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setCover(await uploadImage(file));
    } catch (err) {
      showToast(err instanceof Error ? err.message : "封面上传失败");
    }
  };

  // ===== 动态章节管理 =====
  // 添加新章节：优先从最后一个章节标题提取数字 +1（“第5话”→“第6话”）；
  // 提取不到数字（如“特别篇”）时回退为“第N话”（N = 数组长度 + 1），保证序号连续
  const addChapter = () => {
    setChapters((prev) => {
      const lastTitle = prev[prev.length - 1]?.title ?? "";
      const m = /(\d+)/.exec(lastTitle);
      const nextNum = m ? Number(m[1]) + 1 : prev.length + 1;
      return [...prev, { title: `第${nextNum}话`, images: [] }];
    });
  };

  // 删除章节：至少保留一章
  const removeChapter = (index: number) => {
    setChapters((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  };

  // 修改章节标题
  const renameChapter = (index: number, title: string) => {
    setChapters((prev) => prev.map((c, i) => (i === index ? { ...c, title } : c)));
  };

  // 打开某章节的内页选择器（记住目标章节）
  const openPagesPicker = (index: number) => {
    activeChapterRef.current = index;
    pagesInputRef.current?.click();
  };

  // 某章节内页多选：选图瞬间按选择顺序插入 null 占位槽，
  // 之后按 2 张一批排队上传（绝不全量并发），每张传完【按位置回填】自己的槽位
  // —— 先传完的也只写进自己原来的位置，顺序永远与选择顺序严格一致；
  // 任一张失败终止后续批次（槽位保留 null 可手动删除或重选），已成功的保留
  const handlePages = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const index = activeChapterRef.current;
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    // 占位槽起始下标（本次选择的图片排在现有图片之后）
    const base = chapters[index]?.images.length ?? 0;
    setChapters((prev) =>
      prev.map((c, i) =>
        i === index ? { ...c, images: [...c.images, ...files.map(() => null)] } : c
      )
    );
    setUploadState({ chapter: index, pending: files.length });
    try {
      let aborted = false;
      const GROUP = 2;
      for (let start = 0; start < files.length && !aborted; start += GROUP) {
        const batch = files.slice(start, start + GROUP);
        // 批内并发（最多 2 张）：回填各自的槽位，互不抢位
        await Promise.all(
          batch.map(async (file, k) => {
            const slot = base + start + k;
            try {
              const url = await uploadImage(file);
              setChapters((prev) =>
                prev.map((c, i) => {
                  if (i !== index) return c;
                  const imgs = [...c.images];
                  if (slot < imgs.length) imgs[slot] = url;
                  else imgs.push(url); // 越界兜底：push 到尾部
                  return { ...c, images: imgs };
                })
              );
            } catch (err) {
              showToast(err instanceof Error ? err.message : "内页上传失败");
              aborted = true;
            } finally {
              setUploadState((s) =>
                s && s.pending > 1 ? { ...s, pending: s.pending - 1 } : null
              );
            }
          })
        );
      }
    } finally {
      setUploadState(null);
    }
  };

  // 移除某章节的单张内页（含失败占位槽），按下标删，剩余图片顺序保持
  const removePage = (chapterIndex: number, pageIndex: number) => {
    setChapters((prev) =>
      prev.map((c, i) =>
        i === chapterIndex
          ? { ...c, images: c.images.filter((_, k) => k !== pageIndex) }
          : c
      )
    );
  };

  // 标签：回车或点添加生成 chip
  const addTag = () => {
    const tag = tagInput.trim();
    if (!tag) return;
    if (!tags.includes(tag)) setTags((prev) => [...prev, tag]);
    setTagInput("");
  };

  // 提交审核：校验 → 组装 chapters 数组 → 带 Token POST /api/comics/submit → 后端入库待审核
  const handleSubmit = async () => {
    const isAppend = mode === "append";
    // 追加模式：书名/封面已存在，跳过相关校验
    if (!isAppend && !title.trim()) {
      showToast("请填写漫画书名");
      return;
    }
    if (!isAppend && !cover) {
      showToast("请上传一张封面图");
      return;
    }
    if (chapters.length === 0 || chapters.every((c) => c.images.length === 0)) {
      showToast("请至少为一个章节上传内页图");
      return;
    }
    const token = getToken();
    if (!token) {
      showToast("请先登录后再投稿");
      return;
    }
    // 失败占位槽（null）未处理完不允许提交：保证章节内页不缺页、顺序完整
    const badChapter = chapters.findIndex((c) => c.images.some((s) => s === null));
    if (badChapter !== -1) {
      showToast(
        `第${badChapter + 1}话还有未上传成功的内页，请点 X 删除后重新添加`
      );
      return;
    }
    // 数据组装：[{ title, images }, ...]；即使只有一章也是单元素数组
    // 追加模式空标题按“第N话”占位，后端会接着目标漫画章节数续排
    const chaptersPayload = chapters.map((c, i) => ({
      title: c.title.trim() || `第${i + 1}话`,
      images: c.images as string[],
    }));
    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/comics/submit`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          title: isAppend ? "" : title.trim(),
          author: author.trim(),
          cover_url: isAppend ? null : cover,
          tags: [...tags],
          intro: intro.trim() || null,
          need_translation: needTranslation, // 是否需要 AI 翻译
          chapters: chaptersPayload, // 章节数组：后端审核通过后写入 Chapter 表
          submit_type: mode, // new=新建整本 / append=追加章节
          target_comic_id: isAppend ? targetComicId : null,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        showToast(data?.detail ?? "投稿失败，请稍后重试");
        return;
      }
      showToast(isAppend ? "章节已追加，等待管理员审核" : "投稿成功！请耐心等待管理员审核");
      // 成功后跳转『我的投稿』，方便用户追踪审核进度
      setTimeout(() => router.push("/my-submissions"), 1400);
    } catch (err) {
      console.error("[投稿] 提交失败：", err);
      showToast("无法连接服务器，请确认后端已启动");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 via-white to-white pb-16">
      {/* 顶栏：返回 + 标题 */}
      <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-zinc-200/60 bg-white/80 px-4 backdrop-blur-xl">
        <button
          type="button"
          aria-label="返回"
          onClick={() => router.back()}
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/70 text-zinc-900 shadow-sm transition-colors hover:bg-white"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <h1 className="text-base font-bold text-zinc-900">
          {mode === "append" ? "追加章节" : "上传漫画（投稿）"}
        </h1>
      </div>

      <div className="mx-auto max-w-2xl space-y-4 px-4 pt-5">
        {/* 追加模式横幅：提示正在为哪本漫画追加 */}
        {mode === "append" && (
          <div className="rounded-2xl border border-violet-200 bg-violet-50/80 px-4 py-3 text-sm font-medium text-violet-700">
            正在为《{targetTitle || `漫画 #${targetComicId}`}》追加章节
          </div>
        )}

        {/* 基本信息（追加模式隐藏：书名/作者/简介沿用目标漫画） */}
        {mode === "new" && (
        <div className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl">
          <div className="space-y-3">
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="漫画书名 *"
              className="w-full rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
            />
            <input
              type="text"
              value={author}
              onChange={(e) => setAuthor(e.target.value)}
              placeholder="作者名（默认为当前用户）"
              className="w-full rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
            />
            <textarea
              rows={4}
              value={intro}
              onChange={(e) => setIntro(e.target.value)}
              placeholder="作品简介：剧情梗概、更新频率、适读人群等"
              className="w-full resize-none rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm leading-relaxed text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
            />
          </div>
        </div>
        )}

        {/* 标签（追加模式隐藏） */}
        {mode === "new" && (
        <div className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl">
          <p className="text-sm font-semibold text-zinc-900">标签</p>
          <div className="mt-3 flex gap-2">
            <input
              type="text"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTag()}
              placeholder="输入标签后回车或点击添加"
              className="flex-1 rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={addTag}
              className="rounded-xl bg-violet-500 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-violet-400 active:scale-95"
            >
              添加
            </button>
          </div>
          {tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1.5 rounded-full bg-violet-100 px-3 py-1 text-xs font-medium text-violet-600"
                >
                  #{tag}
                  <button
                    type="button"
                    aria-label={`移除标签 ${tag}`}
                    onClick={() => setTags((prev) => prev.filter((t) => t !== tag))}
                    className="flex h-4 w-4 items-center justify-center rounded-full bg-violet-200 text-violet-600 hover:bg-violet-300"
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        )}

        {/* 封面图（追加模式隐藏） */}
        {mode === "new" && (
        <div className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl">
          <p className="text-sm font-semibold text-zinc-900">封面图 *</p>
          <div className="mt-3 flex gap-3">
            {cover ? (
              <div className="relative">
                <img
                  src={cover}
                  alt="封面预览"
                  className="h-40 w-28 rounded-xl object-cover"
                />
                <button
                  type="button"
                  aria-label="移除封面"
                  onClick={() => setCover(null)}
                  className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-zinc-900/80 text-white"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label="上传封面"
                onClick={() => coverInputRef.current?.click()}
                className="flex h-40 w-28 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-zinc-300 bg-zinc-100/80 text-zinc-400 transition-colors hover:bg-zinc-200/70"
              >
                <ImagePlus className="h-6 w-6" />
                <span className="text-xs">上传封面</span>
              </button>
            )}
            <p className="flex-1 self-center text-xs leading-relaxed text-zinc-400">
              建议 2:3 比例竖版封面，JPG / PNG 格式；封面是读者看到的第一眼，请选最有代表性的画面。
            </p>
          </div>
        </div>
        )}

        {/* 动态章节管理：每章一个区块（标题输入框 + 专属多图上传） */}
        <div className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl">
          <p className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
            <FileImage className="h-4 w-4 text-violet-500" />
            章节管理 *（{chapters.length} 章）
          </p>
          <div className="mt-3 space-y-4">
            {chapters.map((chapter, ci) => (
              <div
                key={ci}
                className="rounded-xl border border-zinc-200 bg-white/80 p-3"
              >
                {/* 章节头部：标题输入框 + 删除此章节 */}
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={chapter.title}
                    onChange={(e) => renameChapter(ci, e.target.value)}
                    placeholder={`第${ci + 1}话`}
                    className="min-w-0 flex-1 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
                  />
                  {chapters.length > 1 && (
                    <button
                      type="button"
                      aria-label={`删除 ${chapter.title || `第${ci + 1}话`}`}
                      onClick={() => removeChapter(ci)}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-red-50 px-2.5 py-2 text-xs font-medium text-red-500 transition-colors hover:bg-red-100"
                    >
                      <X className="h-3.5 w-3.5" />
                      删除此章节
                    </button>
                  )}
                </div>

                {/* 该章节专属的内页多图上传 */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {chapter.images.map((src, pi) =>
                    src === null ? (
                      /* 占位槽：上传中转圈；上传结束仍是 null = 该张失败，点 X 删除后重选 */
                      <div key={`slot-${pi}`} className="relative">
                        <div
                          className={`flex aspect-[3/4] items-center justify-center rounded-lg border border-dashed ${
                            uploadState?.chapter === ci
                              ? "border-violet-300 bg-violet-50"
                              : "border-red-300 bg-red-50"
                          }`}
                        >
                          {uploadState?.chapter === ci ? (
                            <div className="h-5 w-5 animate-spin rounded-full border-2 border-violet-200 border-t-violet-500" />
                          ) : (
                            <X className="h-5 w-5 text-red-400" />
                          )}
                        </div>
                        {uploadState?.chapter !== ci && (
                          <button
                            type="button"
                            aria-label={`移除失败的内页 ${pi + 1}`}
                            onClick={() => removePage(ci, pi)}
                            className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900/80 text-white"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        )}
                      </div>
                    ) : (
                      <div key={src} className="relative">
                        <img
                          src={src}
                          alt={`${chapter.title || `第${ci + 1}话`} 内页 ${pi + 1}`}
                          className="aspect-[3/4] w-full rounded-lg object-cover"
                        />
                        <button
                          type="button"
                          aria-label={`移除内页 ${pi + 1}`}
                          onClick={() => removePage(ci, pi)}
                          className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-zinc-900/80 text-white"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                    )
                  )}
                  <button
                    type="button"
                    aria-label={`为 ${chapter.title || `第${ci + 1}话`} 添加内页`}
                    onClick={() => openPagesPicker(ci)}
                    className="flex aspect-[3/4] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-300 bg-zinc-100/80 text-zinc-400 transition-colors hover:bg-zinc-200/70"
                  >
                    <Plus className="h-5 w-5" />
                    <span className="text-xs">添加内页</span>
                  </button>
                </div>
              </div>
            ))}

            {/* 添加新章节按钮 */}
            <button
              type="button"
              onClick={addChapter}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-violet-300 bg-violet-50/60 py-3 text-sm font-medium text-violet-500 transition-colors hover:bg-violet-100/70"
            >
              <Plus className="h-4 w-4" />
              添加新章节
            </button>
          </div>
        </div>

        {/* 是否需要 AI 翻译：Segmented Control（新建与追加章节模式都显示） */}
        <div className="rounded-2xl border border-white/60 bg-white/70 p-4 shadow-[0_8px_32px_0_rgba(31,38,135,0.08)] backdrop-blur-xl">
          <p className="text-sm font-semibold text-zinc-900">是否需要 AI 翻译</p>
          <div className="mt-3 grid grid-cols-2 gap-1 rounded-xl bg-zinc-100 p-1">
            <button
              type="button"
              onClick={() => setNeedTranslation(true)}
              className={`rounded-lg py-2.5 text-sm font-semibold transition-colors ${
                needTranslation
                  ? "bg-violet-500 text-white shadow"
                  : "bg-transparent text-zinc-500 hover:bg-zinc-200/70"
              }`}
            >
              YES
            </button>
            <button
              type="button"
              onClick={() => setNeedTranslation(false)}
              className={`rounded-lg py-2.5 text-sm font-semibold transition-colors ${
                !needTranslation
                  ? "bg-violet-500 text-white shadow"
                  : "bg-transparent text-zinc-500 hover:bg-zinc-200/70"
              }`}
            >
              NO
            </button>
          </div>
        </div>

        {/* 提交审核 */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || uploadState !== null}
          className="w-full rounded-2xl bg-violet-500 py-3.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-violet-400 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? "提交中..." : "提交审核"}
        </button>
        <p className="pb-4 text-center text-xs text-zinc-400">
          提交后进入待审核状态，通过审核后作品会出现在漫画首页
        </p>
      </div>

      {/* 隐藏的文件选择 */}
      <input
        ref={coverInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleCover}
      />
      <input
        ref={pagesInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handlePages}
      />

      {/* 屏幕正中玻璃态 Toast */}
      {toastMsg && (
        <div className="fixed left-1/2 top-1/2 z-[100] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-black/60 px-6 py-3 text-center text-white backdrop-blur-xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
}

/**
 * 页面默认导出：useSearchParams 需要 Suspense 边界包裹才能稳定静态预渲染
 */
export default function UploadPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gradient-to-b from-violet-50 via-white to-white">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-200 border-t-violet-500" />
          <p className="text-sm text-zinc-400">正在加载投稿表单...</p>
        </div>
      }
    >
      <UploadForm />
    </Suspense>
  );
}
