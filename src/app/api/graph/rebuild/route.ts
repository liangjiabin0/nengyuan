import { NextResponse } from 'next/server';
import { crossLinkKnowledgeGraph } from '@/lib/kg/cross-link';
import { rebuildAliases } from '@/lib/kg/rebuild-aliases';
import { autoMergeHighConfidence } from '@/lib/kg/merge';
import { requireAdmin } from '@/lib/auth/request';
import { enqueueOrRun } from '@/lib/jobs/dispatch';

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({} as { mode?: string }));
    const mode = body.mode || 'full';

    const outcome = await enqueueOrRun('graph-rebuild', { mode }, async () => {
      if (mode === 'aliases') return rebuildAliases();
      if (mode === 'merge') return autoMergeHighConfidence();
      return crossLinkKnowledgeGraph();
    });

    if (outcome.mode === 'queued') {
      return NextResponse.json({ ok: true, jobId: outcome.job.id, mode }, { status: 202 });
    }
    return NextResponse.json({ ok: true, result: outcome.result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
