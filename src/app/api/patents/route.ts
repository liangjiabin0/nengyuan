import { NextResponse } from 'next/server';
import path from 'node:path';
import unzipper from 'unzipper';
import { ATTACHMENT_MAX_BYTES } from '@/lib/attachments/policy';
import { parsePatentSource } from '@/lib/patent-generation/source-parser';
import {
  createPatentProject,
  listPatentProjects,
  toPatentClientProject
} from '@/lib/patent-generation/store';
import { requireUser } from '@/lib/auth/request';

export const runtime = 'nodejs';

const MAX_SOURCE_BYTES = ATTACHMENT_MAX_BYTES;
const PATENT_SOURCE_EXTENSIONS = new Set([
  '.docx',
  '.pdf',
  '.md',
  '.markdown',
  '.txt',
  '.rtf',
  '.tex',
  '.html',
  '.htm'
]);
const UPLOAD_EXTENSIONS = new Set([...PATENT_SOURCE_EXTENSIONS, '.zip']);

function errorResponse(error: unknown, status = 400) {
  return NextResponse.json(
    { error: error instanceof Error ? error.message : '专利项目操作失败。' },
    { status }
  );
}

function shouldSkipZipEntry(entryPath: string) {
  const normalized = entryPath.replace(/\\/g, '/');
  if (!normalized || normalized.endsWith('/')) return true;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '__MACOSX' || part.startsWith('.'))) return true;
  return false;
}

async function resolvePatentSource(fileName: string, buffer: Buffer) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension !== '.zip') {
    return { name: fileName, buffer };
  }
  const directory = await unzipper.Open.buffer(buffer);
  const candidates: Array<{ name: string; relativePath: string; buffer: Buffer }> = [];
  for (const file of directory.files) {
    if (file.type === 'Directory') continue;
    const relativePath = String(file.path || '').replace(/\\/g, '/');
    if (shouldSkipZipEntry(relativePath)) continue;
    const baseName = path.basename(relativePath);
    const entryExt = path.extname(baseName).toLowerCase();
    if (!PATENT_SOURCE_EXTENSIONS.has(entryExt)) continue;
    const content = await file.buffer();
    if (!content.length) continue;
    candidates.push({ name: baseName, relativePath, buffer: content });
  }
  if (!candidates.length) {
    throw new Error('压缩包中未找到可解析的技术交底文件（DOCX/PDF/MD/TXT 等）。');
  }
  candidates.sort((a, b) => b.buffer.length - a.buffer.length);
  return { name: candidates[0]!.name, buffer: candidates[0]!.buffer };
}

export async function GET(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    return NextResponse.json({ projects: await listPatentProjects(auth.user!.id) });
  } catch (error) {
    return errorResponse(error, 500);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (Number.isFinite(contentLength) && contentLength > MAX_SOURCE_BYTES + 1024 * 1024) {
      return errorResponse(new Error('技术文档不能超过 200 MB。'), 413);
    }
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return errorResponse(new Error('请选择技术文档。'));
    const extension = path.extname(file.name).toLowerCase();
    if (!UPLOAD_EXTENSIONS.has(extension)) {
      return errorResponse(
        new Error('仅支持 DOCX、PDF、Markdown/TXT/RTF/HTML/TeX 技术文档，或包含这些文件的 ZIP 包。'),
        422
      );
    }
    if (!file.size) return errorResponse(new Error('不能上传空文档。'), 422);
    if (file.size > MAX_SOURCE_BYTES) {
      return errorResponse(new Error('技术文档不能超过 200 MB。'), 413);
    }
    const raw = Buffer.from(await file.arrayBuffer());
    const resolved = await resolvePatentSource(file.name, raw);
    const parsed = await parsePatentSource(resolved.name, resolved.buffer);
    const project = await createPatentProject({
      name: resolved.name,
      mediaType: file.type,
      buffer: resolved.buffer,
      parsed,
      userId: auth.user!.id
    });
    return NextResponse.json({ project: toPatentClientProject(project) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const status = /200 MB/.test(message) ? 413 : /仅支持|为空|缺少|无法|未提取|未找到/.test(message) ? 422 : 500;
    return errorResponse(error, status);
  }
}
