import path from 'node:path';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { assertConversationOwner, type ConversationKind } from '@/lib/chat-history';
import { readOpenCodeSessionContextUsage } from '@/lib/opencode/runtime';
import { RESEARCH_REVIEW_SESSION_MAP } from '@/lib/research-review/constants';

function normalizeKind(value: string | null): ConversationKind {
  if (value === 'research-review') return 'research-review';
  return 'chat';
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const params = new URL(request.url).searchParams;
  const conversationId = params.get('conversationId')?.trim() || '';
  if (!conversationId) return NextResponse.json({ usage: null });

  const kind = normalizeKind(params.get('kind'));
  const ownership = await assertConversationOwner(conversationId, auth.user!.id, kind);
  if (!ownership.conversation) return NextResponse.json({ error: '会话不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该会话。' }, { status: 403 });

  const usage = await readOpenCodeSessionContextUsage(conversationId, kind === 'research-review'
    ? {
        sessionMapFile: RESEARCH_REVIEW_SESSION_MAP,
        workingDirectory: path.join(process.cwd(), 'storage', 'research-review', conversationId)
      }
    : {
        workingDirectory: path.join(process.cwd(), 'storage', 'chat-workspaces', conversationId)
      });
  // 【按线上版本补回】读取用量期间会话可能被删除或转移，返回前再校验一次归属。
  const currentOwnership = await assertConversationOwner(conversationId, auth.user!.id, kind);
  if (!currentOwnership.conversation || !currentOwnership.allowed) {
    return NextResponse.json(
      { error: '会话状态已发生变化，请刷新后重试。' },
      { status: 409 }
    );
  }
  return NextResponse.json({ usage }, {
    headers: { 'Cache-Control': 'private, no-store' }
  });
}
