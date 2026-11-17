import { ReactNode } from "react";

interface SectionTitleProps {
  title: string;
  subtitle?: string;
  /** 标题右侧的自定义操作区（如“查看更多”链接） */
  action?: ReactNode;
}

/**
 * 内容区域标题组件。
 */
export default function SectionTitle({ title, subtitle, action }: SectionTitleProps) {
  return (
    <div className="mb-4 flex items-end justify-between">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900">{title}</h2>
        {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}
