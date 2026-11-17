"use client";

import { useState } from "react";
import { Search } from "lucide-react";

/**
 * 全站搜索框。当前为占位实现，暂不接入真实搜索逻辑。
 */
export default function SearchBar() {
  const [keyword, setKeyword] = useState("");

  return (
    <form
      onSubmit={(e) => e.preventDefault()}
      className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-1.5"
    >
      <Search className="h-4 w-4 shrink-0 text-zinc-400" />
      <input
        type="text"
        value={keyword}
        onChange={(e) => setKeyword(e.target.value)}
        placeholder="搜索漫画…"
        className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-400"
      />
    </form>
  );
}
