// 论文智能评审的运行时定位：Python 解释器、两份技能快照目录。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REVIEW_SKILL_DIR = 'paper-peer-review-v8';
export const PPT_SKILL_DIR = 'two-slide-paper-ppt-graphical-v3';

export function skillPath(dir, root = process.cwd()) {
  return path.join(root, '.opencode', 'skills', dir);
}

function works(python) {
  try {
    const r = spawnSync(python, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return r.status === 0 && r.stdout.trim() === '3';
  } catch {
    return false;
  }
}

/**
 * 依次尝试：PAPER_REVIEW_PYTHON → OFFICE_DOCS_PYTHON → tools/office-docs-venv → python3 → python → py -3。
 * Windows 上的 python.exe 可能是应用商店占位程序，所以每个候选都实际执行一次。
 */
export function resolvePaperReviewPython(root = process.cwd()) {
  const candidates = [
    process.env.PAPER_REVIEW_PYTHON,
    process.env.OFFICE_DOCS_PYTHON,
    path.join(root, 'tools', 'office-docs-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    'python3',
    'python'
  ].filter(Boolean);
  for (const c of candidates) {
    if ((path.isAbsolute(c) ? fs.existsSync(c) : true) && works(c)) return c;
  }
  if (process.platform === 'win32') {
    const r = spawnSync('py', ['-3', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  throw new Error('找不到可用的 Python 3。请设置 PAPER_REVIEW_PYTHON 为 python 可执行文件的绝对路径。');
}
