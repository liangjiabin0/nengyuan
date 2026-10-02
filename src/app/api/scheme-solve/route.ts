import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import {
  deleteSchemeSolveAttachments,
  listSchemeSolveAttachments,
  storeSchemeSolveAttachment
} from '@/lib/scheme-solve/attachments';
import {
  SCHEME_SOLVE_ATTACHMENT_MAX_BYTES,
  SCHEME_SOLVE_ATTACHMENT_MAX_UPLOAD_FILES
} from '@/lib/scheme-solve/constants';
import {
  createSchemeSession,
  deleteSchemeSession,
  getSchemeSnapshot,
  listSchemeSessions
} from '@/lib/scheme-solve/store';

export const runtime = 'nodejs';

const createSchema = z.object({
  idea: z.string().trim().min(4).max(20_000)
}).strict();

async function sessionWithAttachments(sessionId: string) {
  const snapshot = await getSchemeSnapshot(sessionId);
  if (!snapshot) return null;
  const attachments = await listSchemeSolveAttachments(sessionId);
  return { ...snapshot, attachments };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  return NextResponse.json({ sessions: await listSchemeSessions(auth.user!.id) });
}

export async function POST(request: Request) {
  let createdId = '';
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;

    const contentType = request.headers.get('content-type') || '';
    let idea = '';
    const files: File[] = [];

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      idea = String(form.get('idea') || '').trim();
      for (const entry of form.getAll('files')) {
        if (entry instanceof File && entry.size > 0) files.push(entry);
      }
    } else {
      const parsed = createSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json({ error: '请用几句话描述想法（最多 20000 字）。' }, { status: 422 });
      }
      idea = parsed.data.idea;
    }

    const ideaParsed = createSchema.safeParse({ idea });
    if (!ideaParsed.success) {
      return NextResponse.json({ error: '请用几句话描述想法（最多 20000 字）。' }, { status: 422 });
    }
    if (files.length > SCHEME_SOLVE_ATTACHMENT_MAX_UPLOAD_FILES) {
      return NextResponse.json(
        { error: `创建时最多上传 ${SCHEME_SOLVE_ATTACHMENT_MAX_UPLOAD_FILES} 个附件。` },
        { status: 413 }
      );
    }
    for (const file of files) {
      if (file.size > SCHEME_SOLVE_ATTACHMENT_MAX_BYTES) {
        return NextResponse.json({ error: '单个附件不能超过 200 MB。' }, { status: 413 });
      }
    }

    const session = await createSchemeSession(ideaParsed.data.idea, auth.user!.id);
    if (!session) return NextResponse.json({ error: '创建方案失败。' }, { status: 500 });
    createdId = session.id;

    for (const file of files) {
      await storeSchemeSolveAttachment(session.id, {
        name: file.name,
        type: file.type,
        buffer: Buffer.from(await file.arrayBuffer())
      });
    }

    return NextResponse.json({ session: await sessionWithAttachments(session.id) }, { status: 201 });
  } catch (error) {
    if (createdId) {
      await deleteSchemeSolveAttachments(createdId).catch(() => undefined);
      await deleteSchemeSession(createdId).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : '创建方案失败。';
    const status = /最多|超过|仅支持|空文件|无效/.test(message) ? 422 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
