import fs from 'node:fs';
import path from 'node:path';
import { getDataRootDir } from './config';

export type DataSubdirs = {
  root: string;
  papers: string;
  patents: string;
  mentors: string;
  books: string;
  funds: string;
  nkrd: string;
};

const SUBDIR_ALIASES = {
  // 论文目录下按格式分为 pdf/、caj/；ingest 会递归扫描
  papers: ['论文', '论文信息', '01_论文', 'papers'],
  patents: ['专利信息', '02_专利', '专利', 'patents'],
  mentors: ['导师信息', '03_导师信息', '导师', 'mentors'],
  // 书籍：首选「书籍」；白皮书/whitepapers 仅兼容旧导入目录
  books: ['书籍', 'books', '白皮书', 'whitepapers', 'white-papers'],
  funds: ['基金信息', '基金', 'funds', '项目'],
  nkrd: ['国重项目信息', '国家重点研发', 'nkrd', 'national-projects']
} as const;

function dirHasEntries(dir: string) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function resolveSubdir(root: string, aliases: readonly string[]) {
  const existing: string[] = [];
  for (const name of aliases) {
    const fullPath = path.join(root, name);
    if (fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory()) {
      existing.push(fullPath);
    }
  }
  if (existing.length) {
    // 多个别名都存在时优先选有内容的目录（避免空的「论文」挡住「论文信息」）
    return existing.find(dirHasEntries) || existing[0];
  }
  const preferred = path.join(root, aliases[0]);
  fs.mkdirSync(preferred, { recursive: true });
  return preferred;
}

export function resolveDataSubdirs(root = getDataRootDir()): DataSubdirs {
  if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true });
  return {
    root,
    papers: resolveSubdir(root, SUBDIR_ALIASES.papers),
    patents: resolveSubdir(root, SUBDIR_ALIASES.patents),
    mentors: resolveSubdir(root, SUBDIR_ALIASES.mentors),
    books: resolveSubdir(root, SUBDIR_ALIASES.books),
    funds: resolveSubdir(root, SUBDIR_ALIASES.funds),
    nkrd: resolveSubdir(root, SUBDIR_ALIASES.nkrd)
  };
}

export function listMentorZipCandidates(root: string) {
  if (!fs.existsSync(root)) return [] as string[];
  return fs
    .readdirSync(root)
    .filter((name) => name.toLowerCase().endsWith('.zip') && /导师|mentor/i.test(name))
    .map((name) => path.join(root, name));
}
