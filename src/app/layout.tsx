import type { Metadata } from "next";
import { Suspense } from "react";
import "./globals.css";
import Navbar from "@/components/Navbar";

export const metadata: Metadata = {
  title: "AoliComic - 漫画阅读与交流",
  description: "漫画阅读与交流网站",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-white text-zinc-900">
        {/* Navbar 内部使用了 usePathname()，用 Suspense 包裹解决预渲染报错，
            并在导航栏加载时提供骨架屏占位 */}
        <Suspense fallback={<div className="h-16 bg-white/60"></div>}>
          <Navbar />
        </Suspense>
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
