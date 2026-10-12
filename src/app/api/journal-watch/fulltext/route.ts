import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { get } from '@/lib/db';
import { attachFulltext, fulltextDirectory, fulltextFileName } from '@/lib/journal-watch/run';
import { normalizeDoi } from '@/lib/journal-watch/sources';

const MAX_PDF_BYTES = 100 * 1024 * 1024;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** 上传某篇文章的全文 PDF（用户从机构账号手动下载后上传），入库并替换摘要记录。 */
export async function POST(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  try {
    const formData = await request.formData();
    const doi = normalizeDoi(formData.get('doi'));
    const file = formData.get('file');
    if (!doi) return jsonError('缺少 DOI。');
    if (!(file instanceof File)) return jsonError('请选择 PDF 文件。');
    if (file.size > MAX_PDF_BYTES) return jsonError('PDF 超过 100 MB。', 413);
    const article = await get<{ journal_code: string }>('SELECT journal_code FROM journal_watch_articles WHERE doi = ?', [doi]);
    if (!article) return jsonError('期刊追踪里没有这篇文章。', 404);

    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') return jsonError('文件不是 PDF。');
    const dir = await fulltextDirectory(article.journal_code);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fulltextFileName(doi)), bytes);

    const result = await attachFulltext(doi);
    return NextResponse.json({ ok: true, paperKey: result.paperKey });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '上传全文失败。', 500);
  }
}
