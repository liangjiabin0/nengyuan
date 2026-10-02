import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { buildGridGuideDocx, gridGuideFileName } from '@/lib/grid-guide/export';
import { readGridGuideBinaryFile, toWorkspaceRelative, zipGridGuideWorkspace } from '@/lib/grid-guide/files';
import { assertGridGuideOwner, getGridGuideProject } from '@/lib/grid-guide/store';
import { findGuideDocx, gridGuideTaskDirectory } from '@/lib/grid-guide/workspace';

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

  const url = new URL(request.url);
  const filePath = url.searchParams.get('path') || '';
  const pack = url.searchParams.get('pack') !== '0';
  const guideOnly = url.searchParams.get('guide') === '1';

  try {
    if (filePath) {
      const file = readGridGuideBinaryFile(id, filePath);
      const name = file.relative.split('/').pop() || 'file';
      return new NextResponse(new Uint8Array(file.buffer), {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Content-Length': String(file.buffer.length)
        }
      });
    }

    if (project.hasWorkspace && (pack || !project.document)) {
      if (guideOnly) {
        const taskDir = gridGuideTaskDirectory(id, project.taskFolder);
        const docx = taskDir ? findGuideDocx(taskDir) : null;
        if (docx) {
          const file = readGridGuideBinaryFile(id, toWorkspaceRelative(id, docx));
          const name = file.relative.split('/').pop() || '指南建议稿.docx';
          return new NextResponse(new Uint8Array(file.buffer), {
            headers: {
              'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
              'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
              'Content-Length': String(file.buffer.length)
            }
          });
        }
      }
      const buffer = await zipGridGuideWorkspace(id, project.taskFolder);
      const fileName = `${project.taskFolder || project.title || '国网指南成果'}.zip`;
      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Content-Length': String(buffer.length)
        }
      });
    }

    if (!project.document) {
      return NextResponse.json({ error: '项目指南尚未生成。' }, { status: 409 });
    }
    const buffer = await buildGridGuideDocx(project.document);
    const fileName = gridGuideFileName(project.document.projectTitle);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Content-Length': String(buffer.length)
      }
    });
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : '导出失败。' },
      { status: 422 }
    );
  }
}
