import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { mgplanConfigDir, mgplanOutputDir, safeMgplanFilePath } from '@/lib/scheme-solve/mgplan-case';
import { assertSchemeOwner, getSchemeIdea } from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const MIME: Record<string, string> = {
  '.csv': 'text/csv; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertSchemeOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '方案不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该方案。' }, { status: 403 });
  const url = new URL(request.url);
  const ideaId = url.searchParams.get('ideaId')?.trim() || '';
  const name = url.searchParams.get('name')?.trim() || '';
  const scope = url.searchParams.get('scope') === 'config' ? 'config' : 'output';
  if (!ideaId || !name) return NextResponse.json({ error: '缺少 ideaId 或 name。' }, { status: 422 });
  const idea = await getSchemeIdea(ideaId);
  if (!idea || idea.sessionId !== id) return NextResponse.json({ error: '想法不存在。' }, { status: 404 });
  try {
    const root = scope === 'config' ? mgplanConfigDir(id, ideaId) : mgplanOutputDir(id, ideaId);
    const filePath = safeMgplanFilePath(root, name);
    const bytes = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    return new NextResponse(bytes, {
      headers: {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Content-Disposition': `inline; filename="${path.basename(filePath)}"`,
        'Cache-Control': 'private, max-age=60',
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '文件不可用。' },
      { status: 404 }
    );
  }
}
