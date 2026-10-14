import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 论文智能评审固定使用的两份技能快照（由 scripts/paper-review/import-skills.mjs 导入）。 */
export const REVIEW_SKILL_DIR = 'paper-peer-review-v8';
export const PPT_SKILL_DIR = 'two-slide-paper-ppt-graphical-v3';

export function skillRoot(dir: string) {
  return path.join(process.cwd(), '.opencode', 'skills', dir);
}

type Snapshot = {
  skill: string;
  originalName: string;
  version: string | null;
  zipSha256: string;
  contentSha256: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
};

export type SkillSnapshotInfo = {
  dir: string;
  originalName: string;
  version: string | null;
  zipSha256: string;
  contentSha256: string;
  /** 当前磁盘文件与快照记录是否一致（不一致说明被改动过） */
  intact: boolean;
  modifiedFiles: string[];
};

function readSnapshot(dir: string): Snapshot {
  const file = path.join(skillRoot(dir), 'skill-snapshot.json');
  if (!fs.existsSync(file)) throw new Error(`技能 ${dir} 未导入（缺少 skill-snapshot.json）。请先运行 scripts/paper-review/import-skills.mjs。`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Snapshot;
}

export function inspectSkillSnapshot(dir: string): SkillSnapshotInfo {
  const snap = readSnapshot(dir);
  const root = skillRoot(dir);
  const modified: string[] = [];
  for (const f of snap.files) {
    const full = path.join(root, ...f.path.split('/'));
    if (!fs.existsSync(full)) {
      modified.push(`${f.path}（缺失）`);
      continue;
    }
    const sha = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (sha !== f.sha256) modified.push(f.path);
  }
  return {
    dir,
    originalName: snap.originalName,
    version: snap.version,
    zipSha256: snap.zipSha256,
    contentSha256: snap.contentSha256,
    intact: modified.length === 0,
    modifiedFiles: modified
  };
}

/**
 * 逐文件复制目录。不用 fs.cpSync：在 Windows 上它遇到中文路径（如 v3 模板目录“规划类”）会让 Node 进程直接崩溃退出。
 */
function copyTree(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) copyTree(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * 任务启动时冻结技能快照：把两份技能完整复制到任务目录，后续阶段只读这份副本。
 * 这样技能在任务运行中被更新，也不会影响正在跑的任务。
 */
export function freezeSkillsForTask(taskRoot: string) {
  const out: Record<string, SkillSnapshotInfo & { frozenPath: string }> = {};
  for (const dir of [REVIEW_SKILL_DIR, PPT_SKILL_DIR]) {
    const info = inspectSkillSnapshot(dir);
    if (!info.intact) throw new Error(`技能 ${dir} 与导入快照不一致：${info.modifiedFiles.slice(0, 5).join('、')}。请重新导入或通过“经验候选”流程更新。`);
    const target = path.join(taskRoot, 'skills', dir);
    if (!fs.existsSync(path.join(target, 'skill-snapshot.json'))) {
      fs.rmSync(target, { recursive: true, force: true });
      copyTree(skillRoot(dir), target);
    }
    out[dir] = { ...info, frozenPath: path.relative(taskRoot, target).split(path.sep).join('/') };
  }
  return out;
}

export function frozenSkillPath(taskRoot: string, dir: string, ...rel: string[]) {
  return path.join(taskRoot, 'skills', dir, ...rel);
}
