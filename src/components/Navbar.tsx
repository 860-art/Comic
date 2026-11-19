"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, LogIn, UserRoundPlus } from "lucide-react";
import { NAV_LINKS, ROUTES, SITE_NAME, LogoIcon } from "@/lib/navigation";
import SearchBar from "@/components/SearchBar";
import { getAuth, getToken, MockUser } from "@/lib/auth";

import { API_BASE } from "@/lib/api";

function NavLinks() {
  const pathname = usePathname();

  return (
    <nav className="flex items-center gap-1">
      {NAV_LINKS.map(({ label, href, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors sm:px-3 ${
            pathname === href
              ? "bg-zinc-100 font-medium text-zinc-900"
              : "text-zinc-600 hover:text-zinc-900"
          }`}
        >
          <Icon className="h-4 w-4 shrink-0" />
          {/* 手机端仅显示图标，桌面端显示图标 + 文字 */}
          <span className="hidden sm:inline">{label}</span>
        </Link>
      ))}
    </nav>
  );
}

export default function Navbar() {
  const pathname = usePathname();
  // 默认未登录（与 SSR 输出一致，避免水合不一致），路由变化时重新读取 localStorage
  const [auth, setAuth] = useState<MockUser>({ isLoggedIn: false, username: "" });
  // 未读通知数：> 0 时铃铛显示红点（每次路由变化重新拉取）
  const [unread, setUnread] = useState(0);

  useEffect(() => {
    setAuth(getAuth());
    const token = getToken();
    if (!token) {
      setUnread(0);
      return;
    }
    fetch(`${API_BASE}/api/notifications/unread-count`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { count?: number } | null) => {
        setUnread(typeof data?.count === "number" ? data.count : 0);
      })
      .catch(() => {
        // 后端未启动 → 不显示红点
        setUnread(0);
      });
  }, [pathname]);

  return (
    <header className="sticky top-0 z-40 bg-white/65 backdrop-blur-xl">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4 md:gap-6">
        {/* Logo */}
        <Link href={ROUTES.home} className="flex items-center gap-2 font-semibold">
          <LogoIcon className="h-5 w-5" />
          <span>{SITE_NAME}</span>
        </Link>

        {/* 主导航（依赖运行时路径，用 Suspense 包裹以支持预渲染） */}
        <Suspense fallback={<div className="h-8 w-44 md:w-64" />}>
          <NavLinks />
        </Suspense>

        {/* 右侧区域：搜索框 + 铃铛（最右）/登录注册，整体固定靠右 */}
        <div className="ml-auto flex items-center gap-3">
          {/* 搜索框 */}
          <div className="hidden w-56 sm:block">
            <SearchBar />
          </div>

          {/* 未登录：登录 / 注册按钮 */}
          {!auth.isLoggedIn && (
            <div className="flex items-center gap-2">
              <Link
                href={ROUTES.login}
                className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm text-zinc-600 hover:text-zinc-900"
              >
                <LogIn className="h-4 w-4" />
                <span className="hidden sm:inline">登录</span>
              </Link>
              <Link
                href={ROUTES.register}
                className="flex items-center gap-1 rounded-md bg-zinc-900 px-2 py-1.5 text-sm text-white hover:bg-zinc-700 sm:px-3"
              >
                <UserRoundPlus className="h-4 w-4" />
                <span className="hidden sm:inline">注册</span>
              </Link>
            </div>
          )}

          {/* 通知铃铛：仅登录后显示，固定最右侧，点击进通知中心；有未读显示红点 */}
          {auth.isLoggedIn && (
            <Link
              href={ROUTES.notifications}
              aria-label={unread > 0 ? `通知（${unread} 条未读）` : "通知"}
              className="relative flex h-8 w-8 items-center justify-center rounded-full text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            >
              <Bell className="h-4 w-4" />
              {unread > 0 && (
                <span className="absolute right-1 top-1 h-2 w-2 rounded-full bg-red-500 ring-2 ring-white" />
              )}
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
