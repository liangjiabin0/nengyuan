import { NextResponse } from 'next/server';
import { readDbSummary } from '@/lib/db-summary';
import { answerDatavDcQuery } from '@/lib/datav-screen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; snapshot: string }> };

async function handle(request: Request, _context: Context) {
  let query = '';
  if (request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { query?: unknown } | null;
    query = typeof body?.query === 'string' ? body.query : '';
  } else {
    query = new URL(request.url).searchParams.get('query') || '';
  }
  return NextResponse.json(await answerDatavDcQuery(query, readDbSummary()), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

export async function POST(request: Request, context: Context) {
  return handle(request, context);
}

export async function GET(request: Request, context: Context) {
  return handle(request, context);
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}
