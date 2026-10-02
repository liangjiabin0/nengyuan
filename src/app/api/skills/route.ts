import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import {
  createCustomSharedSkill,
  createSharedSkill,
  listCatalogSkills,
  withSkillPermissions,
  SHARED_SKILL_MAX_BYTES
} from '@/lib/shared-skills';

function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const skills = withSkillPermissions(await listCatalogSkills(), auth.user);
  return NextResponse.json({ skills });
}

export async function POST(request: Request) {
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json().catch(() => ({})) as {
        name?: string;
        title?: string;
        description?: string;
        body?: string;
      };
      const skill = await createCustomSharedSkill({
        name: body.name,
        title: body.title,
        description: body.description,
        body: body.body,
        uploadedBy: auth.user!.id,
        uploadedByName: auth.user!.username
      });
      return NextResponse.json({ skill }, { status: 201 });
    }
    const formData = await request.formData().catch(() => null);
    const file = formData?.get('file');
    if (!(file instanceof File)) return jsonError('请选择要上传的技能文件，或提交名称、描述和正文。');
    if (file.size > SHARED_SKILL_MAX_BYTES) {
      return jsonError(`技能包不能超过 ${Math.round(SHARED_SKILL_MAX_BYTES / 1024 / 1024)} MB。`, 413);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const skill = await createSharedSkill({
      fileName: file.name,
      buffer,
      uploadedBy: auth.user!.id,
      uploadedByName: auth.user!.username
    });
    return NextResponse.json({ skill }, { status: 201 });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : '技能保存失败。', 400);
  }
}
