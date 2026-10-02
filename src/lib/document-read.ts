import fs from 'node:fs/promises';
import { get } from './db';
import { readPaperBodyText } from './paper-body';
import { provenanceHeader } from './content-provenance';
import { resolveMentorFilePath } from './mentors';

export type DocumentRead = {
  kind: 'paper' | 'mentor' | 'project';
  key: string;
  title: string;
  charCount: number;
  truncated: boolean;
  text: string;
};

async function readMentor(mentorKey: string, maxChars: number): Promise<DocumentRead | null> {
  const row = await get<Record<string, unknown>>(
    'SELECT mentor_key, name, school, college, content, file_path FROM mentor_profiles WHERE mentor_key = ?',
    [mentorKey]
  );
  if (!row) return null;

  let text = String(row.content || '');
  const filePath = resolveMentorFilePath(String(row.file_path || '').trim());
  if (filePath) {
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      // keep content column
    }
  }
  if (!text.trim()) return null;

  const truncated = text.length > maxChars;
  const fullLength = text.length;
  if (truncated) text = `${text.slice(0, maxChars)}…`;

  const title = `${row.name || '导师'} · ${row.school || ''}`;
  return {
    kind: 'mentor',
    key: String(row.mentor_key),
    title,
    charCount: truncated ? fullLength : text.length,
    truncated,
    text: `${provenanceHeader('mentor_profile')}\n导师档案: ${title}\n${text}`
  };
}

async function resolveMentorKey(anchor: string) {
  const trimmed = anchor.trim().replace(/^mentor:/i, '');
  if (!trimmed) return null;

  const byKey = await get<{ mentor_key: string }>(
    'SELECT mentor_key FROM mentor_profiles WHERE mentor_key = ?',
    [trimmed]
  );
  if (byKey) return byKey.mentor_key;

  const namePart = trimmed.split(/[·|｜|+]/)[0]?.trim() || trimmed;
  const byName = await get<{ mentor_key: string }>(
    'SELECT mentor_key FROM mentor_profiles WHERE name = ? OR name LIKE ? ORDER BY LENGTH(name) ASC LIMIT 1',
    [namePart, `%${namePart}%`]
  );
  return byName?.mentor_key || null;
}

/** 按 anchor 读取论文全文、导师档案或项目（先论文，再导师） */
export async function readDocument(anchor: string, maxChars = 200_000): Promise<DocumentRead | null> {
  const trimmed = String(anchor || '').trim().replace(/^《|》$/g, '');
  if (!trimmed) return null;

  const paper = await readPaperBodyText(trimmed, maxChars);
  if (paper) {
    return {
      kind: 'paper',
      key: paper.paperKey,
      title: paper.title,
      charCount: paper.charCount,
      truncated: paper.truncated,
      text: paper.text
    };
  }

  const mentorKey = await resolveMentorKey(trimmed);
  if (mentorKey) {
    return readMentor(mentorKey, maxChars);
  }

  return null;
}
