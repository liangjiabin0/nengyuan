import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './db';
import { getDb, withTransaction } from './db';
import { upsertEdgeInDb, upsertEntityInDb } from './normalize';
import { updateImportJobState } from './import-state';

function fileHash(filePath: string) {
  return crypto.createHash('sha1').update(fs.readFileSync(filePath)).digest('hex');
}

async function runInDb(db: Database, sql: string, params: unknown[] = []) {
  if (params.length) await db.prepare(sql).run(...params);
  else await db.prepare(sql).run();
}

function listMarkdownFiles(dir: string) {
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.name.toLowerCase().endsWith('.md')) files.push(fullPath);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return files.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function parsePatentMarkdown(filePath: string, content: string) {
  const base = path.basename(filePath, path.extname(filePath));
  const parts = base.split('+');
  const title =
    parts.at(-1)?.trim() ||
    /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ||
    base;
  const patentType = parts.find((p) => /发明公开|实用新型|外观设计|发明授权/.test(p)) || '';
  const cnMatch = base.match(/CN[-_]?\d{5,}[-A-Z]?/i);
  const hash = fileHash(filePath);
  const paperKey = `patent:${hash.slice(0, 24)}`;
  return {
    paperKey,
    title,
    authors: parts[0]?.trim() || '',
    filePath,
    pdfPath: filePath,
    originalPath: filePath,
    fileHash: hash,
    pageCount: 1,
    abstract: content.slice(0, 4000),
    keywords: [patentType, cnMatch?.[0] || ''].filter(Boolean).join('；'),
    content
  };
}

async function upsertPatentInDb(db: Database, patent: ReturnType<typeof parsePatentMarkdown>) {
  await runInDb(
    db,
    `INSERT INTO paper_documents(
      paper_key, title, authors, file_path, pdf_path, original_path, file_hash,
      page_count, abstract, keywords, references_json, citations_json, algorithms_json, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(paper_key) DO UPDATE SET
      title=excluded.title,
      authors=excluded.authors,
      file_path=excluded.file_path,
      pdf_path=excluded.pdf_path,
      original_path=excluded.original_path,
      file_hash=excluded.file_hash,
      abstract=excluded.abstract,
      keywords=excluded.keywords,
      updated_at=CURRENT_TIMESTAMP`,
    [
      patent.paperKey,
      patent.title,
      patent.authors || null,
      patent.filePath,
      patent.pdfPath,
      patent.originalPath,
      patent.fileHash,
      patent.pageCount,
      patent.abstract,
      patent.keywords || null,
      '[]',
      '[]',
      '[]'
    ]
  );

  const chunkKey = `${patent.paperKey}:0`;
  await runInDb(db, 'DELETE FROM paper_chunks WHERE paper_key=?', [patent.paperKey]);
  await runInDb(
    db,
    `INSERT INTO paper_chunks(
      chunk_key, paper_key, chunk_index, page_start, page_end, section, text,
      token_estimate, parent_key, chunk_role, updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
    [chunkKey, patent.paperKey, 0, 1, 1, '专利全文', patent.content.slice(0, 12000), Math.ceil(patent.content.length / 4), null, 'child']
  );

  const paperEntity = await upsertEntityInDb(db, 'paper', patent.title, { paperKey: patent.paperKey, kind: 'patent' });
  await upsertEdgeInDb(db, patent.paperKey, paperEntity, 'entity', 5);
  if (patent.authors) {
    await upsertEdgeInDb(
      db,
      patent.paperKey,
      await upsertEntityInDb(db, 'institution', patent.authors.split(/[;；]/)[0]?.trim()),
      'filed_by',
      3
    );
  }

  // 检索索引在全量 rebuildSearchIndex 时统一重建，避免逐条写入拖慢导入
}

export async function ingestPatentMarkdownDirectory(dir: string, batchSize = 200) {
  const files = listMarkdownFiles(dir);
  let imported = 0;
  let skipped = 0;
  const changedKeys: string[] = [];
  const errors: Array<{ filePath: string; error: string }> = [];
  const db = getDb();
  const skipExisting = process.env.SKIP_EXISTING_PATENTS === '1';
  const existingHashes = skipExisting
    ? new Set(
        (await db.prepare("SELECT file_hash FROM paper_documents WHERE paper_key LIKE 'patent:%'").all<{ file_hash: string }>())
          .map((row) => row.file_hash)
      )
    : null;

  for (let offset = 0; offset < files.length; offset += batchSize) {
    const batch = files.slice(offset, offset + batchSize);
    await withTransaction(async (tx) => {
      for (const filePath of batch) {
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const patent = parsePatentMarkdown(filePath, content);
          if (existingHashes?.has(patent.fileHash)) {
            skipped += 1;
            continue;
          }
          await upsertPatentInDb(tx, patent);
          imported += 1;
          changedKeys.push(patent.paperKey);
          existingHashes?.add(patent.fileHash);
        } catch (error) {
          errors.push({ filePath, error: error instanceof Error ? error.message : String(error) });
        }
      }
    });

    updateImportJobState({
      phase: 'patents',
      message: `正在导入专利 Markdown (${Math.min(offset + batch.length, files.length)}/${files.length})`,
      progress: { current: Math.min(offset + batch.length, files.length), total: files.length }
    });
  }

  return {
    dir,
    files: files.length,
    imported,
    failed: errors.length,
    skipped,
    changedKeys,
    errors: errors.slice(0, 20)
  };
}
