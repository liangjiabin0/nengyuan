import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENT_MAX_BYTES } from '@/lib/attachments/policy';
import { all, get, run, withTransaction } from '@/lib/db';
import { deleteOpenCodeSessionMapping } from '@/lib/opencode/runtime';
import type {
  ClaimStrategy,
  InventionDisclosure,
  PatentAudit,
  PatentBlocker,
  PatentDraft,
  PatentDrawingsBundle,
  PatentParsedSource,
  PatentProject,
  PatentProjectStatus,
  PatentStage,
  PriorArtReport
} from './types';

const PATENT_STORAGE_ROOT = path.join(process.cwd(), 'storage', 'patents');

const ALLOWED_EXTENSIONS = new Set([
  '.docx',
  '.pdf',
  '.md',
  '.markdown',
  '.txt',
  '.rtf',
  '.tex',
  '.html',
  '.htm'
]);
const MAX_SOURCE_BYTES = ATTACHMENT_MAX_BYTES;

type ProjectRow = {
  id: string;
  title: string;
  status: PatentProjectStatus;
  current_stage: PatentStage;
  user_id: string | null;
  applicant: string | null;
  inventors_json: string | null;
  contact_json: string | null;
  answers_json: string | null;
  blockers_json: string | null;
  quality_score: number;
  error: string | null;
  created_at: string;
  updated_at: string;
};

type SourceRow = {
  id: string;
  project_id: string;
  original_name: string;
  stored_name: string;
  storage_path: string;
  media_type: string;
  extension: string;
  size_bytes: number;
  extracted_text: string;
  parsed_json: string;
};

type ArtifactRow = {
  kind: string;
  content_text: string | null;
  content_json: string | null;
};

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function sanitizeFileName(value: string) {
  const name = path.basename(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return (name || 'source').slice(0, 220);
}

function assertProjectId(value: string) {
  const id = String(value || '').trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('无效的专利项目 ID。');
  return id;
}

function projectDirectory(projectId: string) {
  const root = path.resolve(PATENT_STORAGE_ROOT);
  const target = path.resolve(root, assertProjectId(projectId));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('专利项目路径无效。');
  return target;
}

export function getPatentProjectDirectory(projectId: string) {
  return projectDirectory(projectId);
}

function buildBlockers(_parsed: PatentParsedSource): PatentBlocker[] {
  // 身份确认、技术澄清等一律由 OpenCode（patent-clarification）提问并写 blockers.json，
  // 不在 TypeScript 链路里程序化插入强制问题。
  return [];
}

export async function createPatentProject(input: {
  name: string;
  mediaType: string;
  buffer: Buffer;
  parsed: PatentParsedSource;
  userId?: string;
}) {
  const originalName = sanitizeFileName(input.name);
  const extension = path.extname(originalName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error('仅支持 DOCX、PDF、Markdown/TXT/RTF/HTML/TeX 技术文档，或包含这些文件的 ZIP 包。');
  }
  if (!input.buffer.length) throw new Error('不能上传空文档。');
  if (input.buffer.length > MAX_SOURCE_BYTES) throw new Error('技术文档不能超过 200 MB。');

  const projectId = crypto.randomUUID();
  const sourceId = crypto.randomUUID();
  const storedName = `${sourceId}${extension}`;
  const directory = projectDirectory(projectId);
  const storagePath = path.join(directory, storedName);
  const sha256 = crypto.createHash('sha256').update(input.buffer).digest('hex');
  const title = input.parsed.metadata.title || originalName.replace(/\.[^.]+$/, '');

  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(storagePath, input.buffer, { flag: 'wx' });
  try {
    await withTransaction(async (database) => {
      await database.prepare(
        `INSERT INTO patent_projects
         (id, title, status, current_stage, user_id, applicant, inventors_json, contact_json, answers_json, blockers_json)
         VALUES (?, ?, 'draft', 'source', ?, ?, ?, '{}', '{}', ?)`
      ).run(
        projectId,
        title,
        input.userId || null,
        input.parsed.metadata.applicant || null,
        JSON.stringify(input.parsed.metadata.authors || []),
        JSON.stringify(buildBlockers(input.parsed))
      );
      await database.prepare(
        `INSERT INTO patent_sources
         (id, project_id, original_name, stored_name, storage_path, media_type, extension, size_bytes,
          sha256, extracted_text, parsed_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sourceId,
        projectId,
        originalName,
        storedName,
        storagePath,
        input.mediaType || 'application/octet-stream',
        extension,
        input.buffer.length,
        sha256,
        input.parsed.text,
        JSON.stringify(input.parsed)
      );
    });
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return await getPatentProject(projectId);
}

export async function listPatentProjects(userId?: string) {
  const rows = userId
    ? await all<ProjectRow>('SELECT id, title, status, current_stage, quality_score, error, created_at, updated_at FROM patent_projects WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC', [userId])
    : await all<ProjectRow>('SELECT id, title, status, current_stage, quality_score, error, created_at, updated_at FROM patent_projects ORDER BY updated_at DESC, created_at DESC');
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    currentStage: row.current_stage,
    qualityScore: Number(row.quality_score || 0),
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function assertPatentProjectOwner(projectId: string, userId: string) {
  const id = assertProjectId(projectId);
  const row = await get<ProjectRow>('SELECT * FROM patent_projects WHERE id = ?', [id]);
  if (!row) return { project: null, allowed: false as const };
  if (!row.user_id || row.user_id !== userId) {
    return { project: row, allowed: false as const };
  }
  return { project: row, allowed: true as const };
}

export async function getPatentProject(projectId: string): Promise<PatentProject | null> {
  const id = assertProjectId(projectId);
  const row = await get<ProjectRow>('SELECT * FROM patent_projects WHERE id = ?', [id]);
  if (!row) return null;
  const source = await get<SourceRow>('SELECT * FROM patent_sources WHERE project_id = ? ORDER BY created_at LIMIT 1', [id]);
  const artifacts = await all<ArtifactRow>(
    `SELECT kind, content_text, content_json
     FROM patent_artifacts
     WHERE project_id = ? AND version = 1`,
    [id]
  );
  const byKind = new Map(artifacts.map((artifact) => [artifact.kind, artifact]));
  const jsonArtifact = <T>(kind: string) => parseJson<T | undefined>(byKind.get(kind)?.content_json, undefined);
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    currentStage: row.current_stage,
    applicant: row.applicant || '',
    inventors: parseJson<string[]>(row.inventors_json, []),
    contact: parseJson<Record<string, string>>(row.contact_json, {}),
    answers: parseJson<Record<string, string>>(row.answers_json, {}),
    blockers: parseJson<PatentBlocker[]>(row.blockers_json, []),
    qualityScore: Number(row.quality_score || 0),
    error: row.error || undefined,
    source: source
      ? {
          id: source.id,
          name: source.original_name,
          mediaType: source.media_type,
          extension: source.extension,
          size: Number(source.size_bytes),
          parsed: parseJson<PatentParsedSource>(source.parsed_json, {
            text: source.extracted_text,
            charCount: source.extracted_text.length,
            paragraphs: [],
            headings: [],
            tables: [],
            figures: [],
            formulas: [],
            formulaObjectsDetected: 0,
            formulaObjectsRecovered: 0,
            warnings: [],
            metadata: {}
          })
        }
      : undefined,
    disclosure: jsonArtifact<InventionDisclosure>('disclosure'),
    clarification: jsonArtifact<PatentProject['clarification']>('clarification'),
    priorArt: jsonArtifact<PriorArtReport>('prior_art'),
    strategy: jsonArtifact<ClaimStrategy>('strategy'),
    drawings: jsonArtifact<PatentDrawingsBundle>('drawings'),
    draft: jsonArtifact<PatentDraft>('draft'),
    audit: jsonArtifact<PatentAudit>('audit'),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/** API 只返回 UI 所需的解析摘要，避免反复传输整篇源文、段落和表格。 */
export function toPatentClientProject(project: PatentProject | null): PatentProject | null {
  if (!project) return null;
  return {
    ...project,
    source: project.source
      ? {
          ...project.source,
          parsed: {
            ...project.source.parsed,
            text: '',
            paragraphs: [],
            headings: [],
            tables: [],
            figures: [],
            formulas: []
          }
        }
      : project.source
  };
}

export async function clearPatentArtifacts(projectId: string, kinds: string[]) {
  const id = assertProjectId(projectId);
  if (!kinds.length) return;
  const placeholders = kinds.map(() => '?').join(', ');
  await run(`DELETE FROM patent_artifacts WHERE project_id = ? AND kind IN (${placeholders})`, [id, ...kinds]);
  await run('UPDATE patent_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

export async function updatePatentProject(
  projectId: string,
  input: {
    title?: string;
    applicant?: string;
    inventors?: string[];
    contact?: Record<string, string>;
    answers?: Record<string, string>;
  }
) {
  const project = await getPatentProject(projectId);
  if (!project) throw new Error('专利项目不存在。');
  const applicant = input.applicant?.trim() ?? project.applicant;
  const inventors = input.inventors?.map((item) => item.trim()).filter(Boolean) ?? project.inventors;
  const contact = input.contact ?? project.contact;
  const answers = { ...project.answers, ...(input.answers || {}) };
  const previousAnswers = project.answers;
  const applicantConfirmed =
    input.applicant !== undefined
    || project.blockers.some((item) => item.id === 'confirm-applicant' && item.resolved);
  const inventorsConfirmed =
    input.inventors !== undefined
    || project.blockers.some((item) => item.id === 'confirm-inventors' && item.resolved);
  const blockers = project.blockers.map((blocker) => {
    if (blocker.id === 'confirm-applicant') {
      return {
        ...blocker,
        resolved: applicantConfirmed && Boolean(applicant),
        answer: applicantConfirmed ? applicant || undefined : blocker.answer
      };
    }
    if (blocker.id === 'confirm-inventors') {
      const answer = inventors.join('、');
      return {
        ...blocker,
        resolved: inventorsConfirmed && inventors.length > 0,
        answer: inventorsConfirmed ? answer || undefined : blocker.answer
      };
    }
    const answer = answers[blocker.id]?.trim();
    return answer ? { ...blocker, resolved: true, answer } : blocker;
  });
  const technicalChanged = Object.keys(answers).some((key) => {
    if (['confirm-applicant', 'confirm-inventors'].includes(key)) return false;
    return (answers[key] || '').trim() !== (previousAnswers[key] || '').trim();
  });
  if (technicalChanged) {
    await clearPatentArtifacts(project.id, [
      'disclosure',
      'clarification',
      'prior_art',
      'strategy',
      'drawings',
      'draft',
      'audit'
    ]);
    // OpenCode 工作区内还有 STATUS.json、claims.txt 等独立副本；若不同时清理，
    // 后续续跑会把用户的新答复错误地套到旧草稿上。
    fsSync.rmSync(path.join(projectDirectory(project.id), 'opencode'), {
      recursive: true,
      force: true
    });
    deleteOpenCodeSessionMapping(
      `patent:${project.id}`,
      path.join(process.cwd(), 'storage', 'patent-opencode-sessions.json')
    );
  }
  const hasP0 = blockers.some((blocker) => blocker.severity === 'P0' && !blocker.resolved);
  await run(
    `UPDATE patent_projects
     SET title = ?, applicant = ?, inventors_json = ?, contact_json = ?, answers_json = ?,
         blockers_json = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      input.title?.trim() || project.title,
      applicant || null,
      JSON.stringify(inventors),
      JSON.stringify(contact),
      JSON.stringify(answers),
      JSON.stringify(blockers),
      hasP0
        ? 'needs_input'
        : project.status === 'needs_input' || technicalChanged
          ? 'draft'
          : project.status,
      project.id
    ]
  );
  return await getPatentProject(project.id);
}

export async function setPatentProgress(
  projectId: string,
  patch: {
    status?: PatentProjectStatus;
    stage?: PatentStage;
    qualityScore?: number;
    error?: string | null;
    blockers?: PatentBlocker[];
    /** 仅合并答复/身份字段，不清理已有产物。 */
    answers?: Record<string, string>;
    applicant?: string;
    inventors?: string[];
  }
) {
  const project = await getPatentProject(projectId);
  if (!project) throw new Error('专利项目不存在。');
  const answers = patch.answers ? { ...project.answers, ...patch.answers } : project.answers;
  const applicant = patch.applicant?.trim() || project.applicant;
  const inventors = patch.inventors?.length ? patch.inventors : project.inventors;
  await run(
    `UPDATE patent_projects
     SET status = ?, current_stage = ?, quality_score = ?, error = ?, blockers_json = ?,
         answers_json = ?, applicant = ?, inventors_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      patch.status || project.status,
      patch.stage || project.currentStage,
      patch.qualityScore ?? project.qualityScore,
      patch.error === undefined ? project.error || null : patch.error,
      JSON.stringify(patch.blockers || project.blockers),
      JSON.stringify(answers),
      applicant || null,
      JSON.stringify(inventors),
      project.id
    ]
  );
}

export async function savePatentArtifact(projectId: string, kind: string, content: unknown, text?: string) {
  const id = assertProjectId(projectId);
  await run(
    `INSERT INTO patent_artifacts
     (id, project_id, kind, version, content_text, content_json)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(project_id, kind, version) DO UPDATE SET
       content_text = excluded.content_text,
       content_json = excluded.content_json,
       updated_at = CURRENT_TIMESTAMP`,
    [crypto.randomUUID(), id, kind, text || null, JSON.stringify(content)]
  );
  await run('UPDATE patent_projects SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
}

export async function getPatentSourceRow(projectId: string) {
  return await get<SourceRow>('SELECT * FROM patent_sources WHERE project_id = ? ORDER BY created_at LIMIT 1', [
    assertProjectId(projectId)
  ]) || null;
}

export async function deletePatentProject(projectId: string) {
  const id = assertProjectId(projectId);
  await withTransaction(async (database) => {
    await database.prepare('DELETE FROM patent_artifacts WHERE project_id = ?').run(id);
    await database.prepare('DELETE FROM patent_sources WHERE project_id = ?').run(id);
    await database.prepare('DELETE FROM patent_projects WHERE id = ?').run(id);
  });
  await fs.rm(projectDirectory(id), { recursive: true, force: true }).catch(() => undefined);
}
