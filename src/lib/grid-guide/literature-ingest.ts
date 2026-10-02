import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { markitdownVenvPython } from '@/lib/attachments/markitdown-cli';

export type GridGuideExtractedDocument = {
  id: string;
  title: string;
  relative: string;
  source: string;
  chars: number;
  chinese: number;
};

export type GridGuideLiteratureIngest = {
  archiveCount: number;
  documentCount: number;
  documents: GridGuideExtractedDocument[];
  manuscriptRelative: string | null;
  manuscriptChinese: number;
  indexRelative: string | null;
  errors: string[];
};

function resolvePython() {
  const venv = markitdownVenvPython();
  if (fs.existsSync(venv)) return venv;
  return process.platform === 'win32' ? 'python' : 'python3';
}

function emptyIngest(): GridGuideLiteratureIngest {
  return {
    archiveCount: 0,
    documentCount: 0,
    documents: [],
    manuscriptRelative: null,
    manuscriptChinese: 0,
    indexRelative: null,
    errors: []
  };
}

function parseSummary(stdout: string): GridGuideLiteratureIngest {
  const line = stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return emptyIngest();
  try {
    const data = JSON.parse(line) as {
      archiveCount?: number;
      documentCount?: number;
      documents?: GridGuideExtractedDocument[];
      manuscript?: { relative?: string; chinese?: number } | null;
      errors?: string[];
    };
    return {
      archiveCount: Number(data.archiveCount) || 0,
      documentCount: Number(data.documentCount) || (data.documents?.length ?? 0),
      documents: Array.isArray(data.documents) ? data.documents : [],
      manuscriptRelative: data.manuscript?.relative || null,
      manuscriptChinese: Number(data.manuscript?.chinese) || 0,
      indexRelative: 'literature/extracted/INDEX.md',
      errors: Array.isArray(data.errors) ? data.errors : []
    };
  } catch {
    return emptyIngest();
  }
}

function copyIfMissing(source: string, target: string) {
  if (!fs.existsSync(source)) return;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function ingestGridGuideLiterature(input: {
  literatureDir: string;
  taskDir?: string | null;
  onProgress?: (status: { phase: string; detail: string }) => void;
}): GridGuideLiteratureIngest {
  const literatureDir = input.literatureDir;
  if (!fs.existsSync(literatureDir)) return emptyIngest();
  const hasSource = fs.readdirSync(literatureDir, { withFileTypes: true }).some((entry) => entry.isFile());
  if (!hasSource) return emptyIngest();

  const outDir = path.join(literatureDir, 'extracted');
  const script = path.join(process.cwd(), 'scripts', 'extract-grid-guide-literature.py');
  input.onProgress?.({ phase: 'literature', detail: '正在解压文献包并抽取全文…' });
  const result = spawnSync(resolvePython(), [script, '--literature', literatureDir, '--out', outDir], {
    encoding: 'utf8',
    timeout: 12 * 60 * 1000,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  if (result.status !== 0) {
    return {
      ...emptyIngest(),
      errors: [combined.slice(0, 800) || result.error?.message || '文献抽取失败']
    };
  }
  const ingest = parseSummary(result.stdout || '');
  if (fs.existsSync(path.join(outDir, 'INDEX.md'))) {
    ingest.indexRelative = 'literature/extracted/INDEX.md';
  }

  if (input.taskDir) {
    const extractDest = path.join(
      input.taskDir,
      '00_项目总体',
      '07_唯一资料主总结与网络补充',
      '01_全文提取'
    );
    fs.mkdirSync(extractDest, { recursive: true });
    for (const doc of ingest.documents) {
      copyIfMissing(path.join(outDir, doc.relative), path.join(extractDest, path.basename(doc.relative)));
    }
    if (ingest.manuscriptRelative) {
      copyIfMissing(
        path.join(outDir, ingest.manuscriptRelative),
        path.join(input.taskDir, '00_项目总体', '01_输入与范围', '原稿.md')
      );
    }
  }

  input.onProgress?.({
    phase: 'literature',
    detail: `文献全文已抽取 ${ingest.documentCount} 份${ingest.manuscriptRelative ? '，并写入原稿' : ''}`
  });
  return ingest;
}

export function readLiteratureManifest(workspaceRoot: string): GridGuideLiteratureIngest | null {
  const file = path.join(workspaceRoot, 'literature', 'extracted', 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      archiveCount?: number;
      documentCount?: number;
      documents?: GridGuideExtractedDocument[];
      manuscript?: { relative?: string; chinese?: number } | null;
      errors?: string[];
    };
    return {
      archiveCount: Number(data.archiveCount) || 0,
      documentCount: Number(data.documentCount) || (data.documents?.length ?? 0),
      documents: Array.isArray(data.documents) ? data.documents : [],
      manuscriptRelative: data.manuscript?.relative || null,
      manuscriptChinese: Number(data.manuscript?.chinese) || 0,
      indexRelative: 'literature/extracted/INDEX.md',
      errors: Array.isArray(data.errors) ? data.errors : []
    };
  } catch {
    return null;
  }
}
