import fs from 'node:fs';
import path from 'node:path';
import { cancelQueuedPptVoiceJobs } from '@/lib/jobs/queue';
import { getPptVoiceTtsSettings } from './settings';
import { runPptVoiceAgent } from './sidecar';
import {
  appendPptVoiceEvent,
  getPptVoiceProject,
  listPptVoiceSlides,
  setPptVoiceProgress,
  setPptVoiceStatus,
  updatePptVoicePreflight,
  updatePptVoiceSlideAudio
} from './store';
import {
  assertPptxFile,
  findOutputFiles,
  pptVoiceConfigPath,
  pptVoiceNotesPath,
  pptVoiceSlidesDir,
  pptVoiceSourcePath,
  pptVoiceWorkingPath,
  writeNotesJson,
  writeProjectConfig
} from './workspace';

const globalTasks = globalThis as typeof globalThis & {
  __pptVoiceBuild?: Map<string, Promise<void>>;
};

const tasks = globalTasks.__pptVoiceBuild || new Map<string, Promise<void>>();
globalTasks.__pptVoiceBuild = tasks;

export async function exportPptVoiceSlideImages(projectId: string) {
  const source = pptVoiceSourcePath(projectId);
  if (!fs.existsSync(source)) throw new Error('源 PPT 不存在。');
  const output = pptVoiceSlidesDir(projectId);
  fs.mkdirSync(output, { recursive: true });
  await appendPptVoiceEvent({ projectId, text: '正在导出幻灯片预览' });
  const result = await runPptVoiceAgent(['export-slides', '--pptx', source, '--output', output], {
    timeoutMs: 180_000
  });
  const count = Number(result.count || 0);
  const engine = String(result.engine || 'powerpoint');
  const quality = engine === 'powerpoint' || engine === 'libreoffice';
  await appendPptVoiceEvent({
    projectId,
    text: quality
      ? `已导出 ${count} 页幻灯片预览（${engine === 'libreoffice' ? 'LibreOffice' : 'PowerPoint'}）`
      : `高质量渲染不可用，已用版式回退生成 ${count} 页预览`
  });
  return { count, engine };
}

async function syncWorkingPptx(projectId: string) {
  const project = await getPptVoiceProject(projectId);
  if (!project) throw new Error('项目不存在。');
  const slides = await listPptVoiceSlides(projectId);
  writeProjectConfig(projectId, project.voice);
  writeNotesJson(projectId, slides);
  const source = pptVoiceSourcePath(projectId);
  const working = pptVoiceWorkingPath(projectId);
  assertPptxFile(source, '源 PPT');
  const temp = path.join(path.dirname(working), `working.${process.pid}.${Date.now()}.pptx`);
  try {
    await runPptVoiceAgent(
      ['write-notes', '--pptx', source, '--notes', pptVoiceNotesPath(projectId), '--output', temp],
      { timeoutMs: 120_000 }
    );
    assertPptxFile(temp, '工作副本');
    try {
      fs.rmSync(working, { force: true });
      fs.renameSync(temp, working);
    } catch {
      fs.copyFileSync(temp, working);
      fs.rmSync(temp, { force: true });
    }
  } catch (error) {
    if (fs.existsSync(temp)) fs.rmSync(temp, { force: true });
    throw error;
  }
  assertPptxFile(working, '工作副本');
  return { project, slides, working, config: pptVoiceConfigPath(projectId) };
}

export async function runPptVoiceCheck(projectId: string) {
  await setPptVoiceStatus(projectId, 'checking', { progress: 12, detail: '正在预检备注与费用', error: null });
  await appendPptVoiceEvent({ projectId, text: '开始预检：写入工作副本并估算费用' });
  try {
    const { working, config } = await syncWorkingPptx(projectId);
    const result = await runPptVoiceAgent(['check', '--pptx', working, '--config', config], { timeoutMs: 60_000 });
    const preflight = {
      slideCount: Number(result.slideCount || 0),
      emptyNoteSlides: Array.isArray(result.emptyNoteSlides) ? result.emptyNoteSlides.map(Number) : [],
      characterCount: Number(result.characterCount || 0),
      estimatedCostYuan: String(result.estimatedCostYuan || '0')
    };
    await updatePptVoicePreflight(projectId, preflight);
    const empty = preflight.emptyNoteSlides.length;
    const detail = empty
      ? `预检完成：${preflight.slideCount} 页，${empty} 页无备注，约 ¥${preflight.estimatedCostYuan}`
      : `预检完成：${preflight.slideCount} 页，约 ¥${preflight.estimatedCostYuan}`;
    await appendPptVoiceEvent({ projectId, text: detail, level: empty ? 'warn' : 'info' });
    await setPptVoiceStatus(projectId, empty ? 'draft' : 'ready', { progress: empty ? 15 : 25, detail, error: null });
    return preflight;
  } catch (error) {
    const message = error instanceof Error ? error.message : '预检失败。';
    await appendPptVoiceEvent({ projectId, text: message, level: 'error' });
    await setPptVoiceStatus(projectId, 'failed', { detail: message, error: message });
    throw error;
  }
}

export async function runPptVoicePreview(projectId: string, slideIndex: number) {
  const tts = getPptVoiceTtsSettings();
  if (!tts.dashscopeApiKey) throw new Error('未配置百炼 DASHSCOPE_API_KEY。请到系统设置 → PPT 配音填写。');
  await appendPptVoiceEvent({ projectId, slideIndex, text: `正在试听第 ${slideIndex} 页` });
  const { working, config } = await syncWorkingPptx(projectId);
  const output = path.join(path.dirname(working), 'preview', `slide-${String(slideIndex).padStart(3, '0')}.mp3`);
  const result = await runPptVoiceAgent(
    ['synthesize-one', '--pptx', working, '--slide', String(slideIndex), '--output', output, '--config', config],
    { timeoutMs: 180_000 }
  );
  const duration = Number(result.durationSeconds || 0);
  const rel = `preview/slide-${String(slideIndex).padStart(3, '0')}.mp3`;
  await updatePptVoiceSlideAudio(projectId, slideIndex, {
    durationSeconds: duration,
    audioRelpath: rel,
    status: 'previewed',
    error: null
  });
  await appendPptVoiceEvent({
    projectId,
    slideIndex,
    text: `第 ${slideIndex} 页试听完成${duration ? `，约 ${duration.toFixed(1)} 秒` : ''}`
  });
  return { audioRelpath: rel, durationSeconds: duration, source: result.source };
}

async function runPptVoiceBuildJob(projectId: string, skipEmpty: boolean) {
  const tts = getPptVoiceTtsSettings();
  if (!tts.dashscopeApiKey) throw new Error('未配置百炼 DASHSCOPE_API_KEY。请到系统设置 → PPT 配音填写。');
  const project = await getPptVoiceProject(projectId);
  if (!project) throw new Error('项目不存在。');
  const slides = await listPptVoiceSlides(projectId);
  const empty = slides.filter((slide) => !slide.notes.trim()).map((slide) => slide.slideIndex);
  if (empty.length && !skipEmpty) {
    throw new Error(`以下页面没有演讲者备注：${empty.join('、')}。可先让 AI 写备注，或勾选跳过空页。`);
  }

  await setPptVoiceStatus(projectId, 'generating', { progress: 30, detail: '正在同步备注并启动配音', error: null });
  await appendPptVoiceEvent({ projectId, text: '开始配音：合成逐页音频并嵌入 PowerPoint' });
  const { working, config } = await syncWorkingPptx(projectId);
  if (skipEmpty && empty.length) {
    const voice = { ...project.voice, emptyNotePolicy: 'skip' as const };
    writeProjectConfig(projectId, voice);
  }

  const result = await runPptVoiceAgent(['build', '--pptx', working, '--config', config], {
    timeoutMs: 40 * 60 * 1000,
    onProgress: (event) => {
      const current = Number(event.current || 0);
      const total = Math.max(1, Number(event.total || slides.length));
      const message = String(event.message || '正在配音');
      const progress = 30 + Math.round((current / total) * 60);
      void Promise.all([
        setPptVoiceProgress(projectId, Math.min(95, progress), message),
        appendPptVoiceEvent({ projectId, text: message })
      ]);
    }
  });

  const output = findOutputFiles(projectId);
  if (!output.pptx) throw new Error('配音完成但未找到输出 PPT。');
  for (const slide of slides) {
    if (slide.notes.trim()) {
      await updatePptVoiceSlideAudio(projectId, slide.slideIndex, { status: 'audio_ready', error: null });
    }
  }
  let videoPath = output.mp4;
  try {
    const exported = await exportPptVoiceVideo(projectId);
    videoPath = exported.videoPath;
  } catch (error) {
    const message = error instanceof Error ? error.message : '导出视频失败。';
    await appendPptVoiceEvent({ projectId, text: `PPT 已完成，视频稍后可再导出：${message}`, level: 'warn' });
  }
  const detail = videoPath
    ? `配音完成：已生成带声音 PPT 和视频`
    : `配音完成：${path.basename(output.pptx)}`;
  await appendPptVoiceEvent({ projectId, text: detail, level: 'output' });
  await setPptVoiceStatus(projectId, 'done', { progress: 100, detail, error: null });
  return {
    outputPath: result.outputPath,
    reportPath: result.reportPath,
    manifestPath: result.manifestPath,
    videoPath
  };
}

export function isPptVoiceBuildActive(projectId: string) {
  return tasks.has(projectId);
}

export function startPptVoiceBuild(projectId: string, skipEmpty = false) {
  const active = tasks.get(projectId);
  if (active) return active;
  const promise = (async () => {
    try {
      await runPptVoiceBuildJob(projectId, skipEmpty);
    } catch (error) {
      const message = error instanceof Error ? error.message : '配音失败。';
      await appendPptVoiceEvent({ projectId, text: message, level: 'error' });
      await setPptVoiceStatus(projectId, 'failed', { detail: message, error: message });
      throw error;
    } finally {
      tasks.delete(projectId);
    }
  })();
  tasks.set(projectId, promise);
  return promise;
}

export async function resumePptVoiceBuild(projectId: string) {
  const project = await getPptVoiceProject(projectId);
  if (!project) return;
  if (project.status === 'generating' && !tasks.has(projectId)) {
    startPptVoiceBuild(projectId, project.voice.emptyNotePolicy === 'skip').catch(() => undefined);
  }
}

const videoTasks = globalThis as typeof globalThis & {
  __pptVoiceVideo?: Map<string, Promise<{ videoPath: string }>>;
};
const exportingVideo = videoTasks.__pptVoiceVideo || new Map<string, Promise<{ videoPath: string }>>();
videoTasks.__pptVoiceVideo = exportingVideo;

export async function exportPptVoiceVideo(projectId: string) {
  const active = exportingVideo.get(projectId);
  if (active) return active;
  const promise = (async () => {
    const files = findOutputFiles(projectId);
    if (!files.pptx) throw new Error('还没有配音成品 PPT。');
    if (files.mp4 && fs.existsSync(files.mp4) && fs.statSync(files.mp4).mtimeMs >= fs.statSync(files.pptx).mtimeMs) {
      return { videoPath: files.mp4 };
    }
    const dest = files.pptx.replace(/\.pptx$/i, '.mp4');
    await setPptVoiceProgress(projectId, 96, '正在导出配音视频');
    await appendPptVoiceEvent({ projectId, text: '正在把带声音的 PPT 导出为视频' });
    const result = await runPptVoiceAgent(
      ['export-video', '--pptx', files.pptx, '--output', dest],
      { timeoutMs: 40 * 60 * 1000 }
    );
    const videoPath = String(result.outputPath || dest);
    const ready = findOutputFiles(projectId).mp4;
    if (!ready || !fs.existsSync(videoPath)) throw new Error('视频导出完成但文件仍被占用，请稍后再下载。');
    await appendPptVoiceEvent({ projectId, text: `视频已生成：${path.basename(videoPath)}`, level: 'output' });
    await setPptVoiceProgress(projectId, 100, '配音视频已就绪');
    return { videoPath: ready };
  })();
  exportingVideo.set(projectId, promise);
  try {
    return await promise;
  } finally {
    exportingVideo.delete(projectId);
  }
}

export function isPptVoiceVideoExportActive(projectId: string) {
  return exportingVideo.has(projectId);
}

export async function startPptVoiceVideoExport(projectId: string) {
  if (exportingVideo.has(projectId)) {
    return { started: true, alreadyRunning: true };
  }
  const files = findOutputFiles(projectId);
  if (!files.pptx) throw new Error('还没有配音成品 PPT。');
  await setPptVoiceProgress(projectId, 96, '正在导出配音视频');
  void exportPptVoiceVideo(projectId).catch(async (error) => {
    const message = error instanceof Error ? error.message : '导出视频失败。';
    await appendPptVoiceEvent({ projectId, text: message, level: 'error' });
    await setPptVoiceProgress(projectId, 100, `PPT 已完成，视频导出失败：${message}`);
  });
  return { started: true, alreadyRunning: false };
}

export async function enqueuePptVoiceBuild(projectId: string, skipEmpty = false) {
  try {
    await cancelQueuedPptVoiceJobs(projectId);
  } catch {
    // 队列表不可用时仍在本进程启动配音
  }
  const current = await getPptVoiceProject(projectId);
  if (current?.status !== 'generating') {
    await setPptVoiceStatus(projectId, 'generating', { progress: 8, detail: '正在启动配音', error: null });
  }
  return startPptVoiceBuild(projectId, skipEmpty);
}
