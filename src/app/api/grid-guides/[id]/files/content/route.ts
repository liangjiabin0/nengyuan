import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import { readGridGuideTextFile, writeGridGuideTextFile } from '@/lib/grid-guide/files';
import { assertGridGuideOwner } from '@/lib/grid-guide/store';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

async function ownerError(id: string, userId: string) {
  const ownership = await assertGridGuideOwner(id, userId);
  if (!ownership.exists) return NextResponse.json({ error: '项目指南不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目指南。' }, { status: 403 });
  return null;
}

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const relative = new URL(request.url).searchParams.get('path') || '';
  try {
    const content = readGridGuideTextFile(id, relative);
    return NextResponse.json({ path: relative, content });
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : '读取文件失败。' },
      { status: 422 }
    );
  }
}

const putSchema = z.object({
  path: z.string().trim().min(1).max(500),
  content: z.string().min(1).max(1_500_000)
}).strict();

export async function PUT(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const parsed = putSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '保存内容无效。' }, { status: 422 });
  }
  try {
    const saved = writeGridGuideTextFile(id, parsed.data.path, parsed.data.content);
    return NextResponse.json({ ok: true, ...saved });
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : '保存文件失败。' },
      { status: 422 }
    );
  }
}
