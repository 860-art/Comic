/**
 * 后端 API 基础路径 —— 全局唯一出处。
 * - 线上（Vercel）：读取构建时注入的 NEXT_PUBLIC_COMIC_API_URL，
 *   指向 Railway 后端公网域名，例如 https://xxx.up.railway.app
 * - 本地开发：未设置该变量时回退到本机 8001，行为不变
 * 所有页面/组件统一从本文件导入，切勿在别处硬编码地址。
 */
export const API_BASE = (
  process.env.NEXT_PUBLIC_COMIC_API_URL || "http://127.0.0.1:8001"
).replace(/\/+$/, "");
