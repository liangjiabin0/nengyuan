import { NextResponse } from 'next/server';
import { requireAdmin, toPublicUser } from '@/lib/auth/request';
import { deleteSessionsForUser } from '@/lib/auth/session';
import { createUser, deleteUsers, listUsers, updateUsersRole } from '@/lib/auth/users';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  return NextResponse.json({
    users: (await listUsers()).map((user) => toPublicUser(user, false))
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}));
  try {
    const user = await createUser({
      username: String(body?.username || ''),
      password: String(body?.password || ''),
      role: body?.role === 'admin' ? 'admin' : 'user'
    });
    return NextResponse.json({ user: toPublicUser(user, false) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '创建用户失败。' },
      { status: 400 }
    );
  }
}

export async function PATCH(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids) ? body.ids.map((id: unknown) => String(id || '')) : [];
  const role = body?.role === 'admin' ? 'admin' : body?.role === 'user' ? 'user' : null;
  if (!role) {
    return NextResponse.json({ error: '请指定角色。' }, { status: 400 });
  }

  try {
    const result = await updateUsersRole(ids, role, { actorId: auth.user?.id });
    return NextResponse.json({
      users: result.updated.map((user) => toPublicUser(user, false)),
      warnings: result.errors,
      message: `已更新 ${result.updated.length} 个账号角色。`
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '批量更新角色失败。' },
      { status: 400 }
    );
  }
}

export async function DELETE(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids) ? body.ids.map((id: unknown) => String(id || '')) : [];

  try {
    const result = await deleteUsers(ids, { actorId: auth.user?.id });
    for (const user of result.deleted) {
      await deleteSessionsForUser(user.id);
    }
    return NextResponse.json({
      deletedIds: result.deleted.map((user) => user.id),
      warnings: result.errors,
      message: `已删除 ${result.deleted.length} 个账号。`
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '批量删除失败。' },
      { status: 400 }
    );
  }
}
