import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import { listGridGuideAttachments } from '@/lib/grid-guide/attachments';
import { resumeGridGuideTask } from '@/lib/grid-guide/runner';
import {
  assertGridGuideOwner,
  deleteGridGuideProject,
  getGridGuideProject,
  updateGridGuideText,
  updateGridGuideTexts
} from '@/lib/grid-guide/store';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };
const pathSchema = z.array(z.union([z.string().min(1).max(80), z.number().int().nonnegative()])).min(1).max(8);
const singleEditSchema = z.object({
  path: pathSchema,
  value: z.string().trim().min(1).max(30_000)
}).strict();
const editSchema = z.union([
  singleEditSchema,
  z.object({
    edits: z.array(singleEditSchema).min(1).max(120)
  }).strict()
]);

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
  void resumeGridGuideTask(id);
  const project = await getGridGuideProject(id);
  if (!project) return NextResponse.json({ error: '项目指南不存在。' }, { status: 404 });
  const attachments = await listGridGuideAttachments(id);
  return NextResponse.json({ project: { ...project, attachments } });
}

export async function DELETE(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const project = await getGridGuideProject(id);
  if (project?.status === 'generating') {
    return NextResponse.json({ error: '指南正在生成，暂时不能删除。' }, { status: 409 });
  }
  await deleteGridGuideProject(id);
  return NextResponse.json({ ok: true });
}

export async function PATCH(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const error = await ownerError(id, auth.user!.id);
  if (error) return error;
  const project = await getGridGuideProject(id);
  // 局部修订期间允许编辑未锁定字段；完整生成中仍禁止。
  if (project?.status === 'generating' && !project.document) {
    return NextResponse.json({ error: '本轮修改仍在进行，请稍候再直接编辑。' }, { status: 409 });
  }
  const parsed = editSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: '编辑内容或位置无效。' }, { status: 422 });
  }
  try {
    const payload = parsed.data;
    const projectResult = 'edits' in payload
      ? await updateGridGuideTexts(id, payload.edits)
      : await updateGridGuideText(id, payload.path, payload.value);
    return NextResponse.json({ project: projectResult });
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : '保存编辑失败。' },
      { status: 422 }
    );
  }
}
