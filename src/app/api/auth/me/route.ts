import { NextResponse } from 'next/server';
import { resolveRequestUser, toPublicUser } from '@/lib/auth/request';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { user, localAdmin } = await resolveRequestUser(request);
  if (!user) {
    return NextResponse.json({ authenticated: false, user: null, localAdmin: false });
  }
  return NextResponse.json({
    authenticated: true,
    user: toPublicUser(user, localAdmin),
    localAdmin
  });
}
