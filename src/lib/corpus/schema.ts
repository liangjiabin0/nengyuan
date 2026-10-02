import crypto from 'node:crypto';
import path from 'node:path';

export const CORPUS_FORMAT = 'knowledge-corpus-markdown';
export const CORPUS_VERSION = 1;

export const CORPUS_KINDS = [
  'person',
  'mentor',
  'paper',
  'patent',
  'book',
  'project',
  'nkrd',
  'output'
] as const;

export type CorpusKind = (typeof CORPUS_KINDS)[number];

export type CorpusSource = {
  recordKey: string;
  kind: CorpusKind;
  title: string;
  sourceFile: string;
  sourcePage?: number | null;
};

export type CorpusManifest = {
  format: typeof CORPUS_FORMAT;
  version: typeof CORPUS_VERSION;
  exportedAt: string;
  databasePath: string;
  databaseFingerprint: string;
  counts: Record<CorpusKind, number>;
  totalRecords: number;
};

export function getCorpusRoot() {
  return path.join(process.cwd(), 'storage', 'knowledge-corpus');
}

export function getCorpusStagingRoot() {
  return path.join(process.cwd(), 'storage', 'knowledge-corpus.next');
}

export function getCorpusPreviousRoot() {
  return path.join(process.cwd(), 'storage', 'knowledge-corpus.previous');
}

export function corpusDirectory(kind: CorpusKind) {
  if (kind === 'person') return 'people';
  if (kind === 'mentor') return 'mentors';
  if (kind === 'paper') return 'papers';
  if (kind === 'patent') return 'patents';
  if (kind === 'book') return 'books';
  if (kind === 'project') return 'projects';
  if (kind === 'nkrd') return 'national-projects';
  return 'outputs';
}

export function corpusRecordFileName(recordKey: string) {
  const digest = crypto.createHash('sha256').update(recordKey).digest('hex').slice(0, 24);
  return `${digest}.md`;
}

export function corpusRecordRelativePath(kind: CorpusKind, recordKey: string) {
  return path.posix.join(corpusDirectory(kind), corpusRecordFileName(recordKey));
}

export function isCorpusRelativePath(value: string) {
  if (!value || path.isAbsolute(value) || /^[a-z]:/i.test(value)) return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.split('/').includes('..')) return false;
  return /^(people|mentors|papers|patents|books|projects|national-projects|outputs)\/[a-f0-9]{24}\.md$/.test(
    normalized
  )
    || /^attachments\/[a-f0-9]{24}\/[a-f0-9]{24}\.md$/.test(normalized)
    || normalized === 'MANIFEST.md';
}
