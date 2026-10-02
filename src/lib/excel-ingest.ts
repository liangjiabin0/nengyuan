import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import * as XLSX from 'xlsx';
import { getDataRootDir } from './config';
import { withTransaction, persistDbSummary, type Database } from './db';
import {
  normalizeRow,
  toOutputInput,
  toProjectInput,
  upsertOutputEntitiesInDb,
  upsertProjectEntitiesInDb
} from './normalize';
import type { ProjectInput } from './types';
import { rebuildSearchIndex } from './search-index';
import { exportKnowledgeCorpus } from './corpus/export';
import { exportParsedFundMarkdown } from './fund-markdown';

export type SheetImportResult = {
  filename: string;
  sheetName: string;
  fileHash: string;
  rowCount: number;
  projectsUpserted: number;
  outputsUpserted: number;
  skipped: boolean;
  reason?: string;
  detectedHeaders?: string[];
  edgesHint?: string;
};

export type ExcelIngestResult = {
  scannedFiles: number;
  scannedRoots: string[];
  importedSheets: SheetImportResult[];
  projects: number;
  outputs: number;
  rawRecords: number;
  files: number;
  parsedFunds?: { dir: string; written: number };
  diagnostics: {
    skippedSheets: number;
    importedSheets: number;
    headerMismatches: string[];
  };
  crossLink?: unknown;
  corpus: Awaited<ReturnType<typeof exportKnowledgeCorpus>>;
};

const TABLE_EXTS = new Set(['.xlsx', '.xls', '.csv']);

function fileHash(filePath: string) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function isProjectLikeHeader(headers: string[]) {
  const joined = headers.join('|');
  return /项目名|立项编号|projectName|projectCode|基金名|grantName|项目主持人|承担机构|依托单位|课题名称|批准号|负责人/.test(joined);
}

function listCandidateFiles(roots: string[]) {
  const files: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 3 || !fs.existsSync(dir)) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // 国重由 nkrd-ingest 单独导入，避免被基金表逻辑写成 project: 键
        if (/node_modules|\.next|\.git|ragpack|storage|国重项目信息|national-projects|^nkrd$/i.test(entry.name)) {
          continue;
        }
        walk(full, depth + 1);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!TABLE_EXTS.has(ext)) continue;
      if (/数据统计情况|inspect|~\$/i.test(entry.name)) continue;
      files.push(full);
    }
  };

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    const stat = fs.statSync(root);
    if (stat.isFile()) {
      if (TABLE_EXTS.has(path.extname(root).toLowerCase())) files.push(root);
      continue;
    }
    walk(root, 0);
  }
  return [...new Set(files)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function rowsFromWorkbook(filePath: string): Array<{ sheetName: string; rows: Record<string, unknown>[] }> {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    const text = fs.readFileSync(filePath, 'utf8');
    const records = parse(text, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      trim: true
    }) as Record<string, unknown>[];
    return [{ sheetName: 'csv', rows: records }];
  }

  const workbook = XLSX.readFile(filePath, { cellDates: true });
  return workbook.SheetNames.map((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '', raw: false });
    return { sheetName, rows };
  });
}

function carryForwardProject(prev: Record<string, string> | null, row: Record<string, string>) {
  if (!prev) return row;
  const next = { ...row };
  const keys = [
    'grantName',
    'grantCategory',
    'country',
    'projectName',
    'projectNameEn',
    'keywords',
    'keywordsEn',
    'summary',
    'summaryEn',
    'projectCode',
    'principalInvestigator',
    'institution',
    'year',
    'startDate',
    'endDate',
    'amount',
    'currency',
    'participants',
    'discipline',
    'disciplineCode',
    'partnerInstitutions'
  ];
  for (const key of keys) {
    if (!next[key] && prev[key]) next[key] = prev[key];
  }
  return next;
}

type ImportSheetOptions = {
  linkEntities?: boolean;
};

type SqliteStatement = ReturnType<Database['prepare']>;

async function upsertProjectRow(
  db: Database,
  project: ProjectInput,
  options: ImportSheetOptions = {},
  insertProject?: SqliteStatement
) {
  const stmt =
    insertProject ||
    db.prepare(
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
  await stmt.run(
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
  if (options.linkEntities !== false) {
    await upsertProjectEntitiesInDb(db, project);
  }
}

async function upsertOutputRow(
  db: Database,
  output: NonNullable<ReturnType<typeof toOutputInput>>,
  options: ImportSheetOptions = {},
  insertOutput?: SqliteStatement
) {
  const stmt =
    insertOutput ||
    db.prepare(
      `INSERT INTO outputs(output_key, project_key, title, publication, authors, updated_at)
     VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(output_key) DO UPDATE SET
       project_key=excluded.project_key,
       title=excluded.title,
       publication=excluded.publication,
       authors=excluded.authors,
       updated_at=CURRENT_TIMESTAMP`
    );
  await stmt.run(output.outputKey, output.projectKey, output.title || null, output.publication || null, output.authors || null);
  if (options.linkEntities !== false) {
    await upsertOutputEntitiesInDb(db, output);
  }
}

async function importSheet(
  db: Database,
  filePath: string,
  sheetName: string,
  rows: Record<string, unknown>[],
  hash: string,
  options: ImportSheetOptions = {}
): Promise<SheetImportResult> {
  const filename = path.basename(filePath);
  if (!rows.length) {
    return {
      filename,
      sheetName,
      fileHash: hash,
      rowCount: 0,
      projectsUpserted: 0,
      outputsUpserted: 0,
      skipped: true,
      reason: '空表'
    };
  }

  const sample = normalizeRow(rows[0] as Record<string, string>);
  const detectedHeaders = Object.keys(sample);
  if (!isProjectLikeHeader(detectedHeaders)) {
    return {
      filename,
      sheetName,
      fileHash: hash,
      rowCount: rows.length,
      projectsUpserted: 0,
      outputsUpserted: 0,
      skipped: true,
      reason: '表头不像基金项目表，已跳过',
      detectedHeaders: detectedHeaders.slice(0, 20)
    };
  }

  const existing = await db
    .prepare('SELECT id, row_count FROM source_files WHERE file_hash=? AND sheet_name=?')
    .get<{ id: number; row_count: number }>(hash, sheetName);

  if (existing && existing.row_count === rows.length) {
    return {
      filename,
      sheetName,
      fileHash: hash,
      rowCount: rows.length,
      projectsUpserted: 0,
      outputsUpserted: 0,
      skipped: true,
      reason: '相同文件与 sheet 已导入，跳过'
    };
  }

  let sourceFileId: number;
  if (existing) {
    sourceFileId = existing.id;
    await db.prepare('DELETE FROM raw_records WHERE source_file_id=?').run(sourceFileId);
    await db.prepare(
      `UPDATE source_files SET filename=?, row_count=?, imported_at=CURRENT_TIMESTAMP, status='imported'
       WHERE id=?`
    ).run(filename, rows.length, sourceFileId);
  } else {
    const info = await db
      .prepare(
        `INSERT INTO source_files(filename, sheet_name, file_hash, row_count, status)
         VALUES(?,?,?,?, 'imported')`
      )
      .run(filename, sheetName, hash, rows.length);
    sourceFileId = Number(info.lastInsertRowid);
  }

  let projectsUpserted = 0;
  let outputsUpserted = 0;
  let prev: Record<string, string> | null = null;
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
  const insertOutput = db.prepare(
    `INSERT INTO outputs(output_key, project_key, title, publication, authors, updated_at)
     VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
     ON CONFLICT(output_key) DO UPDATE SET
       project_key=excluded.project_key,
       title=excluded.title,
       publication=excluded.publication,
       authors=excluded.authors,
       updated_at=CURRENT_TIMESTAMP`
  );
  const insertRaw = db.prepare(
    `INSERT INTO raw_records(source_file_id, row_index, project_key, payload)
     VALUES(?,?,?,?)
     ON CONFLICT(source_file_id, row_index) DO UPDATE SET
       project_key=excluded.project_key,
       payload=excluded.payload`
  );

  for (let index = 0; index < rows.length; index += 1) {
    const normalized = carryForwardProject(prev, normalizeRow(rows[index] as Record<string, string>));
    const hasProjectSignal = Boolean(
      normalized.projectName || normalized.projectCode || normalized.principalInvestigator || normalized.grantName
    );
    if (!hasProjectSignal && !normalized.outputTitle) continue;

    if (hasProjectSignal) {
      const project = toProjectInput(normalized);
      await upsertProjectRow(db, project, options, insertProject);
      projectsUpserted += 1;
      prev = normalized;
      await insertRaw.run(sourceFileId, index, project.projectKey, JSON.stringify(normalized));
      const output = toOutputInput(project.projectKey, normalized);
      if (output) {
        await upsertOutputRow(db, output, options, insertOutput);
        outputsUpserted += 1;
      }
    } else if (prev) {
      const project = toProjectInput(prev);
      const output = toOutputInput(project.projectKey, normalized);
      if (output) {
        await upsertOutputRow(db, output, options, insertOutput);
        outputsUpserted += 1;
      }
      await insertRaw.run(sourceFileId, index, project.projectKey, JSON.stringify(normalized));
    }
  }

  return {
    filename,
    sheetName,
    fileHash: hash,
    rowCount: rows.length,
    projectsUpserted,
    outputsUpserted,
    skipped: false,
    detectedHeaders: detectedHeaders.slice(0, 24),
    edgesHint: 'project→person/institution/fund/keyword/participants'
  };
}

export async function ingestExcelAndCsv(options?: {
  roots?: string[];
  rebuildIndex?: boolean;
  crossLink?: boolean;
  exportCorpus?: boolean;
  linkEntities?: boolean;
  onProgress?: (current: number, total: number, filePath: string) => void;
}): Promise<ExcelIngestResult> {
  const dataRoot = getDataRootDir();
  const { resolveDataSubdirs } = await import('./data-dirs');
  const fundsDir = resolveDataSubdirs(dataRoot).funds;
  const roots = options?.roots ?? [
    process.cwd(),
    dataRoot,
    path.join(process.cwd(), '知识问答'),
    path.join(process.cwd(), 'data'),
    path.join(dataRoot, '项目'),
    path.join(dataRoot, '基金'),
    path.join(dataRoot, '基金信息'),
    fundsDir
  ];
  const files = listCandidateFiles(roots);
  const importedSheets: SheetImportResult[] = [];
  const sheetOptions: ImportSheetOptions = {
    linkEntities: options?.linkEntities !== false
  };
  // 按文件单独事务，避免 60+ 大 CSV 长时间锁库
  for (let index = 0; index < files.length; index += 1) {
    const filePath = files[index];
    options?.onProgress?.(index + 1, files.length, filePath);
    const hash = fileHash(filePath);
    await withTransaction(async (db) => {
      for (const sheet of rowsFromWorkbook(filePath)) {
        importedSheets.push(await importSheet(db, filePath, sheet.sheetName, sheet.rows, hash, sheetOptions));
      }
    });
  }

  let crossLink: unknown;
  if (options?.crossLink !== false) {
    const { crossLinkKnowledgeGraph } = await import('./kg/cross-link');
    crossLink = await crossLinkKnowledgeGraph();
  }

  if (options?.rebuildIndex !== false) {
    await rebuildSearchIndex();
  } else {
    await persistDbSummary({ includeSlowCounts: true });
  }

  const corpus =
    options?.exportCorpus === false
      ? ({ root: '', manifest: null, filesWritten: 0 } as unknown as Awaited<ReturnType<typeof exportKnowledgeCorpus>>)
      : await exportKnowledgeCorpus();
  // Even when corpus export is skipped, write readable fund Markdown under storage/parsed/funds
  const parsedFunds = await exportParsedFundMarkdown();
  const stats = await persistDbSummary({ includeSlowCounts: true });
  const skippedSheets = importedSheets.filter((s) => s.skipped).length;
  const okSheets = importedSheets.filter((s) => !s.skipped).length;
  return {
    scannedFiles: files.length,
    scannedRoots: roots.filter((r) => fs.existsSync(r)),
    importedSheets,
    projects: stats.stats.projects,
    outputs: stats.stats.outputs,
    rawRecords: stats.stats.rawRecords,
    files: stats.stats.files,
    parsedFunds: { dir: parsedFunds.dir, written: parsedFunds.written },
    diagnostics: {
      skippedSheets,
      importedSheets: okSheets,
      headerMismatches: importedSheets
        .filter((s) => s.reason?.includes('表头'))
        .map((s) => `${s.filename}#${s.sheetName}: ${(s.detectedHeaders || []).join(',')}`)
        .slice(0, 20)
    },
    crossLink,
    corpus
  };
}
