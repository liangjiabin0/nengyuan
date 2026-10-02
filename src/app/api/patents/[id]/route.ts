import { NextResponse } from 'next/server';
import {
  assertPatentProjectOwner,
  deletePatentProject,
  getPatentProject,
  toPatentClientProject,
  updatePatentProject
} from '@/lib/patent-generation/store';
import { requireUser } from '@/lib/auth/request';
import { getLatestPatentRun } from '@/lib/patent-generation/run-store';
import { z } from 'zod';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const patchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  applicant: z.string().trim().max(300).optional(),
  inventors: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  contact: z.record(z.string(), z.string().max(500)).optional(),
  answers: z.record(z.string().max(160), z.string().max(20_000)).optional()
}).strict();

function errorResponse(error: unknown, status = 400) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : '专利项目操作失败。' },
    { status }
  );
}

export async function GET(request: Request, context: Context) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { id } = await context.params;
    const ownership = await assertPatentProjectOwner(id, auth.user!.id);
    if (!ownership.project) return errorResponse(new Error('专利项目不存在。'), 404);
    if (!ownership.allowed) return errorResponse(new Error('无权访问该专利项目。'), 403);
    const project = await getPatentProject(id);
    if (!project) return errorResponse(new Error('专利项目不存在。'), 404);
    return NextResponse.json({ project: toPatentClientProject(project) });
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function PATCH(request: Request, context: Context) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { id } = await context.params;
    const ownership = await assertPatentProjectOwner(id, auth.user!.id);
    if (!ownership.project) return errorResponse(new Error('专利项目不存在。'), 404);
    if (!ownership.allowed) return errorResponse(new Error('无权访问该专利项目。'), 403);
    const activeRun = await getLatestPatentRun(id);
    if (activeRun && ['queued', 'running'].includes(activeRun.status)) {
      return errorResponse(new Error('项目正在生成，不能同时修改确认信息。'), 409);
    }
    const body = await request.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return errorResponse(new Error('请求数据格式或长度无效。'), 422);
    const project = await updatePatentProject(id, {
      title: parsed.data.title,
      applicant: parsed.data.applicant,
      inventors: parsed.data.inventors,
      contact: parsed.data.contact,
      answers: parsed.data.answers
    });
    return NextResponse.json({ project: toPatentClientProject(project) });
  } catch (error) {
    const status = error instanceof Error && /不存在/.test(error.message) ? 404 : 422;
    return errorResponse(error, status);
  }
}

export async function DELETE(request: Request, context: Context) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { id } = await context.params;
    const ownership = await assertPatentProjectOwner(id, auth.user!.id);
    if (!ownership.project) return errorResponse(new Error('专利项目不存在。'), 404);
    if (!ownership.allowed) return errorResponse(new Error('无权访问该专利项目。'), 403);
    const activeRun = await getLatestPatentRun(id);
    if (activeRun && ['queued', 'running'].includes(activeRun.status)) {
      return errorResponse(new Error('项目正在生成，请先取消任务再删除。'), 409);
    }
    await deletePatentProject(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, 500);
  }
}
