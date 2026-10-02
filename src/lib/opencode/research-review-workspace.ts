import fs from 'node:fs';
import path from 'node:path';
import type { ChatAttachmentRow } from '../chat-attachments';
import {
  attachmentWorkspaceRoot,
  cacheAttachmentsToVirtualDir
} from '@/lib/attachments/workspace-cache';
import type { OpenCodeAttachment } from './attachments';

const SKILL_REF_FILES = [
  'output-skeleton.md',
  'report-structure.md',
  'literature-review-style.md',
  'evidence-and-citation-rules.md',
  'word-format-spec.md'
] as const;

export type ResearchReviewWorkspaceProgress = {
  phase: string;
  detail: string;
};

export function researchReviewWorkspaceRoot(conversationId: string) {
  return attachmentWorkspaceRoot('research-review', conversationId);
}

/** Build an isolated OpenCode cwd with short relative literature/ref paths. */
export function prepareResearchReviewWorkspace(
  conversationId: string,
  rows: ChatAttachmentRow[],
  onProgress?: (status: ResearchReviewWorkspaceProgress) => void
): { workingDirectory: string; attachmentPaths: OpenCodeAttachment[] } {
  const id = conversationId.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('科研传承助手会话 ID 无效。');
  }

  const root = researchReviewWorkspaceRoot(id);
  const refsDir = path.join(root, 'refs');
  fs.mkdirSync(refsDir, { recursive: true });

  onProgress?.({ phase: 'workspace', detail: '正在准备隔离工作区…' });

  const skillsLink = path.join(root, '.opencode', 'skills');
  const skillsTarget = path.join(process.cwd(), '.opencode', 'skills');
  if (!fs.existsSync(skillsLink) && fs.existsSync(skillsTarget)) {
    fs.mkdirSync(path.dirname(skillsLink), { recursive: true });
    try {
      fs.symlinkSync(skillsTarget, skillsLink, 'junction');
    } catch {
      // Non-fatal: skill tool still loads via OPENCODE_SKILLS_DIR; refs/ covers style files.
    }
  }

  const skillRefs = path.join(
    process.cwd(),
    '.opencode',
    'skills',
    'writing-source-grounded-research-reviews',
    'references'
  );
  for (const fileName of SKILL_REF_FILES) {
    const source = path.join(skillRefs, fileName);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, path.join(refsDir, fileName));
    }
  }

  const { attachmentPaths } = cacheAttachmentsToVirtualDir({
    conversationId: id,
    rows,
    mode: 'isolated',
    rootDir: root,
    subdir: 'literature',
    fileNameStyle: 'ordered',
    onProgress
  });

  const artifactNotes: string[] = [];
  const artifactsRoot = path.join(root, 'artifacts');
  if (fs.existsSync(artifactsRoot)) {
    for (const entry of fs.readdirSync(artifactsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const reportMd = path.join(artifactsRoot, entry.name, 'report.md');
      if (fs.existsSync(reportMd)) {
        artifactNotes.push(`- artifacts/${entry.name}/report.md`);
      }
    }
  }

  const indexLines = [
    '# 本轮文献证据索引',
    '',
    '工作目录即为当前会话目录。请用下列**相对路径** read（可带 offset/limit）。',
    '附件是原文件：系统未解压 ZIP，也未预先转换成 Markdown。需要时自行解压或按文档读取技能转换。',
    '',
    '## Skill 参考（与 writing-source-grounded-research-reviews 同步）',
    '',
    ...SKILL_REF_FILES.map((name) => `- refs/${name}`),
    '',
    ...(artifactNotes.length
      ? ['## 既往报告正文', '', ...artifactNotes, '']
      : []),
    '## 文献附件（原文件，未预解压/未预解析）',
    '',
    ...attachmentPaths.map((item, index) => {
      const target = item.originalRelativePath || item.relativePath;
      return `${index + 1}. ${item.name}\n   - path: ${target}`;
    }),
    ''
  ];
  fs.writeFileSync(path.join(root, 'INDEX.md'), indexLines.join('\n'), 'utf8');

  return { workingDirectory: root, attachmentPaths };
}
