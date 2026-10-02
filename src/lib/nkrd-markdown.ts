import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './db';
import { getDb } from './db';
import { corpusRecordFileName } from './corpus/schema';
import {
  type FundOutputRow,
  type FundProjectRow,
  getParsedRootDir,
  renderFundProjectMarkdown
} from './fund-markdown';

export const NKRD_GRANT_NAME = '国家重点研发计划(NKRD)';
export const NKRD_KEY_PREFIX = 'nkrd:';

export function isNkrdProjectKey(projectKey: string) {
  return String(projectKey || '').startsWith(NKRD_KEY_PREFIX);
}

/** Readable parsed Markdown: storage/parsed/nkrd */
export function getParsedNkrdDir(root = getParsedRootDir()) {
  return path.join(root, 'nkrd');
}

function sanitizeFileStem(value: string) {
  return (
    value
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 80) || 'nkrd'
  );
}

export function nkrdMarkdownFileName(row: FundProjectRow) {
  const stem = sanitizeFileStem(
    row.project_name || row.principal_investigator || row.project_code || row.project_key
  );
  const digest = crypto.createHash('sha256').update(row.project_key).digest('hex').slice(0, 10);
  return `${stem}_${digest}.md`;
}

/** Render NKRD markdown; kind frontmatter uses nkrd for Agent domain clarity. */
export function renderNkrdProjectMarkdown(row: FundProjectRow, outputs: FundOutputRow[] = []) {
  const base = renderFundProjectMarkdown(row, outputs);
  return base
    .replace(/^kind: "project"$/m, 'kind: "nkrd"')
    .replace(/^- \*\*基金名称:\*\*/m, '- **计划名称:**')
    .replace(/^- \*\*基金类别:\*\*/m, '- **重点专项/类别:**')
    .replace(/^- \*\*项目编号:\*\*/m, '- **内部ID:**');
}

export type ExportParsedNkrdResult = {
  dir: string;
  written: number;
  corpusCopied: number;
};

/**
 * Write NKRD projects as Markdown:
 * 1) storage/parsed/nkrd
 * 2) optional sync into knowledge-corpus/national-projects
 */
export async function exportParsedNkrdMarkdown(
  db: Database = getDb(),
  options?: { corpusNkrdDir?: string | null }
): Promise<ExportParsedNkrdResult> {
  const dir = getParsedNkrdDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.toLowerCase().endsWith('.md')) fs.unlinkSync(path.join(dir, name));
  }

  const projects = db
    .prepare("SELECT * FROM projects WHERE project_key LIKE 'nkrd:%' ORDER BY project_key")
    .all<FundProjectRow>();
  const outputs = db
    .prepare(
      `SELECT o.* FROM outputs o
       INNER JOIN projects p ON p.project_key = o.project_key
       WHERE p.project_key LIKE 'nkrd:%'
       ORDER BY o.project_key, o.output_key`
    )
    .all<FundOutputRow>();
  const [projectRows, outputRows] = await Promise.all([projects, outputs]);
  const outputsByProject = new Map<string, FundOutputRow[]>();
  for (const row of outputRows) {
    const list = outputsByProject.get(row.project_key) || [];
    list.push(row);
    outputsByProject.set(row.project_key, list);
  }

  const corpusDir = options?.corpusNkrdDir;
  if (corpusDir) {
    fs.mkdirSync(corpusDir, { recursive: true });
    for (const name of fs.readdirSync(corpusDir)) {
      if (/^[a-f0-9]{24}\.md$/i.test(name)) fs.unlinkSync(path.join(corpusDir, name));
    }
  }

  let written = 0;
  let corpusCopied = 0;
  for (const project of projectRows) {
    const markdown = `${renderNkrdProjectMarkdown(project, outputsByProject.get(project.project_key) || []).trim()}\n`;
    fs.writeFileSync(path.join(dir, nkrdMarkdownFileName(project)), markdown, 'utf8');
    written += 1;
    if (corpusDir) {
      fs.writeFileSync(path.join(corpusDir, corpusRecordFileName(project.project_key)), markdown, 'utf8');
      corpusCopied += 1;
    }
  }

  return { dir, written, corpusCopied };
}
