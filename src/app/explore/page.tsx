import { Suspense } from "react";
import SectionTitle from "@/components/SectionTitle";
import ExploreView from "@/components/ExploreView";

export default function ExplorePage() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <SectionTitle title="分类发现" subtitle="按题材标签筛选全站漫画作品" />
      {/* ExploreView 内部使用 useSearchParams() 读取 ?tag= 参数，
          用 Suspense 包裹以稳定预渲染，并提供筛选栏骨架屏 */}
      <Suspense
        fallback={
          <div className="h-16 rounded-3xl border border-white/50 bg-white/60 backdrop-blur-xl" />
        }
      >
        <ExploreView />
      </Suspense>
    </div>
  );
}
