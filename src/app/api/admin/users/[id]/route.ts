import { NextResponse } from 'next/server';
import { requireAdmin, toPublicUser } from '@/lib/auth/request';
import { deleteSessionsForUser } from '@/lib/auth/session';
import { deleteUser, updateUserPassword, updateUserRole } from '@/lib/auth/users';

export const runtime = 'nodejs';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const password = body?.password != null ? String(body.password) : '';
  const hasRole = body?.role === 'admin' || body?.role === 'user';

  if (!password && !hasRole) {
    return NextResponse.json({ error: '请提供新密码或角色。' }, { status: 400 });
  }

  try {
    let user = null;
    const messages: string[] = [];

    if (hasRole) {
      if (auth.user?.id === id && body.role === 'user') {
        return NextResponse.json({ error: '不能将当前登录账号降为普通用户。' }, { status: 400 });
      }
      user = await updateUserRole(id, body.role);
      messages.push('角色已更新');
    }

    if (password) {
      user = await updateUserPassword(id, password);
      await deleteSessionsForUser(id);
      messages.push('密码已更新，该用户需重新登录');
    }

    return NextResponse.json({
      user: user ? toPublicUser(user, false) : null,
      message: `${messages.join('；')}。`
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '更新失败。' },
      { status: 400 }
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;

  const { id } = await params;
  try {
    const user = await deleteUser(id, { actorId: auth.user?.id });
    await deleteSessionsForUser(id);
    return NextResponse.json({
      deletedId: user.id,
      message: `已删除账号「${user.username}」。`
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '删除失败。' },
      { status: 400 }
    );
  }
}
