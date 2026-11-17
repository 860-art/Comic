import { type CommentItem } from "@/data/comments";

/**
 * 社交统一数据源：个人空间(/space)与漫画广场(/square)共用。
 * - 帖子持久化在 localStorage('all_posts')，首次访问时用 SOCIAL_POSTS 播种
 * - 关注状态持久化在 localStorage('follows')
 * - 每条帖子自带 comments 数组（评论按帖存储，互不串扰）
 * - 当前用户（"me"）的昵称来自 localStorage('userInfo')，头像/背景来自 'userInfo'/'profile_images'
 * - 注意：本文件只能 import 数据模块（如 data/comments），不得 import 组件
 */

export interface SocialPost {
  id: string;
  /** 广场文章标题；空间动态可为空（用正文首行兜底展示） */
  title: string;
  /** "me" 表示当前用户，其余对应 SPACE_USERS.id */
  authorId: string;
  author: string;
  /** 粉丝数（数字，便于关注 +1 联动） */
  followers: number;
  tags: string[];
  images: string[];
  /** 点赞数：新帖子一律 0 */
  likes: number;
  /** 热度文本，如 "3.2万"；普通动态可为空 */
  heat: string;
  /** 正文长文本 */
  intro: string;
  time: string;
  /** 本帖评论：新帖子一律空数组，评论后持久化到这里 */
  comments: CommentItem[];
  /** 评论数（与 comments.length 保持同步） */
  commentsCount: number;
}

export interface SpaceUser {
  id: string;
  name: string;
  avatar: string;
  banner: string;
  /** 基础粉丝数：发过文章的老用户较大，纯评论用户非常小（注册送的几个粉） */
  fans: number;
  /** 基础获赞数：注册送的小数字 */
  baseLikes: number;
}

/** 当前用户标识与默认信息 */
export const ME_ID = "me";
export const ME_DEFAULT_NAME = "当前用户";
export const ME_DEFAULT_AVATAR = "https://picsum.photos/id/64/200/200";
export const ME_DEFAULT_BANNER = "https://picsum.photos/seed/qzspace/800/400";

/** 其他用户（假数据）：覆盖广场作者与评论区出现的所有名字 */
export const SPACE_USERS: SpaceUser[] = [
  { id: "u1", name: "分镜收藏家", avatar: "https://picsum.photos/seed/ua1/200/200", banner: "https://picsum.photos/seed/ub1/800/400", fans: 17000, baseLikes: 120 },
  { id: "u2", name: "墨色研究所", avatar: "https://picsum.photos/seed/ua2/200/200", banner: "https://picsum.photos/seed/ub2/800/400", fans: 9632, baseLikes: 89 },
  { id: "u3", name: "封面设计手帐", avatar: "https://picsum.photos/seed/ua3/200/200", banner: "https://picsum.photos/seed/ub3/800/400", fans: 8204, baseLikes: 66 },
  { id: "u4", name: "线稿练习生", avatar: "https://picsum.photos/seed/ua4/200/200", banner: "https://picsum.photos/seed/ub4/800/400", fans: 6, baseLikes: 3 },
  { id: "u5", name: "配色小白", avatar: "https://picsum.photos/seed/ua5/200/200", banner: "https://picsum.photos/seed/ub5/800/400", fans: 2, baseLikes: 1 },
  { id: "u6", name: "排版强迫症", avatar: "https://picsum.photos/seed/ua6/200/200", banner: "https://picsum.photos/seed/ub6/800/400", fans: 4, baseLikes: 2 },
  { id: "u7", name: "豆腐块", avatar: "https://picsum.photos/seed/ua7/200/200", banner: "https://picsum.photos/seed/ub7/800/400", fans: 3, baseLikes: 5 },
  { id: "u8", name: "花瓣收藏夹", avatar: "https://picsum.photos/seed/ua8/200/200", banner: "https://picsum.photos/seed/ub8/800/400", fans: 1, baseLikes: 0 },
  { id: "u9", name: "咕咕鸟", avatar: "https://picsum.photos/seed/ua9/200/200", banner: "https://picsum.photos/seed/ub9/800/400", fans: 2, baseLikes: 1 },
];

/** 全局帖子初始数据（播种用），广场文章与空间动态同源 */
export const SOCIAL_POSTS: SocialPost[] = [
  {
    id: "p1",
    title: "复古欧风少女漫画分镜赏析",
    authorId: "u1",
    author: "分镜收藏家",
    followers: 17000,
    tags: ["复古画风", "恋爱", "连载中"],
    images: ["/images/square/article1-1.jpg", "/images/square/article1-2.jpg"],
    likes: 230,
    heat: "3.2万",
    comments: [] as CommentItem[],
    commentsCount: 0,
    time: "8月14日",
    intro:
      "这组画面来自一部典型的欧风少女漫画：华丽雕花画框中的人物肖像、柔和的淡粉色调、细腻的蕾丝与首饰刻画，处处透着旧时代沙龙画的仪式感。\n\n分镜上最值得学习的是“画框套画框”的手法——作者用装饰性边框把人物框成一幅古典油画，再让对话气泡打破边框，形成“画中人开口说话”的戏剧效果。这种处理让静态的分镜拥有了舞台剧般的层次。\n\n第二张图则展示了节奏的松弛：大面积留白的浅色背景配上人物侧脸特写，对话被推到画面下方的方框里，视线自然从脸部滑向台词，阅读节奏非常舒服。\n\n如果你正在创作恋爱或宫廷题材的作品，强烈建议研究这种“用装饰元素控制视线”的构图思路：先用繁复细节确立年代感，再用留白把注意力交还给角色情绪。",
  },
  {
    id: "p2",
    title: "Q 版奇幻漫画配色笔记",
    authorId: "u2",
    author: "墨色研究所",
    followers: 9632,
    tags: ["Q版角色", "奇幻", "配色灵感"],
    images: ["/images/square/article2-1.jpg"],
    likes: 196,
    heat: "1.8万",
    comments: [] as CommentItem[],
    commentsCount: 0,
    time: "8月15日",
    intro:
      "这张 Q 版角色图是学习“低饱和高明度”配色的绝佳案例：整体以冰蓝与奶白为基调，用粉色的花朵与蝴蝶做小面积点缀，画面干净又不寡淡。\n\n角色设计上同样有巧思——尖耳朵暗示奇幻种族，垂下的长辫与宽大连衣裙放大了“幼态感”，而微微下垂的眼角配合气泡台词，把“无奈吐槽”的情绪用最少的笔触传达出来。\n\n背景处理也很聪明：远景用竖条纹暗示建筑轮廓，中景留白，前景用散落的花瓣制造空气感，三层结构简单但完整。\n\n总结三条可以立刻上手的经验：一是配色先用两三个邻近色打底；二是点缀色只出现在头饰、道具等视觉焦点；三是 Q 版角色的表情重点放在眉眼与嘴角，幅度可以夸张，但线条要少。",
  },
  {
    id: "p3",
    title: "漫画书架封面设计灵感集",
    authorId: "u3",
    author: "封面设计手帐",
    followers: 8204,
    tags: ["封面设计", "排版参考", "UI 灵感"],
    images: ["/images/covers/book-2.svg", "/images/covers/book-6.svg"],
    likes: 158,
    heat: "2.6万",
    comments: [] as CommentItem[],
    commentsCount: 0,
    time: "8月16日",
    intro:
      "书架页的封面是读者与作品的第一触点。这两张封面走的是“纯色 + 衬线大字”路线：整版铺一个深色底，中央只放书名与作者名，四周留出一圈细描边，像一本真正被装帧过的纸质书。\n\n这类设计的优势在信息层级极其清晰——远看是一块颜色，近看是一个名字。它特别适合作品数量多、封面密集排列的网格场景：每本书都能用颜色快速区分，又能用统一的版式保持书架的整体感。\n\n动手复刻时注意三个细节：标题字号要敢于放大到画面高度的六分之一以上；作者名用小号半透明白，与主标题拉开对比；内边框与画面边缘保持等距，这是“装帧感”的来源。\n\n如果你在做自己的漫画网站或个人书架，不妨先从“一个主色 + 一行大字 + 一条细框”开始尝试。",
  },
];

/** 粉丝数格式化：过万显示 x.x万，其余千分位 */
export function formatFans(n: number): string {
  if (n >= 10000) {
    return `${(n / 10000).toFixed(1).replace(/\.0$/, "")}万`;
  }
  return n.toLocaleString("en-US");
}

export interface UserStats {
  fans: number;
  likes: number;
  postCount: number;
}

/** 当前用户真实统计：粉丝读 userInfo.fans（默认 0），获赞 = 自己帖子的点赞总和（默认 0） */
export function getMyStats(posts: SocialPost[]): UserStats {
  const mine = posts.filter((p) => p.authorId === ME_ID);
  let fans = 0;
  try {
    const raw = window.localStorage.getItem("userInfo");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (typeof parsed?.fans === "number") fans = parsed.fans;
    }
  } catch {
    // 忽略
  }
  const likes = mine.reduce((sum, p) => sum + (p.likes || 0), 0);
  return { fans, likes, postCount: mine.length };
}

/** 他人真实统计：小基数基础值 + 帖子点赞总和 + 关注 +1 */
export function getUserStats(
  authorId: string,
  posts: SocialPost[],
  followed: boolean
): UserStats {
  const user = SPACE_USERS.find((u) => u.id === authorId);
  const mine = posts.filter((p) => p.authorId === authorId);
  const fans = (user?.fans ?? 0) + (followed ? 1 : 0);
  const likes =
    (user?.baseLikes ?? 0) + mine.reduce((sum, p) => sum + (p.likes || 0), 0);
  return { fans, likes, postCount: mine.length };
}

/** 读取全局帖子：localStorage('all_posts') 优先，为空时播种初始数据；并规范化评论字段 */
export function loadPosts(): SocialPost[] {
  const normalize = (list: SocialPost[]): SocialPost[] =>
    list.map((p) => {
      const comments = Array.isArray(p.comments) ? p.comments : [];
      return {
        ...p,
        comments,
        commentsCount:
          typeof p.commentsCount === "number"
            ? p.commentsCount
            : comments.length,
      };
    });
  if (typeof window === "undefined") return SOCIAL_POSTS;
  try {
    const raw = window.localStorage.getItem("all_posts");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return normalize(parsed as SocialPost[]);
      }
    }
    window.localStorage.setItem("all_posts", JSON.stringify(SOCIAL_POSTS));
  } catch {
    // 数据损坏时回退初始数据
  }
  return SOCIAL_POSTS;
}

/** 持久化全局帖子（个人空间发布时 unshift 后调用） */
export function savePosts(posts: SocialPost[]) {
  try {
    window.localStorage.setItem("all_posts", JSON.stringify(posts));
  } catch {
    // 存储异常时静默降级
  }
}

/** 读取关注列表：localStorage('follows') */
export function loadFollowIds(): string[] {
  try {
    const raw = window.localStorage.getItem("follows");
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as string[];
    }
  } catch {
    // 忽略
  }
  return [];
}

/** 持久化关注列表 */
export function saveFollowIds(ids: string[]) {
  try {
    window.localStorage.setItem("follows", JSON.stringify(ids));
  } catch {
    // 忽略
  }
}

/** 用户主页路由：me → 自己的空间，其他 → /space/[id] */
export function getSpaceHref(authorId: string): string {
  return authorId === ME_ID ? "/space" : `/space/${authorId}`;
}

/** 按名字找用户（评论区跳转用） */
export function findUserByName(name: string): SpaceUser | undefined {
  return SPACE_USERS.find((u) => u.name === name);
}

/** 广场文章动态标题兜底：空标题时取正文首行截断 */
export function displayTitle(post: SocialPost): string {
  if (post.title) return post.title;
  const firstLine = post.intro.split("\n")[0].trim();
  if (!firstLine) return "动态";
  return firstLine.length > 16 ? `${firstLine.slice(0, 16)}…` : firstLine;
}
