import { NextResponse } from 'next/server';
import { fetchGraphRelations, fetchTermCooccurrenceGraph, findPapersForGraphNode, searchGraphSeeds } from '@/lib/graph-relations';
import { communitySummary, shortestPathBetween } from '@/lib/kg/graph-engine';
import { requireUser } from '@/lib/auth/request';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode') || 'expand';
  const seeds = [
    ...searchParams.getAll('seed'),
    ...(searchParams.get('seeds') || '').split(',')
  ]
    .map((seed) => seed.trim())
    .filter(Boolean);
  const limit = Number(searchParams.get('limit') || '80');
  const hops = Number(searchParams.get('hops') || '1');
  const relations = (searchParams.get('relations') || '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const types = (searchParams.get('types') || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const q = searchParams.get('q') || '';

  try {
    if (mode === 'search') {
      return NextResponse.json({ seeds: await searchGraphSeeds(q, Number.isFinite(limit) ? limit : 20) });
    }
    if (mode === 'terms') {
      const yearFrom = Number(searchParams.get('yearFrom') || '');
      const yearTo = Number(searchParams.get('yearTo') || '');
      const minCount = Number(searchParams.get('minCount') || '1');
      return NextResponse.json(await fetchTermCooccurrenceGraph(
        q,
        Number.isFinite(limit) ? limit : 100,
        Number.isFinite(yearFrom) && yearFrom > 0 ? yearFrom : undefined,
        Number.isFinite(yearTo) && yearTo > 0 ? yearTo : undefined,
        Number.isFinite(minCount) ? minCount : 1
      ));
    }
    if (mode === 'path') {
      const from = searchParams.get('from') || seeds[0] || '';
      const to = searchParams.get('to') || seeds[1] || '';
      const result = await shortestPathBetween(from, to, Number.isFinite(hops) ? hops : 3, Number.isFinite(limit) ? limit : 200);
      return NextResponse.json(result);
    }
    if (mode === 'community') {
      const result = await communitySummary(seeds, Number.isFinite(hops) ? hops : 2, Number.isFinite(limit) ? limit : 150);
      return NextResponse.json(result);
    }
    if (mode === 'papers') {
      const nodeKey = searchParams.get('node') || seeds[0] || '';
      const label = searchParams.get('label') || '';
      const page = Number(searchParams.get('page') || '1');
      const pageSize = Number(searchParams.get('pageSize') || '8');
      if (!nodeKey) return NextResponse.json({ error: '缺少图谱节点参数' }, { status: 400 });
      return NextResponse.json(await findPapersForGraphNode(nodeKey, page, pageSize, label));
    }

    const graph = await fetchGraphRelations(seeds, {
      hops: Number.isFinite(hops) ? hops : 1,
      limit: Number.isFinite(limit) ? limit : 80,
      relations: relations.length ? relations : undefined,
      types: types.length ? types : undefined
    });
    return NextResponse.json(graph);
  } catch (error) {
    const message = error instanceof Error ? error.message : '图谱关系加载失败';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
