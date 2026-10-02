import { NextResponse } from 'next/server';
import {
  requireUser,
  setSessionCookie,
  toPublicUser
} from '@/lib/auth/request';
import { createSession, deleteSessionsForUser } from '@/lib/auth/session';
import { changeOwnPassword } from '@/lib/auth/users';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;

  const body = await request.json().catch(() => ({}));
  const currentPassword = String(body?.currentPassword || '');
  const newPassword = String(body?.newPassword || '');
  const confirmPassword = String(body?.confirmPassword || '');

  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: '请填写当前密码和新密码。' }, { status: 400 });
  }
  if (confirmPassword && confirmPassword !== newPassword) {
    return NextResponse.json({ error: '两次输入的新密码不一致。' }, { status: 400 });
  }

  try {
    const user = await changeOwnPassword(auth.user!.id, currentPassword, newPassword);
    await deleteSessionsForUser(user.id);

    const response = NextResponse.json({
      user: toPublicUser(user, auth.localAdmin),
      localAdmin: auth.localAdmin,
      message: auth.localAdmin
        ? '密码已更新。局域网登录时请使用新密码。'
        : '密码已更新。'
    });

    // 本机环回不依赖 cookie；普通登录则签发新会话，避免把自己踢下线
    if (!auth.localAdmin) {
      const token = await createSession(user.id);
      setSessionCookie(response, token);
    }

    return response;
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '修改密码失败。' },
      { status: 400 }
    );
  }
}
