"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { saveLoginSession } from "@/lib/auth";
import { ROUTES } from "@/lib/navigation";

import { API_BASE } from "@/lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [showErrorModal, setShowErrorModal] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password.trim()) {
      setError("请填写用户名和密码");
      return;
    }
    setError("");
    setLoading(true);
    try {
      // 真实登录：请求后端 /api/auth/login
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password: password,
        }),
      });
      if (!res.ok) {
        // 401 等：读取后端返回的 detail 展示
        const data = await res.json().catch(() => null);
        setShowErrorModal(true);
        if (data?.detail) console.warn("登录失败：", data.detail);
        return;
      }
      const data = await res.json();
      // 关键：保存 JWT token 与用户名，之后所有页面据此判断登录态
      saveLoginSession(data.user?.username ?? username.trim(), data.access_token);
      router.push(ROUTES.home);
    } catch (err) {
      console.error("[登录] 请求失败：", err);
      setError("无法连接服务器，请确认后端已启动");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold">登录</h1>
      <p className="mt-2 text-sm text-zinc-500">请输入您的账号和密码</p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="用户名"
          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码"
          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={loading}
          className="w-full rounded-md bg-zinc-900 py-2 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {loading ? "登录中..." : "登录"}
        </button>
      </form>

      <p className="mt-4 text-sm text-zinc-500">
        还没有账号？
        <Link href={ROUTES.register} className="text-zinc-900 underline">
          去注册
        </Link>
      </p>

      {/* 信息错误弹窗 */}
      {showErrorModal && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4"
          onClick={() => setShowErrorModal(false)}
        >
          <div
            className="w-full max-w-xs rounded-2xl bg-white p-8 text-center shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-xl font-bold text-red-600">错误</h2>
            <p className="mt-3 text-sm text-zinc-700">用户名或密码错误</p>
            <button
              type="button"
              onClick={() => setShowErrorModal(false)}
              className="mt-6 w-full rounded-md bg-red-600 py-2 text-sm font-medium text-white hover:bg-red-500"
            >
              确定
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
