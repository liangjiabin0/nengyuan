import { requireUser } from '@/lib/auth/request';
import { NextResponse } from 'next/server';
import { readDbSummary } from '@/lib/db-summary';
import { answerDatavDcQuery } from '@/lib/datav-screen';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string; snapshot: string }> };

async function handle(request: Request, _context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  let query = '';
  if (request.method === 'POST') {
    const body = (await request.json().catch(() => null)) as { query?: unknown } | null;
    query = typeof body?.query === 'string' ? body.query : '';
  } else {
    query = new URL(request.url).searchParams.get('query') || '';
  }
  const url = new URL(request.url);
  const forwardedProto = request.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  const protocol = forwardedProto === 'https' ? 'https:' : url.protocol;
  const origin = new URL(`${protocol}//${request.headers.get('host') || url.host}`).origin;
  return NextResponse.json(await answerDatavDcQuery(query, readDbSummary(), origin), {
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
