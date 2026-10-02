import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { resolveDataSubdirs } from '@/lib/data-dirs';
import { ingestPaperDirectory, ingestPaperFile, listPaperFiles } from '@/lib/papers';
import { getIndexStats } from '@/lib/search-index';
import { requireAdmin, requireUser } from '@/lib/auth/request';

function jsonError(message: string, status = 500, detail?: unknown) {
  return NextResponse.json(
    { error: message, detail: detail instanceof Error ? detail.message : detail },
    { status }
  );
}

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const { searchParams } = new URL(request.url);
    const dir = searchParams.get('dir') || resolveDataSubdirs(config.dataRootDir).papers;
    const files = listPaperFiles(dir);
    return NextResponse.json({
      dir,
      files: files.length,
      sample: files.slice(0, 30),
      index: await getIndexStats()
    });
  } catch (error) {
    return jsonError('扫描论文目录失败。', 500, error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
    const body = await request.json().catch(() => ({}));
    const filePath = typeof body.filePath === 'string' ? body.filePath : '';
    const dir =
      typeof body.dir === 'string' ? body.dir : resolveDataSubdirs(config.dataRootDir).papers;

    if (filePath) {
      return NextResponse.json({
        result: await ingestPaperFile(filePath),
        index: await getIndexStats()
      });
    }

    return NextResponse.json({
      result: await ingestPaperDirectory(dir),
      index: await getIndexStats()
    });
  } catch (error) {
    return jsonError('导入论文失败。', 500, error);
  }
}
