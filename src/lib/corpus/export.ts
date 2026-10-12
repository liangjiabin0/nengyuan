import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from '../db';
import { getDb } from '../db';
import { config } from '../config';
import {
  CORPUS_FORMAT,
  CORPUS_KINDS,
  CORPUS_VERSION,
  corpusDirectory,
  corpusRecordFileName,
  corpusRecordRelativePath,
  getCorpusPreviousRoot,
  getCorpusRoot,
  getCorpusStagingRoot,
  type CorpusKind,
  type CorpusManifest
} from './schema';
import {
  exportParsedFundMarkdown,
  getParsedDocumentsDir,
  renderFundProjectMarkdown,
  type FundOutputRow,
  type FundProjectRow
} from '../fund-markdown';
import { exportParsedNkrdMarkdown, isNkrdProjectKey, renderNkrdProjectMarkdown } from '../nkrd-markdown';

type PaperRow = {
  paper_key: string;
  title: string;
  authors: string | null;
  file_path: string;
  pdf_path: string;
  original_path: string | null;
  file_hash: string;
  page_count: number;
  abstract: string | null;
  keywords: string | null;
  references_json: string | null;
  citations_json: string | null;
  algorithms_json: string | null;
  publish_year: number | null;
  journal: string | null;
  doi: string | null;
  pub_date: string | null;
  updated_at: string;
};

type PaperChunkRow = {
  paper_key: string;
  chunk_index: number;
  page_start: number | null;
  page_end: number | null;
  section: string | null;
  text: string;
  chunk_role: string;
};

type MentorRow = {
  mentor_key: string;
  name: string;
  school: string | null;
  college: string | null;
  major: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  file_path: string;
  file_hash: string;
  content: string;
  updated_at: string;
};

type PersonRow = {
  entity_key: string;
  name: string;
  meta: string | null;
  updated_at: string;
};

type ProjectRow = {
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

type OutputRow = {
  output_key: string;
  project_key: string;
  title: string | null;
  publication: string | null;
  authors: string | null;
  updated_at: string;
};

type CorpusSnapshot = {
  papers: PaperRow[];
  chunks: PaperChunkRow[];
  mentors: MentorRow[];
  people: PersonRow[];
  projects: ProjectRow[];
  outputs: OutputRow[];
};

export type CorpusExportResult = {
  root: string;
  manifest: CorpusManifest;
  filesWritten: number;
};

function cleanText(value: unknown) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

const SUBSCRIPT_PAIRS: Array<[number, string]> = [
  [0x2080, '0'], [0x2081, '1'], [0x2082, '2'], [0x2083, '3'], [0x2084, '4'],
  [0x2085, '5'], [0x2086, '6'], [0x2087, '7'], [0x2088, '8'], [0x2089, '9'],
  [0x208A, '+'], [0x208B, '-'], [0x208C, '='], [0x208D, '('], [0x208E, ')'],
  [0x2090, 'a'], [0x2091, 'e'], [0x2095, 'h'], [0x1D62, 'i'], [0x2C7C, 'j'],
  [0x2096, 'k'], [0x2097, 'l'], [0x2098, 'm'], [0x2099, 'n'], [0x2092, 'o'],
  [0x209A, 'p'], [0x1D63, 'r'], [0x209B, 's'], [0x209C, 't'], [0x1D64, 'u'],
  [0x1D65, 'v'], [0x2093, 'x']
];

const SUPERSCRIPT_PAIRS: Array<[number, string]> = [
  [0x2070, '0'], [0x00B9, '1'], [0x00B2, '2'], [0x00B3, '3'], [0x2074, '4'],
  [0x2075, '5'], [0x2076, '6'], [0x2077, '7'], [0x2078, '8'], [0x2079, '9'],
  [0x207A, '+'], [0x207B, '-'], [0x207C, '='], [0x207D, '('], [0x207E, ')'],
  [0x1D43, 'a'], [0x1D47, 'b'], [0x1D9C, 'c'], [0x1D48, 'd'], [0x1D49, 'e'],
  [0x1DA0, 'f'], [0x1D4D, 'g'], [0x02B0, 'h'], [0x2071, 'i'], [0x02B2, 'j'],
  [0x1D4F, 'k'], [0x02E1, 'l'], [0x1D50, 'm'], [0x207F, 'n'], [0x1D52, 'o'],
  [0x1D56, 'p'], [0x02B3, 'r'], [0x02E2, 's'], [0x1D57, 't'], [0x1D58, 'u'],
  [0x1D5B, 'v'], [0x02B7, 'w'], [0x02E3, 'x'], [0x02B8, 'y'], [0x1DBB, 'z']
];

function tableFromPairs(pairs: Array<[number, string]>) {
  return Object.fromEntries(pairs.map(([codePoint, latin]) => [String.fromCodePoint(codePoint), latin]));
}

const SUBSCRIPT = tableFromPairs(SUBSCRIPT_PAIRS);
const SUPERSCRIPT = tableFromPairs(SUPERSCRIPT_PAIRS);
const SUBSCRIPT_CLASS = SUBSCRIPT_PAIRS.map(([codePoint]) => `\\u{${codePoint.toString(16)}}`).join('');
const SUPERSCRIPT_CLASS = SUPERSCRIPT_PAIRS.map(([codePoint]) => `\\u{${codePoint.toString(16)}}`).join('');

function mappedRun(value: string, table: Record<string, string>) {
  return [...value].map((char) => table[char] || char).join('');
}

/**
 * Preserve existing TeX and normalize common Unicode formula notation into
 * inline LaTeX inside the canonical Markdown record.
 */
export function normalizeFormulaSyntax(value: unknown) {
  return cleanText(value)
    .replace(
      new RegExp(`([A-Za-z\\u4e00-\\u9fff])([${SUBSCRIPT_CLASS}]+)`, 'gu'),
      (_, base: string, suffix: string) => `$${base}_{${mappedRun(suffix, SUBSCRIPT)}}$`
    )
    .replace(
      new RegExp(`([A-Za-z\\u4e00-\\u9fff0-9])([${SUPERSCRIPT_CLASS}]+)`, 'gu'),
      (_, base: string, suffix: string) => `$${base}^{${mappedRun(suffix, SUPERSCRIPT)}}$`
    )
    .replace(
      /\b([A-Za-z][A-Za-z0-9]*)\s*(\u2264|\u2265|\u2260|\u2248|\u00b1|\u00d7)\s*([A-Za-z0-9.-]+)\b/g,
      (_, left: string, operator: string, right: string) => {
        const latexOperator: Record<string, string> = {
          '\u2264': '\\le',
          '\u2265': '\\ge',
          '\u2260': '\\ne',
          '\u2248': '\\approx',
          '\u00b1': '\\pm',
          '\u00d7': '\\times'
        };
        return `$${left} ${latexOperator[operator]} ${right}$`;
      }
    )
    .replace(/\u221a\s*([A-Za-z0-9]+)/g, (_, operand: string) => `$\\sqrt{${operand}}$`);
}

export function wrapLongMarkdownLines(value: unknown, width = 240) {
  return cleanText(value)
    .split('\n')
    .flatMap((sourceLine) => {
      const lines: string[] = [];
      let line = sourceLine;
      while (line.length > width) {
        const window = line.slice(0, width + 1);
        const candidates = [
          window.lastIndexOf(' '),
          window.lastIndexOf('\u3001'),
          window.lastIndexOf('\u3002'),
          window.lastIndexOf('\uff0c'),
          window.lastIndexOf('\uff1b'),
          window.lastIndexOf(',')
        ];
        const splitAt = Math.max(...candidates);
        const end = splitAt >= Math.floor(width * 0.6) ? splitAt + 1 : width;
        lines.push(line.slice(0, end).trimEnd());
        line = line.slice(end).trimStart();
      }
      lines.push(line);
      return lines;
    })
    .join('\n');
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

function heading(value: unknown, fallback: string) {
  return oneLine(value || fallback).replace(/^#+\s*/, '').trim() || fallback;
}

function contentHash(value: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function parseStringArray(value: string | null) {
  if (!value) return [] as string[];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(oneLine).filter(Boolean);
  } catch {
    return [];
  }
}

function parseMeta(value: string | null) {
  if (!value) return {} as Record<string, unknown>;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function labelLine(label: string, value: unknown) {
  const text = oneLine(value);
  return text ? `- **${label}:** ${text}` : '';
}

function section(title: string, body: unknown) {
  const text = wrapLongMarkdownLines(normalizeFormulaSyntax(body));
  return text ? `## ${title}\n\n${text}` : '';
}

function writeRecord(
  stagingRoot: string,
  kind: CorpusKind,
  recordKey: string,
  markdown: string,
  seenKeys: Set<string>
) {
  if (!recordKey || seenKeys.has(recordKey)) {
    throw new Error(`Markdown ????? key ??? key?${recordKey || '<empty>'}`);
  }
  seenKeys.add(recordKey);
  const dir = path.join(stagingRoot, corpusDirectory(kind));
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, corpusRecordFileName(recordKey));
  fs.writeFileSync(target, `${markdown.trim()}\n`, 'utf8');
}

function renderMentor(row: MentorRow) {
  const hash = contentHash(row);
  return [
    frontmatter({
      record_key: row.mentor_key,
      kind: 'mentor',
      name: row.name,
      school: row.school,
      college: row.college,
      major: row.major,
      title: row.title,
      email: row.email,
      phone: row.phone,
      source_file: row.file_path,
      source_page: null,
      source_hash: row.file_hash,
      content_hash: hash,
      updated_at: row.updated_at
    }),
    `# ${heading(row.name, row.mentor_key)}`,
    [
      labelLine('??', row.school),
      labelLine('??/??', row.college),
      labelLine('??', row.major),
      labelLine('??', row.title),
      labelLine('??', row.email),
      labelLine('??', row.phone)
    ].filter(Boolean).join('\n'),
    section('Profile', row.content)
  ].filter(Boolean).join('\n\n');
}

function paperBody(chunks: PaperChunkRow[]) {
  const parents = chunks.filter((row) => row.chunk_role === 'parent').sort((a, b) => a.chunk_index - b.chunk_index);
  const selected = parents.length
    ? parents
    : chunks
        .filter((row) => row.chunk_role === 'child')
        .sort((a, b) => a.chunk_index - b.chunk_index);
  return selected
    .map((row) => {
      const text = normalizeFormulaSyntax(row.text);
      if (!text) return '';
      const sectionName = heading(row.section, '');
      return sectionName && !text.startsWith(sectionName)
        ? `### ${sectionName}\n\n${text}`
        : text;
    })
    .filter(Boolean)
    .join('\n\n');
}

function renderPaper(row: PaperRow, chunks: PaperChunkRow[], kind: 'paper' | 'patent' | 'book') {
  const references = parseStringArray(row.references_json);
  const citations = parseStringArray(row.citations_json);
  const algorithms = parseStringArray(row.algorithms_json);
  const body = paperBody(chunks);
  const hash = contentHash({ row, body, references });
  return [
    frontmatter({
      record_key: row.paper_key,
      kind,
      title: row.title,
      authors: row.authors,
      journal: row.journal,
      publish_year: row.publish_year,
      publication_date: row.pub_date,
      doi: row.doi,
      keywords: row.keywords,
      page_count: row.page_count,
      source_file: row.original_path || row.file_path,
      preview_file: row.pdf_path || row.file_path,
      source_page: null,
      source_hash: row.file_hash,
      content_hash: hash,
      updated_at: row.updated_at
    }),
    `# ${heading(row.title, row.paper_key)}`,
    [
      labelLine('作者', row.authors),
      labelLine('期刊', row.journal),
      labelLine('年份', row.publish_year),
      labelLine('日期', row.pub_date),
      labelLine('DOI', row.doi),
      labelLine('关键词', row.keywords)
    ].filter(Boolean).join('\n'),
    section('Abstract', row.abstract),
    section(
      kind === 'patent' ? 'Patent Text' : kind === 'book' ? 'Book Text' : 'Full Text',
      body
    ),
    algorithms.length
      ? `## Algorithms and Formulae\n\n${algorithms
          .map((item) => wrapLongMarkdownLines(`- ${normalizeFormulaSyntax(item)}`))
          .join('\n')}`
      : '',
    citations.length ? `## Citation Markers\n\n${citations.map((item) => `- ${item}`).join('\n')}` : '',
    references.length
      ? `## References\n\n${references
          .map((item, index) => wrapLongMarkdownLines(`${index + 1}. ${normalizeFormulaSyntax(item)}`))
          .join('\n')}`
      : ''
  ].filter(Boolean).join('\n\n');
}

function renderPerson(row: PersonRow) {
  const meta = parseMeta(row.meta);
  const hash = contentHash(row);
  const metadata = Object.entries(meta)
    .map(([key, value]) => labelLine(key, typeof value === 'object' ? JSON.stringify(value) : value))
    .filter(Boolean)
    .join('\n');
  return [
    frontmatter({
      record_key: row.entity_key,
      kind: 'person',
      name: row.name,
      source_file: typeof meta.filePath === 'string' ? meta.filePath : null,
      source_page: null,
      content_hash: hash,
      updated_at: row.updated_at
    }),
    `# ${heading(row.name, row.entity_key)}`,
    metadata ? `## Metadata\n\n${metadata}` : '?????????????????????????????????????????'
  ].join('\n\n');
}

function renderProject(row: ProjectRow, outputs: OutputRow[] = []) {
  const project = row as FundProjectRow;
  const out = outputs as FundOutputRow[];
  if (isNkrdProjectKey(project.project_key)) return renderNkrdProjectMarkdown(project, out);
  return renderFundProjectMarkdown(project, out);
}

async function takeSnapshot(db: Database): Promise<CorpusSnapshot> {
  return db.transaction(async (snapshotDb) => {
    await snapshotDb.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const [papers, chunks, mentors, people, projects, outputs] = await Promise.all([
      snapshotDb.prepare(
        `SELECT paper_key, title, authors, file_path, pdf_path, original_path, file_hash,
                page_count, abstract, keywords, references_json, citations_json, algorithms_json,
                publish_year, journal, doi, pub_date, updated_at
         FROM paper_documents ORDER BY paper_key`
      ).all<PaperRow>(),
      snapshotDb.prepare(
        `SELECT paper_key, chunk_index, page_start, page_end, section, text, chunk_role
         FROM paper_chunks ORDER BY paper_key, chunk_index`
      ).all<PaperChunkRow>(),
      snapshotDb.prepare(
        `SELECT mentor_key, name, school, college, major, email, phone, title, file_path,
                file_hash, content, updated_at
         FROM mentor_profiles ORDER BY mentor_key`
      ).all<MentorRow>(),
      snapshotDb.prepare(
        `SELECT entity_key, name, meta, updated_at
         FROM entities WHERE type = 'person' ORDER BY entity_key`
      ).all<PersonRow>(),
      snapshotDb.prepare('SELECT * FROM projects ORDER BY project_key').all<ProjectRow>(),
      snapshotDb.prepare('SELECT * FROM outputs ORDER BY output_key').all<OutputRow>()
    ]);
    return { papers, chunks, mentors, people, projects, outputs };
  });
}

function databaseFingerprint(snapshot: CorpusSnapshot) {
  const summary = {
    databasePath: path.resolve(config.databasePath),
    papers: snapshot.papers.map((row) => [row.paper_key, row.file_hash, row.updated_at]),
    mentors: snapshot.mentors.map((row) => [row.mentor_key, row.file_hash, row.updated_at]),
    people: snapshot.people.map((row) => [row.entity_key, row.updated_at]),
    projects: snapshot.projects.map((row) => [row.project_key, row.updated_at]),
    outputs: snapshot.outputs.map((row) => [row.output_key, row.updated_at])
  };
  return contentHash(summary);
}

function renderManifest(manifest: CorpusManifest) {
  const countLines = CORPUS_KINDS.map((kind) => `- **${kind}:** ${manifest.counts[kind]}`).join('\n');
  return [
    frontmatter({
      record_key: 'corpus-manifest',
      kind: 'manifest',
      format: manifest.format,
      version: manifest.version,
      exported_at: manifest.exportedAt,
      database_path: manifest.databasePath,
      database_fingerprint: manifest.databaseFingerprint,
      total_records: manifest.totalRecords
    }),
    '# Knowledge Corpus Manifest',
    '此目录由数据库自动导出。问答时只读取本目录，不直接查询数据库。',
    '## Record Counts',
    countLines,
    '## How to read',
    [
      '- 分域检索：`papers/`、`patents/`、`books/`、`projects/`、`national-projects/`、`people/`。',
      '- 专利：对 `patents/` 做 grep（公开号如 CN113203912A、题名、申请人、权利要求），再 read 命中的哈希 Markdown。',
      '- 按公开号定位可先读 `patents/INDEX.jsonl`（每行一条：pub_no / title / applicant / path）。'
    ].join('\n')
  ].join('\n\n');
}

function validateStaging(stagingRoot: string, manifest: CorpusManifest, seenKeys: Set<string>) {
  if (seenKeys.size !== manifest.totalRecords) {
    throw new Error(`??????????keys=${seenKeys.size}, manifest=${manifest.totalRecords}`);
  }
  for (const kind of CORPUS_KINDS) {
    const dir = path.join(stagingRoot, corpusDirectory(kind));
    const count = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => /^[a-f0-9]{24}\.md$/.test(name)).length
      : 0;
    if (count !== manifest.counts[kind]) {
      throw new Error(`???????????${kind}=${count}, expected=${manifest.counts[kind]}`);
    }
  }
  if (!fs.existsSync(path.join(stagingRoot, 'MANIFEST.md'))) {
    throw new Error('??????');
  }
}

function activateStaging(stagingRoot: string, targetRoot: string, previousRoot: string) {
  fs.rmSync(previousRoot, { recursive: true, force: true });
  const hadTarget = fs.existsSync(targetRoot);
  if (hadTarget) fs.renameSync(targetRoot, previousRoot);
  try {
    fs.renameSync(stagingRoot, targetRoot);
  } catch (error) {
    if (hadTarget && fs.existsSync(previousRoot) && !fs.existsSync(targetRoot)) {
      fs.renameSync(previousRoot, targetRoot);
    }
    throw error;
  }
  fs.rmSync(previousRoot, { recursive: true, force: true });
}

async function exportKnowledgeCorpusNow(db: Database): Promise<CorpusExportResult> {
  const snapshot = await takeSnapshot(db);
  const stagingRoot = getCorpusStagingRoot();
  const targetRoot = getCorpusRoot();
  const previousRoot = getCorpusPreviousRoot();
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(stagingRoot, { recursive: true });

  const chunksByPaper = new Map<string, PaperChunkRow[]>();
  for (const chunk of snapshot.chunks) {
    const rows = chunksByPaper.get(chunk.paper_key) || [];
    rows.push(chunk);
    chunksByPaper.set(chunk.paper_key, rows);
  }

  const counts = Object.fromEntries(CORPUS_KINDS.map((kind) => [kind, 0])) as Record<CorpusKind, number>;
  const seenKeys = new Set<string>();
  try {
    // ?????? SearXNG ?????????? knowledge-corpus/mentors?counts.mentor ?? 0??
    for (const row of snapshot.people) {
      writeRecord(stagingRoot, 'person', row.entity_key, renderPerson(row), seenKeys);
      counts.person += 1;
    }
    for (const row of snapshot.papers) {
      const kind = row.paper_key.startsWith('patent:')
        ? 'patent'
        : row.paper_key.startsWith('book:') || row.paper_key.startsWith('whitepaper:')
          ? 'book'
          : 'paper';
      writeRecord(stagingRoot, kind, row.paper_key, renderPaper(row, chunksByPaper.get(row.paper_key) || [], kind), seenKeys);
      counts[kind] += 1;
    }

    const outputsByProject = new Map<string, OutputRow[]>();
    for (const row of snapshot.outputs) {
      const list = outputsByProject.get(row.project_key) || [];
      list.push(row);
      outputsByProject.set(row.project_key, list);
    }
    // ??/?????????????????????? knowledge-corpus/outputs
    for (const row of snapshot.projects) {
      const kind = isNkrdProjectKey(row.project_key) ? 'nkrd' : 'project';
      writeRecord(
        stagingRoot,
        kind,
        row.project_key,
        renderProject(row, outputsByProject.get(row.project_key) || []),
        seenKeys
      );
      counts[kind] += 1;
    }
    counts.output = 0;

    const manifest: CorpusManifest = {
      format: CORPUS_FORMAT,
      version: CORPUS_VERSION,
      exportedAt: new Date().toISOString(),
      databasePath: path.resolve(config.databasePath),
      databaseFingerprint: databaseFingerprint(snapshot),
      counts,
      totalRecords: seenKeys.size
    };
    fs.writeFileSync(path.join(stagingRoot, 'MANIFEST.md'), `${renderManifest(manifest)}\n`, 'utf8');
    validateStaging(stagingRoot, manifest, seenKeys);
    activateStaging(stagingRoot, targetRoot, previousRoot);
    writePatentIndexSync(
      path.join(targetRoot, corpusDirectory('patent')),
      snapshot.papers.filter((row) => row.paper_key.startsWith('patent:'))
    );

    // Sync readable Markdown to storage/parsed/{funds,nkrd}
    await exportParsedFundMarkdown(db);
    await exportParsedNkrdMarkdown(db);
    void import('./comments').then(({ materializeAllCorpusComments }) => materializeAllCorpusComments(targetRoot));

    return { root: targetRoot, manifest, filesWritten: manifest.totalRecords + 1 };
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

let exportQueue: Promise<CorpusExportResult> = Promise.resolve(null as unknown as CorpusExportResult);

export function exportKnowledgeCorpus(db: Database = getDb()) {
  const run = exportQueue.then(
    () => exportKnowledgeCorpusNow(db),
    () => exportKnowledgeCorpusNow(db)
  );
  exportQueue = run;
  return run;
}

function paperKind(paperKey: string): 'paper' | 'patent' | 'book' {
  if (paperKey.startsWith('patent:')) return 'patent';
  if (paperKey.startsWith('book:') || paperKey.startsWith('whitepaper:')) return 'book';
  return 'paper';
}

function sanitizeParsedStem(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80) || 'document';
}

function countCorpusKind(root: string, kind: CorpusKind) {
  const dir = path.join(root, corpusDirectory(kind));
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((name) => /^[a-f0-9]{24}\.md$/i.test(name)).length;
}

/** 删除一篇论文在知识库与 parsed 目录里的 Markdown（期刊追踪的摘要记录被全文取代时用）。 */
export function removePaperFromCorpus(paperKey: string, title: string) {
  const kind = paperKind(paperKey);
  fs.rmSync(path.join(getCorpusRoot(), corpusDirectory(kind), corpusRecordFileName(paperKey)), { force: true });
  const parsedKind = kind === 'book' ? 'books' : kind === 'patent' ? 'patents' : 'papers';
  const digest = crypto.createHash('sha256').update(paperKey).digest('hex').slice(0, 10);
  fs.rmSync(path.join(getParsedDocumentsDir(parsedKind), `${sanitizeParsedStem(title || paperKey)}_${digest}.md`), {
    force: true
  });
}

function writePatentIndexSync(
  dir: string,
  rows: Array<{ paper_key: string; title: string; authors?: string | null; keywords?: string | null }>
) {
  fs.mkdirSync(dir, { recursive: true });
  const lines = rows.map((row) => {
    const pub =
      /CN\d{7,13}[A-Z]?/i.exec(`${row.paper_key} ${row.keywords || ''}`)?.[0]?.toUpperCase() || '';
    return JSON.stringify({
      pub_no: pub,
      title: row.title,
      applicant: row.authors || '',
      keywords: row.keywords || '',
      paper_key: row.paper_key,
      path: `knowledge-corpus/${corpusRecordRelativePath('patent', row.paper_key)}`
    });
  });
  fs.writeFileSync(path.join(dir, 'INDEX.jsonl'), lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

export async function replacePatentCorpusFromDb(db: Database = getDb()) {
  const corpusRoot = getCorpusRoot();
  const dest = path.join(corpusRoot, corpusDirectory('patent'));
  const staging = `${dest}.next`;
  const previous = `${dest}.previous`;
  const parsedDir = getParsedDocumentsDir('patents');
  const parsedStaging = `${parsedDir}.next`;

  const papers = await db
    .prepare(
      `SELECT paper_key, title, authors, file_path, pdf_path, original_path, file_hash,
              page_count, abstract, keywords, references_json, citations_json, algorithms_json,
              publish_year, journal, doi, pub_date, updated_at
       FROM paper_documents
       WHERE paper_key LIKE 'patent:%'
       ORDER BY paper_key`
    )
    .all<PaperRow>();

  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(parsedStaging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  fs.mkdirSync(parsedStaging, { recursive: true });

  for (const row of papers) {
    const chunks = await db
      .prepare(
        `SELECT paper_key, chunk_index, page_start, page_end, section, text, chunk_role
         FROM paper_chunks
         WHERE paper_key = ?
         ORDER BY chunk_index`
      )
      .all<PaperChunkRow>(row.paper_key);
    const markdown = `${renderPaper(row, chunks, 'patent').trim()}\n`;
    fs.writeFileSync(path.join(staging, corpusRecordFileName(row.paper_key)), markdown, 'utf8');
    const stem = sanitizeParsedStem(row.title || row.paper_key);
    const digest = crypto.createHash('sha256').update(row.paper_key).digest('hex').slice(0, 10);
    fs.writeFileSync(path.join(parsedStaging, `${stem}_${digest}.md`), markdown, 'utf8');
  }

  writePatentIndexSync(staging, papers);
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(dest)) fs.renameSync(dest, previous);
  fs.renameSync(staging, dest);
  fs.rmSync(previous, { recursive: true, force: true });

  const parsedPrevious = `${parsedDir}.previous`;
  fs.rmSync(parsedPrevious, { recursive: true, force: true });
  if (fs.existsSync(parsedDir)) fs.renameSync(parsedDir, parsedPrevious);
  fs.renameSync(parsedStaging, parsedDir);
  fs.rmSync(parsedPrevious, { recursive: true, force: true });

  const manifest = rewriteLiveManifest(db);
  void import('./comments').then(({ materializeAllCorpusComments }) => materializeAllCorpusComments(corpusRoot));
  return { written: papers.length, parsedWritten: papers.length, manifest };
}

export function rewriteLiveManifest(db: Database = getDb()) {
  const root = getCorpusRoot();
  const counts = Object.fromEntries(
    CORPUS_KINDS.map((kind) => [kind, countCorpusKind(root, kind)])
  ) as Record<CorpusKind, number>;
  const totalRecords = CORPUS_KINDS.reduce((sum, kind) => sum + counts[kind], 0);
  const manifest: CorpusManifest = {
    format: CORPUS_FORMAT,
    version: CORPUS_VERSION,
    exportedAt: new Date().toISOString(),
    databasePath: path.resolve(config.databasePath),
    databaseFingerprint: contentHash({
      databasePath: path.resolve(config.databasePath),
      counts,
      totalRecords
    }),
    counts,
    totalRecords
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'MANIFEST.md'), `${renderManifest(manifest)}\n`, 'utf8');
  return manifest;
}

export type SyncPaperCorpusResult = {
  written: number;
  parsedWritten: number;
  byKind: Partial<Record<'paper' | 'patent' | 'book', number>>;
  manifest: CorpusManifest;
};

/**
 * Sync paper/patent/book full text into local Markdown for Agent reads.
 * Writes hash-named files under storage/knowledge-corpus/{papers,patents,books}
 * and readable copies under storage/parsed/{papers,patents,books}.
 */
export async function syncPaperDocumentsToCorpus(
  db: Database = getDb(),
  options?: { paperKeys?: string[]; keyPrefix?: string }
): Promise<SyncPaperCorpusResult> {
  const keys = (options?.paperKeys || [])
    .map((key) => String(key || '').trim())
    .filter(Boolean);
  const prefix = String(options?.keyPrefix || '').trim();
  if (!keys.length && !prefix) {
    throw new Error('syncPaperDocumentsToCorpus ?? paperKeys ? keyPrefix');
  }

  const papers = await (
    keys.length
      ? db
          .prepare(
            `SELECT paper_key, title, authors, file_path, pdf_path, original_path, file_hash,
                    page_count, abstract, keywords, references_json, citations_json, algorithms_json,
                    publish_year, journal, doi, pub_date, updated_at
             FROM paper_documents
             WHERE paper_key IN (${keys.map(() => '?').join(',')})
             ORDER BY paper_key`
          )
          .all<PaperRow>(...keys)
      : db
          .prepare(
            `SELECT paper_key, title, authors, file_path, pdf_path, original_path, file_hash,
                    page_count, abstract, keywords, references_json, citations_json, algorithms_json,
                    publish_year, journal, doi, pub_date, updated_at
             FROM paper_documents
             WHERE paper_key LIKE ?
             ORDER BY paper_key`
          )
          .all<PaperRow>(`${prefix}%`)
  );

  const corpusRoot = getCorpusRoot();
  const byKind: Partial<Record<'paper' | 'patent' | 'book', number>> = {};
  let written = 0;
  let parsedWritten = 0;

  for (const row of papers) {
    const kind = paperKind(row.paper_key);
    const chunks = await db
      .prepare(
        `SELECT paper_key, chunk_index, page_start, page_end, section, text, chunk_role
         FROM paper_chunks
         WHERE paper_key = ?
         ORDER BY chunk_index`
      )
      .all<PaperChunkRow>(row.paper_key);
    const markdown = `${renderPaper(row, chunks, kind).trim()}\n`;

    const corpusDir = path.join(corpusRoot, corpusDirectory(kind));
    fs.mkdirSync(corpusDir, { recursive: true });
    fs.writeFileSync(path.join(corpusDir, corpusRecordFileName(row.paper_key)), markdown, 'utf8');
    written += 1;
    byKind[kind] = (byKind[kind] || 0) + 1;

    const parsedKind =
      kind === 'book' ? 'books' : kind === 'patent' ? 'patents' : 'papers';
    const parsedDir = getParsedDocumentsDir(parsedKind);
    fs.mkdirSync(parsedDir, { recursive: true });
    const stem = sanitizeParsedStem(row.title || row.paper_key);
    const digest = crypto.createHash('sha256').update(row.paper_key).digest('hex').slice(0, 10);
    fs.writeFileSync(path.join(parsedDir, `${stem}_${digest}.md`), markdown, 'utf8');
    parsedWritten += 1;
  }

  const manifest = rewriteLiveManifest(db);
  if (byKind.patent) {
    writePatentIndexSync(
      path.join(corpusRoot, corpusDirectory('patent')),
      papers.filter((row) => paperKind(row.paper_key) === 'patent')
    );
  }
  void import('./comments').then(({ materializeAllCorpusComments }) => materializeAllCorpusComments(corpusRoot));
  return { written, parsedWritten, byKind, manifest };
}
