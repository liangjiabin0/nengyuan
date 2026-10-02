import { requireUser } from '@/lib/auth/request';
import { createChatLiveResponse } from '@/lib/chat-live-stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 18000;

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const userId = auth.user!.id;
  const rawAfter = new URL(request.url).searchParams.get('after');
  const requestedAfter = rawAfter == null ? NaN : Number(rawAfter);
  const afterSeq = Number.isFinite(requestedAfter)
    ? Math.max(0, Math.floor(requestedAfter))
    : null;

  return createChatLiveResponse({
    request,
    userId,
    requestedAfter: afterSeq,
    reauthorize: async () => {
      const current = await requireUser(request);
      return !current.error && current.user?.id === userId;
    }
  });
}
