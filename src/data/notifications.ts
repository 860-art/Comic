/**
 * 通知中心假数据（Mock Data）。
 * 类型：system（系统通知）/ like（点赞）/ comment（评论）。
 * 点击跳转规则：like / comment → /space（我的空间）；system 不跳转。
 */

export type NotificationType = "system" | "like" | "comment";

export interface AppNotification {
  id: string;
  type: NotificationType;
  /** 发送者名字：系统通知固定为“官方” */
  sender: string;
  /** 发送者网络头像（可选，无则用字母圆） */
  avatarUrl?: string;
  /** 字母圆背景色（无 avatarUrl 时使用） */
  color?: string;
  /** 动作文案 */
  action: string;
  /** 补充内容（评论原文 / 公告摘要） */
  detail?: string;
  time: string;
}

export const MOCK_NOTIFICATIONS: AppNotification[] = [
  {
    id: "n1",
    type: "system",
    sender: "官方",
    color: "bg-violet-500 text-white",
    action: "AoliComic官方发布了新公告",
    detail: "全新 AI 翻译功能上线，现在可以在阅读页配置自己的 API 密钥了！",
    time: "今天 10:00",
  },
  {
    id: "n2",
    type: "like",
    sender: "花瓣收藏夹",
    avatarUrl: "https://picsum.photos/seed/ua8/200/200",
    action: "赞了你的动态",
    time: "今天 09:12",
  },
  {
    id: "n3",
    type: "comment",
    sender: "墨色研究所",
    avatarUrl: "https://picsum.photos/seed/ua2/200/200",
    action: "评论了你：",
    detail: "这个分镜处理得太棒了，能出一期构图教程吗？",
    time: "今天 08:30",
  },
  {
    id: "n4",
    type: "like",
    sender: "分镜收藏家",
    avatarUrl: "https://picsum.photos/seed/ua1/200/200",
    action: "赞了你的动态",
    time: "昨天 22:47",
  },
  {
    id: "n5",
    type: "comment",
    sender: "豆腐块",
    avatarUrl: "https://picsum.photos/seed/ua7/200/200",
    action: "评论了你：",
    detail: "配色好干净，先收藏了！",
    time: "昨天 21:05",
  },
  {
    id: "n6",
    type: "system",
    sender: "官方",
    color: "bg-violet-500 text-white",
    action: "AoliComic官方发布了新公告",
    detail: "周末投稿活动开启：活动期间过审的作品将获得首页双倍曝光。",
    time: "前天 18:00",
  },
  {
    id: "n7",
    type: "comment",
    sender: "线稿练习生",
    avatarUrl: "https://picsum.photos/seed/ua4/200/200",
    action: "评论了你：",
    detail: "厉害，期待更新！",
    time: "3 天前",
  },
];
