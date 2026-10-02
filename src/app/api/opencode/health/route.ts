import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { getOpenCodeHealth } from '@/lib/opencode/runtime';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;

  const health = await getOpenCodeHealth();
  return NextResponse.json({
    healthy: Boolean(health?.healthy),
    version: health?.version || null,
    url: health?.url || null,
    error: 'error' in health ? health.error : undefined
  });
}
