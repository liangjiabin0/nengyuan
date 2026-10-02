import { NextResponse } from 'next/server';
import { getIndexStats, rebuildSearchIndex } from '@/lib/search-index';
import { crossLinkKnowledgeGraph } from '@/lib/kg/cross-link';
import { requireAdmin, requireUser } from '@/lib/auth/request';
import { enqueueOrRun } from '@/lib/jobs/dispatch';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    index: await getIndexStats()
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({} as { crossLink?: boolean }));
  const crossLinkFlag = body.crossLink !== false;

  const outcome = await enqueueOrRun(
    'reindex',
    { crossLink: crossLinkFlag },
    async () => {
      const crossLink = crossLinkFlag ? await crossLinkKnowledgeGraph() : null;
      const result = await rebuildSearchIndex();
      return {
        crossLink,
        result,
        index: await getIndexStats()
      };
    }
  );

  if (outcome.mode === 'queued') {
    return NextResponse.json({ ok: true, jobId: outcome.job.id }, { status: 202 });
  }
  return NextResponse.json(outcome.result as Record<string, unknown>);
}
