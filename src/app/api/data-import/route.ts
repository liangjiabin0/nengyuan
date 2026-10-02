import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { resolveDataSubdirs } from '@/lib/data-dirs';
import { startDataImport } from '@/lib/data-import';
import { defaultPaperConcurrency } from '@/lib/fast-import';
import { getImportJobState } from '@/lib/import-state';
import { listCajFiles } from '@/lib/papers';
import { readDbSummary } from '@/lib/db-summary';
import { getIndexStats } from '@/lib/search-index';
import { requireAdmin, requireUser } from '@/lib/auth/request';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const light = new URL(request.url).searchParams.get('light') === '1';
  const state = getImportJobState();
  const subdirs = resolveDataSubdirs(config.dataRootDir);
  // light 轮询高频：禁止扫盘统计 CAJ（数据目录可达数万文件）
  const pendingCaj = light
    ? 0
    : listCajFiles(subdirs.papers).length
      + listCajFiles(subdirs.patents).length
      + listCajFiles(subdirs.books).length;
  const summary = readDbSummary();
  const index =
    light || state?.status !== 'running'
      ? summary?.indexStats ?? null
      : await getIndexStats();
  return NextResponse.json({
    state,
    subdirs,
    pendingCaj,
    index,
    defaults: { concurrency: defaultPaperConcurrency(), fast: true, indexChunks: false, fullRebuild: false }
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({}));
  const rootDir = typeof body.rootDir === 'string' && body.rootDir.trim() ? body.rootDir.trim() : config.dataRootDir;
  const fast = body.fast !== false;
  const fullRebuild = body.fullRebuild === true;
  const crossLink = body.crossLink === true;
  const skipCaj = body.skipCaj === true;
  const concurrency = Number.isFinite(Number(body.concurrency)) ? Number(body.concurrency) : undefined;
  const started = await startDataImport(rootDir, {
    fast,
    fullRebuild,
    indexChunks: body.indexChunks === true,
    crossLink,
    skipCaj,
    concurrency
  });
  if (!started.started) {
    return NextResponse.json({ started: false, state: started.state }, { status: 409 });
  }
  return NextResponse.json({ started: true, state: started.state });
}
