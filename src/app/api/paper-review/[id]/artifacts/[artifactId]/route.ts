import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { isAdminUser } from '@/lib/auth';
import { requireUser } from '@/lib/auth/request';
import { refreshArtifacts } from '@/lib/paper-review/runner';
import { assertPaperReviewOwner, getPaperReviewTask } from '@/lib/paper-review/store';
import { resolveInTask } from '@/lib/paper-review/workspace';

export const runtime = 'nodejs';
type Context = { params: Promise<{ id: string; artifactId: string }> };

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip'
};

/** 预览/下载单个产物。?mode=preview 时 DOCX 转 HTML、文本类返回文本；其余流式下载。 */
export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id, artifactId } = await context.params;
  const own = await assertPaperReviewOwner(id, auth.user!.id, isAdminUser(auth.user));
  if (!own.exists) return NextResponse.json({ error: '任务不存在' }, { status: 404 });
  if (!own.allowed) return NextResponse.json({ error: '无权访问该任务' }, { status: 403 });
  let task = own.task!;
  let artifact = task.artifacts.find((a) => a.id === artifactId);
  if (!artifact) {
    await refreshArtifacts(id);
    task = (await getPaperReviewTask(id))!;
    artifact = task.artifacts.find((a) => a.id === artifactId);
  }
  if (!artifact) return NextResponse.json({ error: '文件不存在' }, { status: 404 });
  let file: string;
  try {
    file = resolveInTask(id, artifact.path);
  } catch {
    return NextResponse.json({ error: '路径不合法' }, { status: 400 });
  }
  if (!fs.existsSync(file)) return NextResponse.json({ error: '文件已被删除' }, { status: 404 });
  const ext = path.extname(file).toLowerCase();
  const mode = new URL(request.url).searchParams.get('mode');
  if (mode === 'preview') {
    if (ext === '.docx') {
      const mammoth = await import('mammoth');
      const html = (await mammoth.convertToHtml({ buffer: fs.readFileSync(file) })).value;
      return NextResponse.json({ kind: 'html', html });
    }
    if (['.json', '.csv', '.md', '.log', '.txt'].includes(ext)) {
      return NextResponse.json({ kind: 'text', text: fs.readFileSync(file, 'utf8').slice(0, 500_000) });
    }
  }
  const stat = fs.statSync(file);
  const name = path.basename(file);
  const inline = mode === 'preview' && ['.png', '.jpg', '.svg'].includes(ext);
  const headers: Record<string, string> = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`
  };
  // SVG 内联预览时禁止执行脚本
  if (ext === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  return new NextResponse(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, { headers });
}
