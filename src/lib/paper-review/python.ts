import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let cached: string | null = null;

function works(python: string) {
  try {
    const r = spawnSync(python, ['-c', 'import sys;print(sys.version_info[0])'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    return r.status === 0 && r.stdout.trim() === '3';
  } catch {
    return false;
  }
}

/**
 * 论文智能评审用的 Python：PAPER_REVIEW_PYTHON → OFFICE_DOCS_PYTHON → tools/office-docs-venv → python3 → python → py -3。
 * Windows 上 python.exe 可能是应用商店占位程序，所以每个候选都实际执行一次。
 */
export function resolvePaperReviewPython() {
  if (cached) return cached;
  const root = process.cwd();
  const candidates = [
    process.env.PAPER_REVIEW_PYTHON,
    process.env.OFFICE_DOCS_PYTHON,
    path.join(root, 'tools', 'office-docs-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
    'python3',
    'python'
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    if ((path.isAbsolute(c) ? fs.existsSync(c) : true) && works(c)) return (cached = c);
  }
  if (process.platform === 'win32') {
    const r = spawnSync('py', ['-3', '-c', 'import sys;print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && r.stdout.trim()) return (cached = r.stdout.trim());
  }
  throw new Error('找不到可用的 Python 3。请在 .env.local 设置 PAPER_REVIEW_PYTHON 为 python 可执行文件的绝对路径。');
}
