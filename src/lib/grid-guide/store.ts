import crypto from 'node:crypto';
import { all, get, run, withTransaction } from '@/lib/db';
import { deleteOpenCodeSessionMapping } from '@/lib/opencode/runtime';
import { GRID_GUIDE_SESSION_FILE } from './constants';
import { deleteGridGuideAttachments } from './attachments';
import { sanitizeGridGuideFormalReferences } from './sanitize';
import type { GridGuideDocument, GridGuideMessage, GridGuideProject } from './types';
import {
  assessTaskDeliverables,
  countTaskFiles,
  deleteGridGuideWorkspace,
  readGeneratedProjectTitle,
  resolveTaskFolderName,
  workspaceExists
} from './workspace';

type ProjectRow = {
  id: string;
  title: string;
  idea: string;
  status: GridGuideProject['status'];
  progress: number;
  progress_detail: string;
  user_id: string | null;
  document_json: string | null;
  task_folder: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type MessageRow = {
  id: string;
  role: GridGuideMessage['role'];
  content: string;
  selection: string | null;
  created_at: string;
};

function assertId(value: string) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效的项目指南 ID。');
  return id;
}

function parseDocument(value: string | null) {
  if (!value) return undefined;
  try {
    return sanitizeGridGuideFormalReferences(JSON.parse(value) as GridGuideDocument);
  } catch {
    return undefined;
  }
}

function mapMessage(row: MessageRow): GridGuideMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    selection: row.selection || undefined,
    createdAt: row.created_at
  };
}

/** 脚本/宿主已落盘但未回写 status 时，按任务文件夹把记录标成已生成。 */
async function reconcileGridGuideFromDisk(projectId: string) {
  const id = assertId(projectId);
  const row = await get<ProjectRow>('SELECT * FROM grid_guide_projects WHERE id = ?', [id]);
  if (!row || row.status === 'generating') return;
  const taskFolder = resolveTaskFolderName(id, row.task_folder || undefined);
  if (!taskFolder) return;
  const assessment = assessTaskDeliverables(id, taskFolder);
  if (assessment.ready) {
    if (row.status === 'ready' && row.task_folder === taskFolder && row.progress === 100) return;
    const title = readGeneratedProjectTitle(id, taskFolder);
    await run(
      `UPDATE grid_guide_projects
       SET title = COALESCE(NULLIF(?, ''), title),
           task_folder = ?,
           status = 'ready',
           progress = 100,
           progress_detail = ?,
           error = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        title || '',
        taskFolder,
        `已写入 ${assessment.fileCount} 个成果文件`,
        id
      ]
    );
    return;
  }
  if (!row.task_folder && countTaskFiles(id, taskFolder) > 0) {
    await run(
      `UPDATE grid_guide_projects SET task_folder = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [taskFolder, id]
    );
  }
}

export async function createGridGuideProject(idea: string, userId: string) {
  const id = crypto.randomUUID();
  const compact = idea.replace(/\s+/g, ' ').trim();
  if (compact.length < 4) throw new Error('请至少用几句话描述项目构想。');
  const title = compact.length > 28 ? `${compact.slice(0, 28)}…` : compact;
  await run(
    `INSERT INTO grid_guide_projects (id, title, idea, status, user_id)
     VALUES (?, ?, ?, 'draft', ?)`,
    [id, title, compact, userId]
  );
  await addGridGuideMessage(id, 'user', compact);
  return await getGridGuideProject(id);
}

export async function listGridGuideProjects(userId: string) {
  const rows = await all<ProjectRow>(
    `SELECT id, title, idea, status, progress, progress_detail, task_folder, error, created_at, updated_at
     FROM grid_guide_projects
     WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC`,
    [userId]
  );
  await Promise.all(rows.map((row) => reconcileGridGuideFromDisk(row.id)));
  const next = await all<ProjectRow>(
    `SELECT id, title, idea, status, progress, progress_detail, task_folder, error, created_at, updated_at
     FROM grid_guide_projects
     WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC`,
    [userId]
  );
  return next.map((row) => ({
    id: row.id,
    title: row.title,
    idea: row.idea,
    status: row.status,
    progress: row.progress,
    progressDetail: row.progress_detail || undefined,
    taskFolder: row.task_folder || undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function assertGridGuideOwner(projectId: string, userId: string) {
  const row = await get<ProjectRow>('SELECT * FROM grid_guide_projects WHERE id = ?', [assertId(projectId)]);
  if (!row) return { exists: false, allowed: false };
  return { exists: true, allowed: row.user_id === userId };
}

export async function getGridGuideProject(projectId: string): Promise<GridGuideProject | null> {
  const id = assertId(projectId);
  await reconcileGridGuideFromDisk(id);
  const row = await get<ProjectRow>('SELECT * FROM grid_guide_projects WHERE id = ?', [id]);
  if (!row) return null;
  const messages = (await all<MessageRow>(
    'SELECT id, role, content, selection, created_at FROM grid_guide_messages WHERE project_id = ? ORDER BY created_at, rowid',
    [id]
  )).map(mapMessage);
  return {
    id: row.id,
    title: row.title,
    idea: row.idea,
    status: row.status,
    progress: row.progress,
    progressDetail: row.progress_detail || undefined,
    document: parseDocument(row.document_json),
    taskFolder: row.task_folder || undefined,
    hasWorkspace: workspaceExists(id),
    messages,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function addGridGuideMessage(
  projectId: string,
  role: GridGuideMessage['role'],
  content: string,
  selection?: string
) {
  const id = assertId(projectId);
  await run(
    `INSERT INTO grid_guide_messages (id, project_id, role, content, selection)
     VALUES (?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), id, role, content.trim(), selection?.trim() || null]
  );
  await run('UPDATE grid_guide_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

export async function setGridGuideStatus(
  projectId: string,
  status: GridGuideProject['status'],
  error?: string | null
) {
  const progress = status === 'generating' ? 2 : status === 'ready' ? 100 : undefined;
  const detail =
    status === 'generating'
      ? '任务已提交，正在连接生成服务'
      : status === 'ready'
        ? '指南成果已生成'
        : status === 'failed'
          ? '生成失败'
          : '';
  await run(
    `UPDATE grid_guide_projects
     SET status = ?, error = ?,
         progress = COALESCE(?, progress), progress_detail = ?,
         updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [status, error || null, progress, detail, assertId(projectId)]
  );
}

export async function setGridGuideProgress(projectId: string, progress: number, detail: string) {
  const normalized = Math.max(0, Math.min(99, Math.round(progress)));
  await run(
    `UPDATE grid_guide_projects
     SET status = 'generating', progress = ?, progress_detail = ?, error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [normalized, detail.trim(), assertId(projectId)]
  );
}

export async function saveGridGuideTaskResult(
  projectId: string,
  input: { taskFolder: string; title?: string; summary?: string }
) {
  const title = input.title?.replace(/\s+/g, ' ').trim();
  await run(
    `UPDATE grid_guide_projects
     SET title = COALESCE(NULLIF(?, ''), title),
         task_folder = ?,
         status = 'ready',
         progress = 100,
         progress_detail = ?,
         error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      title || '',
      input.taskFolder,
      input.summary?.trim() || '指南成果已写入任务文件夹',
      assertId(projectId)
    ]
  );
  return await getGridGuideProject(projectId);
}

export async function saveGridGuideDocument(projectId: string, document: GridGuideDocument) {
  await run(
    `UPDATE grid_guide_projects
     SET title = ?, document_json = ?, status = 'ready', progress = 100,
         progress_detail = '指南与编制说明已生成', error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [document.projectTitle, JSON.stringify(document), assertId(projectId)]
  );
  return await getGridGuideProject(projectId);
}

function applyGridGuideTextEdit(
  document: GridGuideDocument,
  path: Array<string | number>,
  value: string
) {
  if (!value.trim()) throw new Error('内容不能为空。');
  if (
    !path.length ||
    path.length > 8 ||
    path.some((part) => typeof part === 'string' && ['__proto__', 'prototype', 'constructor'].includes(part))
  ) {
    throw new Error('无效的编辑位置。');
  }

  let parent: unknown = document;
  for (const part of path.slice(0, -1)) {
    if (typeof parent !== 'object' || parent === null || !(part in parent)) {
      throw new Error('编辑位置不存在。');
    }
    parent = (parent as Record<string | number, unknown>)[part];
  }
  const leaf = path.at(-1)!;
  if (
    typeof parent !== 'object' ||
    parent === null ||
    !(leaf in parent) ||
    typeof (parent as Record<string | number, unknown>)[leaf] !== 'string'
  ) {
    throw new Error('该内容不支持直接编辑。');
  }
  const next = value.trim();
  (parent as Record<string | number, unknown>)[leaf] = next;

  if (path.length === 1 && path[0] === 'projectTitle') {
    document.explanation.planningCorrespondence.guideName = next;
  }
  if (path[0] === 'guide' && path[1] === 'topicSetup' && typeof path[2] === 'number') {
    if (document.guide.topics[path[2]]) document.guide.topics[path[2]].title = next;
  }
  if (
    path[0] === 'guide' &&
    path[1] === 'topics' &&
    typeof path[2] === 'number' &&
    path[3] === 'title'
  ) {
    if (document.guide.topicSetup[path[2]] !== undefined) {
      document.guide.topicSetup[path[2]] = next;
    }
  }
}

export async function updateGridGuideText(
  projectId: string,
  path: Array<string | number>,
  value: string
) {
  return await updateGridGuideTexts(projectId, [{ path, value }]);
}

export async function updateGridGuideTexts(
  projectId: string,
  edits: Array<{ path: Array<string | number>; value: string }>
) {
  const project = await getGridGuideProject(projectId);
  if (!project?.document) throw new Error('指南尚未生成，无法编辑。');
  if (!edits.length) throw new Error('没有可保存的编辑。');

  const document = structuredClone(project.document) as GridGuideDocument;
  for (const edit of edits) {
    applyGridGuideTextEdit(document, edit.path, edit.value);
  }
  return await saveGridGuideDocument(projectId, document);
}

export async function deleteGridGuideProject(projectId: string) {
  const id = assertId(projectId);
  await deleteGridGuideAttachments(id);
  deleteGridGuideWorkspace(id);
  deleteOpenCodeSessionMapping(`grid-guide:${id}`, GRID_GUIDE_SESSION_FILE);
  await withTransaction(async (database) => {
    await database.prepare('DELETE FROM grid_guide_messages WHERE project_id = ?').run(id);
    await database.prepare('DELETE FROM grid_guide_projects WHERE id = ?').run(id);
  });
}
