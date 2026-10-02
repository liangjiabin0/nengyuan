'use server';

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import {
  isLocalAdminHost,
  loginAsDefaultAdmin,
  loginWithPassword,
  logoutToken,
  sessionCookieOptions
} from '@/lib/auth/request';
import { SESSION_COOKIE } from '@/lib/auth/types';

function safeNextPath(raw: unknown) {
  const value = String(raw || '/').trim() || '/';
  if (!value.startsWith('/') || value.startsWith('//') || value === '/login' || value.startsWith('/login?')) {
    return '/';
  }
  return value;
}

function fail(message: string): never {
  redirect(`/login?error=${encodeURIComponent(message)}`);
}

export async function loginAction(formData: FormData) {
  const username = String(formData.get('username') || '').trim();
  const password = String(formData.get('password') || '');
  const nextPath = safeNextPath(formData.get('next'));

  const headerList = await headers();
  const request = new Request('http://local.invalid/login', { headers: headerList });
  const jar = await cookies();
  const previousToken = jar.get(SESSION_COOKIE)?.value || '';
  if (isLocalAdminHost(request)) {
    const result = await loginAsDefaultAdmin();
    if (previousToken && previousToken !== result.token) await logoutToken(previousToken);
    jar.set(SESSION_COOKIE, result.token, sessionCookieOptions());
    redirect(nextPath);
  }

  if (!username || !password) {
    fail('请输入用户名和密码。');
  }

  const result = await loginWithPassword(username, password);
  if (!result) {
    fail('用户名或密码错误。');
  }

  if (previousToken && previousToken !== result.token) await logoutToken(previousToken);
  jar.set(SESSION_COOKIE, result.token, sessionCookieOptions());
  redirect(nextPath);
}
