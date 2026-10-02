import fs from 'node:fs';
import path from 'node:path';
import { NextResponse } from 'next/server';
import { getBundleRoot } from '@/lib/bundle-store';
import { getDataRootDir } from '@/lib/config';
import { getIndexStats } from '@/lib/search-index';
import { exportRagPack } from '@/lib/ragpack/export';
import { importRagPack } from '@/lib/ragpack/import';
import {
  getActiveRagpackJob,
  getRagpackJobState,
  isRagpackJobRunning,
  resetRagpackJobState,
  setActiveRagpackJob,
  updateRagpackJobState
} from '@/lib/ragpack/job-state';
import { requireAdmin, requireUser } from '@/lib/auth/request';

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const state = getRagpackJobState();
  const bundleRoot = getBundleRoot();
  return NextResponse.json({
    state,
    dataRootDir: getDataRootDir(),
    bundleRoot,
    bundleActive: Boolean(bundleRoot),
    index: await getIndexStats()
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const contentType = request.headers.get('content-type') || '';

  if (contentType.includes('multipart/form-data')) {
    if (isRagpackJobRunning()) {
      return NextResponse.json({ error: '已有便携包任务正在运行' }, { status: 409 });
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: '请上传 .ragpack 文件' }, { status: 400 });
    }

    const uploadDir = path.join(process.cwd(), 'storage', 'uploads');
    fs.mkdirSync(uploadDir, { recursive: true });
    const uploadPath = path.join(uploadDir, `import-${Date.now()}.ragpack`);
    fs.writeFileSync(uploadPath, Buffer.from(await file.arrayBuffer()));

    resetRagpackJobState();
    updateRagpackJobState({ status: 'running', phase: 'import', message: '正在导入便携包...' });

    const job = importRagPack(uploadPath)
      .then((result) => {
        updateRagpackJobState({
          status: 'done',
          phase: 'done',
          message: '便携包导入完成',
          result
        });
        return result;
      })
      .catch((error) => {
        updateRagpackJobState({
          status: 'error',
          phase: 'error',
          message: '便携包导入失败',
          error: error instanceof Error ? error.message : String(error)
        });
        throw error;
      })
      .finally(() => setActiveRagpackJob(null));

    setActiveRagpackJob(job);
    const result = await job;
    return NextResponse.json({ ok: true, result });
  }

  const body = await request.json().catch(() => ({}));
  if (body.action !== 'export') {
    return NextResponse.json({ error: '未知操作' }, { status: 400 });
  }

  if (isRagpackJobRunning()) {
    return NextResponse.json({ error: '已有便携包任务正在运行' }, { status: 409 });
  }

  resetRagpackJobState();
  updateRagpackJobState({ status: 'running', phase: 'export', message: '正在打包便携包（可能需要数分钟）...' });

  const job = exportRagPack()
    .then((result) => {
      updateRagpackJobState({
        status: 'done',
        phase: 'done',
        message: '便携包导出完成',
        result
      });
      return result;
    })
    .catch((error) => {
      updateRagpackJobState({
        status: 'error',
        phase: 'error',
        message: '便携包导出失败',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    })
    .finally(() => setActiveRagpackJob(null));

  setActiveRagpackJob(job);
  const result = await job;
  return NextResponse.json({ ok: true, result });
}

export async function PUT(request: Request) {
  const auth = await requireAdmin(request);
  if (auth.error) return auth.error;
  const body = await request.json().catch(() => ({}));
  const outPath = typeof body.outPath === 'string' ? body.outPath : getRagpackJobState().result && 'outPath' in (getRagpackJobState().result as object)
    ? (getRagpackJobState().result as { outPath: string }).outPath
    : '';

  if (!outPath || !fs.existsSync(outPath)) {
    return NextResponse.json({ error: '没有可下载的便携包，请先导出' }, { status: 404 });
  }

  const bytes = fs.readFileSync(outPath);
  const fileName = path.basename(outPath);
  return new NextResponse(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${encodeURIComponent(fileName)}"`,
      'Content-Length': String(bytes.length)
    }
  });
}
