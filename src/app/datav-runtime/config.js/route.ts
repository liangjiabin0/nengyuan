import { requireUser } from '@/lib/auth/request';
import { NextResponse } from 'next/server';
import { readDbSummary } from '@/lib/db-summary';
import { buildDatavScreenConfig, wrapDatavCubeConfig } from '@/lib/datav-screen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  return new NextResponse(wrapDatavCubeConfig(buildDatavScreenConfig(readDbSummary())), {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
