import crypto from 'node:crypto';
import { all, get, run, withTransaction } from '@/lib/db';
import { DEFAULT_PPT_VOICE } from './constants';
import type {
  PptVoiceEvent,
  PptVoiceEventLevel,
  PptVoiceMessage,
  PptVoicePreflight,
  PptVoiceProject,
  PptVoiceProjectSnapshot,
  PptVoiceSlide,
  PptVoiceSlideStatus,
  PptVoiceStatus,
  PptVoiceVoiceSettings
} from './types';
import { countPptVoiceSlideImages, deletePptVoiceWorkspace, hasPptVoiceOutput, hasPptVoiceReport, hasPptVoiceVideo } from './workspace';

type ProjectRow = {
  id: string;
  title: string;
  source_name: string;
  status: PptVoiceStatus;
  progress: number;
  progress_detail: string;
  error: string | null;
  voice_json: string;
  preflight_json: string | null;
  user_id: string | null;
  created_at: string;
  updated_at: string;
};

type SlideRow = {
  id: string;
  project_id: string;
  slide_index: number;
  slide_id: number;
  title: string;
  body_text: string;
  raw_notes: string;
  notes: string;
  duration_seconds: number | null;
  audio_relpath: string | null;
  status: PptVoiceSlideStatus;
  error: string | null;
  updated_at: string;
};

type EventRow = {
  id: number;
  project_id: string;
  slide_index: number | null;
  level: PptVoiceEventLevel;
  text: string;
  created_at: string;
};

type MessageRow = {
  id: number;
  project_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
};

export function assertPptVoiceId(value: string) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效的 PPT 配音项目 ID。');
  return id;
}

function parseVoice(raw: string | null): PptVoiceVoiceSettings {
  if (!raw) return { ...DEFAULT_PPT_VOICE };
  try {
    return { ...DEFAULT_PPT_VOICE, ...(JSON.parse(raw) as Partial<PptVoiceVoiceSettings>) };
  } catch {
    return { ...DEFAULT_PPT_VOICE };
  }
}

function parsePreflight(raw: string | null): PptVoicePreflight | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as PptVoicePreflight;
  } catch {
    return undefined;
  }
}

function mapProject(row: ProjectRow): PptVoiceProject {
  const slideImageCount = countPptVoiceSlideImages(row.id);
  return {
    id: row.id,
    title: row.title,
    sourceName: row.source_name,
    status: row.status,
    progress: row.progress,
    progressDetail: row.progress_detail || undefined,
    error: row.error || undefined,
    voice: parseVoice(row.voice_json),
    preflight: parsePreflight(row.preflight_json),
    hasOutput: hasPptVoiceOutput(row.id),
    hasVideo: hasPptVoiceVideo(row.id),
    hasReport: hasPptVoiceReport(row.id),
    hasSlideImages: slideImageCount > 0,
    slideImageCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSlide(row: SlideRow): PptVoiceSlide {
  return {
    id: row.id,
    projectId: row.project_id,
    slideIndex: row.slide_index,
    slideId: row.slide_id,
    title: row.title,
    bodyText: row.body_text,
    rawNotes: row.raw_notes,
    notes: row.notes,
    durationSeconds: row.duration_seconds ?? undefined,
    audioRelpath: row.audio_relpath || undefined,
    status: row.status,
    error: row.error || undefined,
    updatedAt: row.updated_at
  };
}

function mapEvent(row: EventRow): PptVoiceEvent {
  return {
    id: row.id,
    projectId: row.project_id,
    slideIndex: row.slide_index ?? undefined,
    level: row.level,
    text: row.text,
    createdAt: row.created_at
  };
}

function mapMessage(row: MessageRow): PptVoiceMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at
  };
}

export async function createPptVoiceProject(input: {
  id?: string;
  title: string;
  sourceName: string;
  userId: string;
  voice: PptVoiceVoiceSettings;
  slides: Array<{
    slideIndex: number;
    slideId: number;
    title: string;
    bodyText: string;
    rawNotes: string;
    notes: string;
  }>;
}) {
  const id = crypto.randomUUID();
  const title = input.title.replace(/\s+/g, ' ').trim() || input.sourceName.replace(/\.pptx$/i, '');
  await withTransaction(async () => {
    await run(
      `INSERT INTO ppt_voice_projects (id, title, source_name, status, progress, progress_detail, voice_json, user_id)
       VALUES (?, ?, ?, 'draft', 0, '已解析幻灯片', ?, ?)`,
      [id, title, input.sourceName, JSON.stringify(input.voice), input.userId]
    );
    for (const slide of input.slides) {
      await run(
        `INSERT INTO ppt_voice_slides
          (id, project_id, slide_index, slide_id, title, body_text, raw_notes, notes, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          crypto.randomUUID(),
          id,
          slide.slideIndex,
          slide.slideId,
          slide.title,
          slide.bodyText,
          slide.rawNotes,
          slide.notes,
          slide.notes.trim() ? 'ready' : 'idle'
        ]
      );
    }
  });
  await appendPptVoiceEvent({ projectId: id, text: `已导入 ${input.slides.length} 页：${input.sourceName}` });
  return await getPptVoiceProject(id);
}

export async function listPptVoiceProjects(userId: string) {
  const rows = await all<ProjectRow>(
    `SELECT id, title, source_name, status, progress, progress_detail, error, user_id, created_at, updated_at
     FROM ppt_voice_projects WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC`,
    [userId]
  );
  return rows.map(mapProject);
}

export async function getPptVoiceProject(projectId: string): Promise<PptVoiceProject | null> {
  const row = await get<ProjectRow>('SELECT * FROM ppt_voice_projects WHERE id = ?', [assertPptVoiceId(projectId)]);
  return row ? mapProject(row) : null;
}

export async function assertPptVoiceOwner(projectId: string, userId: string) {
  const row = await get<ProjectRow>('SELECT * FROM ppt_voice_projects WHERE id = ?', [assertPptVoiceId(projectId)]);
  if (!row) return { exists: false, allowed: false };
  return { exists: true, allowed: row.user_id === userId };
}

export async function listPptVoiceSlides(projectId: string) {
  const rows = await all<SlideRow>(
    'SELECT * FROM ppt_voice_slides WHERE project_id = ? ORDER BY slide_index',
    [assertPptVoiceId(projectId)]
  );
  return rows.map(mapSlide);
}

export async function getPptVoiceSlide(projectId: string, slideIndex: number) {
  const row = await get<SlideRow>(
    'SELECT * FROM ppt_voice_slides WHERE project_id = ? AND slide_index = ?',
    [assertPptVoiceId(projectId), slideIndex]
  );
  return row ? mapSlide(row) : null;
}

export async function listPptVoiceEvents(projectId: string, after = 0, limit = 200) {
  const id = assertPptVoiceId(projectId);
  const take = Math.max(1, Math.min(500, limit));
  if (after > 0) {
    const rows = await all<EventRow>(
      'SELECT * FROM ppt_voice_events WHERE project_id = ? AND id > ? ORDER BY id ASC LIMIT ?',
      [id, after, take]
    );
    return rows.map(mapEvent);
  }
  const rows = await all<EventRow>(
    'SELECT * FROM ppt_voice_events WHERE project_id = ? ORDER BY id DESC LIMIT ?',
    [id, take]
  );
  return rows.reverse().map(mapEvent);
}

export async function listPptVoiceMessages(projectId: string) {
  const rows = await all<MessageRow>(
    'SELECT * FROM ppt_voice_messages WHERE project_id = ? ORDER BY id ASC',
    [assertPptVoiceId(projectId)]
  );
  return rows.map(mapMessage);
}

export async function getPptVoiceSnapshot(projectId: string, after = 0): Promise<PptVoiceProjectSnapshot | null> {
  const project = await getPptVoiceProject(projectId);
  if (!project) return null;
  return {
    ...project,
    slides: await listPptVoiceSlides(projectId),
    events: await listPptVoiceEvents(projectId, after),
    messages: await listPptVoiceMessages(projectId)
  };
}

export async function setPptVoiceStatus(
  projectId: string,
  status: PptVoiceStatus,
  options?: { progress?: number; detail?: string; error?: string | null }
) {
  const id = assertPptVoiceId(projectId);
  await run(
    `UPDATE ppt_voice_projects
     SET status = ?, progress = COALESCE(?, progress), progress_detail = COALESCE(?, progress_detail),
         error = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [status, options?.progress ?? null, options?.detail ?? null, options?.error === undefined ? null : options.error, id]
  );
}

export async function setPptVoiceProgress(projectId: string, progress: number, detail: string) {
  await run(
    `UPDATE ppt_voice_projects SET progress = ?, progress_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [progress, detail, assertPptVoiceId(projectId)]
  );
}

export async function updatePptVoiceVoice(projectId: string, voice: PptVoiceVoiceSettings) {
  await run(
    `UPDATE ppt_voice_projects SET voice_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(voice), assertPptVoiceId(projectId)]
  );
}

export async function updatePptVoiceTitle(projectId: string, title: string) {
  const trimmed = title.trim().slice(0, 200);
  if (!trimmed) throw new Error('标题不能为空。');
  await run(
    `UPDATE ppt_voice_projects SET title = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [trimmed, assertPptVoiceId(projectId)]
  );
}

export async function updatePptVoicePreflight(projectId: string, preflight: PptVoicePreflight) {
  await run(
    `UPDATE ppt_voice_projects SET preflight_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [JSON.stringify(preflight), assertPptVoiceId(projectId)]
  );
}

export async function updatePptVoiceSlideNotes(projectId: string, slideIndex: number, notes: string) {
  const trimmed = notes.trim();
  await run(
    `UPDATE ppt_voice_slides
     SET notes = ?, status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND slide_index = ?`,
    [trimmed, trimmed ? 'ready' : 'idle', assertPptVoiceId(projectId), slideIndex]
  );
  await run(`UPDATE ppt_voice_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [projectId]);
}

export async function updatePptVoiceSlidesNotes(
  projectId: string,
  updates: Array<{ slideIndex: number; notes: string }>
) {
  for (const item of updates) {
    await updatePptVoiceSlideNotes(projectId, item.slideIndex, item.notes);
  }
}

export async function updatePptVoiceSlideAudio(
  projectId: string,
  slideIndex: number,
  input: { durationSeconds?: number; audioRelpath?: string; status?: PptVoiceSlideStatus; error?: string | null }
) {
  await run(
    `UPDATE ppt_voice_slides
     SET duration_seconds = COALESCE(?, duration_seconds),
         audio_relpath = COALESCE(?, audio_relpath),
         status = COALESCE(?, status),
         error = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE project_id = ? AND slide_index = ?`,
    [
      input.durationSeconds ?? null,
      input.audioRelpath ?? null,
      input.status ?? null,
      input.error === undefined ? null : input.error,
      assertPptVoiceId(projectId),
      slideIndex
    ]
  );
}

export async function appendPptVoiceEvent(input: {
  projectId: string;
  slideIndex?: number;
  level?: PptVoiceEventLevel;
  text: string;
}) {
  await run(
    `INSERT INTO ppt_voice_events (project_id, slide_index, level, text) VALUES (?, ?, ?, ?)`,
    [assertPptVoiceId(input.projectId), input.slideIndex ?? null, input.level || 'info', input.text]
  );
}

export async function appendPptVoiceMessage(projectId: string, role: 'user' | 'assistant', content: string) {
  await run(
    `INSERT INTO ppt_voice_messages (project_id, role, content) VALUES (?, ?, ?)`,
    [assertPptVoiceId(projectId), role, content]
  );
}

export async function refreshPptVoiceReadyStatus(projectId: string) {
  const project = await getPptVoiceProject(projectId);
  if (!project || project.status === 'generating' || project.status === 'checking') return;
  const slides = await listPptVoiceSlides(projectId);
  const empty = slides.filter((slide) => !slide.notes.trim()).length;
  if (project.hasOutput) {
    await setPptVoiceStatus(projectId, 'done', { progress: 100, detail: '配音稿已生成', error: null });
    return;
  }
  if (empty === 0 && slides.length) {
    await setPptVoiceStatus(projectId, 'ready', { progress: 20, detail: '全部页面已有备注', error: null });
  } else {
    await setPptVoiceStatus(projectId, 'draft', {
      progress: 8,
      detail: empty ? `${empty} 页尚无备注` : '已解析幻灯片',
      error: null
    });
  }
}

export async function deletePptVoiceProject(projectId: string) {
  const id = assertPptVoiceId(projectId);
  await run('DELETE FROM ppt_voice_messages WHERE project_id = ?', [id]);
  await run('DELETE FROM ppt_voice_events WHERE project_id = ?', [id]);
  await run('DELETE FROM ppt_voice_slides WHERE project_id = ?', [id]);
  await run('DELETE FROM ppt_voice_projects WHERE id = ?', [id]);
  deletePptVoiceWorkspace(id);
}
