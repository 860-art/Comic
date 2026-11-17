/**
 * 全站统一假数据仓库（Mock Data）。
 * 首页（Home）、书架（Library）、漫画详情页（Comic Detail）等所有页面
 * 一律从本文件读取 MOCK_COMICS，确保全局数据统一、封面/主题色/章节互通。
 */

/** 单个章节 */
export interface Chapter {
  id: string;
  /** 章节标题，如“第1话 坠入星海” */
  title: string;
  /** 本章节页数 */
  pages: number;
}

/** 漫画条目 */
export interface Comic {
  id: string;
  title: string;
  author: string;
  /** 封面图路径 */
  coverUrl: string;
  /** 封面主题色（十六进制），用于书架渐变背景 */
  themeColor: string;
  /** 阅读进度（0-100） */
  progress: number;
  /** 连载状态 */
  status: "连载中" | "已完结";
  /** 最近更新时间 */
  updatedAt: string;
  /** 收藏数 */
  favorites: number;
  /** 简介长文本 */
  description: string;
  /** 标签：必须从 ALL_TAGS 中选取（不含“全部”） */
  tags: string[];
  /** 是否需要 AI 翻译（用户投稿时选择；原生漫画无此字段 → 阅读页默认显示翻译按钮） */
  needTranslation?: boolean;
  /** 章节列表 */
  chapters: Chapter[];
}

/** 全站统一的分类标签体系：分类页、详情页、筛选器共用 */
export const ALL_TAGS = ["全部", "科幻", "悬疑", "热血", "奇幻", "日常", "爱情"] as const;

export const MOCK_COMICS: Comic[] = [
  {
    id: "1",
    title: "星尘旅人",
    author: "林小满",
    coverUrl: "/images/covers/book-1.svg",
    themeColor: "#2F3B46",
    progress: 68,
    status: "已完结",
    updatedAt: "2026-11-02",
    favorites: 12800,
    tags: ["科幻", "热血"],
    description:
      "少年拾荒者在废土边缘捡到一枚会发光的星核，从此踏上横跨七个星系的旅途。冷色调的星空分镜与温暖的人物互动形成强烈反差，是一部兼具史诗感与治愈系的太空歌剧漫画。",
    chapters: [
      { id: "1-1", title: "第1话 坠入星海", pages: 32 },
      { id: "1-2", title: "第2话 铁锈集市", pages: 28 },
      { id: "1-3", title: "第3话 乘客编号 07", pages: 30 },
      { id: "1-4", title: "第4话 跃迁前夜", pages: 26 },
    ],
  },
  {
    id: "2",
    title: "赤月传说",
    author: "陈默",
    coverUrl: "/images/covers/book-2.svg",
    themeColor: "#5A2A2A",
    progress: 32,
    status: "连载中",
    updatedAt: "2026-11-12",
    favorites: 9600,
    tags: ["奇幻", "热血"],
    description:
      "血月降临之夜，猎魔人后裔被迫继承家族封印之刃。赤红主色调的水墨风战斗分镜极具冲击力，讲述一个关于传承、背叛与救赎的东方奇幻故事。",
    chapters: [
      { id: "2-1", title: "第1话 血月之夜", pages: 36 },
      { id: "2-2", title: "第2话 封印之刃", pages: 30 },
      { id: "2-3", title: "第3话 山神庙", pages: 34 },
      { id: "2-4", title: "第4话 同门", pages: 28 },
    ],
  },
  {
    id: "3",
    title: "深海咖啡馆",
    author: "苏晚",
    coverUrl: "/images/covers/book-3.svg",
    themeColor: "#3A4A63",
    progress: 85,
    status: "连载中",
    updatedAt: "2026-11-10",
    favorites: 15300,
    tags: ["日常", "爱情"],
    description:
      "传说在马里亚纳海沟最深处，有一家只为疲惫的灵魂营业的咖啡馆。章鱼店长、灯塔水母侍应生和人类的常客们，在深蓝世界里交换着一个个温柔的故事。",
    chapters: [
      { id: "3-1", title: "第1话 深夜营业中", pages: 24 },
      { id: "3-2", title: "第2话 灯塔水母的班次", pages: 22 },
      { id: "3-3", title: "第3话 失眠的沉船船长", pages: 26 },
      { id: "3-4", title: "第4话 气泡苏打与回忆", pages: 24 },
    ],
  },
  {
    id: "4",
    title: "热血高校联盟",
    author: "张远航",
    coverUrl: "/images/covers/book-4.svg",
    themeColor: "#8C3130",
    progress: 12,
    status: "连载中",
    updatedAt: "2026-11-11",
    favorites: 7400,
    tags: ["热血", "科幻"],
    description:
      "垫底高中的空手道部只剩三名成员，却在全国大赛前夜收到神秘的联合邀请。斜纹动感封面的运动漫画，分镜充满速度线与汗水的力量感。",
    chapters: [
      { id: "4-1", title: "第1话 三人残部", pages: 30 },
      { id: "4-2", title: "第2话 联盟邀请函", pages: 28 },
      { id: "4-3", title: "第3话 集训第一天", pages: 32 },
      { id: "4-4", title: "第4话 雨中的道场", pages: 26 },
    ],
  },
  {
    id: "5",
    title: "谜案手记",
    author: "顾之遥",
    coverUrl: "/images/covers/book-5.svg",
    themeColor: "#4A1F1F",
    progress: 45,
    status: "连载中",
    updatedAt: "2026-11-09",
    favorites: 11200,
    tags: ["悬疑", "科幻"],
    description:
      "一本从旧书摊淘来的手记，记载着这座城市从未破获的悬案。档案侦探以手记为线索层层倒推，放大镜与证物特写的分镜让读者与主角同步推理。",
    chapters: [
      { id: "5-1", title: "第1话 旧书摊的委托", pages: 34 },
      { id: "5-2", title: "第2话 手记里的死者", pages: 30 },
      { id: "5-3", title: "第3话 第七件证物", pages: 32 },
      { id: "5-4", title: "第4话 不在场的十分钟", pages: 30 },
    ],
  },
  {
    id: "6",
    title: "云端漫游者",
    author: "方既明",
    coverUrl: "/images/covers/book-6.svg",
    themeColor: "#1E2B3A",
    progress: 90,
    status: "已完结",
    updatedAt: "2026-10-28",
    favorites: 8800,
    tags: ["科幻", "日常"],
    description:
      "云端数据维护员每天的工作是修理人们记忆里损坏的天气预报。当你发现自己天空里多出一朵不该存在的云，故事就开始了。一部安静而有回响的软科幻漫画。",
    chapters: [
      { id: "6-1", title: "第1话 天气修理工", pages: 28 },
      { id: "6-2", title: "第2话 多出来的一朵云", pages: 26 },
      { id: "6-3", title: "第3话 客户的雨天", pages: 28 },
      { id: "6-4", title: "第4话 晴，局部有你", pages: 30 },
    ],
  },
];
