import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { getDataRootDir } from './config';
import { resolveDataSubdirs } from './data-dirs';
import { getDb, withTransaction, persistDbSummary, type Database } from './db';
import { normalizeRow, toProjectInput } from './normalize';
import type { ProjectInput } from './types';
import { exportParsedNkrdMarkdown, NKRD_GRANT_NAME, NKRD_KEY_PREFIX } from './nkrd-markdown';
import { getCorpusRoot, corpusDirectory } from './corpus/schema';
import { rewriteLiveManifest } from './corpus/export';
import { indexProjectInDb } from './search-index';
import { syncFtsFromSearchRecords } from './fts-index';

export type NkrdIngestResult = {
  dir: string;
  scannedFiles: number;
  projects: number;
  upserted: number;
  parsedMarkdown: number;
  corpusCopied: number;
  diagnostics: {
    importedSheets: number;
    skippedSheets: number;
    reasons: string[];
  };
};

function fileHash(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listCsvFiles(root: string) {
  if (!fs.existsSync(root)) return [] as string[];
  return fs
    .readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith('.csv') && !/\$|~/.test(name))
    .map((name) => path.join(root, name))
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function parseAmountCurrency(raw: string): { amount: string; currency: string } {
  const text = String(raw || '').trim();
  if (!text) return { amount: '', currency: '' };
  const match = text.match(/^([\d,.]+)\s*(.*)$/);
  if (!match) return { amount: text, currency: '' };
  const amount = match[1].replace(/,/g, '');
  const unit = match[2].trim();
  return { amount, currency: unit || '万元' };
}

function buildNkrdSummary(row: Record<string, string>) {
  const parts: string[] = [];
  if (row.summary) parts.push(row.summary);
  if (row.judgmentBasis) parts.push(`## 判定依据\n\n${row.judgmentBasis}`);
  if (row.cardText) parts.push(`## 项目卡片原文\n\n${row.cardText}`);
  if (row.sourceUrl) parts.push(`## 来源\n\n${row.sourceUrl}`);
  return parts.join('\n\n').trim();
}

function nkrdProjectKey(row: Record<string, string>) {
  const id = String(row.projectCode || '').trim();
  if (id) return `${NKRD_KEY_PREFIX}${id}`;
  const source = [row.projectName, row.principalInvestigator, row.institution, row.year]
    .filter(Boolean)
    .join('|');
  const digest = crypto.createHash('sha256').update(source || JSON.stringify(row)).digest('hex').slice(0, 20);
  return `${NKRD_KEY_PREFIX}${digest}`;
}

function toNkrdProjectInput(row: Record<string, string>): ProjectInput {
  const { amount, currency } = parseAmountCurrency(row.amount || '');
  const base = toProjectInput({
    ...row,
    grantName: row.grantName || NKRD_GRANT_NAME,
    country: row.country || '中国',
    amount,
    currency: row.currency || currency,
    summary: buildNkrdSummary(row)
  });
  return {
    ...base,
    projectKey: nkrdProjectKey(row)
  };
}

function isNkrdLikeHeader(headers: string[]) {
  const joined = headers.join('|');
  // Accept either raw Chinese headers or normalizeRow() English aliases.
  const hasIdentity =
    /项目名|主持人|承担机构|泛研网|重点专项|国家重点研发|NKRD|projectName|principalInvestigator|institution|projectCode|grantCategory/i.test(
      joined
    );
  const hasMeta = /项目名|立项年度|资助金额|projectName|year|amount/i.test(joined);
  return hasIdentity && hasMeta;
}

async function upsertNkrdProject(db: Database, project: ProjectInput, insertProject: ReturnType<Database['prepare']>) {
  await insertProject.run(
    project.projectKey,
    project.grantName || null,
    project.grantCategory || null,
    project.country || null,
    project.projectName || null,
    project.projectNameEn || null,
    project.keywords || null,
    project.summary || null,
    project.projectCode || null,
    project.principalInvestigator || null,
    project.institution || null,
    project.year || null,
    project.startDate || null,
    project.endDate || null,
    project.amount ? Number(project.amount) || null : null,
    project.currency || null,
    project.participants || null,
    project.discipline || null,
    project.disciplineCode || null,
    project.partnerInstitutions || null
  );
}

async function clearPreviousNkrd(db: Database, fundFileNames: Set<string>) {
  const sourceRows = await db.prepare('SELECT id, filename FROM source_files').all<{
    id: number;
    filename: string;
  }>();
  const ids = sourceRows
    .filter((row) => fundFileNames.has(String(row.filename || '').toLowerCase()))
    .map((row) => row.id);
  const delRaw = db.prepare('DELETE FROM raw_records WHERE source_file_id = ?');
  const delSource = db.prepare('DELETE FROM source_files WHERE id = ?');
  for (const id of ids) {
    await delRaw.run(id);
    await delSource.run(id);
  }

  await db.exec(`
    DELETE FROM search_records
    WHERE source_type IN ('project', 'output')
      AND source_key LIKE 'nkrd:%';
    DELETE FROM outputs WHERE project_key LIKE 'nkrd:%';
    DELETE FROM projects WHERE project_key LIKE 'nkrd:%';
  `);
}

export async function ingestNkrdProjects(options?: {
  root?: string;
  exportCorpus?: boolean;
  rebuildIndex?: boolean;
  onProgress?: (current: number, total: number, filePath: string) => void;
}): Promise<NkrdIngestResult> {
  const dataRoot = options?.root || resolveDataSubdirs(getDataRootDir()).nkrd;
  const files = listCsvFiles(dataRoot);
  const fileNames = new Set(files.map((f) => path.basename(f).toLowerCase()));
  const reasons: string[] = [];
  let importedSheets = 0;
  let skippedSheets = 0;
  let upserted = 0;

  await withTransaction(async (db) => {
    await clearPreviousNkrd(db, fileNames);

    const insertProject = db.prepare(
      `INSERT INTO projects(
        project_key, grant_name, grant_category, country, project_name, project_name_en,
        keywords, summary, project_code, principal_investigator, institution, year,
        start_date, end_date, amount, currency, participants, discipline, discipline_code,
        partner_institutions, updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(project_key) DO UPDATE SET
        grant_name=excluded.grant_name,
        grant_category=excluded.grant_category,
        country=excluded.country,
        project_name=excluded.project_name,
        project_name_en=excluded.project_name_en,
        keywords=excluded.keywords,
        summary=excluded.summary,
        project_code=excluded.project_code,
        principal_investigator=excluded.principal_investigator,
        institution=excluded.institution,
        year=excluded.year,
        start_date=excluded.start_date,
        end_date=excluded.end_date,
        amount=excluded.amount,
        currency=excluded.currency,
        participants=excluded.participants,
        discipline=excluded.discipline,
        discipline_code=excluded.discipline_code,
        partner_institutions=excluded.partner_institutions,
        updated_at=CURRENT_TIMESTAMP`
    );
    const insertRaw = db.prepare(
      `INSERT INTO raw_records(source_file_id, row_index, project_key, payload)
       VALUES(?,?,?,?)
       ON CONFLICT(source_file_id, row_index) DO UPDATE SET
         project_key=excluded.project_key,
         payload=excluded.payload`
    );
    const insertSource = db.prepare(
      `INSERT INTO source_files(filename, sheet_name, file_hash, row_count, status)
       VALUES(?,?,?,?, 'imported')`
    );

    for (let index = 0; index < files.length; index += 1) {
      const filePath = files[index];
      options?.onProgress?.(index + 1, files.length, filePath);
      const text = fs.readFileSync(filePath, 'utf8');
      const records = parse(text, {
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true,
        trim: true
      }) as Array<Record<string, unknown>>;

      if (!records.length) {
        skippedSheets += 1;
        reasons.push(`${path.basename(filePath)}: 空表`);
        continue;
      }

      const sample = normalizeRow(records[0] as Record<string, string>);
      if (!isNkrdLikeHeader(Object.keys(sample))) {
        skippedSheets += 1;
        reasons.push(`${path.basename(filePath)}: 表头不像国重项目表`);
        continue;
      }

      const sourceFileId = Number(
        (await insertSource.run(path.basename(filePath), 'csv', fileHash(filePath), records.length)).lastInsertRowid
      );

      for (let rowIndex = 0; rowIndex < records.length; rowIndex += 1) {
        const normalized = normalizeRow(records[rowIndex] as Record<string, string>);
        if (!normalized.projectName && !normalized.principalInvestigator && !normalized.projectCode) continue;
        const project = toNkrdProjectInput(normalized);
        await upsertNkrdProject(db, project, insertProject);
        await insertRaw.run(sourceFileId, rowIndex, project.projectKey, JSON.stringify(normalized));
        upserted += 1;
      }
      importedSheets += 1;
    }
  });

  const corpusDir =
    options?.exportCorpus === false
      ? null
      : path.join(getCorpusRoot(), corpusDirectory('nkrd'));
  const exported = await exportParsedNkrdMarkdown(getDb(), { corpusNkrdDir: corpusDir });
  if (corpusDir) rewriteLiveManifest(getDb());

  if (options?.rebuildIndex !== false) {
    await withTransaction(async (db) => {
      const projects = db
        .prepare("SELECT * FROM projects WHERE project_key LIKE 'nkrd:%'")
        .all<Record<string, unknown> & { project_key: string }>();
      const rows = await projects;
      for (const project of rows) await indexProjectInDb(db, project);
    }, true);
    await syncFtsFromSearchRecords();
  }

  await persistDbSummary({ includeSlowCounts: true });
  return {
    dir: dataRoot,
    scannedFiles: files.length,
    projects: Number((await getDb()
      .prepare("SELECT COUNT(*) AS c FROM projects WHERE project_key LIKE 'nkrd:%'")
      .get<{ c: number }>())?.c || 0),
    upserted,
    parsedMarkdown: exported.written,
    corpusCopied: exported.corpusCopied,
    diagnostics: {
      importedSheets,
      skippedSheets,
      reasons: reasons.slice(0, 20)
    }
  };
}
