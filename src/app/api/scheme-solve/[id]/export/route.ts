import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { buildSchemeIdeaExport, buildSchemeSessionZip } from '@/lib/scheme-solve/export';
import { assertSchemeOwner } from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';
export const maxDuration = 120;

type Context = { params: Promise<{ id: string }> };

function contentDisposition(fileName: string) {
  return `attachment; filename="scheme-report.bin"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export async function POST(request: Request, context: Context) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { id } = await context.params;
    const ownership = await assertSchemeOwner(id, auth.user!.id);
    if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
    if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });

    const body = await request.json().catch(() => ({}));
    const ideaId = String(body?.ideaId || '').trim();
    const result = ideaId
      ? await buildSchemeIdeaExport(id, ideaId)
      : await buildSchemeSessionZip(id);
    const type = result.fileName.endsWith('.zip')
      ? 'application/zip'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    return new NextResponse(new Uint8Array(result.bytes), {
      headers: {
        'Content-Type': type,
        'Content-Disposition': contentDisposition(result.fileName),
        'Cache-Control': 'no-store'
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '导出失败。' },
      { status: 422 }
    );
  }
}
