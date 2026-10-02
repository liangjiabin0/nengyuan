import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const OLE_OFFICE_EXTENSIONS = new Set(['.ppt', '.doc']);

const OLE_TARGET: Record<string, string> = {
  '.ppt': 'pptx',
  '.doc': 'docx'
};

export type DocumentConvertResult = {
  ok: boolean;
  via?: 'markitdown' | 'soffice+markitdown';
  error?: string;
};

export function markitdownRepoRoot() {
  return process.cwd();
}

export function markitdownCliRelPath() {
  return process.platform === 'win32' ? 'tools/markitdown.cmd' : 'tools/markitdown.sh';
}

export function markitdownCmdPath() {
  return path.join(markitdownRepoRoot(), markitdownCliRelPath());
}

export function markitdownVenvPython() {
  return process.platform === 'win32'
    ? path.join(markitdownRepoRoot(), 'tools', 'markitdown-venv', 'Scripts', 'python.exe')
    : path.join(markitdownRepoRoot(), 'tools', 'markitdown-venv', 'bin', 'python');
}

export function markitdownPdfFallbackScript() {
  return path.join(markitdownRepoRoot(), 'tools', 'markitdown', 'scripts', 'convert_with_pymupdf4llm.py');
}

export function annotateMarkitdownSkillContent(content: string) {
  const stamp = '## 项目相对路径';
  const body = String(content || '')
    .replace(/\n## (?:本机绝对路径|项目相对路径)\n[\s\S]*$/u, '')
    .trim();
  const pythonRel = process.platform === 'win32'
    ? 'tools/markitdown-venv/Scripts/python.exe'
    : 'tools/markitdown-venv/bin/python';
  return [
    body,
    '',
    stamp,
    '',
    '以下路径均相对 `AI4ES_PROJECT_ROOT`。启动侧车时系统会自动设置该变量；不要写死盘符，不要在会话工作区创建 venv：',
    '',
    '- 转换（Windows）：`tools/markitdown.cmd`',
    '- 转换（Linux）：`tools/markitdown.sh`',
    `- 解释器：\`${pythonRel}\``,
    '- PDF 回退脚本：`tools/markitdown/scripts/convert_with_pymupdf4llm.py`',
    '',
    'Windows：`& "$env:AI4ES_PROJECT_ROOT\\tools\\markitdown.cmd" "原文件" -o "同目录.converted.md"`',
    'Linux：`"$AI4ES_PROJECT_ROOT/tools/markitdown.sh" "原文件" -o "同目录.converted.md"`',
    '也可：`"$AI4ES_PROJECT_ROOT/' + pythonRel.replace(/\\/g, '/') + '" -m markitdown "原文件" -o "同目录.converted.md"`'
  ].join('\n');
}

export function resolveSofficePath() {
  const envPath = String(process.env.LIBREOFFICE_PATH || process.env.SOFFICE_PATH || '').trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  const names = process.platform === 'win32' ? ['soffice.com', 'soffice.exe', 'soffice'] : ['soffice', 'libreoffice'];
  const finder = process.platform === 'win32' ? 'where' : 'which';
  for (const name of names) {
    const found = spawnSync(finder, [name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8_000
    });
    const line = String(found.stdout || '')
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item && fs.existsSync(item));
    if (line) return line;
  }
  const candidates = process.platform === 'win32'
    ? [
      'C:\\Program Files\\LibreOffice\\program\\soffice.com',
      'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
      'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
    ]
    : ['/usr/bin/soffice', '/usr/bin/libreoffice'];
  return candidates.find((item) => fs.existsSync(item)) || '';
}

function toFileUrl(dir: string) {
  const abs = path.resolve(dir).replace(/\\/g, '/');
  return abs.startsWith('/') ? `file://${abs}` : `file:///${abs}`;
}

function clipOutput(value: string, max = 400) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function convertOleOfficeWithSoffice(inputPath: string, targetExt: string) {
  const soffice = resolveSofficePath();
  if (!soffice) {
    return {
      ok: false as const,
      error: `旧版 ${path.extname(inputPath) || 'Office'} 需要 LibreOffice（soffice）。本机未找到，请安装或把文件另存为 .${targetExt}`
    };
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4es-lo-'));
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai4es-lo-profile-'));
  const result = spawnSync(
    soffice,
    [
      '-env:UserInstallation=' + toFileUrl(profileDir),
      '--headless',
      '--norestore',
      '--nolockcheck',
      '--convert-to',
      targetExt,
      '--outdir',
      tmpDir,
      path.resolve(inputPath)
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 90_000,
      env: { ...process.env, SAL_USE_VCLPLUGIN: 'svp' }
    }
  );
  const expected = path.join(tmpDir, `${path.basename(inputPath, path.extname(inputPath))}.${targetExt}`);
  const produced = fs.existsSync(expected)
    ? expected
    : (fs.readdirSync(tmpDir).find((name) => name.toLowerCase().endsWith(`.${targetExt}`))
      ? path.join(tmpDir, fs.readdirSync(tmpDir).filter((name) => name.toLowerCase().endsWith(`.${targetExt}`))[0])
      : '');
  if (result.status !== 0 || !produced || !fs.existsSync(produced) || fs.statSync(produced).size < 80) {
    const detail = clipOutput(String(result.stderr || result.stdout || `exit ${result.status}`));
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.rmSync(profileDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return {
      ok: false as const,
      error: `LibreOffice 未能把 ${path.basename(inputPath)} 转为 .${targetExt}${detail ? `：${detail}` : ''}`
    };
  }
  return { ok: true as const, path: produced, tmpDir, profileDir };
}

function runMarkitdown(inputPath: string, outputPath: string) {
  const python = markitdownVenvPython();
  if (!fs.existsSync(python)) {
    return {
      ok: false as const,
      error: `未找到 ${path.relative(process.cwd(), python) || python}，请在项目根安装 markitdown-venv`
    };
  }
  if (!fs.existsSync(inputPath)) {
    return { ok: false as const, error: `原文件不存在：${inputPath}` };
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const result = spawnSync(python, ['-m', 'markitdown', inputPath, '-o', outputPath], {
    windowsHide: true,
    timeout: 90_000,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    return {
      ok: false as const,
      error: `markitdown 失败（${result.status}）：${clipOutput(String(result.stderr || result.stdout || '无输出'))}`
    };
  }
  try {
    if (fs.statSync(outputPath).size > 20) return { ok: true as const };
  } catch {
    // fall through
  }
  return { ok: false as const, error: 'markitdown 输出为空' };
}

export function convertAttachmentDocument(inputPath: string, outputPath: string): DocumentConvertResult {
  const ext = path.extname(inputPath).toLowerCase();
  const target = OLE_TARGET[ext];
  if (target) {
    const converted = convertOleOfficeWithSoffice(inputPath, target);
    if (!converted.ok) return { ok: false, error: converted.error };
    try {
      const md = runMarkitdown(converted.path, outputPath);
      if (!md.ok) return { ok: false, via: 'soffice+markitdown', error: md.error };
      return { ok: true, via: 'soffice+markitdown' };
    } finally {
      try {
        fs.rmSync(converted.tmpDir, { recursive: true, force: true });
        fs.rmSync(converted.profileDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }
  const md = runMarkitdown(inputPath, outputPath);
  if (!md.ok) return { ok: false, via: 'markitdown', error: md.error };
  return { ok: true, via: 'markitdown' };
}

export function convertDocumentWithMarkitdown(inputPath: string, outputPath: string) {
  return convertAttachmentDocument(inputPath, outputPath).ok;
}
