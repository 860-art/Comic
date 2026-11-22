/**
 * 图片上传：文件 → 后端 /api/upload → Cloudflare R2 → 返回公网 URL。
 * 全站统一入口（投稿封面/内页、发帖配图、头像背景），返回值直接可入库与展示。
 */
import { API_BASE } from "./api";
import { getToken } from "./auth";

export async function uploadImage(file: File): Promise<string> {
  const token = getToken();
  if (!token) throw new Error("请先登录后再上传图片");
  if (file.size > 10 * 1024 * 1024) throw new Error("图片超过 10MB 上限");

  const form = new FormData();
  form.append("file", file);

  const res = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { detail?: string } | null;
    throw new Error(data?.detail || `图片上传失败（${res.status}）`);
  }
  const data = (await res.json()) as { url?: string };
  if (!data.url) throw new Error("上传接口未返回图片地址");
  return data.url;
}

/** dataURL → File（评论配图在抽屉里以预览 dataURL 形式暂存，发布时转回 File 上传） */
export function dataUrlToFile(dataUrl: string, filename = "comment-image.png"): File {
  const [meta, base64] = dataUrl.split(",");
  const mime = meta.match(/:(.*?);/)?.[1] || "image/png";
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], filename, { type: mime });
}
