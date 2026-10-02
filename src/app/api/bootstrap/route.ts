import { NextResponse } from 'next/server';
import { persistDbSummary } from '@/lib/db';
import { readDbSummary } from '@/lib/db-summary';
import { requireUser } from '@/lib/auth/request';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  void import('@/lib/chat-workspace-retention')
    .then((mod) => mod.purgeExpiredChatWorkspaceContent())
    .catch((error) => {
      console.error('[chat-workspace-retention] bootstrap purge failed', error);
    });
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';
  const cached = readDbSummary();

  if (cached && !refresh) {
    return NextResponse.json({ ...cached, ready: true, source: 'cache' });
  }

  const payload = await persistDbSummary({ includeSlowCounts: false });
  return NextResponse.json({ ...payload, ready: true, source: refresh ? 'refresh' : 'computed' });
}
