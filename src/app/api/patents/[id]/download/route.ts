import { NextResponse } from 'next/server';
import { buildPatentExportBundle } from '@/lib/patent-generation/export';
import { assertPatentProjectOwner, getPatentProject } from '@/lib/patent-generation/store';
import { requireUser } from '@/lib/auth/request';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { id } = await context.params;
    const ownership = await assertPatentProjectOwner(id, auth.user!.id);
    if (!ownership.project) return NextResponse.json({ error: '专利项目不存在。' }, { status: 404 });
    if (!ownership.allowed) return NextResponse.json({ error: '无权访问该专利项目。' }, { status: 403 });
    const project = await getPatentProject(id);
    if (!project) return NextResponse.json({ error: '专利项目不存在。' }, { status: 404 });
    if (!project.draft) return NextResponse.json({ error: '专利草稿尚未生成。' }, { status: 409 });
    if (!['completed', 'review_required', 'ready'].includes(project.status)) {
      return NextResponse.json(
        { error: '当前草稿仍在生成或已失效，请等待任务结束后再下载。' },
        { status: 409 }
      );
    }
    const unresolvedIdentity = project.blockers.some(
      (item) => item.category === 'identity' && !item.resolved
    );
    if (unresolvedIdentity || !project.applicant.trim() || !project.inventors.length) {
      return NextResponse.json(
        { error: '申请人或发明人尚未确认，不能导出申请包。' },
        { status: 409 }
      );
    }
    const output = await buildPatentExportBundle(project);
    return new NextResponse(new Uint8Array(output.buffer), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(output.fileName)}`,
        'Content-Length': String(output.buffer.length),
        'X-Patent-Draft-Status': project.status,
        'X-Patent-Review-Required': String(
          project.status === 'review_required' || Boolean(project.audit && !project.audit.passed)
        )
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导出专利文件失败。' },
      { status: 500 }
    );
  }
}
