import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './db';
import { getDb } from './db';
import { corpusRecordFileName } from './corpus/schema';

/** Parsed Markdown artifacts live under storage/, isolated from the raw 数据/ tree. */
export function getParsedRootDir() {
  return path.join(process.cwd(), 'storage', 'parsed');
}

export type FundProjectRow = {
  project_key: string;
  grant_name: string | null;
  grant_category: string | null;
  country: string | null;
  project_name: string | null;
  project_name_en: string | null;
  keywords: string | null;
  summary: string | null;
  project_code: string | null;
  principal_investigator: string | null;
  institution: string | null;
  year: string | null;
  start_date: string | null;
  end_date: string | null;
  amount: number | null;
  currency: string | null;
  participants: string | null;
  discipline: string | null;
  discipline_code: string | null;
  partner_institutions: string | null;
  updated_at: string;
};

export type FundOutputRow = {
  output_key: string;
  project_key: string;
  title: string | null;
  publication: string | null;
  authors: string | null;
  updated_at?: string;
};

function cleanText(value: unknown) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

function oneLine(value: unknown) {
  return cleanText(value).replace(/\s*\n+\s*/g, ' ');
}

function yamlScalar(value: unknown) {
  if (value === null || value === undefined || value === '') return 'null';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(oneLine(value));
}

function frontmatter(fields: Record<string, unknown>) {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${yamlScalar(value)}`);
  return `---\n${lines.join('\n')}\n---`;
}

function labelLine(label: string, value: unknown) {
  const text = cleanText(value);
  return text ? `- **${label}:** ${text}` : '';
}

function heading(title: string, fallback: string) {
  return cleanText(title) || fallback;
}

function contentHash(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

function sanitizeFileStem(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'fund';
}

/** Human-readable parsed fund Markdown: storage/parsed/funds (isolated from 数据/). */
export function getParsedFundsDir(root = getParsedRootDir()) {
  return path.join(root, 'funds');
}

/** Human-readable parsed document Markdown under storage/parsed/{books,papers,patents}. */
export function getParsedDocumentsDir(
  kind: 'books' | 'papers' | 'patents',
  root = getParsedRootDir()
) {
  return path.join(root, kind);
}

export function fundMarkdownFileName(row: FundProjectRow) {
  const stem = sanitizeFileStem(row.project_code || row.project_name || row.project_name_en || row.project_key);
  const digest = crypto.createHash('sha256').update(row.project_key).digest('hex').slice(0, 10);
  return `${stem}_${digest}.md`;
}

export function renderFundProjectMarkdown(row: FundProjectRow, outputs: FundOutputRow[] = []) {
  const title = row.project_name || row.project_name_en || row.project_code || row.project_key;
  const hash = contentHash({ row, outputs });
  const outputBlock = outputs.length
    ? [
        '## 相关成果',
        ...outputs.map((item, index) =>
          [
            `### ${index + 1}. ${heading(item.title || item.output_key, item.output_key)}`,
            [
              labelLine('发表载体', item.publication),
              labelLine('作者', item.authors)
            ]
              .filter(Boolean)
              .join('\n')
          ]
            .filter(Boolean)
            .join('\n\n')
        )
      ].join('\n\n')
    : '';

  return [
    frontmatter({
      record_key: row.project_key,
      kind: 'project',
      title,
      project_code: row.project_code,
      principal_investigator: row.principal_investigator,
      institution: row.institution,
      year: row.year,
      grant_name: row.grant_name,
      grant_category: row.grant_category,
      output_count: outputs.length,
      source_file: null,
      source_page: null,
      content_hash: hash,
      updated_at: row.updated_at
    }),
    `# ${heading(title, row.project_key)}`,
    [
      labelLine('项目编号', row.project_code),
      labelLine('项目负责人', row.principal_investigator),
      labelLine('依托机构', row.institution),
      labelLine('基金名称', row.grant_name),
      labelLine('基金类别', row.grant_category),
      labelLine('国家/地区', row.country),
      labelLine('年份', row.year),
      labelLine('开始日期', row.start_date),
      labelLine('结束日期', row.end_date),
      labelLine('金额', row.amount),
      labelLine('币种', row.currency),
      labelLine('参与者', row.participants),
      labelLine('学科', row.discipline),
      labelLine('学科代码', row.discipline_code),
      labelLine('合作机构', row.partner_institutions),
      labelLine('关键词', row.keywords)
    ]
      .filter(Boolean)
      .join('\n'),
    row.summary ? `## Summary\n\n${cleanText(row.summary)}` : '',
    outputBlock
  ]
    .filter(Boolean)
    .join('\n\n');
}

export type ExportParsedFundsResult = {
  dir: string;
  written: number;
  corpusCopied: number;
};

/**
 * Write each project as Markdown:
 * 1) storage/parsed/funds (readable filenames)
 * 2) optional sync into knowledge-corpus/projects (retrieval; no outputs/)
 */
export async function exportParsedFundMarkdown(
  db: Database = getDb(),
  options?: { corpusProjectsDir?: string | null }
): Promise<ExportParsedFundsResult> {
  const dir = getParsedFundsDir();
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    if (name.toLowerCase().endsWith('.md')) fs.unlinkSync(path.join(dir, name));
  }

  // NSFC / general funds only — national key R&D (nkrd:*) is exported separately.
  const projects = db
    .prepare("SELECT * FROM projects WHERE project_key NOT LIKE 'nkrd:%' ORDER BY project_key")
    .all<FundProjectRow>();
  const outputs = db
    .prepare(
      `SELECT o.* FROM outputs o
       INNER JOIN projects p ON p.project_key = o.project_key
       WHERE p.project_key NOT LIKE 'nkrd:%'
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

  const corpusDir = options?.corpusProjectsDir;
  if (corpusDir) {
    fs.mkdirSync(corpusDir, { recursive: true });
    for (const name of fs.readdirSync(corpusDir)) {
      if (/^[a-f0-9]{24}\.md$/i.test(name)) fs.unlinkSync(path.join(corpusDir, name));
    }
  }

  let written = 0;
  let corpusCopied = 0;
  for (const project of projectRows) {
    const markdown = `${renderFundProjectMarkdown(project, outputsByProject.get(project.project_key) || []).trim()}\n`;
    fs.writeFileSync(path.join(dir, fundMarkdownFileName(project)), markdown, 'utf8');
    written += 1;
    if (corpusDir) {
      fs.writeFileSync(path.join(corpusDir, corpusRecordFileName(project.project_key)), markdown, 'utf8');
      corpusCopied += 1;
    }
  }

  return { dir, written, corpusCopied };
}
