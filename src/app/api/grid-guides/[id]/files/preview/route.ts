import { NextResponse } from 'next/server';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';
import { requireUser } from '@/lib/auth/request';
import {
  gridGuideFileExtension,
  isImageGridGuideFile,
  isTextGridGuideFile,
  readGridGuideBinaryFile,
  readGridGuideTextFile
} from '@/lib/grid-guide/files';
import { assertGridGuideOwner } from '@/lib/grid-guide/store';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string }> };

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertGridGuideOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '项目指南不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目指南。' }, { status: 403 });

  const relative = new URL(request.url).searchParams.get('path') || '';
  const raw = new URL(request.url).searchParams.get('raw') === '1';
  try {
    const extension = gridGuideFileExtension(relative);
    if (isTextGridGuideFile(relative)) {
      const content = readGridGuideTextFile(id, relative);
      return NextResponse.json({ kind: 'text', path: relative, content, extension });
    }
    const file = readGridGuideBinaryFile(id, relative);
    if (raw || extension === '.pdf' || isImageGridGuideFile(relative)) {
      return new NextResponse(new Uint8Array(file.buffer), {
        headers: {
          'Content-Type': MIME[extension] || 'application/octet-stream',
          'Content-Length': String(file.buffer.length),
          'Cache-Control': 'private, max-age=30'
        }
      });
    }
    if (extension === '.docx') {
      const result = await mammoth.convertToHtml({ buffer: file.buffer });
      return NextResponse.json({ kind: 'docx', path: relative, html: result.value });
    }
    if (extension === '.xlsx' || extension === '.xls') {
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const sheets = workbook.SheetNames.slice(0, 8).map((name) => {
        const sheet = workbook.Sheets[name];
        const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false }) as string[][];
        return { name, rows: rows.slice(0, 200) };
      });
      return NextResponse.json({ kind: 'xlsx', path: relative, sheets });
    }
    return NextResponse.json({ kind: 'binary', path: relative, extension });
  } catch (reason) {
    return NextResponse.json(
      { error: reason instanceof Error ? reason.message : '预览失败。' },
      { status: 422 }
    );
  }
}
