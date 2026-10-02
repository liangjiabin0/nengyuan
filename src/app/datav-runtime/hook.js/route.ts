import { NextResponse } from 'next/server';
import { wrapDatavCubeHook } from '@/lib/datav-screen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return new NextResponse(wrapDatavCubeHook(), {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}
