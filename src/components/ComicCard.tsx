import Link from "next/link";
import { ROUTES } from "@/lib/navigation";

interface ComicCardProps {
  id: string;
  title: string;
  /** 作者名（可选） */
  author?: string;
  /** 封面图地址（可选，缺省时显示占位色块） */
  coverUrl?: string;
  /** 展示在标题下方的标签（可选） */
  tags?: string[];
}

/**
 * 漫画封面卡片，点击跳转到漫画详情页。
 */
export default function ComicCard({ id, title, author, coverUrl, tags }: ComicCardProps) {
  return (
    <Link
      href={ROUTES.comic(id)}
      className="group block overflow-hidden rounded-lg border border-zinc-200 transition-shadow hover:shadow-md"
    >
      {/* 封面占位：后续接入真实图片时替换为 next/image */}
      <div className="relative aspect-[3/4] bg-gradient-to-br from-zinc-200 to-zinc-300">
        {coverUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={coverUrl} alt={title} className="h-full w-full object-cover" />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-sm text-zinc-500">
            封面占位
          </span>
        )}
      </div>
      <div className="p-2">
        <p className="truncate text-sm font-medium text-zinc-900 group-hover:underline">
          {title}
        </p>
        {author && (
          <p className="mt-0.5 truncate text-xs text-zinc-500">{author}</p>
        )}
        {tags && tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    </Link>
  );
}
