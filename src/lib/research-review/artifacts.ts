import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, run } from '../db';
import { researchReviewWorkspaceRoot } from '../opencode/research-review-workspace';
import {
  buildResearchReviewDocx,
  prepareResearchReviewMarkdown,
  researchReviewFileName
} from './export';

export type ResearchReviewArtifact = {
  id: string;
  conversationId: string;
  messageId: string;
  fileName: string;
  byteSize: number;
  reportTitle: string;
  qualityScore: number;
  qualityMax: number;
  qualityOk: boolean;
  createdAt: string;
  downloadUrl: string;
};

type ArtifactRow = {
  id: string;
  conversation_id: string;
  message_id: string;
  file_name: string;
  storage_path: string;
  markdown_path: string | null;
  report_title: string | null;
  byte_size: number;
  quality_score: number | null;
  quality_max: number | null;
  quality_ok: number;
  created_at: string;
};

function artifactsDir(conversationId: string) {
  return path.join(researchReviewWorkspaceRoot(conversationId), 'artifacts');
}

function extractReportTitle(markdown: string, fallback: string) {
  const cleaned = prepareResearchReviewMarkdown(markdown);
  for (const line of cleaned.split('\n')) {
    const h1 = /^#\s+(.+)$/.exec(line.trim());
    if (h1?.[1]) return h1[1].trim().slice(0, 120);
    if (/^复杂场景|^微网|^配电网|^研究综述/.test(line.trim()) && line.trim().length < 80) {
      return line.trim().replace(/^#+\s*/, '').slice(0, 120);
    }
  }
  return fallback.slice(0, 120) || '科研综述';
}

function toPublicArtifact(row: ArtifactRow): ResearchReviewArtifact {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    messageId: row.message_id,
    fileName: row.file_name,
    byteSize: Number(row.byte_size || 0),
    reportTitle: row.report_title || row.file_name.replace(/\.docx$/i, ''),
    qualityScore: Number(row.quality_score || 0),
    qualityMax: Number(row.quality_max || 0),
    qualityOk: Boolean(row.quality_ok),
    createdAt: row.created_at,
    downloadUrl: `/api/research-review/artifacts/${encodeURIComponent(row.id)}`
  };
}

export function buildResearchReviewCompletionNote(input: {
  reportTitle: string;
  fileName: string;
  byteSize: number;
  paperCount?: number;
}) {
  const sizeKb = globalThis.Math.max(1, globalThis.Math.round(input.byteSize / 1024));
  const scope = input.paperCount
    ? `已基于本会话 ${input.paperCount} 篇文献`
    : '已基于本会话上传文献';
  return [
    `${scope}完成研究报告。`,
    '',
    `题目：${input.reportTitle}`,
    `文件：${input.fileName}（约 ${sizeKb} KB）`,
    '',
    '完整 Word 已放到对话右侧的「附件查看」，请到那里下载。对话里不再附文件。'
  ].join('\n');
}

export async function createResearchReviewArtifact(input: {
  conversationId: string;
  messageId: string;
  markdown: string;
  conversationTitle?: string;
  paperCount?: number;
}) {
  const conversationId = input.conversationId.trim();
  const messageId = input.messageId.trim();
  if (!conversationId || !messageId) {
    throw new Error('缺少会话或消息 ID，无法生成 Word 附件。');
  }

  const markdown = prepareResearchReviewMarkdown(input.markdown);
  if (!markdown.trim()) {
    throw new Error('没有可写入 Word 的综述正文。');
  }

  const reportTitle = extractReportTitle(
    markdown,
    input.conversationTitle || '科研综述'
  );
  const fileName = researchReviewFileName(reportTitle);
  const bytes = await buildResearchReviewDocx(markdown, reportTitle);

  const dir = path.join(artifactsDir(conversationId), messageId);
  fs.mkdirSync(dir, { recursive: true });
  const docxPath = path.join(dir, fileName);
  const mdPath = path.join(dir, 'report.md');
  fs.writeFileSync(docxPath, bytes);
  fs.writeFileSync(mdPath, `${markdown.trim()}\n`, 'utf8');

  const id = crypto.randomUUID();
  const relativeDocx = path
    .relative(process.cwd(), docxPath)
    .split(path.sep)
    .join('/');
  const relativeMd = path
    .relative(process.cwd(), mdPath)
    .split(path.sep)
    .join('/');

  await run(
    `INSERT INTO research_review_artifacts
      (id, conversation_id, message_id, file_name, storage_path, markdown_path, report_title, byte_size, quality_score, quality_max, quality_ok)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      conversationId,
      messageId,
      fileName,
      relativeDocx,
      relativeMd,
      reportTitle,
      bytes.length,
      0,
      0,
      0
    ],
    true
  );

  const row = await getArtifactRow(id);
  if (!row) throw new Error('Word 附件写入后未能读取。');
  return {
    artifact: toPublicArtifact(row),
    markdown,
    reportTitle,
    completionNote: buildResearchReviewCompletionNote({
      reportTitle,
      fileName,
      byteSize: bytes.length,
      paperCount: input.paperCount
    })
  };
}

async function getArtifactRow(id: string) {
  return get<ArtifactRow>(
    `SELECT id, conversation_id, message_id, file_name, storage_path, markdown_path, report_title,
            byte_size, quality_score, quality_max, quality_ok, created_at
     FROM research_review_artifacts WHERE id = ?`,
    [id]
  );
}

export async function getResearchReviewArtifact(id: string) {
  const row = await getArtifactRow(id);
  return row ? toPublicArtifact(row) : null;
}

export async function getResearchReviewArtifactFile(id: string) {
  const row = await getArtifactRow(id);
  if (!row) return null;
  const abs = path.resolve(process.cwd(), row.storage_path);
  if (!abs.startsWith(path.resolve(process.cwd(), 'storage', 'research-review'))) {
    throw new Error('非法附件路径。');
  }
  if (!fs.existsSync(abs)) return null;
  return {
    artifact: toPublicArtifact(row),
    absolutePath: abs,
    bytes: fs.readFileSync(abs)
  };
}

export async function listResearchReviewArtifacts(conversationId: string) {
  const rows = await all<ArtifactRow>(
    `SELECT id, conversation_id, message_id, file_name, storage_path, markdown_path, report_title,
            byte_size, quality_score, quality_max, quality_ok, created_at
     FROM research_review_artifacts
     WHERE conversation_id = ?
     ORDER BY created_at DESC, id DESC`,
    [conversationId]
  );
  return rows.map(toPublicArtifact);
}

export async function listResearchReviewArtifactsByMessages(conversationId: string) {
  const artifacts = await listResearchReviewArtifacts(conversationId);
  const byMessage = new Map<string, ResearchReviewArtifact[]>();
  for (const artifact of artifacts) {
    const current = byMessage.get(artifact.messageId) || [];
    current.push(artifact);
    byMessage.set(artifact.messageId, current);
  }
  return byMessage;
}

export async function readResearchReviewArtifactMarkdown(messageId: string, conversationId: string) {
  const row = await get<ArtifactRow>(
    `SELECT id, conversation_id, message_id, file_name, storage_path, markdown_path, report_title,
            byte_size, quality_score, quality_max, quality_ok, created_at
     FROM research_review_artifacts
     WHERE conversation_id = ? AND message_id = ?
     ORDER BY created_at DESC LIMIT 1`,
    [conversationId, messageId]
  );
  if (!row?.markdown_path) return '';
  const abs = path.resolve(process.cwd(), row.markdown_path);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

export async function deleteResearchReviewArtifacts(conversationId: string) {
  const rows = await all<ArtifactRow>(
    `SELECT id, conversation_id, message_id, file_name, storage_path, markdown_path, report_title,
            byte_size, quality_score, quality_max, quality_ok, created_at
     FROM research_review_artifacts WHERE conversation_id = ?`,
    [conversationId]
  );
  await run('DELETE FROM research_review_artifacts WHERE conversation_id = ?', [conversationId], true);
  const root = artifactsDir(conversationId);
  if (fs.existsSync(root)) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  return rows.length;
}
