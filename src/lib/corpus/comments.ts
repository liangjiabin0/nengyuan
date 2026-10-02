import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db';
import { isAdminUser } from '../auth/users';
import type { AuthUser } from '../auth/types';
import {
  CORPUS_BROWSE_DOMAINS,
  isCorpusBrowseDomain,
  resolveCorpusBrowsePath,
  type CorpusBrowseDomain
} from './browse';
import { corpusRecordFileName, getCorpusRoot } from './schema';

export const CORPUS_COMMENTS_START = '<!-- corpus-comments -->';
export const CORPUS_COMMENTS_END = '<!-- /corpus-comments -->';

export type CorpusFileComment = {
  id: string;
  relativePath: string;
  recordKey: string | null;
  domain: string;
  body: string;
  userId: string;
  authorName: string;
  createdAt: string;
  updatedAt: string;
};

type CommentRow = {
  id: string;
  relative_path: string;
  record_key: string | null;
  domain: string;
  body: string;
  user_id: string;
  author_name: string;
  created_at: string;
  updated_at: string;
};

function mapComment(row: CommentRow): CorpusFileComment {
  return {
    id: row.id,
    relativePath: row.relative_path,
    recordKey: row.record_key || null,
    domain: row.domain,
    body: row.body,
    userId: row.user_id,
    authorName: row.author_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function stripCorpusCommentsBlock(markdown: string) {
  const start = markdown.indexOf(CORPUS_COMMENTS_START);
  if (start < 0) return markdown;
  const end = markdown.indexOf(CORPUS_COMMENTS_END, start);
  const before = markdown.slice(0, start);
  const after = end < 0 ? '' : markdown.slice(end + CORPUS_COMMENTS_END.length);
  return `${before}${after}`.replace(/\s+$/, '');
}

export function formatCorpusCommentsBlock(comments: CorpusFileComment[]) {
  if (!comments.length) return '';
  const lines = comments.map((item) => {
    const when = formatCommentTime(item.updatedAt || item.createdAt);
    const text = item.body.replace(/\s+/g, ' ').trim();
    return `- **${item.authorName}**（${when}）：${text}`;
  });
  return [
    CORPUS_COMMENTS_START,
    '## 用户备注',
    '',
    ...lines,
    CORPUS_COMMENTS_END
  ].join('\n');
}

export function applyCorpusCommentsBlock(markdown: string, comments: CorpusFileComment[]) {
  const body = stripCorpusCommentsBlock(markdown).replace(/\s+$/, '');
  const block = formatCorpusCommentsBlock(comments);
  if (!block) return `${body}\n`;
  return `${body}\n\n${block}\n`;
}

export function extractFrontmatterField(raw: string, field: string) {
  if (!raw.startsWith('---')) return '';
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return '';
  const match = raw.slice(3, end).match(new RegExp(`^\\s*${field}:\\s*(.+)\\s*$`, 'm'));
  if (!match) return '';
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

export function formatCommentTime(value: string) {
  if (!value) return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 19).replace('T', ' ');
  return value;
}

function nowStamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

export async function listCorpusComments(input: { relativePath?: string; recordKey?: string }) {
  const relativePath = String(input.relativePath || '').trim();
  const recordKey = String(input.recordKey || '').trim();
  if (!relativePath && !recordKey) return [] as CorpusFileComment[];

  const clauses: string[] = [];
  const params: string[] = [];
  if (relativePath) {
    clauses.push('relative_path = ?');
    params.push(relativePath);
  }
  if (recordKey) {
    clauses.push('record_key = ?');
    params.push(recordKey);
  }
  const rows = await getDb()
    .prepare(
      `SELECT id, relative_path, record_key, domain, body, user_id, author_name, created_at, updated_at
       FROM corpus_file_comments
       WHERE ${clauses.join(' OR ')}
       ORDER BY created_at ASC, id ASC`
    )
    .all<CommentRow>(...params);
  return rows.map(mapComment);
}

export async function getCorpusCommentById(id: string) {
  const row = await getDb()
    .prepare(
      `SELECT id, relative_path, record_key, domain, body, user_id, author_name, created_at, updated_at
       FROM corpus_file_comments WHERE id = ?`
    )
    .get<CommentRow>(id);
  return row ? mapComment(row) : null;
}

export async function createCorpusComment(input: {
  relativePath: string;
  recordKey?: string | null;
  domain: CorpusBrowseDomain;
  body: string;
  userId: string;
  authorName: string;
}) {
  const body = String(input.body || '').trim();
  if (!body) throw new Error('备注内容不能为空。');
  const authorName = String(input.authorName || '').trim();
  if (!authorName) throw new Error('请填写备注人姓名。');
  const id = randomUUID();
  const stamp = nowStamp();
  await getDb()
    .prepare(
      `INSERT INTO corpus_file_comments
        (id, relative_path, record_key, domain, body, user_id, author_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      input.relativePath,
      input.recordKey || null,
      input.domain,
      body,
      input.userId,
      authorName,
      stamp,
      stamp
    );
  const created = await getCorpusCommentById(id);
  if (!created) throw new Error('备注写入失败。');
  await materializeCorpusComments({
    relativePath: created.relativePath,
    recordKey: created.recordKey,
    domain: created.domain
  });
  return created;
}

export async function updateCorpusComment(input: {
  id: string;
  body?: string;
  authorName?: string;
  user: AuthUser;
}) {
  const existing = await getCorpusCommentById(input.id);
  if (!existing) return null;
  if (existing.userId !== input.user.id && !isAdminUser(input.user)) {
    throw Object.assign(new Error('只能修改自己写的备注。'), { status: 403 });
  }
  const body = input.body !== undefined ? String(input.body || '').trim() : existing.body;
  const authorName = input.authorName !== undefined
    ? String(input.authorName || '').trim()
    : existing.authorName;
  if (!body) throw new Error('备注内容不能为空。');
  if (!authorName) throw new Error('请填写备注人姓名。');
  await getDb()
    .prepare(
      `UPDATE corpus_file_comments SET body = ?, author_name = ?, updated_at = ? WHERE id = ?`
    )
    .run(body, authorName, nowStamp(), input.id);
  const updated = await getCorpusCommentById(input.id);
  if (updated) {
    await materializeCorpusComments({
      relativePath: updated.relativePath,
      recordKey: updated.recordKey,
      domain: updated.domain
    });
  }
  return updated;
}

export async function deleteCorpusComment(id: string, user: AuthUser) {
  const existing = await getCorpusCommentById(id);
  if (!existing) return false;
  if (existing.userId !== user.id && !isAdminUser(user)) {
    throw Object.assign(new Error('只能删除自己写的备注。'), { status: 403 });
  }
  await getDb().prepare('DELETE FROM corpus_file_comments WHERE id = ?').run(id);
  await materializeCorpusComments({
    relativePath: existing.relativePath,
    recordKey: existing.recordKey,
    domain: existing.domain
  });
  return true;
}

function resolveCommentFile(input: {
  relativePath?: string | null;
  recordKey?: string | null;
  domain?: string | null;
}) {
  const relativePath = String(input.relativePath || '').trim();
  if (relativePath) {
    const resolved = resolveCorpusBrowsePath(relativePath);
    if (resolved) return resolved;
  }

  const recordKey = String(input.recordKey || '').trim();
  const domainHint = String(input.domain || '').trim();
  const domains = [
    ...(isCorpusBrowseDomain(domainHint) ? [domainHint] : []),
    ...CORPUS_BROWSE_DOMAINS.filter((item) => item !== domainHint)
  ];
  if (recordKey) {
    const name = corpusRecordFileName(recordKey);
    for (const domain of domains) {
      const resolved = resolveCorpusBrowsePath(`${domain}/${name}`);
      if (resolved) return resolved;
    }
  }
  return null;
}

export async function materializeCorpusComments(input: {
  relativePath?: string | null;
  recordKey?: string | null;
  domain?: string | null;
}) {
  const resolved = resolveCommentFile(input);
  const comments = await listCorpusComments({
    relativePath: resolved?.relativePath || input.relativePath || undefined,
    recordKey: input.recordKey || undefined
  });
  if (!resolved) return { written: false, relativePath: input.relativePath || '' };

  const current = fs.readFileSync(resolved.absolutePath, 'utf8');
  const next = applyCorpusCommentsBlock(current, comments);
  if (next !== current) {
    fs.writeFileSync(resolved.absolutePath, next, 'utf8');
  }
  if (resolved.relativePath && comments.some((item) => item.relativePath !== resolved.relativePath)) {
    await getDb()
      .prepare(
        `UPDATE corpus_file_comments
         SET relative_path = ?
         WHERE relative_path = ? OR (record_key IS NOT NULL AND record_key = ?)`
      )
      .run(resolved.relativePath, input.relativePath || resolved.relativePath, input.recordKey || '');
  }
  return { written: true, relativePath: resolved.relativePath };
}

export async function materializeAllCorpusComments(root = getCorpusRoot()) {
  const rows = await getDb()
    .prepare(
      `SELECT DISTINCT relative_path, record_key, domain FROM corpus_file_comments`
    )
    .all<{ relative_path: string; record_key: string | null; domain: string }>();
  let written = 0;
  for (const row of rows) {
    const result = await materializeCorpusComments({
      relativePath: row.relative_path,
      recordKey: row.record_key,
      domain: row.domain
    });
    if (result.written) written += 1;
  }
  if (!rows.length && !fs.existsSync(root)) return { written: 0 };
  return { written };
}

export function canMutateComment(comment: CorpusFileComment, user: AuthUser | null | undefined) {
  if (!user) return false;
  return comment.userId === user.id || isAdminUser(user);
}
