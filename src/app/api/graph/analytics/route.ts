import { NextResponse } from 'next/server';
import {
  getAuthorAnalytics,
  getBurstAnalytics,
  getTeamAnalytics,
  getTimelineAnalytics,
  type AnalyticsOptions
} from '@/lib/research-analytics';
import { requireUser } from '@/lib/auth/request';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const params = new URL(request.url).searchParams;
  const mode = params.get('mode') || 'timeline';
  const numberParam = (name: string) => {
    const value = Number(params.get(name));
    return Number.isFinite(value) && value > 0 ? value : undefined;
  };
  const options: AnalyticsOptions = {
    query: params.get('q') || '',
    yearFrom: numberParam('yearFrom'),
    yearTo: numberParam('yearTo'),
    limit: numberParam('limit'),
    minCount: numberParam('minCount'),
    minTeamSize: numberParam('minTeamSize'),
    refresh: params.get('refresh') === '1'
  };

  try {
    if (mode === 'timeline') return NextResponse.json(await getTimelineAnalytics(options));
    if (mode === 'bursts') return NextResponse.json(await getBurstAnalytics(options));
    if (mode === 'authors') return NextResponse.json(await getAuthorAnalytics(options));
    if (mode === 'teams') return NextResponse.json(await getTeamAnalytics(options));
    return NextResponse.json({ error: `不支持的分析模式：${mode}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '科研分析加载失败' },
      { status: 500 }
    );
  }
}
