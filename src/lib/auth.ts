/**
 * 登录状态管理（真实后端版）。
 * - JWT token 由 FastAPI（POST /api/auth/login）签发，存入 localStorage('token')
 * - 判断是否登录 = localStorage 是否存在 token
 * - 前端不再有假登录/假注册逻辑
 */

export interface MockUser {
  isLoggedIn: boolean;
  username: string;
}

const TOKEN_KEY = "token";
const USERNAME_KEY = "username";

/** 读取登录状态：以 localStorage 中是否存在 token 为准（SSR 环境返回未登录默认值） */
export function getAuth(): MockUser {
  if (typeof window === "undefined") {
    return { isLoggedIn: false, username: "" };
  }
  const token = window.localStorage.getItem(TOKEN_KEY);
  return {
    isLoggedIn: Boolean(token),
    username: window.localStorage.getItem(USERNAME_KEY) ?? "",
  };
}

/** 登录成功：保存后端签发的 JWT token 与用户名 */
export function saveLoginSession(username: string, token: string) {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USERNAME_KEY, username);
}

/** 读取当前 token（后续带 Authorization: Bearer 请求鉴权接口时使用） */
export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

/** 退出登录：清空 token 与用户名 */
export function mockLogout() {
  window.localStorage.removeItem(TOKEN_KEY);
  window.localStorage.removeItem(USERNAME_KEY);
}
