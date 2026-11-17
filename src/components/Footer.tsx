import { SITE_NAME } from "@/lib/navigation";

export default function Footer() {
  return (
    <footer className="border-t border-zinc-200 py-8">
      <div className="mx-auto flex max-w-6xl items-center justify-center px-4 text-sm text-zinc-500">
        <span>© 2026 {SITE_NAME} · 漫画阅读与交流</span>
      </div>
    </footer>
  );
}
