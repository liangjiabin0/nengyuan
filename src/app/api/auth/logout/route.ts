import { NextResponse } from 'next/server';
import {
  clearSessionCookie,
  isLocalAdminHost,
  logoutToken,
  readSessionToken
} from '@/lib/auth/request';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  if (isLocalAdminHost(request)) {
    return NextResponse.json({
      ok: true,
      localAdmin: true,
      message: '本机环回访问始终为管理员，登出不会生效。'
    });
  }

  const token = readSessionToken(request);
  await logoutToken(token);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response);
  return response;
}
