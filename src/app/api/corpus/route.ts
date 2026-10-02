import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import {
  CORPUS_BROWSE_DOMAINS,
  isCorpusBrowseDomain,
  listCorpusBrowseFiles
} from '@/lib/corpus/browse';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;

  const { searchParams } = new URL(request.url);
  const domain = searchParams.get('domain') || 'papers';
  if (!isCorpusBrowseDomain(domain)) {
    return jsonError(`不支持的语料分域。可选：${CORPUS_BROWSE_DOMAINS.join(', ')}`);
  }

  const page = Math.max(1, Number(searchParams.get('page') || '1') || 1);
  const pageSize = Math.min(100, Math.max(5, Number(searchParams.get('pageSize') || '20') || 20));

  try {
    const result = listCorpusBrowseFiles(domain, page, pageSize);
    return NextResponse.json({
      domain,
      domains: CORPUS_BROWSE_DOMAINS,
      ...result
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '列举语料文件失败。', 500);
  }
}
