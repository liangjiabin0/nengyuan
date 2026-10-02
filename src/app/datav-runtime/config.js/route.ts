import { NextResponse } from 'next/server';
import { readDbSummary } from '@/lib/db-summary';
import { buildDatavScreenConfig, wrapDatavCubeConfig } from '@/lib/datav-screen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(wrapDatavCubeConfig(buildDatavScreenConfig(readDbSummary())), {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
