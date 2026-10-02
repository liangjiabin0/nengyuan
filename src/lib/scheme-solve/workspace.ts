import fs from 'node:fs';
import path from 'node:path';
import type { ChatAttachmentRow } from '@/lib/chat-attachments';
import {
  attachmentWorkspaceRoot,
  cacheAttachmentsToVirtualDir
} from '@/lib/attachments/workspace-cache';
import type { OpenCodeAttachment } from '@/lib/opencode/attachments';
import { SCHEME_WORKSPACE_SCOPE } from './constants';
import { extractJsonObject } from './model-json';
import type { SchemeIdea } from './types';

export function schemeSolveWorkspaceRoot(sessionId: string) {
  return attachmentWorkspaceRoot(SCHEME_WORKSPACE_SCOPE, sessionId);
}

export function schemeIdeaDirectory(sessionId: string, ideaId: string) {
  return path.join(schemeSolveWorkspaceRoot(sessionId), ideaId);
}

export function deleteSchemeSolveWorkspace(sessionId: string) {
  const root = schemeSolveWorkspaceRoot(sessionId);
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
}

function writeText(filePath: string, content: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

export function prepareSchemeSessionWorkspace(
  sessionId: string,
  seedIdea: string,
  rows: ChatAttachmentRow[],
  onProgress?: (status: { phase: string; detail: string }) => void
): { workingDirectory: string; attachmentPaths: OpenCodeAttachment[] } {
  const workingDirectory = schemeSolveWorkspaceRoot(sessionId);
  fs.mkdirSync(workingDirectory, { recursive: true });
  writeText(path.join(workingDirectory, 'IDEA.md'), `# 原始构想\n\n${seedIdea.trim()}\n`);
  const { attachmentPaths } = cacheAttachmentsToVirtualDir({
    conversationId: sessionId,
    rows,
    mode: 'isolated',
    rootDir: workingDirectory,
    subdir: 'literature',
    fileNameStyle: 'ordered',
    onProgress
  });
  const index = [
    '# 方案求解工作区',
    '',
    '- 原始构想：`IDEA.md`',
    attachmentPaths.length ? '- 参考附件：`literature/`（原文件，未预解压/未预解析）' : '- 本轮没有附件',
    '',
    attachmentPaths.map((item, index) => `${index + 1}. ${item.name} → ${item.originalRelativePath || item.relativePath}`).join('\n')
  ].join('\n');
  writeText(path.join(workingDirectory, 'INDEX.md'), `${index}\n`);
  return { workingDirectory, attachmentPaths };
}

export function prepareSchemeIdeaWorkspace(
  sessionId: string,
  seedIdea: string,
  idea: SchemeIdea,
  rows: ChatAttachmentRow[],
  onProgress?: (status: { phase: string; detail: string }) => void
): { workingDirectory: string; attachmentPaths: OpenCodeAttachment[] } {
  const workingDirectory = schemeIdeaDirectory(sessionId, idea.id);
  fs.mkdirSync(workingDirectory, { recursive: true });
  writeText(
    path.join(workingDirectory, 'IDEA.md'),
    [
      `# ${idea.title}`,
      '',
      idea.summary,
      '',
      `问题类型：${idea.problemClass || 'unknown'}`,
      `决策：${idea.decisions || ''}`,
      `约束：${idea.limits || ''}`,
      `目标：${idea.goal || ''}`,
      idea.caseHint ? `算例提示：${idea.caseHint}` : '',
      '',
      '## 原始构想',
      seedIdea.trim()
    ]
      .filter(Boolean)
      .join('\n')
  );
  const { attachmentPaths } = cacheAttachmentsToVirtualDir({
    conversationId: sessionId,
    rows,
    mode: 'isolated',
    rootDir: workingDirectory,
    subdir: 'literature',
    fileNameStyle: 'ordered',
    onProgress
  });
  writeText(
    path.join(workingDirectory, 'INDEX.md'),
    [
      '# 本想法工作区',
      '',
      '- 想法说明：`IDEA.md`',
      '- 设计：`DESIGN.md`',
      '- 模型：`model.json`',
      '- 求解：`result.json`',
      idea.problemClass === 'mgplan' ? '- 规划算例：`mgplan/config/` · 结果：`mgplan/output/` · 解读：`RESULTS.md`' : '',
      idea.problemClass === 'dispatch' ? '- 调度：`dispatch/run-spec.yaml` · `dispatch/result_bundle.json`' : '',
      idea.problemClass === 'loss' ? '- 线损：`loss/input.json` · `loss/output/`（17 表 + Excel + 图 + HTML）' : '',
      idea.problemClass === 'modelica' ? '- 仿真：`modelica/model.mo` · `modelica/result.json`' : '',
      idea.problemClass === 'forecast' ? '- 预测：`forecast/` 曲线与 metrics.json' : '',
      idea.problemClass === 'acopf' ? '- 交流算例：`tdmg/input/` · 结果：`tdmg/output/` · 解读：`RESULTS.md`' : '',
      ['dcopf', 'lp', 'mip'].includes(String(idea.problemClass)) ? '- 线性模型文件：`esopt/*.mps` / `esopt/*.lp`（若上传）' : '',
      '- 审查：`review-small.md` / `review-large.md`',
      '- 报告：`REPORT.md`',
      attachmentPaths.length ? '- 附件：`literature/`（原文件，未预解压/未预解析）' : '- 无附件',
      '',
      attachmentPaths.map((item, index) => `${index + 1}. ${item.name} → ${item.originalRelativePath || item.relativePath}`).join('\n')
    ].filter(Boolean).join('\n')
  );
  return { workingDirectory, attachmentPaths };
}

export function readWorkspaceText(sessionId: string, ideaId: string, fileName: string) {
  const filePath = path.join(schemeIdeaDirectory(sessionId, ideaId), fileName);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
}

export function readWorkspaceJson(sessionId: string, ideaId: string, fileName: string) {
  const raw = readWorkspaceText(sessionId, ideaId, fileName).trim();
  if (!raw) return null;
  return extractJsonObject(raw);
}

export function writeWorkspaceText(sessionId: string, ideaId: string, fileName: string, content: string) {
  writeText(path.join(schemeIdeaDirectory(sessionId, ideaId), fileName), content);
}

export function listIdeaReportFiles(sessionId: string, ideaId: string) {
  const dir = schemeIdeaDirectory(sessionId, ideaId);
  return {
    design: readWorkspaceText(sessionId, ideaId, 'DESIGN.md'),
    model: readWorkspaceText(sessionId, ideaId, 'model.json'),
    result: readWorkspaceText(sessionId, ideaId, 'result.json'),
    results: readWorkspaceText(sessionId, ideaId, 'RESULTS.md'),
    reviewSmall: readWorkspaceText(sessionId, ideaId, 'review-small.md'),
    reviewLarge: readWorkspaceText(sessionId, ideaId, 'review-large.md'),
    report: readWorkspaceText(sessionId, ideaId, 'REPORT.md'),
    exists: fs.existsSync(dir)
  };
}
