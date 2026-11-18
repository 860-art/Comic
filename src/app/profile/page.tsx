"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Camera, ChevronRight, Pencil, Star, Upload, X } from "lucide-react";
import { getAuth, getToken, mockLogout } from "@/lib/auth";
import { API_BASE } from "@/lib/api";
import { ROUTES } from "@/lib/navigation";

/**
 * 个人中心页（白色玻璃态 · 名片式布局，参考 QQ 资料卡）：
 * - Banner 背景图置顶；白色玻璃卡片上移覆盖其下缘，头像压在两者交界线上
 * - 模块一：点击 Banner → 三项底部菜单（查看封面 / 上传图片 / 取消）
 * - 模块二：点击头像 → 全屏放大（右侧悬浮编辑图标）→ 两项底部菜单（从相册选择 / 取消）
 * - 底部三个白色玻璃胶囊按钮（个性名片 / 编辑资料 / 发消息）
 */

interface MenuItem {
  label: string;
  onClick: () => void;
}

/** 通用底部菜单（白色玻璃态）：遮罩 + 底部弹出的选项列表 */
function BottomMenu({
  open,
  onClose,
  items,
}: {
  open: boolean;
  onClose: () => void;
  items: MenuItem[];
}) {
  return (
    <>
      <div
        onClick={onClose}
        className={`fixed inset-0 z-[80] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[85] transition-transform duration-300 ease-out ${
          open ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="mx-3 mb-3 overflow-hidden rounded-3xl border border-white/60 bg-white/85 shadow-2xl backdrop-blur-xl">
          {items.map((item, i) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                onClose();
                item.onClick();
              }}
              className={`w-full px-4 py-3.5 text-sm font-medium text-zinc-900 transition-colors hover:bg-zinc-100/70 ${
                i < items.length - 1 ? "border-b border-zinc-200/70" : ""
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}

export default function ProfilePage() {
  const router = useRouter();

  // ===== 模块一：Banner 背景图（默认使用固定本地占位图，绝不随机） =====
  const [bannerSrc, setBannerSrc] = useState("/images/default-cover.svg");
  const [bannerMenuOpen, setBannerMenuOpen] = useState(false);
  const bannerInputRef = useRef<HTMLInputElement>(null);

  // ===== 模块二：头像（默认固定本地占位图） =====
  const [avatarSrc, setAvatarSrc] = useState("/images/default-avatar.svg");
  const [avatarMenuOpen, setAvatarMenuOpen] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // 全屏查看器：banner / avatar / null（两条链路来源独立）
  const [viewer, setViewer] = useState<"banner" | "avatar" | null>(null);

  // ===== 用户信息：单一状态源 + localStorage 持久化 =====
  const [userInfo, setUserInfo] = useState({
    nickname: "当前用户",
    signature: "今天也在追更漫画。",
    gender: "女",
    birthday: "8-8",
    tags: [] as string[], // 默认没有标签，由用户自行添加管理
    fans: 0, // 真实数据：默认没有粉丝
    likes: 0, // 真实数据：默认没有获赞
  });
  // 抽屉一：编辑资料开关与草稿
  const [editOpen, setEditOpen] = useState(false);
  const [draft, setDraft] = useState(userInfo);
  // 抽屉二：编辑标签开关与输入
  const [tagOpen, setTagOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");

  // 头像/背景是否已从数据库恢复（防止默认值覆盖已保存的数据）
  const [imagesReady, setImagesReady] = useState(false);

  // 登录状态与角色（管理员审核台按钮仅 role === 'admin' 时显示）
  const [authReady, setAuthReady] = useState(false);
  const [auth, setAuth] = useState({ isLoggedIn: false, username: "" });
  const [role, setRole] = useState("");
  // 保存反馈 Toast
  const [toastMsg, setToastMsg] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(null), 2000);
  };

  // 页面加载：本地有 Token 则立刻从数据库拉取真实资料（GET /api/auth/me）
  useEffect(() => {
    const authState = getAuth();
    setAuth(authState);
    const token = getToken();
    setAuthReady(true);

    if (!token) {
      setImagesReady(true);
      return;
    }

    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/auth/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          // token 失效：保持默认占位图即可（下次登录会重新拉取）
          return;
        }
        const data = await res.json();
        const user = data.user;
        // 数据库里有就用数据库的；没有（新用户）保持固定本地占位图
        // tags：后端已解析为数组（如 ["悬疑","热血"]），必须接收渲染，不能用空数组覆盖
        setUserInfo((prev) => ({
          ...prev,
          nickname: user.username ?? prev.nickname,
          signature: user.signature ?? prev.signature,
          gender: user.gender ?? prev.gender,
          birthday: user.birthday ?? prev.birthday,
          tags: Array.isArray(user.tags) ? user.tags : prev.tags,
        }));
        // 管理员门控：role 以数据库为准（AO 等管理员账号显示审核台入口）
        setRole(user.role === "admin" ? "admin" : "");
        if (user.avatar_url) setAvatarSrc(user.avatar_url);
        if (user.cover_url) setBannerSrc(user.cover_url);
      } catch (err) {
        console.error("[个人中心] 拉取资料失败：", err);
      } finally {
        setImagesReady(true);
      }
    };
    load();
  }, []);

  // userInfo（连同最新头像/背景）任何变化立刻持久化，主页实时渲染最新数据
  useEffect(() => {
    if (!imagesReady) return;
    try {
      window.localStorage.setItem(
        "userInfo",
        JSON.stringify({ ...userInfo, avatar: avatarSrc, banner: bannerSrc })
      );
    } catch {
      // 忽略存储异常
    }
  }, [userInfo, avatarSrc, bannerSrc, imagesReady]);

  // 头像/背景变化立刻持久化，供个人空间页同步展示
  useEffect(() => {
    if (!imagesReady) return;
    try {
      window.localStorage.setItem(
        "profile_images",
        JSON.stringify({ banner: bannerSrc, avatar: avatarSrc })
      );
    } catch {
      // 忽略存储异常
    }
  }, [bannerSrc, avatarSrc, imagesReady]);

  // 保存资料：更新本地 state + PUT /api/auth/me 写入数据库
  const handleSaveProfile = async () => {
    setUserInfo((prev) => ({ ...prev, ...draft }));
    setEditOpen(false);
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          signature: draft.signature,
          gender: draft.gender,
          birthday: draft.birthday,
        }),
      });
      if (res.ok) {
        showToast("资料已保存");
      } else {
        showToast("保存失败，请重新登录后重试");
      }
    } catch (err) {
      console.error("[个人中心] 保存资料失败：", err);
      showToast("无法连接服务器");
    }
  };

  // 标签持久化：PUT /api/auth/me 把 tags 数组写入数据库（刷新后仍在）
  const persistTags = async (tags: string[]) => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ tags }),
      });
      showToast(res.ok ? "标签已保存" : "标签保存失败，请重新登录后重试");
    } catch (err) {
      console.error("[个人中心] 标签保存失败：", err);
      showToast("无法连接服务器");
    }
  };

  // 添加标签：push 进 userInfo.tags 并持久化到数据库
  const handleAddTag = () => {
    const tag = tagInput.trim();
    if (!tag) return;
    if (!userInfo.tags.includes(tag)) {
      const next = [...userInfo.tags, tag];
      setUserInfo((prev) => ({ ...prev, tags: next }));
      persistTags(next);
    }
    setTagInput("");
  };

  // 删除标签：从 userInfo.tags 移除并持久化到数据库
  const handleRemoveTag = (tag: string) => {
    const next = userInfo.tags.filter((t) => t !== tag);
    setUserInfo((prev) => ({ ...prev, tags: next }));
    persistTags(next);
  };

  const openEditDrawer = () => {
    setDraft(userInfo);
    setEditOpen(true);
  };

  // 上传图片：FileReader 转 dataURL → 更新本地预览 + PUT /api/auth/me 存入数据库
  const uploadImage = async (
    e: React.ChangeEvent<HTMLInputElement>,
    field: "avatar_url" | "cover_url",
    setter: (src: string) => void
  ) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // 允许重复选择同一文件
    if (!file) return;
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    setter(dataUrl);
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ [field]: dataUrl }),
      });
      showToast(res.ok ? "图片已保存" : "保存失败，请重新登录后重试");
    } catch (err) {
      console.error("[个人中心] 上传图片保存失败：", err);
      showToast("无法连接服务器");
    }
  };

  const handleLogout = () => {
    mockLogout();
    router.push(ROUTES.home);
  };

  // 等待登录状态读取完成，避免水合闪烁
  if (!authReady) {
    return <div className="min-h-screen bg-zinc-50" />;
  }

  // 未登录拦截：不渲染资料，显示登录引导
  if (!auth.isLoggedIn) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-5 bg-gradient-to-b from-violet-50 via-white to-white px-6 text-center">
        <p className="text-lg font-medium text-zinc-700">
          请先登录才能查看个人中心
        </p>
        <button
          type="button"
          onClick={() => router.push(ROUTES.login)}
          className="rounded-full bg-violet-500 px-8 py-2.5 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-violet-400 active:scale-95"
        >
          登录
        </button>
      </div>
    );
  }

  return (
    <div className="pb-16">
      {/* ============ 模块一：Banner 背景图 ============ */}
      <div
        className="relative h-64 w-full cursor-pointer"
        onClick={() => setBannerMenuOpen(true)}
      >
        <img
          src={bannerSrc}
          alt="个人中心背景"
          onError={(e) => {
            // 破图兜底：固定本地占位图，绝不让破图符号露出来
            (e.target as HTMLImageElement).src = "/images/default-cover.svg";
          }}
          className="h-full w-full bg-gradient-to-r from-violet-200 to-violet-100 object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-black/10" />
        {/* 白色玻璃提示：点击可更换封面 */}
        <span className="absolute bottom-3 right-3 flex items-center gap-1.5 rounded-full border border-white/60 bg-white/70 px-3 py-1.5 text-xs font-medium text-zinc-900 shadow-sm backdrop-blur-md">
          <Camera className="h-3.5 w-3.5" />
          更换封面
        </span>
      </div>

      {/* ============ 白色玻璃名片卡片：上移覆盖 Banner 下缘 ============ */}
      <div className="mx-auto max-w-6xl px-4">
        <div className="relative -mt-20 rounded-3xl border border-white/60 bg-white/70 shadow-[0_8px_32px_0_rgba(31,38,135,0.12)] backdrop-blur-xl">
          {/* 头像：压在 Banner 与卡片的交界线上（参照背景与头像的位置关系） */}
          <button
            type="button"
            aria-label="查看头像"
            onClick={() => setViewer("avatar")}
            className="absolute -top-16 left-6 transition-transform active:scale-95"
          >
            <img
              src={avatarSrc}
              alt="头像"
              onError={(e) => {
                (e.target as HTMLImageElement).src = "/images/default-avatar.svg";
              }}
              className="h-32 w-32 rounded-full bg-zinc-200 object-cover shadow-xl ring-4 ring-white"
            />
            {/* 头像右下角小相机徽标 */}
            <span className="absolute -bottom-1 -right-1 flex h-8 w-8 items-center justify-center rounded-full border border-white/60 bg-white/85 text-zinc-900 shadow-md backdrop-blur-md">
              <Camera className="h-4 w-4" />
            </span>
          </button>

          {/* 名字与 ID：避让左侧头像 */}
          <div className="pl-44 pr-6 pt-8">
            <h2 className="text-2xl font-bold text-zinc-900">
              {userInfo.nickname}
            </h2>
            <p className="mt-1 text-sm text-zinc-500">
              ID: AOLICOMIC001 · 漫画爱好者
            </p>
          </div>

          {/* 信息行 */}
          <div className="mt-6 divide-y divide-zinc-200/70 border-t border-zinc-200/70 px-6">
            {/* 签名：纯文本展示，不带箭头 */}
            <div className="py-4">
              <p className="text-sm leading-relaxed text-zinc-800">
                {userInfo.signature}
              </p>
            </div>
            {/* 性别 / 生日：纯文本展示 */}
            <div className="py-4">
              <p className="text-sm text-zinc-500">
                {userInfo.gender === "女" ? "♀ 女" : "♂ 男"} · 生日{" "}
                {userInfo.birthday}
              </p>
            </div>
            {/* 标签区：点击呼出编辑标签抽屉 */}
            <div className="py-4">
              <p className="text-xs text-zinc-400">我的标签</p>
              <button
                type="button"
                onClick={() => setTagOpen(true)}
                className="mt-2 flex max-w-full flex-wrap gap-2 text-left"
              >
                {userInfo.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-zinc-200 bg-white/80 px-3 py-1 text-xs text-zinc-700"
                  >
                    #{tag}
                  </span>
                ))}
                {userInfo.tags.length === 0 && (
                  <span className="text-xs text-zinc-400">暂无标签</span>
                )}
                <span className="rounded-full border border-dashed border-zinc-300 px-3 py-1 text-xs text-zinc-400">
                  ＋ 添加
                </span>
              </button>
            </div>
            {/* 资料填写 */}
            <div className="flex items-center justify-between py-4">
              <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                资料填写
              </p>
              <button
                type="button"
                onClick={openEditDrawer}
                className="flex items-center gap-0.5 text-sm text-violet-500"
              >
                去填写
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            {/* 我的空间：跳转个人空间页 */}
            <div className="flex items-center justify-between py-4">
              <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                我的空间
              </p>
              <button
                type="button"
                onClick={() => router.push(ROUTES.space)}
                className="flex items-center gap-0.5 text-sm text-violet-500"
              >
                去逛逛
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            {/* 上传漫画（投稿）：跳转『我的投稿』（页内 + 号再进投稿页） */}
            <div className="flex items-center justify-between py-4">
              <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                <Upload className="h-4 w-4 text-zinc-700" />
                上传漫画（投稿）
              </p>
              <button
                type="button"
                onClick={() => router.push("/my-submissions")}
                className="flex items-center gap-0.5 text-sm text-violet-500"
              >
                去投稿
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
            {/* 我的书架 */}
            <div className="flex items-center justify-between py-4">
              <p className="flex items-center gap-2 text-sm font-medium text-zinc-900">
                <Star className="h-4 w-4 text-zinc-700" />
                我的书架
              </p>
              <button
                type="button"
                onClick={() => router.push(ROUTES.library)}
                className="flex items-center gap-0.5 text-sm text-violet-500"
              >
                去翻翻
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>

        {/* 管理员审核台：仅 role === 'admin' 时显示 */}
        {role === "admin" && (
          <button
            type="button"
            onClick={() => router.push("/admin")}
            className="mt-6 w-full rounded-2xl bg-red-500 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-red-400 active:scale-[0.98]"
          >
            管理员审核台（仅测试用）
          </button>
        )}

        {/* 退出登录（白色玻璃按钮） */}
        <button
          type="button"
          onClick={handleLogout}
          className="mt-3 w-full rounded-2xl border border-white/60 bg-white/70 py-3 text-sm font-medium text-zinc-700 shadow-sm backdrop-blur-xl transition-colors hover:bg-white/90"
        >
          退出登录
        </button>
      </div>

      {/* ===== 抽屉一：编辑资料（白色玻璃态，底部弹出） ===== */}
      <div
        onClick={() => setEditOpen(false)}
        className={`fixed inset-0 z-[80] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          editOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[85] transition-transform duration-300 ease-out ${
          editOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="flex max-h-[75vh] flex-col rounded-t-3xl border-t border-white/60 bg-white/90 shadow-2xl backdrop-blur-xl">
          <div className="shrink-0 px-6 pt-5">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300" />
            <h3 className="text-lg font-bold text-zinc-900">编辑资料</h3>
          </div>
          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
            {/* 昵称 */}
            <label className="block">
              <span className="text-xs text-zinc-500">昵称</span>
              <input
                type="text"
                value={draft.nickname}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, nickname: e.target.value }))
                }
                className="mt-1 w-full rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm text-zinc-900 focus:outline-none"
              />
            </label>
            {/* 签名（多行） */}
            <label className="block">
              <span className="text-xs text-zinc-500">签名</span>
              <textarea
                rows={3}
                value={draft.signature}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, signature: e.target.value }))
                }
                className="mt-1 w-full resize-none rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm text-zinc-900 focus:outline-none"
              />
            </label>
            {/* 性别切换 */}
            <div>
              <span className="text-xs text-zinc-500">性别</span>
              <div className="mt-1 flex gap-2">
                {["男", "女"].map((g) => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => setDraft((d) => ({ ...d, gender: g }))}
                    className={`flex-1 rounded-xl border py-2.5 text-sm font-medium transition-colors ${
                      draft.gender === g
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-white/80 text-zinc-700 hover:bg-zinc-100"
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            {/* 生日 */}
            <label className="block">
              <span className="text-xs text-zinc-500">生日</span>
              <input
                type="text"
                value={draft.birthday}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, birthday: e.target.value }))
                }
                placeholder="如：8-8"
                className="mt-1 w-full rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
              />
            </label>
          </div>
          <div className="shrink-0 px-6 pb-6 pt-2">
            <button
              type="button"
              onClick={handleSaveProfile}
              className="w-full rounded-2xl bg-zinc-900 py-3 text-sm font-semibold text-white shadow-lg transition-all hover:bg-zinc-700 active:scale-[0.98]"
            >
              保存修改
            </button>
          </div>
        </div>
      </div>

      {/* ===== 抽屉二：编辑标签（参照“我的标签”页样式） ===== */}
      <div
        onClick={() => setTagOpen(false)}
        className={`fixed inset-0 z-[80] bg-black/40 backdrop-blur-sm transition-opacity duration-300 ${
          tagOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <div
        className={`fixed inset-x-0 bottom-0 z-[85] transition-transform duration-300 ease-out ${
          tagOpen ? "translate-y-0" : "translate-y-full"
        }`}
      >
        <div className="flex max-h-[70vh] flex-col rounded-t-3xl border-t border-white/60 bg-white/90 shadow-2xl backdrop-blur-xl">
          <div className="shrink-0 px-6 pt-5">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-300" />
            <h3 className="text-2xl font-bold text-zinc-900">我的标签</h3>
            <p className="mt-1 text-sm text-zinc-500">
              贴上标签，有个性的你自己。
            </p>
          </div>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            {/* 当前已有标签：带 × 删除按钮 */}
            <div className="flex flex-wrap gap-2">
              {userInfo.tags.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white/80 py-1.5 pl-3.5 pr-2 text-sm text-zinc-800"
                >
                  #{tag}
                  <button
                    type="button"
                    aria-label={`删除标签 ${tag}`}
                    onClick={() => handleRemoveTag(tag)}
                    className="flex h-5 w-5 items-center justify-center rounded-full bg-zinc-200 text-zinc-500 transition-colors hover:bg-zinc-300 hover:text-zinc-700"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              {userInfo.tags.length === 0 && (
                <p className="text-sm text-zinc-400">
                  还没有标签，在下方添加一个吧
                </p>
              )}
            </div>
            {/* 添加新标签 */}
            <div className="mt-5 flex gap-2">
              <input
                type="text"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                placeholder="输入新标签，如“悬疑”"
                className="flex-1 rounded-xl border border-zinc-200 bg-white/80 px-3 py-2.5 text-sm text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
              />
              <button
                type="button"
                onClick={handleAddTag}
                className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-700 active:scale-95"
              >
                添加
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ===== 隐藏的本地文件选择（两条链路各自独立） ===== */}
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => uploadImage(e, "cover_url", setBannerSrc)}
      />
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => uploadImage(e, "avatar_url", setAvatarSrc)}
      />

      {/* ===== 模块一底部菜单：三项 ===== */}
      <BottomMenu
        open={bannerMenuOpen}
        onClose={() => setBannerMenuOpen(false)}
        items={[
          { label: "查看封面", onClick: () => setViewer("banner") },
          {
            label: "上传图片",
            onClick: () => bannerInputRef.current?.click(),
          },
          { label: "取消", onClick: () => {} },
        ]}
      />

      {/* ===== 模块二底部菜单：两项 ===== */}
      <BottomMenu
        open={avatarMenuOpen}
        onClose={() => setAvatarMenuOpen(false)}
        items={[
          {
            label: "从相册选择",
            onClick: () => avatarInputRef.current?.click(),
          },
          { label: "取消", onClick: () => {} },
        ]}
      />

      {/* ===== 全屏查看器：Banner 封面 ===== */}
      {viewer === "banner" && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90 p-4"
          onClick={() => setViewer(null)}
        >
          <img
            src={bannerSrc}
            alt="封面大图"
            className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain"
          />
        </div>
      )}

      {/* ===== 全屏查看器：头像放大 + 右侧悬浮编辑图标 ===== */}
      {viewer === "avatar" && (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/90"
          onClick={() => setViewer(null)}
        >
          <div className="relative" onClick={(e) => e.stopPropagation()}>
            <img
              src={avatarSrc}
              alt="头像大图"
              className="h-64 w-64 rounded-full object-cover"
            />
            <button
              type="button"
              aria-label="编辑头像"
              onClick={() => {
                setViewer(null);
                setAvatarMenuOpen(true);
              }}
              className="absolute -right-3 top-1/2 flex h-11 w-11 -translate-y-1/2 items-center justify-center rounded-full border border-white/60 bg-white/90 text-zinc-900 shadow-xl backdrop-blur-md transition-colors hover:bg-white"
            >
              <Pencil className="h-5 w-5" />
            </button>
          </div>
        </div>
      )}

      {/* 保存反馈 Toast（屏幕正中玻璃态） */}
      {toastMsg && (
        <div className="fixed left-1/2 top-1/2 z-[100] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-white/20 bg-black/60 px-6 py-3 text-white backdrop-blur-xl">
          {toastMsg}
        </div>
      )}
    </div>
  );
}
