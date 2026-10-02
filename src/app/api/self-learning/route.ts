import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import {
  deleteUserLearningMemory,
  listUserLearningDomains,
  listUserLearningMemories,
  setUserLearningMemoryPinned
} from '@/lib/self-learning';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const domain = new URL(request.url).searchParams.get('domain')?.trim() || '';
  const [domains, memories] = await Promise.all([
    listUserLearningDomains(auth.user!.id),
    listUserLearningMemories(auth.user!.id, domain || undefined)
  ]);
  return NextResponse.json({ domains, memories });
}

/** 【按线上版本补回】钉住 / 取消钉住一条记忆。 */
export async function PATCH(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => null) as { id?: unknown; pinned?: unknown } | null;
  const id = String(body?.id || '').trim();
  if (!id || typeof body?.pinned !== 'boolean') return jsonError('缺少记忆 ID 或钉住状态。');
  const result = await setUserLearningMemoryPinned(auth.user!.id, id, body.pinned);
  if (!result.ok) return jsonError(result.error, result.missing ? 404 : 400);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const id = new URL(request.url).searchParams.get('id')?.trim() || '';
  if (!id) return jsonError('缺少记忆 ID。');
  const deleted = await deleteUserLearningMemory(auth.user!.id, id);
  if (!deleted) return jsonError('记忆不存在或无权删除。', 404);
  return NextResponse.json({ ok: true });
}
