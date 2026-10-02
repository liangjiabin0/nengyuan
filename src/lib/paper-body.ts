import { all, get } from './db';
import { provenanceHeader, type ContentKind } from './content-provenance';

const DEFAULT_MAX_CHARS = 200_000;

export type PaperBodyRead = {
  paperKey: string;
  title: string;
  authors: string;
  sectionCount: number;
  charCount: number;
  truncated: boolean;
  contentKind: ContentKind;
  text: string;
};

async function resolvePaper(anchor: string) {
  const trimmed = anchor.trim();
  if (!trimmed) return null;

  const byKey = await get<Record<string, unknown>>(
    'SELECT paper_key, title, authors, abstract, file_path, pdf_path FROM paper_documents WHERE paper_key = ?',
    [trimmed]
  );
  if (byKey) return byKey;

  const byTitle = await get<Record<string, unknown>>(
    'SELECT paper_key, title, authors, abstract, file_path, pdf_path FROM paper_documents WHERE title LIKE ? ORDER BY updated_at DESC LIMIT 1',
    [`%${trimmed.slice(0, 80)}%`]
  );
  if (byTitle) return byTitle;

  const byChunk = await get<Record<string, unknown>>(
    `SELECT p.paper_key, p.title, p.authors, p.abstract, p.file_path, p.pdf_path
     FROM paper_chunks c JOIN paper_documents p ON p.paper_key = c.paper_key
     WHERE c.chunk_key = ? LIMIT 1`,
    [trimmed]
  );
  return byChunk || null;
}

export async function readPaperBodyText(anchor: string, maxChars = DEFAULT_MAX_CHARS): Promise<PaperBodyRead | null> {
  const paper = await resolvePaper(anchor);
  if (!paper) return null;

  const paperKey = String(paper.paper_key);
  const parents = await all<{ section: string; text: string; chunk_index: number }>(
    `SELECT section, text, chunk_index FROM paper_chunks
     WHERE paper_key = ? AND chunk_role = 'parent' AND section != '参考文献'
     ORDER BY chunk_index`,
    [paperKey]
  );

  let parts: string[] = [];
  if (parents.length) {
    parts = parents.map((row) => {
      const header = row.section ? `## ${row.section}\n` : '';
      return `${header}${row.text}`;
    });
  } else {
    const children = await all<{ section: string; text: string; chunk_index: number }>(
      `SELECT section, text, chunk_index FROM paper_chunks
       WHERE paper_key = ? AND chunk_role = 'child'
         AND (section IS NULL OR section != '参考文献')
       ORDER BY chunk_index`,
      [paperKey]
    );
    parts = children.map((row) => row.text);
  }

  let text = parts.join('\n\n').replace(/\s+/g, ' ').trim();
  if (!text && paper.abstract) {
    text = `【仅摘要可用，正文 chunk 未入库】\n${String(paper.abstract)}`;
  }

  const truncated = text.length > maxChars;
  const fullLength = text.length;
  if (truncated) text = `${text.slice(0, maxChars)}…`;

  return {
    paperKey,
    title: String(paper.title || ''),
    authors: String(paper.authors || ''),
    sectionCount: parents.length || parts.length,
    charCount: truncated ? fullLength : text.length,
    truncated,
    contentKind: 'paper_body_full',
    text: `${provenanceHeader('paper_body_full')}\n论文: ${paper.title}\n${text}`
  };
}
