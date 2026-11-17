import { BookOpen, Home, Library, SquareUser, Compass } from "lucide-react";

/**
 * 全站路由常量，避免在组件中硬编码路径。
 */
export const ROUTES = {
  home: "/",
  /** 阅读页：跳到指定章节；不传章节时默认第 1 话（章节 ID 规则为 {漫画ID}-{序号}） */
  read: (id: string, chapterId = `${id}-1`) => `/comic/${id}/chapter/${chapterId}`,
  comic: (id: string) => `/comic/${id}`,
  square: "/square",
  explore: "/explore",
  upload: "/upload",
  profile: "/profile",
  space: "/space",
  library: "/library",
  login: "/login",
  register: "/register",
  notifications: "/notifications",
} as const;

/**
 * 顶部导航链接配置。
 */
export const NAV_LINKS = [
  { label: "首页", href: ROUTES.home, icon: Home },
  { label: "漫画广场", href: ROUTES.square, icon: Compass },
  { label: "我的书架", href: ROUTES.library, icon: Library },
  { label: "个人中心", href: ROUTES.profile, icon: SquareUser },
] as const;

export const SITE_NAME = "AoliComic";

export const LogoIcon = BookOpen;
