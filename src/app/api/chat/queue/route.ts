import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { enqueueUserSendTurn, listUserSendQueue } from '@/lib/chat-send-queue-store';
import { publishChatLive } from '@/lib/chat-live';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const conversationId = new URL(request.url).searchParams.get('conversationId')?.trim() || '';
  const items = await listUserSendQueue(auth.user!.id, conversationId || undefined);
  return NextResponse.json({ items });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null) as {
    id?: string;
    conversationId?: string;
    question?: string;
    attachmentIds?: string[];
  } | null;
  const conversationId = String(body?.conversationId || '').trim();
  if (!conversationId) return jsonError('缺少会话。');
  const result = await enqueueUserSendTurn({
    id: body?.id,
    userId: auth.user!.id,
    conversationId,
    question: String(body?.question || ''),
    attachmentIds: Array.isArray(body?.attachmentIds) ? body.attachmentIds : []
  });
  if (!result.ok) return jsonError(result.error, result.status);
  await publishChatLive(auth.user!.id, {
    type: 'list',
    conversationId,
    event: { resource: 'send-queue' }
  });
  return NextResponse.json({ item: result.item });
}
