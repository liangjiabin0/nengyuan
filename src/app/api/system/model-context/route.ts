import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { detectModelContext } from '@/lib/model-context';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  // 【按线上版本还原】支持第三档 storm。
  const requested = new URL(request.url).searchParams.get('role');
  const role = requested === 'storm' ? 'storm' : requested === 'large' ? 'large' : 'small';
  const info = await detectModelContext(role);
  return NextResponse.json(info, {
    headers: { 'Cache-Control': 'private, max-age=60' }
  });
}
