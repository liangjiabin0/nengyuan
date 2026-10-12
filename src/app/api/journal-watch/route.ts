import { NextResponse } from 'next/server';
import { requireAdmin, requireUser } from '@/lib/auth/request';
import { enqueueOrRun } from '@/lib/jobs/dispatch';
import { listJobs } from '@/lib/jobs/queue';
import { runJournalWatch } from '@/lib/journal-watch/run';
import { getJournalWatchOverview, listJournalWatchArticles, type JournalWatchListQuery } from '@/lib/journal-watch/store';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

const STATUSES = new Set(['all', 'abstract', 'title-only', 'fulltext']);

/** 期刊追踪：各期刊统计、最近一次抓取情况、文章列表。 */
export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const params = new URL(request.url).searchParams;
  const status = params.get('status') || 'all';
  const query: JournalWatchListQuery = {
    journal: params.get('journal')?.trim() || undefined,
    days: Number(params.get('days')) || undefined,
    q: params.get('q')?.trim() || undefined,
    status: (STATUSES.has(status) ? status : 'all') as JournalWatchListQuery['status'],
    page: Number(params.get('page')) || 1,
    pageSize: Number(params.get('pageSize')) || 50
  };
  try {
    const [overview, list, jobs] = await Promise.all([
      getJournalWatchOverview(),
      listJournalWatchArticles(query),
      listJobs({ type: 'journal-watch', limit: 1 }).catch(() => [])
    ]);
    const activeJob = jobs.find((job) => job.status === 'queued' || job.status === 'running') || null;
    return NextResponse.json({
      ...overview,
      ...list,
      activeJob: activeJob ? { id: activeJob.id, status: activeJob.status, progress: activeJob.progress } : null
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '读取期刊追踪失败。', 500);
  }
}

/** 管理员手动触发一次抓取；backfillDays 可指定往前补抓的天数。 */
export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const body = (await request.json().catch(() => ({}))) as { backfillDays?: unknown };
  const backfillDays = Math.min(365, Math.max(0, Number(body.backfillDays) || 0)) || undefined;
  try {
    const result = await enqueueOrRun('journal-watch', { trigger: 'manual', backfillDays }, () =>
      runJournalWatch({ trigger: 'manual', backfillDays })
    );
    return NextResponse.json(result.mode === 'queued' ? { mode: 'queued', jobId: result.job.id } : { mode: 'inline', summary: result.result });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '启动抓取失败。', 500);
  }
}
