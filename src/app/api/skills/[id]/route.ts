import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import {
  canDeleteSharedSkill,
  deleteCatalogSkill,
  canEditSharedSkill,
  getCatalogSkill,
  listSharedSkillFileEntries,
  parseSkillMarkdown,
  readSharedSkillFile,
  readSharedSkillMarkdown,
  saveCatalogSkillFiles,
  updateCatalogSkill
} from '@/lib/shared-skills';
import { skillDeleteDeniedReason, skillEditDeniedReason } from '@/lib/skill-permissions';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const skill = await getCatalogSkill(id);
  if (!skill) return jsonError('技能不存在。', 404);
  const file = new URL(request.url).searchParams.get('file');
  if (file) {
    try {
      return NextResponse.json({ file: readSharedSkillFile(skill.name, file) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '读取文件失败。';
      return jsonError(message, message === '文件不存在。' ? 404 : 400);
    }
  }
  const markdown = readSharedSkillMarkdown(skill.name);
  return NextResponse.json({
    skill: {
      ...skill,
      canDelete: canDeleteSharedSkill(skill, auth.user),
      canEdit: canEditSharedSkill(skill, auth.user)
    },
    files: listSharedSkillFileEntries(skill.name),
    markdown,
    body: parseSkillMarkdown(markdown).body
  });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const existing = await getCatalogSkill(id);
  if (!existing) return jsonError('技能不存在。', 404);
  if (!canEditSharedSkill(existing, auth.user)) {
    return jsonError(skillEditDeniedReason(existing, auth.user) || '没有修改权限。', 403);
  }
  try {
    const body = await request.json().catch(() => ({})) as {
      name?: string;
      title?: string;
      description?: string;
      body?: string;
      files?: Array<{ path?: string; content?: string }>;
      deleted?: string[];
    };
    const hasMeta = ['name', 'title', 'description', 'body'].some((key) => (
      body[key as 'name' | 'title' | 'description' | 'body'] !== undefined
    ));
    const hasFiles = Boolean(body.files?.length || body.deleted?.length);
    if (!hasMeta && !hasFiles) return jsonError('没有要保存的内容。');
    let skill = existing;
    if (hasMeta) {
      const result = await updateCatalogSkill(existing.source === 'shared' ? existing.id : existing.name, {
        name: body.name,
        title: body.title,
        description: body.description,
        body: body.body
      });
      skill = result.skill;
    }
    if (hasFiles) {
      await saveCatalogSkillFiles(skill.name, {
        source: skill.source,
        files: body.files,
        deleted: body.deleted
      });
    }
    return NextResponse.json({
      skill: {
        ...skill,
        canDelete: canDeleteSharedSkill(skill, auth.user),
        canEdit: canEditSharedSkill(skill, auth.user)
      },
      files: listSharedSkillFileEntries(skill.name)
    });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '技能更新失败。', 400);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await params;
  const skill = await getCatalogSkill(id);
  if (!skill) return jsonError('技能不存在。', 404);
  if (!canDeleteSharedSkill(skill, auth.user)) {
    return jsonError(skillDeleteDeniedReason(skill, auth.user) || '没有删除权限。', 403);
  }
  const removed = await deleteCatalogSkill(skill.source === 'shared' ? skill.id : skill.name);
  if (!removed) return jsonError('技能删除失败。', 400);
  return NextResponse.json({ ok: true });
}
