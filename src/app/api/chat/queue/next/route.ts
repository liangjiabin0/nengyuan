import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { peekNextUserSendTurn } from '@/lib/chat-send-queue-store';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null) as { conversationId?: string } | null;
  const conversationId = String(body?.conversationId || '').trim();
  if (!conversationId) return jsonError('缺少会话。');
  const item = await peekNextUserSendTurn(auth.user!.id, conversationId);
  return NextResponse.json({ item });
}
