import { NextResponse } from 'next/server';
import { ingestExcelAndCsv } from '@/lib/excel-ingest';
import { requireAdmin } from '@/lib/auth/request';
import { enqueueOrRun } from '@/lib/jobs/dispatch';

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const outcome = await enqueueOrRun('excel-ingest', {}, () => ingestExcelAndCsv());
    if (outcome.mode === 'queued') {
      return NextResponse.json({ ok: true, jobId: outcome.job.id }, { status: 202 });
    }
    return NextResponse.json({ ok: true, result: outcome.result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
