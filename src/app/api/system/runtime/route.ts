import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { collectRuntimeSnapshot } from '@/lib/system-runtime';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const snapshot = await collectRuntimeSnapshot();
  return NextResponse.json(snapshot);
}
