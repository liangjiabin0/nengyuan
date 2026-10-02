import { NextResponse } from 'next/server';
import { getStats } from '@/lib/db';
import { readDbSummary } from '@/lib/db-summary';
import { getIndexStats } from '@/lib/search-index';
import { requireUser } from '@/lib/auth/request';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const summary = readDbSummary();
  if (summary) {
    return NextResponse.json({ stats: summary.stats, indexStats: summary.indexStats });
  }
  const [stats, indexStats] = await Promise.all([getStats(), getIndexStats()]);
  return NextResponse.json({ stats, indexStats });
}
