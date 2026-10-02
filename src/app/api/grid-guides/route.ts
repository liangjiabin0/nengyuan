import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireUser } from '@/lib/auth/request';
import {
  deleteGridGuideAttachments,
  listGridGuideAttachments,
  storeGridGuideAttachment
} from '@/lib/grid-guide/attachments';
import {
  GRID_GUIDE_ATTACHMENT_MAX_BYTES,
  GRID_GUIDE_ATTACHMENT_MAX_FILES
} from '@/lib/grid-guide/constants';
import {
  createGridGuideProject,
  deleteGridGuideProject,
  getGridGuideProject,
  listGridGuideProjects
} from '@/lib/grid-guide/store';

export const runtime = 'nodejs';
export const maxDuration = 900;

const createSchema = z.object({
  idea: z.string().trim().min(4).max(20_000)
}).strict();

async function projectWithAttachments(projectId: string) {
  const project = await getGridGuideProject(projectId);
  if (!project) return null;
  const attachments = await listGridGuideAttachments(projectId);
  return { ...project, attachments };
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  return NextResponse.json({ projects: await listGridGuideProjects(auth.user!.id) });
}

export async function POST(request: Request) {
  let createdProjectId = '';
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
        return NextResponse.json({ error: '请用几句话描述项目构想（最多 20000 字）。' }, { status: 422 });
      }
      idea = parsed.data.idea;
    }

    const ideaParsed = createSchema.safeParse({ idea });
    if (!ideaParsed.success) {
      return NextResponse.json({ error: '请用几句话描述项目构想（最多 20000 字）。' }, { status: 422 });
    }
    if (files.length > GRID_GUIDE_ATTACHMENT_MAX_FILES) {
      return NextResponse.json(
        { error: `创建时最多上传 ${GRID_GUIDE_ATTACHMENT_MAX_FILES} 个附件。` },
        { status: 413 }
      );
    }
    for (const file of files) {
      if (file.size > GRID_GUIDE_ATTACHMENT_MAX_BYTES) {
        return NextResponse.json({ error: '单个附件不能超过 200 MB。' }, { status: 413 });
      }
    }

    const project = await createGridGuideProject(ideaParsed.data.idea, auth.user!.id);
    if (!project) {
      return NextResponse.json({ error: '创建项目指南失败。' }, { status: 500 });
    }
    createdProjectId = project.id;

    for (const file of files) {
      await storeGridGuideAttachment(project.id, {
        name: file.name,
        type: file.type,
        buffer: Buffer.from(await file.arrayBuffer())
      });
    }

    const withAttachments = await projectWithAttachments(project.id);
    return NextResponse.json({ project: withAttachments }, { status: 201 });
  } catch (error) {
    if (createdProjectId) {
      await deleteGridGuideAttachments(createdProjectId).catch(() => undefined);
      await deleteGridGuideProject(createdProjectId).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : '创建项目指南失败。';
    const status = /最多|超过|仅支持|空文件|无效/.test(message) ? 422 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
