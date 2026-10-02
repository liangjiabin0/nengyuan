import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { listGridGuideFileTree } from '@/lib/grid-guide/files';
import { assertGridGuideOwner, getGridGuideProject } from '@/lib/grid-guide/store';
import { assessTaskDeliverables, resolveTaskFolderName } from '@/lib/grid-guide/workspace';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertGridGuideOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '项目指南不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目指南。' }, { status: 403 });
  const project = await getGridGuideProject(id);
  if (!project) return NextResponse.json({ error: '项目指南不存在。' }, { status: 404 });
  const taskFolder = resolveTaskFolderName(id, project.taskFolder);
  const assessment = assessTaskDeliverables(id, taskFolder);
  return NextResponse.json({
    tree: listGridGuideFileTree(id),
    taskFolder: taskFolder || null,
    fileCount: assessment.fileCount,
    hasWorkspace: project.hasWorkspace
  });
}
