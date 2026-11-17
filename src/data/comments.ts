/**
 * 评论数据模型（独立文件，避免 data/posts 与组件互相依赖造成循环）。
 * - CommentDrawer 与详情页从这里引用 CommentItem 类型
 * - 假数据 MOCK_COMMENTS 与 localStorage 持久化已彻底删除：
 *   漫画评论一律走后端真实接口（GET/POST /api/comics/{comic_id}/comments）
 */

export interface CommentItem {
  id: string;
  author: string;
  /** 头像图片地址；为空时组件用 ui-avatars.com 网络默认图兜底 */
  avatar?: string;
  /** 头像背景色（Tailwind 类名），无头像时的兜底背景 */
  color: string;
  time: string;
  content: string;
  likes: number;
  replies: CommentItem[];
}
