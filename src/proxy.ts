import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE, SESSION_HEADER } from '@/lib/auth/types';

const PUBLIC_PATHS = new Set([
  '/login',
  '/healthz',
  '/api/auth/login',
  '/api/auth/me'
]);

function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname.startsWith('/datav/')) return true;
  if (pathname === '/favicon.ico') return true;
  if (/\.(?:png|jpg|jpeg|gif|svg|ico|webp|css|js|map|txt|woff2?)$/i.test(pathname)) return true;
  return false;
}

function withForwardedAuth(request: NextRequest) {
  // Preserve Cookie while adding the internal session header for Node handlers.
  const requestHeaders = new Headers(request.headers);
  const originalHost = request.headers.get('host') || '';
  if (originalHost) {
    requestHeaders.set('x-ai4es-original-host', originalHost);
  }
  const token = request.cookies.get(SESSION_COOKIE)?.value || '';
  if (token) {
    requestHeaders.set(SESSION_HEADER, token);
    const cookieHeader = request.headers.get('cookie') || '';
    if (cookieHeader.includes(`${SESSION_COOKIE}=`)) {
      requestHeaders.set('cookie', cookieHeader);
    } else {
      requestHeaders.set(
        'cookie',
        cookieHeader ? `${cookieHeader}; ${SESSION_COOKIE}=${encodeURIComponent(token)}` : `${SESSION_COOKIE}=${encodeURIComponent(token)}`
      );
    }
  }
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (isPublicPath(pathname)) {
    return withForwardedAuth(request);
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    return withForwardedAuth(request);
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: '未登录或会话已过期。' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)']
};
