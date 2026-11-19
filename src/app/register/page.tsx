"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ROUTES } from "@/lib/navigation";

import { API_BASE } from "@/lib/api";

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !email.trim() || !password.trim()) {
      setError("请填写用户名、邮箱和密码");
      return;
    }
    // 邮箱格式校验：必须包含 @，否则无法注册
    if (!email.includes("@") || email.startsWith("@") || email.endsWith("@")) {
      setError("邮件格式不正确");
      return;
    }
    if (password.length < 6) {
      setError("密码长度至少 6 位");
      return;
    }
    setError("");
    setLoading(true);
    try {
      // 真实注册：请求后端 /api/auth/register（密码由后端 bcrypt 哈希入库）
      const res = await fetch(`${API_BASE}/api/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          email: email.trim(),
          password: password,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.detail ?? "注册失败，请稍后重试");
        return;
      }
      // 注册成功：提示后跳转登录页
      setSuccess(true);
      setTimeout(() => router.push(ROUTES.login), 1200);
    } catch (err) {
      console.error("[注册] 请求失败：", err);
      setError("无法连接服务器，请确认后端已启动");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <h1 className="text-2xl font-semibold">注册</h1>
      <p className="mt-2 text-sm text-zinc-500">创建 AoliComic 账号，开启你的漫画之旅。</p>

      <form onSubmit={handleSubmit} className="mt-6 space-y-4">
        <input
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="用户名"
          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="邮箱"
          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="密码（至少 6 位）"
          className="w-full rounded-md border border-zinc-200 px-3 py-2 text-sm outline-none"
        />
        {error && <p className="text-sm text-red-500">{error}</p>}
        {success && <p className="text-sm text-green-600">注册成功！正在跳转到登录页…</p>}
        <button
          type="submit"
          disabled={loading || success}
          className="w-full rounded-md bg-zinc-900 py-2 text-sm text-white hover:bg-zinc-700 disabled:opacity-50"
        >
          {loading ? "注册中..." : "注册"}
        </button>
      </form>

      <p className="mt-4 text-sm text-zinc-500">
        已有账号？
        <Link href={ROUTES.login} className="text-zinc-900 underline">
          去登录
        </Link>
      </p>
    </div>
  );
}
