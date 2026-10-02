import { NextResponse } from 'next/server';
import { getIndexStats, rebuildSearchIndex, searchRecords } from '@/lib/search-index';
import { requireAdmin, requireUser } from '@/lib/auth/request';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q') || '';
  const limit = Math.max(1, Math.min(50, Number(searchParams.get('limit') || '20')));

  if (!query.trim()) {
    return NextResponse.json({ index: await getIndexStats(), results: [] });
  }

  return NextResponse.json({
    index: await getIndexStats(),
    results: await searchRecords(query, { limit })
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    result: await rebuildSearchIndex(),
    index: await getIndexStats()
  });
}
