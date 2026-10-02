import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import {
  listSchemeSolveAttachments,
  storeSchemeSolveAttachment
} from '@/lib/scheme-solve/attachments';
import {
  SCHEME_SOLVE_ATTACHMENT_MAX_BYTES,
  SCHEME_SOLVE_ATTACHMENT_MAX_UPLOAD_FILES
} from '@/lib/scheme-solve/constants';
import { assertSchemeOwner } from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';
export const maxDuration = 900;

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const sessionId = new URL(request.url).searchParams.get('sessionId')?.trim() || '';
  if (!sessionId) return jsonError('缺少 sessionId。');
  const ownership = await assertSchemeOwner(sessionId, auth.user!.id);
  if (!ownership.exists) return jsonError('方案不存在。', 404);
  if (!ownership.allowed) return jsonError('无权访问该方案。', 403);
  return NextResponse.json({ attachments: await listSchemeSolveAttachments(sessionId) });
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const form = await request.formData();
    const sessionId = String(form.get('sessionId') || '').trim();
    if (!sessionId) return jsonError('缺少 sessionId。');
    const ownership = await assertSchemeOwner(sessionId, auth.user!.id);
    if (!ownership.exists) return jsonError('方案不存在。', 404);
    if (!ownership.allowed) return jsonError('无权访问该方案。', 403);
    const files = form.getAll('files').filter((entry): entry is File => entry instanceof File && entry.size > 0);
    if (!files.length) return jsonError('请选择附件。');
    if (files.length > SCHEME_SOLVE_ATTACHMENT_MAX_UPLOAD_FILES) {
      return jsonError(`一次最多上传 ${SCHEME_SOLVE_ATTACHMENT_MAX_UPLOAD_FILES} 个文件。`, 413);
    }
    for (const file of files) {
      if (file.size > SCHEME_SOLVE_ATTACHMENT_MAX_BYTES) {
        return jsonError('单个附件不能超过 200 MB。', 413);
      }
    }
    for (const file of files) {
      await storeSchemeSolveAttachment(sessionId, {
        name: file.name,
        type: file.type,
        buffer: Buffer.from(await file.arrayBuffer())
      });
    }
    return NextResponse.json({ attachments: await listSchemeSolveAttachments(sessionId) });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '上传失败。', 500);
  }
}
