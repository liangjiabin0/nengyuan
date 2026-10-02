import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { readCorpusBrowseFile } from '@/lib/corpus/browse';
import {
  extractFrontmatterField,
  listCorpusComments,
  stripCorpusCommentsBlock
} from '@/lib/corpus/comments';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const relativePath = (searchParams.get('path') || '').trim();
  if (!relativePath) return jsonError('缺少 path 参数。');

  try {
    const file = readCorpusBrowseFile(relativePath);
    if (!file) return jsonError('文件不存在或不在允许的语料分域内。', 404);
    const recordKey = extractFrontmatterField(file.content, 'record_key');
    const comments = await listCorpusComments({
      relativePath: file.relativePath,
      recordKey
    });
    return NextResponse.json({
      ...file,
      content: stripCorpusCommentsBlock(file.content),
      recordKey,
      comments
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '读取语料文件失败。', 500);
  }
}
