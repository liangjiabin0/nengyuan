import { NextResponse } from 'next/server';
import { cookies, headers } from 'next/headers';
import { getSessionUser, createSession, deleteSession } from './session';
import { ensureDefaultAdmin, isAdminUser } from './users';
import {
  SESSION_COOKIE,
  SESSION_HEADER,
  SESSION_TTL_MS,
  type AuthUser,
  type AuthUserPublic
} from './types';

function hostnameFromHostHeader(value: string | null | undefined) {
  const first = String(value || '').split(',')[0].trim().toLowerCase();
  if (!first) return '';
  if (first.startsWith('[')) {
    const end = first.indexOf(']');
    if (end > 1) return first.slice(1, end);
  }
  return first.split(':')[0];
}

export function isLoopbackHostname(hostname: string) {
  return hostname === '127.0.0.1'
    || hostname === 'localhost'
    || hostname === '::1'
    || hostname === '[::1]';
}

/**
 * 解析「浏览器侧」主机名。
 * 拆分架构下 Next rewrite 到 127.0.0.1:4000，Host 会变成 API 地址；
 * 此时仅当直连 Host 为环回时，才信任 X-Forwarded-Host（本机反代），
 * 避免局域网用户被误判为本机管理员。
 */
export function getRequestHostname(request: Request) {
  // Prefer the browser host stamped by Next middleware before rewrite.
  const original = hostnameFromHostHeader(request.headers.get('x-ai4es-original-host'));
  if (original) return original;

  const host = hostnameFromHostHeader(request.headers.get('host'));
  const forwarded = hostnameFromHostHeader(request.headers.get('x-forwarded-host'));
  if (isLoopbackHostname(host) && forwarded) {
    return forwarded;
  }
  return host;
}

/**
 * 浏览器侧主机名是 localhost / 127.0.0.1 / ::1 时视为本机管理员。
 * 不单独信任 X-Forwarded-Host，避免局域网请求伪造 localhost。
 */
export function isLocalAdminHost(request: Request) {
  // Host and forwarding headers are client-controlled; require a real session everywhere.
  void request;
  return false;
}

export function readSessionTokenFromCookieHeader(cookieHeader: string | null) {
  if (!cookieHeader) return '';
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const [rawName, ...rest] = part.trim().split('=');
    if (rawName === SESSION_COOKIE) return decodeURIComponent(rest.join('=') || '');
  }
  return '';
}

export function toPublicUser(user: AuthUser, localAdmin = false): AuthUserPublic {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    localAdmin
  };
}

export function sessionCookieOptions(maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    path: '/',
    secure: false,
    maxAge: maxAgeSeconds
  };
}

export function setSessionCookie(response: NextResponse, token: string) {
  response.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
}

/**
 * 解析当前请求用户：
 * localhost 环回访问直接视为默认管理员；其它来源校验 session cookie/header。
 */
export async function resolveRequestUser(request: Request): Promise<{
  user: AuthUser | null;
  localAdmin: boolean;
  token: string;
}> {
  if (isLocalAdminHost(request)) {
    const admin = await ensureDefaultAdmin();
    return { user: admin, localAdmin: true, token: readSessionToken(request) };
  }
  const token = readSessionToken(request);
  const user = await getSessionUser(token);
  return { user, localAdmin: false, token };
}

export function readSessionToken(request: Request) {
  const fromCookie = readSessionTokenFromCookieHeader(request.headers.get('cookie'));
  if (fromCookie) return fromCookie;
  const fromHeader = request.headers.get(SESSION_HEADER)?.trim() || '';
  if (fromHeader) return fromHeader;
  const auth = request.headers.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return '';
}

export async function requireUser(request: Request) {
  const resolved = await resolveRequestUser(request);
  if (!resolved.user) {
    return {
      error: NextResponse.json({ error: '未登录或会话已过期。' }, { status: 401 }),
      user: null as AuthUser | null,
      localAdmin: false,
      token: resolved.token
    };
  }
  return {
    error: null as NextResponse | null,
    user: resolved.user,
    localAdmin: resolved.localAdmin,
    token: resolved.token
  };
}

export async function requireAdmin(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth;
  if (!isAdminUser(auth.user)) {
    return {
      error: NextResponse.json({ error: '需要管理员权限。' }, { status: 403 }),
      user: auth.user,
      localAdmin: auth.localAdmin,
      token: auth.token
    };
  }
  return auth;
}

/** 服务端组件 / 布局用：localhost 自动管理员，否则从 cookies() 取会话。 */
export async function getServerAuthUser(_options?: { host?: string | null }) {
  try {
    const headerList = await headers();
    const request = new Request('http://local.invalid/', { headers: headerList });
    if (isLocalAdminHost(request)) {
      return { user: await ensureDefaultAdmin(), localAdmin: true };
    }
  } catch {
    // 非 Next 请求上下文时退回 cookie 会话
  }
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value || '';
  return { user: await getSessionUser(token), localAdmin: false };
}

export async function loginAsDefaultAdmin() {
  const user = await ensureDefaultAdmin();
  const token = await createSession(user.id);
  return { user, token };
}

export async function loginWithPassword(username: string, password: string) {
  const { authenticateUser } = await import('./users');
  const user = await authenticateUser(username, password);
  if (!user) return null;
  const token = await createSession(user.id);
  return { user, token };
}

export async function logoutToken(token: string) {
  await deleteSession(token);
}
