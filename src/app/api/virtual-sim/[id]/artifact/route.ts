import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { requireUser } from '@/lib/auth/request';
import {
  listLossPreviewFiles,
  lossPreviewFileUrl,
  safeLossOutputPath
} from '@/lib/scheme-solve/loss-outputs';
import { assertSchemeOwner, getSchemeIdea } from '@/lib/scheme-solve/store';
import { listIdeaReportFiles } from '@/lib/scheme-solve/workspace';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ id: string }> };

const KINDS = ['design', 'model', 'result', 'results', 'reviewSmall', 'reviewLarge', 'report'] as const;

const MIME: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xls': 'application/vnd.ms-excel',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8'
};

function contentDisposition(fileName: string, download: boolean) {
  const encoded = encodeURIComponent(fileName);
  const fallback = fileName.replace(/[^\x20-\x7E]/g, '_') || 'file';
  return `${download ? 'attachment' : 'inline'}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function rewriteHtmlReport(html: string, sessionId: string, ideaId: string) {
  return html.replace(/(src|href)=["'](?:\.\/)?(charts\/[^"']+)["']/gi, (_match, attr, relative) => {
    const url = lossPreviewFileUrl(sessionId, ideaId, String(relative).replace(/\\/g, '/'));
    return `${attr}="${url}"`;
  });
}

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '仿真任务不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该任务。' }, { status: 403 });

  const url = new URL(request.url);
  const ideaId = url.searchParams.get('ideaId')?.trim() || '';
  if (!ideaId) return NextResponse.json({ error: '缺少 ideaId。' }, { status: 422 });
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== id) return NextResponse.json({ error: '任务不存在。' }, { status: 404 });

  const fileName = url.searchParams.get('file')?.trim() || '';
  if (fileName) {
    try {
      const filePath = safeLossOutputPath(id, ideaId, fileName);
      const ext = path.extname(filePath).toLowerCase();
      const download = url.searchParams.get('download') === '1';
      if (url.searchParams.get('preview') === '1' && (ext === '.xlsx' || ext === '.xls')) {
        const workbook = XLSX.read(fs.readFileSync(filePath), { type: 'buffer' });
        const sheets = workbook.SheetNames.slice(0, 8).map((name) => {
          const sheet = workbook.Sheets[name];
          const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false }) as string[][];
          return { name, rows: rows.slice(0, 200) };
        });
        return NextResponse.json(
          { kind: 'xlsx', name: path.basename(filePath), sheets },
          { headers: { 'Cache-Control': 'private, no-store' } }
        );
      }
      let bytes = fs.readFileSync(filePath);
      if (!download && (ext === '.html' || ext === '.htm')) {
        bytes = Buffer.from(rewriteHtmlReport(bytes.toString('utf8'), id, ideaId), 'utf8');
      }
      return new NextResponse(new Uint8Array(bytes), {
        headers: {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Disposition': contentDisposition(path.basename(filePath), download),
          'Cache-Control': 'private, max-age=60',
          'X-Content-Type-Options': 'nosniff'
        }
      });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : '产物不可用。' },
        { status: 404 }
      );
    }
  }

  const files = listIdeaReportFiles(id, ideaId);
  const kind = url.searchParams.get('kind')?.trim() as (typeof KINDS)[number] | '';
  if (kind && KINDS.includes(kind)) {
    return NextResponse.json(
      { ideaId, kind, content: files[kind] || '' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const outputs = listLossPreviewFiles(id, ideaId).map((item) => ({
    ...item,
    previewUrl: lossPreviewFileUrl(id, ideaId, item.relative),
    downloadUrl: lossPreviewFileUrl(id, ideaId, item.relative, 'download=1')
  }));

  return NextResponse.json(
    {
      ideaId,
      title: idea.title,
      summary: idea.summary,
      decisions: idea.decisions,
      limits: idea.limits,
      goal: idea.goal,
      files,
      outputs
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
