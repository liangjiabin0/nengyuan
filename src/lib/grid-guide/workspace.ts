import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ChatAttachmentRow } from '@/lib/chat-attachments';
import {
  attachmentWorkspaceRoot,
  cacheAttachmentsToVirtualDir
} from '@/lib/attachments/workspace-cache';
import type { OpenCodeAttachment } from '@/lib/opencode/attachments';
import {
  GRID_GUIDE_RESERVED_ROOT_NAMES,
  GRID_GUIDE_SKILL_NAME,
  GRID_GUIDE_SKILL_REF_FILES,
  GRID_GUIDE_WORKSPACE_SCOPE
} from './constants';
import { materializeV7Derived } from './v7-derived';
import { assessV7Deliverables, type GridGuideDeliverableAssessment } from './v7-manifest';
import { coerceGuideJson, guideJsonMissingFields } from './guide-json';
import { ingestGridGuideLiterature, type GridGuideLiteratureIngest } from './literature-ingest';
import { getCorpusRoot } from '@/lib/corpus/schema';

export type GridGuideWorkspaceProgress = {
  phase: string;
  detail: string;
};

const SKILL_ROOT = path.join(process.cwd(), '.opencode', 'skills', GRID_GUIDE_SKILL_NAME);

export function gridGuideWorkspaceRoot(projectId: string) {
  return attachmentWorkspaceRoot(GRID_GUIDE_WORKSPACE_SCOPE, projectId);
}

export function suggestTaskFolderName(idea: string) {
  const compact = idea.replace(/\s+/g, ' ').trim();
  const cleaned = compact
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .slice(0, 40)
    .trim();
  return cleaned || '国网指南任务';
}

export function sanitizeTaskFolderName(value: string) {
  return suggestTaskFolderName(value);
}

function extractSearchTerms(idea: string) {
  const preferred = [
    '构网型储能',
    '构网型',
    '跟网型',
    '稳定支撑',
    '惯量支撑',
    '短路容量',
    '一次调频',
    '电压支撑',
    '虚拟同步',
    '直流最优潮流',
    '分布式优化',
    '微电网韧性',
    '韧性微网',
    '微电网',
    '微网',
    '韧性评估',
    '韧性提升'
  ].filter((term) => idea.includes(term) || (term === '微电网' && idea.includes('微网')) || (term === '微网' && idea.includes('微电网')));
  const patterned = idea.match(/[\u4e00-\u9fff]{2,4}型[\u4e00-\u9fff]{2,6}/g) || [];
  const clauses = idea
    .split(/[，。；、,\s\/]+/)
    .map((part) => part.replace(/^(研究|形成|开展|进行|编制|重点覆盖)+/, '').trim())
    .filter((part) => part.length >= 4 && part.length <= 12);
  return [...new Set([...preferred, ...patterned, ...clauses])].slice(0, 10);
}

function toKnowledgeRelative(absPath: string) {
  const normalized = absPath.replace(/\\/g, '/');
  const marker = '/knowledge-corpus/';
  const index = normalized.toLowerCase().indexOf(marker);
  return index >= 0 ? `knowledge-corpus/${normalized.slice(index + marker.length)}` : null;
}

function firstFileHeading(file: string) {
  try {
    const text = fs.readFileSync(file, 'utf8').slice(0, 2500);
    return text.match(/^#\s+(.+)$/m)?.[1]?.trim() || path.basename(file, '.md');
  } catch {
    return path.basename(file, '.md');
  }
}

export function collectCorpusHits(idea: string, limit = 24) {
  const corpusRoot = path.join(process.cwd(), 'storage', 'knowledge-corpus');
  const terms = extractSearchTerms(idea);
  const domains = ['papers', 'patents', 'books'] as const;
  const hits: Array<{ domain: string; relative: string; title: string }> = [];
  const seen = new Set<string>();
  for (const domain of domains) {
    const domainRoot = path.join(corpusRoot, domain);
    if (!fs.existsSync(domainRoot) || !terms.length) continue;
    for (const term of terms.slice(0, 6)) {
      const result = spawnSync('rg', ['-l', '-m', '20', '--glob', '*.md', term, domainRoot], {
        encoding: 'utf8',
        timeout: 20_000,
        windowsHide: true
      });
      for (const line of (result.stdout || '').split(/\r?\n/)) {
        if (!line.trim()) continue;
        const relative = toKnowledgeRelative(line.trim());
        if (!relative || seen.has(relative)) continue;
        const title = firstFileHeading(line.trim());
        seen.add(relative);
        hits.push({ domain, relative, title });
        if (hits.filter((item) => item.domain === domain).length >= 8) break;
      }
      if (hits.filter((item) => item.domain === domain).length >= 8) break;
    }
    if (hits.length >= limit) break;
  }
  return { terms, hits: hits.slice(0, limit) };
}

function writeCorpusHitsFile(refsDir: string, idea: string) {
  const { terms, hits } = collectCorpusHits(idea);
  const lines = [
    '# 预检索命中',
    '',
    `检索词：${terms.join('、') || '（未抽出）'}。请直接 read 下列 ` + '`knowledge-corpus/...`' + ' 路径，不要 glob *，不要换 patents/patents 或 ../../knowledge-corpus。',
    ''
  ];
  if (!hits.length) {
    lines.push('本轮预检索未命中。可对 `knowledge-corpus/papers` 做一次 grep，失败则改 web_search 后写盘。', '');
  } else {
    let domain = '';
    for (const hit of hits) {
      if (hit.domain !== domain) {
        domain = hit.domain;
        lines.push(`## ${domain}`, '');
      }
      lines.push(`- \`${hit.relative}\` — ${hit.title}`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(refsDir, 'corpus-hits.md'), lines.join('\n'), 'utf8');
  return hits;
}

const STRUCTURAL_DELIVERABLE_NAME_RE = /^(00_项目总体|05_正式成果|\d{2}_课题\d+_)/;

export function isStructuralDeliverableName(name: string) {
  return STRUCTURAL_DELIVERABLE_NAME_RE.test(name);
}

export function listTaskFolderNames(projectId: string) {
  const root = gridGuideWorkspaceRoot(projectId);
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !GRID_GUIDE_RESERVED_ROOT_NAMES.has(entry.name) &&
        !isStructuralDeliverableName(entry.name)
    )
    .map((entry) => entry.name);
}

export function resolveTaskFolderName(projectId: string, preferred?: string) {
  const names = listTaskFolderNames(projectId);
  if (preferred && names.includes(preferred)) return preferred;
  if (names.length === 1) return names[0];
  if (names.length > 1) {
    const scored = names
      .map((name) => {
        const dir = path.join(gridGuideWorkspaceRoot(projectId), name);
        const formal = path.join(dir, '05_正式成果');
        const overall = path.join(dir, '00_项目总体');
        return {
          name,
          score: (fs.existsSync(formal) ? 2 : 0) + (fs.existsSync(overall) ? 1 : 0)
        };
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh-CN'));
    return scored[0]?.name;
  }
  return preferred?.trim() || undefined;
}

export function ensureTaskFolder(projectId: string, idea: string, suggestedTaskName: string) {
  const root = gridGuideWorkspaceRoot(projectId);
  const name = resolveTaskFolderName(projectId, suggestedTaskName) || suggestedTaskName;
  const taskDir = path.join(root, name);
  fs.mkdirSync(root, { recursive: true });
  for (const entry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !isStructuralDeliverableName(entry.name)) continue;
    fs.mkdirSync(taskDir, { recursive: true });
    const from = path.join(root, entry.name);
    const to = path.join(taskDir, entry.name);
    if (from === to || fs.existsSync(to)) continue;
    fs.renameSync(from, to);
  }
  const scopeDir = path.join(taskDir, '00_项目总体', '01_输入与范围');
  fs.mkdirSync(scopeDir, { recursive: true });
  const scopeFile = path.join(scopeDir, '范围说明.md');
  if (!fs.existsSync(scopeFile)) {
    fs.writeFileSync(
      scopeFile,
      [
        '# 范围说明',
        '',
        '## 用户构想',
        '',
        idea.trim() || '（无）',
        '',
        '本文件由工作区预创建。请基于知识库论文/专利/书籍与网络补证扩写：研究对象、既有做法、工程矛盾、拟设 3—5 个递进课题，以及资料边界。不得用常识编造标准号、示范工程或验收阈值。',
        ''
      ].join('\n'),
      'utf8'
    );
  }
  return name;
}

export function gridGuideTaskDirectory(projectId: string, taskFolder?: string) {
  const name = resolveTaskFolderName(projectId, taskFolder);
  if (!name) return null;
  return path.join(gridGuideWorkspaceRoot(projectId), name);
}

export function workspaceExists(projectId: string) {
  return fs.existsSync(gridGuideWorkspaceRoot(projectId));
}

function countFilesRecursive(dir: string, limit = 400) {
  let count = 0;
  const stack = [dir];
  while (stack.length && count < limit) {
    const current = stack.pop();
    if (!current || !fs.existsSync(current)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) count += 1;
      if (count >= limit) break;
    }
  }
  return count;
}

export function countTaskFiles(projectId: string, taskFolder?: string) {
  const dir = gridGuideTaskDirectory(projectId, taskFolder);
  if (!dir || !fs.existsSync(dir)) return 0;
  return countFilesRecursive(dir);
}

export function readGeneratedProjectTitle(projectId: string, taskFolder?: string) {
  const dir = gridGuideTaskDirectory(projectId, taskFolder);
  if (!dir) return '';
  const jsonPath = findGuideJson(dir);
  if (!jsonPath) return '';
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as { project_name?: unknown };
    return typeof data.project_name === 'string' ? data.project_name.trim() : '';
  } catch {
    return '';
  }
}

export function assessTaskDeliverables(
  projectId: string,
  taskFolder?: string
): GridGuideDeliverableAssessment {
  return assessV7Deliverables(gridGuideTaskDirectory(projectId, taskFolder));
}

export function findGuideJson(taskDir: string): string | null {
  const candidates = [
    path.join(taskDir, '05_正式成果', 'guide.json'),
    path.join(taskDir, '05_正式成果', '指南建议稿.json')
  ];
  for (const file of candidates) {
    if (fs.existsSync(file)) return file;
  }
  const formal = path.join(taskDir, '05_正式成果');
  if (!fs.existsSync(formal)) return null;
  for (const entry of fs.readdirSync(formal, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.json') && /guide|指南/.test(entry.name)) {
      return path.join(formal, entry.name);
    }
  }
  return null;
}

export function findGuideDocx(taskDir: string): string | null {
  const formal = path.join(taskDir, '05_正式成果');
  const preferred = path.join(formal, '指南建议稿.docx');
  if (fs.existsSync(preferred)) return preferred;
  if (!fs.existsSync(formal)) return null;
  const files = fs
    .readdirSync(formal, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.docx') && /指南|建议稿/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const score = (name: string) => (/指南/.test(name) ? 2 : 0) + (/建议稿/.test(name) ? 1 : 0);
      return score(b) - score(a) || a.localeCompare(b, 'zh-CN');
    });
  return files[0] ? path.join(formal, files[0]) : null;
}

export async function materializeGridGuideDerived(taskDir: string) {
  await materializeV7Derived(taskDir);
  return tryBuildFixedGuideDocx(taskDir);
}

export function tryBuildFixedGuideDocx(taskDir: string) {
  const input = findGuideJson(taskDir);
  if (!input) return { attempted: false, output: null as string | null, error: null as string | null };
  const existingGuide = findGuideDocx(taskDir);
  try {
    const raw = JSON.parse(fs.readFileSync(input, 'utf8')) as unknown;
    const coerced = coerceGuideJson(raw);
    const missing = guideJsonMissingFields(coerced);
    fs.writeFileSync(input, `${JSON.stringify(coerced, null, 2)}\n`, 'utf8');
    if (missing.length) {
      return {
        attempted: true,
        output: existingGuide,
        error: `guide.json 字段不完整：${missing.join('；')}`
      };
    }
  } catch (error) {
    return {
      attempted: true,
      output: existingGuide,
      error: error instanceof Error ? error.message : 'guide.json 无法解析'
    };
  }
  const script = path.join(SKILL_ROOT, 'scripts', 'build_fixed_guide.py');
  const template = path.join(SKILL_ROOT, 'assets', 'sgcc-guide-fixed-template.docx');
  if (!fs.existsSync(script) || !fs.existsSync(template)) {
    return { attempted: false, output: existingGuide, error: '缺少固定母版或生成脚本。' };
  }
  const output = path.join(taskDir, '05_正式成果', '指南建议稿.docx');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync('python', [script, '--input', input, '--output', output, '--template', template], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true
  });
  if (result.status === 0 && fs.existsSync(output)) {
    return { attempted: true, output, error: null };
  }
  const detail = [result.stderr, result.stdout, result.error?.message].filter(Boolean).join('\n').trim();
  return {
    attempted: true,
    output: fs.existsSync(output) ? output : existingGuide,
    error: detail.slice(0, 800) || '固定母版生成失败。'
  };
}

export function deleteGridGuideWorkspace(projectId: string) {
  const root = gridGuideWorkspaceRoot(projectId);
  if (!fs.existsSync(root)) return;
  fs.rmSync(root, { recursive: true, force: true });
}

export function prepareGridGuideWorkspace(
  projectId: string,
  idea: string,
  rows: ChatAttachmentRow[],
  options?: {
    suggestedTaskName?: string;
    onProgress?: (status: GridGuideWorkspaceProgress) => void;
  }
): {
  workingDirectory: string;
  attachmentPaths: OpenCodeAttachment[];
  suggestedTaskName: string;
  literature: GridGuideLiteratureIngest;
} {
  const id = projectId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('项目指南 ID 无效。');

  const root = gridGuideWorkspaceRoot(id);
  const refsDir = path.join(root, 'refs');
  fs.mkdirSync(refsDir, { recursive: true });
  options?.onProgress?.({ phase: 'workspace', detail: '正在准备隔离工作区…' });

  const skillsLink = path.join(root, '.opencode', 'skills');
  const skillsTarget = path.join(process.cwd(), '.opencode', 'skills');
  if (!fs.existsSync(skillsLink) && fs.existsSync(skillsTarget)) {
    fs.mkdirSync(path.dirname(skillsLink), { recursive: true });
    try {
      fs.symlinkSync(skillsTarget, skillsLink, 'junction');
    } catch {
      // Skill 仍可通过 OPENCODE_SKILLS_DIR 加载。
    }
  }
  const corpusRoot = getCorpusRoot();
  const corpusLink = path.join(root, 'knowledge-corpus');
  if (!fs.existsSync(corpusLink) && fs.existsSync(corpusRoot)) {
    try {
      fs.symlinkSync(corpusRoot, corpusLink, 'junction');
    } catch {
      // corpus-guard 仍可把 knowledge-corpus/ 改写到真实语料路径。
    }
  }

  const skillRefs = path.join(SKILL_ROOT, 'references');
  for (const fileName of GRID_GUIDE_SKILL_REF_FILES) {
    const source = path.join(skillRefs, fileName);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(refsDir, fileName));
    }
  }
  const corpusHits = writeCorpusHitsFile(refsDir, idea);

  const { attachmentPaths } = cacheAttachmentsToVirtualDir({
    conversationId: id,
    rows,
    mode: 'isolated',
    rootDir: root,
    subdir: 'literature',
    fileNameStyle: 'ordered',
    onProgress: options?.onProgress
  });

  const suggestedTaskName = sanitizeTaskFolderName(options?.suggestedTaskName || idea);
  const existingTask = resolveTaskFolderName(id);
  const taskFolder = ensureTaskFolder(id, idea, existingTask || suggestedTaskName);
  const literature = ingestGridGuideLiterature({
    literatureDir: path.join(root, 'literature'),
    taskDir: path.join(root, taskFolder),
    onProgress: options?.onProgress
  });
  const taskNotes = existingTask
    ? [`已有任务文件夹：\`${existingTask}/\`。修订时在此目录内更新，不要另起平行副本。`]
    : [
        `任务文件夹已预创建：\`./${taskFolder}/\`。不要另建平行任务文件夹。`,
        '读完 TASK.md 后立刻扩写该文件夹内的范围说明，再检索，再按 V7 清单逐一落盘。'
      ];

  const literatureLines = literature.documentCount
    ? [
        `- 文献包已解压并抽取全文：${literature.documentCount} 份，见 \`literature/extracted/INDEX.md\` 与任务文件夹 \`00_项目总体/07_唯一资料主总结与网络补充/01_全文提取/\`。`,
        literature.manuscriptRelative
          ? `- 原稿全文已写入 \`literature/extracted/manuscript.md\` 和 \`./${taskFolder}/00_项目总体/01_输入与范围/原稿.md\`。有原稿时，主交付是证据接地的重写稿（第一、二章综述级深度），七段指南是附加成果。`
          : '- 无独立原稿。请基于抽取全文编制指南。'
      ]
    : ['- 本轮没有可抽取的文献包。检索知识库与网络后编制。'];

  const taskLines = [
    '# 本次国网指南任务',
    '',
    `建议任务名：${suggestedTaskName}`,
    '',
    '## 用户构想',
    '',
    idea.trim() || '（无）',
    '',
    '## 工作区约定',
    '',
    ...taskNotes.map((line) => `- ${line}`),
    ...literatureLines,
    '- 知识库路径写 `knowledge-corpus/papers`（或 patents、books）。禁止 glob *、禁止 patents/patents、禁止 ../../knowledge-corpus。',
    '- 同一 grep 路径失败一次就换分域或改 web_search，禁止反复重试。读多少由你根据证据需要自行决定，不要因为工具截断而只看题录。',
    '- 不要生成 V6 副本、page-*.png、contact sheet 或渲染底稿。',
    '- 必须按 refs/v7-required-deliverables.md 落盘 V7 必须成果；有原稿时还须写 `05_正式成果/重写稿.md`。',
    '',
    '## 预检索命中',
    '',
    corpusHits.length
      ? `已写入 \`refs/corpus-hits.md\`，共 ${corpusHits.length} 条。先 read 这些文件再写三类总结，不要重新穷举语料。`
      : '预检索未命中。对 `knowledge-corpus/papers` 检索一次后必须写盘。',
    '',
    '## 附件',
    '',
    attachmentPaths.length
      ? attachmentPaths
          .map((item, index) => {
            const target = item.originalRelativePath || item.relativePath;
            return `${index + 1}. ${item.name} → ${target}`;
          })
          .join('\n')
      : '本轮没有附件。请检索知识库与网络后编制。',
    literature.indexRelative ? `\n抽取索引：\`${literature.indexRelative}\`` : '',
    ''
  ];
  fs.writeFileSync(path.join(root, 'TASK.md'), taskLines.join('\n'), 'utf8');

  const indexLines = [
    '# 国网指南工作区索引',
    '',
    '请先 read TASK.md、refs/v7-required-deliverables.md、refs/dense-single-document-summary.md、refs/corpus-hits.md。有文献包时接着 read literature/extracted/INDEX.md。不要先读完全部 refs。',
    '',
    '## Skill 参考',
    '',
    ...GRID_GUIDE_SKILL_REF_FILES.map((name) => `- refs/${name}`),
    '',
    '## 用户附件',
    '',
    attachmentPaths.length
      ? attachmentPaths.map((item, index) => {
        const target = item.originalRelativePath || item.relativePath;
        return `${index + 1}. ${item.name} → ${target}`;
      }).join('\n')
      : '无',
    '',
    literature.documentCount
      ? `## 已抽取全文\n\n- literature/extracted/INDEX.md（${literature.documentCount} 份）\n${literature.manuscriptRelative ? '- literature/extracted/manuscript.md\n' : ''}`
      : '',
    existingTask ? `## 已有成果\n\n- ${existingTask}/` : `## 任务文件夹\n\n- 已预创建 \`./${taskFolder}/\`，请在其中扩写 V7 成果。`,
    ''
  ];
  fs.writeFileSync(path.join(root, 'INDEX.md'), indexLines.filter(Boolean).join('\n'), 'utf8');

  return { workingDirectory: root, attachmentPaths, suggestedTaskName: taskFolder, literature };
}
