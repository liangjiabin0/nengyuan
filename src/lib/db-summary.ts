import fs from 'node:fs';
import path from 'node:path';

export type DbSummaryPayload = {
  updatedAt: string;
  stats: {
    files: number;
    rawRecords: number;
    projects: number;
    outputs: number;
    entities: number;
    edges: number;
  };
  indexStats: {
    searchRecords: number;
    searchTerms: number;
    aliases: number;
    mentions: number;
    mergeCandidates: number;
  };
  papers: number;
  patents: number;
  books?: number;
  /** @deprecated 读旧 db-summary.json 时兼容 */
  whitepapers?: number;
  mentors: number;
  disk: {
    paperPdf: number;
    paperCaj: number;
    patentMd: number;
    bookPdf?: number;
    /** @deprecated 读旧 db-summary.json 时兼容 */
    whitepaperPdf?: number;
    fundTables?: number;
    mentorMd: number;
  };
  bundleActive: boolean;
};

const summaryPath = () => path.join(process.cwd(), 'storage', 'db-summary.json');

export function readDbSummary(): DbSummaryPayload | null {
  try {
    if (!fs.existsSync(summaryPath())) return null;
    return JSON.parse(fs.readFileSync(summaryPath(), 'utf8')) as DbSummaryPayload;
  } catch {
    return null;
  }
}

export function writeDbSummary(payload: DbSummaryPayload) {
  fs.mkdirSync(path.dirname(summaryPath()), { recursive: true });
  fs.writeFileSync(summaryPath(), JSON.stringify(payload, null, 2));
}

export function isDbSummaryFresh(summary: DbSummaryPayload, maxAgeMs = 24 * 60 * 60 * 1000) {
  const age = Date.now() - new Date(summary.updatedAt).getTime();
  return age >= 0 && age < maxAgeMs;
}
