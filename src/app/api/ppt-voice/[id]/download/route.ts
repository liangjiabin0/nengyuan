import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/auth/request';
import { isPptVoiceVideoExportActive } from '@/lib/ppt-voice/orchestrator';
import { assertPptVoiceOwner, getPptVoiceProject } from '@/lib/ppt-voice/store';
import { findOutputFiles, isUnlockedFile, pptVoicePreviewPath, pptVoiceSlideImagePath } from '@/lib/ppt-voice/workspace';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

function isBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('EBUSY') || message.includes('resource busy') || message.includes('locked');
}

function fileResponse(filePath: string, downloadName: string, contentType: string) {
  const buffer = fs.readFileSync(filePath);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      'Content-Length': String(buffer.length)
    }
  });
}

function streamFileResponse(filePath: string, downloadName: string, contentType: string) {
  const stat = fs.statSync(filePath);
  const stream = fs.createReadStream(filePath);
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store'
    }
  });
}

export async function GET(request: Request, context: Context) {
  const auth = await requireUser(request);
  if (auth.error) return auth.error;
  const { id } = await context.params;
  const ownership = await assertPptVoiceOwner(id, auth.user!.id);
  if (!ownership.exists) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });
  if (!ownership.allowed) return NextResponse.json({ error: '无权访问该项目。' }, { status: 403 });
  const project = await getPptVoiceProject(id);
  if (!project) return NextResponse.json({ error: '项目不存在。' }, { status: 404 });

  const kind = new URL(request.url).searchParams.get('kind') || 'pptx';
  const slide = Number(new URL(request.url).searchParams.get('slide') || 0);
  if (kind === 'slide' && slide > 0) {
    const image = pptVoiceSlideImagePath(id, slide);
    if (!fs.existsSync(image)) return NextResponse.json({ error: '还没有该页预览图。' }, { status: 404 });
    const buffer = fs.readFileSync(image);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=60',
        'Content-Length': String(buffer.length)
      }
    });
  }
  if (kind === 'audio' && slide > 0) {
    const audio = pptVoicePreviewPath(id, slide);
    if (!fs.existsSync(audio)) return NextResponse.json({ error: '还没有该页试听音频。' }, { status: 404 });
    const buffer = fs.readFileSync(audio);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(buffer.length)
      }
    });
  }

  const files = findOutputFiles(id);
  if (kind === 'report') {
    if (!files.report) return NextResponse.json({ error: '还没有生成报告。' }, { status: 404 });
    return fileResponse(files.report, path.basename(files.report), 'text/html; charset=utf-8');
  }
  if (kind === 'video' || kind === 'mp4') {
    if (isPptVoiceVideoExportActive(id)) {
      return NextResponse.json({ error: '视频正在导出，请等完成后再下载。' }, { status: 409 });
    }
    if (!files.mp4 || !isUnlockedFile(files.mp4)) {
      return NextResponse.json({ error: '还没有配音视频，或视频仍被占用。请稍后再试。' }, { status: 409 });
    }
    try {
      return streamFileResponse(files.mp4, path.basename(files.mp4), 'video/mp4');
    } catch (error) {
      if (isBusyError(error)) {
        return NextResponse.json({ error: '视频正在生成或被占用，请稍后再下载。' }, { status: 409 });
      }
      throw error;
    }
  }
  if (!files.pptx) return NextResponse.json({ error: '还没有配音成品。' }, { status: 404 });
  return fileResponse(
    files.pptx,
    path.basename(files.pptx),
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  );
}
