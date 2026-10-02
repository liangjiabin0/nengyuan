import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { readCorpusBrowseFile, resolveCorpusBrowsePath } from '@/lib/corpus/browse';
import {
  createCorpusComment,
  extractFrontmatterField,
  listCorpusComments
} from '@/lib/corpus/comments';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const relativePath = (searchParams.get('path') || '').trim();
  const recordKey = (searchParams.get('recordKey') || '').trim();
  if (!relativePath && !recordKey) return jsonError('缺少 path 或 recordKey 参数。');

  try {
    const comments = await listCorpusComments({ relativePath, recordKey });
    return NextResponse.json({ comments });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '读取备注失败。', 500);
  }
}

export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;

  try {
    const payload = (await request.json()) as {
      path?: string;
      body?: string;
      authorName?: string;
    };
    const relativePath = String(payload.path || '').trim();
    const resolved = resolveCorpusBrowsePath(relativePath);
    if (!resolved) return jsonError('文件不存在或不在允许的语料分域内。', 404);

    const file = readCorpusBrowseFile(relativePath);
    const recordKey = file ? extractFrontmatterField(file.content, 'record_key') : '';
    const comment = await createCorpusComment({
      relativePath: resolved.relativePath,
      recordKey,
      domain: resolved.domain,
      body: String(payload.body || ''),
      userId: auth.user!.id,
      authorName: String(payload.authorName || auth.user!.username || '').trim()
    });
    const comments = await listCorpusComments({
      relativePath: resolved.relativePath,
      recordKey
    });
    return NextResponse.json({ comment, comments }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '发表备注失败。', 400);
  }
}
