import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/request';
import { isAgentServiceRequest } from '@/lib/auth/service-token';
import {
  buildSkillMarkdown,
  getCatalogSkill,
  getSharedSkill,
  getSharedSkillByName,
  listCatalogSkills,
  listSharedSkillFiles,
  readSharedSkillMarkdown,
  sanitizeSkillName,
  writeSharedSkillMarkdown
} from '@/lib/shared-skills';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

function lookupSharedSkill(idOrName: string) {
  const value = String(idOrName || '').trim();
  if (!value) return Promise.resolve(null);
  return getSharedSkill(value).then((skill) => skill || getSharedSkillByName(sanitizeSkillName(value)));
}

export async function POST(request: Request) {
  if (!isAgentServiceRequest(request)) {
    const auth = await requireAdmin(request);
    if (auth.error) return auth.error;
  }
  try {
    const body = await request.json().catch(() => ({})) as {
      action?: string;
      name?: string;
      title?: string;
      description?: string;
      markdown?: string;
      body?: string;
    };
    const action = String(body.action || 'list').trim();
    if (action === 'list') {
      const skills = await listCatalogSkills();
      return NextResponse.json({ skills });
    }
    if (action === 'read') {
      const skill = await getCatalogSkill(body.name || '');
      if (!skill) return jsonError('技能不存在。', 404);
      return NextResponse.json({
        skill,
        files: listSharedSkillFiles(skill.name),
        markdown: readSharedSkillMarkdown(skill.name)
      });
    }
    if (action === 'install' || action === 'update') {
      const name = String(body.name || '').trim();
      const markdown = String(body.markdown || '').trim()
        || (name
          ? buildSkillMarkdown({
            name,
            title: body.title,
            description: body.description,
            body: body.body
          })
          : '');
      if (!name && !markdown) return jsonError('请提供 name 或 markdown。');
      const catalogSkill = name ? await getCatalogSkill(name) : null;
      if (catalogSkill?.source === 'system') {
        return jsonError('系统技能不能通过 Agent 修改。', 403);
      }
      const existing = name ? await lookupSharedSkill(name) : null;
      if (action === 'update' && !existing && !markdown.includes('name:')) {
        return jsonError('要修改的技能不存在。');
      }
      const result = await writeSharedSkillMarkdown({
        name: existing?.name || name || 'skill',
        markdown,
        uploadedByName: '智能对话'
      });
      return NextResponse.json({
        skill: result.skill,
        created: result.created,
        files: listSharedSkillFiles(result.skill.name)
      }, { status: result.created ? 201 : 200 });
    }
    return jsonError('action 只能是 list、read、install 或 update。');
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '技能操作失败。', 400);
  }
}
