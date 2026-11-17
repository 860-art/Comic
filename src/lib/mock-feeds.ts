/**
 * 漫画广场 Feed 流假数据（Mock Data）。
 * 仅用于搭建页面结构，后续接入真实数据源后替换。
 */
export interface FeedPost {
  id: string;
  /** 文章标题（移动端显示在卡片头部大标题） */
  title: string;
  /** 作者名字 */
  author: string;
  /** @昵称 */
  handle: string;
  /** 粉丝数 */
  followers: number;
  /** 热度标签（主图右上角） */
  heat: string;
  likes: number;
  comments: number;
  /** 标签（正文上方以 #芯片 展示） */
  tags: string[];
  /** 长文本简介 */
  intro: string;
}

export const MOCK_FEEDS: FeedPost[] = [
  {
    id: "1",
    title: "本周连载更新速递：热门作品大盘点",
    author: "连载观察员",
    handle: "update_daily",
    followers: 12800,
    heat: "3.2万",
    likes: 1560,
    comments: 234,
    tags: ["悬疑", "连载中", "周更"],
    intro:
      "本周多部人气作品迎来关键剧情节点。冒险主线进入新的篇章，角色关系逐步明朗；悬疑支线埋下的伏笔开始回收，讨论度持续走高。本文整理了各部作品的更新要点与时间线梳理，帮助你快速回顾剧情脉络，欢迎在评论区补充你观察到的细节。",
  },
  {
    id: "2",
    title: "新人作者创作经验谈：从分镜到完稿",
    author: "画笔不辍",
    handle: "pen_never_stops",
    followers: 8600,
    heat: "1.8万",
    likes: 980,
    comments: 156,
    tags: ["热血", "已完结", "创作"],
    intro:
      "一篇长篇连载从分镜到完稿需要经历哪些环节？作者结合自己三年的创作经历，分享了脚本拆分、分镜节奏、草稿修正与上色流程中的实用技巧，以及如何平衡更新频率与画面质量。文中还附上了常用的作画工具清单，供刚起步的创作者参考。",
  },
  {
    id: "3",
    title: "经典老番重读指南：为什么它至今仍被推荐",
    author: "补档收藏家",
    handle: "archive_keeper",
    followers: 21500,
    heat: "4.6万",
    likes: 2340,
    comments: 412,
    tags: ["恋爱", "连载中", "经典"],
    intro:
      "有些作品即便完结多年，依然被读者反复推荐。这篇长文从叙事结构、角色塑造与分镜语言三个角度重新解读这部经典，分析它对后来同类题材的影响，并整理了适合新读者入坑的阅读顺序。如果你还没读过，不妨把它加入书架。",
  },
];
