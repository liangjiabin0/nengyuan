import type { Database } from './db';
import { all, getColumns, getDb } from './db';
import { hashText } from './normalize';
import { isReferenceLikeParagraph } from './paper-segment';
import type { SearchResult } from './search-index';

export const PARENT_MAX_CHARS = 4800;
export const CHILD_MAX_CHARS = 520;

export type PaperChunkRole = 'parent' | 'child';

export type ParentChunkRow = {
  chunk_key: string;
  paper_key: string;
  chunk_index: number;
  page_start?: number | null;
  page_end?: number | null;
  section?: string;
  text: string;
  token_estimate?: number;
  parent_key?: string | null;
  chunk_role?: string;
};

async function runInDb(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) await db.prepare(sql).run(...params);
  else await db.prepare(sql).run();
}

function normalizeWhitespace(text: string) {
  return text
    .replace(/\r/g, '\n')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ /g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitParagraphsPreservingMath(text: string) {
  const source = text.replace(/\r/g, '\n');
  const parts: string[] = [];
  const re = /\$\$[\s\S]*?\$\$/g;
  let last = 0;
  for (const match of source.matchAll(re)) {
    const start = match.index ?? 0;
    parts.push(...source.slice(last, start).split(/\n\s*\n/g));
    parts.push(match[0]);
    last = start + match[0].length;
  }
  parts.push(...source.slice(last).split(/\n\s*\n/g));
  return parts.map(normalizeWhitespace).filter(Boolean);
}

function sectionFor(text: string) {
  const match = /^(摘要|Abstract|引言|绪论|结论|参考文献|\d+(?:\.\d+)*\s*[^\n]{1,40}|[一二三四五六七八九十]+、[^\n]{1,40})/m.exec(text);
  return match ? normalizeWhitespace(match[1]).slice(0, 80) : '';
}

function parentChunkKey(paperKey: string, section: string, index: number, text: string) {
  return `paper-parent:${hashText(`${paperKey}|${section}|${index}|${text.slice(0, 120)}`).slice(0, 24)}`;
}

function childChunkKey(paperKey: string, parentKey: string, index: number, text: string) {
  return `paper-chunk:${hashText(`${paperKey}|${parentKey}|${index}|${text.slice(0, 80)}`).slice(0, 24)}`;
}

export function splitParentIntoChildren(parent: {
  chunkKey: string;
  paperKey: string;
  parentIndex: number;
  section: string;
  text: string;
}) {
  const paragraphs = splitParagraphsPreservingMath(parent.text);
  const children: Array<{
    chunkKey: string;
    paperKey: string;
    chunkIndex: number;
    parentKey: string;
    section: string;
    text: string;
    tokenEstimate: number;
    chunkRole: 'child';
  }> = [];
  let buffer = '';
  let childIndex = 0;

  const flush = () => {
    const value = normalizeWhitespace(buffer);
    if (!value) return;
    children.push({
      chunkKey: childChunkKey(parent.paperKey, parent.chunkKey, childIndex, value),
      paperKey: parent.paperKey,
      chunkIndex: 10_000 + parent.parentIndex * 100 + childIndex,
      parentKey: parent.chunkKey,
      section: parent.section,
      text: value,
      tokenEstimate: Math.ceil(value.length / 2),
      chunkRole: 'child'
    });
    childIndex += 1;
    buffer = '';
  };

  for (const paragraph of paragraphs) {
    if ((buffer + '\n\n' + paragraph).length > CHILD_MAX_CHARS) flush();
    buffer += `${buffer ? '\n\n' : ''}${paragraph}`;
  }
  flush();

  if (!children.length && parent.text.trim()) {
    children.push({
      chunkKey: childChunkKey(parent.paperKey, parent.chunkKey, 0, parent.text),
      paperKey: parent.paperKey,
      chunkIndex: 10_000 + parent.parentIndex * 100,
      parentKey: parent.chunkKey,
      section: parent.section,
      text: parent.text,
      tokenEstimate: Math.ceil(parent.text.length / 2),
      chunkRole: 'child'
    });
  }

  return children;
}

export function splitTextIntoParentChildChunks(text: string, paperKey: string) {
  const paragraphs = splitParagraphsPreservingMath(text);
  const sectionBlocks: Array<{ section: string; text: string }> = [];
  let currentSection = '';
  let currentParagraphs: string[] = [];
  let currentLen = 0;

  const flushBlock = () => {
    if (!currentParagraphs.length) return;
    sectionBlocks.push({
      section: currentSection,
      text: currentParagraphs.join('\n\n')
    });
    currentParagraphs = [];
    currentLen = 0;
  };

  for (const paragraph of paragraphs) {
    if (/^(参考文献|REFERENCES|References)\s*[:：]?$/i.test(paragraph.trim())) {
      flushBlock();
      break;
    }
    if (isReferenceLikeParagraph(paragraph) && currentParagraphs.length > 2) {
      flushBlock();
      break;
    }
    const detected = sectionFor(paragraph);
    if (detected && detected !== currentSection && currentParagraphs.length) {
      flushBlock();
      currentSection = detected;
    } else if (detected && !currentSection) {
      currentSection = detected;
    }
    if (currentLen + paragraph.length > PARENT_MAX_CHARS && currentParagraphs.length) {
      flushBlock();
    }
    currentParagraphs.push(paragraph);
    currentLen += paragraph.length;
  }
  flushBlock();

  const parents: Array<{
    chunkKey: string;
    paperKey: string;
    chunkIndex: number;
    pageStart: null;
    pageEnd: null;
    section: string;
    text: string;
    tokenEstimate: number;
    parentKey: null;
    chunkRole: 'parent';
  }> = [];
  const children: Array<{
    chunkKey: string;
    paperKey: string;
    chunkIndex: number;
    pageStart: null;
    pageEnd: null;
    section: string;
    text: string;
    tokenEstimate: number;
    parentKey: string;
    chunkRole: 'child';
  }> = [];

  sectionBlocks.forEach((block, parentIndex) => {
    const parentKey = parentChunkKey(paperKey, block.section || `section-${parentIndex}`, parentIndex, block.text);
    parents.push({
      chunkKey: parentKey,
      paperKey,
      chunkIndex: parentIndex,
      pageStart: null,
      pageEnd: null,
      section: block.section,
      text: block.text,
      tokenEstimate: Math.ceil(block.text.length / 2),
      parentKey: null,
      chunkRole: 'parent'
    });
    for (const child of splitParentIntoChildren({
      chunkKey: parentKey,
      paperKey,
      parentIndex,
      section: block.section,
      text: block.text
    })) {
      children.push({
        chunkKey: child.chunkKey,
        paperKey: child.paperKey,
        chunkIndex: child.chunkIndex,
        pageStart: null,
        pageEnd: null,
        section: child.section,
        text: child.text,
        tokenEstimate: child.tokenEstimate,
        parentKey: child.parentKey,
        chunkRole: 'child'
      });
    }
  });

  return { parents, children };
}

export async function fetchParentChunks(parentKeys: string[]) {
  const unique = [...new Set(parentKeys.filter(Boolean))];
  if (!unique.length) return new Map<string, ParentChunkRow>();

  const rows = await all<ParentChunkRow & { paper_title?: string }>(
    `SELECT c.chunk_key, c.paper_key, c.chunk_index, c.page_start, c.page_end, c.section, c.text,
            c.token_estimate, c.parent_key, c.chunk_role, p.title as paper_title
     FROM paper_chunks c
     JOIN paper_documents p ON p.paper_key = c.paper_key
     WHERE c.chunk_key IN (${unique.map(() => '?').join(',')}) AND c.chunk_role = 'parent'`,
    unique
  );

  return new Map(rows.map((row) => [row.chunk_key, row]));
}

export async function expandResultsWithParentContext(
  results: SearchResult[],
  options: { intent?: string } = {}
) {
  const paperHits = results.filter((result) => result.sourceType === 'paper_chunk');
  if (!paperHits.length) return results;

  const parentKeys = paperHits
    .map((result) => String(result.fields.parent_key || result.fields.parentKey || ''))
    .filter(Boolean);

  const legacyChildKeys = paperHits
    .filter((result) => !result.fields.parent_key && !result.fields.parentKey)
    .map((result) => result.sourceKey);

  const parentByKey = await fetchParentChunks(parentKeys);

  if (legacyChildKeys.length) {
    const legacyParents = await all<ParentChunkRow>(
      `SELECT c.chunk_key, c.paper_key, c.chunk_index, c.page_start, c.page_end, c.section, c.text,
              c.token_estimate, c.parent_key, c.chunk_role
       FROM paper_chunks child
       JOIN paper_chunks c ON c.chunk_key = child.parent_key AND c.chunk_role = 'parent'
       WHERE child.chunk_key IN (${legacyChildKeys.map(() => '?').join(',')})`,
      legacyChildKeys
    );
    for (const row of legacyParents) parentByKey.set(row.chunk_key, row);
  }

  const useLongContext = options.intent === 'paper' || options.intent === 'general' || options.intent === 'citation';
  const parentCharLimit = useLongContext ? 6200 : 4200;
  const childParent = new Map<string, string>();
  for (const result of paperHits) {
    const parentKey = String(result.fields.parent_key || result.fields.parentKey || '');
    if (parentKey) continue;
    const row = await getDb()
      .prepare(`SELECT parent_key FROM paper_chunks WHERE chunk_key = ? AND chunk_role = 'child'`)
      .get<{ parent_key?: string }>(result.sourceKey);
    if (row?.parent_key) childParent.set(result.sourceKey, row.parent_key);
  }
  const extraParentKeys = [...childParent.values()].filter((key) => !parentByKey.has(key));
  if (extraParentKeys.length) {
    const extra = await fetchParentChunks(extraParentKeys);
    for (const [key, row] of extra) parentByKey.set(key, row);
  }

  return results.map((result) => {
    if (result.sourceType !== 'paper_chunk') return result;

    const parentKey = String(result.fields.parent_key || result.fields.parentKey || childParent.get(result.sourceKey) || '');
    const parent = parentKey ? parentByKey.get(parentKey) : undefined;

    if (!parent?.text?.trim()) return result;

    const parentText = parent.text.replace(/\s+/g, ' ').slice(0, parentCharLimit);
    const childText = String(result.fields.text || result.snippet || '').replace(/\s+/g, ' ').slice(0, 360);
    const section = String(parent.section || result.fields.section || '');

    return {
      ...result,
      fields: {
        ...result.fields,
        parent_key: parent.chunk_key,
        parent_section: section,
        parent_text: parentText,
        child_text: childText,
        parent_expanded: true,
        parent_token_estimate: parent.token_estimate || Math.ceil(parentText.length / 2)
      },
    };
  });
}

export async function migrateLegacyPaperChunksInDb(db: Database) {
  const columns = await getColumns('paper_chunks');
  const hasParentKey = columns.some((column) => column.name === 'parent_key');
  if (!hasParentKey) {
    await db.exec(`ALTER TABLE paper_chunks ADD COLUMN parent_key TEXT`);
    await db.exec(`ALTER TABLE paper_chunks ADD COLUMN chunk_role TEXT NOT NULL DEFAULT 'child'`);
  }

  const papers = await db.prepare(
    `SELECT DISTINCT paper_key FROM paper_chunks
     WHERE chunk_role = 'child' AND (parent_key IS NULL OR parent_key = '')`
  ).all<{ paper_key: string }>();

  if (!papers.length) {
    return { migratedPapers: 0, createdParents: 0, updatedChildren: 0 };
  }

  let createdParents = 0;
  let updatedChildren = 0;

  for (const { paper_key: paperKey } of papers) {
    const children = await db.prepare(
      `SELECT chunk_key, paper_key, chunk_index, section, text
       FROM paper_chunks
       WHERE paper_key = ? AND chunk_role = 'child'
       ORDER BY chunk_index`
    ).all<{ chunk_key: string; paper_key: string; chunk_index: number; section?: string; text: string }>(paperKey);

    if (!children.length) continue;

    const grouped = new Map<string, typeof children>();
    for (const child of children) {
      const section = child.section || '正文';
      const bucket = grouped.get(section) || [];
      bucket.push(child);
      grouped.set(section, bucket);
    }

    let parentIndex = 0;
    for (const [section, sectionChildren] of grouped) {
      const fullText = sectionChildren.map((child) => child.text).join('\n\n');
      const parentBlocks = splitTextIntoParentChildChunks(fullText, paperKey).parents;

      for (const parent of parentBlocks) {
        const parentKey = parent.chunkKey;
        await runInDb(
          db,
          `INSERT OR REPLACE INTO paper_chunks(
            chunk_key, paper_key, chunk_index, page_start, page_end, section, text, token_estimate, parent_key, chunk_role, updated_at
          ) VALUES(?, ?, ?, NULL, NULL, ?, ?, ?, NULL, 'parent', CURRENT_TIMESTAMP)`,
          [parentKey, paperKey, parentIndex, section || parent.section, parent.text, parent.tokenEstimate]
        );
        createdParents += 1;
        parentIndex += 1;

        for (const child of sectionChildren) {
          if (!parent.text.includes(child.text.slice(0, Math.min(100, child.text.length)))) continue;
          await runInDb(db, `UPDATE paper_chunks SET parent_key = ? WHERE chunk_key = ?`, [parentKey, child.chunk_key]);
          updatedChildren += 1;
        }
      }

      const unlinked = await db.prepare(
        `SELECT chunk_key FROM paper_chunks
         WHERE paper_key = ? AND chunk_role = 'child' AND section = ? AND (parent_key IS NULL OR parent_key = '')`
      ).all<{ chunk_key: string }>(paperKey, section);
      if (unlinked.length) {
        const fallbackParent = await db.prepare(
          `SELECT chunk_key FROM paper_chunks WHERE paper_key = ? AND chunk_role = 'parent' ORDER BY chunk_index LIMIT 1`
        ).get<{ chunk_key: string }>(paperKey);
        if (fallbackParent?.chunk_key) {
          for (const row of unlinked) {
            await runInDb(db, `UPDATE paper_chunks SET parent_key = ? WHERE chunk_key = ?`, [fallbackParent.chunk_key, row.chunk_key]);
            updatedChildren += 1;
          }
        }
      }
    }
  }

  return { migratedPapers: papers.length, createdParents, updatedChildren };
}
