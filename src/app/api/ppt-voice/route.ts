import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { PPT_VOICE_MAX_BYTES } from '@/lib/ppt-voice/constants';
import { defaultVoiceFromTts } from '@/lib/ppt-voice/settings';
import { runPptVoiceAgent } from '@/lib/ppt-voice/sidecar';
import { exportPptVoiceSlideImages } from '@/lib/ppt-voice/orchestrator';
import { createPptVoiceProject, deletePptVoiceProject, getPptVoiceSnapshot, listPptVoiceProjects } from '@/lib/ppt-voice/store';
import { writeSourcePptx } from '@/lib/ppt-voice/workspace';

export const runtime = 'nodejs';
export const maxDuration = 180;

export async function GET(request: Request) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  return NextResponse.json({ projects: await listPptVoiceProjects(auth.user!.id) });
}

export async function POST(request: Request) {
  let createdId = '';
  let tmp = '';
  try {
    const auth = await requireUser(request);
    if (auth.error) return auth.error;
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size <= 0) {
      return NextResponse.json({ error: '请上传 .pptx 文件。' }, { status: 422 });
    }
    if (!file.name.toLowerCase().endsWith('.pptx')) {
      return NextResponse.json({ error: '仅支持 .pptx。' }, { status: 422 });
    }
    if (file.size > PPT_VOICE_MAX_BYTES) {
      return NextResponse.json({ error: 'PPT 不能超过 200 MB。' }, { status: 413 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    tmp = path.join(os.tmpdir(), `ppt-voice-${randomUUID()}.pptx`);
    fs.writeFileSync(tmp, buffer);
    const inspected = await runPptVoiceAgent(['inspect', '--pptx', tmp], { timeoutMs: 60_000 });
    const slides = (Array.isArray(inspected.slides) ? inspected.slides : [])
      .map((item) => {
        const record = item as Record<string, unknown>;
        return {
          slideIndex: Number(record.slideIndex || 0),
          slideId: Number(record.slideId || 0),
          title: String(record.title || ''),
          bodyText: String(record.bodyText || ''),
          rawNotes: String(record.rawNotes || ''),
          notes: String(record.notes || '')
        };
      })
      .filter((item) => item.slideIndex > 0);
    if (!slides.length) {
      return NextResponse.json({ error: '未能解析到幻灯片。' }, { status: 422 });
    }

    const created = await createPptVoiceProject({
      title: file.name.replace(/\.pptx$/i, ''),
      sourceName: file.name,
      userId: auth.user!.id,
      voice: defaultVoiceFromTts(),
      slides
    });
    if (!created) return NextResponse.json({ error: '创建项目失败。' }, { status: 500 });
    createdId = created.id;
    writeSourcePptx(created.id, buffer);
    try {
      await exportPptVoiceSlideImages(created.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : '导出幻灯片预览失败。';
      console.warn(`[ppt-voice] slide preview: ${message}`);
    }
    return NextResponse.json({ project: await getPptVoiceSnapshot(created.id) }, { status: 201 });
  } catch (error) {
    if (createdId) await deletePptVoiceProject(createdId).catch(() => undefined);
    const message = error instanceof Error ? error.message : '导入 PPT 失败。';
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (tmp) fs.unlink(tmp, () => undefined);
  }
}
