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
import { deleteSchemeSession, getSchemeSnapshot, listSchemeSessions } from '@/lib/scheme-solve/store';
import { createVirtualSimSession, startVirtualSimResearch } from '@/lib/virtual-sim/pipeline';
import {
  VIRTUAL_SIM_CAPABILITY_GROUPS,
  inferVirtualSimRouting,
  isVirtualSimToolId,
  listVirtualSimCapabilities,
  listVirtualSimTools
} from '@/lib/virtual-sim/tools';

export const runtime = 'nodejs';
export const maxDuration = 60;

const createSchema = z.object({
  idea: z.string().trim().min(4).max(20_000),
  toolId: z.string().trim().optional(),
  capabilityId: z.string().trim().optional()
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
  const toolId = new URL(request.url).searchParams.get('tool')?.trim() || '';
  if (toolId && !isVirtualSimToolId(toolId)) {
    return NextResponse.json({ error: '未知的仿真工具。' }, { status: 422 });
  }
  return NextResponse.json({
    tools: listVirtualSimTools().map((tool) => ({
      id: tool.id,
      label: tool.label,
      shortLabel: tool.shortLabel,
      engine: tool.engine,
      description: tool.description
    })),
    capabilityGroups: VIRTUAL_SIM_CAPABILITY_GROUPS,
    capabilities: listVirtualSimCapabilities().map((capability) => ({
      id: capability.id,
      groupId: capability.groupId,
      toolId: capability.toolId,
      label: capability.label,
      engine: capability.engine,
      integration: capability.integration,
      method: capability.method,
      description: capability.description,
      fidelity: capability.fidelity,
      boundary: capability.boundary
    })),
    sessions: await listSchemeSessions(auth.user!.id, {
      source: 'virtual-sim',
      toolId: toolId || undefined
    })
  });
}

export async function POST(request: Request) {
  let createdId = '';
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;

    const contentType = request.headers.get('content-type') || '';
    let idea = '';
    let toolId = '';
    let capabilityId = '';
    const files: File[] = [];

    if (contentType.includes('multipart/form-data')) {
      const form = await request.formData();
      idea = String(form.get('idea') || '').trim();
      toolId = String(form.get('toolId') || '').trim();
      capabilityId = String(form.get('capabilityId') || '').trim();
      for (const entry of form.getAll('files')) {
        if (entry instanceof File && entry.size > 0) files.push(entry);
      }
    } else {
      const parsed = createSchema.safeParse(await request.json().catch(() => null));
      if (!parsed.success) {
        return NextResponse.json({ error: '请用几句话描述仿真任务。' }, { status: 422 });
      }
      idea = parsed.data.idea;
      toolId = parsed.data.toolId || '';
      capabilityId = parsed.data.capabilityId || '';
    }

    const ideaParsed = createSchema.safeParse({ idea, ...(toolId ? { toolId } : {}), ...(capabilityId ? { capabilityId } : {}) });
    if (!ideaParsed.success) {
      return NextResponse.json({ error: '请用几句话描述仿真任务（最多 20000 字）。' }, { status: 422 });
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

    const routing = inferVirtualSimRouting(ideaParsed.data.idea, files.map((file) => file.name));
    const created = await createVirtualSimSession(
      ideaParsed.data.idea,
      auth.user!.id,
      routing.toolId,
      routing.capabilityId
    );
    createdId = created.session.id;
    for (const file of files) {
      await storeSchemeSolveAttachment(created.session.id, {
        name: file.name,
        type: file.type,
        buffer: Buffer.from(await file.arrayBuffer())
      });
    }
    await startVirtualSimResearch(created.session.id, [created.idea.id]);
    return NextResponse.json({ session: await sessionWithAttachments(created.session.id), routing }, { status: 201 });
  } catch (error) {
    if (createdId) {
      await deleteSchemeSolveAttachments(createdId).catch(() => undefined);
      await deleteSchemeSession(createdId).catch(() => undefined);
    }
    const message = error instanceof Error ? error.message : '创建仿真任务失败。';
    const status = /最多|超过|仅支持|空文件|无效|未知/.test(message) ? 422 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
