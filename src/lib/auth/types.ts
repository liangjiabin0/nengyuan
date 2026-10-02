export type UserRole = 'admin' | 'user';

export type AuthUser = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
};

export type AuthUserPublic = {
  id: string;
  username: string;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
  /** 通过 localhost / 127.0.0.1 / ::1 访问时为 true。 */
  localAdmin: boolean;
};

export const SESSION_COOKIE = 'dy_session';
/** 拆分架构下 Next rewrite/proxy 可能丢掉 Cookie，用该头把会话交给 API 进程 */
export const SESSION_HEADER = 'x-ai4es-session';
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = process.env.DEFAULT_ADMIN_PASSWORD || '';
