import { NextResponse } from 'next/server';
import {
  clearSessionCookie,
  isLocalAdminHost,
  loginAsDefaultAdmin,
  loginWithPassword,
  logoutToken,
  readSessionToken,
  setSessionCookie,
  toPublicUser
} from '@/lib/auth/request';

export const runtime = 'nodejs';

function publicOrigin(request: Request) {
  const url = new URL(request.url);
  const host =
    request.headers.get('x-ai4es-original-host') ||
    request.headers.get('x-forwarded-host') ||
    request.headers.get('host') ||
    url.host;
  const proto = request.headers.get('x-forwarded-proto') || url.protocol.replace(/:$/, '') || 'http';
  return `${proto}://${host}`;
}

function safeNextPath(raw: unknown) {
  const value = String(raw || '/').trim() || '/';
  if (!value.startsWith('/') || value.startsWith('//') || value === '/login' || value.startsWith('/login?')) {
    return '/';
  }
  return value;
}

async function readLoginBody(request: Request) {
  const contentType = request.headers.get('content-type') || '';
  const raw = await request.text().catch(() => '');

  if (contentType.includes('application/json') || raw.trim().startsWith('{')) {
    const body = raw ? (JSON.parse(raw) as { username?: unknown; password?: unknown; next?: unknown }) : {};
    return {
      username: String(body?.username || '').trim(),
      password: String(body?.password || ''),
      nextPath: safeNextPath(body?.next),
      form: false
    };
  }

  const params = new URLSearchParams(raw);
  return {
    username: String(params.get('username') || '').trim(),
    password: String(params.get('password') || ''),
    nextPath: safeNextPath(params.get('next')),
    form: true
  };
}

function redirectTo(request: Request, path: string, cookieToken?: string) {
  const response = NextResponse.redirect(new URL(path, publicOrigin(request)), 303);
  if (cookieToken) setSessionCookie(response, cookieToken);
  return response;
}

function fail(request: Request, form: boolean, message: string, status: number) {
  if (form) {
    const url = new URL('/login', publicOrigin(request));
    url.searchParams.set('error', message);
    return NextResponse.redirect(url, 303);
  }
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const previousToken = readSessionToken(request);
  const { username, password, nextPath, form } = await readLoginBody(request).catch(() => ({
    username: '',
    password: '',
    nextPath: '/',
    form: true
  }));

  if (isLocalAdminHost(request)) {
    const result = await loginAsDefaultAdmin();
    if (previousToken && previousToken !== result.token) await logoutToken(previousToken);
    if (form) return redirectTo(request, nextPath, result.token);
    const response = NextResponse.json({
      user: toPublicUser(result.user, true),
      localAdmin: true,
      message: '本机环回访问已自动使用管理员账号，无需登录。'
    });
    setSessionCookie(response, result.token);
    return response;
  }

  if (!username || !password) {
    return fail(request, form, '请输入用户名和密码。', 400);
  }

  const result = await loginWithPassword(username, password);
  if (!result) {
    return fail(request, form, '用户名或密码错误。', 401);
  }
  if (previousToken && previousToken !== result.token) await logoutToken(previousToken);

  if (form) return redirectTo(request, nextPath, result.token);

  const response = NextResponse.json({
    user: toPublicUser(result.user, false),
    localAdmin: false
  });
  setSessionCookie(response, result.token);
  return response;
}

export async function DELETE(request: Request) {
  if (!isLocalAdminHost(request)) await logoutToken(readSessionToken(request));
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
